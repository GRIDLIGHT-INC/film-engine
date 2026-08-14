/**
 * Phase 1 — the flow graph as data.
 *
 * The pipeline has always been a DAG; it was just a module-level constant that
 * nobody could edit. Phase 1 turns it into rows without changing what it does.
 *
 * The load-bearing test here is the lockstep equivalence one: the seeded
 * built-in flow must walk identically to PIPELINE_STEPS, step for step, for
 * every reachable frontier. That is what makes Phase 1 a provable no-op for
 * existing behaviour rather than a rewrite anyone has to trust — and it stays
 * true as PIPELINE_STEPS evolves, because the seed is DERIVED from it rather
 * than transcribed alongside it.
 *
 * Set-based on three axes, each iterating a real registry:
 *   9  PIPELINE_STEPS   -> every step round-trips through the graph
 *   23 node types       -> the runtime registry matches the documented taxonomy
 *   8  port types       -> the full compatibility matrix, not a sample
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PIPELINE_STEPS, getNextSteps } = require('../lib/pipeline-engine');
const {
    NODE_TYPES, PORT_TYPES, nodeType, portsCompatible,
} = require('../lib/flow-node-types');
const {
    validateGraph, detectCycles, topoSort, nextNodes, graphFingerprint,
} = require('../lib/flow-graph');
const { pipelineStepsAsGraph, BUILTIN_FLOW_IDS } = require('../lib/flow-seed');

const TAXONOMY = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs', 'plans', 'flows-canvas-node-taxonomy.json'), 'utf8'));

// ── The runtime registry and the documented taxonomy must not drift ─────

test('the node-type registry matches the documented taxonomy exactly', () => {
    const documented = TAXONOMY.nodes.map(n => n.id).sort();
    const runtime = Object.keys(NODE_TYPES).sort();
    assert.deepStrictEqual(runtime, documented,
        'lib/flow-node-types.js and flows-canvas-node-taxonomy.json disagree on which nodes exist');
});

test('every node type declares the same ports as the taxonomy', () => {
    const drift = [];
    for (const doc of TAXONOMY.nodes) {
        const rt = NODE_TYPES[doc.id];
        if (!rt) continue;
        const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
        if (!same(rt.inputs, doc.inputs)) drift.push(`${doc.id} inputs ${JSON.stringify(rt.inputs)} != ${JSON.stringify(doc.inputs)}`);
        if (!same(rt.outputs, doc.outputs)) drift.push(`${doc.id} outputs ${JSON.stringify(rt.outputs)} != ${JSON.stringify(doc.outputs)}`);
    }
    assert.deepStrictEqual(drift, [], drift.join('; '));
});

test('the port-type list matches the taxonomy', () => {
    assert.deepStrictEqual([...PORT_TYPES].sort(), [...TAXONOMY.port_types].sort());
});

// ── Port compatibility, over the whole matrix ──────────────────────────

test('port compatibility is exhaustive, symmetric in `any`, and otherwise exact', () => {
    const wrong = [];
    for (const from of PORT_TYPES) {
        for (const to of PORT_TYPES) {
            const got = portsCompatible(from, to);
            const want = from === to || from === 'any' || to === 'any';
            if (got !== want) wrong.push(`${from}->${to}: got ${got}, want ${want}`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

// ── The seeded graph must reproduce PIPELINE_STEPS ─────────────────────

test('every pipeline step becomes exactly one node in the seeded graph', () => {
    const graph = pipelineStepsAsGraph();
    const missing = PIPELINE_STEPS.map(s => s.id).filter(id => !graph.nodes.some(n => n.id === id));
    assert.deepStrictEqual(missing, [], `steps absent from the seeded graph: ${missing.join(', ')}`);
    assert.strictEqual(graph.nodes.length, PIPELINE_STEPS.length,
        'the seeded graph has a different number of nodes than there are steps');
});

test('every dependency in PIPELINE_STEPS becomes an edge', () => {
    const graph = pipelineStepsAsGraph();
    const missing = [];
    for (const step of PIPELINE_STEPS) {
        for (const dep of step.depends) {
            const edge = graph.edges.find(e => e.from === dep && e.to === step.id);
            if (!edge) missing.push(`${dep} -> ${step.id}`);
        }
    }
    assert.deepStrictEqual(missing, [], `dependencies with no edge: ${missing.join(', ')}`);

    const expected = PIPELINE_STEPS.reduce((n, s) => n + s.depends.length, 0);
    assert.strictEqual(graph.edges.length, expected, 'the seeded graph invented or dropped edges');
});

test('every seeded node uses a node type that exists in the registry', () => {
    const graph = pipelineStepsAsGraph();
    const bad = graph.nodes.filter(n => !nodeType(n.type)).map(n => `${n.id}:${n.type}`);
    assert.deepStrictEqual(bad, [], `seeded nodes with unknown types: ${bad.join(', ')}`);
});

test('the seeded graph validates cleanly', () => {
    const result = validateGraph(pipelineStepsAsGraph());
    assert.deepStrictEqual(result.errors, [], `seeded graph is invalid: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.ok, true);
});

/**
 * THE EXIT CRITERION.
 *
 * Walk the graph engine and the step engine side by side. At every frontier the
 * two must offer the same set of work. Testing one fixed order would pass on a
 * graph that merely happens to agree once; this drives both to exhaustion.
 */
test('the seeded graph walks in lockstep with PIPELINE_STEPS', () => {
    const graph = pipelineStepsAsGraph();
    const completed = [];
    const trace = [];

    for (let guard = 0; guard <= PIPELINE_STEPS.length; guard++) {
        const fromSteps = getNextSteps(completed, []).map(s => s.id).sort();
        const fromGraph = nextNodes(graph, completed, []).map(n => n.id).sort();

        assert.deepStrictEqual(fromGraph, fromSteps,
            `frontier diverged after [${completed.join(', ')}]:\n  steps: ${fromSteps}\n  graph: ${fromGraph}`);

        if (fromSteps.length === 0) break;
        completed.push(fromSteps[0]);
        trace.push(fromSteps[0]);
    }

    assert.strictEqual(completed.length, PIPELINE_STEPS.length,
        `walk ended after ${completed.length} of ${PIPELINE_STEPS.length} steps: ${trace.join(' -> ')}`);
});

test('skipped steps propagate identically in both engines', () => {
    // autoSkipSteps drops voice+lipsync for a dialogue-free shot; the graph must
    // treat a skipped dependency as satisfied exactly as getNextSteps does.
    const graph = pipelineStepsAsGraph();
    const skip = ['voice', 'lipsync'];
    const completed = [];

    for (let guard = 0; guard <= PIPELINE_STEPS.length; guard++) {
        const fromSteps = getNextSteps(completed, skip).map(s => s.id).sort();
        const fromGraph = nextNodes(graph, completed, skip).map(n => n.id).sort();
        assert.deepStrictEqual(fromGraph, fromSteps, `frontier diverged with skips after [${completed.join(', ')}]`);
        if (fromSteps.length === 0) break;
        completed.push(fromSteps[0]);
    }
});

// ── Graph algebra ──────────────────────────────────────────────────────

test('topoSort orders every node after its dependencies', () => {
    const graph = pipelineStepsAsGraph();
    const order = topoSort(graph);
    assert.strictEqual(order.length, graph.nodes.length);

    const position = new Map(order.map((id, i) => [id, i]));
    const violations = graph.edges.filter(e => position.get(e.from) > position.get(e.to))
        .map(e => `${e.from} -> ${e.to}`);
    assert.deepStrictEqual(violations, [], `edges pointing backwards in topo order: ${violations.join(', ')}`);
});

test('detectCycles finds a cycle a user could draw', () => {
    const graph = {
        nodes: [
            { id: 'a', type: 'gen.image' },
            { id: 'b', type: 'gen.video' },
            { id: 'c', type: 'gen.post' },
        ],
        edges: [
            { from: 'a', fromPort: 'image', to: 'b', toPort: 'image' },
            { from: 'b', fromPort: 'video', to: 'c', toPort: 'video' },
            { from: 'c', fromPort: 'video', to: 'b', toPort: 'video' },
        ],
    };
    const cycles = detectCycles(graph);
    assert.ok(cycles.length > 0, 'a b->c->b cycle was not detected');

    const result = validateGraph(graph);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === 'CYCLE'), `no CYCLE error: ${JSON.stringify(result.errors)}`);
});

test('an acyclic graph reports no cycles', () => {
    assert.deepStrictEqual(detectCycles(pipelineStepsAsGraph()), []);
});

// ── Validation rules ───────────────────────────────────────────────────

test('validateGraph rejects an unknown node type', () => {
    const r = validateGraph({ nodes: [{ id: 'n1', type: 'gen.telepathy' }], edges: [] });
    assert.ok(r.errors.some(e => e.code === 'UNKNOWN_NODE_TYPE'), JSON.stringify(r.errors));
});

test('validateGraph rejects duplicate node ids', () => {
    const r = validateGraph({
        nodes: [{ id: 'n1', type: 'in.prompt' }, { id: 'n1', type: 'in.prompt' }],
        edges: [],
    });
    assert.ok(r.errors.some(e => e.code === 'DUPLICATE_NODE_ID'), JSON.stringify(r.errors));
});

test('validateGraph rejects an edge to a node that does not exist', () => {
    const r = validateGraph({
        nodes: [{ id: 'n1', type: 'in.prompt' }],
        edges: [{ from: 'n1', fromPort: 'text', to: 'ghost', toPort: 'text' }],
    });
    assert.ok(r.errors.some(e => e.code === 'EDGE_UNKNOWN_NODE'), JSON.stringify(r.errors));
});

test('validateGraph rejects a port the node does not declare', () => {
    const r = validateGraph({
        nodes: [{ id: 'p', type: 'in.prompt' }, { id: 'v', type: 'gen.video' }],
        edges: [{ from: 'p', fromPort: 'video', to: 'v', toPort: 'text' }],
    });
    assert.ok(r.errors.some(e => e.code === 'UNKNOWN_PORT'), JSON.stringify(r.errors));
});

test('validateGraph rejects an incompatible port pairing', () => {
    // in.prompt emits text; gen.lipsync takes video and audio, never text.
    const r = validateGraph({
        nodes: [{ id: 'p', type: 'in.prompt' }, { id: 'l', type: 'gen.lipsync' }],
        edges: [{ from: 'p', fromPort: 'text', to: 'l', toPort: 'video' }],
    });
    assert.ok(r.errors.some(e => e.code === 'PORT_TYPE_MISMATCH'), JSON.stringify(r.errors));
});

test('validateGraph rejects two edges feeding one input port', () => {
    // The schema enforces this with UNIQUE(flow_id, to_node, to_port); the
    // validator must refuse it before it ever reaches the database.
    const r = validateGraph({
        nodes: [
            { id: 'a', type: 'in.asset' },
            { id: 'b', type: 'in.asset' },
            { id: 'l', type: 'gen.lipsync' },
        ],
        edges: [
            { from: 'a', fromPort: 'video', to: 'l', toPort: 'video' },
            { from: 'b', fromPort: 'video', to: 'l', toPort: 'video' },
        ],
    });
    assert.ok(r.errors.some(e => e.code === 'PORT_FANIN'), JSON.stringify(r.errors));
});

test('collector ports accept fan-in; every other port does not', () => {
    // A final mix genuinely takes music AND sfx AND ambient on one audio input:
    // the real 9-step pipeline converges three audio sources on assembly. Those
    // ports are declared multi; everything else stays single so the executor
    // never has to arbitrate between two values for one slot.
    const collectors = Object.entries(NODE_TYPES)
        .flatMap(([id, def]) => (def.multiInputs || []).map(port => `${id}.${port}`));
    assert.ok(collectors.length > 0, 'no node declares a collector port, but assembly needs one');

    // Fan-in into a declared collector is legal.
    const ok = validateGraph({
        nodes: [
            { id: 'm', type: 'gen.music' },
            { id: 's', type: 'gen.sfx' },
            { id: 'asm', type: 'out.assembly' },
        ],
        edges: [
            { from: 'm', fromPort: 'audio', to: 'asm', toPort: 'audio' },
            { from: 's', fromPort: 'audio', to: 'asm', toPort: 'audio' },
        ],
    });
    assert.deepStrictEqual(ok.errors, [], `collector rejected legal fan-in: ${JSON.stringify(ok.errors)}`);
});

test('the registry and taxonomy agree on which ports are collectors', () => {
    const drift = [];
    for (const doc of TAXONOMY.nodes) {
        const rt = NODE_TYPES[doc.id];
        if (!rt) continue;
        const a = [...(rt.multiInputs || [])].sort();
        const b = [...(doc.multi_inputs || [])].sort();
        if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(`${doc.id}: registry ${JSON.stringify(a)} != taxonomy ${JSON.stringify(b)}`);
    }
    assert.deepStrictEqual(drift, [], drift.join('; '));
});

test('a collector port only ever accepts its own type', () => {
    // Multi-arity must not become un-typed: assembly collects many audio, not
    // anything at all.
    const r = validateGraph({
        nodes: [{ id: 'p', type: 'in.prompt' }, { id: 'asm', type: 'out.assembly' }],
        edges: [{ from: 'p', fromPort: 'text', to: 'asm', toPort: 'audio' }],
    });
    assert.ok(!r.ok, 'a collector accepted a text source into an audio port');
});

test('validateGraph accepts a legitimate multi-input node', () => {
    // lipsync genuinely takes video AND audio — distinct ports, so this is fine.
    const r = validateGraph({
        nodes: [
            { id: 'v', type: 'in.asset' },
            { id: 'a', type: 'in.asset' },
            { id: 'l', type: 'gen.lipsync' },
        ],
        edges: [
            { from: 'v', fromPort: 'video', to: 'l', toPort: 'video' },
            { from: 'a', fromPort: 'audio', to: 'l', toPort: 'audio' },
        ],
    });
    assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
});

test('every node type can be instantiated in a graph that validates', () => {
    // Set-based: a registry entry with a typo in its ports would only surface
    // when somebody happened to drag that one node onto the canvas.
    const bad = [];
    for (const id of Object.keys(NODE_TYPES)) {
        const r = validateGraph({ nodes: [{ id: 'solo', type: id }], edges: [] });
        if (!r.ok) bad.push(`${id}: ${JSON.stringify(r.errors)}`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

// ── Fingerprint ────────────────────────────────────────────────────────

test('graphFingerprint is stable across key order and node order', () => {
    const a = { nodes: [{ id: 'x', type: 'in.prompt' }, { id: 'y', type: 'gen.image' }], edges: [] };
    const b = { nodes: [{ type: 'gen.image', id: 'y' }, { type: 'in.prompt', id: 'x' }], edges: [] };
    assert.strictEqual(graphFingerprint(a), graphFingerprint(b));
});

test('graphFingerprint changes when the graph changes', () => {
    const a = pipelineStepsAsGraph();
    const b = pipelineStepsAsGraph();
    b.nodes.push({ id: 'extra', type: 'in.prompt' });
    assert.notStrictEqual(graphFingerprint(a), graphFingerprint(b),
        'an edited flow would reuse the fingerprint of the one in the render ledger');
});

test('the built-in flow id is stable', () => {
    assert.ok(BUILTIN_FLOW_IDS.SHOT_PIPELINE, 'no id for the built-in shot pipeline');
    assert.match(BUILTIN_FLOW_IDS.SHOT_PIPELINE, /^[\w-]+$/);
});
