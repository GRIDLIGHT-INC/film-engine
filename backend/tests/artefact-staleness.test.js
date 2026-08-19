/**
 * Phase 1 — a derived artefact knows what it was made from.
 *
 * Nothing in the pipeline records its inputs. Edit a character's appearance, a
 * location description, a style preset or a scene card, and every frame already
 * generated from the old version stays valid-looking forever. The only signal is
 * a director looking at the board and feeling that something is off.
 *
 * That is not hypothetical. A character plate was generated in a stock
 * clip-art style, the builder that produced it was fixed fourteen hours later,
 * and the plate survived its own fix — cached, referenced by every shot with
 * that character in it, and silently dragging photoreal streets into cartoon.
 * Eight frames was small enough to eyeball. A feature is not.
 *
 * The fingerprint is deliberately NOT a hand-written list of inputs per kind.
 * Every generated artefact already has exactly one honest description of what
 * it will be: the payload we would send the provider, built by the single
 * construction path in lib/capability-payloads.js. If that payload changes, the
 * output would change. So the payload IS the fingerprint, which means no second
 * enumeration of inputs can drift from the first.
 *
 * Set-based over the artefact registry because the failure is per-kind and
 * partial by nature — the location plate came out fine while the character
 * plate came out as clip art, from the same bug. An example-based test passes
 * on whichever kind happens to work.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-stale-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const fp = require('../lib/artefact-fingerprint');

// ── Fixture: a project with everything a payload builder reads ──────────────

function makeProject() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    const charId = generateId(), locId = generateId(), propId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, style_preset) VALUES (?, ?, ?)')
        .run(projectId, 'Stale Test', 'teal and amber, anamorphic, 35mm grain');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location, time_of_day) VALUES (?, ?, ?, ?, ?)')
        .run(sceneId, projectId, '1', 'SUBURBAN STREET', 'DUSK');
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms)
                VALUES (?, ?, ?, ?, ?)`)
        .run(shotId, sceneId, '1A', JSON.stringify({
            shot_code: '1A',
            description: 'She stops at the door.',
            camera: { shot_type: 'close-up', lens: '50mm', movement: 'static' },
            lighting: { type: 'natural' },
            characters: ['MAYA'],
            dialogue: [{ character: 'MAYA', line: 'Get inside.' }],
        }), 4000);
    db.prepare('INSERT INTO film_characters (id, project_id, name, appearance_prompt) VALUES (?, ?, ?, ?)')
        .run(charId, projectId, 'MAYA', 'mid-30s woman, rust cardigan, dark ponytail');
    db.prepare('INSERT INTO film_locations (id, project_id, name, description) VALUES (?, ?, ?, ?)')
        .run(locId, projectId, 'SUBURBAN STREET', 'late-1970s cul-de-sac, wet asphalt');
    db.prepare('INSERT INTO film_props (id, project_id, name, visual_prompt) VALUES (?, ?, ?, ?)')
        .run(propId, projectId, 'Grocery bag', 'brown paper bag, oranges spilling');
    // buildMusicPrompt is driven by the CUE, not the scene. Without one the
    // payload is a constant default, and a fingerprint over a constant would
    // look stable for the wrong reason.
    const cueId = generateId();
    db.prepare('INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, title, mood) VALUES (?, ?, ?, ?, ?, ?)')
        .run(cueId, projectId, sceneId, 'score', 'Main theme', 'calm');
    return { projectId, sceneId, shotId, charId, locId, propId, cueId };
}

/**
 * The 12 generated artefact kinds, and — for each — an edit that MUST change
 * its fingerprint. The mutation is the real assertion: a fingerprint that never
 * moves is a checksum of nothing.
 */
const MUTATIONS = {
    keyframe: ids => db.prepare('UPDATE film_characters SET appearance_prompt = ? WHERE id = ?')
        .run('a completely different person', ids.charId),
    video: ids => db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify({ shot_code: '1A', description: 'She runs.', camera: { shot_type: 'wide', lens: '24mm', movement: 'tracking-forward' } }), ids.shotId),
    voice: ids => db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify({ shot_code: '1A', description: 'x', camera: {}, dialogue: [{ character: 'MAYA', line: 'Something else entirely.' }] }), ids.shotId),
    lipsync: ids => MUTATIONS.voice(ids),
    // The cue is what a music payload is built from; the scene barely features.
    music: ids => db.prepare('UPDATE film_music_cues SET mood = ?, genre = ? WHERE id = ?')
        .run('dread', 'horror strings', ids.cueId),
    // SFX comes off the card's declared cues, so changing the action line is
    // correctly invisible to it.
    sfx: ids => db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify({ shot_code: '1A', description: 'x', camera: {},
            sfx_cues: [{ description: 'a door slamming', timing: 'on cut' }] }), ids.shotId),
    ambient: ids => db.prepare('UPDATE film_scenes SET location = ? WHERE id = ?').run('FOREST', ids.sceneId),
    post: ids => MUTATIONS.video(ids),
    character_plate: ids => db.prepare('UPDATE film_characters SET appearance_prompt = ? WHERE id = ?')
        .run('someone else', ids.charId),
    location_plate: ids => db.prepare('UPDATE film_locations SET description = ? WHERE id = ?')
        .run('a rooftop in Osaka', ids.locId),
    prop_plate: ids => db.prepare('UPDATE film_props SET visual_prompt = ? WHERE id = ?')
        .run('a brass key', ids.propId),
    // The style preset reaches every visual artefact; the card is what the
    // breakdown produced from the screenplay.
    scene_card: ids => db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify({ shot_code: '1A', description: 'Rewritten entirely.', camera: {} }), ids.shotId),
};

test('the registry covers every generated artefact kind', () => {
    const kinds = Object.keys(fp.ARTEFACT_KINDS);
    // Derived from the code that actually generates: the orchestrated
    // capabilities, plus the plates, plus the card.
    const { STEP_CAPABILITY } = require('../routes/pipeline');
    const caps = Object.values(STEP_CAPABILITY);
    const missingCaps = caps.filter(c => !kinds.some(k => fp.ARTEFACT_KINDS[k].capability === c));
    assert.deepStrictEqual(missingCaps, [],
        `orchestrated capabilities with no artefact kind: ${missingCaps.join(', ')}`);
    for (const plate of ['character_plate', 'location_plate', 'prop_plate', 'scene_card']) {
        assert.ok(kinds.includes(plate), `${plate} is generated but has no fingerprint kind`);
    }
    assert.strictEqual(kinds.length, 12, `expected 12 artefact kinds, found ${kinds.length}`);
});

test('every kind produces a stable fingerprint from the same inputs', () => {
    const ids = makeProject();
    const broken = [];
    for (const kind of Object.keys(fp.ARTEFACT_KINDS)) {
        let a, b;
        try {
            a = fp.fingerprintFor(kind, ids);
            b = fp.fingerprintFor(kind, ids);
        } catch (err) { broken.push(`${kind}: threw — ${err.message}`); continue; }
        if (!a) { broken.push(`${kind}: produced no fingerprint`); continue; }
        if (a !== b) broken.push(`${kind}: not stable — same inputs gave ${a.slice(0, 8)} then ${b.slice(0, 8)}`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('every kind notices when its inputs change', () => {
    const broken = [];
    for (const [kind, mutate] of Object.entries(MUTATIONS)) {
        const ids = makeProject();
        let before, after;
        try {
            before = fp.fingerprintFor(kind, ids);
            mutate(ids);
            after = fp.fingerprintFor(kind, ids);
        } catch (err) { broken.push(`${kind}: threw — ${err.message}`); continue; }
        if (before === after) {
            broken.push(`${kind}: input changed and the fingerprint did not — this is the plate bug`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('a change to one kind does not falsely stale an unrelated one', () => {
    // Over-broad fingerprints are the other failure: if every edit invalidates
    // everything, staleness becomes noise and gets switched off.
    const ids = makeProject();
    const before = fp.fingerprintFor('ambient', ids);
    db.prepare('UPDATE film_characters SET appearance_prompt = ? WHERE id = ?').run('different face', ids.charId);
    const after = fp.fingerprintFor('ambient', ids);
    assert.strictEqual(before, after,
        'a character wardrobe change invalidated an ambient bed, which nothing about it describes');
});

test('an artefact with no recorded fingerprint is not stale', () => {
    // Every project that predates this feature must generate exactly as before.
    assert.strictEqual(fp.isStale({ input_fingerprint: null }, 'anything'), false);
    assert.strictEqual(fp.isStale({}, 'anything'), false);
});

test('staleness is a comparison, not a flag', () => {
    const ids = makeProject();
    const recorded = fp.fingerprintFor('keyframe', ids);
    assert.strictEqual(fp.isStale({ input_fingerprint: recorded }, recorded), false);
    assert.strictEqual(fp.isStale({ input_fingerprint: recorded }, 'something-else'), true);
});

// ── Recording, propagation and the gate ────────────────────────────────────

const fs = require('fs');
const PERSIST_SITES = [
    { kind: 'keyframe', file: 'routes/storyboard.js' },
    { kind: 'orchestrated (8 capabilities)', file: 'routes/pipeline.js' },
    { kind: 'location_plate + prop_plate', file: 'lib/reference-plates.js' },
    { kind: 'character_plate', file: 'routes/characters.js' },
];

test('every site that saves a generated asset stamps it', () => {
    // A generator that persists without stamping leaves a NULL fingerprint,
    // which reads as "outside the workflow" — indistinguishable from an asset
    // that predates the feature, and therefore never stale. Silent by design,
    // so it has to be checked structurally.
    const missing = PERSIST_SITES.filter(site => {
        const src = fs.readFileSync(path.join(__dirname, '..', site.file), 'utf8');
        return !/stampAsset\(/.test(src);
    }).map(s => `${s.file} (${s.kind})`);
    assert.deepStrictEqual(missing, [], `persist sites that never stamp: ${missing.join(', ')}`);
});

test('the schema can hold a fingerprint', () => {
    const cols = db.prepare('PRAGMA table_info(film_assets)').all().map(c => c.name);
    for (const c of ['input_fingerprint', 'artefact_kind', 'fingerprinted_at']) {
        assert.ok(cols.includes(c), `migration 063 did not add ${c}`);
    }
});

test('a stamped asset goes stale when its inputs change, and not before', () => {
    const ids = makeProject();
    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name)
                VALUES (?, ?, ?, 'keyframe', '/tmp/x.png', 'x.png')`)
        .run(assetId, ids.projectId, ids.shotId);

    const stamped = fp.stampAsset(assetId, 'keyframe', ids);
    assert.ok(stamped, 'stampAsset recorded nothing');

    const read = () => db.prepare('SELECT input_fingerprint FROM film_assets WHERE id = ?').get(assetId);
    assert.strictEqual(fp.isStale(read(), fp.fingerprintFor('keyframe', ids)), false,
        'fresh asset reported stale');

    db.prepare('UPDATE film_characters SET appearance_prompt = ? WHERE id = ?')
        .run('an entirely different woman', ids.charId);
    assert.strictEqual(fp.isStale(read(), fp.fingerprintFor('keyframe', ids)), true,
        'the character changed and the frame still claims to be current');
});

test('propagation follows PIPELINE_STEPS.depends, not a second hand-written graph', () => {
    // Two dependency graphs drift. The orchestrator already declares this one.
    const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
    const declared = {};
    for (const step of PIPELINE_STEPS) declared[step.id] = step.depends;
    for (const [kind, spec] of Object.entries(fp.ARTEFACT_KINDS)) {
        if (!spec.dependsOn) continue;
        const stepId = kind;
        if (!declared[stepId]) continue;
        assert.deepStrictEqual(spec.dependsOn.slice().sort(), declared[stepId].slice().sort(),
            `${kind} declares different dependencies than PIPELINE_STEPS`);
    }
});


// ── PAR-006: the gate ──────────────────────────────────────────────────────

test('dependencies are DERIVED from PIPELINE_STEPS, never hand-declared', () => {
    // Written after the hand-written list drifted from the orchestrator on its
    // first day: video depends on keyframe (it is the init_image) and the
    // registry did not say so, which meant a video generated from a stale
    // keyframe would have passed any gate built on it.
    const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
    const wrong = [];
    for (const step of PIPELINE_STEPS) {
        const spec = fp.ARTEFACT_KINDS[step.id];
        if (!spec) continue;   // assembly has no artefact
        const declared = (spec.dependsOn || []).slice().sort();
        const actual = step.depends.slice().sort();
        if (JSON.stringify(declared) !== JSON.stringify(actual)) {
            wrong.push(`${step.id}: registry says [${declared}], PIPELINE_STEPS says [${actual}]`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('generating on top of a stale input is refused, per dependent kind', () => {
    // Set-based over every kind that has dependencies, because gating one of
    // them proves nothing about the rest — and the expensive mistake is
    // building a clip on a keyframe that no longer matches its character.
    const dependent = Object.entries(fp.ARTEFACT_KINDS).filter(([, s]) => (s.dependsOn || []).length);
    assert.ok(dependent.length >= 3, `expected several dependent kinds, found ${dependent.length}`);

    const broken = [];
    for (const [kind, spec] of dependent) {
        const ids = makeProject();
        // Stamp one asset per dependency so there is something to go stale.
        for (const dep of spec.dependsOn) {
            const assetId = generateId();
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name)
                        VALUES (?, ?, ?, 'other', '/tmp/x', 'x')`).run(assetId, ids.projectId, ids.shotId);
            fp.stampAsset(assetId, dep, ids);
        }
        if (fp.staleInputs(kind, ids).length) {
            broken.push(`${kind}: reported stale inputs while everything was freshly stamped`);
            continue;
        }
        // Now change something every dependency is built from.
        db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
            .run(JSON.stringify({ shot_code: '1A', description: 'Rewritten.', camera: { shot_type: 'wide' } }), ids.shotId);
        const stale = fp.staleInputs(kind, ids);
        if (!stale.length) broken.push(`${kind}: its inputs changed and it would generate anyway`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('a kind whose inputs were never stamped is never gated', () => {
    // The guarantee that keeps every existing project generating unchanged.
    const ids = makeProject();
    assert.deepStrictEqual(fp.staleInputs('lipsync', ids), [],
        'a shot with no stamped assets was gated, which would break every project that predates this');
});

test('the gate is reachable from generation, not just computable', () => {
    // A gate nothing calls is a library. Checked structurally: the orchestrator
    // is the one path every orchestrated capability goes through.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8');
    assert.ok(/staleInputs\(/.test(src), 'routes/pipeline.js never consults the stale gate');
    assert.ok(/ignore_stale/.test(src), 'the gate has no override, so a wrong fingerprint is unrecoverable');
});
