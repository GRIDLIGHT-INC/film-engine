/**
 * Phase 5 — built-in templates.
 *
 * "Choose from ready-made flows: multi-model video, image, character sheets,
 * and more — drop in your media and run."
 *
 * The plan's exit criterion: every declared template instantiates into a graph
 * passing validateGraph() with zero errors. Set-based over TEMPLATES, because a
 * broken template is only discovered when someone picks that one — and the
 * whole promise of a template shelf is that you do not have to check first.
 *
 * These ship AFTER the executor rather than alongside it, so they are written
 * against finished semantics (collector ports, fan-out branching, the budget
 * gate) instead of against an executor that then changes underneath them.
 */

const test = require('node:test');
const assert = require('node:assert');

const { TEMPLATES, instantiate, listTemplates } = require('../lib/flow-templates');
const { validateGraph } = require('../lib/flow-graph');
const { nodeType } = require('../lib/flow-node-types');
const { projectedCost } = require('../lib/flow-cost');

const CTX = { projectId: 'p-1', sceneId: 's-1', shotId: 'sh-1' };

test('there is a template shelf at all', () => {
    assert.ok(Object.keys(TEMPLATES).length >= 4, 'a shelf of fewer than four is not a shelf');
});

test('THE EXIT CRITERION: every template instantiates into a valid graph', () => {
    const broken = [];
    for (const id of Object.keys(TEMPLATES)) {
        const graph = instantiate(id, CTX);
        const result = validateGraph(graph);
        if (!result.ok) broken.push(`${id}: ${JSON.stringify(result.errors)}`);
    }
    assert.deepStrictEqual(broken, [], broken.join('\n'));
});

test('every template uses only node types that exist', () => {
    const bad = [];
    for (const id of Object.keys(TEMPLATES)) {
        for (const n of instantiate(id, CTX).nodes) {
            if (!nodeType(n.type)) bad.push(`${id}: unknown node type '${n.type}'`);
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('every template declares a name and a description', () => {
    const bad = Object.entries(TEMPLATES)
        .filter(([, t]) => !t.name || !t.description)
        .map(([id]) => id);
    assert.deepStrictEqual(bad, [], `templates missing name/description: ${bad.join(', ')}`);
});

test('every template produces something — no shelf item is a dead end', () => {
    // A template whose graph generates nothing and saves nothing would validate
    // cleanly and be useless, which is the failure a validity check misses.
    const inert = [];
    for (const id of Object.keys(TEMPLATES)) {
        const graph = instantiate(id, CTX);
        const generates = graph.nodes.some(n => (nodeType(n.type) || {}).capability);
        const outputs = graph.nodes.some(n => (nodeType(n.type) || {}).kind === 'output');
        if (!generates || !outputs) inert.push(`${id}: generates=${generates} outputs=${outputs}`);
    }
    assert.deepStrictEqual(inert, [], inert.join('; '));
});

test('every template is fully wired — no orphan nodes', () => {
    // An unconnected node on a ready-made flow is a template that was edited
    // and not re-checked.
    const orphans = [];
    for (const id of Object.keys(TEMPLATES)) {
        const g = instantiate(id, CTX);
        if (g.nodes.length < 2) continue;
        const connected = new Set(g.edges.flatMap(e => [e.from, e.to]));
        for (const n of g.nodes) {
            if (!connected.has(n.id)) orphans.push(`${id}: '${n.id}' is connected to nothing`);
        }
    }
    assert.deepStrictEqual(orphans, [], orphans.join('; '));
});

test('every template costs something knowable before it runs', () => {
    const bad = [];
    for (const id of Object.keys(TEMPLATES)) {
        const cost = projectedCost(instantiate(id, CTX));
        if (!(cost.total > 0) || !(cost.calls > 0)) bad.push(`${id}: ${JSON.stringify(cost)}`);
    }
    assert.deepStrictEqual(bad, [], `templates the budget guard cannot price: ${bad.join('; ')}`);
});

test('instantiating twice gives identical graphs', () => {
    for (const id of Object.keys(TEMPLATES)) {
        assert.deepStrictEqual(instantiate(id, CTX), instantiate(id, CTX), `${id} is not deterministic`);
    }
});

test('an unknown template id is refused', () => {
    assert.throws(() => instantiate('no-such-template', CTX), /template/i);
});

test('listTemplates describes the shelf without instantiating it', () => {
    const list = listTemplates();
    assert.strictEqual(list.length, Object.keys(TEMPLATES).length);
    for (const t of list) {
        assert.ok(t.id && t.name && t.description, JSON.stringify(t));
        assert.ok(typeof t.node_count === 'number' && t.node_count > 0, `${t.id} reports no nodes`);
    }
});

// ── The specific flows the product promises ────────────────────────────

test('the shelf covers what the product advertises', () => {
    // multi-model video, image, character sheets — named in the pitch.
    const ids = Object.keys(TEMPLATES);
    for (const expected of ['multi-model-video', 'character-sheet', 'prompt-to-image']) {
        assert.ok(ids.includes(expected), `the shelf is missing '${expected}': ${ids.join(', ')}`);
    }
});

test('multi-model video actually uses more than one provider', () => {
    // "Multi-model" is the claim; a template that fans out onto one provider
    // would satisfy a shape check and miss the point entirely.
    const g = instantiate('multi-model-video', CTX);
    const providers = new Set(
        g.nodes.map(n => (n.config || {}).provider).filter(Boolean)
    );
    const fanout = g.nodes.find(n => n.type === 'tf.fanout');
    const fanProviders = fanout ? ((fanout.config || {}).providers || []) : [];

    assert.ok(providers.size > 1 || fanProviders.length > 1,
        `multi-model-video names ${providers.size} provider(s) and ${fanProviders.length} fan-out provider(s)`);
});

test('character sheet fans out across views', () => {
    const g = instantiate('character-sheet', CTX);
    const fanout = g.nodes.find(n => n.type === 'tf.fanout');
    assert.ok(fanout, 'character-sheet does not fan out, so it produces one view, not a sheet');
    assert.ok(Number((fanout.config || {}).count) >= 3, 'a character sheet needs at least three views');
});

test('templates carrying a fan-out are priced with it', () => {
    const g = instantiate('character-sheet', CTX);
    const fanout = g.nodes.find(n => n.type === 'tf.fanout');
    const n = Number((fanout.config || {}).count);
    const cost = projectedCost(g);
    assert.ok(cost.calls >= n, `fan-out of ${n} projected only ${cost.calls} call(s) — the guard would under-count`);
});
