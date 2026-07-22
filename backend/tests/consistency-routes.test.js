/**
 * Integration tests for the Consistency Profiles API (routes/consistency.js).
 * Spawns the real server (temp DB); no external gateway needed.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-consist-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 18100 + Math.floor(Math.random() * 600);
const BASE_URL = `http://localhost:${TEST_PORT}`;
let serverProcess;

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

describe('Consistency Profiles API', () => {
    let projectId, assetId, profileId;

    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: { ...process.env, PORT: String(TEST_PORT), FILM_DATA_DIR: TEST_DIR }, stdio: 'pipe',
        });
        serverProcess.stderr.on('data', () => {});
        serverProcess.stdout.on('data', () => {});
        await waitForServer();
        const proj = await request('/film/projects', { method: 'POST', body: { title: 'Consistency Test', logline: 'x' } });
        projectId = proj.data.id;
        // A real asset to use as a canonical reference.
        const asset = await request(`/film/projects/${projectId}/assets`, {
            method: 'POST', body: { asset_type: 'character_sheet', file_path: '/tmp/jax_front.png', file_name: 'jax_front.png' },
        });
        assetId = asset.data.id;
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('rejects an invalid profile_type', async () => {
        const res = await request(`/film/projects/${projectId}/consistency/profiles`, { method: 'POST', body: { profile_type: 'nope' } });
        assert.equal(res.status, 400);
    });

    it('creates a draft character profile', async () => {
        const res = await request(`/film/projects/${projectId}/consistency/profiles`, {
            method: 'POST', body: { profile_type: 'character', subject_id: 'char-1', subject_name: 'Jax' },
        });
        assert.equal(res.status, 201);
        assert.equal(res.data.status, 'draft');
        assert.equal(res.data.profile_type, 'character');
        profileId = res.data.id;
    });

    it('is idempotent per (project, type, subject)', async () => {
        const res = await request(`/film/projects/${projectId}/consistency/profiles`, {
            method: 'POST', body: { profile_type: 'character', subject_id: 'char-1', subject_name: 'Jax' },
        });
        assert.equal(res.data.id, profileId, 'should return the existing profile');
    });

    it('refuses to lock without a canonical reference', async () => {
        const res = await request(`/film/consistency/profiles/${profileId}/lock`, { method: 'POST', body: {} });
        assert.equal(res.status, 400);
        assert.match(res.data.error, /canonical/i);
    });

    it('rejects a canonical ref that is not a known asset', async () => {
        const res = await request(`/film/consistency/profiles/${profileId}/refs`, { method: 'POST', body: { asset_id: 'not-real' } });
        assert.equal(res.status, 400);
    });

    it('attaches a canonical reference (real asset) and locks', async () => {
        const addRef = await request(`/film/consistency/profiles/${profileId}/refs`, {
            method: 'POST', body: { asset_id: assetId, ref_role: 'canonical', weight: 0.8 },
        });
        assert.equal(addRef.status, 201);
        assert.equal(addRef.data.canonical_asset_id, assetId); // canonical ref sets the pointer
        const lock = await request(`/film/consistency/profiles/${profileId}/lock`, { method: 'POST', body: {} });
        assert.equal(lock.status, 200);
        assert.equal(lock.data.status, 'locked');
    });

    it('updates a profile (prompt contract + seed)', async () => {
        const res = await request(`/film/consistency/profiles/${profileId}`, {
            method: 'PUT', body: { prompt_contract: 'rugged bounty hunter, scar', locked_seed: 42, reference_weight: 0.75 },
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.prompt_contract, 'rugged bounty hunter, scar');
        assert.equal(res.data.locked_seed, 42);
    });

    it('lists profiles with counts', async () => {
        const res = await request(`/film/projects/${projectId}/consistency/profiles`);
        assert.equal(res.status, 200);
        assert.equal(res.data.counts.total, 1);
        assert.equal(res.data.counts.locked, 1);
    });

    it('unlocks a profile', async () => {
        const res = await request(`/film/consistency/profiles/${profileId}/unlock`, { method: 'POST', body: {} });
        assert.equal(res.data.status, 'draft');
    });

    it('returns project readiness audit', async () => {
        const res = await request(`/film/projects/${projectId}/consistency/audit`);
        assert.equal(res.status, 200);
        assert.equal(typeof res.data.ready, 'boolean');
        assert.ok(Array.isArray(res.data.shots));
    });

    it('404s a shot audit for an unknown shot', async () => {
        const res = await request('/film/shots/11111111-1111-4111-8111-111111111111/consistency/audit');
        assert.equal(res.status, 404);
    });

    it('deletes a profile', async () => {
        const res = await request(`/film/consistency/profiles/${profileId}`, { method: 'DELETE' });
        assert.equal(res.status, 200);
        const list = await request(`/film/projects/${projectId}/consistency/profiles`);
        assert.equal(list.data.counts.total, 0);
    });
});
