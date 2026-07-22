/**
 * Pipeline consistency-readiness gate (routes/pipeline.js):
 * strict mode blocks a scene→final run when a referenced character/location has
 * no locked consistency profile; non-strict runs but surfaces the readiness.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-pready-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 18700 + Math.floor(Math.random() * 600);
const BASE_URL = `http://localhost:${TEST_PORT}`;
let serverProcess, mockGateway;

function request(urlPath, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.stringify(opts.body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request(`${BASE_URL}${urlPath}`, {
            method, headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
        }, (res) => {
            let data = ''; res.on('data', c => data += c);
            res.on('end', () => { let p; try { p = JSON.parse(data); } catch { p = data; } resolve({ status: res.statusCode, data: p }); });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function waitForServer(n = 40) {
    for (let i = 0; i < n; i++) {
        try { const r = await request('/api/health'); if (r.status === 200) return; } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Server did not start');
}

describe('Pipeline consistency readiness', () => {
    let projectId, shotId, sceneId, mockPort;

    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        // Mock gateway so non-strict runs complete fast (each step succeeds).
        mockGateway = http.createServer((req, res) => {
            let raw = ''; req.on('data', c => raw += c);
            req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
        });
        await new Promise(r => mockGateway.listen(0, '127.0.0.1', r));
        mockPort = mockGateway.address().port;

        serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: { ...process.env, PORT: String(TEST_PORT), FILM_DATA_DIR: TEST_DIR, GRIDLIGHT_URL: `http://127.0.0.1:${mockPort}`, GRIDLIGHT_API_KEY: 't', RATE_LIMIT_MAX_GENERATION: '1000' },
            stdio: 'pipe',
        });
        serverProcess.stderr.on('data', () => {});
        serverProcess.stdout.on('data', () => {});
        await waitForServer();

        // project → character in registry → scene → shot referencing the character (no locked profile).
        const proj = await request('/film/projects', { method: 'POST', body: { title: 'Readiness', logline: 'x' } });
        projectId = proj.data.id;
        await request(`/film/projects/${projectId}/characters`, { method: 'POST', body: { name: 'Jax', appearance_prompt: 'bounty hunter' } });
        await request(`/film/projects/${projectId}/script`, { method: 'POST', body: { content: 'Title: R\n\nINT. OFFICE - DAY\n\nJax stands.\n', format: 'fountain' } });
        const scenes = await request(`/film/projects/${projectId}/scenes`);
        sceneId = (scenes.data.scenes || [])[0].id;
        const shots = await request('/film/shots', {
            method: 'POST',
            body: { scene_id: sceneId, cards: [{ shot_code: '1A', camera: { shot_type: 'medium' }, characters: [{ name: 'Jax' }] }] },
        });
        shotId = (shots.data.shots || [])[0].id;
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        if (mockGateway) mockGateway.close();
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('strict mode blocks the run when a character has no locked profile', async () => {
        const res = await request(`/film/shots/${shotId}/pipeline/run`, { method: 'POST', body: { strict: true } });
        assert.equal(res.status, 409);
        assert.equal(res.data.readiness.ready, false);
        assert.ok(res.data.readiness.missing.some(m => /Jax/.test(m)), 'missing should mention the unlocked character');
    });

    it('non-strict run proceeds but reports readiness', async () => {
        const res = await request(`/film/shots/${shotId}/pipeline/run`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.ok(res.data.readiness, 'response carries a readiness field');
        assert.equal(res.data.readiness.ready, false);
        assert.ok(['complete', 'completed_with_errors'].includes(res.data.status));
    });

    it('shot audit endpoint agrees the shot is not ready', async () => {
        const res = await request(`/film/shots/${shotId}/consistency/audit`);
        assert.equal(res.status, 200);
        assert.equal(res.data.ready, false);
        assert.ok(res.data.missing.length >= 1);
    });

    it('strict SCENE run 409s when a contained shot is not ready', async () => {
        const res = await request(`/film/scenes/${sceneId}/pipeline/run`, { method: 'POST', body: { strict: true } });
        assert.equal(res.status, 409);
        assert.equal(res.data.readiness.ready, false);
    });

    it('strict PROJECT run 409s when any shot is not ready', async () => {
        const res = await request(`/film/projects/${projectId}/pipeline/run`, { method: 'POST', body: { strict: true } });
        assert.equal(res.status, 409);
        assert.equal(res.data.readiness.ready, false);
    });

    it('non-strict scene run proceeds (202) with readiness', async () => {
        const res = await request(`/film/scenes/${sceneId}/pipeline/run`, { method: 'POST', body: {} });
        assert.equal(res.status, 202);
        assert.ok(res.data.readiness);
    });
});
