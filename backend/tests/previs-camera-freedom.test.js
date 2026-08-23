/**
 * Any camera move, on a stage you can actually load.
 *
 * The director's complaint is that previs is "a bit limited". Measured, it is
 * limited to TWO DEGREES OF FREEDOM. src/index.html builds the shot camera as
 * `position: [0, height, distance]` with `rotation: [0,0,0]` — X and all three
 * rotations are literals — and lib/previs-blocking.js solveShot places it at
 * `[target.x, height, target.z + distance]` with `rotation: [0, pitch, roll]`,
 * so YAW IS ALWAYS ZERO at the library level too. The camera lives on a rail
 * through the subject and can never turn. A three-quarter angle and a reverse
 * are not hard to author here; they are unsayable.
 *
 * Meanwhile PREVIS.orbit has full yaw/pitch/distance — but that is the VIEWER.
 * So a director can look anywhere and place the camera nowhere, which is the
 * exact experience of a 3D view that feels limited without it being obvious
 * why.
 *
 * Held to five things, each derived rather than typed:
 *
 *   1. every pose/optic component is operable and round-trips
 *   2. an authored path is the SOURCE and the sampled path is derived from it
 *   3. an authored path names itself honestly to BOTH consumers
 *   4. the 18 presets still compile to the paths they compile to today
 *   5. every model subject kind can be loaded onto the stage, and labelled
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, '..', 'src', 'index.html');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-freedom-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handlePrevis } = require('../routes/previs');
const {
    MOVEMENTS, defaultBlocking, samplePath, solveShot,
} = require('../lib/previs-blocking');

// Comments are not code. Paid for four times in this codebase.
function stripComments(src) {
    let out = ''; let i = 0; let mode = null; let quote = '';
    while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (mode === null) {
            if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
            if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
            if (c === '"' || c === "'") { mode = 'str'; quote = c; out += c; i++; continue; }
            if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (mode === 'line') { if (c === '\n') { mode = null; out += c; } i++; continue; }
        if (mode === 'block') { if (c === '*' && d === '/') { mode = null; i += 2; } else i++; continue; }
        if (mode === 'str') { out += c; if (c === '\\') { out += d; i += 2; continue; } if (c === quote) mode = null; i++; continue; }
        out += c; if (c === '\\') { out += d; i += 2; continue; } if (c === '`') mode = null; i++;
    }
    return out;
}
const readCode = rel => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readUi = () => stripComments(fs.readFileSync(SRC, 'utf8').replace(/<!--[\s\S]*?-->/g, ''));

// ── The pose/optic set, derived from what the route validates ───────────────
//
// Not a typed list of ten field names: validateBlocking is what decides the
// shape a camera may take, so it is what the set comes from. Vector fields
// expand per axis because the whole defect is that ONE AXIS of position and
// ALL THREE of rotation are literals — a set keyed on "position" would report
// a camera that can only slide along Z as fully operable.

function derivePoseComponents() {
    const src = readCode('routes/previs.js');
    const fn = src.match(/function validateBlocking[\s\S]*?\n}/);
    assert.ok(fn, 'validateBlocking is gone — the derivation is wrong, not the code');

    const scalars = [];
    for (const m of fn[0].matchAll(/camera\.([A-Za-z]+) !== undefined/g)) scalars.push(m[1]);
    if (/camera\.sensorId/.test(fn[0])) scalars.push('sensorId');

    /*
     * focusDistanceM is a camera component the rest of the system plainly
     * treats as one — applyBlockingToCard writes it onto the card and solveShot
     * returns it — and validateBlocking does not check it at all. So the
     * validator alone derives NINE of the ten, and the tenth is missing for a
     * reason worth its own assertion below rather than being quietly added to
     * the count here.
     */
    for (const m of readCode('routes/previs.js').matchAll(/camera\.(focusDistanceM)\b/g)) scalars.push(m[1]);

    const vectors = [];
    const vec = fn[0].match(/for \(const field of \[([^\]]+)\]\)/);
    if (vec) for (const f of vec[1].split(',')) vectors.push(f.trim().replace(/^['"]|['"]$/g, ''));

    const out = [];
    for (const v of vectors) for (const axis of [0, 1, 2]) out.push({ id: `${v}[${axis}]`, vector: v, axis });
    for (const s of [...new Set(scalars)]) out.push({ id: s, scalar: s });
    return out;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function callPrevis(method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const req = { method, body: body || {} };
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            const raw = Buffer.concat(chunks).toString();
            let parsed = raw;
            try { parsed = JSON.parse(raw); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handlePrevis(req, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function seedShot() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Freedom');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, ?)')
        .run(shotId, sceneId, 'P1', JSON.stringify({
            shot_code: 'P1', description: 'Probe.',
            camera: { shot_type: 'close-up', lens: '50mm', movement: 'dolly-in' },
        }), 4000);
    return { projectId, shotId };
}

const BASE = () => ({
    camera: { position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50,
        sensorId: 'super35', fStop: 2.8, focusDistanceM: 3 },
    subject: { position: [0, 0, 0], heightM: 1.7 },
    stage: { widthM: 12, depthM: 12 }, rig: 'dolly', movement: 'dolly-in',
});

// Distinctive, valid, and different from every default, so a value that
// survives cannot be a default that happened to match.
const PROBE = { 'position[0]': -2.75, 'position[1]': 0.42, 'position[2]': 4.25,
    'rotation[0]': 0.31, 'rotation[1]': -0.77, 'rotation[2]': 0.12,
    focalMm: 137, fStop: 5.6, focusDistanceM: 6.25, sensorId: 'fullframe' };

// ── 1. Six degrees of freedom, and every optic ─────────────────────────────

test('every pose and optic component can be set and comes back', async () => {
    const components = derivePoseComponents();
    assert.ok(components.length >= 10,
        `expected at least 10 pose/optic components, derived ${components.length}: `
        + components.map(c => c.id).join(', '));

    const lost = [];
    for (const c of components) {
        const value = PROBE[c.id];
        if (value === undefined) { lost.push(`${c.id}: no probe value — the derivation found a field this test does not know`); continue; }

        const { shotId } = seedShot();
        const body = BASE();
        if (c.vector) body.camera[c.vector][c.axis] = value;
        else body.camera[c.scalar] = value;

        const saved = await callPrevis('PUT', `/film/shots/${shotId}/previs`, body);
        if (saved.status >= 400) { lost.push(`${c.id}: refused (${JSON.stringify(saved.body)})`); continue; }

        const got = (await callPrevis('GET', `/film/shots/${shotId}/previs`)).body || {};
        const cam = (got.blocking && got.blocking.camera) || {};
        const back = c.vector ? (cam[c.vector] || [])[c.axis] : cam[c.scalar];
        const same = typeof value === 'number'
            ? Math.abs(Number(back) - value) < 1e-6 : back === value;
        if (!same) lost.push(`${c.id}: ${JSON.stringify(value)} -> ${JSON.stringify(back)}`);
    }
    assert.deepStrictEqual(lost, [], 'pose or optic components that do not round-trip');
});

test('every camera component the stage stores is validated', () => {
    /*
     * focusDistanceM is written onto the scene card by applyBlockingToCard and
     * returned by solveShot, so it is a camera component in every sense the
     * rest of the system uses — and validateBlocking never checks it. A
     * negative or NaN focus distance is therefore storable, and it reaches the
     * depth-of-field maths and the card. The other optics are all guarded as
     * "a positive number"; this one is guarded by nobody.
     *
     * Small, and worth fixing while the camera is being opened up rather than
     * after six degrees of freedom make bad poses easier to author.
     */
    const fn = readCode('routes/previs.js').match(/function validateBlocking[\s\S]*?\n}/);
    assert.ok(fn, 'validateBlocking is gone');
    assert.ok(/focusDistanceM/.test(fn[0]),
        'validateBlocking accepts any focusDistanceM, including negative and NaN, '
        + 'while every other optic is checked as a positive number');
});

test('the stage can place the camera off-axis and turn it', () => {
    /*
     * solveShot is the entry edge: /previs/from-card seeds the stage from what
     * was written, so if the solver can only produce a frontal camera, every
     * explored angle is reset to frontal the moment a director re-seeds. Fixing
     * only the UI leaves that leak open, and it reads as previs throwing work
     * away rather than as a solver limit.
     *
     * Checked through the SOLVER rather than the source, because the question
     * is what it can PRODUCE. A solver that grew an unused yaw argument would
     * pass a grep and fail a director.
     */
    const target = { position: [0, 0, 0], heightM: 1.7 };
    const gaps = [];

    const straight = solveShot({ shotType: 'medium', focalMm: 50, subject: target });
    const angled = solveShot({ shotType: 'medium', focalMm: 50, subject: target, azimuthDeg: 40 });

    if (!angled || typeof angled !== 'object') {
        gaps.push('solveShot cannot be asked for an angle at all');
    } else {
        const sameSpot = ['0', '1', '2'].every(i =>
            Math.abs((angled.position || [])[i] - (straight.position || [])[i]) < 1e-9);
        if (sameSpot) gaps.push('an azimuth does not move the camera off the subject axis');
        const yaw = (angled.rotation || [])[0];
        if (!Number.isFinite(yaw) || Math.abs(yaw) < 1e-9) {
            gaps.push('the solved camera has no yaw, so it cannot be turned to face the subject from the side');
        }
    }
    assert.deepStrictEqual(gaps, [],
        'the solver can only place a camera directly in front of its subject');
});

test('the stage offers a control for every pose component a director must set', () => {
    /*
     * The route has always accepted a full pose; the PAGE is what hardcodes it.
     * So a route-only test passes today with the camera nailed to one axis,
     * which is the state a director is complaining about.
     *
     * Executed against the reader the page actually uses, not a grep for input
     * ids: a field that exists and is never read is indistinguishable from one
     * that is missing, and this codebase has shipped exactly that (mood-board
     * specs validated and consumed nowhere).
     */
    const ui = readUi();
    const reader = ui.match(/function previsReadInspector\(\)[\s\S]*?\n    \}/);
    assert.ok(reader, 'previsReadInspector is gone');

    const literalAxis = /position:\s*\[\s*0\s*,/.test(reader[0]);
    const literalRotation = /rotation:\s*\[\s*0\s*,\s*0\s*,\s*0\s*\]/.test(reader[0]);

    const gaps = [];
    if (literalAxis) gaps.push('previsReadInspector pins camera X to 0 — the camera cannot leave the subject axis');
    if (literalRotation) gaps.push('previsReadInspector pins all three rotations to 0 — the camera cannot turn');
    assert.deepStrictEqual(gaps, [],
        'the page cannot express a pose the route would accept');
});

// ── 2/3. An authored path is the source, and it names itself ───────────────

test('an authored camera path is stored as the source, not resampled away', async () => {
    /*
     * putBlocking re-samples path_json from the movement enum on every save, so
     * an authored path handed in today is silently replaced by a preset's. That
     * is correct while presets are the only author — and it is exactly why keys
     * need their own field rather than reusing path_json: otherwise the derived
     * sample and the source are the same column, and there is no way to tell
     * "this is what the enum produced" from "this is what the director flew".
     *
     * Same argument migration 058 already made one level down when it chose to
     * store the sampled path rather than the parameters it came from.
     */
    const { shotId } = seedShot();
    const keys = [
        { t: 0,   position: [-3, 1.5, 4], rotation: [0.6, -0.1, 0], focalMm: 35 },
        { t: 0.5, position: [0, 1.7, 2.5], rotation: [0.2, -0.05, 0], focalMm: 50 },
        { t: 1,   position: [2.5, 1.2, 1.5], rotation: [-0.4, 0.05, 0], focalMm: 85 },
    ];
    const saved = await callPrevis('PUT', `/film/shots/${shotId}/previs`, { ...BASE(), cameraKeys: keys });
    assert.ok(saved.status < 400, `authored keys refused: ${JSON.stringify(saved.body)}`);

    const got = (await callPrevis('GET', `/film/shots/${shotId}/previs`)).body || {};
    const back = (got.blocking && (got.blocking.cameraKeys || got.blocking.camera_keys)) || null;
    assert.ok(Array.isArray(back) && back.length === keys.length,
        'the authored path was not stored as the source — nothing can distinguish it from a resampled preset');

    const first = back[0] || {};
    assert.ok(Math.abs((first.position || [])[0] - (-3)) < 1e-6,
        'the stored keys are not the keys that were authored');
});

test('an authored path names itself honestly to both consumers', async () => {
    /*
     * MOVEMENT_MAP feeds the image prompt (storyboard-prompt.js:388) and
     * CAMERA_CONTROL_MAP feeds the provider (video-prompt.js:87). An authored
     * path has no enum name, so unless one analyzer produces BOTH a real
     * movement id and honest prose, we rebuild the bug already written up as "A
     * Blocked Sequence Reported Itself as Static": a plainly-moving path went
     * out as camera_control static, and MOVEMENT_MAP['static'] is '' so the
     * still said nothing at all. Silent, both consumers, one root.
     *
     * The analyzer must be ONE function for the same reason effectiveCamera is:
     * two copies of a naming rule is how a display comes to disagree with a
     * generator.
     */
    let analyze;
    try { ({ analyzePath: analyze } = require('../lib/previs-blocking')); } catch (_) { analyze = null; }
    assert.ok(typeof analyze === 'function',
        'no single path analyzer — an authored path cannot name itself to the prompt or the provider');

    // A path that plainly moves must never be called static.
    const moving = [
        { t: 0, position: [-3, 1.5, 4], rotation: [0.6, 0, 0], focalMm: 35 },
        { t: 1, position: [2.5, 1.5, 4], rotation: [-0.4, 0, 0], focalMm: 35 },
    ];
    const named = analyze(moving);
    assert.ok(named && typeof named === 'object', 'the analyzer returned nothing for a moving path');
    assert.ok(MOVEMENTS[named.dominantMovement],
        `dominantMovement '${named.dominantMovement}' is not a real MOVEMENTS id, so camera_control would carry an invented enum`);
    assert.notStrictEqual(named.dominantMovement, 'static',
        'a path whose camera plainly moves reported itself static — the exact bug this rule exists to stop');
    assert.ok(typeof named.description === 'string' && named.description.trim().length > 0,
        'the analyzer produced no prose, so a compound move reaches the prompt as one enum word or nothing');

    // And a genuinely still camera must still be nameable.
    const still = [
        { t: 0, position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50 },
        { t: 1, position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50 },
    ];
    assert.strictEqual(analyze(still).dominantMovement, 'static',
        'a camera that does not move should be called static');
});

// ── 4. The presets must not move ───────────────────────────────────────────

test('all 18 presets compile to the paths they compile to today', () => {
    /*
     * "Presets become shortcuts, not a competing system" is only true if this
     * never moves. Captured from the code as it stood BEFORE authored keys
     * existed, on the precedent of tests/fixtures/video-payload-golden.json —
     * and for the same reason: regenerating the fixture would delete the
     * guarantee rather than check it.
     */
    const golden = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures/previs-preset-paths.json'), 'utf8'));
    const ids = Object.keys(MOVEMENTS);
    assert.deepStrictEqual(ids.sort(), Object.keys(golden).sort(),
        'the movement registry and the golden fixture describe different sets');

    const drifted = [];
    for (const id of ids) {
        const now = samplePath(id, defaultBlocking(), { frames: 12 }).map(k => ({
            position: k.position.map(v => +v.toFixed(6)),
            rotation: (k.rotation || []).map(v => +v.toFixed(6)),
            focalMm: k.focalMm === undefined ? null : +Number(k.focalMm).toFixed(6),
            t: k.t === undefined ? null : +Number(k.t).toFixed(6),
        }));
        if (JSON.stringify(now) !== JSON.stringify(golden[id])) drifted.push(id);
    }
    assert.deepStrictEqual(drifted, [],
        'these presets no longer produce the path they produced before authored keys existed');
});

// ── 5. The stage you are exploring on ──────────────────────────────────────

test('every model subject kind can be staged, and arrives labelled', async () => {
    /*
     * "especially if we have 3D characters and location/props ... this way we
     * can load them" is half the ask, and the picker currently collapses every
     * label to "model": listModelJobs reports subject identity inside metadata
     * while the SPA reads subject_name/kind at the top level. A picker where
     * every entry reads the same makes loading them a guessing game.
     *
     * Derived from MODEL_SUBJECTS in routes/threed.js so a fourth subject kind
     * is covered with nothing to remember.
     */
    const threed = readCode('routes/threed.js');
    const m = threed.match(/MODEL_SUBJECTS\s*=\s*\{([^}]*)\}/);
    assert.ok(m, 'MODEL_SUBJECTS is gone — the derivation is wrong');
    const kinds = [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map(x => x[1])
        .filter((v, i, a) => a.indexOf(v) === i);
    assert.ok(kinds.length >= 3, `expected at least 3 model subject kinds, derived ${kinds.join(', ')}`);

    /*
     * Asked through the ROUTE the stage actually calls, not an export.
     * routes/threed.js exports only handleThreeD, so an export-based check
     * fails on code that works — my first version did exactly that.
     */
    const { projectId } = seedShot();
    const listed = await new Promise(resolve => {
        const { handleThreeD } = require('../routes/threed');
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let body = Buffer.concat(chunks).toString();
            try { body = JSON.parse(body); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body });
        });
        Promise.resolve(handleThreeD({ method: 'GET', body: {} }, res,
            ['film', 'projects', projectId, 'models'], {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
    assert.ok(listed.status < 400,
        `the stage cannot ask what models exist: ${JSON.stringify(listed.body)}`);
    const rows = (listed.body && listed.body.models) || [];
    const labelled = rows.every(r => r && (r.subject_name || r.name
        || (r.metadata && (r.metadata.subject_name || r.metadata.name))));
    assert.ok(rows.length === 0 || labelled,
        'a listed model carries no subject identity the picker can label it with');

    const ui = readUi();
    const loader = ui.match(/async function previsLoadModels\(\)[\s\S]*?\n    \}/);
    assert.ok(loader, 'previsLoadModels is gone');
    const readsIdentity = /subject_name|subject_kind|metadata/.test(loader[0]);
    assert.ok(readsIdentity,
        'the picker reads no subject identity, so every model is labelled the same');
});
