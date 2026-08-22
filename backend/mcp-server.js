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

/**
 * What the connected model reads before it calls anything.
 *
 * This is not the user's guide — that is docs/claude-desktop-guide.md, written
 * for a person. This is the model's orientation, and it was wrong by omission:
 * it described `flow_*` and `node_*`, which is 38 of 133 tools, so a model
 * reading it would reasonably conclude Film Engine is a graph-execution service
 * and never discover that it writes screenplays and makes films.
 *
 * Ordered by the work rather than by the registry, because the first question
 * is always "where do I start" and the answer is never "the alphabetically
 * first tool".
 */
const INSTRUCTIONS = [
    'Film Engine takes a screenplay all the way to a finished film, and every stage is here.',
    'The order of the work: write or import a screenplay → break it into shots →',
    'describe the characters, locations and props → generate reference plates for them →',
    'generate storyboard frames → block shots in 3D previs → generate video, voice and music →',
    'assemble and export to an editor.',
    '',
    'WRITING. script_get reads the screenplay; scene_append adds a chapter without re-sending',
    'the rest, which is how a novel is imported chapter by chapter; scene_insert_after puts one',
    'in the middle; scene_edit changes named phrases in place and is all-or-nothing per batch;',
    'outline_get and outline_write handle acts and synopses; beats_get reports where the',
    'structure has holes.',
    '',
    'YOU DO THE REASONING. No tool here calls another language model — writing a scene card, a',
    'character description or a screenplay is your work, and the plain data tools exist so you',
    'can do it: read with script_get, compose, then write with shot_create, character_update or',
    'scene_update. There is deliberately no breakdown or convert tool.',
    '',
    'SPENDING. Anything named gen.*, and storyboard_generate / storyboard_regenerate /',
    'storyboard_refine / plate_generate / plate_generate_all / flow_run, resolves a provider and',
    'COSTS THE USER MONEY. shot_prompt shows exactly what a frame would send and spends nothing —',
    'read it before regenerating. Ask before generating at volume.',
    '',
    'GRAPHS. flow_* tools operate on whole pipelines and node_* execute one node in isolation.',
    'Read flow_node_types before authoring a graph, flow_validate before flow_run, and',
    'flow_estimate before any fan-out.',
].join(' ');

let tools = null;   // lazily required: importing opens the database

/** Whatever the host called itself at initialize, for the presence report. */
let CLIENT_NAME = null;

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
        // What the host calls itself, so the presence report can name it rather
        // than saying only that something is attached. Optional in the protocol,
        // so it is read defensively.
        const info = params && params.clientInfo;
        if (info && info.name) CLIENT_NAME = String(info.name).slice(0, 120);
        try { require('./lib/agent-presence').markAgentSeen(CLIENT_NAME || 'mcp'); } catch (_) { /* observing */ }
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

        // An agent host calling a tool is the only honest evidence that one is
        // attached — a host that is connected calls tools, and one that is not
        // cannot fake it. The HTTP side reads this to decide whether an AI
        // request should go to the connected model (free, already holds the
        // context) or fall back to a server-side key.
        //
        // Never throws: observing must not break the thing observed.
        try {
            require('./lib/agent-presence').markAgentSeen(CLIENT_NAME || 'mcp');
        } catch (_) { /* presence is a convenience, not a precondition */ }

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
        // CLIENT_NAME is whatever the host called itself at initialize —
        // "Claude Desktop", "claude-ai", "ChatGPT". recordHostUsage normalises
        // it; matching a fixed id list literally would send every real client
        // to `unknown-host` and collapse the by-host breakdown to one row that
        // looks like the feature working.
        recordHostUsage({
            host: CLIENT_NAME,
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
