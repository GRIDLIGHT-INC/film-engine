/**
 * Which path an AI request will take, and why.
 *
 *   GET /film/agent
 *
 * The goal's stated rabbit hole is *use MCPs wherever we can for AI queries*.
 * The answer is option (c): **MCP is the default path, HTTP is the fallback for
 * when no agent host is attached.** This is what lets the UI act on that rather
 * than assume it.
 *
 * The endpoint reports two things, and they are deliberately separate. Whether a
 * host is attached is a fact about right now; which MCP tools replace which HTTP
 * endpoints is a fact about the design, and is true whether or not anything is
 * connected. A page that only asked "connected?" could tell a writer their
 * request will cost money and not what to do about it.
 */

const { agentPresence } = require('../lib/agent-presence');

/**
 * Every HTTP endpoint that spends a server-side key, and what replaces it.
 *
 * Assembled from each route module's own `MCP_ALTERNATIVE` declaration rather
 * than listed here, so a sixth AI feature cannot be added without answering the
 * question. `tests/mcp-first-writing.test.js` fails if a module that imports the
 * LLM client declares nothing.
 */
function aiEndpoints() {
    const out = [];
    for (const mod of ['screenplay-ai', 'text-convert', 'breakdown']) {
        try {
            const m = require(`./${mod}`);
            for (const e of (m.MCP_ALTERNATIVE || [])) out.push(e);
        } catch (_) { /* a module that will not load is a bigger problem elsewhere */ }
    }
    return out;
}

function handleAgentPresence(req, res) {
    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    const presence = agentPresence();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ...presence,
        ai_endpoints: aiEndpoints(),
        preferred: presence.connected ? 'mcp' : 'http',
        note: presence.connected
            ? `An agent host (${presence.client || 'unknown'}) is attached. Ask it to do the writing — `
                + 'it already holds the context and costs nothing extra. The HTTP routes below still work '
                + 'and will spend this project’s API key.'
            : 'No agent host attached. The AI writing routes below will spend this project’s own API '
                + 'key. Connect Claude Desktop to the MCP server and the same work is done by the model '
                + 'you are already talking to.',
    }));
}

module.exports = { handleAgentPresence };
