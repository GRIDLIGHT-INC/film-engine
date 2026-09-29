/**
 * FOG-013 (GRD-4594) — flows on the Production graph, end to end, through a
 * real server.
 *
 * The epic's own sentence: select 2 shots, plan, apply a variations template,
 * pause, pick, see the version selected and the queue updated. Every step is
 * an HTTP call against a spawned server.js, the generations go to a mock
 * gateway (nothing is bought), and every assertion is made per shot of the
 * selection — a path that works for the first shot and not the second is the
 * partial failure an example test cannot see.
 *
 * The variations template is the shipped "Multi-model video": a keyframe,
 * fanned out across three providers, stopping at "pick a take". A test has no
 * credentials for Runway or OpenAI, so the fan-out's provider list is pointed
 * at the gateway three times — the per-node provider choice the Flows canvas
 * edits — and everything else in the template is as shipped.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-fog013-' + crypto.randomUUID().slice(0, 8));
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.FILM_DATA_DIR = TEST_DIR;
const { testApi } = require('./helpers');

const PORT = 25100 + Math.floor(Math.random() * 400);
const api = testApi(`http://localhost:${PORT}`);
let server, gateway;
const gatewayCalls = [];

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0]), Buffer.alloc(16)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)]);

test.before(async () => {
    gateway = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/media/capabilities') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ media: [{ medium: 'video', models: [{ id: 'ltx-2.5', available: true,
                inputs: [{ kind: 'keyframe', field: 'references', accepts: ['image/png', 'image/jpeg'], max: 8, at: ['start', 'end', 'seconds'] }] }] }] }));
        }
        if (req.method === 'GET' && req.url.startsWith('/outputs/')) {
            res.writeHead(200, { 'Content-Type': 'video/mp4' });
            return res.end(Buffer.concat([MP4, crypto.randomBytes(8)]));
        }
        let raw = ''; req.on('data', c => raw += c);
        req.on('end', () => {
            gatewayCalls.push(req.url);
            if (req.url === '/video') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('data: ' + JSON.stringify({ event: 'started' }) + '\n\n');
                res.write('data: ' + JSON.stringify({ event: 'completed', video_url: `/outputs/${crypto.randomUUID()}.mp4`, seed: 7, model: 'ltx-2.5' }) + '\n\n');
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, image: PNG.toString('base64'), images: [PNG.toString('base64')] }));
        });
    });
    await new Promise(r => gateway.listen(0, '127.0.0.1', r));
    const env = { ...process.env, PORT: String(PORT), FILM_DATA_DIR: TEST_DIR, GRIDLIGHT_ENABLED: '1',
        GRIDLIGHT_URL: `http://127.0.0.1:${gateway.address().port}`, GRIDLIGHT_API_KEY: 'test', RATE_LIMIT_MAX_GENERATION: '1000' };
    for (const k of Object.keys(env)) if (/_API_KEY$|_API_SECRET$|^RUNWAYML_/.test(k) && k !== 'GRIDLIGHT_API_KEY') delete env[k];
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'pipe' });
    server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
    for (let i = 0; i < 100; i++) {
        try { const r = await api('/api/health'); if (r.status === 200) return; } catch (_) { /* booting */ }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('server did not start');
});
test.after(() => {
    if (server) server.kill('SIGTERM');
    if (gateway) gateway.close();
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
});

async function poll(fn, done, what) {
    let last;
    for (let i = 0; i < 300; i++) {
        last = await fn();
        if (done(last)) return last;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.fail(`${what}: never happened; last ${JSON.stringify(last && last.data).slice(0, 600)}`);
}

test('select 2 shots → plan → apply a variations template → pause → pick → the version is selected and the queue moves', async () => {
    // ── a project with two shots on the graph ───────────────────────────
    const proj = await api('/film/projects', { method: 'POST', body: { title: 'Flows on the graph', provider_config: { image: 'gridlight', video: 'gridlight' } } });
    assert.equal(proj.status, 201, JSON.stringify(proj.data));
    const P = proj.data.id;
    await api(`/film/projects/${P}/script`, { method: 'POST', body: { format: 'fountain',
        content: 'Title: Flows\n\nINT. DINER - NIGHT\n\nMAYA waits by the window.\n\nMAYA\nHe is late.\n' } });
    const scenes = await api(`/film/projects/${P}/scenes`);
    const sceneId = scenes.data.scenes[0].id;
    const made0 = await api('/film/shots', { method: 'POST', body: { scene_id: sceneId, cards: ['1A', '1B'].map(code =>
        ({ shot_code: code, description: `${code}: MAYA waits by the window.`, characters: ['MAYA'], camera: { shot_type: 'medium' } })) } });
    assert.ok([200, 201].includes(made0.status), JSON.stringify(made0.data));
    const shots = (made0.data.shots || made0.data).map(s => s.id);
    assert.equal(shots.length, 2);
    const graph0 = await api(`/film/projects/${P}/production-graph`);
    const keys = shots.map(id => `shot:${id}`);
    for (const k of keys) assert.ok(graph0.data.nodes.some(n => n.key === k), `${k} is not on the graph`);

    // ── the variations template, saved into the project ─────────────────
    const shelf = await api('/film/flow-templates');
    const tpl = shelf.data.templates.find(t => t.id === 'multi-model-video');
    assert.ok(tpl, 'the variations template is not on the shelf');
    const made = await api(`/film/projects/${P}/flows/from-template`, { method: 'POST', body: { template_id: 'multi-model-video' } });
    assert.ok([200, 201].includes(made.status), JSON.stringify(made.data));
    const flowId = made.data.id || (made.data.flow && made.data.flow.id);
    const flow = await api(`/film/flows/${flowId}`);
    const g = flow.data.flow || flow.data;
    for (const n of g.nodes) {
        if (n.type === 'in.prompt') n.config = { ...n.config, text: 'MAYA waits by the window, neon outside' };
        if (n.type === 'tf.fanout') n.config = { ...n.config, count: 3, providers: ['gridlight', 'gridlight', 'gridlight'] };
    }
    const put = await api(`/film/flows/${flowId}`, { method: 'PUT', body: { nodes: g.nodes, edges: g.edges } });
    assert.equal(put.status, 200, JSON.stringify(put.data));

    // ── plan: free, one run per selected shot ───────────────────────────
    const callsBefore = gatewayCalls.length;
    const plan = await api(`/film/flows/${flowId}/apply-plan?targets=${encodeURIComponent(keys.join(','))}`);
    assert.equal(plan.status, 200, JSON.stringify(plan.data));
    assert.equal(plan.data.runs, 2);
    assert.deepEqual(plan.data.shots.map(s => s.shot_id).sort(), [...shots].sort());
    assert.equal(gatewayCalls.length, callsBefore, 'the free plan reached the gateway');

    // ── apply, and every run pauses at the pick ─────────────────────────
    const applied = await api(`/film/flows/${flowId}/apply`, { method: 'POST', body: { targets: keys, fingerprint: plan.data.fingerprint } });
    assert.equal(applied.status, 202, JSON.stringify(applied.data));
    const paused = await poll(() => api(`/film/flow-applies/${applied.data.apply_id}`),
        r => r.data && r.data.runs && r.data.runs.length === 2 && r.data.runs.every(x => x.status !== 'pending' && x.status !== 'running'),
        'both runs settling');
    for (const run of paused.data.runs) assert.equal(run.status, 'paused', `run for ${run.shot_id}: ${run.status} ${run.error_message || ''}`);

    // Paused: every shot carries its variations as candidates, none selected, and the queue says "waiting for a pick".
    const graph1 = await api(`/film/projects/${P}/production-graph`);
    for (const id of shots) {
        const versions = graph1.data.nodes.filter(n => n.parent === `shot:${id}` && n.source === 'flow');
        assert.equal(versions.length, 3, `shot ${id}: ${versions.length} flow variations on the graph`);
        assert.ok(versions.every(v => v.awaiting_pick && !v.selected), `shot ${id}: a variation was selected before any pick`);
    }
    const q1 = await api(`/film/projects/${P}/production-graph/queue`);
    for (const run of paused.data.runs) {
        assert.ok(q1.data.paused.some(x => x.kind === 'flow_run' && x.run_id === run.run_id), `run ${run.run_id} is not waiting for a pick on the strip`);
    }

    // ── pick one variation on the first shot ────────────────────────────
    const [first, second] = [paused.data.runs.find(r => r.shot_id === shots[0]), paused.data.runs.find(r => r.shot_id === shots[1])];
    const branches = await api(`/film/flow-runs/${first.run_id}/branches`);
    const keysB = (branches.data.branches || branches.data).map(b => b.branch_key);
    assert.equal(keysB.length, 3);
    const chosen = graph1.data.nodes.find(n => n.parent === `shot:${shots[0]}` && n.source === 'flow' && n.branch === keysB[1]);
    assert.ok(chosen, 'the variation to pick is not on the graph');
    const pick = await api(`/film/flow-runs/${first.run_id}/select`, { method: 'POST', body: { branch_key: keysB[1] } });
    assert.equal(pick.status, 200, JSON.stringify(pick.data));
    await poll(() => api(`/film/flow-runs/${first.run_id}`), r => r.data && (r.data.run || r.data).status === 'complete', 'the picked run finishing');

    // The picked variation is the shot's clip; the other shot is untouched.
    const graph2 = await api(`/film/projects/${P}/production-graph`);
    const shotNode = graph2.data.nodes.find(n => n.key === `shot:${shots[0]}`);
    assert.ok(shotNode, 'the shot left the graph');
    assert.equal(shotNode.selected_video_asset_id, chosen.asset_id, 'the shot does not point at the variation that was picked');
    const selectedVideo = graph2.data.nodes.filter(n => n.parent === `shot:${shots[0]}` && n.type === 'video' && n.selected);
    assert.deepEqual(selectedVideo.map(v => v.asset_id), [chosen.asset_id], `shot 1A shows ${selectedVideo.length} selected clips`);
    const other = graph2.data.nodes.find(n => n.key === `shot:${shots[1]}`);
    assert.equal(other.selected_video_asset_id, null, 'the other shot gained a selected clip');
    assert.ok(graph2.data.nodes.filter(n => n.parent === `shot:${shots[1]}` && n.source === 'flow').every(v => v.awaiting_pick && !v.selected),
        'the other shot\'s variations changed without a pick');

    // The queue moved: the picked run is done today; the other still waits for its pick.
    const q2 = await api(`/film/projects/${P}/production-graph/queue`);
    assert.ok(q2.data.done_today.some(x => x.kind === 'flow_run' && x.run_id === first.run_id), 'the picked run is not in done today');
    assert.ok(!q2.data.paused.some(x => x.run_id === first.run_id), 'the picked run still waits for a pick');
    assert.ok(q2.data.paused.some(x => x.run_id === second.run_id), 'the unpicked run left the waiting bucket');
});
