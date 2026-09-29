/**
 * PGN-018 — collapse a sequence or scene.
 *
 * A collapsed flag per group, stored per project beside the pinned layout
 * (production_group_layout). A collapsed group draws as one card: its length,
 * shots done / total, how many of its nodes are behind, and anything running.
 * Collapsing never moves a node, so expanding restores the layout exactly;
 * Tidy never forgets a position inside a collapsed group.
 *
 * Set-based over every group kind the graph builds (a sequence, a scene of
 * loose shots) and over every summary field.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-col-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const pg = require('../lib/production-graph');
const { handleProductionGraph } = require('../routes/production-graph');

const P = generateId(), S1 = generateId(), S2 = generateId();
const A = generateId(), B = generateId(), C = generateId(), SEQ = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Collapse')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'DINER')").run(S1, P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 2, 'STREET')").run(S2, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, sort_order) VALUES (?, ?, '1A', 3000, 0)").run(A, S1);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, sort_order) VALUES (?, ?, '1B', 4000, 1)").run(B, S1);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, sort_order) VALUES (?, ?, '2A', 5000, 0)").run(C, S2);
db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Walk', ?)").run(SEQ, P, JSON.stringify([A, B]));
// 1A has a clip of its own: one of the sequence's two shots is done.
db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
    VALUES (?, ?, ?, 'video_raw', '1A.mp4', '/tmp/none-1A.mp4', 1)`).run(generateId(), P, A);
// Something running on 2A.
db.prepare(`INSERT INTO film_generation_jobs (id, project_id, shot_id, provider, capability, request_id, status, meta, started_at, heartbeat_at, collectable)
    VALUES (?, ?, ?, 'runway', 'video', 'r-1', 'pending', ?, datetime('now'), datetime('now'), 1)`).run(generateId(), P, C, JSON.stringify({ shot_id: C }));

const graph = () => pg.buildGraph(db, P);
const group = (g, key) => g.groups.find(x => x.key === key);
async function call(method, parts, body) {
    let status = 0, out = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { out = b ? JSON.parse(b) : null; } };
    await handleProductionGraph({ method, body }, res, ['film', 'projects', P, 'production-graph', ...parts], {});
    return { status, out };
}
const KINDS = [`seq:${SEQ}`, `scene:${S2}`];

test('every group carries its members and a summary: length, shots done / total, behind, running', () => {
    const g = graph();
    for (const key of KINDS) {
        const gr = group(g, key);
        assert.ok(gr, `${key} is not a group`);
        assert.equal(gr.collapsed, false);
        assert.ok(Array.isArray(gr.members) && gr.members.length, `${key} has no members`);
        for (const f of ['length_ms', 'shots_done', 'shots_total', 'behind', 'running']) assert.ok(f in gr.summary, `${key}: no ${f}`);
    }
    const seq = group(g, `seq:${SEQ}`);
    assert.ok(seq.members.includes(`shot:${A}`) && seq.members.includes(`seq:${SEQ}`));
    assert.equal(seq.summary.length_ms, 7000);
    assert.equal(seq.summary.shots_total, 2);
    assert.equal(seq.summary.shots_done, 1);
    const sc = group(g, `scene:${S2}`);
    assert.equal(sc.summary.shots_total, 1);
    assert.equal(sc.summary.running, 1, 'the running job on 2A is not counted');
});

test('collapse is stored per project; strict value; an unknown group or project is refused', async () => {
    for (const key of KINDS) {
        let r = await call('PUT', ['groups', encodeURIComponent(key)], { collapsed: true });
        assert.equal(r.status, 200, JSON.stringify(r.out));
        assert.equal(group(graph(), key).collapsed, true, `${key} did not collapse`);
        r = await call('PUT', ['groups', encodeURIComponent(key)], { collapsed: false });
        assert.equal(group(graph(), key).collapsed, false, `${key} did not expand`);
    }
    assert.equal((await call('PUT', ['groups', encodeURIComponent(KINDS[0])], { collapsed: 'yes' })).status, 400);
    assert.equal((await call('PUT', ['groups', encodeURIComponent('seq:' + generateId())], { collapsed: true })).status, 404);
    let status = 0;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end() {} };
    await handleProductionGraph({ method: 'PUT', body: { collapsed: true } }, res, ['film', 'projects', generateId(), 'production-graph', 'groups', KINDS[0]], {});
    assert.equal(status, 404);
});

test('collapsing moves no node: expand restores every position exactly, pinned or not', async () => {
    // One member pinned by hand, the rest where auto layout put them.
    await call('PUT', ['layout'], { nodes: [{ key: `shot:${A}`, x: 999, y: 777 }] });
    const before = new Map(graph().nodes.map(n => [n.key, `${n.x},${n.y}`]));
    const rowsBefore = db.prepare('SELECT node_key, x, y, pinned FROM production_node_layout WHERE project_id = ? ORDER BY node_key').all(P);
    for (const key of KINDS) await call('PUT', ['groups', encodeURIComponent(key)], { collapsed: true });
    assert.deepEqual(db.prepare('SELECT node_key, x, y, pinned FROM production_node_layout WHERE project_id = ? ORDER BY node_key').all(P), rowsBefore,
        'collapsing wrote to the node layout');
    for (const key of KINDS) await call('PUT', ['groups', encodeURIComponent(key)], { collapsed: false });
    const after = new Map(graph().nodes.map(n => [n.key, `${n.x},${n.y}`]));
    assert.deepEqual([...after], [...before], 'expanding did not restore the layout exactly');
});

test('a collapsed group is drawn as a card, and the groups after it close up', async () => {
    const open = graph();
    const seqOpen = group(open, `seq:${SEQ}`), sceneOpen = group(open, `scene:${S2}`);
    await call('PUT', ['groups', encodeURIComponent(`seq:${SEQ}`)], { collapsed: true });
    const shut = graph();
    const seqShut = group(shut, `seq:${SEQ}`), sceneShut = group(shut, `scene:${S2}`);
    assert.ok(seqShut.w < seqOpen.w && seqShut.h <= seqOpen.h, 'a collapsed group is still full size');
    assert.ok(sceneShut.x < sceneOpen.x, 'the next group did not close up');
    await call('PUT', ['groups', encodeURIComponent(`seq:${SEQ}`)], { collapsed: false });
    assert.equal(group(graph(), `scene:${S2}`).x, sceneOpen.x, 'expanding did not put the next group back');
});

test('Tidy never forgets a position inside a collapsed group, and still tidies the rest', async () => {
    await call('PUT', ['layout'], { nodes: [{ key: `shot:${B}`, x: 111, y: 222, pinned: false }, { key: `shot:${C}`, x: 333, y: 444, pinned: false }] });
    await call('PUT', ['groups', encodeURIComponent(`seq:${SEQ}`)], { collapsed: true });
    const r = await call('POST', ['tidy'], {});
    assert.equal(r.status, 200);
    const rows = new Set(db.prepare('SELECT node_key FROM production_node_layout WHERE project_id = ?').all(P).map(x => x.node_key));
    assert.ok(rows.has(`shot:${B}`), 'Tidy forgot a position inside a collapsed group');
    assert.ok(!rows.has(`shot:${C}`), 'Tidy left an unpinned node outside any collapsed group');
    // "all" also respects the collapsed group.
    await call('POST', ['tidy'], { all: true });
    const rows2 = new Set(db.prepare('SELECT node_key FROM production_node_layout WHERE project_id = ?').all(P).map(x => x.node_key));
    assert.ok(rows2.has(`shot:${B}`) && rows2.has(`shot:${A}`));
    await call('PUT', ['groups', encodeURIComponent(`seq:${SEQ}`)], { collapsed: false });
});

// ---- the page ----------------------------------------------------------------------
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), parens = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') parens++; else if (SPA[i] === ')' && --parens === 0) { i++; break; } }
    let depth = 0;
    for (let j = SPA.indexOf('{', i); j < SPA.length; j++) { if (SPA[j] === '{') depth++; else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1); }
    return null;
}

test('the page draws a collapsed group as a card with every summary field, hides its members, and toggles through the route', async () => {
    const esc = 'const esc = s => String(s == null ? "" : s);';
    const html = new Function(`${esc} const pgSecs = ms => ms ? (Math.round(ms / 100) / 10) + 's' : '—'; ${fnSource('pgGroupHtml')}; return pgGroupHtml;`)();
    const shut = html({ key: 'seq:q', label: 'SC 1 · WALK', x: 0, y: 0, w: 220, h: 120, collapsed: true,
        summary: { length_ms: 7000, shots_done: 1, shots_total: 2, behind: 3, running: 1 } });
    for (const needle of ['7s', '1 / 2', '3 behind', '1 running']) assert.ok(shut.includes(needle), `the card does not show ${needle}`);
    assert.match(shut, /pgToggleCollapse\('seq:q'\)/);
    const open = html({ key: 'seq:q', label: 'SC 1', x: 0, y: 0, w: 900, h: 400, collapsed: false, summary: {} });
    assert.match(open, /pgToggleCollapse\('seq:q'\)/, 'an open group cannot be collapsed');
    assert.doesNotMatch(open, /1 \/ 2/);
    assert.match(fnSource('pgRender'), /pgGroupHtml\(/);
    assert.match(fnSource('pgVisible'), /pgInCollapsed\(/, 'members of a collapsed group are still drawn');
    const calls = [];
    const toggle = new Function('api', 'PG', 'loadProductionGraph', 'setStatus',
        `${fnSource('pgToggleCollapse')}; return pgToggleCollapse;`)(
        async (url, o) => { calls.push({ url, body: JSON.parse(o.body), method: o.method }); return {}; },
        { graph: { project_id: 'p', groups: [{ key: 'seq:q', collapsed: false }] } }, async () => {}, () => {});
    await toggle('seq:q');
    assert.deepEqual(calls[0], { url: '/projects/p/production-graph/groups/' + encodeURIComponent('seq:q'), body: { collapsed: true }, method: 'PUT' });
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
