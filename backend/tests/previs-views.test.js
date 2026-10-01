/**
 * THE VIEWS A DIRECTOR JUDGES A CAMERA IN, AND WHERE THE DECISIONS GO NEXT.
 *
 * ADR-008 lets the Previs console draw the world itself — Look (splats), 360°,
 * Depth and Plan beside the geometric plate — and this holds the parts of that
 * which live in code rather than in pixels:
 *
 *  - the splats endpoint answers "switched off" differently from "this world
 *    has none", lists tiers smallest first, and fetches nothing;
 *  - every view mode renders as a button, and the note under the frame says
 *    that Look is NOT what generation receives;
 *  - the shots list lives in the app's side panel when the console is on;
 *  - Production reads the same decisions back, with the CARD's value beside
 *    each, and the graph node carries the lock count.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-views-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleWorlds } = require('../routes/worlds');
const { handlePrevis } = require('../routes/previs');
const { renderConsole } = require('./console-render');

const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function call(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const req = { method, body: body || {}, headers: {} };
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
        Promise.resolve(handler(req, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function setFlag(key, on) {
    db.prepare(`INSERT INTO film_app_settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, on ? 'true' : 'false');
}

function makeWorld(kinds) {
    const projectId = generateId(), worldId = generateId(), versionId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Views');
    db.prepare('INSERT INTO film_worlds (id, project_id, name) VALUES (?, ?, ?)').run(worldId, projectId, 'Diner');
    db.prepare('INSERT INTO film_world_versions (id, world_id, version, scale_factor) VALUES (?, ?, 1, 1.75)').run(versionId, worldId);
    for (const kind of kinds) {
        db.prepare('INSERT INTO film_world_assets (id, world_version_id, kind, remote_url) VALUES (?, ?, ?, ?)')
            .run(generateId(), versionId, kind, `https://cdn.example/${kind}.${kind === 'panorama' ? 'jpg' : 'spz'}`);
    }
    return versionId;
}

/* ── the splats endpoint ────────────────────────────────────────────────── */

test('off, the endpoint says so and lists what exists without handing out URLs', async () => {
    setFlag('world_splats', false);
    const vid = makeWorld(['splat_full', 'splat_100k']);
    const r = await call(handleWorlds, 'GET', `/film/world-versions/${vid}/splats`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.enabled, false);
    assert.deepStrictEqual(r.body.splats, [], 'a switched-off flag must not hand the page a 25 MB URL');
    assert.deepStrictEqual(r.body.available, ['splat_100k', 'splat_full'], 'off must still say what exists');
    assert.match(r.body.note, /world_splats/);
});

test('on, tiers come smallest first with the version scale, and a missing panorama is null', async () => {
    setFlag('world_splats', true);
    const vid = makeWorld(['splat_full', 'splat_500k', 'splat_100k']);
    const r = await call(handleWorlds, 'GET', `/film/world-versions/${vid}/splats`);
    assert.strictEqual(r.body.enabled, true);
    assert.deepStrictEqual(r.body.splats.map(s => s.kind), ['splat_100k', 'splat_500k', 'splat_full']);
    assert.ok(r.body.splats.every(s => /^https:\/\//.test(s.url) && s.local === false));
    assert.strictEqual(r.body.scale_factor, 1.75);
    assert.strictEqual(r.body.panorama, null);
    setFlag('world_splats', false);
});

/* ── the view modes ─────────────────────────────────────────────────────── */

const ON = { world_engine: true, previs_console: true, cinematography_ai: true, camera_explore: true, reference_match: true };

test('every view mode is a button, and the note under the frame is rendered', () => {
    const html = renderConsole(ON);
    for (const label of ['Look', '360°', 'Geometry', 'Depth', 'Plan']) {
        assert.ok(html.includes(`>${label}</button>`), `no ${label} button in the one-screen console`);
    }
    assert.ok(html.includes('id="pvModeNote"'), 'no note under the frame');
    assert.match(html, /pv-frame pv-mode-/, 'the frame does not carry its mode class');
});

test('Look says, on screen, what a board frame receives: the shot as words, with the location plate', () => {
    assert.match(PAGE, /look:\s*'SPLAT PREVIEW — THE SHOT REACHES THE FRAME AS WORDS, WITH THE LOCATION PLATE'/);
    assert.doesNotMatch(PAGE, /GENERATION (STILL )?RECEIVES THE GEOMETRIC PLATE/, 'a caption still says the geometric plate is sent');
});

test('with the console off, the page never reaches for the renderer', () => {
    // worldViewMode falls back to geometry — the handoff layout loads nothing new.
    assert.match(PAGE, /if \(!worldFlagOn\('previs_console'\)\) return 'geo';/);
    const off = renderConsole({ world_engine: true });
    assert.ok(!off.includes('id="pvModeNote"'));
});

test('every view mode has a rule, and the thumbnails and panel shots are styled', () => {
    for (const cls of ['pv-mode-look', 'pv-mode-pano', 'pv-mode-geo', 'pv-mode-depth', 'pv-mode-plan',
        'pv-gl', 'we-tile-img', 'fe-panel-shots']) {
        assert.ok(new RegExp(`\\.${cls}\\b[^{]*\\{`).test(PAGE), `.${cls} has no rule`);
    }
    assert.match(PAGE, /body\.pv-shots-in-panel/, 'no rule moves the shot rail out when the panel holds it');
});

test('the side panel refresh keeps the shot list in the app panel', () => {
    assert.match(PAGE, /window\.worldSyncPanelShots/, 'the shell cannot reach the panel shot list');
});

/* ── Production reads the decisions back ────────────────────────────────── */

test('each decision carries the scene card value Production shows', async () => {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Read back');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    const card = { shot_code: '1A', camera: { lens: '35mm', height_m: 1.4 }, direction: 'Hold on June',
        characters: ['JUNE', 'RAY'] };
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify(card));
    const r = await call(handlePrevis, 'GET', `/film/shots/${shotId}/previs`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const v = Object.fromEntries(r.body.decisions.map(d => [d.id, d.value]));
    assert.strictEqual(v.camera, '35mm · 1.40 m high');
    assert.strictEqual(v.direction, 'Hold on June');
    assert.strictEqual(v.characters, 'JUNE, RAY');
    assert.strictEqual(v.props, '', 'a decision the card does not hold reads empty, not invented');
});

test('the shot drawer has a From Previs section that only reads, and opens Previs', () => {
    const at = PAGE.indexOf('function pgDrawerShot(');
    const drawer = PAGE.slice(at, PAGE.indexOf('\nasync function pgLoadShotDetails', at));
    assert.ok(drawer.includes('<span>From Previs</span>'), 'no From Previs section in the shot drawer');
    assert.ok(drawer.indexOf('From Previs') < drawer.indexOf('Plates &amp; details'), 'From Previs sits after the plates');
    assert.match(drawer, /Open in Previs/);
    assert.match(drawer, /pgLoadPrevis\(n\)/);
    const loader = PAGE.slice(PAGE.indexOf('async function pgLoadPrevis('), PAGE.indexOf('function pgDrawerShot('));
    assert.ok(!/\/previs\/(lock|unlock|apply|approve)/.test(loader), 'Production must not change a Previs decision');
});

test('the graph shot node carries the lock count from Previs', () => {
    const { buildGraph } = require('../lib/production-graph');
    const projectId = generateId(), sceneId = generateId(), a = generateId(), b = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Graph');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    for (const [id, code] of [[a, '1A'], [b, '1B']]) {
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)').run(id, sceneId, code, '{}');
    }
    db.prepare(`INSERT INTO film_previs_blocking (shot_id, camera_json, locked_parts_json, approved_fingerprint)
                VALUES (?, '{}', ?, 'fp')`).run(a, JSON.stringify(['camera', 'direction']));
    const g = buildGraph(db, projectId);
    const node = id => g.nodes.find(n => n.key === 'shot:' + id);
    assert.deepStrictEqual(node(a).previs, { locked: 2, approved: true });
    assert.deepStrictEqual(node(b).previs, { locked: 0, approved: false }, 'an unblocked shot reads as nothing locked');
    assert.match(PAGE, /pgPrevisTag\(n\)/, 'the node never renders the tag');
});
