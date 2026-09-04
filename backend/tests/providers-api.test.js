/**
 * Integration tests for the Provider Settings API (routes/providers.js).
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

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-prov-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 19000 + Math.floor(Math.random() * 900);
const BASE_URL = `http://localhost:${TEST_PORT}`;
let serverProcess;

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
                resolve({ status: res.statusCode, data: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function waitForServer(maxRetries = 40) {
    for (let i = 0; i < maxRetries; i++) {
        try { const r = await request('/api/health'); if (r.status === 200) return; } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Server did not start');
}

describe('Provider Settings API', () => {
    let projectId;

    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: { ...process.env, PORT: String(TEST_PORT), FILM_DATA_DIR: TEST_DIR },
            stdio: 'pipe',
        });
        serverProcess.stderr.on('data', () => {});
        serverProcess.stdout.on('data', () => {});
        await waitForServer();
        const proj = await request('/film/projects', { method: 'POST', body: { title: 'Provider Test', logline: 'x' } });
        projectId = proj.data.id;
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('lists the provider catalog including gridlight', async () => {
        const res = await request('/film/providers');
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data.capabilities));
        assert.ok(res.data.capabilities.includes('image'));
        const gl = res.data.providers.find(p => p.id === 'gridlight');
        assert.ok(gl, 'gridlight should be registered');
        assert.equal(gl.kind, 'generator');
        assert.ok(gl.capabilities.includes('video'));
    });

    it('stores a credential without ever echoing the raw key', async () => {
        const res = await request('/film/providers/gridlight/credentials', {
            method: 'PUT', body: { api_key: 'sk-secret-ABCD1234' },
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.credentials.set, true);
        assert.equal(res.data.credentials.last4, '1234');
        assert.ok(!res.raw.includes('sk-secret-ABCD1234'), 'raw key must not be returned');
    });

    it('rejects an empty api_key', async () => {
        const res = await request('/film/providers/gridlight/credentials', { method: 'PUT', body: { api_key: '' } });
        assert.equal(res.status, 400);
    });

    it('404s credentials for an unknown provider', async () => {
        const res = await request('/film/providers/nope/credentials', { method: 'PUT', body: { api_key: 'x' } });
        assert.equal(res.status, 404);
    });

    it('deletes a stored credential', async () => {
        const res = await request('/film/providers/gridlight/credentials', { method: 'DELETE' });
        assert.equal(res.status, 200);
        assert.equal(res.data.credentials.set, false);
    });

    it('returns per-project provider config with effective defaults', async () => {
        /*
         * With no credentials and the local gateway switched OFF, "effective"
         * is NULL rather than the gateway. That is the honest answer: nothing
         * is configured to generate these, and reporting a provider that cannot
         * run is how a run gets started and dies at its first paid step.
         */
        const res = await request(`/film/projects/${projectId}/providers`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.data.config, {});
        assert.equal(res.data.effective.image, null);
        assert.equal(res.data.effective.voice, null);
    });

    it('persists a valid per-project provider choice and filters unknown ones', async () => {
        const res = await request(`/film/projects/${projectId}/providers`, {
            method: 'PUT', body: { config: { image: 'gridlight', video: 'does-not-exist' } },
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.config.image, 'gridlight');   // registered → kept
        assert.equal(res.data.config.video, undefined);      // unknown → filtered
        /*
         * The CHOICE is stored — the gateway is a registered provider and
         * picking it is legitimate — but it does not resolve while the switch
         * is off. Storing a pin you cannot currently use is right: turning the
         * switch on later must restore the choice rather than require it to be
         * made again.
         */
        assert.equal(res.data.effective.video, null);
        assert.equal(res.data.effective.image, null);
    });

    it('404s provider config for an unknown project', async () => {
        const res = await request('/film/projects/11111111-1111-4111-8111-111111111111/providers');
        assert.equal(res.status, 404);
    });

    it('every provider needing setup exposes a connection spec', async () => {
        // Set-based: the SPA renders a setup card from connection.oauth or
        // connection.fields, so a provider that requires a key but ships no
        // connection spec is unconfigurable from the UI.
        const res = await request('/film/providers');
        const missing = (res.data.providers || [])
            .filter(p => p.requiresKey && !p.connection)
            .map(p => p.id);
        assert.deepEqual(missing, [], `providers requiring setup with no connection spec: ${missing.join(', ')}`);
    });

    it('exposes the Runway connection spec', async () => {
        const res = await request('/film/providers');
        const runway = (res.data.providers || []).find(p => p.id === 'runway');
        assert.ok(runway, 'runway is in the catalog');
        assert.equal(runway.requiresKey, true);
        assert.ok(runway.connection && runway.connection.instructions, 'runway explains how to get a key');
        assert.deepEqual([...runway.capabilities].sort(), ['image', 'video']);
    });

    it('stores connection fields in meta without ever echoing raw values', async () => {
        // Per-field masked status is only reflected for fields an adapter
        // declares, and nothing bundled declares any today — but the endpoint is
        // live, so the guarantee that matters (secrets never come back out) is
        // still asserted here.
        const res = await request('/film/providers/runway/credentials', {
            method: 'PUT', body: { fields: { client_id: 'CID-123', client_secret: 'SECRET-xyz' } },
        });
        assert.equal(res.status, 200);
        assert.ok(!res.raw.includes('SECRET-xyz'));
        assert.ok(!res.raw.includes('CID-123'));
    });

    it('rejects OAuth connect for a provider without oauth', async () => {
        const res = await request('/film/providers/openai/connect');
        assert.equal(res.status, 400);
    });
});
