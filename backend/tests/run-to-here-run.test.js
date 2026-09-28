/**
 * PGN-009 — "Run to here": run it, from the node menu.
 *
 * The plan (PGN-008) is shown in the one confirmation; then its steps run in
 * order through each thing's EXISTING generate path — a frame or a shot's clip
 * through the pipeline's executeStep, a sequence through its own generate
 * route, a sound through its cue's generate route — re-planned after each, and
 * stopping at the first refusal with the rest named. Progress shows on the
 * nodes through PGN-003's poller.
 *
 * Set-based over every stage the planner can emit: each has an executor, and
 * each executor reaches the right path.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-rthr-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const rth = require('../lib/run-to-here');
const { SOUND_KIND } = require('../lib/production-graph');

/** Every stage planRunToHere can emit, derived rather than typed. */
const STAGES = [...new Set(['keyframe', 'video', 'sequence', ...Object.values(SOUND_KIND)])];

test('every stage the planner can emit has an executor, and each reaches its own generate path', async () => {
    const calls = [];
    const deps = {
        executeStep: async (stage, shot) => { calls.push(`step:${stage}:${shot.id}`); return { ok: true }; },
        callRoute: async (method, url) => { calls.push(`${method} ${url}`); return { _status: 200, body: { ok: true } }; },
        loadShot: id => ({ shot: { id }, scene: { id: 'sc', project_id: 'p' }, project: { id: 'p' } }),
    };
    const want = {
        keyframe: 'step:keyframe:S', video: 'step:video:S',
        sequence: 'POST /film/sequences/Q/generate',
    };
    for (const k of Object.values(SOUND_KIND)) want[k] = 'POST /film/music-cues/C/generate';
    const missing = [];
    for (const stage of STAGES) {
        calls.length = 0;
        const item = { stage, key: 'x', shot_id: 'S', sequence_id: 'Q', cue_id: 'C' };
        const r = await rth.executeRunToHereItem(item, deps);
        if (!r || !r.ok || calls[0] !== want[stage]) missing.push(`${stage}: ${calls[0] || 'nothing called'}`);
    }
    assert.deepEqual(missing, []);
});

test('a route that answers with an error is a refusal, carrying the route\'s own words', async () => {
    const r = await rth.executeRunToHereItem({ stage: 'sequence', sequence_id: 'Q' },
        { callRoute: async () => ({ _status: 409, body: { error: 'a shot has no keyframe' } }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /no keyframe/);
});

const P = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Run to here run')").run(P);

const planOf = (items, extra) => () => Object.assign({ items, blockers: [], total_cost: items.reduce((n, i) => n + i.cost, 0), refused: false }, extra);
const it = (stage, key) => ({ stage, key, cost: 0.04 });

test('it runs the plan in order, re-planning after each step, and records the run', async () => {
    let step = 0;
    const scripted = [[it('keyframe', 'shot:a'), it('video', 'shot:a')], [it('video', 'shot:a')], []];
    const ran = [];
    const out = await rth.runToHere(P, 'shot:a', {}, {
        plan: () => ({ items: scripted[Math.min(step, 2)], blockers: [], total_cost: 0, refused: false }),
        execute: async i => { ran.push(i.stage); step++; return { ok: true }; },
    });
    assert.equal(out.ok, true);
    assert.deepEqual(ran, ['keyframe', 'video']);
    const row = db.prepare('SELECT params FROM film_pipeline_runs WHERE id = ?').get(out.run_id);
    assert.equal(JSON.parse(row.params).kind, 'run_to_here');
    assert.equal(JSON.parse(row.params).target, 'shot:a');
});

test('the first refusal stops it and names what was not attempted', async () => {
    const out = await rth.runToHere(P, 'seq:s', {}, {
        plan: planOf([it('keyframe', 'shot:a'), it('keyframe', 'shot:b'), it('sequence', 'seq:s')]),
        execute: async i => (i.key === 'shot:b' ? { ok: false, error: 'declined' } : { ok: true }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.failed.key, 'shot:b');
    assert.deepEqual(out.not_attempted.map(n => n.key), ['seq:s']);
});

test('start: blockers refuse before anything runs (409), budget refuses (402), a bad target is 400, an unknown project 404', () => {
    const blocked = rth.startRunToHere(P, 'shot:a', {}, { plan: planOf([], { blockers: [{ key: 'shot:a', reason: 'the board is locked' }] }) });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /locked/);
    const over = rth.startRunToHere(P, 'shot:a', {}, { plan: planOf([it('keyframe', 'shot:a')], { refused: true, budget: { limit: 1 } }) });
    assert.equal(over.status, 402);
    const bad = rth.startRunToHere(P, 'link:x', {}, { plan: () => ({ error: 'A borrowed frame is not made' }) });
    assert.equal(bad.status, 400);
    assert.equal(rth.startRunToHere(generateId(), 'shot:a', {}, { plan: planOf([]) }).status, 404);
    const none = rth.startRunToHere(P, 'shot:a', {}, { plan: planOf([]) });
    assert.equal(none.status, 200);
    assert.match(none.body.message, /nothing/i);
});

test('start: a runnable plan answers 202 with a run id and runs in the background', async () => {
    const ran = [];
    let step = 0;
    const out = rth.startRunToHere(P, 'shot:a', {}, {
        plan: () => (step ? { items: [], blockers: [], total_cost: 0, refused: false } : planOf([it('video', 'shot:a')])()),
        execute: async i => { ran.push(i.stage); step++; return { ok: true }; },
    });
    assert.equal(out.status, 202);
    assert.ok(out.body.run_id);
    await rth._lastRun();
    assert.deepEqual(ran, ['video']);
});

test('POST …/nodes/:key/run-to-here is routed', async () => {
    const { handleProductionGraph } = require('../routes/production-graph');
    let status = 0, body = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
    await handleProductionGraph({ method: 'POST', body: {} }, res,
        ['film', 'projects', P, 'production-graph', 'nodes', 'shot:' + generateId(), 'run-to-here'], {});
    assert.equal(status, 400, 'an unknown node is refused, not run');
    assert.match(body.error, /not on the graph/);
});

// ---- the page -----------------------------------------------------------------------

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

test('the node menu offers "Run to here" exactly on the node types the planner accepts', () => {
    const src = fnSource('pgOpenMenu');
    assert.match(src, /Run to here/);
    const m = src.match(/PG_RUN_TO_HERE_TYPES|runToHereTypes/);
    assert.ok(m, 'the menu does not decide from a declared set of target types');
    const decl = SPA.match(/const PG_RUN_TO_HERE_TYPES = Object\.freeze\(\[([^\]]*)\]\)/);
    assert.ok(decl, 'no PG_RUN_TO_HERE_TYPES');
    const pageTypes = decl[1].match(/'([a-z]+)'/g).map(s => s.slice(1, -1)).sort();
    const serverTypes = Object.keys(rth.TARGETS).filter(t => rth.TARGETS[t]).sort();
    assert.deepEqual(pageTypes, serverTypes, 'the page offers it where the server refuses it, or the reverse');
    assert.match(fnSource('pgMenuDo'), /pgRunToHere\(/);
});

test('the confirmation reads the free plan, lists steps with prices and any blocker, then posts the run', () => {
    const run = fnSource('pgRunToHere');
    assert.ok(run);
    assert.match(run, /confirmPaidImage\(/);
    assert.match(run, /run-to-here\/plan/);
    assert.match(run, /method: 'POST'/);
    assert.match(run, /pgPollRunning\(/, 'progress per step is not started');
    const describe = new Function(`const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); ${fnSource('pgRunToHereDescribe')}; return pgRunToHereDescribe;`)();
    const html = describe({ items: [{ stage: 'keyframe', shot_code: '1A', cost: 0.04, why: 'no frame yet' }, { stage: 'sequence', name: 'Walk', legs: 2, cost: 1 }],
        blockers: [], total_cost: 1.04 });
    assert.match(html, /1A/); assert.match(html, /Walk/); assert.match(html, /\$1\.04/); assert.match(html, /2 legs/);
    assert.match(describe({ items: [], blockers: [{ reason: 'the board is locked' }], total_cost: 0 }), /locked/);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
