/**
 * A cue is written to the length of the cut, not to a default.
 *
 * "If we generate a soundtrack for a clip, how do we know the final length and
 * feed the right prompt?"
 *
 * Today: we do not. `buildMusicPrompt` reads
 * `cue.duration_ms || scene.estimated_duration || 30000`, and
 * `estimated_duration` is **0** on every scene in both real projects — 0 is
 * falsy, so every cue falls through to a hardcoded thirty seconds. Measured:
 * Wingfall scene 1 holds 22.08s of real footage and scene 2 holds 10.05s, and
 * both would be scored at 30s.
 *
 * The engine already knows the right number. `measuredDurations()` reads the
 * real length of every clip off disk, and the conform and all three NLE
 * exporters use it to build the film. Music was the one thing still guessing.
 *
 * What it CANNOT know is a re-cut made in Premiere: there is no FCPXML, EDL or
 * xmeml parser anywhere in this repo — the NLE seam is one-way. That is a real
 * limit and is stated rather than papered over.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-cuelen-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();

const { buildMusicPrompt } = require('../lib/music-prompt');
const { sceneCutLength } = require('../lib/clip-coverage');

const PROJECT = 'cl000000-0000-4000-8000-000000000001';
const SCENE = 'cl000000-0000-4000-8000-000000000002';

test.before(() => {
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'p', datetime('now'), datetime('now'))`).run(PROJECT);
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, location, estimated_duration, created_at)
                VALUES (?, ?, 1, 'DINER', 0, datetime('now'))`).run(SCENE, PROJECT);

    // Two shots with real clips of known length.
    for (const [i, ms] of [[1, 6000], [2, 4500]]) {
        const shot = `cl000000-0000-4000-8000-00000000010${i}`;
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, created_at)
                    VALUES (?, ?, ?, '{}', datetime('now'))`).run(shot, SCENE, `1${'AB'[i - 1]}`);
        db.prepare(`INSERT INTO film_assets
              (id, project_id, shot_id, asset_type, file_path, file_name, mime_type, duration_ms, version, created_at)
            VALUES (?, ?, ?, 'video_raw', ?, ?, 'video/mp4', ?, 1, datetime('now'))`)
            .run(crypto.randomUUID(), PROJECT, shot, `/tmp/${shot}.mp4`, `${shot}.mp4`, ms);
    }
});

test('the cut length is the sum of the measured clips, not an estimate', () => {
    /*
     * 0 is falsy, which is why `scene.estimated_duration` never even reached
     * the prompt — the default swallowed it. The measured length has to be
     * computed from the clips that actually exist.
     */
    assert.strictEqual(sceneCutLength(db, SCENE), 10500,
        'the scene cut length is not the sum of its measured clips');
});

test('a scene with no footage yet reports nothing, not zero', () => {
    /*
     * "No footage" and "a zero-length scene" are different answers and zero
     * cannot tell them apart — that conflation is exactly what made
     * estimated_duration: 0 fall through to a 30-second default without
     * anybody noticing.
     */
    const empty = 'cl000000-0000-4000-8000-000000000003';
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, location, created_at)
                VALUES (?, ?, 2, 'STREET', datetime('now'))`).run(empty, PROJECT);
    assert.strictEqual(sceneCutLength(db, empty), null,
        'a scene with no clips reports 0 rather than "nothing measured"');
});

test('the music prompt is written to the measured cut when there is one', () => {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(SCENE);
    const payload = buildMusicPrompt({ mood: 'melancholy' }, scene, { db });
    assert.strictEqual(payload.duration_s, 10.5,
        `the cue was written at ${payload.duration_s}s for a 10.5s cut`);
    assert.strictEqual(payload.duration_source, 'measured',
        'the payload does not say where its length came from');
});

test('an explicit cue length still wins', () => {
    // A composer asking for a 45-second piece over a 10-second scene is making
    // a decision, not a mistake — an underscore that runs past the cut is
    // ordinary, and the engine must not overrule it.
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(SCENE);
    const payload = buildMusicPrompt({ mood: 'melancholy', duration_ms: 45000 }, scene, { db });
    assert.strictEqual(payload.duration_s, 45);
    assert.strictEqual(payload.duration_source, 'cue');
});

test('with nothing measured it falls back, and SAYS it fell back', () => {
    /*
     * The default is not the problem; a silent default is. A director told
     * "30s, because nothing has been shot yet" can act on it — generate the
     * footage first, or set the cue length by hand.
     */
    const empty = db.prepare('SELECT * FROM film_scenes WHERE scene_number = 2 AND project_id = ?').get(PROJECT);
    const payload = buildMusicPrompt({ mood: 'tense' }, empty, { db });
    assert.strictEqual(payload.duration_s, 30);
    assert.strictEqual(payload.duration_source, 'default');
    assert.match(String(payload.duration_note || ''), /no footage|nothing.*measured|not been shot/i,
        'a defaulted length does not say why');
});

test('every caller measures the cut, without having to ask', () => {
    /*
     * The handle is required LAZILY rather than threaded through the call
     * sites. This module is used by the route, the orchestrator and the flow
     * canvas; passing a database through all three to fix one number is how
     * two of them end up still guessing — the "three paths out of four" gap
     * this codebase has shipped twice.
     *
     * So the check is that the measurement does not depend on the caller.
     */
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'music-prompt.js'), 'utf8');
    assert.match(src, /require\('\.\.\/db\/database'\)\.db/,
        'the cut length can only be measured when a caller supplies a handle');
    assert.match(src, /sceneCutLength/, 'the prompt no longer measures the cut at all');

    // And an existing caller, unchanged, gets a measured length.
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(SCENE);
    const payload = buildMusicPrompt({ mood: 'melancholy' }, scene);
    assert.strictEqual(payload.duration_source, 'measured',
        'a caller that passes no handle falls back instead of measuring');
});

test('the NLE seam is one-way, and that is stated', () => {
    /*
     * There is no FCPXML, EDL or xmeml PARSER in this repo — export only. So a
     * re-cut made in Premiere cannot be read back, and a cue written to the
     * engine's own assembly may not match the finished edit. Pinned as a fact
     * rather than left for someone to assume otherwise.
     */
    const dir = path.join(__dirname, '..');
    const files = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'tests') continue;
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.js')) files.push(full);
        }
    }(dir));

    const importers = files.filter(f => /parseFcpxml|parseEdl|parseXmeml|importTimeline/
        .test(fs.readFileSync(f, 'utf8')));
    assert.deepStrictEqual(importers, [],
        'an NLE importer now exists — the cue length can follow the finished edit, '
        + 'and this test and the docs should say so');
});

test('a reference track reaches the prompt as a style, not a title', () => {
    /*
     * "Sounds like X" is the clearest music note a director gives, and
     * `film_music_cues.reference_track` was stored and read by nothing.
     * Phrased as a style to match rather than pasted in raw, which would read
     * as a title to quote.
     */
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(SCENE);
    const payload = buildMusicPrompt(
        { mood: 'melancholy', reference_track: 'Blade Runner end titles' }, scene);
    assert.match(payload.prompt, /in the style of Blade Runner end titles/,
        'the reference track never reaches the prompt');
});

test('every field the prompt reads has a control', () => {
    /*
     * `instruments` and `key_signature` were READ BY THE GENERATOR and had no
     * field in the cue form — the same gap as a control that reaches nothing,
     * seen from the other side. Derived from what the prompt actually reads,
     * so a field added to the builder later is covered.
     */
    const promptSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'music-prompt.js'), 'utf8');
    const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

    const read = [...new Set([...promptSrc.matchAll(/\bcue\.([a-z_]+)/g)].map(m => m[1]))];
    // Fields the generator derives rather than the director setting them.
    const DERIVED = new Set(['duration_s', 'category', 'sound', 'seed']);

    /*
     * A control need not be named after its field.
     *
     * Two are not, and both for a reason: a length is typed in seconds and
     * stored in milliseconds, and sections are a repeating editor rather than
     * one input. Exempt BY NAME with the control named, on the rule
     * manual-edit.test.js already follows — an exemption matching on shape
     * would quietly excuse the next field that has no control at all, which is
     * the exact gap this test exists to catch. Each named control must exist
     * AND be bound to something that runs.
     */
    const NAMED_CONTROLS = {
        duration_ms: ['data-field="duration_s"', 'data.duration_ms = Math.round(Number(data.duration_s)'],
        sections: ['id="cueSections"', 'onclick="cueAddSection()"', 'function cueAddSection()',
            'data.sections = sections'],
    };

    const at = SPA.indexOf('id="musicCueModal"');
    assert.notStrictEqual(at, -1, 'the cue form is gone');
    const form = SPA.slice(at, at + 6000);

    const missing = read.filter(f => !DERIVED.has(f)
        && !NAMED_CONTROLS[f]
        && !form.includes(`data-field="${f}"`));
    assert.deepStrictEqual(missing, [],
        `the generator reads these and nobody can set them: ${missing.join(', ')}`);

    for (const [field, needles] of Object.entries(NAMED_CONTROLS)) {
        assert.ok(read.includes(field),
            `${field} is exempted with a named control and the generator no longer reads it — `
            + 'a stale exemption makes the whole list a lie');
        for (const needle of needles) {
            assert.ok(SPA.includes(needle),
                `${field} claims to be set by ${needle}, which is not in the page`);
        }
    }

    // Length is typed in seconds and stored in ms.
    assert.match(form, /data-field="duration_s"/, 'no way to set a cue length');
    assert.match(SPA, /data\.duration_ms = Math\.round\(Number\(data\.duration_s\)/,
        'a cue length typed in seconds is stored as seconds');
});

test('instruments are stored as a list, not as one long instrument', () => {
    // The route JSON-stringifies whatever it is given; a raw comma string
    // becomes a single instrument called "solo cello, brushed kit".
    const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.match(SPA, /data\.instruments\.split\(','\)/,
        'the instruments field is sent as a raw string');
});
