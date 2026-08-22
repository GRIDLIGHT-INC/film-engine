#!/usr/bin/env node
/**
 * Film Engine MCP server — stdio transport, hand-rolled JSON-RPC.
 *
 * Exposes the flows graph engine as tools so an agent can author, cost, run and
 * inspect a flow, or execute one node in isolation, without going through the
 * SPA. The tool list is generated in lib/mcp-tools.js from the same registries
 * the canvas reads, so it cannot fall behind the palette.
 *
 * WHY NO SDK. The backend has exactly one dependency (better-sqlite3) and
 * ADR-002 rejects frameworks for the HTTP layer on the same reasoning: this
 * server answers four methods over newline-delimited JSON on stdin/stdout, and
 * @modelcontextprotocol/sdk would be a larger surface than the thing it wraps.
 * The protocol edges that actually matter are pinned by tests/mcp-tools.test.js
 * — notifications draw no reply, unknown methods return -32601, and a tool that
 * fails returns isError rather than a protocol error.
 *
 * Usage:  node backend/mcp-server.js        (a client spawns this; it speaks
 *                                            JSON-RPC on stdio, not to a human)
 *
 * Env: FILM_DATA_DIR — the database this server reads and writes. Defaults to
 *      the same location the HTTP server uses, so both see one project set.
 */

const readline = require('readline');

// Protocol versions this server understands. We echo the client's when we know
// it, so a newer client is not told to downgrade over a difference we do not use.
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = SUPPORTED_PROTOCOLS[0];

const SERVER_INFO = { name: 'film-engine', version: '0.1.0' };

const INSTRUCTIONS = [
    'Film Engine turns a screenplay into shots and generates the media for them.',
    'Tools come in two families.',
    'flow_* tools operate on whole graphs: list them, read one, validate it, estimate its cost, run it, inspect the run.',
    'node_* tools execute a single node type in isolation — useful for trying one generation before committing to a run.',
    'Read flow_node_types before authoring a graph; call flow_validate before flow_run; call flow_estimate before any fan-out.',
    'Anything named gen.* resolves a provider and spends money.',
].join(' ');

let tools = null;   // lazily required: importing opens the database

function api() {
    if (!tools) tools = require('./lib/mcp-tools');
    return tools;
}

// ── JSON-RPC plumbing ───────────────────────────────────────────────────────

function send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
    send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

/** A tool result becomes text content; failure is flagged, not thrown. */
function toolResult(result) {
    const shown = api().presentResult(result);
    const text = typeof shown === 'string' ? shown : JSON.stringify(shown, null, 2);
    const out = { content: [{ type: 'text', text }] };
    if (api().isFailure(result)) out.isError = true;
    return out;
}

const METHODS = {
    initialize(params) {
        const asked = params && params.protocolVersion;
        return {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
        };
    },

    ping() {
        return {};
    },

    'tools/list'() {
        return { tools: api().listTools() };
    },

    async 'tools/call'(params) {
        const name = params && params.name;
        if (!name) throw Object.assign(new Error('tools/call requires a name'), { code: -32602 });

        const args = (params && params.arguments) || {};
        const started = Date.now();
        const result = await api().callTool(name, args);

        // An unadvertised name is the caller's mistake about the protocol, not
        // a tool that ran badly, so it is a JSON-RPC error.
        if (result && result.unknownTool) {
            throw Object.assign(new Error(result.error), { code: -32602 });
        }

        const payload = toolResult(result);
        meterHostCall(name, args, payload, Date.now() - started);
        return payload;
    },
};


/**
 * Every tool call is subscription traffic, so every tool call is metered.
 *
 * This server is driven by an agent host — Claude Desktop, ChatGPT Desktop —
 * and the host IS the model. Nothing here is billed per call, but the payloads
 * moving through this function draw down the user's subscription window, which
 * is the resource that actually runs out mid-breakdown. Metering at
 * `tools/call` rather than per tool is the same choice made for providers: one
 * choke point, so a tool added later is covered with nothing to remember.
 *
 * The project is taken from the arguments where a tool names one — most do —
 * so subscription use can be attributed to a film. A tool with no project id
 * is still recorded, unattributed, because the tokens were spent either way.
 *
 * Never throws. The tool has already run and the model is waiting on its
 * result; bookkeeping does not get to turn that into an error.
 */
function meterHostCall(name, args, payload, durationMs) {
    try {
        const { recordHostUsage } = require('./lib/mcp-usage');
        recordHostUsage({
            host: process.env.MCP_HOST || 'claude-desktop',
            tool: name,
            projectId: args && (args.project_id || args.projectId) || null,
            shotId: args && (args.shot_id || args.shotId) || null,
            sceneId: args && (args.scene_id || args.sceneId) || null,
            inboundChars: JSON.stringify(args || {}).length,
            outboundChars: JSON.stringify(payload || {}).length,
            durationMs,
        });
    } catch (_) { /* metering never breaks a completed call */ }
}

async function handle(message) {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    const fn = METHODS[method];
    if (!fn) {
        // Notifications never draw a response, not even an error — including
        // notifications/initialized, which every client sends.
        if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
        return;
    }

    try {
        const result = await fn(params);
        if (!isNotification) reply(id, result);
    } catch (err) {
        if (!isNotification) fail(id, err.code || -32603, err.message || 'Internal error');
    }
}

function main() {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    // Serialised: tools/call reaches the database and a provider, and two
    // concurrent runs interleaving their writes is not worth the parallelism.
    let queue = Promise.resolve();

    rl.on('line', line => {
        const text = line.trim();
        if (!text) return;

        let message;
        try {
            message = JSON.parse(text);
        } catch (_) {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
        }

        queue = queue.then(() => handle(message)).catch(err => {
            process.stderr.write(`[mcp] unhandled: ${err && err.message}\n`);
        });
    });

    // When stdout is a pipe its writes are asynchronous, so exiting the moment
    // the queue drains truncates replies already handed to it — the first reply
    // survived and every later one vanished. The empty write's callback fires
    // once everything before it has flushed.
    rl.on('close', () => {
        queue.then(() => process.stdout.write('', () => process.exit(0)));
    });
}

if (require.main === module) main();

module.exports = { METHODS, handle, SUPPORTED_PROTOCOLS, SERVER_INFO };
