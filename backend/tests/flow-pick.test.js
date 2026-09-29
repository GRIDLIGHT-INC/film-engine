/**
 * FOG-005 (GRD-4586) — a paused pick becomes pick-a-version.
 *
 * A flow that fans out and meets a `tf.select` gate PAUSES: a person chooses.
 * The variations it paused on are candidate versions on the shot (FOG-004's
 * candidates), shown in the drawer. Picking one goes through the existing
 * select route, RESUMES the run from the gate — nothing upstream is generated
 * again — and makes the chosen variation the shot's selected version. A run
 * that is no longer paused (finished, cancelled) cannot be picked.
 *
 * Set-based twice: over every variation of a real paused run, and over every
 * kind a candidate is drawn as (FLOW_OUTPUT_KINDS) for what picking does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog005-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { runFlow } = require('../lib/flow-executor');
const { handleFlows, writeGraph } = require('../routes/flows');
const outputs = require('../lib/flow-outputs');
const { buildGraph } = require('../lib/production-graph');

// ── http shim through the real router ──────────────────────────────────
async function call(method, urlPath, body) {
    const parts = urlPath.split('/').filter(Boolean);
    let done;
    const finished = new Promise(r => { done = r; });
    const res = {
        statusCode: null, body: null,
        writeHead(code) { this.statusCode = code; },
        end(p) { try { this.body = JSON.parse(p); } catch (_) { this.body = p; } done(); },
    };
    await handleFlows({ method, body: body || {} }, res, parts, {});
    await finished;
    return res;
}

// ── fixture ────────────────────────────────────────────────────────────
const P = generateId(), SC = generateId(), SH = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Pick a version')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'SQUARE')").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', '{}')").run(SH, SC);

const GRAPH = {
    nodes: [
        { id: 'p', type: 'in.prompt', config: { text: 'a square at dusk' } },
        { id: 'fan', type: 'tf.fanout', config: { count: 3 } },
        { id: 'img', type: 'gen.image' },
        { id: 'pick', type: 'tf.select' },
        { id: 'save', type: 'out.asset' },
    ],
    edges: [
        { from: 'p', fromPort: 'text', to: 'fan', toPort: 'any' },
        { from: 'fan', fromPort: 'any', to: 'img', toPort: 'text' },
        { from: 'img', fromPort: 'image', to: 'pick', toPort: 'any' },
        { from: 'pick', fromPort: 'any', to: 'save', toPort: 'image' },
    ],
};
const FLOW = generateId();
db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'Three looks', 0, 1)").run(FLOW, P);
writeGraph(FLOW, GRAPH);

let calls = 0;
const png = n => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`variation-${n}-${crypto.randomUUID()}`)]);
function ctx() {
    return {
        project: { id: P, title: 'Pick a version', provider_config: '{}' },
        scene: { id: SC, project_id: P }, shot: { id: SH, shot_code: '1A' },
        sceneCard: { action: 'a square' }, characters: [], location: null, voiceProfiles: [],
        providerFor: () => ({ id: 'stub', async generate() { calls++; return { ok: true, data: png(calls) }; } }),
    };
}
const candidatesOf = runId => db.prepare(`SELECT * FROM film_assets WHERE json_valid(metadata)
    AND json_extract(metadata, '$.kind') = 'flow_output' AND json_extract(metadata, '$.run_id') = ?`).all(runId);
const liveFrame = () => path.join(require('../lib/file-storage').getFilePath(P, 'storyboards', '1A.png'));

async function pausedRun() {
    const runId = generateId();
    // The route's picker resolves the run's context from its shot; the test
    // stubs the provider through the same hook runFlow is given.
    require('../lib/flow-pick')._setContextFor(() => ctx());
    const r = await runFlow(GRAPH, ctx(), { runId, flowId: FLOW });
    assert.equal(r.status, 'paused', `the run did not pause: ${JSON.stringify(r.status)}`);
    return runId;
}

// ── pausing ────────────────────────────────────────────────────────────
let RUN;
test('a paused run keeps every variation as a candidate on its shot, awaiting a pick', async () => {
    RUN = await pausedRun();
    const rows = candidatesOf(RUN);
    const branches = db.prepare('SELECT branch_key FROM film_flow_branches WHERE run_id = ? ORDER BY branch_key').all(RUN).map(b => b.branch_key);
    assert.equal(branches.length, 3);
    for (const b of branches) {
        const row = rows.find(r => JSON.parse(r.metadata).branch === b);
        assert.ok(row, `variation ${b} is not a candidate`);
        assert.ok(fs.existsSync(row.file_path), `variation ${b} is not on disk`);
        assert.equal(row.shot_id, SH);
        assert.equal(JSON.parse(row.metadata).awaiting_pick, 'pick');
    }
    assert.equal(rows.length, 3, 'one candidate per variation, no more');
    const shot = buildGraph(db, P).nodes.find(n => n.key === `shot:${SH}`);
    const awaiting = shot.flow_frames.filter(f => f.awaiting_pick);
    assert.equal(awaiting.length, 3, 'the drawer does not see them as awaiting a pick');
    for (const f of awaiting) assert.equal(f.run_id, RUN);
});

// ── picking ────────────────────────────────────────────────────────────
test('picking one resumes the run from the gate and makes it the shot\'s frame; nothing upstream runs again', async () => {
    const before = calls;
    const chosen = candidatesOf(RUN).find(r => JSON.parse(r.metadata).branch === 'fan#2');
    const r = await call('POST', `/film/flow-runs/${RUN}/select`, { branch_key: 'fan#2' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.selected, 'fan#2');
    assert.equal(r.body.status, 'complete', 'the run did not resume');
    assert.equal(calls, before, 'the pick generated again');

    const run = db.prepare('SELECT status FROM film_flow_runs WHERE id = ?').get(RUN);
    assert.equal(run.status, 'complete');
    const sel = db.prepare('SELECT branch_key FROM film_flow_branches WHERE run_id = ? AND selected = 1').all(RUN);
    assert.deepEqual(sel.map(s => s.branch_key), ['fan#2']);

    // The downstream save used the chosen candidate rather than making a fourth.
    assert.equal(candidatesOf(RUN).length, 3, 'resuming saved the chosen variation a second time');

    // The shot's frame is the chosen picture, as a new version on the board.
    const shot = db.prepare('SELECT current_frame_version FROM film_shots WHERE id = ?').get(SH);
    const frame = db.prepare("SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard' ORDER BY version DESC LIMIT 1").get(SH);
    assert.ok(frame, 'no frame version was made');
    assert.deepEqual(fs.readFileSync(liveFrame()), fs.readFileSync(chosen.file_path), 'the board shows a different picture');
    assert.ok(shot.current_frame_version == null || shot.current_frame_version === frame.version, 'the chosen version is not the one shown');
    assert.equal(JSON.parse(frame.metadata).flow_from.branch, 'fan#2');
    assert.equal(JSON.parse(frame.metadata).flow_from.run_id, RUN);

    const g = buildGraph(db, P).nodes.find(n => n.key === `shot:${SH}`);
    assert.equal(g.flow_frames.filter(f => f.awaiting_pick).length, 0, 'still shown as awaiting a pick after the pick');
    assert.equal(g.selected_frame.version, frame.version);
});

test('a run that is no longer paused cannot be picked, and nothing changes', async () => {
    const frames = db.prepare("SELECT COUNT(*) AS n FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'").get(SH).n;
    const r = await call('POST', `/film/flow-runs/${RUN}/select`, { branch_key: 'fan#1' });
    assert.equal(r.statusCode, 409);
    assert.equal(r.body.code, 'NOT_PAUSED');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'").get(SH).n, frames);
    assert.deepEqual(db.prepare('SELECT branch_key FROM film_flow_branches WHERE run_id = ? AND selected = 1').all(RUN).map(s => s.branch_key), ['fan#2']);
});

test('cancelling a paused run leaves its variations unpicked, and a pick after it is refused', async () => {
    const run = await pausedRun();
    const c = await call('POST', `/film/flow-runs/${run}/cancel`);
    assert.equal(c.statusCode, 200);
    const r = await call('POST', `/film/flow-runs/${run}/select`, { branch_key: 'fan#1' });
    assert.equal(r.statusCode, 409);
    assert.equal(r.body.code, 'NOT_PAUSED');
    assert.equal(candidatesOf(run).length, 3, 'cancelling removed the variations');
    const g = buildGraph(db, P).nodes.find(n => n.key === `shot:${SH}`);
    assert.ok(!g.flow_frames.some(f => f.run_id === run && f.awaiting_pick), 'a cancelled run still offers a pick');
});

test('an unknown branch is refused and the run stays paused', async () => {
    const run = await pausedRun();
    const r = await call('POST', `/film/flow-runs/${run}/select`, { branch_key: 'fan#9' });
    assert.equal(r.statusCode, 404);
    assert.equal(db.prepare('SELECT status FROM film_flow_runs WHERE id = ?').get(run).status, 'paused');
});

test('a locked board refuses a frame pick, and the run stays paused', async () => {
    const run = await pausedRun();
    db.prepare("UPDATE film_projects SET board_locked_at = datetime('now') WHERE id = ?").run(P);
    try {
        const r = await call('POST', `/film/flow-runs/${run}/select`, { branch_key: 'fan#1' });
        assert.equal(r.statusCode, 423);
        assert.equal(db.prepare('SELECT status FROM film_flow_runs WHERE id = ?').get(run).status, 'paused');
    } finally { db.prepare('UPDATE film_projects SET board_locked_at = NULL WHERE id = ?').run(P); }
});

// ── every drawn kind: what picking does ────────────────────────────────
test('picking a candidate of every drawn kind makes it the shot\'s version of that kind', async () => {
    const pick = require('../lib/flow-pick');
    const kinds = Object.entries(outputs.FLOW_OUTPUT_KINDS).filter(([, k]) => k.version);
    assert.ok(kinds.length >= 3);
    for (const [port, k] of kinds) {
        const saved = await outputs.saveFlowOutput(db, {
            port, value: port === 'image' ? png(99) : Buffer.from(`${port}-bytes-${crypto.randomUUID()}`),
            node: { id: 'save', config: {} }, ctx: { ...ctx(), runId: null, branch: 'x#1' },
        });
        assert.ok(saved.ok, saved.error);
        const r = pick.promoteCandidate(db, saved.assetId, {});
        assert.equal(r.ok, true, `${port}: ${r.error}`);
        if (k.version === 'frame') {
            assert.ok(r.version, `${port}: no frame version`);
            assert.deepEqual(fs.readFileSync(liveFrame()), fs.readFileSync(saved.path));
        } else {
            const row = db.prepare('SELECT asset_type FROM film_assets WHERE id = ?').get(saved.assetId);
            assert.equal(row.asset_type, k.as_type, `${port}: still a candidate after the pick`);
            if (k.version === 'clip') {
                assert.equal(db.prepare('SELECT selected_video_asset_id AS v FROM film_shots WHERE id = ?').get(SH).v, saved.assetId,
                    `${port}: not the shot's selected clip`);
            }
        }
    }
});

// ── the drawer ─────────────────────────────────────────────────────────
test('the drawer offers Pick on each awaiting variation and Cancel on its run', () => {
    const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const grab = name => {
        const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(SPA);
        assert.ok(m, `no ${name} on the page`);
        let i = SPA.indexOf('{', SPA.indexOf(')', m.index)), d = 0;
        for (let j = i; j < SPA.length; j++) { if (SPA[j] === '{') d++; else if (SPA[j] === '}' && --d === 0) return SPA.slice(m.index, j + 1); }
    };
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const c = vm.createContext({ esc, pgSrc: u => u, String });
    vm.runInContext(grab('pgFlowPickControls') + grab('pgFlowFramesHtml') + ';this.a=pgFlowPickControls;this.b=pgFlowFramesHtml;', c);
    const strip = c.b({ flow_frames: [
        { asset_id: 'a1', url: '/u1', run_id: 'R1', branch: 'fan#1', awaiting_pick: true },
        { asset_id: 'a2', url: '/u2', run_id: 'R1', branch: 'fan#2', awaiting_pick: true },
        { asset_id: 'a3', url: '/u3', run_id: 'R0', branch: 'fan#1', awaiting_pick: false },
    ] });
    assert.match(strip, /pgFlowPick\('R1','fan#1'\)/);
    assert.match(strip, /pgFlowPick\('R1','fan#2'\)/);
    assert.doesNotMatch(strip, /pgFlowPick\('R0'/, 'a variation whose run is not paused offers a pick');
    assert.match(strip, /pgFlowCancelRun\('R1'\)/, 'no way to cancel the paused run');
    const clip = c.a({ source: 'flow', awaiting_pick: true, run_id: 'R2', branch: 'fan#3' });
    assert.match(clip, /pgFlowPick\('R2','fan#3'\)/, 'a paused clip variation offers no pick');
    assert.equal(c.a({ source: 'flow', awaiting_pick: false, run_id: 'R2', branch: 'fan#3' }), '');
    assert.match(grab('pgDrawerVersion'), /pgFlowPickControls\(n\)/, 'the version drawer never offers the pick');
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA, 'the iOS bundle was not re-synced');
});
