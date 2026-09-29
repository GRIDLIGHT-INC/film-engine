/**
 * FOG-002 (GRD-4583) — Apply: one run per target.
 *
 * `POST /film/flows/:id/apply` takes the plan's fingerprint. It refuses when
 * the plan moved since it was read, refuses over budget unless told to ignore
 * it, and otherwise starts exactly ONE run per runnable shot of the plan,
 * through the existing executor, tied together by one apply record.
 *
 * Set-based over the plan itself: every shot the plan says is runnable gets
 * exactly one run, bound to that shot, and every shot or target the plan
 * refuses or holds gets none. And every refusal of the apply starts nothing —
 * the run table is counted before and after each one. A partial version of
 * this (runs for sequences but not direct shots, or a refusal that still
 * started the first run) passes any test written against one example.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog002-' + crypto.randomUUID().slice(0, 8));
// This file STARTS runs, and some carry a generator. Credentials are read from
// the environment before the database, so a key exported in the shell would
// make a test buy an image. Strip them: a run here must fail at resolution.
for (const k of Object.keys(process.env)) {
    if (/_API_KEY$|_API_SECRET$|^RUNWAYML_/.test(k)) delete process.env[k];
}
process.env.GRIDLIGHT_ENABLED = '0';
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { handleFlows, writeGraph } = require('../routes/flows');
const flowApply = require('../lib/flow-apply');

async function call(method, urlPath, query, body) {
    const parts = urlPath.split('/').filter(Boolean);
    const res = {
        statusCode: null, body: null,
        writeHead(code) { this.statusCode = code; },
        end(p) { try { this.body = JSON.parse(p); } catch (_) { this.body = p; } },
    };
    await handleFlows({ method, body: body || {} }, res, parts, query || {});
    return res;
}

// ── fixture ────────────────────────────────────────────────────────────
const P = generateId();
const SC = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Apply')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'SQUARE')").run(SC, P);
const card = JSON.stringify({ action: 'She crosses', shot_type: 'wide', characters: ['MAYA'] });
const shot = {};
for (const [code, c] of [['1A', card], ['1B', card], ['1C', card], ['1D', '{}'], ['1E', card]]) {
    shot[code] = generateId();
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)').run(shot[code], SC, code, c);
}
db.prepare("UPDATE film_shots SET held_at = datetime('now') WHERE id = ?").run(shot['1E']);
const SEQ = generateId();
db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Walk', ?)").run(SEQ, P, JSON.stringify([shot['1A'], shot['1B']]));
const CUE = generateId();
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, title) VALUES (?, ?, ?, 'score', 'Theme')").run(CUE, P, SC);

function flow(nodes, edges) {
    const id = generateId();
    db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'f', 0, 1)").run(id, P);
    writeGraph(id, { nodes, edges: edges || [] });
    return id;
}
// Binds the shot's card and its subject; calls no provider, so it runs for free.
const FREE = flow([{ id: 'sc', type: 'in.scene', config: {} }, { id: 'su', type: 'in.subject', config: {} }]);
// One image call per run: what the budget refusal needs to have something to price.
const PAID = flow([{ id: 'sc', type: 'in.scene', config: {} }, { id: 'img', type: 'gen.image', config: {} }],
    [{ id: 'e', from: 'sc', fromPort: 'text', to: 'img', toPort: 'text' }]);

const runRows = () => db.prepare('SELECT COUNT(*) AS n FROM film_flow_runs').get().n;
const planFor = (flowId, targets) => flowApply.planApply(db, { flowId, projectId: P, targets });
const settle = async (applyId) => {
    for (let i = 0; i < 200; i++) {
        const r = await call('GET', `/film/flow-applies/${applyId}`);
        if (r.body && r.body.status !== 'running') return r.body;
        await new Promise(res => setTimeout(res, 25));
    }
    throw new Error('the apply never settled');
};

// Every kind of selection the plan can make a decision about.
const TARGETS = [`seq:${SEQ}`, `shot:${shot['1A']}`, `shot:${shot['1C']}`, `shot:${shot['1D']}`, `shot:${shot['1E']}`, `sound:${CUE}`, 'shot:gone'];

// ── one run per runnable shot, none for anything else ──────────────────
test('every runnable shot of the plan gets exactly one run, bound to that shot; every refused or held one gets none', async () => {
    const plan = planFor(FREE, TARGETS);
    const runnable = plan.shots.filter(s => s.status === 'ok').map(s => s.shot_id);
    const notRun = [...plan.shots.filter(s => s.status !== 'ok').map(s => s.shot_id), ...plan.held.map(h => h.shot_id)];
    assert.deepEqual(plan.shots.filter(s => s.status === 'ok').map(s => s.shot_code), ['1A', '1B', '1C'], 'fixture drifted');
    assert.ok(notRun.includes(shot['1D']) && notRun.includes(shot['1E']), 'fixture drifted');

    const res = await call('POST', `/film/flows/${FREE}/apply`, {}, { targets: TARGETS, project_id: P, fingerprint: plan.fingerprint });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.equal(res.body.runs.length, runnable.length);
    const done = await settle(res.body.apply_id);

    const rows = db.prepare('SELECT * FROM film_flow_runs WHERE apply_id = ?').all(res.body.apply_id);
    const byShot = new Map();
    for (const r of rows) byShot.set(r.shot_id, (byShot.get(r.shot_id) || 0) + 1);
    for (const id of runnable) assert.equal(byShot.get(id), 1, `shot ${id} did not get exactly one run`);
    for (const id of notRun) assert.equal(byShot.get(id) || 0, 0, `a refused or held shot ${id} got a run`);
    assert.equal(rows.length, runnable.length);
    for (const r of rows) {
        assert.equal(r.flow_id, FREE);
        assert.equal(r.project_id, P);
        assert.equal(r.scene_id, SC, 'the run was not bound to its shot\'s context');
        assert.equal(r.status, 'complete', `run for ${r.shot_id} ended ${r.status}: ${r.error_message}`);
    }
    // The runs follow the plan's running order.
    assert.deepEqual(done.runs.map(r => r.shot_id), runnable);
    assert.equal(done.status, 'complete');
    assert.equal(done.fingerprint, plan.fingerprint);
    assert.deepEqual(done.targets, TARGETS);
});

test('the runs go through the existing executor: each carries the flow graph as run', async () => {
    const plan = planFor(FREE, [`shot:${shot['1C']}`]);
    const res = await call('POST', `/film/flows/${FREE}/apply`, {}, { targets: [`shot:${shot['1C']}`], project_id: P, fingerprint: plan.fingerprint });
    await settle(res.body.apply_id);
    const row = db.prepare('SELECT graph_fingerprint, graph_snapshot FROM film_flow_runs WHERE apply_id = ?').get(res.body.apply_id);
    const { loadGraph } = require('../routes/flows');
    assert.equal(row.graph_fingerprint, loadGraph(FREE).fingerprint);
    assert.equal(JSON.parse(row.graph_snapshot).nodes.length, 2);
});

// ── every refusal starts nothing ───────────────────────────────────────
const REFUSALS = [
    ['a missing fingerprint', 400, 'FINGERPRINT_REQUIRED', () => ({ flow: FREE, body: { targets: [`shot:${shot['1A']}`], project_id: P } })],
    ['no targets', 400, 'TARGETS_REQUIRED', () => ({ flow: FREE, body: { targets: [], project_id: P, fingerprint: 'x' } })],
    ['a selection that moved', 409, 'PLAN_MOVED', () => ({ flow: FREE, body: { targets: [`shot:${shot['1A']}`, `shot:${shot['1C']}`], project_id: P,
        fingerprint: planFor(FREE, [`shot:${shot['1A']}`]).fingerprint } })],
    ['a card edited after the plan was read', 409, 'PLAN_MOVED', () => {
        const fp = planFor(FREE, [`shot:${shot['1B']}`]).fingerprint;
        db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?').run(JSON.stringify({ action: 'He waits', characters: ['RAY'] }), shot['1B']);
        return { flow: FREE, body: { targets: [`shot:${shot['1B']}`], project_id: P, fingerprint: fp } };
    }],
    ['a flow edited after the plan was read', 409, 'PLAN_MOVED', () => {
        const f = flow([{ id: 'sc', type: 'in.scene', config: {} }]);
        const fp = planFor(f, [`shot:${shot['1A']}`]).fingerprint;
        writeGraph(f, { nodes: [{ id: 'sc', type: 'in.scene', config: {} }, { id: 'p', type: 'in.prompt', config: { text: 'x' } }], edges: [] });
        return { flow: f, body: { targets: [`shot:${shot['1A']}`], project_id: P, fingerprint: fp } };
    }],
    ['nothing in the selection can run', 422, 'NOTHING_TO_RUN', () => ({ flow: FREE, body: { targets: [`shot:${shot['1D']}`, `sound:${CUE}`], project_id: P,
        fingerprint: planFor(FREE, [`shot:${shot['1D']}`, `sound:${CUE}`]).fingerprint } })],
    ['the whole selection is over budget', 402, 'BUDGET_EXCEEDED', () => {
        db.prepare('UPDATE film_projects SET budget_total = 0.01 WHERE id = ?').run(P);
        const t = [`shot:${shot['1A']}`, `shot:${shot['1C']}`];
        return { flow: PAID, body: { targets: t, project_id: P, fingerprint: planFor(PAID, t).fingerprint } };
    }],
    ['an unknown flow', 404, null, () => ({ flow: generateId(), body: { targets: [`shot:${shot['1A']}`], project_id: P, fingerprint: 'x' } })],
];
for (const [name, status, code, make] of REFUSALS) {
    test(`refused, and nothing started: ${name}`, async () => {
        const { flow: f, body } = make();
        const before = runRows();
        const applies = db.prepare('SELECT COUNT(*) AS n FROM film_flow_applies').get().n;
        try {
            const res = await call('POST', `/film/flows/${f}/apply`, {}, body);
            assert.equal(res.statusCode, status, JSON.stringify(res.body));
            if (code) assert.equal(res.body.code, code);
            assert.ok(res.body.error && res.body.error.length > 10, 'refused without saying why');
            if (code === 'PLAN_MOVED') assert.ok(res.body.plan && res.body.plan.fingerprint, 'a moved plan must hand back the current one');
            await new Promise(r => setTimeout(r, 50));
            assert.equal(runRows(), before, `${name}: a run was started`);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM film_flow_applies').get().n, applies, `${name}: an apply was recorded`);
        } finally {
            db.prepare('UPDATE film_projects SET budget_total = 0 WHERE id = ?').run(P);
        }
    });
}

test('ignore_budget passes the budget refusal deliberately, and the apply records that it did', async () => {
    // PAID calls gen.image. The test database holds no provider credential, so
    // each run fails at provider resolution: nothing is bought, and the apply
    // still proves it started one run per shot past a refusal it was told to ignore.
    db.prepare('UPDATE film_projects SET budget_total = 0.03 WHERE id = ?').run(P);
    try {
        const t = [`shot:${shot['1A']}`, `shot:${shot['1C']}`];
        const plan = planFor(PAID, t);
        // $0.03 is under ONE image: the per-run gate would refuse each run too, unless the apply passes ignore_budget down.
        assert.equal(plan.budget.wouldExceed, true, 'two images must exceed a $0.03 budget, or this proves nothing');
        const res = await call('POST', `/film/flows/${PAID}/apply`, {}, { targets: t, project_id: P, fingerprint: plan.fingerprint, ignore_budget: true });
        assert.equal(res.statusCode, 202, JSON.stringify(res.body));
        const rec = db.prepare('SELECT ignore_budget, total_cost FROM film_flow_applies WHERE id = ?').get(res.body.apply_id);
        assert.equal(rec.ignore_budget, 1);
        assert.equal(rec.total_cost, plan.total_cost);
        const done = await settle(res.body.apply_id);
        assert.equal(done.runs.length, 2);
        // Each run was told to ignore the budget too, or the per-run gate would refuse what the apply allowed.
        for (const r of db.prepare('SELECT error_message FROM film_flow_runs WHERE apply_id = ?').all(res.body.apply_id)) {
            assert.doesNotMatch(r.error_message, /budget/i);
        }
    } finally {
        db.prepare('UPDATE film_projects SET budget_total = 0 WHERE id = ?').run(P);
    }
});

test('the same plan cannot be applied twice while the first is still running', async () => {
    const t = [`shot:${shot['1A']}`];
    const plan = planFor(FREE, t);
    const hold = flowApply._testHold();   // the runner waits before its first run until released
    try {
        const first = await call('POST', `/film/flows/${FREE}/apply`, {}, { targets: t, project_id: P, fingerprint: plan.fingerprint });
        assert.equal(first.statusCode, 202);
        const before = runRows();
        const second = await call('POST', `/film/flows/${FREE}/apply`, {}, { targets: t, project_id: P, fingerprint: plan.fingerprint });
        assert.equal(second.statusCode, 409);
        assert.equal(second.body.code, 'APPLY_IN_PROGRESS');
        assert.equal(second.body.apply_id, first.body.apply_id);
        assert.equal(runRows(), before);
        hold.release();
        await settle(first.body.apply_id);
    } finally { hold.release(); }
});

// ── the apply record ───────────────────────────────────────────────────
test('the apply record: 404 for an unknown one; its status is derived from its runs', async () => {
    assert.equal((await call('GET', `/film/flow-applies/${generateId()}`)).statusCode, 404);
    const cases = [
        [['complete', 'complete'], 'complete'],
        [['complete', 'running'], 'running'],
        [['complete', 'pending'], 'running'],
        [['complete', 'paused'], 'paused'],
        [['complete', 'failed'], 'completed_with_errors'],
        [['failed', 'failed'], 'failed'],
        [['cancelled', 'cancelled'], 'cancelled'],
        [['complete', 'cancelled'], 'completed_with_errors'],
        [[], 'failed'],
    ];
    for (const [states, want] of cases) assert.equal(flowApply.deriveApplyStatus(states), want, `${states} → ${want}`);
});

test('a run left pending by a process that died is reported interrupted, not running for ever', async () => {
    const id = generateId();
    const runId = generateId();
    db.prepare(`INSERT INTO film_flow_applies (id, flow_id, project_id, fingerprint, targets_json, status, total_cost)
                VALUES (?, ?, ?, 'fp', '[]', 'running', 0)`).run(id, FREE, P);
    db.prepare(`INSERT INTO film_flow_runs (id, flow_id, project_id, shot_id, status, apply_id) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(runId, FREE, P, shot['1A'], id);
    const r = await call('GET', `/film/flow-applies/${id}`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.status, 'interrupted');
    assert.equal(r.body.runs[0].status, 'interrupted');
});
