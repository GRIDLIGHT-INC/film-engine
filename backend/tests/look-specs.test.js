/**
 * The mood board earns its name: words, images, and specs that reach something.
 *
 * What shipped first was a text composer with a photo album bolted on. Its own
 * comment admitted it — "image-only entries contribute nothing to the words" —
 * so you could pin a reference frame to the board and it changed no output
 * anywhere. And every technical choice on it was free text, which meant a lens
 * you picked could reach a prompt string and nothing else: not previs, which
 * solves framing from a real focal length, and not the project settings, which
 * decide what is actually delivered.
 *
 * Three outputs, and each is checked against the thing it is supposed to move:
 *
 *   WORDS   compose into style_preset                    (already worked)
 *   IMAGES  attach to generation as a style reference    (KIND_RANK has always
 *           had a `style: 3` slot; nothing ever filled it)
 *   SPECS   picked from the engine's own registries and applied to project
 *           settings and previs defaults
 *
 * Set-based over the spec kinds, because the failure is per-kind and silent: a
 * board that applies aspect ratio but drops frame rate looks like it worked,
 * and the film is delivered at the wrong speed.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-specs-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const look = require('../lib/look-development');
const { LENS_KIT, SENSORS, APERTURES } = require('../lib/previs-camera');
const presets = require('../lib/project-presets');
const { KIND_RANK } = require('../lib/reference-images');

function makeProject() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Look Test');
    return projectId;
}

/**
 * Every spec kind, the registry it must come from, and a legal value.
 *
 * The registries are the engine's own — a spec that is not in one is free text
 * wearing a spec's name, and free text cannot reach previs or a delivery
 * setting.
 */
const SPEC_SAMPLES = {
    lens: 50,
    sensor: 'super35',
    aperture: 2.8,
    aspect_ratio: '2.39:1',
    resolution: '1080p',
    frame_rate: 24,
    color_space: 'Rec.709',
    style_preset: 'noir',
};

test('every spec kind is backed by a registry, not free text', () => {
    const kinds = Object.keys(look.SPEC_KINDS);
    const unbacked = kinds.filter(k => {
        const values = look.allowedSpecValues(k);
        return !Array.isArray(values) || !values.length;
    });
    assert.deepStrictEqual(unbacked, [], `spec kinds with no registry behind them: ${unbacked.join(', ')}`);

    // And the registries are the real ones, not a copy that can drift.
    assert.deepStrictEqual(look.allowedSpecValues('lens'), LENS_KIT, 'lens list is not LENS_KIT');
    assert.deepStrictEqual(look.allowedSpecValues('sensor'), Object.keys(SENSORS), 'sensor list is not SENSORS');
    assert.deepStrictEqual(look.allowedSpecValues('aperture'), APERTURES, 'aperture list is not APERTURES');
    assert.deepStrictEqual(look.allowedSpecValues('aspect_ratio'), presets.ASPECT_RATIO_IDS, 'ratios are not the presets');
});

test('the sample set covers every spec kind', () => {
    const missing = Object.keys(look.SPEC_KINDS).filter(k => SPEC_SAMPLES[k] === undefined);
    assert.deepStrictEqual(missing, [], `spec kinds with no test value: ${missing.join(', ')}`);
});

test('every spec kind validates its value against its registry', () => {
    const broken = [];
    for (const [kind, value] of Object.entries(SPEC_SAMPLES)) {
        if (!look.validateSpec(kind, value).ok) broken.push(`${kind}: legal value ${value} was rejected`);
        if (look.validateSpec(kind, '__nonsense__').ok) broken.push(`${kind}: nonsense was accepted`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('every spec kind declares where it lands, and nowhere is not an option', () => {
    // The whole point. A spec that reaches only a prompt string is the thing
    // this replaces.
    const TARGETS = ['project', 'previs', 'prompt'];
    const wrong = Object.entries(look.SPEC_KINDS)
        .filter(([, s]) => !TARGETS.includes(s.target))
        .map(([k, s]) => `${k} → ${s.target}`);
    assert.deepStrictEqual(wrong, [], `spec kinds landing nowhere real: ${wrong.join(', ')}`);

    // At least one of each of the two that were missing before.
    const targets = Object.values(look.SPEC_KINDS).map(s => s.target);
    assert.ok(targets.includes('project'), 'no spec reaches project settings');
    assert.ok(targets.includes('previs'), 'no spec reaches previs');
});

test('project specs are written to the columns that actually deliver', () => {
    const projectId = makeProject();
    const specs = Object.entries(SPEC_SAMPLES)
        .filter(([k]) => look.SPEC_KINDS[k].target === 'project')
        .map(([kind, value]) => ({ kind, value }));

    const applied = look.applyProjectSpecs(db, projectId, specs);
    const row = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);

    const broken = [];
    for (const { kind, value } of specs) {
        const column = look.SPEC_KINDS[kind].column;
        // resolution is picked as an id ("1080p") and stored as dimensions
        // ("1920x1080") — the column vocabulary every exporter parses.
        const expected = kind === 'resolution' ? '1920x1080' : String(value);
        if (String(row[column]) !== expected) {
            broken.push(`${kind}: chose ${value}, expected ${column}=${expected}, holds ${row[column]}`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
    assert.strictEqual(applied.length, specs.length, 'a spec was silently not applied');
});

test('previs specs become the defaults a stage is seeded with', () => {
    const projectId = makeProject();
    const specs = Object.entries(SPEC_SAMPLES)
        .filter(([k]) => look.SPEC_KINDS[k].target === 'previs')
        .map(([kind, value]) => ({ kind, value }));

    const defaults = look.previsDefaults(specs);
    assert.strictEqual(defaults.focalMm, SPEC_SAMPLES.lens, 'the chosen lens does not reach previs');
    assert.strictEqual(defaults.sensorId, SPEC_SAMPLES.sensor, 'the chosen sensor does not reach previs');
    assert.strictEqual(defaults.fStop, SPEC_SAMPLES.aperture, 'the chosen stop does not reach previs');
});

test('a board image becomes a style reference on generation', () => {
    // lib/reference-images has had a `style` rank since it was written and
    // nothing has ever put anything in it. A picture that changes no output is
    // not a reference, it is decoration.
    assert.strictEqual(KIND_RANK.style, 3, 'the style slot is gone from the ranking');

    const projectId = makeProject();
    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name)
                VALUES (?, ?, 'reference_image', '/tmp/look.png', 'look.png')`).run(assetId, projectId);
    db.prepare(`INSERT INTO film_mood_board (id, project_id, kind, note, asset_id, image_path)
                VALUES (?, ?, 'image', '', ?, '/tmp/look.png')`).run(generateId(), projectId, assetId);

    const refs = look.styleReferences(db, projectId);
    assert.ok(refs.length >= 1, 'a board image produced no style reference');
    assert.strictEqual(refs[0].kind, 'style', `wrong kind: ${refs[0].kind}`);
    assert.ok(refs[0].file_path, 'the reference has no file to send');
});

test('style references rank below the subjects, so they never displace a face', () => {
    // With only three reference slots, a look plate taking one from the actor
    // would be the wrong trade every time — a viewer notices a different face
    // long before a different grade.
    assert.ok(KIND_RANK.style > KIND_RANK.character, 'a style plate can displace the character');
    assert.ok(KIND_RANK.style > KIND_RANK.location, 'a style plate can displace the location');
});


test('the three outputs are wired to the three destinations, not just computed', () => {
    // A look library nothing consults is a look library. Checked structurally
    // at each destination, because each is a different subsystem.
    const fs = require('fs');
    const at = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

    assert.ok(/styleReferences\(/.test(at('routes/storyboard.js')),
        'board images never reach generation, so a pinned frame changes nothing');
    assert.ok(/previsDefaults\(/.test(at('routes/previs.js')),
        'the film\'s lens never reaches previs, so a stage opens on a generic default');
    assert.ok(/applyProjectSpecs\(/.test(at('routes/mood-board.js')),
        'the delivery specs are never applied to the project');
});

/**
 * The film's optics reach a shot whether or not anyone opened the 3D stage.
 *
 * lens 40 / super35 / T2.8 were on the board, validated, and reached nothing.
 * They were only consulted by previs/from-card, so they applied to the one shot
 * of eight that happened to be blocked. Seven shots generated on a generic 50mm
 * super35 default that belongs to no production, and the specs a director had
 * deliberately chosen were decoration.
 *
 * Blocking is optional. The lens the film shoots on is not. So the precedence
 * is: what was STAGED beats what was WRITTEN beats what the PRODUCTION shoots
 * on — and the last of those has to exist as a fallback, or choosing it
 * achieves nothing until someone blocks every shot by hand.
 */
test('a shot with no blocking still gets the film\'s chosen optics', () => {
    const projectId = makeProject();
    for (const [kind, value] of [['lens', 40], ['sensor', 'super35'], ['aperture', 2.8]]) {
        db.prepare(`INSERT INTO film_mood_board (id, project_id, kind, note, spec_kind, spec_value)
                    VALUES (?, ?, 'lens', '', ?, ?)`).run(generateId(), projectId, kind, String(value));
    }

    const defaults = look.filmOptics(db, projectId);
    assert.strictEqual(defaults.focalMm, 40, 'the chosen lens does not reach a shot');
    assert.strictEqual(defaults.sensorId, 'super35');
    assert.strictEqual(defaults.fStop, 2.8);
});

test('a project with no specs gets nothing rather than an invented lens', () => {
    // Falling back to a made-up default here would be indistinguishable from a
    // deliberate choice, and would override the scene card.
    const projectId = makeProject();
    assert.deepStrictEqual(look.filmOptics(db, projectId), {});
});

test('the precedence is staged, then written, then the production default', () => {
    const sp = require('../lib/storyboard-prompt');
    const card = {
        shot_code: '1A', description: 'She stops.', lighting: { type: 'natural' },
        camera: { shot_type: 'medium', lens: '85mm' },
    };
    // Written wins over the production default...
    const written = sp.buildStoryboardPrompt(card, [], null, null, { filmOptics: { focalMm: 40 } }).prompt;
    assert.ok(/85\s*mm/.test(written), `the card's own lens was overridden: ${written}`);

    // ...and the production default fills in when the card says nothing.
    const blank = sp.buildStoryboardPrompt({ ...card, camera: { shot_type: 'medium' } }, [], null, null,
        { filmOptics: { focalMm: 40 } }).prompt;
    assert.ok(/40\s*mm/.test(blank), `the film's lens never reached a card that specified none: ${blank}`);

    // ...and blocking still beats both.
    const staged = sp.buildStoryboardPrompt(card, [], null, null,
        { filmOptics: { focalMm: 40 }, previs: { focal_mm: 100, shot_type: 'close-up' } }).prompt;
    assert.ok(/100\s*mm/.test(staged), `what was staged lost to something else: ${staged}`);
});
