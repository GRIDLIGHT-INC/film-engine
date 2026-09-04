/**
 * Integration tests for the video generation route (routes/video-gen.js).
 *
 * Spins up the real server (temp DB) pointed at an in-process mock Gridlight
 * gateway, exercising the full proxy path: route → gridlight-client → mock →
 * job/asset persistence → file serving.
 */
const { describe, it, before, after } = require('node:test');
/*
 * The local gateway is OFF unless switched on, so a suite that stands up a mock
 * Gridlight and generates against it has to enable it — exactly as an operator
 * running the real service does. Set before anything requires the provider
 * registry, which caches the answer.
 */
process.env.GRIDLIGHT_ENABLED = '1';
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-video-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 16000 + Math.floor(Math.random() * 900);
const BASE_URL = `http://localhost:${TEST_PORT}`;

let mockMode = 'binary'; // 'binary' | 'json' | 'jsonBadUrl' | 'error500'
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

describe('Video Generation Integration (mock Gridlight)', () => {
    let mockPort, projectId, sceneId, shotId;

    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });

        mockGridlight = http.createServer((req, res) => {
            // Serving endpoint — the real gateway returns binary here even though
            // its generation endpoints answer with JSON URLs.
            if (req.method === 'GET') {
                if (req.url.startsWith('/videos/')) {
                    res.writeHead(200, { 'Content-Type': 'video/mp4' });
                    return res.end(Buffer.from('FAKE-MP4-DATA'));
                }
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('not found');
            }
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => {
                let reqBody = {}; try { reqBody = JSON.parse(raw || '{}'); } catch { /* ignore */ }
                if (mockMode === 'error500') { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('boom'); }
                if (reqBody.stream === true) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                    res.write('data: ' + JSON.stringify({ event: 'progress', pct: 50 }) + '\n\n');
                    res.write('data: ' + JSON.stringify({ event: 'complete', video_url: `http://${req.headers.host}/videos/vid_abc123.mp4` }) + '\n\n');
                    return res.end();
                }
                // Documented Gridlight shape: application/json carrying a URL, NOT
                // inline binary. Exercising only the binary branch is what let the
                // "generated media never lands on disk" bug ship green.
                if (mockMode === 'json' || mockMode === 'jsonBadUrl') {
                    const videoUrl = mockMode === 'jsonBadUrl'
                        ? `http://${req.headers.host}/missing/nope.mp4`
                        : `http://${req.headers.host}/videos/vid_abc123.mp4`;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ status: 'success', video_url: videoUrl, seed: 42, model_used: 'ltx-2' }));
                }
                res.writeHead(200, { 'Content-Type': 'video/mp4' });
                return res.end(Buffer.from('FAKE-MP4-DATA'));
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
        const proj = await request('/film/projects', { method: 'POST', body: { title: 'Video Test', logline: 'x' } });
        projectId = proj.data.id;
        await request(`/film/projects/${projectId}/script`, {
            method: 'POST',
            body: { content: 'Title: Video Test\n\nINT. OFFICE - DAY\n\nJohn types.\n', format: 'fountain' },
        });
        const scenes = await request(`/film/projects/${projectId}/scenes`);
        sceneId = (scenes.data.scenes || [])[0].id;
        const shots = await request('/film/shots', { method: 'POST', body: { scene_id: sceneId, cards: [{ shot_code: '1A', camera: { shot_type: 'medium', movement: 'static' } }] } });
        shotId = (shots.data.shots || shots.data.created || [])[0].id;
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        if (mockGridlight) mockGridlight.close();
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('rejects an invalid shot id with 400', async () => {
        const res = await request('/film/shots/not-a-uuid/video/generate', { method: 'POST', body: {} });
        assert.equal(res.status, 400);
    });

    it('returns 404 for an unknown shot', async () => {
        const res = await request('/film/shots/11111111-1111-4111-8111-111111111111/video/generate', { method: 'POST', body: {} });
        assert.equal(res.status, 404);
    });

    it('generates video from a shot (inline binary)', async () => {
        mockMode = 'binary';
        const res = await request(`/film/shots/${shotId}/video/generate`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'complete');
        assert.match(res.data.video_url, /^\/film\/video\/.+1A\.mp4$/);
    });

    it('records the video job and a video_raw asset', async () => {
        const res = await request(`/film/shots/${shotId}/video`);
        assert.equal(res.status, 200);
        const jobs = res.data.jobs || res.data.video_jobs || [];
        assert.ok(jobs.some(j => j.status === 'complete'), 'expected a completed video job');
    });

    // Gridlight's POST /video answers application/json with a video_url; only the
    // GET /videos/:file serving endpoint returns bytes. The route must download
    // that URL, or film_assets.file_path holds a remote URL, the media never
    // lands locally, and NLE export emits file:///http://host/... to Premiere.
    it('downloads media to local storage when the provider returns a JSON URL', async () => {
        mockMode = 'json';
        const res = await request(`/film/shots/${shotId}/video/generate`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'complete');

        const assets = await request(`/film/projects/${projectId}/assets`);
        const video = (assets.data.assets || []).filter(a => a.asset_type === 'video_raw').pop();
        assert.ok(video, 'expected a video_raw asset');
        assert.ok(
            path.isAbsolute(video.file_path),
            `file_path must be a local absolute path, got ${JSON.stringify(video.file_path)}`
        );
        assert.ok(!/^https?:\/\//i.test(video.file_path), 'file_path must not be a remote URL');
        assert.ok(fs.existsSync(video.file_path), `no file on disk at ${video.file_path}`);
        assert.match(fs.readFileSync(video.file_path, 'utf8'), /FAKE-MP4-DATA/);
    });

    it('serves the downloaded media back over the API (no 404)', async () => {
        mockMode = 'json';
        // Clear anything an earlier binary-mode test left behind, so passing here
        // proves THIS generation wrote the file rather than inheriting it.
        const stale = path.join(TEST_DIR, 'video', projectId, '1A.mp4');
        try { fs.rmSync(stale, { force: true }); } catch { /* ignore */ }

        const gen = await request(`/film/shots/${shotId}/video/generate`, { method: 'POST', body: {} });
        const served = await request(gen.data.video_url);
        assert.equal(served.status, 200, 'the URL the API hands back must not 404');
        assert.match(served.raw, /FAKE-MP4-DATA/);
    });

    it('fails loudly when generated media cannot be stored', async () => {
        mockMode = 'jsonBadUrl';
        const res = await request(`/film/shots/${shotId}/video/generate`, { method: 'POST', body: {} });
        assert.equal(res.status, 502, 'unstorable media must not report success');
        assert.match(res.data.error, /could not be stored/i);
    });

    it('serves the generated .mp4 with a video mime type', async () => {
        mockMode = 'binary';
        const gen = await request(`/film/shots/${shotId}/video/generate`, { method: 'POST', body: {} });
        const served = await request(gen.data.video_url);
        assert.equal(served.status, 200);
        assert.match(served.headers['content-type'], /video\/mp4/);
        assert.match(served.raw, /FAKE-MP4-DATA/);
    });

    it('streams video generation events (status → done)', async () => {
        mockMode = 'binary';
        const res = await request(`/film/shots/${shotId}/video/generate/stream`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.match(res.raw, /"type":"status"/);
        assert.match(res.raw, /"type":"done"/);
    });

    it('batch-streams video for all shots', async () => {
        mockMode = 'binary';
        const res = await request(`/film/projects/${projectId}/video/batch/stream`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        assert.match(res.raw, /"type":"status"/);
        assert.match(res.raw, /"type":"shot_complete"/);
        assert.match(res.raw, /"type":"result"/);
        assert.match(res.raw, /"type":"done"/);
    });

    it('lists project video jobs', async () => {
        const res = await request(`/film/projects/${projectId}/video`);
        assert.equal(res.status, 200);
        const jobs = res.data.jobs || res.data.video_jobs || [];
        assert.ok(jobs.length >= 1);
    });

    it('marks the job failed on an upstream 500', async () => {
        mockMode = 'error500';
        const res = await request(`/film/shots/${shotId}/video/generate`, { method: 'POST', body: {} });
        assert.ok(res.status >= 400, `expected error status, got ${res.status}`);
        const status = await request(`/film/shots/${shotId}/video`);
        const jobs = status.data.jobs || status.data.video_jobs || [];
        assert.ok(jobs.some(j => j.status === 'failed'), 'expected a failed video job');
    });

    it('rejects a traversal filename on the serve route', async () => {
        const res = await request(`/film/video/${projectId}/..%2f..%2f..%2fetc%2fpasswd`);
        assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
    });

    it('404s a missing video file', async () => {
        const res = await request(`/film/video/${projectId}/nonexistent.mp4`);
        assert.equal(res.status, 404);
    });
});
