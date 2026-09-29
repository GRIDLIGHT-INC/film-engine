/**
 * PGN-022 — the production graph's eight features, together, through a
 * SPAWNED server, on one project that has everything at once: a running job,
 * a stale frame, a held shot and a collapsed sequence.
 *
 * Each feature has its own test file; this one exists because each was built
 * and proven alone, and the page meets them together. Set-based three ways:
 *
 *   - over the NODE TYPES the graph draws (read from lib/production-graph.js):
 *     every one is on this project's graph, over HTTP, carrying a state from
 *     the impact set;
 *   - over the IMPACT STAGES (lib/impact.js chain): every stage is placed by
 *     the epic's Stage-to-node table, and every node-placed stage that goes
 *     behind moves the node the table names;
 *   - over the BATCH ENTRY POINTS (lib/graph-hold.js): every one exists where
 *     the registry says, and every plan reachable over HTTP leaves the held
 *     shot out while the film keeps it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-pgn-' + crypto.randomUUID().slice(0, 8));
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.FILM_DATA_DIR = TEST_DIR;
const { testApi } = require('./helpers');
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const pg = require('../lib/production-graph');
const hold = require('../lib/graph-hold');
const impact = require('../lib/impact');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 24600 + Math.floor(Math.random() * 400);
const api = testApi(`http://localhost:${PORT}`);
let server;

test.before(async () => {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), FILM_DATA_DIR: TEST_DIR }, stdio: 'pipe',
    });
    server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
    for (let i = 0; i < 100; i++) {
        try { const r = await api('/api/health'); if (r.status === 200) return; } catch (_) { /* booting */ }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start');
});
test.after(() => { if (server) server.kill('SIGTERM'); try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {} });

// ── One project with every state at once ──────────────────────────────────

const P = generateId(), SC = generateId(), SC2 = generateId();
const S = { A: generateId(), B: generateId(), C: generateId(), D: generateId() };
const SEQ = generateId(), SEQ2 = generateId(), CUE = generateId();
db.prepare("INSERT INTO film_projects (id, title, target_fps) VALUES (?, 'Every state', 24)").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location, description) VALUES (?, ?, 1, 'DINER', 'A diner at night.')").run(SC, P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location, description) VALUES (?, ?, 2, 'STREET', 'The street outside.')").run(SC2, P);
const card = code => JSON.stringify({ shot_code: code, description: `${code}: she waits by the window.`, camera: { shot_type: 'wide' } });
[['A', SC, '1A', 0], ['B', SC, '1B', 1], ['C', SC, '1C', 2], ['D', SC2, '2A', 0]].forEach(([k, sc, code, i]) =>
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, sort_order, duration_ms, scene_card_yaml)
                VALUES (?, ?, ?, ?, 3000, ?)`).run(S[k], sc, code, i, card(code)));
const sdir = path.join(TEST_DIR, 'storyboards', P), vdir = path.join(TEST_DIR, 'video', P), mdir = path.join(TEST_DIR, 'music', P);
[sdir, vdir, mdir].forEach(d => fs.mkdirSync(d, { recursive: true }));
function asset(type, { shot = null, scene = null, file, fp = null, kind = null, meta = null }) {
    const id = generateId();
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_path, file_name, version, duration_ms,
        input_fingerprint, artefact_kind, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 3000, ?, ?, ?)`)
        .run(id, P, shot, scene, type, file, path.basename(file), fp, kind, meta ? JSON.stringify(meta) : null);
    return id;
}
// 1A: a frame stamped from other inputs — the STALE frame. 1B, 1C, 2A: frames outside the workflow.
asset('storyboard', { shot: S.A, file: path.join(sdir, '1A.png'), fp: 'an-old-fingerprint', kind: 'keyframe' });
asset('storyboard', { shot: S.B, file: path.join(sdir, '1B.png') });
asset('storyboard', { shot: S.C, file: path.join(sdir, '1C.png') });
asset('storyboard', { shot: S.D, file: path.join(sdir, '2A.png') });
// A clip on 1A: a video version.
asset('video_raw', { shot: S.A, file: path.join(vdir, '1A.mp4') });
// A sequence over 1A and 1B (to be collapsed), and a second one borrowing its last frame (a link).
db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Walk', ?)").run(SEQ, P, JSON.stringify([S.A, S.B]));
db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids, start_frame_ref) VALUES (?, ?, 'Out', ?, ?)")
    .run(SEQ2, P, JSON.stringify([S.D]), JSON.stringify({ sequence_id: SEQ, mode: 'shot_image' }));
// A score cue with one generated version: a sound node and an audio version.
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, title) VALUES (?, ?, ?, 'score', 'Diner theme')").run(CUE, P, SC);
const MUSIC = asset('audio_music', { scene: SC, file: path.join(mdir, 'theme.mp3'), meta: { cue_id: CUE } });
db.prepare('UPDATE film_music_cues SET generated_asset_id = ? WHERE id = ?').run(MUSIC, CUE);
// A job running on 1C, heard from just now.
db.prepare(`INSERT INTO film_generation_jobs (id, project_id, shot_id, provider, capability, request_id, status, meta,
    percent, phase, started_at, heartbeat_at, collectable) VALUES (?, ?, ?, 'meshy', 'image', 'req-1', 'pending', ?, 40, 'rendering',
    datetime('now'), datetime('now'), 1)`).run(generateId(), P, S.C, JSON.stringify({ shot_id: S.C }));

const graph = async () => { const r = await api(`/film/projects/${P}/production-graph`); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const node = (g, key) => g.nodes.find(n => n.key === key);

// Hold 1B and collapse the Walk sequence through the real routes, once.
let held = false, collapsed = false;
async function setUp() {
    if (!held) {
        const r = await api(`/film/shots/${S.B}`, { method: 'PUT', body: { held: true } });
        assert.equal(r.status, 200, JSON.stringify(r.data)); held = true;
    }
    if (!collapsed) {
        const r = await api(`/film/projects/${P}/production-graph/groups/${encodeURIComponent('seq:' + SEQ)}`, { method: 'PUT', body: { collapsed: true } });
        assert.equal(r.status, 200, JSON.stringify(r.data)); collapsed = true;
    }
}

// ── Node types ────────────────────────────────────────────────────────────

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'production-graph.js'), 'utf8');
const NODE_TYPES = [...new Set([...SRC.matchAll(/type: '([a-z]+)'/g)].map(m => m[1]))].filter(t => pg.NODE_IMPACT[t]);

test('every node type the graph draws is on this project, over HTTP, with a state from the impact set', async () => {
    await setUp();
    assert.ok(NODE_TYPES.length >= 6, `found only ${NODE_TYPES.length} node types`);
    const g = await graph();
    const drawn = new Set(g.nodes.map(n => n.type));
    assert.deepEqual(NODE_TYPES.filter(t => !drawn.has(t)), [], 'a node type is missing from the fixture graph');
    const bad = g.nodes.filter(n => !n.impact || !pg.IMPACT_STATES.includes(n.impact.state)).map(n => `${n.key}:${n.impact && n.impact.state}`);
    assert.deepEqual(bad, [], 'a node carries no state, or one outside the set');
});

// ── The four states at once ───────────────────────────────────────────────

test('the stale frame reads redo, on its node and in the free Run-what-changed plan', async () => {
    await setUp();
    const g = await graph();
    assert.equal(node(g, 'shot:' + S.A).impact.state, 'redo');
    assert.equal(node(g, 'shot:' + S.B).impact.state, 'untracked', 'a frame made outside the workflow was passed off as current');
    const plan = await api(`/film/projects/${P}/production-graph/run-changed/plan`);
    assert.equal(plan.status, 200, JSON.stringify(plan.data));
    assert.ok(JSON.stringify(plan.data.items || []).includes(S.A), 'the stale frame is not in the redo-now plan');
});

test('the running job is on its node, in its group\'s summary, and in the queue', async () => {
    await setUp();
    const g = await graph();
    assert.ok((g.running || []).some(r => r.key === 'shot:' + S.C), 'the running job is not placed on 1C');
    const run = g.running.find(r => r.key === 'shot:' + S.C);
    assert.equal(run.percent, 40, 'the provider\'s percentage did not reach the node');
    const scene = g.groups.find(x => x.members && x.members.includes('shot:' + S.C));
    assert.ok(scene && scene.summary.running >= 1, 'the group holding the running shot does not count it');
    const q = await api(`/film/projects/${P}/production-graph/queue`);
    assert.equal(q.status, 200);
    assert.ok(JSON.stringify(q.data).includes(S.C), 'the queue does not list the running job');
});

test('the collapsed sequence is one card with its summary, and collapsing moved no node', async () => {
    const before = db.prepare('SELECT node_key, x, y FROM production_node_layout WHERE project_id = ? ORDER BY node_key').all(P);
    await setUp();
    const g = await graph();
    const gr = g.groups.find(x => x.key === 'seq:' + SEQ);
    assert.ok(gr && gr.collapsed, 'the sequence is not collapsed');
    for (const k of [`seq:${SEQ}`, `shot:${S.A}`, `shot:${S.B}`]) assert.ok(gr.members.includes(k), `${k} is not inside the collapsed card`);
    assert.ok(!gr.members.includes(`shot:${S.D}`), 'a shot of another group is inside the card');
    for (const f of ['length_ms', 'shots_done', 'shots_total', 'behind', 'running']) assert.ok(f in gr.summary, `no ${f} on the card`);
    assert.equal(gr.summary.shots_total, 2);
    assert.ok(gr.summary.behind >= 1, 'the stale 1A inside the collapsed group is not counted as behind');
    assert.deepEqual(db.prepare('SELECT node_key, x, y FROM production_node_layout WHERE project_id = ? ORDER BY node_key').all(P), before,
        'collapsing wrote to the node layout');
});

test('the held shot is badged, left out of every plan reachable over HTTP, and kept in the film', async () => {
    await setUp();
    const g = await graph();
    assert.equal(node(g, 'shot:' + S.B).held, true);
    const plan = (await api(`/film/projects/${P}/run-plan`)).data;
    assert.ok(!(plan.strips || []).some(s => (s.items || []).some(i => i.shot_id === S.B)), 'the run plan still plans the held shot');
    assert.ok((plan.held || []).some(h => h.id === S.B), 'the run plan does not name the held shot');
    const rc = (await api(`/film/projects/${P}/production-graph/run-changed/plan`)).data;
    assert.ok(!JSON.stringify(rc.items || []).includes(S.B), 'Run what changed planned the held shot');
    const t = (await api(`/film/projects/${P}/timeline`)).data;
    assert.ok(t.entries.some(e => e.shot_id === S.B), 'a held shot left the film');
});

// ── Impact stages ─────────────────────────────────────────────────────────

const EPIC = fs.readFileSync(path.join(ROOT, 'docs', 'plans', 'production-graph-nodes-epic.md'), 'utf8');
const STAGE_TABLE = (() => {
    const m = EPIC.match(/^### Stage to node\s*$([\s\S]*?)(?=^#{2,3} )/m);
    const rows = {};
    for (const line of (m ? m[1] : '').split('\n')) {
        const c = line.split('|').map(s => s.trim());
        const st = (c[1] || '').match(/^`([a-z_]+)`$/);
        if (st) rows[st[1]] = c[2];
    }
    return rows;
})();

test('every impact stage is placed by the Stage-to-node table, on a node type that exists', () => {
    const stages = impact.chain().map(s => s.id).filter(s => s !== 'scene_card');
    assert.ok(stages.length >= 8, `only ${stages.length} stages`);
    assert.deepEqual(stages.filter(s => !STAGE_TABLE[s]), [], 'a stage the impact report walks has no place on the graph');
    for (const s of stages) {
        const text = STAGE_TABLE[s];
        const types = [...text.matchAll(/`([a-z]+)`/g)].map(m => m[1]);
        assert.ok(/^Not a node/.test(text) || types.some(t => NODE_TYPES.includes(t)), `${s}: placed on no node type the graph draws`);
    }
});

test('every node-placed stage that goes behind moves the node the table names', () => {
    const f = pg.NODE_IMPACT;
    const base = () => ({ shots: { X: { scene_card: 'current', keyframe: 'current', video: 'current', voice: 'current', lipsync: 'current', sfx: 'current', post: 'current' } },
        scenes: { Y: { music: 'current', ambient: 'current' } }, assets: {}, why: {} });
    const shotN = { type: 'shot', id: 'X', scene_id: 'Y', frames: [{ asset_id: 'F', selected: true }] };
    const CUE_FOR = { music: 'score', ambient: 'ambient', sfx: 'sfx' };
    const stuck = [];
    let checked = 0;
    for (const stage of impact.chain().map(s => s.id)) {
        const text = STAGE_TABLE[stage] || '';
        if (stage === 'scene_card' || /^Not a node/.test(text)) continue;
        checked++;
        const c = base();
        const sceneScoped = c.scenes.Y[stage] !== undefined;
        if (sceneScoped) c.scenes.Y[stage] = 'redo'; else c.shots.X[stage] = 'redo';
        let moved;
        if (/badge/.test(text)) moved = (f.shot(shotN, c).badges || []).some(b => b.stage === stage && b.state === 'redo');
        else if (/`shot` node/.test(text)) moved = f.shot(shotN, c).state === 'redo';
        else if (/`sound` node/.test(text)) {
            // A scene stage moves an untracked cue through the scene's state; any
            // stage moves a cue whose own version the walk marked behind.
            const n = { type: 'sound', cue_type: CUE_FOR[stage], scene_id: 'Y', selected_asset_id: 'M' };
            moved = f.sound(n, { ...c, assets: { M: 'redo' } }).state === 'redo'
                && (!sceneScoped || f.sound(n, c).state === 'redo');
        } else if (/`video`/.test(text)) moved = f.video({ type: 'video', asset_id: 'V' }, { ...c, assets: { V: 'redo' } }).state === 'redo';
        else moved = false;
        if (!moved) stuck.push(stage);
    }
    assert.ok(checked >= 7, `only ${checked} node-placed stages checked`);
    assert.deepEqual(stuck, [], 'these stages go behind and the node the table names does not move');
});

// ── Batch entry points ────────────────────────────────────────────────────

test('every batch entry point exists where the hold registry says it does', () => {
    assert.ok(hold.BATCH_ENTRY_POINTS.length >= 10);
    const missing = hold.BATCH_ENTRY_POINTS.filter(e => {
        const src = fs.readFileSync(path.join(ROOT, e.file), 'utf8');
        return !new RegExp(`(?:async\\s+)?function\\s+${e.fn}\\s*\\(`).test(src);
    }).map(e => `${e.file}:${e.fn}`);
    assert.deepEqual(missing, [], 'the registry names a batch function that is not there');
});

test('Run pending names the held shot apart from the work', async () => {
    await setUp();
    db.prepare('DELETE FROM film_assets WHERE shot_id = ? AND asset_type = ?').run(S.B, 'storyboard');
    const g = await graph();
    assert.ok(!(g.pending || []).some(p => p.key === 'shot:' + S.B || p.shot_id === S.B), 'Run pending would make the held shot');
    assert.ok((g.pending_held || []).some(p => JSON.stringify(p).includes(S.B)), 'the held shot is not named beside Run pending');
});

// ── The page, with a collapsed group on it (found in the browser pass) ─────

const SPA = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), parens = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') parens++; else if (SPA[i] === ')' && --parens === 0) { i++; break; } }
    let depth = 0;
    for (let j = SPA.indexOf('{', i); j < SPA.length; j++) { if (SPA[j] === '{') depth++; else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1); }
    return null;
}
// A collapsed sequence at the far left, its members hidden, one scene group to its right.
const PAGE_GRAPH = {
    nodes: [
        { key: 'shot:a', type: 'shot', shot_code: '1A', x: 40, y: 40, w: 200, h: 180, frames: [] },
        { key: 'shot:c', type: 'shot', shot_code: '1C', x: 600, y: 40, w: 200, h: 180, frames: [] },
    ],
    groups: [
        { key: 'seq:q', label: 'SC 1 · WALK', collapsed: true, x: 20, y: 8, w: 240, h: 132, members: ['shot:a', 'seq:q'] },
        { key: 'scene:s', label: 'SC 1', collapsed: false, x: 580, y: 8, w: 300, h: 252, members: ['shot:c'] },
    ],
};
const pageFns = (extra = '') => new Function('PG', `
    function pgVisible(n) { return !pgInCollapsed(n); }
    ${fnSource('pgInCollapsed')} ${fnSource('pgCollapsedOf') || ''} ${fnSource('pgBounds')} ${extra}
    return { pgBounds, pgCollapsedOf: typeof pgCollapsedOf === 'function' ? pgCollapsedOf : null };`);

test('Fit frames a collapsed card: the bounds include it, not only the nodes still drawn', () => {
    const { pgBounds } = pageFns()({ graph: PAGE_GRAPH });
    const b = pgBounds();
    assert.ok(b.x <= 20, `Fit starts at ${b.x}, to the right of the collapsed card at 20 — it is left off-screen`);
    assert.ok(b.x + b.w >= 800, 'Fit no longer reaches the drawn node');
});

test('the minimap draws a collapsed card', () => {
    const src = fnSource('pgMinimap');
    assert.match(src, /pgBoxes\(|\.collapsed/, 'the minimap draws only nodes, so a collapsed card is missing from it');
});

test('the side panel says a shot is inside a collapsed card, and clicking it pans to the card', () => {
    const { pgCollapsedOf } = pageFns()({ graph: PAGE_GRAPH });
    assert.ok(pgCollapsedOf, 'no pgCollapsedOf: nothing can say which card a hidden shot is in');
    assert.equal(pgCollapsedOf('shot:a').key, 'seq:q');
    assert.equal(pgCollapsedOf('shot:c'), null);
    const side = fnSource('pgRenderSide');
    assert.ok(side, 'no pgRenderSide: the outline moved');
    assert.match(side, /pgCollapsedOf\(/, 'the outline still calls a collapsed shot "off graph"');
    assert.match(fnSource('pgSideClick'), /pgCollapsedOf\(/, 'clicking a collapsed shot pans to its hidden position, not to its card');
});

test('pgRender decorates EVERY node, not only the first (map passes the index as `raw`)', () => {
    // Found in the browser pass: `.map(pgNodeHtml)` hands Array.map's index to
    // pgNodeHtml's `raw` flag, so node 0 was drawn with its state and hold and
    // every other node without. A test that calls pgNodeHtml(n) directly cannot
    // see it — this one runs the renderer itself.
    const calls = [];
    const world = { innerHTML: '', querySelector: () => null };
    const canvas = { querySelector: () => ({ textContent: '' }) };
    const render = new Function('PG', 'document', 'pgNodeHtml', 'pgGroupHtml', 'pgVisible', 'pgDrawEdges', 'pgApplyView', 'pgRenderSide', 'requestAnimationFrame',
        `${fnSource('pgRender')}; return pgRender;`)(
        { graph: { nodes: [{ key: 'a' }, { key: 'b' }, { key: 'c' }], groups: [] }, picked: new Set() },
        { getElementById: id => id === 'pgWorld' ? world : id === 'pgCanvas' ? canvas : null, querySelector: () => null, querySelectorAll: () => [] },
        (n, raw) => { calls.push([n.key, raw]); return `<i>${raw ? 'raw' : 'decorated'}</i>`; },
        () => '', () => true, () => {}, () => {}, () => {}, f => f && 0);
    try { render(); } catch (_) { /* later chrome the stub does not model; the node HTML is built first */ }
    assert.ok(calls.length >= 3, `pgRender drew ${calls.length} nodes`);
    const raw = calls.filter(([, r]) => r).map(([k]) => k);
    assert.deepEqual(raw, [], `these nodes were drawn raw, without their state and hold: ${raw.join(', ')}`);
});
