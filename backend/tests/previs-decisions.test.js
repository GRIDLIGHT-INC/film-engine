/**
 * DECISIONS YOU CAN SEE AND LOCK, AND THE CONSOLE THAT SHOWS THEM.
 *
 * Apply and approve already existed as whole-shot fingerprints. This holds the
 * per-decision layer over them: each of the seven chips reports its own state,
 * only an applied decision can be locked, a locked decision that moves reads
 * as stale, and "Lock shot" signs the blocking off exactly as previs_approve
 * does — so every guard downstream of approval keeps working unchanged.
 *
 * And it holds the one-screen console (previs_console): off, the console is
 * the handoff layout byte for byte; on, every element the writers look up by
 * id is still there, and every class it renders has a rule.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-decisions-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handlePrevis } = require('../routes/previs');
const { decisionParts, DECISION_CHIPS, DECISIONS } = require('../lib/decision-contract');
const { renderConsole } = require('./console-render');

const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function makeShot() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Decisions');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)').run(generateId(), projectId, 'JUNE');
    const card = JSON.stringify({ shot_code: '1B', description: 'The booth.', camera: { shot_type: 'medium', lens: '35mm' } });
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, ?)')
        .run(shotId, sceneId, '1B', card, 4000);
    return shotId;
}

function call(method, urlPath, body) {
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

const BLOCKING = {
    camera: { position: [0, 1.2, 3], rotation: [0, 0, 0], focalMm: 50, sensorId: 'super35', fStop: 2.8, focusDistanceM: 3 },
    subject: { position: [0, 0, 0], heightM: 1.68 },
    subjects: [{ name: 'June', kind: 'human', position: [0, 0, 0] }],
    stage: { widthM: 12, depthM: 12 },
    rig: 'dolly',
    movement: 'dolly-in',
    director: { direction: 'Closer on June as she realises', lighting: null, location_view: '' },
};

const stateOf = (decisions, id) => (decisions.find(d => d.id === id) || {}).state;

test('every chip names a decision the contract already knows', () => {
    const known = new Set([...DECISIONS.map(d => d.id), 'previs.spatial-workspace']);
    for (const chip of DECISION_CHIPS) {
        assert.ok(known.has(chip.decision), `${chip.id} points at ${chip.decision}, which the registry does not declare`);
    }
    assert.strictEqual(DECISION_CHIPS.length, 7);
});

test('a change to one decision moves only that decision', () => {
    const row = { camera_json: JSON.stringify(BLOCKING.camera), director_json: JSON.stringify(BLOCKING.director),
        subjects_json: JSON.stringify(BLOCKING.subjects), movement: 'dolly-in', moves_json: '[]' };
    const card = { camera: { lens: '50mm' }, direction: 'Closer on June as she realises' };
    const a = decisionParts(row, card, { characterNames: ['JUNE'] });
    const b = decisionParts({ ...row, director_json: JSON.stringify({ ...BLOCKING.director, direction: 'Wider' }) },
        card, { characterNames: ['JUNE'] });
    const moved = DECISION_CHIPS.map(c => c.id).filter(id => a[id].stage !== b[id].stage);
    assert.deepStrictEqual(moved, ['direction']);
    assert.strictEqual(a.characters.has, true, 'a staged, known character is a cast decision');
});

test('trying → applied → locked, and a locked decision that moves reads as stale', async () => {
    const shotId = makeShot();
    const saved = await call('PUT', `/film/shots/${shotId}/previs`, BLOCKING);
    assert.ok(saved.status < 400, JSON.stringify(saved.body));

    let got = await call('GET', `/film/shots/${shotId}/previs`);
    assert.strictEqual(stateOf(got.body.decisions, 'camera'), 'trying');
    assert.strictEqual(stateOf(got.body.decisions, 'props'), 'none');

    const early = await call('POST', `/film/shots/${shotId}/previs/lock`, { decisions: ['camera'] });
    assert.strictEqual(early.status, 409, 'a decision still being tried must not lock');
    assert.strictEqual(early.body.code, 'NOT_APPLIED');

    const applied = await call('POST', `/film/shots/${shotId}/previs/apply`);
    assert.ok(applied.status < 400, JSON.stringify(applied.body));
    got = await call('GET', `/film/shots/${shotId}/previs`);
    assert.strictEqual(stateOf(got.body.decisions, 'camera'), 'applied');
    assert.strictEqual(stateOf(got.body.decisions, 'direction'), 'applied');

    const locked = await call('POST', `/film/shots/${shotId}/previs/lock`, { decisions: ['camera'] });
    assert.strictEqual(locked.status, 200, JSON.stringify(locked.body));
    assert.strictEqual(stateOf(locked.body.decisions, 'camera'), 'locked');
    assert.strictEqual(stateOf(locked.body.decisions, 'direction'), 'applied', 'locking one leaves the others alone');

    await call('PUT', `/film/shots/${shotId}/previs`, { ...BLOCKING, camera: { ...BLOCKING.camera, focalMm: 85 } });
    got = await call('GET', `/film/shots/${shotId}/previs`);
    assert.strictEqual(stateOf(got.body.decisions, 'camera'), 'stale');

    const unlocked = await call('POST', `/film/shots/${shotId}/previs/unlock`, { decisions: ['camera'] });
    assert.strictEqual(stateOf(unlocked.body.decisions, 'camera'), 'trying');
});

test('Lock shot signs the blocking off, and Unlock shot withdraws it', async () => {
    const shotId = makeShot();
    await call('PUT', `/film/shots/${shotId}/previs`, BLOCKING);
    await call('POST', `/film/shots/${shotId}/previs/apply`);
    const r = await call('POST', `/film/shots/${shotId}/previs/lock`, { all: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.approval.approved, true, 'Lock shot must approve, so generation guards it');
    assert.ok(r.body.decisions.filter(d => d.state !== 'none').every(d => d.state === 'locked'));

    const u = await call('POST', `/film/shots/${shotId}/previs/unlock`, { all: true });
    assert.strictEqual(u.body.approval.approved, false);
    assert.ok(!u.body.decisions.some(d => d.state === 'locked'));
});

test('an unknown decision is refused by name', async () => {
    const shotId = makeShot();
    await call('PUT', `/film/shots/${shotId}/previs`, BLOCKING);
    const r = await call('POST', `/film/shots/${shotId}/previs/lock`, { decisions: ['colour'] });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /colour/);
});

/* ── the one-screen console ─────────────────────────────────────────────── */

const ON = { world_engine: true, previs_console: true, cinematography_ai: true, camera_explore: true, reference_match: true };

test('off, the console is the handoff layout; on, it is one screen', () => {
    const off = renderConsole({ world_engine: true });
    assert.ok(!/pv-console/.test(off), 'previs_console off must leave the two-column console untouched');
    const on = renderConsole(ON);
    assert.match(on, /class="pv-console"/);
    for (const tab of ['Camera', 'Direct', 'Explore', 'Scene']) assert.ok(on.includes(`>${tab}</button>`), `no ${tab} tab`);
});

test('every element the writers find by id is still rendered', () => {
    const on = renderConsole(ON);
    for (const id of ['weFrame', 'weFrameCanvas', 'weReadout', 'weCamSpec', 'weOvCount', 'weOverlayMenu',
        'weLensNow', 'weModeHint', 'weMeasure', 'weRisk', 'weRiskGrade', 'weExport', 'weExportState', 'wePathCanvas']) {
        assert.ok(on.includes(`id="${id}"`), `#${id} is missing from the one-screen console`);
        assert.strictEqual(on.split(`id="${id}"`).length - 1, 1, `#${id} is rendered twice`);
    }
});

test('every pv-* class the console renders has a rule', () => {
    const on = renderConsole(ON);
    const used = new Set();
    for (const m of on.matchAll(/class="([^"]+)"/g)) {
        for (const c of m[1].split(/\s+/)) if (/^pv-[a-z_-]+$/.test(c)) used.add(c);
    }
    assert.ok(used.size >= 12, `only found ${used.size} pv-* classes`);
    for (const cls of used) {
        assert.ok(new RegExp(`\\.${cls}\\b[^{]*\\{`).test(PAGE), `.${cls} is rendered and defined in no stylesheet`);
    }
    for (const state of ['trying', 'applied', 'locked', 'card_ahead', 'conflict', 'stale']) {
        assert.ok(new RegExp(`\\.pv-dec-${state}\\b`).test(PAGE), `no style for a ${state} decision`);
    }
});

test('in one-screen layout too, the flag that unlocks spending hides the button that spends', () => {
    const on = renderConsole({ ...ON, marble_generation: true });
    const off = renderConsole({ ...ON, marble_generation: false });
    assert.match(on, /worldOpenCreate\(\)/, 'no way to create a world with marble_generation on');
    assert.ok(!/worldOpenCreate\(\)/.test(off), 'the spending button renders with marble_generation off');
});
