/**
 * Phase 2 — the typed-port executor.
 *
 * Phase 1 made the graph data. This makes it run: executeNode(node, inputs, ctx)
 * generalises routes/pipeline.js:executeStep, and edges finally carry VALUES
 * rather than implying a database re-read.
 *
 * The exit criterion is set-based over the node registry: every one of the 23
 * node types must resolve to a registered handler. A sampled test ("does
 * gen.image run?") passes with twenty types unimplemented, which is exactly the
 * shape of failure a growing palette produces.
 *
 * It also pins the gap carried out of Phase 0: the old orchestrator called
 * generators and threw the results away, so an orchestrated run produced no
 * assets at all. Handlers own persistence now, and that is asserted rather
 * than assumed.
 *
 * No network: a stub provider is injected through ctx, so the whole executor is
 * exercised without a gateway.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-exec-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { NODE_TYPES } = require('../lib/flow-node-types');
const handlers = require('../lib/node-handlers');
const { executeNode, resolveNodeInputs, runFlow } = require('../lib/flow-executor');

// ── Stub provider: records what it was asked for, invents a result ──────

function stubProvider(record) {
    return {
        id: 'stub',
        async generate(capability, payload) {
            record.push({ capability, payload });
            return { ok: true, status: 200, data: { image_url: 'http://stub/img.png', video_url: 'http://stub/v.mp4', audio_url: 'http://stub/a.wav' } };
        },
    };
}

const PROJECT = generateId();
const SCENE = generateId();
const SHOT = generateId();

function baseCtx(record) {
    return {
        project: { id: PROJECT, title: 'Exec Test', style_preset: 'cinematic', provider_config: '{}' },
        scene: { id: SCENE, project_id: PROJECT, estimated_duration: 45000, time_of_day: 'NIGHT', location_name: 'WAREHOUSE' },
        shot: { id: SHOT, scene_id: SCENE, shot_code: '1A' },
        sceneCard: {
            shot_type: 'medium', characters: ['RAY'], action: 'Ray steps out.',
            dialogue: [{ character: 'RAY', line: 'You should not have come.' }],
            sfx_cues: [{ description: 'train horn', duration_s: 2 }],
        },
        characters: [{ id: 'c1', name: 'RAY', appearance_prompt: 'grey coat' }],
        location: { name: 'WAREHOUSE' },
        voiceProfiles: [],
        musicCue: { mood: 'tense' },
        videoAsset: { id: 'a-v', file_name: '1A.mp4', file_path: '/tmp/1A.mp4' },
        audioAsset: { id: 'a-a', file_name: '1A.wav', file_path: '/tmp/1A.wav' },
        overrides: {},
        // Injected so the executor never touches a network.
        providerFor: () => stubProvider(record || []),
        dryRun: true,
    };
}

test('setup: project/scene/shot rows exist', () => {
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(PROJECT, 'Exec Test');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day) VALUES (?, ?, 1, ?, ?, ?)')
        .run(SCENE, PROJECT, 'INT', 'WAREHOUSE', 'NIGHT');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, ?)')
        .run(SHOT, SCENE, '1A');
});

// ── THE EXIT CRITERION ─────────────────────────────────────────────────

test('every node type in the registry resolves to a handler', () => {
    const missing = Object.keys(NODE_TYPES).filter(id => !handlers.handlerFor(id));
    assert.deepStrictEqual(missing, [], `node types with no handler: ${missing.join(', ')}`);
});

test('every handler declares an execute function', () => {
    const bad = Object.keys(NODE_TYPES)
        .map(id => [id, handlers.handlerFor(id)])
        .filter(([, h]) => !h || typeof h.execute !== 'function')
        .map(([id]) => id);
    assert.deepStrictEqual(bad, [], `handlers without execute(): ${bad.join(', ')}`);
});

test('no handler is registered for a node type that does not exist', () => {
    const known = new Set(Object.keys(NODE_TYPES));
    const orphans = handlers.list().filter(id => !known.has(id));
    assert.deepStrictEqual(orphans, [], `handlers for unknown node types: ${orphans.join(', ')}`);
});

// ── Input resolution: edges carry values ───────────────────────────────

test('resolveNodeInputs gathers upstream port values', () => {
    const graph = {
        nodes: [
            { id: 'p', type: 'in.prompt', config: { text: 'a warehouse' } },
            { id: 'img', type: 'gen.image' },
        ],
        edges: [{ from: 'p', fromPort: 'text', to: 'img', toPort: 'text' }],
    };
    const outputs = { p: { text: { type: 'text', value: 'a warehouse' } } };
    const inputs = resolveNodeInputs(graph, 'img', outputs);

    assert.strictEqual(inputs.text.value, 'a warehouse',
        'the value did not travel along the edge — this is the DB-coupling Phase 2 removes');
});

test('a collector port arrives as an array of every source', () => {
    const graph = {
        nodes: [
            { id: 'm', type: 'gen.music' },
            { id: 's', type: 'gen.sfx' },
            { id: 'asm', type: 'out.assembly' },
        ],
        edges: [
            { from: 'm', fromPort: 'audio', to: 'asm', toPort: 'audio' },
            { from: 's', fromPort: 'audio', to: 'asm', toPort: 'audio' },
        ],
    };
    const outputs = {
        m: { audio: { type: 'audio', value: 'music.wav' } },
        s: { audio: { type: 'audio', value: 'sfx.wav' } },
    };
    const inputs = resolveNodeInputs(graph, 'asm', outputs);

    assert.ok(Array.isArray(inputs.audio), 'a collector port must arrive as an array');
    assert.strictEqual(inputs.audio.length, 2);
});

test('an unconnected input is simply absent', () => {
    const graph = { nodes: [{ id: 'img', type: 'gen.image' }], edges: [] };
    assert.deepStrictEqual(resolveNodeInputs(graph, 'img', {}), {});
});

// ── Node execution ─────────────────────────────────────────────────────

test('in.prompt emits its configured text', async () => {
    const node = { id: 'p', type: 'in.prompt', config: { text: 'warehouse at night' } };
    const r = await executeNode(node, {}, baseCtx([]));
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.outputs.text.value, 'warehouse at night');
    assert.strictEqual(r.outputs.text.type, 'text');
});

test('in.prompt interpolates {{...}} from an upstream text input', async () => {
    const node = { id: 'p', type: 'in.prompt', config: { text: 'a {{mood}} warehouse' } };
    const r = await executeNode(node, { text: { type: 'text', value: 'tense' } }, baseCtx([]));
    assert.strictEqual(r.outputs.text.value, 'a tense warehouse',
        'interpolation is what lets one flow be re-run per shot');
});

test('a generator node calls its capability with a real payload', async () => {
    const record = [];
    const ctx = baseCtx(record);
    const r = await executeNode({ id: 'img', type: 'gen.image' }, {}, ctx);

    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(record.length, 1, 'the generator was not called');
    assert.strictEqual(record[0].capability, 'image');
    assert.ok(record[0].payload.prompt && record[0].payload.prompt.length > 10,
        `generator called with an empty prompt: ${JSON.stringify(record[0].payload)}`);
});

test('an upstream prompt overrides the scene-card prompt', async () => {
    const record = [];
    const ctx = baseCtx(record);
    await executeNode({ id: 'img', type: 'gen.image' }, { text: { type: 'text', value: 'OVERRIDE PROMPT' } }, ctx);
    assert.match(record[0].payload.prompt, /OVERRIDE PROMPT/,
        'a prompt wired into the node was ignored in favour of the scene card');
});

test('a per-node provider override reaches provider resolution', async () => {
    const asked = [];
    const ctx = baseCtx([]);
    ctx.providerFor = (capability, config) => { asked.push({ capability, config }); return stubProvider([]); };

    await executeNode({ id: 'img', type: 'gen.image', config: { provider: 'runway' } }, {}, ctx);
    assert.strictEqual(asked[0].config.image, 'runway',
        'node-level model choice is the multi-model claim; it must reach resolve()');
});

test('a generator that fails reports the error rather than throwing', async () => {
    const ctx = baseCtx([]);
    ctx.providerFor = () => ({ id: 'stub', async generate() { return { ok: false, error: 'upstream exploded' }; } });
    const r = await executeNode({ id: 'img', type: 'gen.image' }, {}, ctx);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /exploded/);
});

test('a precondition failure is reported as a skip, not a failure', async () => {
    const ctx = baseCtx([]);
    ctx.videoAsset = null;
    const r = await executeNode({ id: 'l', type: 'gen.lipsync' }, {}, ctx);
    assert.strictEqual(r.ok, true, 'a missing prerequisite must not fail the run');
    assert.strictEqual(r.skipped, true);
    assert.match(r.message, /video/i);
});

test('out.asset persists rather than discarding — the Phase 0 gap', async () => {
    // The old orchestrator called generators and threw the results away, so an
    // orchestrated run produced no assets at all. Handlers own persistence now.
    const ctx = baseCtx([]);
    const before = db.prepare('SELECT COUNT(*) AS n FROM film_assets WHERE shot_id = ?').get(SHOT).n;

    const r = await executeNode(
        { id: 'save', type: 'out.asset', config: { asset_type: 'keyframe' } },
        { image: { type: 'image', value: { path: '/tmp/1A.png', file_name: '1A.png' } } },
        ctx
    );
    assert.strictEqual(r.ok, true, r.error);

    const after = db.prepare('SELECT COUNT(*) AS n FROM film_assets WHERE shot_id = ?').get(SHOT).n;
    assert.strictEqual(after, before + 1, 'out.asset did not register anything in film_assets');
});

test('every node type executes without throwing on an empty-ish context', async () => {
    // Set-based smoke: a handler that crashes on missing inputs would only
    // surface when a user happened to drop that node on the canvas.
    const failures = [];
    for (const id of Object.keys(NODE_TYPES)) {
        try {
            const r = await executeNode({ id: 'n', type: id, config: {} }, {}, baseCtx([]));
            if (r === undefined || typeof r.ok !== 'boolean') failures.push(`${id}: returned ${JSON.stringify(r)}`);
        } catch (err) {
            failures.push(`${id}: threw ${err.message}`);
        }
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
});

// ── Whole-flow execution ───────────────────────────────────────────────

test('runFlow walks a graph and records a run with per-node state', async () => {
    const record = [];
    const graph = {
        nodes: [
            { id: 'p', type: 'in.prompt', config: { text: 'a warehouse at night' } },
            { id: 'img', type: 'gen.image' },
            { id: 'vid', type: 'gen.video' },
        ],
        edges: [
            { from: 'p', fromPort: 'text', to: 'img', toPort: 'text' },
            { from: 'img', fromPort: 'image', to: 'vid', toPort: 'image' },
        ],
    };

    const run = await runFlow(graph, baseCtx(record), { flowId: 'test-flow' });

    assert.strictEqual(run.status, 'complete', `run failed: ${JSON.stringify(run.errors || run)}`);
    assert.strictEqual(run.nodes.length, 3);

    const row = db.prepare('SELECT * FROM film_flow_runs WHERE id = ?').get(run.id);
    assert.ok(row, 'no run row was written');
    assert.strictEqual(row.status, 'complete');
    assert.ok(row.graph_snapshot && row.graph_snapshot.length > 10,
        'no graph snapshot: a render-ledger entry pointing at a mutable flow means nothing');

    const nodeRuns = db.prepare('SELECT * FROM film_flow_node_runs WHERE run_id = ?').all(run.id);
    assert.strictEqual(nodeRuns.length, 3);
    assert.ok(nodeRuns.every(n => n.status === 'complete'), JSON.stringify(nodeRuns.map(n => [n.node_id, n.status])));
});

test('runFlow executes in dependency order', async () => {
    const order = [];
    const ctx = baseCtx([]);
    ctx.onNodeStart = id => order.push(id);

    const graph = {
        nodes: [
            { id: 'p', type: 'in.prompt', config: { text: 'x' } },
            { id: 'img', type: 'gen.image' },
            { id: 'vid', type: 'gen.video' },
        ],
        edges: [
            { from: 'p', fromPort: 'text', to: 'img', toPort: 'text' },
            { from: 'img', fromPort: 'image', to: 'vid', toPort: 'image' },
        ],
    };
    await runFlow(graph, ctx, { flowId: 'order-flow' });
    assert.deepStrictEqual(order, ['p', 'img', 'vid']);
});

test('runFlow refuses a cyclic graph before running anything', async () => {
    const record = [];
    const graph = {
        nodes: [{ id: 'a', type: 'gen.image' }, { id: 'b', type: 'gen.video' }],
        edges: [
            { from: 'a', fromPort: 'image', to: 'b', toPort: 'image' },
            { from: 'b', fromPort: 'video', to: 'a', toPort: 'image' },
        ],
    };
    const run = await runFlow(graph, baseCtx(record), { flowId: 'cyclic' });

    assert.strictEqual(run.status, 'failed');
    assert.ok(run.errors.some(e => e.code === 'CYCLE'), JSON.stringify(run.errors));
    assert.strictEqual(record.length, 0, 'a generator was called despite an invalid graph');
});

test('a failed node stops its dependants but records what happened', async () => {
    const ctx = baseCtx([]);
    ctx.providerFor = () => ({ id: 'stub', async generate() { return { ok: false, error: 'nope' }; } });

    const graph = {
        nodes: [
            { id: 'img', type: 'gen.image' },
            { id: 'vid', type: 'gen.video' },
        ],
        edges: [{ from: 'img', fromPort: 'image', to: 'vid', toPort: 'image' }],
    };
    const run = await runFlow(graph, ctx, { flowId: 'failing' });

    assert.strictEqual(run.status, 'failed');
    const rows = db.prepare('SELECT node_id, status FROM film_flow_node_runs WHERE run_id = ?').all(run.id);
    const byNode = Object.fromEntries(rows.map(r => [r.node_id, r.status]));
    assert.strictEqual(byNode.img, 'failed');
    assert.notStrictEqual(byNode.vid, 'complete', 'a dependant ran after its dependency failed');
});
