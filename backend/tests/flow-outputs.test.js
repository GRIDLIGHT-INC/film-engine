/**
 * FOG-004 (GRD-4585) — flow outputs are versions.
 *
 * What a flow makes lands on the shot it ran for, as a version of the right
 * kind: an image as a frame version, a video as a clip version, a sound as a
 * sound version. And it is a CANDIDATE: nothing a flow makes becomes the
 * selected version by itself — not on the graph, not on the board, not in
 * playback. Picking one is FOG-005's explicit act.
 *
 * Set-based over out.asset's own media input ports (read from NODE_TYPES,
 * never typed here): each is saved to disk and drawn as its kind, or named as
 * not drawn with the reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog004-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { NODE_TYPES } = require('../lib/flow-node-types');
const { handlerFor } = require('../lib/node-handlers');
const { PORT } = require('../lib/node-handlers/port');
const { buildGraph } = require('../lib/production-graph');
const outputs = require('../lib/flow-outputs');

const MEDIA_PORTS = NODE_TYPES['out.asset'].inputs;

// ── fixture: a shot with a frame and a chosen clip, and a flow run on it ──
const P = generateId(), SC = generateId(), SH = generateId(), BARE = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Flow outputs')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'SQUARE')").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', '{}')").run(SH, SC);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1B', '{}')").run(BARE, SC);
const FRAME = generateId(), CLIP = generateId();
db.prepare("INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_path, file_name, version) VALUES (?, ?, ?, ?, 'keyframe', '/nowhere/1A.png', '1A.png', 1)").run(FRAME, P, SH, SC);
db.prepare("INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_path, file_name, version) VALUES (?, ?, ?, ?, 'video_raw', '/nowhere/1A.mp4', '1A.mp4', 1)").run(CLIP, P, SH, SC);
db.prepare('UPDATE film_shots SET selected_video_asset_id = ? WHERE id = ?').run(CLIP, SH);
const FLOW = generateId(), APPLY = generateId(), RUN = generateId(), RUN_BARE = generateId();
db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'Looks', 0, 1)").run(FLOW, P);
db.prepare("INSERT INTO film_flow_applies (id, flow_id, project_id, fingerprint, targets_json, status) VALUES (?, ?, ?, 'fp', '[]', 'running')").run(APPLY, FLOW, P);
for (const [r, s] of [[RUN, SH], [RUN_BARE, BARE]]) {
    db.prepare("INSERT INTO film_flow_runs (id, flow_id, project_id, shot_id, status, apply_id) VALUES (?, ?, ?, ?, 'running', ?)").run(r, FLOW, P, s, APPLY);
}

const BYTES = {
    image: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    video: Buffer.from('000000186674797069736f6d', 'hex'),
    audio: Buffer.from('494433040000', 'hex'),
    model3d: Buffer.from('676c544602000000', 'hex'),
};
const ctxFor = (shotId, runId, branch) => ({
    shot: { id: shotId, shot_code: shotId === SH ? '1A' : '1B' }, scene: { id: SC, project_id: P },
    project: { id: P }, runId, branch: branch || 'root',
});
async function save(port, shotId, runId, config, branch) {
    const node = { id: `save_${port}`, type: 'out.asset', config: config || {} };
    const r = await handlerFor('out.asset').execute(node, { [port]: PORT(port, BYTES[port]) }, ctxFor(shotId, runId, branch));
    assert.equal(r.ok, true, `${port}: ${r.error}`);
    return db.prepare('SELECT * FROM film_assets WHERE id = ?').get(r.assetId);
}

test('every media port out.asset takes has a decision: drawn as a version kind, or named as not drawn with why', () => {
    assert.ok(MEDIA_PORTS.length >= 4, `read only ${MEDIA_PORTS.length} ports`);
    for (const port of MEDIA_PORTS) {
        const k = outputs.FLOW_OUTPUT_KINDS[port];
        assert.ok(k, `no decision for out.asset port ${port}`);
        if (!k.version) assert.ok(k.why && k.why.length > 20, `${port} is not drawn and does not say why`);
    }
    assert.deepEqual(Object.keys(outputs.FLOW_OUTPUT_KINDS).sort(), [...MEDIA_PORTS].sort(), 'a decision for a port out.asset does not take');
});

const saved = {};
test('each output is written to disk with its bytes and registered as a flow candidate carrying where it came from', async () => {
    for (const port of MEDIA_PORTS) {
        const row = await save(port, SH, RUN, port === 'video' ? { asset_type: 'video_raw' } : {}, 'variant_2');
        saved[port] = row;
        assert.ok(row.file_path && fs.existsSync(row.file_path), `${port}: nothing on disk (${row.file_path})`);
        assert.deepEqual(fs.readFileSync(row.file_path), BYTES[port], `${port}: the bytes on disk are not the output`);
        assert.equal(row.asset_type, 'other', `${port}: registered as ${row.asset_type}, where a reader ranking by type would pick it`);
        assert.equal(row.shot_id, SH);
        const m = JSON.parse(row.metadata);
        assert.equal(m.source, 'flow');
        assert.equal(m.kind, 'flow_output');
        assert.equal(m.output_kind, port);
        assert.equal(m.run_id, RUN);
        assert.equal(m.flow_id, FLOW);
        assert.equal(m.apply_id, APPLY);
        assert.equal(m.branch, 'variant_2');
        assert.ok(m.as_type, `${port}: the type it would be once picked is not recorded`);
    }
    assert.equal(JSON.parse(saved.video.metadata).as_type, 'video_raw', 'the node\'s own asset_type was not kept');
    // Two outputs of one run never overwrite each other.
    const again = await save('image', SH, RUN, {}, 'variant_3');
    assert.notEqual(again.file_path, saved.image.file_path);
    assert.ok(fs.existsSync(saved.image.file_path), 'a second output overwrote the first');
});

test('the graph draws each output on its shot by kind, and none is selected', () => {
    const g = buildGraph(db, P);
    const shot = g.nodes.find(n => n.key === `shot:${SH}`);
    for (const port of MEDIA_PORTS) {
        const k = outputs.FLOW_OUTPUT_KINDS[port];
        const id = saved[port].id;
        if (k.version === 'frame') {
            const f = (shot.flow_frames || []).find(x => x.asset_id === id);
            assert.ok(f, `${port}: not among the shot's flow frames`);
            assert.equal(f.selected, false);
            assert.ok(f.url, `${port}: a frame version nobody can see`);
            assert.equal(f.run_id, RUN);
            assert.ok(!shot.frames.some(x => x.asset_id === id), `${port}: counted as one of the shot's own frames`);
        } else if (k.version) {
            const v = g.nodes.find(n => n.key === `ver:${id}`);
            assert.ok(v, `${port}: no version node`);
            assert.equal(v.type, k.version === 'clip' ? 'video' : 'audio', `${port}: drawn as ${v.type}`);
            assert.equal(v.parent, shot.key, `${port}: not on its shot`);
            assert.equal(v.source, 'flow');
            assert.equal(v.selected, false, `${port}: became the selected version by itself`);
            assert.ok(g.edges.some(e => e.from === shot.key && e.to === v.key), `${port}: no edge from its shot`);
            const grp = g.groups.find(x => (x.members || []).includes(shot.key));
            assert.ok(grp && grp.members.includes(v.key), `${port}: its group does not place it`);
            assert.ok(!(shot.videos || []).some(x => x.asset_id === id), `${port}: counted as the shot's own clip`);
        } else {
            assert.ok(!g.nodes.some(n => n.key === `ver:${id}`), `${port}: drawn although its decision says it is not`);
        }
    }
    // What was selected before is still what is selected.
    assert.equal(shot.selected_video_asset_id, CLIP);
    assert.equal(shot.selected_frame && shot.selected_frame.asset_id, FRAME);
});

test('a shot with nothing but flow outputs still has no frame and plays no flow clip', async () => {
    for (const port of MEDIA_PORTS) await save(port, BARE, RUN_BARE);
    const g = buildGraph(db, P);
    const bare = g.nodes.find(n => n.key === `shot:${BARE}`);
    assert.equal(bare.frames.length, 0, 'a flow image became the shot\'s frame');
    assert.equal(bare.state, 'no_frame');
    assert.equal(bare.selected_video_asset_id, null);
    assert.ok((bare.flow_frames || []).length >= 1);
    const { loadTimeline } = require('../routes/timeline');
    const tl = loadTimeline(P);
    const entry = (tl.entries || []).find(e => e.shot_id === BARE);
    const flowIds = new Set(db.prepare("SELECT id FROM film_assets WHERE shot_id = ? AND json_extract(metadata, '$.source') = 'flow'").all(BARE).map(r => r.id));
    const played = JSON.stringify(entry || {});
    for (const id of flowIds) assert.ok(!played.includes(id), `playback picked up flow output ${id} by itself`);
});

test('a node run alone, with no run id, still saves its output and says it came from a flow node', async () => {
    const row = await save('image', SH, null);
    const m = JSON.parse(row.metadata);
    assert.equal(m.source, 'flow');
    assert.equal(m.run_id, null);
    assert.ok(fs.existsSync(row.file_path));
});

test('an output with no bytes and no URL is refused, not registered as a row pointing at nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM film_assets').get().n;
    const r = await handlerFor('out.asset').execute({ id: 'x', type: 'out.asset', config: {} },
        { image: PORT('image', { nothing: true }) }, ctxFor(SH, RUN));
    assert.equal(r.ok, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM film_assets').get().n, before);
});

// ── The page draws them ─────────────────────────────────────────────────────
const vm = require('vm');
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), depth = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') depth++; else if (SPA[i] === ')' && --depth === 0) break; }
    i = SPA.indexOf('{', i); depth = 0;
    for (let j = i; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}

test('the page draws every drawn kind off its shot: the real node renderer, the badge and the drawer strip', () => {
    const g = buildGraph(db, P);
    const byKey = new Map(g.nodes.map(n => [n.key, n]));
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const ctx = vm.createContext({
        esc, PG: { sel: null, busy: new Map(), running: new Map() }, PG_KIND: { music: { label: 'Music' } }, PG_JOINS: [],
        pgNode: k => byKey.get(k), pgSrc: u => u, pgPort: () => '', pgSecs: () => '0s', pgPrevisTag: () => '',
        pgBorrowedBy: () => '', pgProgressHtml: () => '', pgHoldDecorate: h => h, pgImpactDecorate: h => h, String, Number, Math,
    });
    const names = ['pgNodeHtml', 'pgVersionTitle', 'pgFlowBadge', 'pgFlowFramesHtml'];
    vm.runInContext(names.map(n => { const s = fnSource(n); assert.ok(s, `no ${n} on the page`); return s; }).join('\n')
        + names.map(n => `;this.${n} = ${n};`).join(''), ctx);
    const kinds = Object.entries(outputs.FLOW_OUTPUT_KINDS).filter(([, k]) => k.version && k.version !== 'frame');
    assert.ok(kinds.length >= 2);
    for (const [port] of kinds) {
        const v = byKey.get(`ver:${saved[port].id}`);
        let html;
        assert.doesNotThrow(() => { html = ctx.pgNodeHtml(v, true); }, `${port}: the renderer throws on a flow version hung off a shot`);
        assert.match(html, /from a flow/, `${port}: not labelled as a flow output`);
        assert.doesNotMatch(html, /vnull|playing/, `${port}: drawn as a numbered or playing version`);
    }
    const shot = byKey.get(`shot:${SH}`);
    assert.match(ctx.pgNodeHtml(shot, true), /from flows/, 'the shot does not say flows made frames for it');
    const strip = ctx.pgFlowFramesHtml(shot);
    for (const f of shot.flow_frames) assert.ok(strip.includes(esc(f.url)), `flow frame ${f.asset_id} not in the drawer`);
    assert.match(strip, /not on the board/);
    assert.equal(ctx.pgFlowFramesHtml({ flow_frames: [] }), '');
    assert.match(fnSource('pgDrawerShot'), /pgFlowFramesHtml\(n\)/, 'the shot drawer never shows them');
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA, 'the iOS bundle was not re-synced');
});
