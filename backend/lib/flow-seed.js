/**
 * The built-in flow: the existing 9-step shot pipeline, as rows.
 *
 * DERIVED from PIPELINE_STEPS rather than transcribed beside it. That is the
 * whole point of the phase: if the seed were a hand-written copy, it would
 * agree with the pipeline on the day it was written and drift silently
 * afterwards, and the equivalence test would be asserting that two constants
 * were typed consistently rather than that the graph reproduces the engine.
 *
 * Derivation also means the built-in flow inherits future steps for free — add
 * one to PIPELINE_STEPS and it appears here, wired to its dependencies, with
 * the lockstep test still holding.
 *
 * Seeding is idempotent and runs at startup after ensureSchema().
 */

const { PIPELINE_STEPS } = require('./pipeline-engine');
const { nodeTypeForStep, nodeType } = require('./flow-node-types');

// Stable, human-readable ids. Not UUIDs: the built-in flow is referenced by
// name in seeds, tests and docs, and a regenerated id would orphan all of them.
const BUILTIN_FLOW_IDS = {
    SHOT_PIPELINE: 'builtin-shot-pipeline',
};

// Laid out left-to-right in dependency depth, so the canvas opens on something
// readable rather than a pile of overlapping nodes at the origin.
const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 130;

/** Longest path from a root to each step — its column on the canvas. */
function depthByStep() {
    const byId = new Map(PIPELINE_STEPS.map(s => [s.id, s]));
    const depth = new Map();

    const resolve = (id, guard) => {
        if (depth.has(id)) return depth.get(id);
        if (guard.has(id)) return 0;                  // defensive: PIPELINE_STEPS is acyclic
        guard.add(id);

        const step = byId.get(id);
        const deps = (step && step.depends) || [];
        const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(d => resolve(d, guard)));

        depth.set(id, value);
        return value;
    };

    for (const step of PIPELINE_STEPS) resolve(step.id, new Set());
    return depth;
}

/**
 * PIPELINE_STEPS -> { nodes, edges }.
 *
 * Node ids are the step ids, which is what lets the lockstep test compare
 * frontiers directly against getNextSteps without a translation table.
 */
function pipelineStepsAsGraph() {
    const depth = depthByStep();
    const rowCursor = new Map();

    const nodes = PIPELINE_STEPS.map(step => {
        const column = depth.get(step.id) || 0;
        const row = rowCursor.get(column) || 0;
        rowCursor.set(column, row + 1);

        const type = nodeTypeForStep(step.id);

        return {
            id: step.id,
            type,
            label: step.name,
            config: { step: step.id, scope: step.scope, handler: step.handler },
            x: 80 + column * COLUMN_WIDTH,
            y: 80 + row * ROW_HEIGHT,
        };
    });

    // A dependency becomes an edge on the first port pair the two node types can
    // legally share. Hard-coding port names here would re-introduce exactly the
    // transcription this module exists to avoid.
    const edges = [];
    for (const step of PIPELINE_STEPS) {
        for (const dep of step.depends) {
            const fromType = nodeType(nodeTypeForStep(dep));
            const toType = nodeType(nodeTypeForStep(step.id));
            const shared = fromType && toType
                ? fromType.outputs.find(out => toType.inputs.includes(out))
                : null;

            edges.push({
                id: `${dep}->${step.id}`,
                from: dep,
                fromPort: shared || (fromType && fromType.outputs[0]) || 'any',
                to: step.id,
                toPort: shared || (toType && toType.inputs[0]) || 'any',
            });
        }
    }

    return { nodes, edges };
}

/**
 * Write the built-in flow if it is absent, refresh it if PIPELINE_STEPS has
 * changed underneath it. Safe to call on every boot.
 *
 * The built-in flow is immutable from the API (is_builtin = 1, and the routes
 * refuse to edit or delete it); the UI offers duplicate-to-edit instead. That
 * keeps the equivalence guarantee true permanently rather than until someone
 * edits the row.
 */
function seedBuiltinFlows(db) {
    const graph = pipelineStepsAsGraph();
    const flowId = BUILTIN_FLOW_IDS.SHOT_PIPELINE;

    const existing = db.prepare('SELECT id FROM film_flows WHERE id = ?').get(flowId);

    const write = db.transaction(() => {
        if (!existing) {
            db.prepare(
                `INSERT INTO film_flows (id, project_id, owner, name, description, is_builtin, version)
                 VALUES (?, NULL, '', ?, ?, 1, 1)`
            ).run(
                flowId,
                'Shot Pipeline (built-in)',
                'The standard 9-step shot pipeline, derived from PIPELINE_STEPS. Duplicate it to edit.'
            );
        } else {
            // Rewrite the topology so a new pipeline step reaches the built-in
            // flow without a migration.
            db.prepare('DELETE FROM film_flow_edges WHERE flow_id = ?').run(flowId);
            db.prepare('DELETE FROM film_flow_nodes WHERE flow_id = ?').run(flowId);
        }

        const insertNode = db.prepare(
            `INSERT INTO film_flow_nodes (id, flow_id, node_type, label, config, position_x, position_y)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const node of graph.nodes) {
            insertNode.run(`${flowId}:${node.id}`, flowId, node.type, node.label, JSON.stringify(node.config), node.x, node.y);
        }

        const insertEdge = db.prepare(
            `INSERT INTO film_flow_edges (id, flow_id, from_node, from_port, to_node, to_port)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const edge of graph.edges) {
            insertEdge.run(
                `${flowId}:${edge.id}`, flowId,
                `${flowId}:${edge.from}`, edge.fromPort,
                `${flowId}:${edge.to}`, edge.toPort
            );
        }
    });

    write();
    return { flowId, nodes: graph.nodes.length, edges: graph.edges.length, created: !existing };
}

module.exports = { seedBuiltinFlows, pipelineStepsAsGraph, BUILTIN_FLOW_IDS };
