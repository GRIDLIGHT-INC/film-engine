/**
 * PGN-010 — one queue read model.
 *
 * Everything the Production graph's queue strip will show, from ONE free
 * read: running (with progress), waiting (the rest of a run in progress),
 * done today, awaiting collection (a provider still holds a job the caller
 * stopped waiting for) and failed — each with its node and a thumbnail where
 * one exists.
 *
 * Set-based over the buckets and over the job states that feed them: every
 * (status, collectable, freshness, age) combination lands in exactly one
 * bucket or is deliberately left out, so no job is shown twice or silently lost.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-gq-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const q = require('../lib/generation-queue');

test('the buckets are declared once, in the order the strip reads them', () => {
    // 'paused' arrived with flow runs on the strip (FOG-007): a run stopped at a pick, waiting for a person.
    assert.deepEqual([...q.QUEUE_BUCKETS], ['running', 'waiting', 'paused', 'done_today', 'awaiting_collection', 'failed']);
});

test('every job state lands in exactly one bucket, or is left out on purpose', () => {
    const cases = [];
    for (const status of ['pending', 'completed', 'failed']) {
        for (const collectable of [0, 1]) {
            for (const fresh of [true, false]) {
                for (const today of [true, false]) cases.push({ status, collectable, fresh, today });
            }
        }
    }
    const got = cases.map(c => ({ c, b: q.classifyJob({ status: c.status, collectable: c.collectable,
        silent_s: c.fresh ? 5 : 3600, settled_today: c.today ? 1 : 0, settled_age_s: c.today ? 60 : 3 * 86400 }) }));
    const want = c => {
        if (c.status === 'pending') return c.fresh ? 'running' : (c.collectable ? 'awaiting_collection' : 'failed');
        if (c.status === 'completed') return c.today ? 'done_today' : null;
        return c.today ? 'failed' : null;
    };
    const wrong = got.filter(({ c, b }) => b !== want(c)).map(({ c, b }) => `${JSON.stringify(c)} → ${b}`);
    assert.deepEqual(wrong, []);
    for (const { b } of got) assert.ok(b === null || q.QUEUE_BUCKETS.includes(b));
});

const P = generateId(), SC = generateId(), SH = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Queue')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, '1A')").run(SH, SC);
const frameId = generateId();
const framePath = path.join(process.env.FILM_DATA_DIR, 'storyboards', P, '1A.png');
fs.mkdirSync(path.dirname(framePath), { recursive: true });
fs.writeFileSync(framePath, 'x');
db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_name, file_path, version)
    VALUES (?, ?, ?, ?, 'storyboard', '1A.png', ?, 1)`).run(frameId, P, SH, SC, framePath);

function job(o) {
    const id = generateId();
    db.prepare(`INSERT INTO film_generation_jobs (id, project_id, shot_id, provider, capability, request_id, status, meta,
        percent, phase, started_at, heartbeat_at, settled_at, collectable, asset_id, error)
        VALUES (?, ?, ?, 'runway', 'video', ?, ?, '{}', ?, ?, datetime('now', ?), datetime('now', ?), ?, ?, ?, ?)`)
        .run(id, P, o.shot === undefined ? SH : o.shot, 'r-' + id, o.status, o.percent || null, o.phase || null,
            `-${o.age || 10} seconds`, `-${o.silent || 1} seconds`, o.settled || null, o.collectable === undefined ? 1 : o.collectable,
            o.asset || null, o.error || null);
    return id;
}

test('the project queue fills every bucket from real rows, each item with its node', () => {
    const running = job({ status: 'pending', percent: 40, phase: 'generating' });
    const awaiting = job({ status: 'pending', silent: 900, age: 900 });
    const done = job({ status: 'completed', settled: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    const failed = job({ status: 'failed', error: 'declined', settled: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    db.prepare(`INSERT INTO film_pipeline_runs (id, project_id, run_type, status, params, steps_remaining)
        VALUES (?, ?, 'project', 'running', ?, ?)`).run(generateId(), P, JSON.stringify({ kind: 'run_changed' }),
        JSON.stringify([{ stage: 'video', key: 'shot:' + SH, shot_code: '1A' }]));
    // The paused bucket is filled by a flow run waiting for a pick (FOG-007).
    db.prepare("INSERT INTO film_flow_runs (id, flow_id, project_id, shot_id, status) VALUES (?, 'f', ?, ?, 'paused')").run(generateId(), P, SH);
    const out = q.projectQueue(P);
    assert.ok(out, 'no queue for a real project');
    for (const b of q.QUEUE_BUCKETS) assert.ok(Array.isArray(out[b]) && out[b].length >= 1, `${b} is empty`);
    assert.equal(out.running[0].job_id, running);
    assert.equal(out.running[0].percent, 40);
    assert.equal(out.awaiting_collection[0].job_id, awaiting);
    assert.equal(out.done_today[0].job_id, done);
    assert.equal(out.failed[0].job_id, failed);
    assert.match(out.failed[0].error, /declined/);
    assert.equal(out.waiting[0].key, 'shot:' + SH);
    for (const b of ['running', 'done_today', 'awaiting_collection', 'failed']) assert.equal(out[b][0].key, 'shot:' + SH, `${b}: no node key`);
    assert.deepEqual(out.counts, Object.fromEntries(q.QUEUE_BUCKETS.map(b => [b, out[b].length])));
});

test('a thumbnail comes from the job\'s own file when it has one, else the node\'s current frame, else none', () => {
    const withAsset = job({ status: 'completed', asset: frameId, settled: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    const noShot = job({ status: 'completed', shot: null, settled: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    const out = q.projectQueue(P);
    const a = out.done_today.find(x => x.job_id === withAsset);
    assert.ok(a.thumb && /1A\.png/.test(a.thumb), `job asset thumb: ${a.thumb}`);
    const n = out.running.concat(out.done_today).find(x => x.key === 'shot:' + SH && x.job_id !== withAsset);
    assert.ok(n.thumb && /1A\.png/.test(n.thumb), 'no fallback to the shot frame');
    assert.equal(out.done_today.find(x => x.job_id === noShot).thumb, null, 'an unplaceable job invents no thumbnail');
});

test('an unknown project has no queue; nothing throws', () => {
    assert.equal(q.projectQueue(generateId()), null);
    assert.equal(q.classifyJob(null), null);
});

test('GET …/production-graph/queue serves it', async () => {
    const { handleProductionGraph } = require('../routes/production-graph');
    let status = 0, body = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
    await handleProductionGraph({ method: 'GET' }, res, ['film', 'projects', P, 'production-graph', 'queue'], {});
    assert.equal(status, 200);
    for (const b of q.QUEUE_BUCKETS) assert.ok(Array.isArray(body[b]));
    await handleProductionGraph({ method: 'GET' }, res, ['film', 'projects', generateId(), 'production-graph', 'queue'], {});
    assert.equal(status, 404);
});

test('a run in progress records what is still to come, so the queue can show it waiting', async () => {
    const rc = require('../lib/run-changed');
    const P2 = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Queue run')").run(P2);
    let midRow = null;
    await rc.runChanged(P2, {}, {
        plan: () => ({ items: [{ stage: 'keyframe', key: 'shot:a', cost: 0 }, { stage: 'keyframe', key: 'shot:b', cost: 0 }], skipped: [], total_cost: 0, refused: false }),
        execute: async it => {
            if (it.key === 'shot:a') midRow = db.prepare("SELECT steps_remaining FROM film_pipeline_runs WHERE project_id = ? AND status = 'running'").get(P2);
            return { ok: true };
        },
    });
    assert.ok(midRow, 'no running row during the run');
    assert.deepEqual(JSON.parse(midRow.steps_remaining).map(r => r.key), ['shot:b']);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
