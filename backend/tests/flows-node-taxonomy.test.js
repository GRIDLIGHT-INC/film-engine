/**
 * Set-based coverage test for the proposed Flows-style canvas node taxonomy.
 *
 * The taxonomy in docs/plans/flows-canvas-node-taxonomy.json is a research
 * artifact: it claims a node palette that covers everything Film Engine can
 * currently generate. That claim is only worth anything if it is checked
 * against the CODE rather than against the prose, and re-checked whenever a
 * capability or pipeline step is added.
 *
 * So this test iterates the real registries — CAPABILITIES from the provider
 * base and PIPELINE_STEPS from the pipeline engine — and fails if any member
 * is unmapped, or if the taxonomy references a capability/step that no longer
 * exists. An example-based test ("check that 'image' has a node") would pass on
 * a half-finished taxonomy, which is the exact failure this prevents.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { CAPABILITIES } = require('../lib/providers/base');
const { PIPELINE_STEPS } = require('../lib/pipeline-engine');

const TAXONOMY_PATH = path.join(__dirname, '..', '..', 'docs', 'plans', 'flows-canvas-node-taxonomy.json');

function loadTaxonomy() {
    const raw = fs.readFileSync(TAXONOMY_PATH, 'utf8');
    return JSON.parse(raw);
}

test('taxonomy file exists and parses', () => {
    const t = loadTaxonomy();
    assert.ok(Array.isArray(t.nodes), 'taxonomy must expose a nodes array');
    assert.ok(t.nodes.length > 0, 'taxonomy must define at least one node');
});

test('every provider capability maps to exactly one generator node', () => {
    const t = loadTaxonomy();
    const covered = new Map();          // capability -> [node ids]
    for (const node of t.nodes) {
        for (const cap of node.capabilities || []) {
            if (!covered.has(cap)) covered.set(cap, []);
            covered.get(cap).push(node.id);
        }
    }

    const missing = CAPABILITIES.filter(c => !covered.has(c));
    assert.deepStrictEqual(missing, [], `capabilities with no node: ${missing.join(', ')}`);

    const duplicated = [...covered.entries()].filter(([, ids]) => ids.length > 1);
    assert.deepStrictEqual(
        duplicated.map(([c]) => c), [],
        `capabilities claimed by more than one node: ${duplicated.map(([c, ids]) => `${c} -> ${ids}`).join('; ')}`
    );
});

test('taxonomy references no capability outside the provider registry', () => {
    const t = loadTaxonomy();
    const known = new Set(CAPABILITIES);
    const unknown = [];
    for (const node of t.nodes) {
        for (const cap of node.capabilities || []) {
            if (!known.has(cap)) unknown.push(`${node.id}:${cap}`);
        }
    }
    assert.deepStrictEqual(unknown, [], `unknown capabilities referenced: ${unknown.join(', ')}`);
});

test('every pipeline step maps to a node', () => {
    const t = loadTaxonomy();
    const covered = new Set();
    for (const node of t.nodes) {
        for (const step of node.pipeline_steps || []) covered.add(step);
    }

    const missing = PIPELINE_STEPS.map(s => s.id).filter(id => !covered.has(id));
    assert.deepStrictEqual(missing, [], `pipeline steps with no node: ${missing.join(', ')}`);
});

test('taxonomy references no pipeline step outside the engine', () => {
    const t = loadTaxonomy();
    const known = new Set(PIPELINE_STEPS.map(s => s.id));
    const unknown = [];
    for (const node of t.nodes) {
        for (const step of node.pipeline_steps || []) {
            if (!known.has(step)) unknown.push(`${node.id}:${step}`);
        }
    }
    assert.deepStrictEqual(unknown, [], `unknown pipeline steps referenced: ${unknown.join(', ')}`);
});

test('every node declares the fields the canvas executor needs', () => {
    const t = loadTaxonomy();
    const REQUIRED = ['id', 'label', 'kind', 'inputs', 'outputs'];
    const KINDS = new Set(['input', 'generator', 'transform', 'output']);
    const bad = [];
    for (const node of t.nodes) {
        for (const field of REQUIRED) {
            if (node[field] === undefined) bad.push(`${node.id || '<no id>'} missing ${field}`);
        }
        if (node.kind && !KINDS.has(node.kind)) bad.push(`${node.id} has unknown kind '${node.kind}'`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('node ids are unique', () => {
    const t = loadTaxonomy();
    const seen = new Set();
    const dupes = [];
    for (const node of t.nodes) {
        if (seen.has(node.id)) dupes.push(node.id);
        seen.add(node.id);
    }
    assert.deepStrictEqual(dupes, [], `duplicate node ids: ${dupes.join(', ')}`);
});

test('the declared set totals match the live registries', () => {
    const t = loadTaxonomy();
    assert.strictEqual(
        t.covers.capabilities, CAPABILITIES.length,
        `taxonomy claims ${t.covers.capabilities} capabilities, registry has ${CAPABILITIES.length}`
    );
    assert.strictEqual(
        t.covers.pipeline_steps, PIPELINE_STEPS.length,
        `taxonomy claims ${t.covers.pipeline_steps} steps, engine has ${PIPELINE_STEPS.length}`
    );
});
