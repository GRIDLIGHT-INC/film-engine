/**
 * Pure graph algebra for flows.
 *
 * Same split as pipeline-engine.js vs routes/pipeline.js: the reasoning that is
 * worth testing exhaustively lives here, with no database and no HTTP, so a
 * graph can be validated by a route, by the executor, or by a unit test without
 * any of them needing the others.
 *
 * Graph shape:
 *   { nodes: [{ id, type, config?, x?, y? }],
 *     edges: [{ id?, from, fromPort, to, toPort }] }
 *
 * Cycle detection matters more here than anywhere else in the codebase. The
 * hard-coded PIPELINE_STEPS DAG was acyclic because a human checked it once;
 * a user-authored graph is acyclic only if something checks every time, and a
 * loop would otherwise hang the executor with no timeout to save it.
 */

const crypto = require('crypto');
const { nodeType, portsCompatible } = require('./flow-node-types');

// ── Helpers ─────────────────────────────────────────────────────────────

function nodesOf(graph) { return (graph && Array.isArray(graph.nodes)) ? graph.nodes : []; }
function edgesOf(graph) { return (graph && Array.isArray(graph.edges)) ? graph.edges : []; }

/** node id -> [ids it depends on] */
function dependencyMap(graph) {
    const deps = new Map(nodesOf(graph).map(n => [n.id, []]));
    for (const edge of edgesOf(graph)) {
        if (!deps.has(edge.to)) deps.set(edge.to, []);
        deps.get(edge.to).push(edge.from);
    }
    return deps;
}

// ── Cycles ──────────────────────────────────────────────────────────────

/**
 * Every cycle reachable in the graph, as arrays of node ids.
 *
 * Iterative depth-first search with an explicit stack: a user can paste a very
 * wide graph, and recursion would trade a hang for a stack overflow.
 */
function detectCycles(graph) {
    const adjacency = new Map(nodesOf(graph).map(n => [n.id, []]));
    for (const edge of edgesOf(graph)) {
        if (adjacency.has(edge.from)) adjacency.get(edge.from).push(edge.to);
    }

    const WHITE = 0, GREY = 1, BLACK = 2;
    const colour = new Map([...adjacency.keys()].map(id => [id, WHITE]));
    const cycles = [];
    const seen = new Set();

    for (const start of adjacency.keys()) {
        if (colour.get(start) !== WHITE) continue;

        const stack = [{ id: start, path: [start], next: 0 }];
        colour.set(start, GREY);

        while (stack.length) {
            const frame = stack[stack.length - 1];
            const neighbours = adjacency.get(frame.id) || [];

            if (frame.next >= neighbours.length) {
                colour.set(frame.id, BLACK);
                stack.pop();
                continue;
            }

            const nextId = neighbours[frame.next++];
            if (!adjacency.has(nextId)) continue;           // dangling edge: validateGraph reports it

            if (colour.get(nextId) === GREY) {
                const at = frame.path.indexOf(nextId);
                const cycle = at === -1 ? [nextId] : frame.path.slice(at);
                const key = [...cycle].sort().join('>');     // same loop, whichever node we entered from
                if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
                continue;
            }
            if (colour.get(nextId) === BLACK) continue;

            colour.set(nextId, GREY);
            stack.push({ id: nextId, path: [...frame.path, nextId], next: 0 });
        }
    }

    return cycles;
}

// ── Ordering ────────────────────────────────────────────────────────────

/**
 * Node ids in dependency-safe order (Kahn). Ties break on id so the order is
 * stable — an unstable order would make graphFingerprint unstable with it.
 *
 * @throws when the graph contains a cycle; call validateGraph first.
 */
function topoSort(graph) {
    const deps = dependencyMap(graph);
    const remaining = new Map([...deps].map(([id, list]) => [id, new Set(list)]));
    const order = [];

    while (remaining.size) {
        const ready = [...remaining.entries()]
            .filter(([, pending]) => pending.size === 0)
            .map(([id]) => id)
            .sort();

        if (ready.length === 0) {
            const cycles = detectCycles(graph);
            const detail = cycles.length ? cycles.map(c => c.join(' -> ')).join('; ') : [...remaining.keys()].join(', ');
            throw new Error(`cannot order a cyclic graph: ${detail}`);
        }

        for (const id of ready) {
            order.push(id);
            remaining.delete(id);
        }
        for (const pending of remaining.values()) {
            for (const id of ready) pending.delete(id);
        }
    }

    return order;
}

/**
 * Nodes whose dependencies are all completed or skipped.
 *
 * Mirrors pipeline-engine.getNextSteps so the seeded built-in flow walks
 * identically to PIPELINE_STEPS — the equivalence Phase 1 rests on. A skipped
 * dependency counts as satisfied, exactly as it does there: dropping voice for
 * a dialogue-free shot must not strand lipsync's other dependants.
 */
function nextNodes(graph, completedIds, skipIds) {
    const completed = new Set(completedIds || []);
    const skipped = new Set(skipIds || []);
    const deps = dependencyMap(graph);

    return nodesOf(graph).filter(node => {
        if (completed.has(node.id) || skipped.has(node.id)) return false;
        return (deps.get(node.id) || []).every(dep => completed.has(dep) || skipped.has(dep));
    });
}

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Structural validation. Returns every problem rather than the first, so the
 * canvas can highlight all of them at once instead of one per save.
 *
 * @returns {{ ok: boolean, errors: Array<{code, message, nodeId?, edgeId?}> }}
 */
function validateGraph(graph) {
    const errors = [];
    const nodes = nodesOf(graph);
    const edges = edgesOf(graph);

    const byId = new Map();
    for (const node of nodes) {
        if (!node || !node.id) {
            errors.push({ code: 'MISSING_NODE_ID', message: 'a node has no id' });
            continue;
        }
        if (byId.has(node.id)) {
            errors.push({ code: 'DUPLICATE_NODE_ID', nodeId: node.id, message: `duplicate node id '${node.id}'` });
            continue;
        }
        byId.set(node.id, node);

        if (!nodeType(node.type)) {
            errors.push({ code: 'UNKNOWN_NODE_TYPE', nodeId: node.id, message: `unknown node type '${node.type}'` });
        }
    }

    const claimedInputs = new Map();   // "node:port" -> edge that claimed it

    for (const edge of edges) {
        const label = edge.id || `${edge.from}.${edge.fromPort} -> ${edge.to}.${edge.toPort}`;

        const source = byId.get(edge.from);
        const target = byId.get(edge.to);
        if (!source || !target) {
            errors.push({ code: 'EDGE_UNKNOWN_NODE', edgeId: label, message: `edge references a node that does not exist: ${label}` });
            continue;
        }

        const sourceType = nodeType(source.type);
        const targetType = nodeType(target.type);
        if (!sourceType || !targetType) continue;   // already reported

        if (!sourceType.outputs.includes(edge.fromPort)) {
            errors.push({ code: 'UNKNOWN_PORT', edgeId: label, nodeId: source.id, message: `'${source.type}' has no output port '${edge.fromPort}'` });
            continue;
        }
        if (!targetType.inputs.includes(edge.toPort)) {
            errors.push({ code: 'UNKNOWN_PORT', edgeId: label, nodeId: target.id, message: `'${target.type}' has no input port '${edge.toPort}'` });
            continue;
        }

        if (!portsCompatible(edge.fromPort, edge.toPort)) {
            errors.push({ code: 'PORT_TYPE_MISMATCH', edgeId: label, message: `cannot connect ${edge.fromPort} to ${edge.toPort}` });
            continue;
        }

        // One value per input port — unless the port is declared a COLLECTOR.
        //
        // The plan originally wanted fan-in to be impossible everywhere, so the
        // executor could never face two values for one slot. The real pipeline
        // disagrees: music, sfx and ambient all converge on assembly's audio
        // input, because a final mix genuinely takes many sources. So arity is
        // explicit per port instead. A collector concatenates, which is not the
        // ambiguity the rule existed to prevent; every other port still carries
        // exactly one value and still refuses a second.
        const collects = (targetType.multiInputs || []).includes(edge.toPort);
        if (!collects) {
            const slot = `${edge.to}:${edge.toPort}`;
            if (claimedInputs.has(slot)) {
                errors.push({ code: 'PORT_FANIN', edgeId: label, nodeId: target.id, message: `input '${edge.toPort}' of '${edge.to}' already has a source` });
                continue;
            }
            claimedInputs.set(slot, label);
        }
    }

    for (const cycle of detectCycles(graph)) {
        errors.push({ code: 'CYCLE', message: `cycle: ${cycle.join(' -> ')}`, nodeId: cycle[0] });
    }

    return { ok: errors.length === 0, errors };
}

// ── Fingerprint ─────────────────────────────────────────────────────────

/**
 * Stable hash of a graph's meaning.
 *
 * Node/edge order and key order are normalised, and cosmetic fields (position,
 * label) are excluded: dragging a node must not invalidate a render ledger
 * entry, while rewiring an edge must.
 */
function graphFingerprint(graph) {
    const nodes = nodesOf(graph)
        .map(n => ({ id: n.id, type: n.type, config: n.config || {} }))
        .sort((a, b) => a.id.localeCompare(b.id));

    const edges = edgesOf(graph)
        .map(e => ({ from: e.from, fromPort: e.fromPort, to: e.to, toPort: e.toPort }))
        .sort((a, b) => `${a.from}${a.fromPort}${a.to}${a.toPort}`.localeCompare(`${b.from}${b.fromPort}${b.to}${b.toPort}`));

    const canonical = JSON.stringify({ nodes, edges }, (key, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return Object.keys(value).sort().reduce((acc, k) => { acc[k] = value[k]; return acc; }, {});
        }
        return value;
    });

    return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {    validateGraph, detectCycles, topoSort, nextNodes, graphFingerprint,};
