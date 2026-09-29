/**
 * FOG-007 (GRD-4588) — flow runs in the queue strip.
 *
 * The Production graph's queue read generation jobs and pipeline runs, and no
 * flow run at all: an apply of a flow to twelve shots ran, paused for a pick
 * or failed with nothing on the strip. Now every flow run lands in exactly one
 * bucket — running, waiting, paused (waiting for a pick), done today, failed —
 * or is left out on purpose with the reason declared. Each pans to its shot
 * and can be cancelled through the existing cancel route, and a cancel
 * actually stops a run that is going (it used to be overwritten when the run
 * finished).
 *
 * Set-based over the flow-run statuses the migration's own CHECK declares,
 * never a list typed here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog007-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const q = require('../lib/generation-queue');
const { handleFlows } = require('../routes/flows');

const STATUSES = (() => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '055_flow_runs.sql'), 'utf8');
    const block = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS film_flow_runs'), sql.indexOf('CREATE TABLE IF NOT EXISTS film_flow_node_runs'));
    const m = /status\s+TEXT[^\n]*\n\s*CHECK \(status IN \(([^)]*)\)\)/.exec(block);
    return m[1].split(',').map(s => s.trim().replace(/'/g, ''));
})();

async function call(method, urlPath, body) {
    let done; const finished = new Promise(r => { done = r; });
    const res = { statusCode: null, body: null, writeHead(c) { this.statusCode = c; }, end(p) { try { this.body = JSON.parse(p); } catch (_) { this.body = p; } done(); } };
    await handleFlows({ method, body: body || {} }, res, urlPath.split('/').filter(Boolean), {});
    await finished;
    return res;
}

const P = generateId(), SC = generateId(), SH = generateId(), FLOW = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Flow queue')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, '1A')").run(SH, SC);
db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'Three looks', 0, 1)").run(FLOW, P);

function flowRun(status, o) {
    const id = generateId();
    const opt = o || {};
    db.prepare(`INSERT INTO film_flow_runs (id, flow_id, project_id, shot_id, status, error_message, started_at, completed_at, apply_id)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?)`).run(id, FLOW, P, SH, status, opt.error || '',
        opt.startedAgo || '-10 seconds', opt.completed === undefined ? null : opt.completed, opt.apply || null);
    return id;
}
const bucketOf = (out, runId) => q.QUEUE_BUCKETS.filter(b => (out[b] || []).some(it => it.run_id === runId && it.kind === 'flow_run'));

test('the statuses are read from the migration, and every one has a decision', () => {
    assert.ok(STATUSES.length >= 6, `read only ${STATUSES.join(',')}`);
    for (const s of STATUSES) assert.ok(s in q.FLOW_RUN_STATUS, `no queue decision for a flow run that is ${s}`);
    for (const [s, d] of Object.entries(q.FLOW_RUN_STATUS)) {
        assert.ok(STATUSES.includes(s), `a decision for a status the schema does not have: ${s}`);
        if (d === null) assert.ok((q.FLOW_RUN_LEFT_OUT[s] || '').length > 20, `${s} is left out without saying why`);
        else assert.ok(q.QUEUE_BUCKETS.includes(d), `${s} → ${d}, which is not a bucket`);
    }
    assert.ok(q.QUEUE_BUCKETS.includes('paused'), 'no bucket for a run waiting for a pick');
});

test('every flow run lands in exactly one bucket, or is left out on purpose — today and older alike', () => {
    const today = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const runs = [];
    for (const s of STATUSES) {
        runs.push({ s, when: 'today', id: flowRun(s, { completed: ['complete', 'failed', 'cancelled'].includes(s) ? today : null, error: s === 'failed' ? 'the provider refused' : '' }) });
        if (['complete', 'failed', 'cancelled'].includes(s)) runs.push({ s, when: 'old', id: flowRun(s, { completed: '2020-01-01 00:00:00', startedAgo: '-2000 days' }) });
    }
    const out = q.projectQueue(P);
    const wrong = [];
    for (const r of runs) {
        const got = bucketOf(out, r.id);
        const want = r.when === 'old' ? null : q.FLOW_RUN_STATUS[r.s];
        if (want === null ? got.length !== 0 : (got.length !== 1 || got[0] !== want)) wrong.push(`${r.s} (${r.when}) → [${got}] wanted ${want}`);
    }
    assert.deepEqual(wrong, []);
    for (const b of q.QUEUE_BUCKETS) {
        for (const it of out[b].filter(x => x.kind === 'flow_run')) {
            assert.equal(it.key, `shot:${SH}`, `${b}: a flow run that does not pan to its shot`);
            assert.equal(it.flow_name, 'Three looks');
        }
    }
    const failed = out.failed.find(x => x.kind === 'flow_run');
    assert.match(failed.error, /refused/);
    assert.deepEqual(out.counts, Object.fromEntries(q.QUEUE_BUCKETS.map(b => [b, out[b].length])));
});

test('an applied run whose runner is gone reads as failed, not running for ever', () => {
    const A = generateId();
    db.prepare("INSERT INTO film_flow_applies (id, flow_id, project_id, fingerprint, targets_json, status) VALUES (?, ?, ?, 'fp', '[]', 'running')").run(A, FLOW, P);
    const orphan = flowRun('running', { apply: A });
    const out = q.projectQueue(P);
    assert.deepEqual(bucketOf(out, orphan), ['failed']);
    assert.match(out.failed.find(x => x.run_id === orphan).error, /stopped|interrupted/i);
});

test('only a run that can still be stopped offers Cancel, and the existing route cancels it', async () => {
    const out = q.projectQueue(P);
    for (const b of q.QUEUE_BUCKETS) {
        for (const it of out[b].filter(x => x.kind === 'flow_run')) {
            const live = ['running', 'waiting', 'paused'].includes(b);
            assert.equal(!!it.cancel, live, `${b}: cancel offered=${!!it.cancel}`);
        }
    }
    for (const s of ['pending', 'running', 'paused']) {
        const id = flowRun(s);
        const r = await call('POST', `/film/flow-runs/${id}/cancel`);
        assert.equal(r.statusCode, 200);
        assert.equal(db.prepare('SELECT status FROM film_flow_runs WHERE id = ?').get(id).status, 'cancelled', `${s}: not cancelled`);
        assert.deepEqual(bucketOf(q.projectQueue(P), id), [], `${s}: still on the strip after cancelling`);
    }
});

test('a cancel reaches a run that is going: it stops before its next node and stays cancelled', async () => {
    const { runFlow } = require('../lib/flow-executor');
    const runId = generateId();
    let later = false;
    const graph = {
        nodes: [{ id: 'p', type: 'in.prompt', config: { text: 'a square' } }, { id: 'a', type: 'gen.image' }, { id: 'b', type: 'gen.image' }],
        edges: [{ from: 'p', fromPort: 'text', to: 'a', toPort: 'text' }, { from: 'a', fromPort: 'image', to: 'b', toPort: 'image' }],
    };
    const ctx = {
        project: { id: P, provider_config: '{}' }, scene: { id: SC, project_id: P }, shot: { id: SH, shot_code: '1A' },
        sceneCard: { action: 'a square' }, characters: [], location: null, voiceProfiles: [],
        providerFor: () => ({ id: 'stub', async generate(cap, payload) {
            if (!later) { later = true; await call('POST', `/film/flow-runs/${runId}/cancel`); return { ok: true, data: Buffer.from('89504e47', 'hex') }; }
            throw new Error('the second node ran after the cancel');
        } }),
    };
    const r = await runFlow(graph, ctx, { runId, flowId: FLOW });
    assert.equal(r.status, 'cancelled');
    assert.equal(db.prepare('SELECT status FROM film_flow_runs WHERE id = ?').get(runId).status, 'cancelled', 'the cancel was overwritten when the run ended');
});

test('the strip draws the paused bucket, with a way to the pick and a Cancel run on each live flow run', () => {
    const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const grab = name => {
        const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(SPA);
        let i = SPA.indexOf('{', SPA.indexOf(')', m.index)), d = 0;
        for (let j = i; j < SPA.length; j++) { if (SPA[j] === '{') d++; else if (SPA[j] === '}' && --d === 0) return SPA.slice(m.index, j + 1); }
    };
    const labels = /const PG_QUEUE_LABELS = Object\.freeze\(\{[\s\S]*?\}\);/.exec(SPA)[0];
    const r = new Function(`const esc = s => String(s == null ? '' : s); const pgSrc = u => u; ${grab('pgThumb')} ${labels} ${grab('pgQueueHtml')}; return { pgQueueHtml, PG_QUEUE_LABELS };`)();
    assert.deepEqual(Object.keys(r.PG_QUEUE_LABELS).sort(), [...q.QUEUE_BUCKETS].sort());
    const out = Object.fromEntries(q.QUEUE_BUCKETS.map(b => [b, []]));
    for (const b of ['running', 'waiting', 'paused']) out[b].push({ kind: 'flow_run', run_id: `R-${b}`, flow_name: 'Three looks', key: 'shot:S', status: b, cancel: 'cancel' });
    out.done_today.push({ kind: 'flow_run', run_id: 'R-done', flow_name: 'Three looks', key: 'shot:S', cancel: null });
    out.counts = Object.fromEntries(q.QUEUE_BUCKETS.map(b => [b, out[b].length]));
    const html = r.pgQueueHtml(out, true, () => '1A');
    for (const b of ['running', 'waiting', 'paused']) assert.ok(html.includes(`pgFlowCancelRun('R-${b}')`), `${b}: no Cancel run`);
    assert.ok(!html.includes("pgFlowCancelRun('R-done')"), 'a finished run offers Cancel');
    assert.match(html, /data-bucket="paused"/);
    assert.match(html, /Three looks/);
    assert.match(html, /pgQueueGo\('shot:S'\)/, 'a flow run does not pan to its shot');
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA, 'the iOS bundle was not re-synced');
});
