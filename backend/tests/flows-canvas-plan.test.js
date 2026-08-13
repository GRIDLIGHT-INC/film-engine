/**
 * Set-based conformance test for the Flows canvas implementation plan.
 *
 * An architecture plan fails in two ways that prose review does not catch:
 *   1. it leaves part of the set undesigned — a node with no executor binding,
 *      a capability with no handler — and reads as complete because the gap is
 *      an absence, not a wrong statement;
 *   2. it cites files, capabilities, or ports that do not exist, so the first
 *      implementer discovers the plan was never checked against the tree.
 *
 * So this test iterates the sets rather than sampling them: every node in the
 * taxonomy must have exactly one binding, every binding's port contract must
 * agree with the taxonomy it claims to implement, every module the plan marks
 * `existing` must actually be on disk, and every migration must be numbered
 * above what db/migrations/ already contains.
 *
 * The plan is docs/plans/flows-canvas-implementation-plan.md; its machine-
 * readable half is docs/plans/flows-canvas-interfaces.json.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { CAPABILITIES } = require('../lib/providers/base');
const { PIPELINE_STEPS } = require('../lib/pipeline-engine');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PLAN_MD = path.join(REPO_ROOT, 'docs', 'plans', 'flows-canvas-implementation-plan.md');
const IFACE_PATH = path.join(REPO_ROOT, 'docs', 'plans', 'flows-canvas-interfaces.json');
const TAXONOMY_PATH = path.join(REPO_ROOT, 'docs', 'plans', 'flows-canvas-node-taxonomy.json');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

const load = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const iface = () => load(IFACE_PATH);
const taxonomy = () => load(TAXONOMY_PATH);

// ── The plan exists at all ──────────────────────────────────────────────

test('plan document and interface manifest both exist', () => {
    assert.ok(fs.existsSync(PLAN_MD), 'implementation plan markdown is missing');
    const m = iface();
    assert.ok(Array.isArray(m.modules), 'manifest must declare modules');
    assert.ok(Array.isArray(m.bindings), 'manifest must declare bindings');
    assert.ok(Array.isArray(m.migrations), 'manifest must declare migrations');
    assert.ok(Array.isArray(m.routes), 'manifest must declare routes');
    assert.ok(Array.isArray(m.phases), 'manifest must declare phases');
});

// ── Binding coverage: the primary set ───────────────────────────────────

test('every taxonomy node has exactly one executor binding', () => {
    const nodes = taxonomy().nodes.map(n => n.id);
    const bindings = iface().bindings;

    const byNode = new Map();
    for (const b of bindings) {
        if (!byNode.has(b.node)) byNode.set(b.node, []);
        byNode.get(b.node).push(b);
    }

    const missing = nodes.filter(id => !byNode.has(id));
    assert.deepStrictEqual(missing, [], `nodes with no binding: ${missing.join(', ')}`);

    const dupes = [...byNode.entries()].filter(([, bs]) => bs.length > 1).map(([id]) => id);
    assert.deepStrictEqual(dupes, [], `nodes bound more than once: ${dupes.join(', ')}`);
});

test('no binding references a node outside the taxonomy', () => {
    const known = new Set(taxonomy().nodes.map(n => n.id));
    const orphans = iface().bindings.filter(b => !known.has(b.node)).map(b => b.node);
    assert.deepStrictEqual(orphans, [], `bindings for unknown nodes: ${orphans.join(', ')}`);
});

// ── The two documents must not drift apart ──────────────────────────────

test('binding port contracts match the taxonomy they implement', () => {
    const byId = new Map(taxonomy().nodes.map(n => [n.id, n]));
    const drift = [];
    for (const b of iface().bindings) {
        const node = byId.get(b.node);
        if (!node) continue;
        const same = (a, c) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(c || [])].sort());
        if (!same(b.inputs, node.inputs)) drift.push(`${b.node} inputs ${JSON.stringify(b.inputs)} != taxonomy ${JSON.stringify(node.inputs)}`);
        if (!same(b.outputs, node.outputs)) drift.push(`${b.node} outputs ${JSON.stringify(b.outputs)} != taxonomy ${JSON.stringify(node.outputs)}`);
        const bCap = b.capability ? [b.capability] : [];
        if (!same(bCap, node.capabilities)) drift.push(`${b.node} capability ${JSON.stringify(bCap)} != taxonomy ${JSON.stringify(node.capabilities)}`);
    }
    assert.deepStrictEqual(drift, [], drift.join('\n'));
});

test('every port type used by a binding is a declared port type', () => {
    const known = new Set(taxonomy().port_types);
    const bad = [];
    for (const b of iface().bindings) {
        for (const p of [...(b.inputs || []), ...(b.outputs || [])]) {
            if (!known.has(p)) bad.push(`${b.node}:${p}`);
        }
    }
    assert.deepStrictEqual(bad, [], `undeclared port types: ${bad.join(', ')}`);
});

test('every capability named by a binding is in the provider registry', () => {
    const known = new Set(CAPABILITIES);
    const bad = iface().bindings.filter(b => b.capability && !known.has(b.capability)).map(b => `${b.node}:${b.capability}`);
    assert.deepStrictEqual(bad, [], `unknown capabilities: ${bad.join(', ')}`);
});

test('every pipeline step is reachable through some binding', () => {
    const byId = new Map(taxonomy().nodes.map(n => [n.id, n]));
    const covered = new Set();
    for (const b of iface().bindings) {
        for (const s of (byId.get(b.node) || {}).pipeline_steps || []) covered.add(s);
    }
    const missing = PIPELINE_STEPS.map(s => s.id).filter(id => !covered.has(id));
    assert.deepStrictEqual(missing, [], `pipeline steps unreachable from any bound node: ${missing.join(', ')}`);
});

// ── The plan must be checked against the actual tree ────────────────────

test('every binding handler resolves to a declared module', () => {
    const declared = new Set(iface().modules.map(m => m.path));
    const bad = iface().bindings.filter(b => !declared.has(b.handler)).map(b => `${b.node} -> ${b.handler}`);
    assert.deepStrictEqual(bad, [], `handlers with no module declaration: ${bad.join(', ')}`);
});

test('every module the plan marks "existing" is actually on disk', () => {
    const missing = iface().modules
        .filter(m => m.status === 'existing')
        .filter(m => !fs.existsSync(path.join(REPO_ROOT, m.path)))
        .map(m => m.path);
    assert.deepStrictEqual(missing, [], `plan cites non-existent files as existing: ${missing.join(', ')}`);
});

test('every module the plan marks "new" does not already exist', () => {
    const clashes = iface().modules
        .filter(m => m.status === 'new')
        .filter(m => fs.existsSync(path.join(REPO_ROOT, m.path)))
        .map(m => m.path);
    assert.deepStrictEqual(clashes, [], `plan would create files that already exist: ${clashes.join(', ')}`);
});

test('module paths and statuses are well-formed and unique', () => {
    const STATUSES = new Set(['new', 'existing', 'modified']);
    const seen = new Set();
    const bad = [];
    for (const m of iface().modules) {
        if (seen.has(m.path)) bad.push(`duplicate module ${m.path}`);
        seen.add(m.path);
        if (!STATUSES.has(m.status)) bad.push(`${m.path} has unknown status '${m.status}'`);
        if (!Array.isArray(m.exports)) bad.push(`${m.path} declares no exports array`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('every module the plan marks "modified" is actually on disk', () => {
    const missing = iface().modules
        .filter(m => m.status === 'modified')
        .filter(m => !fs.existsSync(path.join(REPO_ROOT, m.path)))
        .map(m => m.path);
    assert.deepStrictEqual(missing, [], `plan would modify non-existent files: ${missing.join(', ')}`);
});

// ── Migrations must not collide with the existing numbering ─────────────

test('planned migrations are numbered above every applied migration', () => {
    const existing = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));
    const highest = Math.max(...existing.map(f => parseInt(f.slice(0, 3), 10)).filter(n => !Number.isNaN(n)));

    const bad = [];
    const seen = new Set();
    for (const mig of iface().migrations) {
        if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(mig.file)) bad.push(`${mig.file} does not match NNN_snake_case.sql`);
        if (existing.includes(mig.file)) bad.push(`${mig.file} already exists`);
        if (seen.has(mig.file)) bad.push(`${mig.file} declared twice`);
        seen.add(mig.file);
        const n = parseInt(mig.file.slice(0, 3), 10);
        if (!Number.isNaN(n) && n <= highest) bad.push(`${mig.file} number ${n} is not above the highest existing (${highest})`);
        if (!Array.isArray(mig.tables) || mig.tables.length === 0) bad.push(`${mig.file} declares no tables`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

// ── Routes must be well-formed and not collide with what is registered ──

test('planned routes are unique, /film-prefixed, and owned by a declared module', () => {
    const declared = new Set(iface().modules.map(m => m.path));
    const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
    const seen = new Set();
    const bad = [];
    for (const r of iface().routes) {
        const key = `${r.method} ${r.path}`;
        if (seen.has(key)) bad.push(`duplicate route ${key}`);
        seen.add(key);
        if (!METHODS.has(r.method)) bad.push(`${key} has unknown method`);
        if (!r.path.startsWith('/film/')) bad.push(`${key} is not under /film/`);
        if (!declared.has(r.module)) bad.push(`${key} owned by undeclared module ${r.module}`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('the flows route namespace is not already claimed in server.js', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const segments = new Set();
    for (const r of iface().routes) {
        const seg = r.path.split('/').filter(Boolean)[1]; // /film/<seg>/...
        if (seg && !seg.startsWith(':')) segments.add(seg);
    }
    // A new top-level segment must not already be dispatched; reused segments
    // (projects, shots) are expected and exempt.
    const RESERVED_OK = new Set(['projects', 'shots', 'scenes']);
    const clashes = [...segments]
        .filter(s => !RESERVED_OK.has(s))
        .filter(s => server.includes(`parts[1] === '${s}'`));
    assert.deepStrictEqual(clashes, [], `route segments already dispatched in server.js: ${clashes.join(', ')}`);
});

// ── Phases must be coherent ─────────────────────────────────────────────

test('every phase referenced by a module, migration, or route is declared', () => {
    const m = iface();
    const declared = new Set(m.phases.map(p => p.id));
    const bad = [];
    const check = (items, label) => {
        for (const it of items) {
            if (it.phase === undefined) bad.push(`${label} ${it.path || it.file || it.node} declares no phase`);
            else if (!declared.has(it.phase)) bad.push(`${label} ${it.path || it.file || it.node} references undeclared phase ${it.phase}`);
        }
    };
    check(m.modules, 'module');
    check(m.migrations, 'migration');
    check(m.routes.map(r => ({ ...r, path: `${r.method} ${r.path}` })), 'route');
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('phase ids are unique, ordered from 0, and each has a stated exit criterion', () => {
    const phases = iface().phases;
    const ids = phases.map(p => p.id);
    assert.deepStrictEqual(ids, [...new Set(ids)], 'phase ids are not unique');
    assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), 'phases are not in ascending order');
    assert.strictEqual(ids[0], 0, 'phases must start at 0 (the payload-builder fix)');
    const noExit = phases.filter(p => !p.exit_criterion).map(p => p.id);
    assert.deepStrictEqual(noExit, [], `phases with no exit criterion: ${noExit.join(', ')}`);
});
