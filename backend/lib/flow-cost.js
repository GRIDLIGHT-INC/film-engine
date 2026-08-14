/**
 * Projected cost of a flow, and the budget gate that uses it.
 *
 * "One click generates your entire campaign. Every output, every variant, at
 * the same time." A fan-out of 4 across a 200-shot feature is 800 generations,
 * so the ceiling has to be a GATE — checked before anything runs — rather than
 * a number you read afterwards on the ledger.
 *
 * The per-call figures are ESTIMATES used only for that gate. Actual spend is
 * recorded in film_cost_entries by whatever does the generating; nothing here
 * claims to be a price list, and a provider's real rate will differ. They are
 * deliberately on the high side: a guard that under-estimates fails open, which
 * is the failure that costs money.
 */

const { CAPABILITIES } = require('./providers/base');
const { nodeType } = require('./flow-node-types');

/**
 * USD per generation call, per capability. Order-of-magnitude figures for
 * gating, not billing. `stock` licenses rather than generates, so it is priced
 * separately from inference.
 */
const COST_PER_CALL = {
    llm: 0.01,
    image: 0.04,
    video: 0.50,
    voice: 0.03,
    music: 0.10,
    sfx: 0.02,
    ambient: 0.05,
    lipsync: 0.20,
    post: 0.08,
    model3d: 0.35,
    stock: 0.00,
};

// A capability with no entry would be silently free, and the guard would wave
// through exactly the flows it exists to stop. Fail at load rather than at run.
for (const capability of CAPABILITIES) {
    if (typeof COST_PER_CALL[capability] !== 'number') {
        throw new Error(`flow-cost: no cost estimate for capability '${capability}'`);
    }
}

/**
 * How many times each node will execute, accounting for fan-out.
 *
 * Fan-out MULTIPLIES along a path: two fan-outs in series is 3x2 = 6, not 3+2.
 * Getting that wrong under-reports precisely the case the guard is for.
 *
 * @returns {Map<string, number>} node id -> execution count
 */
function branchMultipliers(graph) {
    const nodes = (graph && graph.nodes) || [];
    const edges = (graph && graph.edges) || [];
    const byId = new Map(nodes.map(n => [n.id, n]));

    const incoming = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) {
        if (incoming.has(e.to)) incoming.get(e.to).push(e.from);
    }

    const counts = new Map();

    const resolve = (id, seen) => {
        if (counts.has(id)) return counts.get(id);
        if (seen.has(id)) return 1;             // cycle: validateGraph refuses it separately
        seen.add(id);

        const sources = incoming.get(id) || [];
        // A node runs once per branch reaching it. Where several inputs
        // converge, the widest one governs — a collector waits for all of them
        // rather than running once per source.
        let inherited = 1;
        for (const src of sources) {
            inherited = Math.max(inherited, resolve(src, seen));
        }

        const node = byId.get(id);
        const isFanout = node && node.type === 'tf.fanout';
        const factor = isFanout ? Math.max(1, Number((node.config || {}).count) || 1) : 1;

        const total = inherited * factor;
        counts.set(id, total);
        return total;
    };

    for (const n of nodes) resolve(n.id, new Set());
    return counts;
}

/**
 * Projected cost of running a graph once.
 *
 * @returns {{ total: number, calls: number, byCapability: object }}
 */
function projectedCost(graph) {
    const multipliers = branchMultipliers(graph);
    const byCapability = {};
    let total = 0;
    let calls = 0;

    for (const node of (graph && graph.nodes) || []) {
        const def = nodeType(node.type);
        const capability = def && def.capability;
        if (!capability) continue;              // inputs, transforms and outputs call no provider

        const runs = multipliers.get(node.id) || 1;
        const cost = (COST_PER_CALL[capability] || 0) * runs;

        byCapability[capability] = (byCapability[capability] || 0) + cost;
        total += cost;
        calls += runs;
    }

    return { total, calls, byCapability };
}

/**
 * Where a projected run leaves a project against its budget.
 *
 * A project with no budget_total set is UNLIMITED, not zero: an unset budget
 * must never become an accidental ceiling that blocks every run.
 */
function budgetStatus(db, projectId, projected) {
    const project = projectId
        ? db.prepare('SELECT budget_total FROM film_projects WHERE id = ?').get(projectId)
        : null;

    const limit = Number((project && project.budget_total) || 0);
    const spentRow = projectId
        ? db.prepare('SELECT COALESCE(SUM(amount), 0) AS spent FROM film_cost_entries WHERE project_id = ?').get(projectId)
        : { spent: 0 };
    const spent = Number((spentRow && spentRow.spent) || 0);

    const wouldExceed = limit > 0 && (spent + projected) > limit;

    return {
        limit,
        spent,
        projected,
        remaining: limit > 0 ? limit - spent : Infinity,
        wouldExceed,
    };
}

module.exports = { COST_PER_CALL, projectedCost, branchMultipliers, budgetStatus };
