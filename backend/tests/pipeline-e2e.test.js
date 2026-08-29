/**
 * End-to-end pipeline test: drive a shot through the full 9-step orchestrated
 * pipeline (keyframe → video → voice → lipsync → music → sfx → ambient → post →
 * assembly) against a mock gateway, proving the "scene → final" chain runs and
 * is provider-aware (each step resolves through the provider layer).
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

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-e2e-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 17700 + Math.floor(Math.random() * 600);
const BASE_URL = `http://localhost:${TEST_PORT}`;
let serverProcess, mockGateway;

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
            res.on('end', () => { let p; try { p = JSON.parse(data); } catch { p = data; } resolve({ status: res.statusCode, data: p, raw: data }); });
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

describe('Pipeline end-to-end (scene → final, mock gateway)', () => {
    let projectId, sceneId, shotId, mockPort;

    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        // Mock gateway: every generation endpoint succeeds.
        mockGateway = http.createServer((req, res) => {
            let raw = ''; req.on('data', c => raw += c);
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, url: 'mock' }));
            });
        });
        await new Promise(r => mockGateway.listen(0, '127.0.0.1', r));
        mockPort = mockGateway.address().port;

        serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(TEST_PORT),
                FILM_DATA_DIR: TEST_DIR,
                GRIDLIGHT_URL: `http://127.0.0.1:${mockPort}`,
                GRIDLIGHT_API_KEY: 'test',
                RATE_LIMIT_MAX_GENERATION: '1000',
            },
            stdio: 'pipe',
        });
        serverProcess.stderr.on('data', () => {});
        serverProcess.stdout.on('data', () => {});
        await waitForServer();

        // Fixtures: project → script → scene → shot (with dialogue + sfx so nothing auto-skips).
        const proj = await request('/film/projects', { method: 'POST', body: { title: 'E2E Film', logline: 'x' } });
        projectId = proj.data.id;
        await request(`/film/projects/${projectId}/script`, {
            method: 'POST', body: { content: 'Title: E2E\n\nINT. OFFICE - DAY\n\nJax speaks.\n\nJAX\nHello there.\n', format: 'fountain' },
        });
        const scenes = await request(`/film/projects/${projectId}/scenes`);
        sceneId = (scenes.data.scenes || [])[0].id;
        const shots = await request('/film/shots', {
            method: 'POST',
            body: { scene_id: sceneId, cards: [{ shot_code: '1A', camera: { shot_type: 'medium' }, dialogue: [{ character: 'JAX', line: 'Hello there.' }], sfx: ['footsteps'] }] },
        });
        shotId = (shots.data.shots || shots.data.created || [])[0].id;
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        if (mockGateway) mockGateway.close();
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('runs every generation step against the mock gateway', async () => {
        /*
         * include_scene_steps because this asserts that EVERY step can run, and
         * `music` and `ambient` are scene-scoped: a single-shot run skips them
         * by default now, since running five shots one at a time would
         * otherwise buy five copies of one scene's score. The default is proven
         * in pipeline-scope.test.js; what is proven here is that each step
         * works, so the run has to ask for all of them.
         */
        const res = await request(`/film/shots/${shotId}/pipeline/run`, {
            method: 'POST', body: { include_scene_steps: true },
        });
        assert.equal(res.status, 200);
        const done = res.data.steps_completed;
        // Dialogue present → nothing auto-skipped: all 8 generation steps run.
        for (const step of ['keyframe', 'video', 'voice', 'lipsync', 'music', 'sfx', 'ambient', 'post']) {
            assert.ok(done.includes(step), `step '${step}' should have completed`);
        }
    });

    it('assembly reports honestly when it cannot produce a film', async () => {
        // This assertion used to read `status === 'complete'` with zero failed
        // steps, and it passed because assembly returned a hardcoded success
        // and made nothing. The mock gateway can serve every generation step
        // and cannot conform a film — conforming needs a media tool, and this
        // machine has none — so the honest outcome is a run that says so.
        //
        // The test now pins the DISTINCTION rather than the old happy answer:
        // whatever assembly does, it must never claim a film it did not make.
        const res = await request(`/film/shots/${shotId}/pipeline/run`, { method: 'POST', body: {} });
        const made = (res.data.steps_completed || []).includes('assembly');
        const failed = (res.data.steps_failed || []).includes('assembly');
        assert.ok(made !== failed, 'assembly is both completed and failed, or neither');

        if (made) {
            // A conform really ran: there must be a master to show for it.
            const assets = await request(`/film/projects/${projectId}/assets`);
            const master = (assets.data.assets || []).some(a =>
                String(a.metadata || '').includes('project_master'));
            assert.ok(master, 'assembly completed without registering a conformed film');
        } else {
            assert.ok(['completed_with_errors', 'failed'].includes(res.data.status),
                `assembly failed but the run reported ${res.data.status}`);
        }
    });

    it('records the pipeline run row as complete', async () => {
        const res = await request(`/film/projects/${projectId}/pipeline`);
        assert.equal(res.status, 200);
        const runs = res.data.runs || res.data.pipeline_runs || [];
        assert.ok(runs.some(r => r.status === 'complete' || r.status === 'completed_with_errors'), 'a completed run should be recorded');
    });

    it('auto-skips voice + lipsync when a shot has no dialogue', async () => {
        const noDlg = await request('/film/shots', {
            method: 'POST', body: { scene_id: sceneId, cards: [{ shot_code: '1B', camera: { shot_type: 'wide' } }] },
        });
        const id = (noDlg.data.shots || [])[0].id;
        const res = await request(`/film/shots/${id}/pipeline/run`, { method: 'POST', body: {} });
        // The auto-skip is what this test is about; whether the conform can run
        // depends on the machine and is covered above.
        assert.ok(!res.data.steps_completed.includes('voice'), 'voice should be skipped');
        assert.ok(!res.data.steps_completed.includes('lipsync'), 'lipsync should be skipped');
        assert.ok(res.data.steps_completed.includes('keyframe'));
    });
});
