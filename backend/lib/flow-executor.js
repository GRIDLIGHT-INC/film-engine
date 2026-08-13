/**
 * Flow execution.
 *
 * This is the generalisation of routes/pipeline.js:executeStep. The shape is
 * deliberately the same — capability in, provider result out — and the one real
 * change is that inputs ARRIVE AS AN ARGUMENT instead of being re-read from the
 * database. That is what an edge carrying a value means in practice.
 *
 * Lives in lib/ rather than routes/ for the same reason pipeline-engine.js
 * does: a flow can then be run from a route, a batch job, or a test with no
 * HTTP anywhere in sight.
 */

const { db, generateId } = require('../db/database');
const { validateGraph, nextNodes, graphFingerprint } = require('./flow-graph');
const { nodeType } = require('./flow-node-types');
const handlers = require('./node-handlers');
const { projectedCost, budgetStatus } = require('./flow-cost');
const { branchMultipliers } = require('./flow-cost');

/**
 * Gather the values feeding a node's input ports.
 *
 * A collector port yields an ARRAY of every incoming value; a single-value port
 * yields the value itself. The distinction is declared on the node type, so a
 * handler never has to guess which shape it is holding.
 */
function resolveNodeInputs(graph, nodeId, outputsSoFar) {
    const node = (graph.nodes || []).find(n => n.id === nodeId);
    const def = node ? nodeType(node.type) : null;
    const collectors = new Set((def && def.multiInputs) || []);

    const inputs = {};
    for (const edge of graph.edges || []) {
        if (edge.to !== nodeId) continue;

        const upstream = outputsSoFar[edge.from];
        if (!upstream) continue;
        const value = upstream[edge.fromPort];
        if (value === undefined) continue;

        if (collectors.has(edge.toPort)) {
            if (!inputs[edge.toPort]) inputs[edge.toPort] = [];
            inputs[edge.toPort].push(value);
        } else {
            inputs[edge.toPort] = value;
        }
    }
    return inputs;
}

/**
 * Run one node.
 *
 * Never throws: a handler that blows up becomes { ok: false }, because one bad
 * node must not take down a run that could still record what happened.
 */
async function executeNode(node, inputs, ctx) {
    const handler = handlers.handlerFor(node.type);
    if (!handler) {
        return { ok: false, error: `no handler registered for node type '${node.type}'` };
    }
    try {
        const result = await handler.execute(node, inputs || {}, ctx || {});
        if (!result || typeof result.ok !== 'boolean') {
            return { ok: false, error: `handler for '${node.type}' returned no verdict` };
        }
        return result;
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Execute a whole graph.
 *
 * Validation happens BEFORE anything runs — a cycle would otherwise spin the
 * frontier loop forever, and the user would be billed for whatever generated
 * before it hung.
 *
 * @returns {{ id, status, nodes, errors? }}
 */
async function runFlow(graph, ctx, opts) {
    const options = opts || {};
    const runId = options.runId || generateId();
    const context = ctx || {};

    const validation = validateGraph(graph);
    if (!validation.ok) {
        recordRun(runId, graph, context, options, 'failed', 'graph is invalid');
        return { id: runId, status: 'failed', nodes: [], errors: validation.errors };
    }

    // THE BUDGET GATE. Before anything generates, not after: a fan-out of 4
    // across a feature is hundreds of calls, and a ceiling you discover on the
    // ledger afterwards is not a ceiling. Overridable, explicitly, because a
    // wrong estimate must not make the feature unusable.
    const projectId = (context.scene && context.scene.project_id) || (context.project && context.project.id) || null;
    const cost = projectedCost(graph);
    const budget = projectId ? budgetStatus(db, projectId, cost.total) : { wouldExceed: false };

    if (budget.wouldExceed && !options.ignoreBudget) {
        const message = `budget: this run projects $${cost.total.toFixed(2)} across ${cost.calls} generation call(s); ` +
            `$${budget.spent.toFixed(2)} of the $${budget.limit.toFixed(2)} limit is already spent`;
        recordRun(runId, graph, context, options, 'failed', message);
        return {
            id: runId,
            status: 'failed',
            nodes: [],
            errors: [{ code: 'BUDGET_EXCEEDED', message }],
            budget: { ...budget, projected: cost.total, calls: cost.calls },
        };
    }

    recordRun(runId, graph, context, options, 'running', '');

    // How many times each node runs, given the fan-outs upstream of it.
    const multipliers = branchMultipliers(graph);

    // Per (node, branch) outputs. An unbranched node stores under branch ''.
    const outputs = {};                 // nodeId -> { branchKey -> { port: value } }
    const branchRows = new Map();       // branchKey -> row id
    const completed = [];
    const skipped = [];
    const failed = [];
    const nodeResults = [];
    let paused = false;

    const totalNodes = (graph.nodes || []).length;

    for (let guard = 0; guard <= totalNodes; guard++) {
        if (options.isCancelled && options.isCancelled()) {
            setRunStatus(runId, 'cancelled', '');
            return { id: runId, status: 'cancelled', nodes: nodeResults };
        }

        const frontier = nextNodes(graph, [...completed, ...skipped], []).filter(n => !failed.includes(n.id));
        const runnable = frontier.filter(n => !dependsOnAny(graph, n.id, failed));
        if (runnable.length === 0) break;

        for (const node of runnable) {
            // The branches this node must run across, derived from upstream
            // fan-out rather than from anything the node itself declares.
            const branches = branchesFor(graph, node, outputs, multipliers, runId, branchRows);
            let nodeFailed = false;
            let nodePaused = false;

            for (const branch of branches) {
                if (context.onNodeStart) context.onNodeStart(node.id, node, branch.key);
                startNodeRun(runId, node, branch);

                const inputs = resolveNodeInputs(graph, node.id, projectOutputs(outputs, branch.key));
                const result = await executeNode(node, inputs, { ...context, runId, branch: branch.key, variant: branch.variant });

                nodeResults.push({ id: node.id, type: node.type, branch: branch.key, ...result });

                if (!result.ok) {
                    nodeFailed = true;
                    finishNodeRun(runId, node.id, branch, 'failed', {}, result);
                    if (context.onNodeDone) context.onNodeDone(node.id, result);
                    continue;
                }

                // A select gate with more than one branch waits for a human.
                if (result.awaitSelection) {
                    nodePaused = true;
                    finishNodeRun(runId, node.id, branch, 'pending', result.outputs, result);
                    continue;
                }

                if (!outputs[node.id]) outputs[node.id] = {};
                outputs[node.id][branch.key] = result.outputs || {};

                // A fan-out node declares the branches its dependants run across.
                if (result.branchKeys) {
                    outputs[node.id].__branches = result.branchKeys;
                    for (const b of result.branchKeys) recordBranch(runId, b, node.id, branchRows);
                }

                finishNodeRun(runId, node.id, branch, result.skipped ? 'skipped' : 'complete', result.outputs, result);
                if (context.onNodeDone) context.onNodeDone(node.id, result);
            }

            if (nodeFailed) { failed.push(node.id); continue; }
            if (nodePaused) { paused = true; skipped.push(node.id); continue; }

            if (branches.some(b => b.skipped)) skipped.push(node.id); else completed.push(node.id);

            const done = completed.length + skipped.length + failed.length;
            setProgress(runId, totalNodes ? (done / totalNodes) * 100 : 100);
        }

        if (paused) break;
    }

    const status = failed.length ? 'failed' : (paused ? 'paused' : 'complete');
    setRunStatus(runId, status, failed.length ? `${failed.length} node(s) failed` : '');

    return {
        id: runId, status, nodes: nodeResults, completed, skipped, failed,
        budget: { ...budget, projected: cost.total, calls: cost.calls },
    };
}

/**
 * The branches a node executes across.
 *
 * Derived from the widest upstream fan-out, so a node never has to know whether
 * it is being fanned — the executor decides and hands it one branch at a time.
 */
function branchesFor(graph, node, outputs, multipliers, runId, branchRows) {
    const upstream = (graph.edges || []).filter(e => e.to === node.id).map(e => e.from);

    let keys = [''];
    for (const src of upstream) {
        const declared = outputs[src] && outputs[src].__branches;
        if (declared && declared.length > keys.length) keys = declared;
        else if (outputs[src]) {
            const seen = Object.keys(outputs[src]).filter(k => k !== '__branches');
            if (seen.length > keys.length) keys = seen;
        }
    }

    // A fan-out node itself always runs once; it PRODUCES branches.
    if (node.type === 'tf.fanout') keys = keys.length > 1 ? keys : [''];

    return keys.map(key => ({ key, variant: {}, skipped: false }));
}

/** Outputs as the resolver expects them, for one branch (falling back to the unbranched value). */
function projectOutputs(outputs, branchKey) {
    const flat = {};
    for (const [nodeId, byBranch] of Object.entries(outputs)) {
        const value = byBranch[branchKey] !== undefined ? byBranch[branchKey] : byBranch[''];
        if (value !== undefined) flat[nodeId] = value;
    }
    return flat;
}

function recordBranch(runId, branchKey, originNodeId, branchRows) {
    if (branchRows.has(branchKey)) return branchRows.get(branchKey);
    const id = generateId();
    db.prepare(
        `INSERT OR IGNORE INTO film_flow_branches (id, run_id, origin_node_id, branch_key, variant_config)
         VALUES (?, ?, ?, ?, '{}')`
    ).run(id, runId, originNodeId, branchKey);
    const row = db.prepare('SELECT id FROM film_flow_branches WHERE run_id = ? AND branch_key = ?').get(runId, branchKey);
    branchRows.set(branchKey, row ? row.id : id);
    return branchRows.get(branchKey);
}

/** True when nodeId transitively depends on any of `ids`. */
function dependsOnAny(graph, nodeId, ids) {
    if (!ids.length) return false;
    const blocked = new Set(ids);
    let changed = true;

    while (changed) {
        changed = false;
        for (const edge of graph.edges || []) {
            if (blocked.has(edge.from) && !blocked.has(edge.to)) {
                blocked.add(edge.to);
                changed = true;
            }
        }
    }
    return blocked.has(nodeId) && !ids.includes(nodeId) ? true : blocked.has(nodeId) && ids.includes(nodeId);
}

// ── Persistence ─────────────────────────────────────────────────────────

function recordRun(runId, graph, ctx, opts, status, error) {
    db.prepare(
        `INSERT OR REPLACE INTO film_flow_runs
         (id, flow_id, project_id, scene_id, shot_id, graph_snapshot, graph_fingerprint, status, error_message, params, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
        runId,
        opts.flowId || '',
        (ctx.scene && ctx.scene.project_id) || (ctx.project && ctx.project.id) || null,
        (ctx.scene && ctx.scene.id) || null,
        (ctx.shot && ctx.shot.id) || null,
        JSON.stringify(graph || {}),
        graphFingerprint(graph || {}),
        status,
        error || '',
        JSON.stringify(opts.params || {})
    );
}

function setRunStatus(runId, status, error) {
    db.prepare(
        `UPDATE film_flow_runs SET status = ?, error_message = ?, completed_at = datetime('now') WHERE id = ?`
    ).run(status, error || '', runId);
}

function setProgress(runId, pct) {
    db.prepare('UPDATE film_flow_runs SET progress_pct = ? WHERE id = ?').run(pct, runId);
}

function branchRowId(runId, branchKey) {
    if (!branchKey) return null;
    const row = db.prepare('SELECT id FROM film_flow_branches WHERE run_id = ? AND branch_key = ?').get(runId, branchKey);
    return row ? row.id : null;
}

function startNodeRun(runId, node, branch) {
    const key = (branch && branch.key) || '';
    db.prepare(
        `INSERT OR REPLACE INTO film_flow_node_runs (id, run_id, node_id, node_type, branch_id, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))`
    ).run(`${runId}:${node.id}:${key}`, runId, node.id, node.type, branchRowId(runId, key));
}

function finishNodeRun(runId, nodeId, branch, status, outputs, result) {
    const key = (branch && branch.key) || '';
    db.prepare(
        `UPDATE film_flow_node_runs
         SET status = ?, outputs = ?, provider_id = ?, error = ?, routing_note = ?, completed_at = datetime('now')
         WHERE id = ?`
    ).run(
        status,
        JSON.stringify(outputs || {}),
        (result && result.providerId) || '',
        (result && result.error) || '',
        (result && result.routingNote) || '',
        `${runId}:${nodeId}:${key}`
    );
}

function cancelFlowRun(runId) {
    setRunStatus(runId, 'cancelled', 'cancelled by request');
    return { id: runId, status: 'cancelled' };
}

function getFlowRun(runId) {
    const run = db.prepare('SELECT * FROM film_flow_runs WHERE id = ?').get(runId);
    if (!run) return null;
    const nodes = db.prepare('SELECT * FROM film_flow_node_runs WHERE run_id = ? ORDER BY started_at, node_id').all(runId);
    return { ...run, nodes };
}

module.exports = {
    runFlow, executeNode, resolveNodeInputs, cancelFlowRun, getFlowRun,
};
