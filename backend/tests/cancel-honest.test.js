/**
 * PGN-012 — cancel, stated honestly.
 *
 * A batch ("Run what changed", "Run to here") stops before its next step when
 * cancelled — from any process, because the runner re-reads its run row.
 *
 * A running provider job is cancelled only where the provider really can:
 * every async adapter DECLARES `cancel` as 'provider' (the adapter implements
 * cancel(handle) against the provider's own API) or 'stop_waiting' (it cannot;
 * the job stays collectable and the answer says the provider may still bill).
 * A synchronous call has no handle and nothing to cancel, and says so.
 *
 * Set-based over the async adapters in the registry.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-cx-' + crypto.randomUUID().slice(0, 8));
process.env.RUNWAY_API_KEY = 'test-key-123456';
process.env.TOPAZ_API_KEY = 'test-key-123456';
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const providers = require('../lib/providers');
const cancel = require('../lib/generation-cancel');
const q = require('../lib/generation-queue');

const asyncAdapters = () => providers.list().filter(a => a.asyncGeneration);

test('every async adapter declares whether its provider can really cancel', () => {
    const all = asyncAdapters();
    assert.ok(all.length >= 5, `only ${all.length} async adapters`);
    const bad = all.filter(a => !['provider', 'stop_waiting'].includes(a.cancel)).map(a => `${a.id}=${a.cancel}`);
    assert.deepEqual(bad, []);
    const lying = all.filter(a => a.cancel === 'provider' && typeof a.cancelJob !== 'function').map(a => a.id);
    assert.deepEqual(lying, [], 'claims provider cancel but implements none');
});

test('Runway really cancels: DELETE on its own task, and a refusal is reported, not hidden', async () => {
    const runway = providers.get('runway');
    const real = globalThis.fetch;
    const seen = [];
    try {
        globalThis.fetch = async (url, init) => { seen.push(`${init && init.method} ${url}`); return { ok: true, status: 204, json: async () => ({}), text: async () => '' }; };
        const r = await runway.cancelJob('task-1');
        assert.equal(r.ok, true);
        assert.match(seen[0], /^DELETE .*\/tasks\/task-1$/);
        globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }), text: async () => 'not found' });
        const bad = await runway.cancelJob('task-2');
        assert.equal(bad.ok, false);
        assert.match(bad.error, /404|not found/);
    } finally { globalThis.fetch = real; }
});

const P = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Cancel')").run(P);
function job(provider, collectable = 1) {
    const id = generateId();
    db.prepare(`INSERT INTO film_generation_jobs (id, project_id, provider, capability, request_id, status, meta, started_at, heartbeat_at, collectable)
        VALUES (?, ?, ?, 'video', ?, 'pending', '{}', datetime('now'), datetime('now'), ?)`).run(id, P, provider, 'h-' + id, collectable);
    return id;
}

test('cancelling a job: provider cancel where declared, stop-waiting with the billing warning otherwise, for every async adapter', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
    try {
        const wrong = [];
        for (const a of asyncAdapters()) {
            const id = job(a.id);
            const r = await cancel.cancelJob(id);
            if (a.cancel === 'provider') {
                if (!r.ok || r.mode !== 'provider' || !r.cancelled) wrong.push(`${a.id}: provider cancel not performed`);
            } else {
                if (!r.ok || r.mode !== 'stop_waiting') wrong.push(`${a.id}: not stop-waiting`);
                if (!/may still (finish|bill)/i.test(r.warning || '')) wrong.push(`${a.id}: no billing warning`);
                const row = db.prepare('SELECT * FROM film_generation_jobs WHERE id = ?').get(id);
                if (row.status !== 'pending' || row.collectable !== 1) wrong.push(`${a.id}: the handle was not left collectable`);
            }
        }
        assert.deepEqual(wrong, []);
    } finally { globalThis.fetch = real; }
});

test('a stopped-waiting job moves from "running" to "awaiting collection" in the queue', async () => {
    const stopper = asyncAdapters().find(a => a.cancel === 'stop_waiting');
    const id = job(stopper.id);
    assert.ok(q.projectQueue(P).running.some(x => x.job_id === id));
    await cancel.cancelJob(id);
    const after = q.projectQueue(P);
    assert.ok(!after.running.some(x => x.job_id === id), 'still shown as running');
    assert.ok(after.awaiting_collection.some(x => x.job_id === id), 'not offered for collection');
});

test('the queue says, per running job, which kind of cancel it offers', () => {
    const id = job('runway');
    const item = q.projectQueue(P).running.find(x => x.job_id === id);
    assert.equal(item.cancel, 'provider');
    const s = job('muapi');
    assert.equal(q.projectQueue(P).running.find(x => x.job_id === s).cancel, providers.get('muapi').cancel);
});

test('a synchronous call has nothing to cancel; a finished or unknown job is refused', async () => {
    const sync = job('openai', 0);
    const r = await cancel.cancelJob(sync);
    assert.equal(r.ok, false); assert.equal(r.status, 409); assert.match(r.error, /nothing to cancel|finishes on its own/i);
    db.prepare("UPDATE film_generation_jobs SET status = 'completed' WHERE id = ?").run(sync);
    assert.equal((await cancel.cancelJob(sync)).status, 409);
    assert.equal((await cancel.cancelJob('no-such-job')).status, 404);
});

test('a batch run stops before its next step once cancelled, and names what it did not attempt', async () => {
    const rc = require('../lib/run-changed');
    const items = [{ stage: 'keyframe', key: 'shot:a', cost: 0 }, { stage: 'keyframe', key: 'shot:b', cost: 0 }, { stage: 'keyframe', key: 'shot:c', cost: 0 }];
    let runId = null;
    const ran = [];
    const out = await rc.runChanged(P, {}, {
        plan: () => ({ items, skipped: [], total_cost: 0, refused: false }),
        execute: async it => {
            ran.push(it.key);
            if (!runId) runId = db.prepare("SELECT id FROM film_pipeline_runs WHERE project_id = ? AND status = 'running' ORDER BY rowid DESC LIMIT 1").get(P).id;
            if (it.key === 'shot:a') assert.equal(cancel.cancelRun(P, runId).ok, true);
            return { ok: true };
        },
    });
    assert.deepEqual(ran, ['shot:a'], 'the run went on past a cancel');
    assert.match(out.stopped, /cancel/i);
    assert.deepEqual(out.not_attempted.map(n => n.key), ['shot:b', 'shot:c']);
    const row = db.prepare('SELECT status FROM film_pipeline_runs WHERE id = ?').get(out.run_id);
    assert.equal(row.status, 'cancelled');
    assert.equal(cancel.cancelRun(P, 'no-such-run').status, 404);
    assert.equal(cancel.cancelRun(P, out.run_id).status, 409, 'a finished run cannot be cancelled');
});

test('routes: POST /generation-jobs/:id/cancel and POST …/production-graph/runs/:runId/cancel', async () => {
    const { handleProductionGraph } = require('../routes/production-graph');
    const { handleGenerationJobs } = require('../routes/generation-jobs');
    const call = async (h, parts) => { let status = 0, body = null;
        const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
        await h({ method: 'POST', body: {} }, res, parts, {}); return { status, body }; };
    const id = job(asyncAdapters().find(a => a.cancel === 'stop_waiting').id);
    const j = await call(handleGenerationJobs, ['film', 'generation-jobs', id, 'cancel']);
    assert.equal(j.status, 200); assert.equal(j.body.mode, 'stop_waiting');
    const r = await call(handleProductionGraph, ['film', 'projects', P, 'production-graph', 'runs', 'no-such-run', 'cancel']);
    assert.equal(r.status, 404);
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
function constSource(name) {
    const m = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(SPA);
    let depth = 0;
    for (let j = m.index; j < SPA.length; j++) { const ch = SPA[j]; if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; else if (ch === ';' && depth === 0) return SPA.slice(m.index, j + 1); }
}

test('the strip offers Cancel where the provider can, Stop waiting (with its warning) where it cannot, and Cancel run on a waiting batch', () => {
    const f = new Function(`const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
        ${constSource('PG_QUEUE_LABELS')} ${fnSource('pgQueueHtml')}; return pgQueueHtml;`)();
    const base = Object.fromEntries(q.QUEUE_BUCKETS.map(b => [b, []]));
    const html = f(Object.assign({}, base, {
        running: [{ job_id: 'j1', key: 'shot:a', provider: 'runway', cancel: 'provider' },
            { job_id: 'j2', key: 'shot:b', provider: 'muapi', cancel: 'stop_waiting' },
            { job_id: 'j3', key: 'shot:c', provider: 'openai', cancel: null }],
        waiting: [{ run_id: 'r1', key: 'shot:d', stage: 'video' }],
    }), true, k => k);
    assert.match(html, /pgQueueCancel\('j1'\)[^>]*>Cancel</);
    assert.match(html, /pgQueueCancel\('j2'\)[^>]*title="[^"]*may still[^"]*"[^>]*>Stop waiting</);
    assert.doesNotMatch(html, /pgQueueCancel\('j3'\)/, 'a synchronous call offers a cancel it cannot perform');
    assert.match(html, /pgQueueCancelRun\('r1'\)/);
    assert.match(fnSource('pgQueueCancel'), /generation-jobs\/.*cancel/);
    assert.match(fnSource('pgQueueCancelRun'), /runs\/.*cancel/);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
