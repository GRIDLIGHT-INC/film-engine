/**
 * ── Which build is this connection actually serving? ────────────────────────
 *
 * An agent host spawns backend/mcp-server.js ONCE, at app start, and keeps that
 * process for the life of the connection. `tools/list` is answered from a
 * registry built when the process loaded. So every tool shipped after the host
 * started is invisible, and the host has no way to tell that from the tool
 * never having existed.
 *
 * That is not hypothetical. Four analysis tools shipped at 08:26; the host's
 * process had started at 13:54 the previous day. Asked to use them, the
 * connected model checked the name, searched the catalogue by keyword,
 * re-queried the server, correctly found nothing — and concluded the feature
 * was unbuilt, offering to design the pair that already existed. Every step of
 * that reasoning was sound. The information it needed was not reachable.
 *
 * IT IS NOT REACHABLE THROUGH THE TOOL LIST, and that is the whole design
 * problem: a stale process serves a stale list, so a diagnostic TOOL would be
 * missing from exactly the connections that need it. Only two channels reach a
 * stale process — `serverInfo` at initialize, and the error returned when a
 * tool is called by a name the build does not have. Both are used.
 *
 * The check is a real diff, not a timestamp: it re-reads the registry from disk
 * and compares the NAMES a fresh process would serve against the ones this one
 * is serving. "Something changed" would fire on any edit and be ignored within
 * a day; "this connection is missing analysis_brief, analysis_write" is a
 * sentence someone can act on.
 */

const fs = require('fs');
const path = require('path');

/*
 * The modules that decide WHICH TOOLS EXIST — not which behave how.
 *
 * Route modules change behaviour and are deliberately excluded: including them
 * would flag the surface as changed on every edit anywhere in the backend, and
 * a warning that is always on is one people learn to ignore, taking the real
 * one with it.
 */
const SURFACE_MODULES = Object.freeze([
    path.join(__dirname, 'mcp-tools.js'),        // every tool is declared here
    path.join(__dirname, 'flow-node-types.js'),  // the node_* tools are generated from this
]);

const LOADED_AT = new Date().toISOString();

function mtimeOf(file) {
    try { return fs.statSync(file).mtimeMs; } catch (_) { return null; }
}

const LOADED_MTIMES = SURFACE_MODULES.map(mtimeOf);

/**
 * The names this process is serving, from the registry it loaded.
 *
 * NULL rather than an empty list when it cannot be read. An empty list compares
 * as "this connection is missing all 206 tools", which would turn a momentary
 * failure to read the registry into a message telling the director their entire
 * connection is stale — confidently, and wrongly. Cannot-tell is a third answer
 * and it has to be sayable.
 */
function liveNames() {
    try { return require('./mcp-tools').listTools().map(t => t.name).sort(); } catch (_) { return null; }
}

/**
 * The names a process started right now would serve.
 *
 * Only the surface modules are evicted from the cache — the routes they
 * reference stay loaded, so this re-reads the declarations without
 * re-executing anything that opens a database or a socket. The cache is put
 * back exactly as it was: a diagnostic that leaves the process in a different
 * state than it found it is worse than no diagnostic.
 */
function diskNames() {
    const saved = SURFACE_MODULES.map(f => require.cache[f]);
    try {
        SURFACE_MODULES.forEach(f => { delete require.cache[f]; });
        const fresh = require(SURFACE_MODULES[0]);
        return fresh.listTools().map(t => t.name).sort();
    } catch (_) {
        return null;                       // unreadable on disk: report unknown, never guess
    } finally {
        SURFACE_MODULES.forEach((f, i) => {
            if (saved[i]) require.cache[f] = saved[i]; else delete require.cache[f];
        });
    }
}

/**
 * Has the tool surface moved since this process loaded?
 *
 * Never throws: this runs inside an error path and while answering
 * `initialize`, and a diagnostic that can break either is worse than the
 * confusion it exists to prevent.
 */
function surfaceDrift() {
    try {
        const now = SURFACE_MODULES.map(mtimeOf);
        // The common case is one stat per file and no re-require at all.
        if (now.every((m, i) => m === LOADED_MTIMES[i])) {
            return { stale: false, missing: [], removed: [] };
        }
        const live = liveNames();
        const disk = diskNames();
        // Either side unreadable means the comparison cannot be made. Saying
        // nothing is right here: the failure this exists to prevent is a
        // confident wrong answer.
        if (!disk || !live) return { stale: false, missing: [], removed: [], unreadable: true };

        const liveSet = new Set(live);
        const diskSet = new Set(disk);
        const missing = disk.filter(n => !liveSet.has(n));
        const removed = live.filter(n => !diskSet.has(n));
        return { stale: missing.length > 0 || removed.length > 0, missing, removed };
    } catch (_) {
        return { stale: false, missing: [], removed: [] };
    }
}

/**
 * One sentence for a model that just asked for a tool this build does not have.
 *
 * Names the tools it is missing, because "restart your client" with nothing
 * behind it reads as a shrug — and because the model's next move should be to
 * tell the person which capability is on the other side of a reconnect.
 */
function stalenessNote() {
    const drift = surfaceDrift();
    if (!drift.stale) return null;
    const bits = [];
    if (drift.missing.length) {
        bits.push(`${drift.missing.length} tool${drift.missing.length === 1 ? '' : 's'} exist on disk that this `
            + `connection does not have: ${drift.missing.slice(0, 12).join(', ')}`
            + (drift.missing.length > 12 ? `, and ${drift.missing.length - 12} more` : ''));
    }
    if (drift.removed.length) {
        bits.push(`${drift.removed.length} it serves no longer exist on disk`);
    }
    return `This MCP server process was started at ${LOADED_AT} and its tool list was fixed then. `
        + `${bits.join('; ')}. Restart the agent host (quit and reopen it) to reconnect — the `
        + 'capability is built, this connection predates it.';
}

/**
 * What a client sees at initialize.
 *
 * The version carries the build rather than a constant nobody updates: a
 * connection whose age is visible is one whose staleness can be reasoned about
 * without reading a process table.
 */
function serverInfo(base) {
    let count = 0;
    try { count = require('./mcp-tools').listTools().length; } catch (_) { count = 0; }
    return {
        ...(base || {}),
        version: `${(base && base.version) || require('../package.json').version}+${count}tools.${LOADED_AT}`,
    };
}

module.exports = { SURFACE_MODULES, LOADED_AT, surfaceDrift, stalenessNote, serverInfo };
