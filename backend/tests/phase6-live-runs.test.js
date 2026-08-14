/**
 * Phase 6 — live runs, and results that survive them.
 *
 * Two gaps carried out of phases 2-5, both real on main:
 *
 *   1. POST /film/flows/:id/run/stream was marked SHIPPED in the interface
 *      manifest and was never implemented. No guard caught it, because none of
 *      them checked that a route claimed shipped is actually dispatched — the
 *      manifest was trusted about itself.
 *
 *   2. routes/pipeline.js calls generators and DISCARDS the results. An
 *      orchestrated pipeline run therefore produces no assets at all, which is
 *      why lipsync and post can never find their inputs mid-run and skip. Flow
 *      node handlers persist; the legacy orchestrator never learned to.
 *
 * Set-based on both axes: every route the manifest claims, and every capability
 * the orchestrator dispatches. Checking one route or one capability would pass
 * with the other thirteen — or seven — still broken.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-p6-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleFlows } = require('../routes/flows');
const { runFlowStream } = require('../lib/flow-executor');

const MANIFEST = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs', 'plans', 'flows-canvas-interfaces.json'), 'utf8'));

// ── Shims ───────────────────────────────────────────────────────────────

function fakeRes() {
    return {
        statusCode: null, body: null, chunks: [], ended: false,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        write(chunk) { this.chunks.push(String(chunk)); return true; },
        end(payload) { if (payload) { try { this.body = JSON.parse(payload); } catch (_) { this.body = payload; } } this.ended = true; },
        on() {}, removeListener() {}, writableEnded: false,
    };
}

const PROJECT = generateId();
let FLOW_ID = null;
let RUN_ID = null;

/**
 * A throwaway flow + run, for probes that actually invoke handlers.
 *
 * Dispatch is checked by CALLING each route, which means the probe has side
 * effects: iterating the shipped list runs DELETE /flows/:id and destroys the
 * fixture for everything after it. Each probe therefore gets its own.
 */
function disposableFixture() {
    const flowId = generateId();
    db.prepare(`INSERT INTO film_flows (id, project_id, owner, name, description, is_builtin, version)
                VALUES (?, ?, '', 'probe', '', 0, 1)`).run(flowId, PROJECT);
    db.prepare(`INSERT INTO film_flow_nodes (id, flow_id, node_type, label, config, position_x, position_y)
                VALUES (?, ?, 'in.prompt', 'P', '{}', 0, 0)`).run(flowId + ':p', flowId);

    const runId = generateId();
    db.prepare(`INSERT INTO film_flow_runs (id, flow_id, project_id, status)
                VALUES (?, ?, ?, 'complete')`).run(runId, flowId, PROJECT);

    return { flowId, runId };
}

/**
 * A concrete URL for a route pattern.
 *
 * ':id' means a different thing under /projects, /flows and /flow-runs, and
 * feeding a project id to a flow route makes every check downstream 404 for the
 * wrong reason.
 */
function concreteParts(routePath, fixture) {
    const raw = routePath.split('?')[0].split('/').filter(Boolean);
    const kind = raw[1];
    const f = fixture || { flowId: FLOW_ID, runId: RUN_ID };
    const id = kind === 'projects' ? PROJECT : (kind === 'flow-runs' ? f.runId : f.flowId);
    return raw.map(seg => (seg.startsWith(':') ? id : seg));
}

test('setup', () => {
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(PROJECT, 'Phase 6');

    FLOW_ID = generateId();
    db.prepare(`INSERT INTO film_flows (id, project_id, owner, name, description, is_builtin, version)
                VALUES (?, ?, '', 'Route fixture', '', 0, 1)`).run(FLOW_ID, PROJECT);
    db.prepare(`INSERT INTO film_flow_nodes (id, flow_id, node_type, label, config, position_x, position_y)
                VALUES (?, ?, 'in.prompt', 'P', '{\"text\":\"x\"}', 0, 0)`).run(FLOW_ID + ':p', FLOW_ID);

    RUN_ID = generateId();
    db.prepare(`INSERT INTO film_flow_runs (id, flow_id, project_id, status)
                VALUES (?, ?, ?, 'complete')`).run(RUN_ID, FLOW_ID, PROJECT);
});

// ── THE ROUTE GUARD ─────────────────────────────────────────────────────

test('every route the manifest claims shipped is actually dispatched', () => {
    const shipped = MANIFEST.routes.filter(r => r.status === 'shipped');
    assert.ok(shipped.length > 0, 'the manifest claims no shipped routes');

    const undispatched = [];

    for (const route of shipped) {
        const parts = concreteParts(route.path, disposableFixture());
        const req = { method: route.method, body: {} };
        const res = fakeRes();

        try {
            handleFlows(req, res, parts, {});
        } catch (err) {
            undispatched.push(`${route.method} ${route.path} threw: ${err.message}`);
            continue;
        }

        // The router's own fall-through is exactly {error: 'Not found'}. A real
        // handler answering 404 says something more specific ('Flow not found'),
        // so the two are distinguishable.
        const fellThrough = res.statusCode === 404 && res.body && res.body.error === 'Not found';
        if (fellThrough) undispatched.push(`${route.method} ${route.path}`);
    }

    assert.deepStrictEqual(undispatched, [],
        `routes claimed shipped but not dispatched:\n  ${undispatched.join('\n  ')}`);
});

test('a route ending in /stream actually streams', () => {
    // Weaker checks pass here for the wrong reason: the router matched
    // /run/stream with its /run handler because it only inspected urlParts[3],
    // so a client asking for a stream got a blocking JSON body instead. Not
    // dispatched at all would have been more honest.
    const streaming = MANIFEST.routes.filter(r => r.status === 'shipped' && r.path.endsWith('/stream'));
    assert.ok(streaming.length > 0, 'the manifest claims no streaming routes');

    const notStreaming = [];
    for (const route of streaming) {
        const parts = concreteParts(route.path, disposableFixture());
        const res = fakeRes();
        handleFlows({ method: route.method, body: {} }, res, parts, {});
        const type = (res.headers && res.headers['Content-Type']) || '';
        if (!/event-stream/.test(type)) notStreaming.push(`${route.method} ${route.path} -> ${type || 'no content type'}`);
    }
    assert.deepStrictEqual(notStreaming, [], `streaming routes that do not stream:\n  ${notStreaming.join('\n  ')}`);
});

test('the manifest does not claim a route the router cannot name', () => {
    // The reverse direction: a shipped route whose method is refused outright
    // is dispatched but wrong.
    const shipped = MANIFEST.routes.filter(r => r.status === 'shipped');
    const wrongMethod = [];
    for (const route of shipped) {
        const parts = concreteParts(route.path, disposableFixture());
        const res = fakeRes();
        handleFlows({ method: route.method, body: {} }, res, parts, {});
        if (res.statusCode === 405) wrongMethod.push(`${route.method} ${route.path}`);
    }
    assert.deepStrictEqual(wrongMethod, [], `shipped routes rejected as method-not-allowed: ${wrongMethod.join(', ')}`);
});

// ── SSE streaming ───────────────────────────────────────────────────────

function streamCtx(record) {
    return {
        project: { id: PROJECT, provider_config: '{}' },
        scene: { id: null, project_id: PROJECT },
        sceneCard: { action: 'a warehouse' },
        characters: [], location: null, voiceProfiles: [],
        providerFor: () => ({
            id: 'stub',
            async generate(capability, payload) { (record || []).push(capability); return { ok: true, data: { image_url: 'http://stub/i.png' } }; },
        }),
    };
}

const SIMPLE = {
    nodes: [
        { id: 'p', type: 'in.prompt', config: { text: 'a warehouse at night' } },
        { id: 'img', type: 'gen.image' },
    ],
    edges: [{ from: 'p', fromPort: 'text', to: 'img', toPort: 'text' }],
};

test('runFlowStream emits a node event per node, then a final event', async () => {
    const res = fakeRes();
    await runFlowStream(SIMPLE, streamCtx([]), { flowId: 'streamed' }, res);

    const body = res.chunks.join('');
    assert.match(res.headers['Content-Type'] || '', /event-stream/, 'the response is not an SSE stream');

    const events = body.split('\n\n').filter(Boolean).map(block => {
        const type = (block.match(/^event: (.+)$/m) || [])[1];
        const data = (block.match(/^data: (.+)$/m) || [])[1];
        return { type, data: data ? JSON.parse(data) : null };
    });

    const starts = events.filter(e => e.type === 'node_start').map(e => e.data.node_id);
    const dones = events.filter(e => e.type === 'node_complete').map(e => e.data.node_id);

    assert.deepStrictEqual(starts.sort(), ['img', 'p'], `node_start events: ${JSON.stringify(starts)}`);
    assert.deepStrictEqual(dones.sort(), ['img', 'p'], `node_complete events: ${JSON.stringify(dones)}`);
    assert.ok(events.some(e => e.type === 'complete'), 'no terminal event — a client would wait forever');
});

test('the stream reports a budget refusal instead of silently emitting nothing', async () => {
    db.prepare('UPDATE film_projects SET budget_total = ? WHERE id = ?').run(0.01, PROJECT);
    const record = [];
    const res = fakeRes();
    await runFlowStream(SIMPLE, streamCtx(record), { flowId: 'streamed-broke' }, res);

    const body = res.chunks.join('');
    assert.match(body, /BUDGET_EXCEEDED/, 'a refused run produced no explanation on the stream');
    assert.strictEqual(record.length, 0, 'the stream path bypassed the budget gate');

    db.prepare('UPDATE film_projects SET budget_total = 0 WHERE id = ?').run(PROJECT);
});

test('the stream stops writing once the client disconnects', async () => {
    const res = fakeRes();
    res.writableEnded = true;                  // client already gone
    await runFlowStream(SIMPLE, streamCtx([]), { flowId: 'gone' }, res);
    assert.ok(res.chunks.length <= 1, 'kept streaming to a disconnected client');
});

// ── Persistence: the orchestrator gap ───────────────────────────────────

const { persistStepResult, STEP_CAPABILITY } = require('../routes/pipeline');

test('the orchestrator exposes a persistence path for every capability it dispatches', () => {
    // Set-based over the orchestrator's own dispatch table: a capability with
    // no persistence mapping generates media that lands nowhere, which is the
    // defect this phase closes.
    assert.ok(STEP_CAPABILITY, 'routes/pipeline.js does not export STEP_CAPABILITY');
    assert.strictEqual(typeof persistStepResult, 'function', 'routes/pipeline.js exposes no persistence path');

    const unmapped = [];
    for (const [step, capability] of Object.entries(STEP_CAPABILITY)) {
        if (!persistStepResult.supports || !persistStepResult.supports(capability)) {
            unmapped.push(`${step} (${capability})`);
        }
    }
    assert.deepStrictEqual(unmapped, [], `orchestrated steps whose output cannot be persisted: ${unmapped.join(', ')}`);
});

test('a completed orchestrator step registers an asset', async () => {
    const scene = generateId();
    const shot = generateId();
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day) VALUES (?, ?, 1, ?, ?, ?)')
        .run(scene, PROJECT, 'INT', 'WAREHOUSE', 'NIGHT');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, ?)').run(shot, scene, '9Z');

    const before = db.prepare('SELECT COUNT(*) AS n FROM film_assets WHERE shot_id = ?').get(shot).n;

    await persistStepResult('keyframe', 'image',
        { ok: true, data: Buffer.from('fake-png-bytes') },
        { shot: { id: shot, shot_code: '9Z' }, scene: { id: scene, project_id: PROJECT } });

    const after = db.prepare('SELECT COUNT(*) AS n FROM film_assets WHERE shot_id = ?').get(shot).n;
    assert.strictEqual(after, before + 1,
        'an orchestrated step generated media and registered nothing — downstream steps can never find it');
});

test('persistence failure is reported, not swallowed', async () => {
    // A step that generated successfully but could not save must not report
    // success: that is how you get a "complete" pipeline with no output.
    const result = await persistStepResult('keyframe', 'image',
        { ok: true, data: { nothing: 'useful' } },
        { shot: { id: 'ghost', shot_code: 'X' }, scene: { id: 'ghost', project_id: PROJECT } });

    assert.strictEqual(result.ok, false, 'unsaveable media was reported as persisted');
});

// ── A latent 500 this phase surfaced ────────────────────────────────────

test('film_pipeline_runs accepts every status the code actually writes', () => {
    // routes/pipeline.js has always written 'completed_with_errors' when a step
    // fails, and migration 026's CHECK has never allowed it — so ANY partially
    // failed run threw SQLITE_CONSTRAINT_CHECK and returned 500. It stayed
    // hidden because nothing in the orchestrated path could fail until steps
    // started persisting.
    //
    // Set-based over the literal statuses in the source rather than a list
    // retyped here, so a new status has to be schema-legal to ship.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8');
    const written = new Set();
    for (const m of src.matchAll(/SET status = \?[\s\S]{0,400}?\.run\(\s*'([a-z_]+)'/g)) written.add(m[1]);
    for (const m of src.matchAll(/finalStatus = [^;]*?'([a-z_]+)'/g)) written.add(m[1]);
    for (const m of src.matchAll(/status = '([a-z_]+)'/g)) written.add(m[1]);
    written.add('completed_with_errors');   // the one that broke

    const rejected = [];
    for (const status of written) {
        const id = generateId();
        try {
            db.prepare(
                `INSERT INTO film_pipeline_runs (id, project_id, run_type, status, total_steps)
                 VALUES (?, ?, 'shot', ?, 0)`
            ).run(id, PROJECT, status);
            db.prepare('DELETE FROM film_pipeline_runs WHERE id = ?').run(id);
        } catch (err) {
            rejected.push(`${status}: ${err.code || err.message}`);
        }
    }
    assert.deepStrictEqual(rejected, [],
        `statuses the code writes but the schema refuses (each one is a 500):\n  ${rejected.join('\n  ')}`);
});

test('every asset_type the code writes is one film_assets permits', () => {
    // The orchestrator mapped music -> 'music', but the column only allows
    // 'audio_music'. A wrong value fails the CHECK at INSERT, which turns a
    // SUCCESSFUL generation into a failed step — the media exists on disk and
    // the run reports failure. Set-based over the literals in the source, since
    // the same mistake was sitting in the template shelf too.
    const allowed = new Set(
        (db.prepare("SELECT sql FROM sqlite_master WHERE name='film_assets'").get().sql
            .match(/asset_type IN \(([^)]*)\)/s)[1]
            .match(/'([a-z_]+)'/g) || []).map(v => v.replace(/'/g, ''))
    );
    assert.ok(allowed.size > 5, 'could not read the asset_type vocabulary');

    const files = [
        ['routes/pipeline.js', /ASSET_TYPE = \{([\s\S]*?)\}/],
        ['lib/flow-templates.js', /asset_type: '([a-z_0-9]+)'/g],
        ['lib/node-handlers/output.js', /DEFAULT_ASSET_TYPE = \{([\s\S]*?)\}/],
    ];

    const bad = [];
    for (const [rel] of files) {
        const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        for (const m of src.matchAll(/asset_type: '([a-z_0-9]+)'/g)) {
            if (!allowed.has(m[1])) bad.push(`${rel}: '${m[1]}'`);
        }
        const block = src.match(/(?:ASSET_TYPE|DEFAULT_ASSET_TYPE) = \{([\s\S]*?)\}/);
        if (block) {
            for (const m of block[1].matchAll(/:\s*'([a-z_0-9]+)'/g)) {
                if (!allowed.has(m[1])) bad.push(`${rel}: '${m[1]}'`);
            }
        }
    }
    assert.deepStrictEqual(bad, [], `asset types the schema refuses:\n  ${bad.join('\n  ')}`);
});
