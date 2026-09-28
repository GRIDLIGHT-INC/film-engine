/**
 * PGN-007 — "Run what changed": the run.
 *
 * The plan (PGN-006) is shown in the one confirmation; then items run ONE AT A
 * TIME through the existing generate path, and the impact report is re-read
 * after each, so a "waiting" item runs once what it waits on is done. The run
 * stops at the first refusal and names everything it did not attempt. The
 * budget is checked before the first item and before every item after it.
 * Nothing is attempted twice: an item that ran and is still behind is reported,
 * not bought again.
 *
 * The runner is driven with an injected planner and executor, so every branch
 * is exercised without spending; the route and the page are held too.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-rcr-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const rc = require('../lib/run-changed');

const P = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Run changed run')").run(P);

const item = (stage, key, cost = 0.04) => ({ stage, key, capability: 'image', cost, why: 'w' });

/** A planner that answers from a script of states, advancing as items run. */
function scripted(states) {
    let i = 0;
    return { plan: () => states[Math.min(i, states.length - 1)], advance: () => { i++; } };
}

test('items run one at a time, and the report is re-read after each so a waiting item runs next', async () => {
    const s = scripted([
        { items: [item('keyframe', 'shot:a')], skipped: [{ stage: 'video', key: 'shot:a', reason: 'waiting: …' }], total_cost: 0.04, refused: false },
        { items: [item('video', 'shot:a', 0.5)], skipped: [], total_cost: 0.5, refused: false },
        { items: [], skipped: [], total_cost: 0, refused: false },
    ]);
    const ran = [];
    const out = await rc.runChanged(P, {}, {
        plan: s.plan,
        execute: async it => { ran.push(`${it.stage}@${it.key}`); s.advance(); return { ok: true }; },
    });
    assert.equal(out.ok, true);
    assert.deepEqual(ran, ['keyframe@shot:a', 'video@shot:a'], 'the waiting video ran once its frame was redone');
    assert.deepEqual(out.completed.map(c => c.stage), ['keyframe', 'video']);
    assert.deepEqual(out.not_attempted, []);
});

test('the first refusal stops the run and names everything not attempted', async () => {
    const plan = { items: [item('keyframe', 'shot:a'), item('keyframe', 'shot:b'), item('voice', 'shot:c')], skipped: [], total_cost: 0.12, refused: false };
    const ran = [];
    const out = await rc.runChanged(P, {}, {
        plan: () => plan,
        execute: async it => { ran.push(it.key); return it.key === 'shot:b' ? { ok: false, code: 'STALE_INPUTS', error: 'inputs moved' } : { ok: true }; },
    });
    assert.equal(out.ok, false);
    assert.deepEqual(ran, ['shot:a', 'shot:b']);
    assert.equal(out.failed.key, 'shot:b');
    assert.match(out.failed.error, /inputs moved/);
    assert.deepEqual(out.not_attempted.map(n => n.key), ['shot:c']);
});

test('a thrown generation is a refusal too, never an unhandled crash', async () => {
    const out = await rc.runChanged(P, {}, {
        plan: () => ({ items: [item('keyframe', 'shot:a')], skipped: [], total_cost: 0.04, refused: false }),
        execute: async () => { throw new Error('provider exploded'); },
    });
    assert.equal(out.ok, false);
    assert.match(out.failed.error, /provider exploded/);
});

test('over budget, nothing runs unless the director says so; the budget is re-checked before every item', async () => {
    const ran = [];
    const refusedPlan = { items: [item('keyframe', 'shot:a')], skipped: [], total_cost: 9, refused: true, budget: { limit: 1, spent: 0 } };
    const out = await rc.runChanged(P, {}, { plan: () => refusedPlan, execute: async it => { ran.push(it.key); return { ok: true }; } });
    assert.equal(out.ok, false);
    assert.equal(out.status, 402);
    assert.deepEqual(ran, []);

    const s = scripted([
        { items: [item('keyframe', 'shot:a'), item('keyframe', 'shot:b')], skipped: [], total_cost: 0.08, refused: false },
        { items: [item('keyframe', 'shot:b')], skipped: [], total_cost: 0.04, refused: true, budget: { limit: 0.05, spent: 0.04 } },
    ]);
    const ran2 = [];
    const mid = await rc.runChanged(P, {}, { plan: s.plan, execute: async it => { ran2.push(it.key); s.advance(); return { ok: true }; } });
    assert.deepEqual(ran2, ['shot:a']);
    assert.equal(mid.ok, false);
    assert.match(mid.stopped, /budget/i);

    const ran3 = [];
    const forced = await rc.runChanged(P, { ignore_budget: true }, { plan: () => refusedPlan, execute: async it => { ran3.push(it.key); return { ok: true }; } });
    assert.deepEqual(ran3, ['shot:a']);
    assert.equal(forced.ok, true);
});

test('nothing is bought twice: an item still behind after it ran is reported, not repeated', async () => {
    let calls = 0;
    const out = await rc.runChanged(P, {}, {
        plan: () => ({ items: [item('keyframe', 'shot:a')], skipped: [], total_cost: 0.04, refused: false }),
        execute: async () => { calls++; return { ok: true }; },
    });
    assert.equal(calls, 1);
    assert.equal(out.ok, true);
    assert.deepEqual(out.still_behind.map(i => i.key), ['shot:a']);
});

test('nothing behind: an ok run that did nothing, and says so', async () => {
    const out = await rc.runChanged(P, {}, { plan: () => ({ items: [], skipped: [], total_cost: 0, refused: false }), execute: async () => { throw new Error('should not run'); } });
    assert.equal(out.ok, true);
    assert.deepEqual(out.completed, []);
});

test('every run is recorded as a pipeline run row with what completed, what failed and why', async () => {
    const out = await rc.runChanged(P, {}, {
        plan: () => ({ items: [item('keyframe', 'shot:a'), item('keyframe', 'shot:b')], skipped: [], total_cost: 0.08, refused: false }),
        execute: async it => (it.key === 'shot:a' ? { ok: true } : { ok: false, error: 'declined' }),
    });
    const row = db.prepare('SELECT * FROM film_pipeline_runs WHERE id = ?').get(out.run_id);
    assert.ok(row, 'no run row');
    assert.equal(row.project_id, P);
    assert.equal(row.status, 'failed');
    assert.equal(JSON.parse(row.params).kind, 'run_changed');
    assert.equal(JSON.parse(row.steps_completed).length, 1);
    assert.match(row.error_message, /declined/);
});

// ---- the route --------------------------------------------------------------

async function call(method, parts, body) {
    const { handleProductionGraph } = require('../routes/production-graph');
    let status = 0, out = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { out = JSON.parse(b); } };
    const { Readable } = require('stream');
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = method; req.headers = { 'content-type': 'application/json' };
    await handleProductionGraph(req, res, parts, {});
    return { status, out };
}

test('POST …/run-changed answers at once with a run id and the plan; GET …/run-changed/:run reads it back', async () => {
    rc._setDeps({
        plan: () => ({ items: [item('keyframe', 'shot:a')], skipped: [], total_cost: 0.04, refused: false }),
        execute: async () => ({ ok: true }),
    });
    try {
        const r = await call('POST', ['film', 'projects', P, 'production-graph', 'run-changed'], {});
        assert.equal(r.status, 202);
        assert.ok(r.out.run_id);
        assert.ok(Array.isArray(r.out.plan.items));
        await rc._lastRun();
        const g = await call('GET', ['film', 'projects', P, 'production-graph', 'run-changed', r.out.run_id]);
        assert.equal(g.status, 200);
        assert.equal(g.out.status, 'complete');
        const missing = await call('POST', ['film', 'projects', generateId(), 'production-graph', 'run-changed'], {});
        assert.equal(missing.status, 404);
    } finally { rc._setDeps(null); }
});

test('POST refuses over budget with 402 before anything starts', async () => {
    rc._setDeps({ plan: () => ({ items: [item('keyframe', 'shot:a')], skipped: [], total_cost: 9, refused: true, budget: { limit: 1 } }), execute: async () => ({ ok: true }) });
    try {
        const r = await call('POST', ['film', 'projects', P, 'production-graph', 'run-changed'], {});
        assert.equal(r.status, 402);
    } finally { rc._setDeps(null); }
});

// ---- the page -----------------------------------------------------------------

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), parens = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') parens++; else if (SPA[i] === ')' && --parens === 0) { i++; break; } }
    let depth = 0;
    for (let j = SPA.indexOf('{', i); j < SPA.length; j++) {
        if (SPA[j] === '{') depth++; else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}

test('the confirmation shows every item with its price, the total, what is left out and why, and a budget refusal', () => {
    const src = fnSource('pgRunChangedDescribe');
    assert.ok(src, 'no pgRunChangedDescribe on the page');
    const describe = new Function(`const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); ${src}; return pgRunChangedDescribe;`)();
    const html = describe({
        items: [{ stage: 'keyframe', shot_code: '1A', key: 'shot:a', cost: 0.04, why: 'inputs moved' }, { stage: 'music', scene_id: 's', key: 'scene:s', cost: 0.1, why: 'x' }],
        skipped: [{ stage: 'video', shot_code: '1A', reason: 'waiting: frame first' }],
        total_cost: 0.14, refused: true, budget: { limit: 0.1, spent: 0 },
    });
    assert.match(html, /1A/); assert.match(html, /keyframe/); assert.match(html, /\$0\.04/); assert.match(html, /\$0\.14/);
    assert.match(html, /waiting: frame first/);
    assert.match(html, /budget/i);
});

test('the header offers it, and it goes through the one confirmation then the run route', () => {
    assert.match(SPA, /onclick="pgRunChanged\(\)"/, 'no Run what changed button');
    const run = fnSource('pgRunChanged');
    assert.ok(run);
    assert.match(run, /confirmPaidImage\(/, 'it does not go through the shared confirmation');
    assert.match(run, /run-changed\/plan/, 'the confirmation does not read the free plan');
    assert.match(run, /run-changed['`]/, 'it does not post to the run route');
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
