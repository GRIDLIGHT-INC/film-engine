/**
 * Completeness check for the Phase 0 test specification.
 *
 * The QA deliverable for Phase 0 is a test matrix, and a test matrix fails the
 * same way a plan does: by being silently partial. Six acceptance criteria
 * written for `image` and four for `ambient` reads as thorough right up until
 * the capability nobody wrote cases for is the one that breaks.
 *
 * So this iterates the orchestrator's own dispatch table — STEP_CAPABILITY in
 * routes/pipeline.js, recovered from source because the route does not export
 * it — and requires the matrix to be rectangular: every capability × every
 * acceptance criterion, no holes. It also cross-checks the matrix against
 * PIPELINE_STEPS so a capability cannot claim a scope or a step the engine
 * disagrees with.
 *
 * This test passes once the spec is complete. The RED suite that proves Phase 0
 * itself is unimplemented is phase0-payload-parity.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
const { CAPABILITIES } = require('../lib/providers/base');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MATRIX_PATH = path.join(REPO_ROOT, 'docs', 'plans', 'phase0-test-matrix.json');
const SPEC_MD = path.join(REPO_ROOT, 'docs', 'plans', 'phase0-acceptance-criteria.md');
const PIPELINE_SRC = path.join(__dirname, '..', 'routes', 'pipeline.js');

const matrix = () => JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));

/**
 * Recover STEP_CAPABILITY from routes/pipeline.js source.
 *
 * The route does not export it, and hard-coding a copy here would defeat the
 * purpose: the set has to come from the code so that adding a step to the
 * dispatch table breaks this test until the matrix grows to match.
 */
function stepCapabilityFromSource() {
    const src = fs.readFileSync(PIPELINE_SRC, 'utf8');
    const block = src.match(/const STEP_CAPABILITY\s*=\s*\{([\s\S]*?)\};/);
    assert.ok(block, 'could not locate STEP_CAPABILITY in routes/pipeline.js');
    const map = {};
    for (const m of block[1].matchAll(/(\w+)\s*:\s*'([a-z0-9]+)'/g)) map[m[1]] = m[2];
    assert.ok(Object.keys(map).length > 0, 'STEP_CAPABILITY parsed empty');
    return map;
}

test('spec document and test matrix both exist', () => {
    assert.ok(fs.existsSync(SPEC_MD), 'acceptance criteria markdown is missing');
    const m = matrix();
    assert.ok(Array.isArray(m.acceptance_criteria), 'matrix must declare acceptance_criteria');
    assert.ok(Array.isArray(m.capabilities), 'matrix must declare capabilities');
    assert.ok(Array.isArray(m.global_cases), 'matrix must declare global_cases');
});

test('the matrix covers every capability the orchestrator dispatches', () => {
    const dispatched = new Set(Object.values(stepCapabilityFromSource()));
    const covered = new Set(matrix().capabilities.map(c => c.capability));

    const missing = [...dispatched].filter(c => !covered.has(c));
    assert.deepStrictEqual(missing, [], `orchestrated capabilities with no test cases: ${missing.join(', ')}`);
});

test('the matrix invents no capability outside the provider registry', () => {
    const known = new Set(CAPABILITIES);
    const bogus = matrix().capabilities.map(c => c.capability).filter(c => !known.has(c));
    assert.deepStrictEqual(bogus, [], `unknown capabilities in matrix: ${bogus.join(', ')}`);
});

test('the matrix is rectangular: every capability has a case for every acceptance criterion', () => {
    const m = matrix();
    const acIds = m.acceptance_criteria.map(a => a.id);
    const holes = [];
    for (const cap of m.capabilities) {
        const present = new Set((cap.cases || []).map(c => c.ac));
        for (const ac of acIds) {
            if (!present.has(ac)) holes.push(`${cap.capability} has no ${ac} case`);
        }
    }
    assert.deepStrictEqual(holes, [], holes.join('; '));
});

test('no case cites an undeclared acceptance criterion', () => {
    const m = matrix();
    const acIds = new Set(m.acceptance_criteria.map(a => a.id));
    const bad = [];
    for (const cap of m.capabilities) {
        for (const c of cap.cases || []) {
            if (!acIds.has(c.ac)) bad.push(`${c.id} cites unknown ${c.ac}`);
        }
    }
    for (const c of m.global_cases) {
        if (!acIds.has(c.ac)) bad.push(`${c.id} cites unknown ${c.ac}`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('every case states scenario, inputs, expected, and what failure means', () => {
    const m = matrix();
    const REQUIRED = ['id', 'ac', 'scenario', 'inputs', 'expected', 'failure_means'];
    const bad = [];
    const all = [...m.capabilities.flatMap(c => c.cases || []), ...m.global_cases];
    for (const c of all) {
        for (const f of REQUIRED) {
            if (!c[f] || String(c[f]).trim() === '') bad.push(`${c.id || '<no id>'} missing ${f}`);
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('case ids are unique across the whole matrix', () => {
    const m = matrix();
    const all = [...m.capabilities.flatMap(c => c.cases || []), ...m.global_cases];
    const seen = new Set();
    const dupes = [];
    for (const c of all) {
        if (seen.has(c.id)) dupes.push(c.id);
        seen.add(c.id);
    }
    assert.deepStrictEqual(dupes, [], `duplicate case ids: ${dupes.join(', ')}`);
});

test('each capability declares the step and scope the pipeline engine agrees with', () => {
    const byStep = new Map(PIPELINE_STEPS.map(s => [s.id, s]));
    const stepCap = stepCapabilityFromSource();
    const bad = [];
    for (const cap of matrix().capabilities) {
        const step = byStep.get(cap.step);
        if (!step) { bad.push(`${cap.capability} cites unknown step '${cap.step}'`); continue; }
        if (stepCap[cap.step] !== cap.capability) {
            bad.push(`${cap.capability} claims step '${cap.step}' but STEP_CAPABILITY maps it to '${stepCap[cap.step]}'`);
        }
        if (step.scope !== cap.scope) {
            bad.push(`${cap.capability} declares scope '${cap.scope}' but PIPELINE_STEPS says '${step.scope}'`);
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('each capability declares a non-empty required-key list and a real builder module', () => {
    const bad = [];
    for (const cap of matrix().capabilities) {
        if (!Array.isArray(cap.required_keys) || cap.required_keys.length === 0) {
            bad.push(`${cap.capability} declares no required payload keys`);
        }
        if (!cap.builder_module) {
            bad.push(`${cap.capability} names no builder module`);
        } else if (cap.builder_module !== 'inline' && !fs.existsSync(path.join(REPO_ROOT, cap.builder_module))) {
            bad.push(`${cap.capability} names builder module ${cap.builder_module}, which does not exist`);
        }
        if (!['one', 'many'].includes(cap.cardinality)) {
            bad.push(`${cap.capability} has unknown cardinality '${cap.cardinality}'`);
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('every capability has at least one error-path case', () => {
    const missing = matrix().capabilities
        .filter(c => !(c.cases || []).some(x => x.kind === 'error'))
        .map(c => c.capability);
    assert.deepStrictEqual(missing, [], `capabilities with no error-path case: ${missing.join(', ')}`);
});

test('the two known defects each have a dedicated global case', () => {
    const ids = new Set(matrix().global_cases.map(c => c.id));
    const required = ['global.stub-payload-gone', 'global.storyboard-uses-provider-registry'];
    const missing = required.filter(r => !ids.has(r));
    assert.deepStrictEqual(missing, [], `no case pinned for: ${missing.join(', ')}`);
});
