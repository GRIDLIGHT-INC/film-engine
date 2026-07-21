/**
 * Integration tests for the 3D asset generation route (routes/threed.js).
 *
 * Spins up the real Film Engine server (temp DB) pointed at an in-process
 * mock Gridlight gateway, so the full proxy path is exercised: route →
 * gridlight-client → mock → job/asset persistence → file serving.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-3d-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 14100 + Math.floor(Math.random() * 800);
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Mock Gridlight behavior, mutated per-test (tests run sequentially).
let mockMode = 'binary'; // 'binary' | 'job' | 'url' | 'error500'
let serverProcess;
let mockGridlight;

function request(urlPath, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.stringify(opts.body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request(`${BASE_URL}${urlPath}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
                resolve({ status: res.statusCode, data: parsed, raw: data, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function waitForServer(maxRetries = 40) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await request('/api/health');
            if (res.status === 200) return;
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Server did not start');
}

describe('3D Integration (mock Gridlight)', () => {
    let mockPort;
    let projectId, characterId, propId, modelAssetId;

    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });

        // ── In-process mock Gridlight gateway ──────────────────────────
        mockGridlight = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => {
                let reqBody = {};
                try { reqBody = JSON.parse(raw || '{}'); } catch { /* ignore */ }
                const url = req.url || '';

                if (url.includes('/3d/animations')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ animations: ['idle', 'walk', 'run'] }));
                }
                if (mockMode === 'error500') {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    return res.end('boom');
                }
                // SSE streaming path (relayGridlightSSE sets stream:true)
                if (reqBody.stream === true) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                    res.write('data: ' + JSON.stringify({ event: 'progress', pct: 50 }) + '\n\n');
                    res.write('data: ' + JSON.stringify({ event: 'complete', model_url: 'http://cdn.example/x.glb' }) + '\n\n');
                    return res.end();
                }
                if (mockMode === 'job') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ job_id: 'upstream-123' }));
                }
                if (mockMode === 'url') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ model_url: 'http://cdn.example/x.glb' }));
                }
                // default: inline binary mesh
                res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
                return res.end(Buffer.from('glTF-FAKE-BINARY-DATA'));
            });
        });
        await new Promise(r => mockGridlight.listen(0, '127.0.0.1', r));
        mockPort = mockGridlight.address().port;

        // ── Spawn the real server pointed at the mock ──────────────────
        serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(TEST_PORT),
                FILM_DATA_DIR: TEST_DIR,
                GRIDLIGHT_URL: `http://127.0.0.1:${mockPort}`,
                GRIDLIGHT_API_KEY: 'test-token',
                // This suite fires many generation POSTs from one IP; lift the
                // generation rate limit so it doesn't 429 mid-suite.
                RATE_LIMIT_MAX_GENERATION: '1000',
            },
            stdio: 'pipe',
        });
        serverProcess.stderr.on('data', () => {});
        serverProcess.stdout.on('data', () => {});
        await waitForServer();

        // Fixtures
        const proj = await request('/film/projects', { method: 'POST', body: { title: '3D Test', logline: 'x' } });
        projectId = proj.data.id;
        const ch = await request(`/film/projects/${projectId}/characters`, { method: 'POST', body: { name: 'Jax', appearance_prompt: 'rugged bounty hunter' } });
        characterId = ch.data.id;
        const pr = await request(`/film/projects/${projectId}/props`, { method: 'POST', body: { name: 'Sword', visual_prompt: 'ornate steel blade' } });
        propId = pr.data.id;
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        if (mockGridlight) mockGridlight.close();
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ── Validation & error paths ──────────────────────────────────────
    it('rejects an invalid subject id with 400', async () => {
        const res = await request('/film/characters/not-a-uuid/model/generate', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
    });

    it('returns 404 for an unknown character', async () => {
        const res = await request('/film/characters/11111111-1111-4111-8111-111111111111/model/generate', { method: 'POST', body: {} });
        assert.equal(res.status, 404);
    });

    // ── Sync generate (inline binary → asset registered) ──────────────
    it('generates a model from a character (inline binary)', async () => {
        mockMode = 'binary';
        const res = await request(`/film/characters/${characterId}/model/generate`, { method: 'POST', body: { format: 'glb' } });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'complete');
        assert.ok(res.data.asset_id);
        assert.match(res.data.model_url, /^\/film\/3d\/.+\.glb$/);
        modelAssetId = res.data.asset_id;
    });

    it('persists a typed film_3d_jobs row and an asset', async () => {
        const res = await request(`/film/projects/${projectId}/models`);
        assert.equal(res.status, 200);
        assert.ok(res.data.total_jobs >= 1);
        const job = res.data.jobs.find(j => j.gen_type === 'generate' && j.status === 'complete');
        assert.ok(job, 'expected a completed generate job');
        assert.equal(job.format, 'glb');
        assert.ok(res.data.models.length >= 1);
        assert.equal(res.data.models[0].metadata.kind, 'model_3d');
    });

    it('serves the generated .glb with a model mime type', async () => {
        const res = await request(`/film/characters/${characterId}/model/generate`, { method: 'POST', body: {} });
        const url = res.data.model_url;
        const served = await request(url);
        assert.equal(served.status, 200);
        assert.match(served.headers['content-type'], /model\/gltf-binary/);
        assert.match(served.raw, /glTF-FAKE-BINARY-DATA/);
    });

    // ── Async job handoff (job_id → 202 + poll) ───────────────────────
    it('returns 202 with a poll URL when the service defers to a job id', async () => {
        mockMode = 'job';
        const res = await request(`/film/characters/${characterId}/model/generate`, { method: 'POST', body: {} });
        assert.equal(res.status, 202);
        assert.equal(res.data.status, 'generating');
        assert.equal(res.data.upstream_job_id, 'upstream-123');
        assert.match(res.data.poll, /^\/film\/models\/job\/.+/);

        const job = await request(res.data.poll);
        assert.equal(job.status, 200);
        assert.equal(job.data.upstream_job_id, 'upstream-123');
        assert.equal(job.data.status, 'generating');
    });

    // ── model_url response ────────────────────────────────────────────
    it('accepts a model_url JSON response', async () => {
        mockMode = 'url';
        const res = await request(`/film/characters/${characterId}/model/generate`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'complete');
        assert.ok(res.data.asset_id);
    });

    // ── Upstream error handling ───────────────────────────────────────
    it('marks the job failed on an upstream 500', async () => {
        mockMode = 'error500';
        const res = await request(`/film/props/${propId}/model/generate`, { method: 'POST', body: {} });
        assert.ok(res.status >= 400, `expected error status, got ${res.status}`);
        const list = await request(`/film/projects/${projectId}/models`);
        const failed = list.data.jobs.find(j => j.subject_kind === 'prop' && j.status === 'failed');
        assert.ok(failed, 'expected a failed prop job');
    });

    // ── SSE streaming generate ────────────────────────────────────────
    it('streams generation events (status → complete → done)', async () => {
        mockMode = 'binary'; // stream branch in mock ignores mode and emits complete
        const res = await request(`/film/characters/${characterId}/model/generate/stream`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.match(res.raw, /"type":"status"/);
        assert.match(res.raw, /"type":"complete"/);
        assert.match(res.raw, /"type":"done"/);
    });

    // ── Mesh ops: rig / animate / animations ──────────────────────────
    it('rigs an existing model asset', async () => {
        mockMode = 'binary';
        assert.ok(modelAssetId, 'need a model asset from earlier');
        const res = await request(`/film/models/${modelAssetId}/rig`, { method: 'POST', body: { skeleton: 'humanoid' } });
        assert.equal(res.status, 200);
        assert.equal(res.data.operation, 'rig');
        assert.ok(res.data.asset_id);
    });

    it('lists available animations for a model asset', async () => {
        const res = await request(`/film/models/${modelAssetId}/animations`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.data.animations, ['idle', 'walk', 'run']);
    });

    it('returns 404 for rig on an unknown asset', async () => {
        const res = await request('/film/models/22222222-2222-4222-8222-222222222222/rig', { method: 'POST', body: {} });
        assert.equal(res.status, 404);
    });

    // ── Batch ─────────────────────────────────────────────────────────
    it('batch-streams generation for all subjects', async () => {
        mockMode = 'binary';
        const res = await request(`/film/projects/${projectId}/models/batch/stream`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.match(res.raw, /"type":"status"/);
        assert.match(res.raw, /"type":"subject_complete"/);
        assert.match(res.raw, /"type":"result"/);
        assert.match(res.raw, /"type":"done"/);
    });

    // ── Serve route hardening ─────────────────────────────────────────
    it('rejects a traversal filename on the serve route', async () => {
        const res = await request(`/film/3d/${projectId}/..%2f..%2f..%2fetc%2fpasswd`);
        assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
    });

    it('404s a missing model file', async () => {
        const res = await request(`/film/3d/${projectId}/nonexistent.glb`);
        assert.equal(res.status, 404);
    });

    it('404s an unknown job', async () => {
        const res = await request('/film/models/job/33333333-3333-4333-8333-333333333333');
        assert.equal(res.status, 404);
    });
});
