/**
 * Phase 1 routes, against a real database.
 *
 * flow-graph.test.js proves the algebra; this proves the graph survives a
 * round trip through SQLite and the HTTP layer — node ids are namespaced per
 * flow on disk, so "does what I saved come back as what I saved" is a real
 * question, not a formality.
 *
 * Also pins the two decisions that shape the feature: built-in flows are
 * immutable (which is what keeps the PIPELINE_STEPS equivalence permanent), and
 * library flows (project_id IS NULL) are visible from every project — the
 * "save it once, reuse it across every project" claim.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-flows-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { seedBuiltinFlows, BUILTIN_FLOW_IDS, pipelineStepsAsGraph } = require('../lib/flow-seed');
const { handleFlows, loadGraph } = require('../routes/flows');
const { PIPELINE_STEPS } = require('../lib/pipeline-engine');

// ── Minimal http shims ─────────────────────────────────────────────────

function fakeRes() {
    return {
        statusCode: null, body: null, headers: null,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        end(payload) { try { this.body = JSON.parse(payload); } catch (_) { this.body = payload; } },
    };
}

function call(method, urlPath, body) {
    const parts = urlPath.split('?')[0].split('/').filter(Boolean);
    const req = { method, body };
    const res = fakeRes();
    handleFlows(req, res, parts, {});
    return res;
}

// ── Fixture ────────────────────────────────────────────────────────────

const PROJECT_A = generateId();
const PROJECT_B = generateId();

test('setup: projects and the built-in flow', () => {
    for (const [id, title] of [[PROJECT_A, 'Project A'], [PROJECT_B, 'Project B']]) {
        db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(id, title);
    }
    const seeded = seedBuiltinFlows(db);
    assert.strictEqual(seeded.nodes, PIPELINE_STEPS.length);
    assert.ok(seeded.edges > 0);
});

// ── The built-in flow ──────────────────────────────────────────────────

test('the seeded built-in flow round-trips out of the database intact', () => {
    const stored = loadGraph(BUILTIN_FLOW_IDS.SHOT_PIPELINE);
    const derived = pipelineStepsAsGraph();

    assert.ok(stored, 'the built-in flow was not seeded');
    assert.deepStrictEqual(
        stored.nodes.map(n => n.id).sort(),
        derived.nodes.map(n => n.id).sort(),
        'node ids did not survive the database round trip'
    );
    assert.deepStrictEqual(
        stored.edges.map(e => `${e.from}.${e.fromPort}->${e.to}.${e.toPort}`).sort(),
        derived.edges.map(e => `${e.from}.${e.fromPort}->${e.to}.${e.toPort}`).sort(),
        'edges did not survive the database round trip'
    );
});

test('seeding twice is idempotent', () => {
    const before = loadGraph(BUILTIN_FLOW_IDS.SHOT_PIPELINE);
    seedBuiltinFlows(db);
    const after = loadGraph(BUILTIN_FLOW_IDS.SHOT_PIPELINE);
    assert.strictEqual(after.nodes.length, before.nodes.length);
    assert.strictEqual(after.fingerprint, before.fingerprint, 're-seeding changed the graph');
});

test('the built-in flow is visible from every project', () => {
    for (const projectId of [PROJECT_A, PROJECT_B]) {
        const res = call('GET', `/film/projects/${projectId}/flows`);
        assert.strictEqual(res.statusCode, 200);
        const builtin = res.body.flows.find(f => f.id === BUILTIN_FLOW_IDS.SHOT_PIPELINE);
        assert.ok(builtin, `built-in flow not listed for ${projectId}`);
        assert.strictEqual(builtin.scope, 'library');
        assert.strictEqual(builtin.node_count, PIPELINE_STEPS.length);
    }
});

test('the built-in flow cannot be edited or deleted', () => {
    const put = call('PUT', `/film/flows/${BUILTIN_FLOW_IDS.SHOT_PIPELINE}`, { nodes: [], edges: [] });
    assert.strictEqual(put.statusCode, 409, 'a built-in flow accepted an edit');
    assert.match(put.body.error, /built-in/i);

    const del = call('DELETE', `/film/flows/${BUILTIN_FLOW_IDS.SHOT_PIPELINE}`);
    assert.strictEqual(del.statusCode, 409, 'a built-in flow accepted a delete');

    // And it is genuinely still there afterwards.
    assert.strictEqual(loadGraph(BUILTIN_FLOW_IDS.SHOT_PIPELINE).nodes.length, PIPELINE_STEPS.length);
});

// ── CRUD ───────────────────────────────────────────────────────────────

const SIMPLE_FLOW = {
    name: 'Prompt to video',
    nodes: [
        { id: 'p', type: 'in.prompt', label: 'Idea', config: { text: 'a warehouse at night' }, x: 40, y: 40 },
        { id: 'img', type: 'gen.image', label: 'Keyframe', x: 300, y: 40 },
        { id: 'vid', type: 'gen.video', label: 'Clip', x: 560, y: 40 },
        { id: 'save', type: 'out.asset', label: 'Save', x: 820, y: 40 },
    ],
    edges: [
        { from: 'p', fromPort: 'text', to: 'img', toPort: 'text' },
        { from: 'img', fromPort: 'image', to: 'vid', toPort: 'image' },
        { from: 'vid', fromPort: 'video', to: 'save', toPort: 'video' },
    ],
};

let createdId = null;

test('a flow can be created and read back exactly', () => {
    const res = call('POST', `/film/projects/${PROJECT_A}/flows`, SIMPLE_FLOW);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    createdId = res.body.id;

    const got = call('GET', `/film/flows/${createdId}`);
    assert.strictEqual(got.statusCode, 200);
    assert.strictEqual(got.body.name, SIMPLE_FLOW.name);
    assert.strictEqual(got.body.nodes.length, 4);
    assert.strictEqual(got.body.edges.length, 3);

    // Short node ids, not the on-disk namespaced form.
    assert.deepStrictEqual(got.body.nodes.map(n => n.id).sort(), ['img', 'p', 'save', 'vid']);
    // Config and position survive.
    const prompt = got.body.nodes.find(n => n.id === 'p');
    assert.strictEqual(prompt.config.text, 'a warehouse at night');
    assert.strictEqual(prompt.x, 40);
});

test('an invalid graph is refused with per-error detail', () => {
    const res = call('POST', `/film/projects/${PROJECT_A}/flows`, {
        name: 'Broken',
        nodes: [{ id: 'p', type: 'in.prompt' }, { id: 'l', type: 'gen.lipsync' }],
        edges: [{ from: 'p', fromPort: 'text', to: 'l', toPort: 'video' }],
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.errors.some(e => e.code === 'PORT_TYPE_MISMATCH'), JSON.stringify(res.body));
});

test('a flow requires a name', () => {
    const res = call('POST', `/film/projects/${PROJECT_A}/flows`, { nodes: [], edges: [] });
    assert.strictEqual(res.statusCode, 400);
});

test('updating a flow replaces the graph and bumps the version', () => {
    const before = call('GET', `/film/flows/${createdId}`).body;

    const res = call('PUT', `/film/flows/${createdId}`, {
        name: 'Prompt to video (v2)',
        nodes: SIMPLE_FLOW.nodes.slice(0, 2),
        edges: [SIMPLE_FLOW.edges[0]],
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.version, before.version + 1);
    assert.strictEqual(res.body.nodes.length, 2);
    assert.strictEqual(res.body.edges.length, 1);
    assert.notStrictEqual(res.body.fingerprint, before.fingerprint, 'fingerprint did not change with the graph');
});

test('project scoping: a project flow is invisible to other projects', () => {
    const inA = call('GET', `/film/projects/${PROJECT_A}/flows`).body.flows.map(f => f.id);
    const inB = call('GET', `/film/projects/${PROJECT_B}/flows`).body.flows.map(f => f.id);
    assert.ok(inA.includes(createdId), 'project A cannot see its own flow');
    assert.ok(!inB.includes(createdId), 'project B can see project A\'s flow');
});

test('a library flow is visible from every project', () => {
    const res = call('POST', `/film/projects/${PROJECT_A}/flows`, { ...SIMPLE_FLOW, name: 'Shared', scope: 'library' });
    assert.strictEqual(res.statusCode, 201);
    const libId = res.body.id;

    for (const projectId of [PROJECT_A, PROJECT_B]) {
        const ids = call('GET', `/film/projects/${projectId}/flows`).body.flows.map(f => f.id);
        assert.ok(ids.includes(libId), `library flow not visible from ${projectId}`);
    }
});

test('validate checks a graph without saving it', () => {
    const res = call('POST', `/film/flows/${createdId}/validate`, {
        nodes: [{ id: 'a', type: 'gen.image' }, { id: 'b', type: 'gen.video' }],
        edges: [
            { from: 'a', fromPort: 'image', to: 'b', toPort: 'image' },
            { from: 'b', fromPort: 'video', to: 'a', toPort: 'image' },   // cycle
        ],
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, false);
    assert.ok(res.body.errors.some(e => e.code === 'CYCLE'), JSON.stringify(res.body.errors));

    // The stored flow is untouched.
    assert.strictEqual(call('GET', `/film/flows/${createdId}`).body.nodes.length, 2);
});

test('validate with no body validates the stored flow', () => {
    const res = call('POST', `/film/flows/${createdId}/validate`, {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true, JSON.stringify(res.body.errors));
});

test('a flow can be deleted, and its nodes and edges go with it', () => {
    const res = call('DELETE', `/film/flows/${createdId}`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(call('GET', `/film/flows/${createdId}`).statusCode, 404);

    const orphanNodes = db.prepare('SELECT COUNT(*) AS n FROM film_flow_nodes WHERE flow_id = ?').get(createdId).n;
    const orphanEdges = db.prepare('SELECT COUNT(*) AS n FROM film_flow_edges WHERE flow_id = ?').get(createdId).n;
    assert.strictEqual(orphanNodes, 0, 'nodes outlived their flow');
    assert.strictEqual(orphanEdges, 0, 'edges outlived their flow');
});

test('unknown ids are rejected or 404, never 500', () => {
    assert.strictEqual(call('GET', '/film/flows/does-not-exist').statusCode, 404);
    assert.strictEqual(call('GET', '/film/flows/../../etc/passwd').statusCode, 400);
    assert.strictEqual(call('GET', '/film/projects/not-a-uuid/flows').statusCode, 400);
});

test('cleanup', () => {
    try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});
