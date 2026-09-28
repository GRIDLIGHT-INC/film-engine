/**
 * THE PRODUCTION GRAPH NODES EPIC, HELD TO ITSELF AND TO THE CODE.
 *
 *   ITS OWN SHAPE. Every section the format asks for; tasks that parse, are
 *   numbered consecutively and depend only on EARLIER tasks.
 *
 *   ITS FEATURES. The epic declares eight features (F1..F8) in its own table.
 *   Every one must be carried by at least one task, so a feature cannot be
 *   announced in the overview and silently dropped from the plan.
 *
 *   THE CODE. The graph draws a fixed set of node types and the impact report
 *   walks a fixed set of pipeline stages. Both are read from the source, and
 *   every member must be named by the epic's mapping — a node type added
 *   later, or a stage nobody placed, fails here rather than rendering grey.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EPIC = path.join(ROOT, 'docs/plans/production-graph-nodes-epic.md');
const doc = () => fs.readFileSync(EPIC, 'utf8');

const REQUIRED = ['Overview', 'Business Goals', 'Current State', 'Target State',
    'Constraints', 'Task Breakdown', 'Open Questions', 'Success Metrics'];

function section(name) {
    const m = doc().match(new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
    assert.ok(m, `no "${name}" section`);
    return m[1];
}

function tasks() {
    return [...doc().matchAll(/^\|\s*(PGN-(\d{3}))\s*\|([^|]*)\|([^|]*)\|\s*([SML])\s*\|([^|]*)\|/gm)]
        .map(m => ({ id: m[1], n: +m[2], title: m[3].trim(), description: m[4].trim(), deps: m[6].trim() }));
}

function depNumbers(deps) {
    if (/^none$/i.test(deps)) return [];
    return deps.split(',').map(s => s.trim()).map(part => {
        const one = part.match(/^PGN-(\d{3})$/);
        assert.ok(one, `unparseable dependency "${part}"`);
        return +one[1];
    });
}

test('the epic exists and carries every section the format asks for', () => {
    assert.ok(fs.existsSync(EPIC), 'docs/plans/production-graph-nodes-epic.md does not exist');
    const have = new Set([...doc().matchAll(/^## (.+)$/gm)].map(m => m[1].trim()));
    assert.deepEqual(REQUIRED.filter(s => !have.has(s)), []);
});

test('every task is well formed and consecutively numbered', () => {
    const all = tasks();
    assert.ok(all.length >= 16, `only ${all.length} tasks parsed`);
    all.forEach((t, i) => {
        assert.equal(t.n, i + 1, `${t.id} is out of sequence`);
        assert.ok(t.title.length > 3 && t.description.length > 60, `${t.id} is not described`);
    });
});

test('every dependency names an EARLIER task that exists', () => {
    for (const t of tasks()) {
        for (const d of depNumbers(t.deps)) assert.ok(d < t.n, `${t.id} depends on a task that is not earlier`);
    }
});

test('every declared feature (F1..F8) is carried by at least one task', () => {
    const declared = [...section('Overview').matchAll(/^\|\s*(F\d)\s*\|/gm)].map(m => m[1]);
    assert.equal(declared.length, 8, `the overview declares ${declared.length} features, not 8`);
    const text = tasks().map(t => t.description).join('\n');
    assert.deepEqual(declared.filter(f => !new RegExp(`\\(${f}\\)`).test(text)), []);
});

test('every node type the graph draws is placed on the out-of-date map (derived from the source)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'backend/lib/production-graph.js'), 'utf8');
    const types = [...new Set([...src.matchAll(/type: '([a-z]+)'/g)].map(m => m[1]))];
    assert.ok(types.length >= 5, `found only ${types.length} node types — the scan is broken`);
    const map = section('Target State') + section('Task Breakdown');
    assert.deepEqual(types.filter(t => !new RegExp('`' + t + '`').test(map)), []);
});

test('every pipeline stage the impact report walks is placed or excluded with a reason (derived from the source)', () => {
    const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
    const table = doc().match(/^### Stage to node\s*$([\s\S]*?)(?=^#{2,3} )/m);
    assert.ok(table, 'no "Stage to node" table');
    const rows = new Map([...table[1].matchAll(/^\|\s*`([a-z_]+)`\s*\|([^|]+)\|/gm)].map(m => [m[1], m[2].trim()]));
    const missing = PIPELINE_STEPS.map(s => s.id).filter(id => !rows.has(id) || rows.get(id).length < 8);
    assert.deepEqual(missing, []);
});

test('the hold is honoured by every batch entry point the epic names, and each exists', () => {
    const t = tasks().find(x => /Honour the hold/i.test(x.title));
    assert.ok(t, 'no task honours the hold across batch runs');
    const fns = [...t.description.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)\(\)`/g)].map(m => m[1]);
    assert.ok(fns.length >= 5, `the hold task names only ${fns.length} entry points`);
    const code = ['src/index.html', 'backend/routes/pipeline.js', 'backend/lib/run-plan.js',
        'backend/routes/storyboard.js', 'backend/routes/video-gen.js', 'backend/routes/music-gen.js', 'backend/routes/voice.js']
        .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    assert.deepEqual(fns.filter(f => !new RegExp(`function ${f}\\s*\\(`).test(code)), []);
});

test('every repo path the epic cites exists, except the files it proposes', () => {
    const PROPOSED = new Set(['backend/lib/generation-progress.js', 'backend/lib/graph-patterns.js',
        'backend/db/migrations/118_graph_hold.sql', 'backend/tests/production-graph-nodes.test.js']);
    const cited = [...new Set([...doc().matchAll(/`((?:backend|docs|src)\/[A-Za-z0-9_./-]+\.(?:js|md|sql|json|html))`/g)].map(m => m[1]))];
    assert.ok(cited.length >= 10, `only ${cited.length} paths cited`);
    assert.deepEqual(cited.filter(p => !PROPOSED.has(p) && !fs.existsSync(path.join(ROOT, p))), []);
});
