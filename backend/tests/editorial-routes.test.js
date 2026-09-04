/**
 * Route-level tests for the editorial slice (gaps 3/4/5/7d).
 *
 * These exist because the unit tests for lib/timeline.js and lib/prompt-diff.js
 * pass while the feature is completely unreachable — pure-function coverage says
 * nothing about whether server.js dispatches to the handler. Two real defects in
 * this slice were invisible to unit tests and only showed up against a live
 * server, so the dispatch itself is worth asserting.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-editorial-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 14000 + Math.floor(Math.random() * 900);
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess;

function apiRequest(urlPath, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.stringify(opts.body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request(`${BASE_URL}${urlPath}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
            },
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = data; }
                resolve({ status: res.statusCode, data: parsed });
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
            const res = await apiRequest('/api/health');
            if (res.status === 200) return;
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Server did not start');
}

describe('editorial routes (gaps 3/4/5/7d)', () => {
    let projectId;
    let shotId;

    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: { ...process.env, PORT: String(TEST_PORT), FILM_DATA_DIR: TEST_DIR },
            stdio: 'pipe',
        });
        serverProcess.stderr.on('data', () => {});
        serverProcess.stdout.on('data', () => {});
        await waitForServer();

        const proj = await apiRequest('/film/projects', {
            method: 'POST',
            body: { title: 'Editorial Route Fixture', logline: 'route reachability' },
        });
        projectId = proj.data.id;

        await apiRequest(`/film/projects/${projectId}/script`, {
            method: 'POST',
            body: { content: 'INT. KITCHEN - DAY\n\nA kettle boils.\n' },
        });
        const scenes = await apiRequest(`/film/projects/${projectId}/scenes`);
        const sceneId = scenes.data.scenes[0].id;

        await apiRequest('/film/shots', {
            method: 'POST',
            body: { scene_id: sceneId, cards: [{ shot_code: 'SC01-SH01', duration_ms: 2000, scene_card_yaml: 'shot: wide' }] },
        });
        const timeline = await apiRequest(`/film/projects/${projectId}/timeline`);
        shotId = timeline.data.entries[0].shot_id;
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ── Dispatch reachability ────────────────────────────────────
    // Each of these asserts the route is WIRED, not merely implemented. The
    // /film/projects and /film/shots catch-alls in server.js will happily
    // answer 200 with the wrong payload if a sub-path is registered below
    // them, so "not 404/405" is not enough — the shape has to be right.

    it('GET /projects/:id/timeline is reachable and returns a timeline, not the project', async () => {
        const res = await apiRequest(`/film/projects/${projectId}/timeline`);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data.entries), 'expected timeline entries, got project payload');
        assert.equal(res.data.shot_count, 1);
    });

    it('GET /projects/:id/timeline/notes is reachable', async () => {
        const res = await apiRequest(`/film/projects/${projectId}/timeline/notes`);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data.notes));
    });

    it('GET /projects/:id/selects is reachable and returns selects, not the project', async () => {
        const res = await apiRequest(`/film/projects/${projectId}/selects`);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data.selects), 'expected selects payload, got project payload');
        assert.equal(res.data.shots_total, 1);
    });

    it('GET /shots/:id/takes is reachable', async () => {
        const res = await apiRequest(`/film/shots/${shotId}/takes`);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data.takes));
    });

    it('GET /shots/:id/prompt-history is reachable', async () => {
        const res = await apiRequest(`/film/shots/${shotId}/prompt-history`);
        assert.equal(res.status, 200, 'prompt-history must not fall through to the shots dispatch');
        assert.ok(Array.isArray(res.data.history));
    });

    it('GET /shots/:id/prompt-diff is reachable and validates its params', async () => {
        // Missing a/b is a 400 from the handler. A 404/405 here would mean the
        // route never reached handleRenderLedger at all.
        const res = await apiRequest(`/film/shots/${shotId}/prompt-diff`);
        assert.equal(res.status, 400, 'expected handler validation, not a dispatch miss');
        assert.match(res.data.error, /render ledger IDs are required/);
    });

    // ── Takes materialization + compare correctness ──────────────

    it('logging a picture render creates a take; an audio render does not', async () => {
        const before = await apiRequest(`/film/shots/${shotId}/takes`);
        assert.equal(before.data.count, 0);

        await apiRequest(`/film/shots/${shotId}/render`, {
            method: 'POST',
            body: { step: 'keyframe', prompt: 'wide, kitchen', seed: 1, output_path: '/tmp/k.png' },
        });
        await apiRequest(`/film/shots/${shotId}/render`, {
            method: 'POST',
            body: { step: 'music', prompt: 'score', seed: 99 },
        });

        const after = await apiRequest(`/film/shots/${shotId}/takes`);
        assert.equal(after.data.count, 1, 'music render must not become a take of the shot');
        assert.equal(after.data.takes[0].version, 1);
    });

    it('compares two takes across different steps by ledger id, not version number', async () => {
        // The regression this guards: render_ledger.version is scoped per
        // (shot_id, step) while film_shot_versions.version counts takes per
        // shot. After a keyframe render (ledger v1) and a video render (also
        // ledger v1), the takes are v1 and v2. Matching on the number pulls the
        // wrong ledger row for take 1 and none for take 2.
        await apiRequest(`/film/shots/${shotId}/render`, {
            method: 'POST',
            body: { step: 'video', prompt: 'close, kitchen', seed: 2, output_path: '/tmp/v.mp4' },
        });

        const takes = await apiRequest(`/film/shots/${shotId}/takes`);
        assert.equal(takes.data.count, 2);

        const res = await apiRequest(`/film/shots/${shotId}/versions/compare?a=1&b=2`);
        assert.equal(res.status, 200);

        // Both sides must resolve to a real ledger row...
        assert.ok(res.data.version_a.render_params, 'take 1 lost its render params');
        assert.ok(res.data.version_b.render_params, 'take 2 resolved to no ledger row');

        // ...and to the RIGHT one. Take 1 is the keyframe, take 2 the video.
        assert.equal(res.data.version_a.render_params.step, 'keyframe');
        assert.equal(res.data.version_b.render_params.step, 'video');
        assert.equal(res.data.version_a.render_params.seed, 1);
        assert.equal(res.data.version_b.render_params.seed, 2);
    });

    it('circling a take clears any previous select for that shot', async () => {
        const takes = await apiRequest(`/film/shots/${shotId}/takes`);
        const [t2, t1] = takes.data.takes; // ordered version DESC

        await apiRequest(`/film/versions/${t1.id}/select`, { method: 'POST', body: { note: 'first' } });
        await apiRequest(`/film/versions/${t2.id}/select`, { method: 'POST', body: { note: 'second' } });

        const after = await apiRequest(`/film/shots/${shotId}/takes`);
        const selected = after.data.takes.filter(t => t.is_select);
        assert.equal(selected.length, 1, 'exactly one take may be circled per shot');
        assert.equal(selected[0].id, t2.id);
        assert.equal(after.data.selected_id, t2.id);
    });

    it('rejects a malformed timecode instead of coercing it to frame zero', async () => {
        const bad = await apiRequest(`/film/shots/${shotId}/notes`, {
            method: 'POST',
            body: { content: 'bad timecode', timecode_ms: 'garbage' },
        });
        assert.equal(bad.status, 400);

        const good = await apiRequest(`/film/shots/${shotId}/notes`, {
            method: 'POST',
            body: { content: 'the hand is wrong', timecode_ms: 800 },
        });
        assert.equal(good.status, 201);
        assert.equal(good.data.timecode_ms, 800);

        const onTimeline = await apiRequest(`/film/projects/${projectId}/timeline/notes`);
        assert.equal(onTimeline.data.notes.length, 1);
        assert.equal(onTimeline.data.notes[0].absolute_ms, 800);
    });
});
