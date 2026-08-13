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

    recordRun(runId, graph, context, options, 'running', '');

    const outputs = {};        // nodeId -> { port: {type, value} }
    const completed = [];
    const skipped = [];
    const failed = [];
    const nodeResults = [];

    const totalNodes = (graph.nodes || []).length;

    for (let guard = 0; guard <= totalNodes; guard++) {
        if (options.isCancelled && options.isCancelled()) {
            setRunStatus(runId, 'cancelled', '');
            return { id: runId, status: 'cancelled', nodes: nodeResults };
        }

        // A failed node's dependants must not run, so treat failures as a
        // barrier rather than as satisfied.
        const frontier = nextNodes(graph, [...completed, ...skipped], []).filter(n => !failed.includes(n.id));
        const runnable = frontier.filter(n => !dependsOnAny(graph, n.id, failed));
        if (runnable.length === 0) break;

        for (const node of runnable) {
            if (context.onNodeStart) context.onNodeStart(node.id, node);
            startNodeRun(runId, node);

            const inputs = resolveNodeInputs(graph, node.id, outputs);
            const result = await executeNode(node, inputs, { ...context, runId });

            nodeResults.push({ id: node.id, type: node.type, ...result });

            if (!result.ok) {
                failed.push(node.id);
                finishNodeRun(runId, node.id, 'failed', {}, result);
                if (context.onNodeDone) context.onNodeDone(node.id, result);
                continue;
            }

            outputs[node.id] = result.outputs || {};

            if (result.skipped) {
                skipped.push(node.id);
                finishNodeRun(runId, node.id, 'skipped', result.outputs, result);
            } else {
                completed.push(node.id);
                finishNodeRun(runId, node.id, 'complete', result.outputs, result);
            }

            const done = completed.length + skipped.length + failed.length;
            setProgress(runId, totalNodes ? (done / totalNodes) * 100 : 100);
            if (context.onNodeDone) context.onNodeDone(node.id, result);
        }
    }

    const status = failed.length ? 'failed' : 'complete';
    setRunStatus(runId, status, failed.length ? `${failed.length} node(s) failed` : '');

    return { id: runId, status, nodes: nodeResults, completed, skipped, failed };
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

function startNodeRun(runId, node) {
    db.prepare(
        `INSERT OR REPLACE INTO film_flow_node_runs (id, run_id, node_id, node_type, status, started_at)
         VALUES (?, ?, ?, ?, 'running', datetime('now'))`
    ).run(`${runId}:${node.id}`, runId, node.id, node.type);
}

function finishNodeRun(runId, nodeId, status, outputs, result) {
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
        `${runId}:${nodeId}`
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
