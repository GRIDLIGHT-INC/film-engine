/**
 * Is an agent host attached right now?
 *
 * The goal's stated rabbit hole is *use MCPs wherever we can for AI queries*,
 * and the answer chosen is option (c): **MCP is the default path, HTTP is the
 * fallback for when no agent host is connected.** That requires knowing which
 * situation we are in, and nothing knew.
 *
 * The signal is the MCP server itself calling a tool. That is the only evidence
 * that cannot lie: a host that is connected calls tools, and one that is not
 * cannot fake it. No handshake to keep in step, no second protocol.
 *
 * It shares `film_app_settings` because the MCP server and the HTTP server are
 * separate processes over one SQLite file — which is exactly the arrangement
 * `GET /film/events` already relies on, and the reason a heartbeat table would
 * be a second copy of something the database already does.
 *
 * **It goes stale on purpose.** A host that connected last Tuesday is not
 * attached now, and a signal that never expires would route every request to a
 * fallback that is not there. Twenty minutes is a working session with a pause
 * for lunch in it, not a promise about the next hour.
 */

const PRESENCE_WINDOW_MS = 20 * 60 * 1000;

const KEY_SEEN = 'agent_last_seen';
const KEY_CLIENT = 'agent_client';
/*
 * What the host declared it can do, verbatim, as JSON. Stored rather than
 * interpreted: the capability set grows with the protocol, and a boolean
 * distilled here would answer last year's question.
 */
const KEY_CAPS = 'agent_capabilities';

let _db = null;
function database() {
    if (!_db) _db = require('../db/database').db;
    return _db;
}

/**
 * Record that an agent host just called a tool.
 *
 * Never throws. This runs inside the MCP dispatch path, and a presence write
 * that failed must not fail the tool call it was only observing — the same rule
 * `stampAsset` follows for fingerprints.
 */
function markAgentSeen(client, capabilities) {
    try {
        const db = database();
        const put = db.prepare('INSERT OR REPLACE INTO film_app_settings (key, value) VALUES (?, ?)');
        put.run(KEY_SEEN, new Date().toISOString());
        if (client) put.run(KEY_CLIENT, String(client).slice(0, 120));
        /*
         * Only at initialize, which is the only time it is sent. Every other
         * call passes nothing and must not erase what the handshake recorded —
         * a tool call is not evidence that the host stopped supporting
         * sampling.
         */
        if (capabilities && typeof capabilities === 'object') {
            put.run(KEY_CAPS, JSON.stringify(capabilities).slice(0, 4000));
        }
    } catch (_) { /* observing must not break the thing observed */ }
}

function readSetting(key) {
    try {
        const row = database().prepare('SELECT value FROM film_app_settings WHERE key = ?').get(key);
        return row ? row.value : null;
    } catch (_) { return null; }
}

/**
 * Whether a host is attached, and when it was last heard from.
 *
 * `last_seen` is reported even when stale. "Never connected" and "connected an
 * hour ago" call for different things from a reader — the first is a setup
 * problem and the second is a reconnect — and collapsing both into `false` would
 * lose that.
 */
function agentPresence() {
    const seen = readSetting(KEY_SEEN);
    let caps = null;
    try { caps = JSON.parse(readSetting(KEY_CAPS) || 'null'); } catch (_) { caps = null; }
    const age = seen ? Date.now() - Date.parse(seen) : null;
    return {
        connected: !!(age !== null && Number.isFinite(age) && age >= 0 && age < PRESENCE_WINDOW_MS),
        last_seen: seen,
        seconds_ago: age === null || !Number.isFinite(age) ? null : Math.round(age / 1000),
        client: readSetting(KEY_CLIENT),
        capabilities: caps,
        /*
         * The actionable one, named rather than left for a reader to dig out.
         * `sampling` is what decides whether this engine can ask the attached
         * model a question instead of spending an API key on a server-side one.
         */
        can_ask_the_host: !!(caps && caps.sampling),
        can_elicit: !!(caps && caps.elicitation),
        window_seconds: Math.round(PRESENCE_WINDOW_MS / 1000),
    };
}

/**
 * What an HTTP AI response says about the path it took.
 *
 * Attached to every server-side-LLM response — success AND failure — because
 * the failure case is where it matters most: a key with no credit produces a
 * 502 the reader cannot act on, and "there is a free path and it is already
 * connected" is the actionable part of that error.
 *
 * One helper rather than three literals, or the three modules drift and only
 * one of them ends up telling the truth.
 */
function fallbackNotice(alternative) {
    const p = agentPresence();
    return {
        path: 'http',
        spent_project_key: true,
        agent_host_connected: p.connected,
        ...(alternative ? { mcp_alternative: alternative } : {}),
        note: p.connected
            ? `An agent host (${p.client || 'unknown'}) is attached and this request went to the `
                + 'server-side model anyway, spending this project\u2019s API key. Ask the connected '
                + 'model instead — it already holds the context.'
            : 'This went to the server-side model and spent this project\u2019s API key. Connect an '
                + 'agent host over MCP and the same work is done by the model you are already talking to.',
    };
}

module.exports = { markAgentSeen, agentPresence, fallbackNotice, PRESENCE_WINDOW_MS };
