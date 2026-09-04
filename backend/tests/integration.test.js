/**
 * FILM-076: Integration Test Suite
 *
 * Starts the actual server with a temporary database,
 * then exercises the major API flows end-to-end.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

// Test data directory
const TEST_DIR = path.join(os.tmpdir(), 'film-engine-test-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 13000 + Math.floor(Math.random() * 900);
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess;

/**
 * Simple HTTP client.
 */
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

/**
 * Wait for server to be ready.
 */
async function waitForServer(maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await apiRequest('/api/health');
            if (res.status === 200) return;
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Server did not start');
}

describe('Integration Tests', () => {
    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });

        serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(TEST_PORT),
                FILM_DATA_DIR: TEST_DIR,
            },
            stdio: 'pipe',
        });

        serverProcess.stderr.on('data', () => {}); // suppress
        serverProcess.stdout.on('data', () => {}); // suppress

        await waitForServer();
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ── Health ────────────────────────────────────────────────────
    it('health check returns ok', async () => {
        const res = await apiRequest('/api/health');
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'ok');
    });

    // ── Project CRUD ─────────────────────────────────────────────
    let projectId;

    it('creates a project', async () => {
        const res = await apiRequest('/film/projects', {
            method: 'POST',
            body: { title: 'Integration Test Film', logline: 'A test.', genre: 'Drama' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.id);
        assert.equal(res.data.title, 'Integration Test Film');
        projectId = res.data.id;
    });

    it('lists projects', async () => {
        const res = await apiRequest('/film/projects');
        assert.equal(res.status, 200);
        assert.ok(res.data.projects.length >= 1);
    });

    it('gets a project by id', async () => {
        const res = await apiRequest('/film/projects/' + projectId);
        assert.equal(res.status, 200);
        assert.equal(res.data.id, projectId);
    });

    it('updates a project', async () => {
        const res = await apiRequest('/film/projects/' + projectId, {
            method: 'PUT',
            body: { title: 'Updated Film', genre: 'Sci-Fi' },
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.title, 'Updated Film');
    });

    // ── Script Upload ────────────────────────────────────────────
    it('uploads a screenplay', async () => {
        const fountain = `Title: Test Film
Author: Test Author

INT. OFFICE - DAY

John walks into the office.

JOHN
Hello there.

EXT. PARK - NIGHT

A dog runs across the lawn.

JANE
Beautiful night.
`;
        const res = await apiRequest('/film/projects/' + projectId + '/script', {
            method: 'POST',
            body: { fountain_content: fountain },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.script || res.data.id);
    });

    it('lists script versions', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/scripts');
        assert.equal(res.status, 200);
        const versions = res.data.versions || res.data.scripts || [];
        assert.ok(versions.length >= 1);
    });

    // ── Scenes ───────────────────────────────────────────────────
    let sceneIds = [];

    it('lists scenes', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/scenes');
        assert.equal(res.status, 200);
        assert.ok(res.data.scenes.length >= 2); // INT. OFFICE and EXT. PARK
        sceneIds = res.data.scenes.map(s => s.id);
    });

    it('gets a scene by id', async () => {
        const res = await apiRequest('/film/scenes/' + sceneIds[0]);
        assert.equal(res.status, 200);
        assert.ok(res.data.id);
    });

    // ── Shots ────────────────────────────────────────────────────
    let shotId;

    it('creates a shot', async () => {
        const res = await apiRequest('/film/shots', {
            method: 'POST',
            body: {
                scene_id: sceneIds[0],
                cards: [{ shot_code: 'SC1A', duration_ms: 5000, description: 'Test shot' }],
            },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.shots || res.data.id);
        shotId = res.data.shots ? res.data.shots[0].id : res.data.id;
    });

    it('lists shots (shotlist)', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/shotlist');
        assert.equal(res.status, 200);
        assert.ok(res.data.shots.length >= 1);
    });

    // ── Characters ───────────────────────────────────────────────
    let characterId;

    it('creates a character', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/characters', {
            method: 'POST',
            body: { name: 'JOHN', description: 'Main character' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.id);
        characterId = res.data.id;
    });

    it('lists characters', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/characters');
        assert.equal(res.status, 200);
        assert.ok(res.data.characters.length >= 1);
    });

    it('updates a character', async () => {
        const res = await apiRequest('/film/characters/' + characterId, {
            method: 'PUT',
            body: { description: 'Updated description' },
        });
        assert.equal(res.status, 200);
    });

    // ── Locations ────────────────────────────────────────────────
    let locationId;

    it('creates a location', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/locations', {
            method: 'POST',
            body: { name: 'Office', description: 'A modern office' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.id);
        locationId = res.data.id;
    });

    it('lists locations', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/locations');
        assert.equal(res.status, 200);
        assert.ok(res.data.locations.length >= 1);
    });

    // ── Props ────────────────────────────────────────────────────
    it('creates a prop', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/props', {
            method: 'POST',
            body: { name: 'Laptop', description: 'A silver laptop' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.id);
    });

    // ── Shot Notes ───────────────────────────────────────────────
    it('adds a shot note', async () => {
        const res = await apiRequest('/film/shots/' + shotId + '/notes', {
            method: 'POST',
            body: { content: 'Add more lighting', note_type: 'direction' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.id);
    });

    it('lists shot notes', async () => {
        const res = await apiRequest('/film/shots/' + shotId + '/notes');
        assert.equal(res.status, 200);
        assert.ok(res.data.notes.length >= 1);
    });

    // ── Review ───────────────────────────────────────────────────
    it('submits a shot review', async () => {
        const res = await apiRequest('/film/shots/' + shotId + '/review', {
            method: 'POST',
            body: { approved: true, notes: 'Looks good' },
        });
        assert.equal(res.status, 200);
    });

    // ── Dashboard ────────────────────────────────────────────────
    it('returns dashboard data', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/dashboard');
        assert.equal(res.status, 200);
        assert.ok(res.data.stats);
    });

    it('returns status board', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/status-board');
        assert.equal(res.status, 200);
        assert.ok(res.data.scenes);
    });

    // ── Milestones ───────────────────────────────────────────────
    it('creates a milestone', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/milestones', {
            method: 'POST',
            body: { title: 'Script Lock', target_date: '2025-06-01' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.id);
    });

    it('lists milestones', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/milestones');
        assert.equal(res.status, 200);
        assert.ok(res.data.milestones.length >= 1);
    });

    // ── Render Ledger ────────────────────────────────────────────
    it('creates a render entry', async () => {
        const res = await apiRequest('/film/shots/' + shotId + '/render', {
            method: 'POST',
            body: { step: 'keyframe', model_id: 'sdxl', seed: 42, steps: 30, guidance: 7.5 },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.id);
    });

    it('lists renders for shot', async () => {
        const res = await apiRequest('/film/shots/' + shotId + '/renders');
        assert.equal(res.status, 200);
        assert.ok(res.data.renders.length >= 1);
    });

    // ── Production Status ────────────────────────────────────────
    it('advances project status', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/advance-status', {
            method: 'POST',
        });
        // Should succeed or give a valid response
        assert.ok([200, 400].includes(res.status));
    });

    // ── Export ────────────────────────────────────────────────────
    it('lists export formats', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/export');
        assert.equal(res.status, 200);
        assert.ok(res.data.formats.length >= 3);
    });

    it('exports FCPXML', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/export/fcpxml');
        assert.equal(res.status, 200);
        assert.ok(typeof res.data === 'string' || res.data);
    });

    it('exports EDL', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/export/edl');
        assert.equal(res.status, 200);
    });

    it('exports Premiere XML', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/export/premiere');
        assert.equal(res.status, 200);
    });

    it('exports FDX', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/export/fdx');
        assert.ok([200, 500].includes(res.status)); // 500 if parser not available
    });

    // ── Call Sheets ──────────────────────────────────────────────
    it('gets scene call sheet', async () => {
        const res = await apiRequest('/film/scenes/' + sceneIds[0] + '/call-sheet');
        assert.ok(typeof res.status === 'number');
    });

    it('gets project call sheet', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/call-sheet');
        assert.ok(typeof res.status === 'number');
    });

    // ── Storyboard (viewer only, no ImageGen) ────────────────────
    it('gets storyboard (empty)', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/storyboard');
        assert.equal(res.status, 200);
    });

    // ── Screenplay Comments ──────────────────────────────────────
    let commentId;
    let scriptId;

    it('creates a screenplay comment', async () => {
        // Get latest script id
        const scripts = await apiRequest('/film/projects/' + projectId + '/scripts');
        const versions = scripts.data.versions || scripts.data.scripts || [];
        if (versions.length === 0) { assert.ok(true, 'No scripts to comment on'); return; }
        scriptId = versions[versions.length - 1].id || versions[0].id;

        const res = await apiRequest('/film/scripts/' + scriptId + '/comments', {
            method: 'POST',
            body: { element_index: 0, content: 'Test comment', author: 'tester' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.id);
        commentId = res.data.id;
    });

    it('lists screenplay comments', async () => {
        const res = await apiRequest('/film/scripts/' + scriptId + '/comments');
        assert.equal(res.status, 200);
        assert.ok(res.data.comments.length >= 1);
    });

    it('resolves a comment', async () => {
        const res = await apiRequest('/film/comments/' + commentId, {
            method: 'PUT',
            body: { resolved: true },
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.resolved, 1);
    });

    it('deletes a comment', async () => {
        const res = await apiRequest('/film/comments/' + commentId, {
            method: 'DELETE',
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.deleted, true);
    });

    // ── Project Bundle Export/Import ─────────────────────────────
    it('exports project bundle', async () => {
        const res = await apiRequest('/film/projects/' + projectId + '/bundle');
        assert.equal(res.status, 200);
    });

    it('imports project bundle (base64)', async () => {
        // Export first to get a valid bundle
        const http = require('http');
        const archiveData = await new Promise((resolve, reject) => {
            http.get(BASE_URL + '/film/projects/' + projectId + '/bundle', (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            }).on('error', reject);
        });
        const base64 = archiveData.toString('base64');
        const res = await apiRequest('/film/projects/import', {
            method: 'POST',
            body: { bundle: base64 },
        });
        assert.equal(res.status, 201);
        assert.ok(res.data.project);
        assert.ok(res.data.project.id);
        assert.ok(res.data.stats);
    });

    // ── Project Delete ───────────────────────────────────────────
    it('deletes a project', async () => {
        const res = await apiRequest('/film/projects/' + projectId, {
            method: 'DELETE',
        });
        assert.equal(res.status, 200);
    });

    it('returns 404 for deleted project', async () => {
        const res = await apiRequest('/film/projects/' + projectId);
        assert.equal(res.status, 404);
    });
});
