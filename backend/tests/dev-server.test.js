/**
 * AN EDIT YOU CANNOT SEE IS AN EDIT THAT DID NOT HAPPEN.
 *
 * The page was served by `python -m http.server`, which sends Last-Modified and
 * no Cache-Control. A browser treats that as licence to reuse its copy without
 * asking, so every change to index.html required a forced reload — and the
 * failure is silent and misleading: the control is in the file on disk and
 * absent from the page that is loaded, so pressing it calls a function that
 * does not exist and nothing happens at all.
 *
 * That cost a round trip today ("that button does nothing") and had been
 * costing one after nearly every change: the phrase "hard-refresh" appears at
 * the end of most of this week's work.
 *
 * No dependency, per ADR-002 — this is Node's own http and fs, which is what
 * the decision is about. The backend still has exactly one.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { createDevServer } = require('../dev-server');
const ROOT = path.join(__dirname, '..', '..', 'src');

function listen() {
    return new Promise(resolve => {
        const server = createDevServer(ROOT);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

const get = (port, p) => new Promise(resolve => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
            status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
        }));
    }).on('error', err => resolve({ status: 0, headers: {}, body: Buffer.from(String(err.message)) }));
});

test('the page is served, and never from a cache', async () => {
    const { server, port } = await listen();
    try {
        const res = await get(port, '/');
        assert.strictEqual(res.status, 200, 'the page is not served at all');
        assert.ok(res.body.includes('<!DOCTYPE html'), 'that is not the page');
        assert.match(String(res.headers['content-type'] || ''), /text\/html/);

        /*
         * no-store rather than no-cache: no-cache still permits a stored copy
         * revalidated by ETag, and a revalidation that answers 304 is exactly
         * the stale page this exists to prevent.
         */
        const cache = String(res.headers['cache-control'] || '');
        assert.match(cache, /no-store/,
            `served with Cache-Control "${cache}" — a browser may reuse its copy, and an edit that is `
            + 'on disk and not in the page is a control that does nothing when pressed');
        assert.ok(!res.headers.etag && !res.headers['last-modified'],
            'a validator is sent, which invites the 304 this is meant to avoid');
    } finally { server.close(); }
});

test('an edit is visible on the very next request', async () => {
    const { server, port } = await listen();
    const probe = path.join(ROOT, '.dev-server-probe.txt');
    try {
        fs.writeFileSync(probe, 'first');
        const a = await get(port, '/.dev-server-probe.txt');
        assert.strictEqual(a.body.toString(), 'first');

        fs.writeFileSync(probe, 'second');
        const b = await get(port, '/.dev-server-probe.txt');
        assert.strictEqual(b.body.toString(), 'second',
            'the server answered with the previous contents — it is holding the file itself');
    } finally {
        server.close();
        try { fs.unlinkSync(probe); } catch (_) { /* fine */ }
    }
});

test('nothing outside the served directory can be reached', async () => {
    /*
     * A dev server binds to localhost and is still a server. The database, the
     * git directory and every provider credential sit one level up from src/.
     */
    const { server, port } = await listen();
    try {
        for (const attack of [
            '/../backend/server.js',
            '/../../etc/passwd',
            '/..%2f..%2fbackend%2fserver.js',
            '/%2e%2e/%2e%2e/backend/lib/providers/credentials.js',
        ]) {
            const res = await get(port, attack);
            assert.ok(res.status === 403 || res.status === 404,
                `${attack} returned ${res.status} — it escaped the served directory`);
            assert.ok(!res.body.includes('require('),
                `${attack} returned source from outside src/`);
        }
    } finally { server.close(); }
});

test('the content types the page actually needs', async () => {
    const { server, port } = await listen();
    try {
        const json = await get(port, '/app.json');
        if (json.status === 200) {
            assert.match(String(json.headers['content-type'] || ''), /application\/json/,
                'app.json is served as the wrong type');
        }
        const missing = await get(port, '/does-not-exist.html');
        assert.strictEqual(missing.status, 404, 'a missing file is not a 404');
    } finally { server.close(); }
});
