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

/**
 * HOW LONG A TOOL CALL MAY TAKE BEFORE THE HOST STOPS LISTENING.
 *
 * Declared by this process rather than detected, because this process is the
 * one with the constraint: `backend/server.js` is a different program serving a
 * browser that will happily wait minutes for a mesh. Every async adapter passes
 * its budget through `generation-jobs.budgetFor`, which finishes early enough
 * to write the handle down and answer — so a long generation reached this way
 * comes back as "still running, collect it" instead of being torn down
 * mid-await and reported as "the device did not respond".
 *
 * SIXTY SECONDS WAS TOO MEAN FOR THE MODELS PEOPLE ACTUALLY USE. It left a 45s
 * budget, and Nano Banana Pro takes about two minutes for a 1024 plate — so
 * EVERY plate on the production tier timed out, every one had to be collected
 * by hand, and the director was shown a failure for a picture that rendered
 * fine. A budget shorter than the work is not a safety margin, it is a
 * guaranteed miss.
 *
 * Three minutes covers a pro image comfortably and still returns inside the
 * generous window this host allows. It is not a promise: a 4K mesh or a long
 * clip will still outrun it, which is exactly what the handle is for — and
 * since `generation_collect` now FILES a collected plate rather than dropping
 * it beside the board (see lib/plate-delivery.js), overrunning is no longer
 * the same as losing the work.
 *
 * Overridable, because a host with a different window should say so rather than
 * have this number guessed at.
 */
if (!process.env.FILM_HOST_ABORT_MS) process.env.FILM_HOST_ABORT_MS = '180000';

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

/**
 * A tool result becomes content the model can actually use.
 *
 * This emitted text and nothing else, so an agent could generate a shot and
 * then had no way to LOOK at it — "compare this frame with the storyboard" was
 * blocked at the transport rather than at the prompt. MCP allows image content
 * blocks; we simply never produced one.
 *
 * Any tool opts in by returning `images: [{ data_uri, label }]`. The pictures
 * go alongside the text rather than instead of it, because the numbers and the
 * frame answer different halves of the question. A result with no images is
 * byte-identical to before.
 *
 * This is what makes shot validation free: the connected model IS the LLM here,
 * so it can do the comparison itself and nothing calls a server-side model.
 */
function toolResult(result) {
    const shown = api().presentResult(result);
    const images = [];
    let body = shown;
    if (shown && typeof shown === 'object' && Array.isArray(shown.images)) {
        const { images: carried, ...rest } = shown;
        body = rest;
        for (const img of carried) {
            const uri = String((img && (img.data_uri || img.dataUri)) || '');
            const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
            // Bare base64 and a mime type: a data: URI inside `data` is a
            // protocol error that renders as a broken image with no reason.
            if (m) images.push({ type: 'image', data: m[2], mimeType: m[1] });
            else if (img && img.data && img.mimeType) images.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        }
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    const out = { content: [{ type: 'text', text }, ...images] };
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
        /*
         * WHAT THE HOST CAN DO, not just what it is called.
         *
         * `params.capabilities` is where a client declares `sampling`,
         * `elicitation` and `roots` — and this read the name beside it and threw
         * the rest away. That is the one question the engine cannot answer about
         * its own host: whether the attached model can be ASKED something.
         *
         * It matters because of the direction MCP runs. This server can be
         * called; it cannot call. `sampling/createMessage` is the protocol's
         * answer — the server asks the client's model to complete something,
         * on the user's own subscription, spending no API key — and whether it
         * is available is a property of the HOST, declared right here, once per
         * connection. Guessing it from documentation is guessing about someone
         * else's build; this is the connection actually in front of us.
         */
        try {
            require('./lib/agent-presence').markAgentSeen(
                CLIENT_NAME || 'mcp', params && params.capabilities);
        } catch (_) { /* observing */ }
        return {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            /*
             * The build, not a constant nobody updates.
             *
             * A host fixes its tool list when it spawns this process, so the
             * only record of WHICH build a connection is serving is what it
             * says here. `0.1.0` told a reader nothing; `0.1.0+206tools.<when>`
             * makes the age of a connection answerable without reading a
             * process table.
             */
            serverInfo: require('./lib/mcp-build').serverInfo(SERVER_INFO),
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
            /*
             * The one channel that reaches a stale connection.
             *
             * A host's tool list is fixed when this process spawns, so a tool
             * shipped afterwards is invisible AND indistinguishable from one
             * that was never built — a connected model checked the name,
             * searched by keyword, re-queried, correctly found nothing, and
             * offered to design a pair that already existed. Every step sound;
             * the information unreachable. A diagnostic TOOL would not help:
             * it would be missing from exactly the connections that need it.
             */
            let note = null;
            try { note = require('./lib/mcp-build').stalenessNote(); } catch (_) { note = null; }
            throw Object.assign(new Error(note ? `${result.error}. ${note}` : result.error), { code: -32602 });
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

module.exports = { METHODS, handle, toolResult, SUPPORTED_PROTOCOLS, SERVER_INFO };
