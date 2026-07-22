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
const TEST_PORT = 17100 + Math.floor(Math.random() * 700);
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
        const res = await request(`/film/projects/${projectId}/providers`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.data.config, {});
        assert.equal(res.data.effective.image, 'gridlight');
        assert.equal(res.data.effective.voice, 'gridlight');
    });

    it('persists a valid per-project provider choice and filters unknown ones', async () => {
        const res = await request(`/film/projects/${projectId}/providers`, {
            method: 'PUT', body: { config: { image: 'gridlight', video: 'does-not-exist' } },
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.config.image, 'gridlight');   // registered → kept
        assert.equal(res.data.config.video, undefined);      // unknown → filtered
        // Effective still resolves everything.
        assert.equal(res.data.effective.video, 'gridlight');
    });

    it('404s provider config for an unknown project', async () => {
        const res = await request('/film/projects/11111111-1111-4111-8111-111111111111/providers');
        assert.equal(res.status, 404);
    });

    it('exposes connection specs in the catalog (Artlist MCP oauth + catalog fields)', async () => {
        const res = await request('/film/providers');
        const mcp = res.data.providers.find(p => p.id === 'artlist-mcp');
        const cat = res.data.providers.find(p => p.id === 'artlist-catalog');
        assert.ok(mcp && mcp.connection && mcp.connection.oauth, 'artlist-mcp exposes oauth connection');
        assert.equal(mcp.connection.oauth.connectPath, '/providers/artlist-mcp/connect');
        assert.ok(cat && cat.connection && Array.isArray(cat.connection.fields), 'artlist-catalog exposes fields');
        assert.ok(cat.connection.fields.some(f => f.key === 'client_id'));
    });

    it('stores multi-field credentials in meta and reports masked field status', async () => {
        const res = await request('/film/providers/artlist-catalog/credentials', {
            method: 'PUT', body: { fields: { client_id: 'CID-123', client_secret: 'SECRET-xyz' } },
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.credentials.fields.client_id, true);
        assert.equal(res.data.credentials.fields.client_secret, true);
        // Never echo raw values.
        assert.ok(!res.raw.includes('SECRET-xyz'));
        assert.ok(!res.raw.includes('CID-123'));
    });

    it('rejects OAuth connect for a provider without oauth', async () => {
        const res = await request('/film/providers/openai/connect');
        assert.equal(res.status, 400);
    });
});
