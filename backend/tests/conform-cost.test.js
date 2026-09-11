const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * THE CONFORM IS PROJECTED, NOT OMITTED.
 *
 * SHIP-006. Both projections that feed the 402 gate — `projectedCost` for a
 * flow graph and `buildRunPlan` for an orchestrated run — priced only the
 * steps that call a provider. `assembly` calls none, so it appeared in
 * neither: not as a line, not as a zero, not at all. Today that costs nothing
 * in provider credits, because ADR-007 made local ffmpeg the sole executor.
 * The moment a priced executor arrives (a Gridlight endpoint, a provider
 * stitch) the largest single operation in the product would be waved through
 * the gate that exists to stop exactly that — and nothing would fail, because
 * an absent line is indistinguishable from a free one.
 *
 * So every pipeline step that reaches no capability is priced in ONE registry,
 * guarded at load the way COST_PER_CALL already is, and both projections carry
 * it as a named line with its executor and its reason. Set-based over the
 * local steps derived from the registries, because a second one added later
 * must arrive priced or fail here.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-conform-cost-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
const { NODE_TYPES, nodeTypeForStep } = require('../lib/flow-node-types');
const flowCost = require('../lib/flow-cost');
const { buildRunPlan } = require('../lib/run-plan');

/** Steps that reach no provider: their node type declares no capability. */
const LOCAL = PIPELINE_STEPS.filter(s => {
    const id = nodeTypeForStep(s.id);
    return id && !NODE_TYPES[id].capability;
}).map(s => s.id);

function makeFilm(shotCount) {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Priced');
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    for (let i = 0; i < shotCount; i++) {
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order)
                    VALUES (?, ?, ?, '{}', 2000, ?)`).run(generateId(), sceneId, `1${String.fromCharCode(65 + i)}`, i);
    }
    return { projectId, sceneId };
}

// ── The registry ───────────────────────────────────────────────────────────

test('every local step is priced, with an executor and a reason, and nothing else is', () => {
    assert.ok(LOCAL.includes('assembly'), `assembly is not a local step: ${LOCAL}`);
    const reg = flowCost.LOCAL_STEP_COST;
    assert.ok(reg && typeof reg === 'object', 'flow-cost exports no LOCAL_STEP_COST');
    for (const step of LOCAL) {
        const entry = reg[step];
        assert.ok(entry, `local step '${step}' has no cost entry — it would be silently free`);
        assert.strictEqual(typeof entry.cost, 'number', `${step}: cost is not a number`);
        assert.ok(entry.executor, `${step}: names no executor`);
        assert.ok(entry.reason && entry.reason.length > 20, `${step}: no reason for its price`);
    }
    for (const step of Object.keys(reg)) {
        assert.ok(LOCAL.includes(step), `LOCAL_STEP_COST prices '${step}', which is not a local step`);
    }
    // The guard is at load, like COST_PER_CALL's: a local step left unpriced
    // must refuse to boot rather than run free.
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'flow-cost.js'), 'utf8');
    assert.match(src, /LOCAL_STEP_COST\[[^\]]+\][\s\S]{0,200}throw new Error/, 'no load-time guard over the local steps');
});

// ── The flow projection ────────────────────────────────────────────────────

test('a graph that assembles carries the conform as a line, multiplied by fan-out', () => {
    assert.ok(LOCAL.length);
    for (const step of LOCAL) {
        const type = nodeTypeForStep(step);
        const graph = n => ({
            nodes: [
                { id: 'p', type: 'in.prompt' },
                ...(n > 1 ? [{ id: 'f', type: 'tf.fanout', config: { count: n } }] : []),
                { id: 'img', type: 'gen.image' },
                { id: 'out', type },
            ],
            edges: n > 1
                ? [{ from: 'p', fromPort: 'text', to: 'f', toPort: 'any' },
                    { from: 'f', fromPort: 'any', to: 'img', toPort: 'text' },
                    { from: 'img', fromPort: 'image', to: 'out', toPort: 'video' }]
                : [{ from: 'p', fromPort: 'text', to: 'img', toPort: 'text' },
                    { from: 'img', fromPort: 'image', to: 'out', toPort: 'video' }],
        });
        const one = flowCost.projectedCost(graph(1));
        assert.ok(one.local && one.local[step], `${step} is absent from the projection — an absent line reads as free`);
        assert.strictEqual(one.local[step].runs, 1);
        assert.strictEqual(typeof one.local[step].cost, 'number');
        assert.strictEqual(one.local[step].executor, flowCost.LOCAL_STEP_COST[step].executor);
        const expected = flowCost.COST_PER_CALL.image + one.local[step].cost;
        assert.ok(Math.abs(one.total - expected) < 1e-9, `total ${one.total} does not include the ${step} line (${expected})`);

        const three = flowCost.projectedCost(graph(3));
        assert.strictEqual(three.local[step].runs, 3, `${step} did not multiply along the fan-out`);
        // Provider calls are still provider calls: the local line is not one.
        assert.strictEqual(three.calls, one.calls * 3);
    }
});

// ── The run plan ───────────────────────────────────────────────────────────

test('the run plan names the film once, priced, and its cost sits under the budget gate', () => {
    assert.ok(LOCAL.length);
    const { projectId } = makeFilm(3);
    const plan = buildRunPlan(projectId, {});
    assert.ok(Array.isArray(plan.film), 'the plan has no film section — the conform is not projected');
    for (const step of LOCAL) {
        const line = plan.film.find(f => f.step === step);
        assert.ok(line, `${step} is missing from the plan's film section`);
        assert.strictEqual(line.runs, 1, `${step} is planned ${line.runs} times on a 3-shot film — it is made once`);
        assert.strictEqual(line.scope, 'project');
        assert.strictEqual(typeof line.projected_cost, 'number');
        assert.ok(line.executor && line.reason, `${step}: no executor or reason on the plan`);
    }
    const strips = plan.strips.reduce((n, s) => n + s.projected_cost, 0);
    const film = plan.film.reduce((n, f) => n + f.projected_cost, 0);
    assert.ok(Math.abs(plan.projected_cost - (strips + film)) < 1e-9,
        `projected ${plan.projected_cost} is not strips ${strips} + film ${film}`);

    // DIFFERENTIAL: price the conform and the gate must move. A line that is
    // listed and not summed is decoration; this is what "under the 402 gate"
    // means.
    const saved = {};
    for (const step of LOCAL) { saved[step] = flowCost.LOCAL_STEP_COST[step].cost; flowCost.LOCAL_STEP_COST[step].cost = 7; }
    try {
        const priced = buildRunPlan(projectId, {});
        const delta = priced.projected_cost - plan.projected_cost;
        const added = LOCAL.reduce((n, s) => n + (7 - saved[s]), 0);
        assert.ok(Math.abs(delta - added) < 1e-9,
            `pricing the conform moved the projection by ${delta}, not by the ${added} that was added`);
        db.prepare('UPDATE film_projects SET budget_total = ? WHERE id = ?').run(plan.projected_cost + 3, projectId);
        const gated = buildRunPlan(projectId, {});
        assert.strictEqual(gated.budget.wouldExceed, true, 'the conform\'s cost did not reach the budget gate');
        assert.strictEqual(gated.refused, true, 'a run over budget by the conform alone was not refused');
    } finally {
        for (const step of LOCAL) flowCost.LOCAL_STEP_COST[step].cost = saved[step];
        db.prepare('UPDATE film_projects SET budget_total = 0 WHERE id = ?').run(projectId);
    }
    // Restored: free again, and under budget.
    const after = buildRunPlan(projectId, {});
    assert.ok(Math.abs(after.projected_cost - plan.projected_cost) < 1e-9);
    assert.strictEqual(after.refused, false);
});
