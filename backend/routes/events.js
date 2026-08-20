/**
 * Tell the page when something else changed the database.
 *
 * The SPA has no framework, which is not the reason it goes stale. React
 * re-renders when state in the SAME process changes; here the writes come from
 * a DIFFERENT process — an agent driving MCP against the same SQLite file — and
 * no amount of client framework can observe that. What is needed is a
 * transport, and the codebase already speaks one: every long generation streams
 * over SSE.
 *
 * `PRAGMA data_version` is the whole mechanism. SQLite increments it when
 * ANOTHER connection commits, and leaves it alone for the connection doing the
 * writing. That asymmetry is exactly the semantics wanted: the SPA's own POSTs
 * go through this server's connection and raise no event — it already knows
 * about those, and echoing them back would fight the user's own typing — while
 * a write from the MCP process does. Cost is a pragma read, which is a lookup
 * in a header page rather than a query.
 *
 * The alternative shapes were worse. Polling from the browser spends a request
 * per client per interval to learn nothing, almost always. A file watcher on
 * the .db is unreliable under WAL, where commits land in the -wal and the main
 * file may not be touched for minutes.
 *
 * GET /film/events — an event stream: `{ v }` whenever the database moved.
 */

const { db } = require('../db/database');

const POLL_MS = 1000;         // human-paced work; a second is imperceptible
const KEEPALIVE_MS = 25000;   // under the 30s idle timeout proxies commonly apply

function dataVersion() {
    try { return db.pragma('data_version', { simple: true }); } catch (_) { return null; }
}

function streamEvents(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    let last = dataVersion();
    let alive = true;

    // The first message is the current version, not a change. A client that
    // connects mid-session must be able to tell "here is where we are" from
    // "something just happened", or it reloads once on every reconnect.
    write({ type: 'hello', v: last });

    function write(payload) {
        if (!alive) return;
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { stop(); }
    }

    const poll = setInterval(() => {
        const now = dataVersion();
        if (now !== null && now !== last) {
            last = now;
            write({ type: 'change', v: now });
        }
    }, POLL_MS);

    // A comment line, which SSE ignores. Without it an idle stream is
    // indistinguishable from a dead one and gets closed by whatever is in
    // between.
    const keepalive = setInterval(() => {
        if (alive) { try { res.write(': keepalive\n\n'); } catch (_) { stop(); } }
    }, KEEPALIVE_MS);

    function stop() {
        if (!alive) return;
        alive = false;
        clearInterval(poll);
        clearInterval(keepalive);
        try { res.end(); } catch (_) { /* already gone */ }
    }

    req.on('close', stop);
    req.on('error', stop);
}

function handleEvents(req, res) {
    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
    return streamEvents(req, res);
}

module.exports = { handleEvents, dataVersion, POLL_MS };
