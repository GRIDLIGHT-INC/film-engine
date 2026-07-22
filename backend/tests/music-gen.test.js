/**
 * Integration tests for the music/SFX/ambient generation route
 * (routes/music-gen.js).
 *
 * Spins up the real server (temp DB) pointed at an in-process mock Gridlight
 * gateway, exercising the full proxy path: route → gridlight-client → mock →
 * job/asset persistence → file serving.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-music-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 16100 + Math.floor(Math.random() * 800);
const BASE_URL = `http://localhost:${TEST_PORT}`;

let mockMode = 'binary'; // 'binary' | 'error500'
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
        try { const res = await request('/api/health'); if (res.status === 200) return; } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Server did not start');
}

describe('Music Generation Integration (mock Gridlight)', () => {
    let mockPort, projectId, sceneId, shotId;

    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });

        mockGridlight = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => {
                let reqBody = {}; try { reqBody = JSON.parse(raw || '{}'); } catch { /* ignore */ }
                if (mockMode === 'error500') { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('boom'); }
                if (reqBody.stream === true) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                    res.write('data: ' + JSON.stringify({ event: 'progress', pct: 50 }) + '\n\n');
                    res.write('data: ' + JSON.stringify({ event: 'complete', audio_url: 'http://cdn.example/x.wav' }) + '\n\n');
                    return res.end();
                }
                res.writeHead(200, { 'Content-Type': 'audio/wav' });
                return res.end(Buffer.from('FAKE-WAV-DATA'));
            });
        });
        await new Promise(r => mockGridlight.listen(0, '127.0.0.1', r));
        mockPort = mockGridlight.address().port;

        serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(TEST_PORT),
                FILM_DATA_DIR: TEST_DIR,
                GRIDLIGHT_URL: `http://127.0.0.1:${mockPort}`,
                GRIDLIGHT_API_KEY: 'test-token',
                RATE_LIMIT_MAX_GENERATION: '1000',
            },
            stdio: 'pipe',
        });
        serverProcess.stderr.on('data', () => {});
        serverProcess.stdout.on('data', () => {});
        await waitForServer();

        // Fixtures: project → script → scene → shot
        const proj = await request('/film/projects', { method: 'POST', body: { title: 'Music Test', logline: 'x' } });
        projectId = proj.data.id;
        await request(`/film/projects/${projectId}/script`, {
            method: 'POST',
            body: { content: 'Title: Music Test\n\nEXT. PARK - NIGHT\n\nA dog runs across the lawn.\n', format: 'fountain' },
        });
        const scenes = await request(`/film/projects/${projectId}/scenes`);
        sceneId = (scenes.data.scenes || [])[0].id;
        const shots = await request('/film/shots', { method: 'POST', body: { scene_id: sceneId, cards: [{ shot_code: '1A', sfx: ['dog barking'] }] } });
        shotId = (shots.data.shots || shots.data.created || [])[0].id;
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        if (mockGridlight) mockGridlight.close();
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('rejects an invalid scene id with 400', async () => {
        const res = await request('/film/scenes/not-a-uuid/music/generate', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
    });

    it('returns 404 for an unknown scene', async () => {
        const res = await request('/film/scenes/11111111-1111-4111-8111-111111111111/music/generate', { method: 'POST', body: {} });
        assert.equal(res.status, 404);
    });

    it('generates a music score for a scene (inline binary)', async () => {
        mockMode = 'binary';
        const res = await request(`/film/scenes/${sceneId}/music/generate`, { method: 'POST', body: { mood: 'tense' } });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'complete');
        assert.match(res.data.music_url, /^\/film\/music\/.+_score\.wav$/);
    });

    it('generates ambient audio for a scene', async () => {
        mockMode = 'binary';
        const res = await request(`/film/scenes/${sceneId}/ambient/generate`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'complete');
        assert.match(res.data.ambient_url, /^\/film\/music\/.+_ambient\.wav$/);
    });

    it('generates SFX for a shot', async () => {
        mockMode = 'binary';
        const res = await request(`/film/shots/${shotId}/sfx/generate`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        // Either produced SFX files, or a clean "no cues" message — both are 200.
        assert.ok('sfx_files' in res.data || 'message' in res.data);
    });

    it('serves a generated audio file with an audio mime type', async () => {
        const gen = await request(`/film/scenes/${sceneId}/music/generate`, { method: 'POST', body: {} });
        const served = await request(gen.data.music_url);
        assert.equal(served.status, 200);
        assert.match(served.headers['content-type'], /audio\/wav/);
        assert.match(served.raw, /FAKE-WAV-DATA/);
    });

    it('batch-streams music for all scenes', async () => {
        mockMode = 'binary';
        const res = await request(`/film/projects/${projectId}/music/batch/stream`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.match(res.raw, /"type":"status"/);
        assert.match(res.raw, /"type":"scene_start"/);
        assert.match(res.raw, /"type":"result"/);
        assert.match(res.raw, /"type":"done"/);
    });

    it('lists project music jobs', async () => {
        const res = await request(`/film/projects/${projectId}/music/jobs`);
        assert.equal(res.status, 200);
        const jobs = res.data.jobs || res.data.music_jobs || [];
        assert.ok(jobs.length >= 1);
    });

    it('marks the job failed on an upstream 500', async () => {
        mockMode = 'error500';
        const res = await request(`/film/scenes/${sceneId}/music/generate`, { method: 'POST', body: {} });
        assert.ok(res.status >= 400, `expected error status, got ${res.status}`);
        const list = await request(`/film/projects/${projectId}/music/jobs`);
        const jobs = list.data.jobs || list.data.music_jobs || [];
        assert.ok(jobs.some(j => j.status === 'failed'), 'expected a failed music job');
    });

    it('rejects a traversal filename on the serve route', async () => {
        const res = await request(`/film/music/${projectId}/..%2f..%2f..%2fetc%2fpasswd`);
        assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
    });

    it('404s a missing music file', async () => {
        const res = await request(`/film/music/${projectId}/nonexistent.wav`);
        assert.equal(res.status, 404);
    });
});
