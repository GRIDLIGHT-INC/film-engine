/**
 * The page follows the database, not just the window.
 *
 * The SPA went stale whenever an agent wrote through MCP, and the obvious
 * diagnosis — "it has no framework" — is wrong. React re-renders when state in
 * the SAME process changes; these writes come from a different process against
 * the same SQLite file, which no client framework can observe. What was missing
 * is a transport.
 *
 * `PRAGMA data_version` is the mechanism, and its asymmetry is the whole design:
 * SQLite moves it when ANOTHER connection commits and leaves it alone for the
 * connection doing the writing. So the SPA's own POSTs, which go through this
 * server, raise no event — it already knows about those, and echoing them back
 * would fight the user's typing — while an MCP write does.
 *
 * That asymmetry is the thing worth pinning. Everything else is plumbing.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DIR = path.join(os.tmpdir(), 'film-engine-live-' + crypto.randomUUID().slice(0, 8));
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR || DIR;

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { dataVersion } = require('../routes/events');
const Database = require('better-sqlite3');

const DB_PATH = path.join(process.env.FILM_DATA_DIR, 'film-engine.db');

test('a write from another connection moves the version', () => {
    const before = dataVersion();
    assert.ok(before !== null, 'data_version is unreadable, so nothing can be detected at all');

    const other = new Database(DB_PATH);
    other.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(generateId(), 'From Elsewhere');
    other.close();

    assert.notStrictEqual(dataVersion(), before,
        'a write from another process was invisible, which is the only case this exists for');
});

test('our own writes raise nothing, so the page never fights the user', () => {
    // If the server's own writes fired an event, every keystroke saved from the
    // SPA would reload the page underneath whoever typed it.
    const before = dataVersion();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(generateId(), 'From Here');
    assert.strictEqual(dataVersion(), before,
        'the server echoes its own writes back to the client');
});

test('reading twice does not itself look like a change', () => {
    const a = dataVersion();
    assert.strictEqual(dataVersion(), a, 'the poll reports a change every time it runs');
});

test('the stream says hello before it says change', () => {
    // A client that cannot tell "here is where we are" from "something just
    // happened" reloads once on every reconnect, which on a flaky connection is
    // a page that never settles.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'events.js'), 'utf8');
    assert.ok(/type: 'hello'/.test(src), 'the stream never states the current version');
    assert.ok(/keepalive/.test(src), 'an idle stream is indistinguishable from a dead one');
    assert.ok(/req\.on\('close'/.test(src), 'a disconnected client leaves a timer running forever');
});

test('the page defers a refresh rather than dropping it', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/function liveConnect\(/.test(html), 'the page never connects to the stream');
    assert.ok(/liveConnect\(\);/.test(html.slice(html.indexOf('loadProjects();'))),
        'liveConnect is defined and never called');
    // Reloading the page while someone is typing loses their work; dropping the
    // refresh instead leaves the page wrong for as long as the modal is open,
    // and they close it expecting to see the result.
    assert.ok(/LIVE\.pending = true/.test(html), 'a refresh during editing is dropped rather than deferred');
    assert.ok(/function liveBusy\(/.test(html), 'the page reloads underneath an open modal');
});
