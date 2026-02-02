/**
 * Test helpers for integration tests.
 *
 * Uses the real database module with a temporary data directory.
 * Requires FILM_DATA_DIR to be set before any imports.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/**
 * Create a temporary data directory for test isolation.
 * Must be called BEFORE requiring database.js or server.js.
 */
function createTestDir() {
    const dir = path.join(os.tmpdir(), 'film-engine-test-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Simple HTTP client for testing.
 */
function testApi(baseUrl) {
    return async function request(path, opts = {}) {
        const url = baseUrl + path;
        const method = opts.method || 'GET';
        const body = opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;

        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const reqOpts = {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method,
                headers: { 'Content-Type': 'application/json' },
            };

            const req = http.request(reqOpts, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    let parsed;
                    try { parsed = JSON.parse(data); } catch { parsed = data; }
                    resolve({ status: res.statusCode, data: parsed, headers: res.headers });
                });
            });

            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    };
}

/**
 * Create a test project with script and scenes.
 * Returns { project, script, scenes }.
 */
async function createTestProject(api) {
    // Create project
    const projRes = await api('/film/projects', {
        method: 'POST',
        body: { title: 'Test Film', logline: 'A test film for integration testing.', genre: 'Drama' },
    });
    const project = projRes.data;

    // Upload a simple Fountain script
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

    const scriptRes = await api('/film/projects/' + project.id + '/script', {
        method: 'POST',
        body: { content: fountain, format: 'fountain' },
    });
    const script = scriptRes.data;

    // Get scenes
    const scenesRes = await api('/film/projects/' + project.id + '/scenes');
    const scenes = scenesRes.data.scenes || [];

    return { project, script, scenes };
}

module.exports = { createTestDir, testApi, createTestProject };
