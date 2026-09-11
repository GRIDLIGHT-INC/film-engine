/**
 * Phase 3 — fan-out, select, and the budget guard.
 *
 * "One click generates your entire campaign. Every output, every variant, at
 * the same time." That is the claim; the guard is what makes it safe to offer.
 * A fan-out of 4 across a 200-shot feature is 800 generations, and the cost
 * ceiling has to be a GATE rather than a report you read afterwards.
 *
 * The plan's exit criterion, tested literally:
 *   "a fanout(n=3) feeding a generator yields 3 node-runs sharing a branch key,
 *    and the budget guard refuses the run when projected cost exceeds the
 *    project limit."
 *
 * Both halves matter. Branching without the guard is the reason this phase
 * blocks the merge: Phase 4 already lets a user author a fan-out in the UI, so
 * shipping the canvas without the ceiling would put an uncapped spend path on
 * main.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-branch-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { runFlow } = require('../lib/flow-executor');
const { projectedCost, budgetStatus, COST_PER_CALL } = require('../lib/flow-cost');
const { CAPABILITIES } = require('../lib/providers/base');

const PROJECT = generateId();

function ctx(record) {
    return {
        project: { id: PROJECT, title: 'Branch Test', style_preset: 'cinematic', provider_config: '{}' },
        scene: { id: null, project_id: PROJECT },
        sceneCard: { action: 'a warehouse', characters: [] },
        characters: [], location: null, voiceProfiles: [],
        providerFor: () => ({
            id: 'stub',
            async generate(capability, payload) { (record || []).push({ capability, payload }); return { ok: true, data: { image_url: 'http://stub/i.png' } }; },
        }),
    };
}

/** prompt -> fanout(n) -> image. The shape the exit criterion names. */
function fanoutGraph(n) {
    return {
        nodes: [
            { id: 'p', type: 'in.prompt', config: { text: 'a warehouse at night' } },
            { id: 'fan', type: 'tf.fanout', config: { count: n } },
            { id: 'img', type: 'gen.image' },
        ],
        edges: [
            { from: 'p', fromPort: 'text', to: 'fan', toPort: 'any' },
            { from: 'fan', fromPort: 'any', to: 'img', toPort: 'text' },
        ],
    };
}

test('setup: a project with no budget limit', () => {
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(PROJECT, 'Branch Test');
});

// ── Cost model ─────────────────────────────────────────────────────────

test('every generating capability has a cost estimate', () => {
    // Set-based: a capability with no estimate would be silently free, and the
    // guard would wave through exactly the flows it exists to stop.
    const GENERATING = CAPABILITIES;
    const missing = GENERATING.filter(c => typeof COST_PER_CALL[c] !== 'number');
    assert.deepStrictEqual(missing, [], `capabilities with no cost estimate: ${missing.join(', ')}`);
});

test('projected cost counts every generator call, multiplied by fan-out', () => {
    const one = projectedCost(fanoutGraph(1));
    const three = projectedCost(fanoutGraph(3));
    assert.ok(one.total > 0, 'a graph with a generator costed as free');
    assert.strictEqual(three.calls, one.calls * 3, 'fan-out did not multiply the projected call count');
    assert.ok(Math.abs(three.total - one.total * 3) < 1e-9, 'fan-out did not multiply projected cost');
});

test('nodes that call no provider are free', () => {
    const free = projectedCost({ nodes: [{ id: 'p', type: 'in.prompt' }, { id: 's', type: 'out.asset' }], edges: [] });
    assert.strictEqual(free.total, 0);
    assert.strictEqual(free.calls, 0);
});

test('nested fan-out multiplies, it does not add', () => {
    // Two fan-outs in series is 3x2 branches, not 3+2. Getting this wrong
    // under-reports the exact case the guard is for.
    const graph = {
        nodes: [
            { id: 'p', type: 'in.prompt' },
            { id: 'f1', type: 'tf.fanout', config: { count: 3 } },
            { id: 'f2', type: 'tf.fanout', config: { count: 2 } },
            { id: 'img', type: 'gen.image' },
        ],
        edges: [
            { from: 'p', fromPort: 'text', to: 'f1', toPort: 'any' },
            { from: 'f1', fromPort: 'any', to: 'f2', toPort: 'any' },
            { from: 'f2', fromPort: 'any', to: 'img', toPort: 'text' },
        ],
    };
    assert.strictEqual(projectedCost(graph).calls, 6);
});

// ── The budget guard ───────────────────────────────────────────────────

test('budgetStatus reports headroom against the project limit', () => {
    db.prepare('UPDATE film_projects SET budget_total = ? WHERE id = ?').run(100, PROJECT);
    const status = budgetStatus(db, PROJECT, 10);
    assert.strictEqual(status.limit, 100);
    assert.strictEqual(status.spent, 0);
    assert.strictEqual(status.projected, 10);
    assert.strictEqual(status.wouldExceed, false);
});

test('spend already recorded counts against the limit', () => {
    db.prepare(
        `INSERT INTO film_cost_entries (id, project_id, cost_type, description, amount)
         VALUES (?, ?, 'image_generation', 'earlier work', ?)`
    ).run(generateId(), PROJECT, 95);

    const status = budgetStatus(db, PROJECT, 10);
    assert.strictEqual(status.spent, 95);
    assert.strictEqual(status.wouldExceed, true, '95 spent + 10 projected against a 100 limit must exceed');
});

test('a project with no limit set is never blocked', () => {
    // An unset budget must not become an accidental ceiling of zero.
    const other = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(other, 'No limit');
    const status = budgetStatus(db, other, 1000);
    assert.strictEqual(status.wouldExceed, false);
    assert.strictEqual(status.limit, 0);
});

test('THE GUARD: a run projected over the limit is refused before anything generates', async () => {
    // Leave only a few cents of headroom, so a 3-way image fan-out ($0.12)
    // genuinely crosses the line rather than merely looking like it should.
    db.prepare('DELETE FROM film_cost_entries WHERE project_id = ?').run(PROJECT);
    db.prepare('UPDATE film_projects SET budget_total = ? WHERE id = ?').run(100, PROJECT);
    db.prepare(
        `INSERT INTO film_cost_entries (id, project_id, cost_type, description, amount)
         VALUES (?, ?, 'image_generation', 'earlier work', ?)`
    ).run(generateId(), PROJECT, 99.95);

    const projected = projectedCost(fanoutGraph(3));
    assert.ok(99.95 + projected.total > 100,
        `the fixture does not actually exceed the limit: 99.95 + ${projected.total}`);

    const record = [];
    const run = await runFlow(fanoutGraph(3), ctx(record), { flowId: 'over-budget' });

    assert.strictEqual(run.status, 'failed', 'an over-budget run was allowed to proceed');
    assert.ok(/budget/i.test(JSON.stringify(run.errors || run)), `refusal did not cite the budget: ${JSON.stringify(run.errors)}`);
    assert.strictEqual(record.length, 0,
        'a generator was called despite the run exceeding the budget — the guard must be a gate, not a report');
});

test('the guard can be overridden deliberately, and says so', async () => {
    // Refusing outright with no way through would make the feature unusable the
    // moment an estimate is wrong. The override is explicit and recorded.
    // Same over-budget project as the test above — otherwise this would pass
    // simply by being under the limit and would prove nothing.
    const blocked = await runFlow(fanoutGraph(3), ctx([]), { flowId: 'still-blocked' });
    assert.strictEqual(blocked.status, 'failed', 'precondition: this project must still be over budget');

    const record = [];
    const run = await runFlow(fanoutGraph(3), ctx(record), { flowId: 'override', ignoreBudget: true });
    assert.notStrictEqual(run.status, 'failed', JSON.stringify(run.errors));
    assert.ok(record.length > 0, 'the override did not actually let the run proceed');
});

// ── Branching ──────────────────────────────────────────────────────────

test('THE EXIT CRITERION: fanout(n=3) into a generator yields 3 node-runs sharing a branch key', async () => {
    db.prepare('UPDATE film_projects SET budget_total = 0 WHERE id = ?').run(PROJECT);  // unlimited
    const record = [];
    const run = await runFlow(fanoutGraph(3), ctx(record), { flowId: 'fanout-3' });

    assert.notStrictEqual(run.status, 'failed', JSON.stringify(run.errors || run.nodes));

    const imgRuns = db.prepare(
        'SELECT * FROM film_flow_node_runs WHERE run_id = ? AND node_id = ?'
    ).all(run.id, 'img');
    assert.strictEqual(imgRuns.length, 3, `expected 3 node-runs for the generator, got ${imgRuns.length}`);

    const branches = db.prepare('SELECT * FROM film_flow_branches WHERE run_id = ?').all(run.id);
    assert.strictEqual(branches.length, 3, `expected 3 branch rows, got ${branches.length}`);

    const keys = new Set(branches.map(b => b.branch_key));
    assert.strictEqual(keys.size, 3, 'branch keys are not distinct');
    for (const r of imgRuns) {
        assert.ok(r.branch_id, 'a fanned node-run has no branch');
    }
    assert.strictEqual(record.length, 3, 'the generator was not actually called once per branch');
});

test('every branch records the origin node it came from', async () => {
    const run = await runFlow(fanoutGraph(2), ctx([]), { flowId: 'origin' });
    const branches = db.prepare('SELECT * FROM film_flow_branches WHERE run_id = ?').all(run.id);
    assert.ok(branches.length > 0);
    assert.ok(branches.every(b => b.origin_node_id === 'fan'), JSON.stringify(branches.map(b => b.origin_node_id)));
});

test('a flow with no fan-out still runs exactly once per node', async () => {
    const graph = {
        nodes: [{ id: 'p', type: 'in.prompt', config: { text: 'x' } }, { id: 'img', type: 'gen.image' }],
        edges: [{ from: 'p', fromPort: 'text', to: 'img', toPort: 'text' }],
    };
    const record = [];
    const run = await runFlow(graph, ctx(record), { flowId: 'no-fanout' });
    assert.strictEqual(record.length, 1, 'the unbranched path changed behaviour');
    const rows = db.prepare('SELECT * FROM film_flow_node_runs WHERE run_id = ?').all(run.id);
    assert.strictEqual(rows.length, 2);
});

test('tf.select pauses the run for a human choice', async () => {
    const graph = {
        nodes: [
            { id: 'p', type: 'in.prompt', config: { text: 'x' } },
            { id: 'fan', type: 'tf.fanout', config: { count: 2 } },
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
    const run = await runFlow(graph, ctx([]), { flowId: 'gated' });

    assert.strictEqual(run.status, 'paused', `expected a pause at the select gate, got ${run.status}`);

    const row = db.prepare('SELECT status FROM film_flow_runs WHERE id = ?').get(run.id);
    assert.strictEqual(row.status, 'paused', 'the pause did not survive to the database');

    // The gate must not have let the downstream node run.
    const save = db.prepare('SELECT * FROM film_flow_node_runs WHERE run_id = ? AND node_id = ?').all(run.id, 'save');
    assert.ok(save.every(s => s.status !== 'complete'), 'a node past the select gate ran before a branch was chosen');
});
