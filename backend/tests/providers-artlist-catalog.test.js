/**
 * Unit tests for the Artlist Catalog source adapter.
 * Uses a local HTTP mock; no real Artlist API calls.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-artlist-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
db.exec('CREATE TABLE IF NOT EXISTS film_provider_credentials (provider TEXT PRIMARY KEY, api_key TEXT DEFAULT "", meta TEXT DEFAULT "{}")');

const providers = require('../lib/providers');
const {
    adapter,
    buildSearchUrl,
    normalizeAsset,
    normalizeList,
} = require('../lib/providers/artlist-catalog');

let server;
let baseUrl;
let tokenRequests = 0;
let lastRequest = null;

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => resolve(body));
    });
}

function saveCredential(meta) {
    db.prepare(
        `INSERT INTO film_provider_credentials (provider, api_key, meta)
         VALUES ('artlist-catalog', '', ?)
         ON CONFLICT(provider) DO UPDATE SET meta = excluded.meta`
    ).run(JSON.stringify(meta));
}

describe('providers/artlist-catalog', () => {
    before(async () => {
        server = http.createServer(async (req, res) => {
            const rawBody = await readBody(req);
            lastRequest = { method: req.method, url: req.url, headers: req.headers, rawBody };

            if (req.url === '/oauth/token' && req.method === 'POST') {
                tokenRequests++;
                if (!rawBody.includes('client_id=client-123') || !rawBody.includes('client_secret=secret-456')) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error_description: 'bad client' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600 }));
                return;
            }

            if (req.url.startsWith('/search/song')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    data: [{
                        id: 'song-1',
                        title: 'Night Drive',
                        artist_name: 'Artlist Artist',
                        stream_url: 'https://cdn.example/preview.mp3',
                        duration_seconds: 92,
                        license_type: 'enterprise',
                        territory: 'worldwide',
                    }],
                }));
                return;
            }

            if (req.url.startsWith('/search/sfx')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ items: [{ sfx_id: 'sfx-1', name: 'Door Slam', preview_url: 'https://cdn.example/sfx.mp3' }] }));
                return;
            }

            if (req.url.startsWith('/search/footage')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ results: [{ footage_id: 'clip-1', asset_name: 'City Aerial', video_url: 'https://cdn.example/clip.mp4' }] }));
                return;
            }

            if (req.url === '/song/song-1/download') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'song-1',
                    title: 'Night Drive',
                    download_url: 'https://cdn.example/night-drive.wav',
                    license_status: 'licensed',
                    license_type: 'enterprise',
                    license_expiry: '2027-01-01',
                    territory: 'worldwide',
                }));
                return;
            }

            if (req.url.startsWith('/search/fail')) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'mock search failure' }));
                return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'not found' }));
        });

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        process.env.ARTLIST_BASE_URL = baseUrl;
    });

    beforeEach(() => {
        tokenRequests = 0;
        lastRequest = null;
        adapter._clearTokenCache();
        saveCredential({ client_id: 'client-123', client_secret: 'secret-456' });
    });

    after(() => {
        if (server) server.close();
        try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
        delete process.env.ARTLIST_BASE_URL;
    });

    it('registers through provider autoload and declares source connection fields', () => {
        assert.equal(adapter.id, 'artlist-catalog');
        assert.equal(adapter.kind, 'source');
        assert.equal(adapter.requiresKey, false);
        assert.equal(adapter.supports('music'), true);
        assert.equal(adapter.supports('sfx'), true);
        assert.equal(adapter.supports('stock'), true);
        assert.equal(adapter.supports('voice'), false);
        assert.equal(providers.get('artlist-catalog').id, 'artlist-catalog');
        assert.ok(adapter.connection.instructions.includes('Enterprise'));
        assert.deepEqual(adapter.connection.fields.map(f => f.key), ['client_id', 'client_secret', 'base_url']);
    });

    it('builds search URLs with Artlist-style query parameters', () => {
        const url = buildSearchUrl('music', { query: 'dark pulse', bpm: 90, limit: 5 }, { base_url: baseUrl });
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/search\/song\?/);
        assert.ok(url.includes('query=dark+pulse'));
        assert.ok(url.includes('bpm=90'));
        assert.ok(url.includes('limit=5'));
    });

    it('normalizes common response list shapes and asset fields', () => {
        assert.equal(normalizeList({ data: [{ id: 1 }] }).length, 1);
        assert.equal(normalizeList({ items: [{ id: 1 }] }).length, 1);
        assert.equal(normalizeList({ results: [{ id: 1 }] }).length, 1);

        const item = normalizeAsset({ song_id: 'abc', song_name: 'Cue', artist_name: 'Composer', stream_url: 'preview' }, 'music');
        assert.equal(item.providerAssetId, 'abc');
        assert.equal(item.title, 'Cue');
        assert.equal(item.artist, 'Composer');
        assert.equal(item.preview, 'preview');
        assert.equal(item.license.source, 'licensed_catalog');
        assert.equal(item.license.holder, 'Artlist');
    });

    it('searches music through OAuth client credentials and normalizes results', async () => {
        const result = await adapter.search('music', { query: 'night drive', vocal: false, limit: 10 });

        assert.equal(result.ok, true);
        assert.equal(tokenRequests, 1);
        assert.equal(lastRequest.headers.authorization, 'Bearer mock-access-token');
        assert.equal(result.results.length, 1);
        assert.equal(result.results[0].providerAssetId, 'song-1');
        assert.equal(result.results[0].title, 'Night Drive');
        assert.equal(result.results[0].artist, 'Artlist Artist');
        assert.equal(result.results[0].license.type, 'enterprise');
    });

    it('searches sfx and stock capabilities with separate endpoint defaults', async () => {
        const sfx = await adapter.search('sfx', { query: 'slam' });
        assert.equal(sfx.ok, true);
        assert.equal(sfx.results[0].providerAssetId, 'sfx-1');
        assert.equal(sfx.results[0].title, 'Door Slam');

        const stock = await adapter.search('stock', { query: 'city' });
        assert.equal(stock.ok, true);
        assert.equal(stock.results[0].providerAssetId, 'clip-1');
        assert.equal(stock.results[0].title, 'City Aerial');
    });

    it('licenses an asset and returns a download URL plus license metadata', async () => {
        const result = await adapter.license('music', 'song-1');

        assert.equal(result.ok, true);
        assert.equal(result.providerAssetId, 'song-1');
        assert.equal(result.downloadUrl, 'https://cdn.example/night-drive.wav');
        assert.equal(result.license.status, 'licensed');
        assert.equal(result.license.type, 'enterprise');
        assert.equal(result.license.expiry, '2027-01-01');
        assert.equal(result.license.territory, 'worldwide');
    });

    it('caches access tokens across calls', async () => {
        const first = await adapter.search('music', { query: 'one' });
        const second = await adapter.search('music', { query: 'two' });

        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        assert.equal(tokenRequests, 1);
    });

    it('returns structured errors for missing credentials and unsupported capability', async () => {
        db.prepare('DELETE FROM film_provider_credentials WHERE provider = ?').run('artlist-catalog');
        const missing = await adapter.search('music', { query: 'x' });
        assert.equal(missing.ok, false);
        assert.equal(missing.status, 401);
        assert.match(missing.error, /missing client_id/);

        saveCredential({ client_id: 'client-123', client_secret: 'secret-456' });
        const unsupported = await adapter.search('voice', { query: 'x' });
        assert.equal(unsupported.ok, false);
        assert.equal(unsupported.status, 400);
    });

    it('surfaces upstream search errors', async () => {
        saveCredential({
            client_id: 'client-123',
            client_secret: 'secret-456',
            search_paths: { music: '/search/fail' },
        });
        adapter._clearTokenCache();

        const result = await adapter.search('music', { query: 'fail' });
        assert.equal(result.ok, false);
        assert.equal(result.status, 500);
        assert.match(result.error, /mock search failure/);
    });
});
