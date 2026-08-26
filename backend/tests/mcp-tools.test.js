/**
 * MCP surface tests.
 *
 * The point of generating the MCP tool list from the runtime registries rather
 * than hand-writing it is that it CANNOT drift: a new node type is a new tool
 * without anyone remembering. These tests are therefore all set-based — they
 * iterate NODE_TYPES and the flows router itself. An example-based test ("is
 * there a gen.image tool?") passes on a half-generated list, which is the exact
 * failure this file exists to prevent.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Before any require that reaches db/database — mcp-tools pulls in routes/flows,
// which opens the database at import time. See test-isolation.test.js.
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-mcp-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const { NODE_TYPES } = require('../lib/flow-node-types');
const { list: listHandlers } = require('../lib/node-handlers');
const {
    listTools, hasTool, callTool, toolNameForNodeType, NODE_TOOL_PREFIX, ROUTE_TOOLS, SSE_EXCEPTION,
    PRODUCTION_TOOLS, presentResult, isFailure, ALL_ROUTE_TOOLS, BATCH_TOOLS,
} = require('../lib/mcp-tools');

const TOOLS = listTools();
const byName = new Map(TOOLS.map(t => [t.name, t]));
const nodeTools = TOOLS.filter(t => t.name.startsWith(NODE_TOOL_PREFIX));
const flowTools = TOOLS.filter(t => !t.name.startsWith(NODE_TOOL_PREFIX));

// ── Set 1: the node-type registry ───────────────────────────────────────────

test('every node type in the registry has exactly one MCP tool', () => {
    const missing = Object.keys(NODE_TYPES).filter(id => !hasTool(toolNameForNodeType(id)));
    assert.deepStrictEqual(missing, [], `node types with no MCP tool: ${missing.join(', ')}`);

    // And nothing extra: a node tool with no registry entry would be a tool an
    // agent can call that the canvas cannot draw.
    const registryNames = new Set(Object.keys(NODE_TYPES).map(toolNameForNodeType));
    const orphans = nodeTools.map(t => t.name).filter(n => !registryNames.has(n));
    assert.deepStrictEqual(orphans, [], `node tools with no registry entry: ${orphans.join(', ')}`);

    assert.strictEqual(nodeTools.length, Object.keys(NODE_TYPES).length);
});

test('every node type with a tool also has a handler that can run it', () => {
    const handlers = new Set(listHandlers());
    const unrunnable = Object.keys(NODE_TYPES).filter(id => !handlers.has(id));
    assert.deepStrictEqual(unrunnable, [],
        `tools exposed for node types with no handler: ${unrunnable.join(', ')}`);
});

test("every node tool's schema declares exactly its registry input ports", () => {
    const wrong = [];
    for (const [id, def] of Object.entries(NODE_TYPES)) {
        const tool = byName.get(toolNameForNodeType(id));
        const declared = Object.keys((tool.inputSchema.properties.inputs || {}).properties || {}).sort();
        const expected = [...def.inputs].sort();
        if (JSON.stringify(declared) !== JSON.stringify(expected)) {
            wrong.push({ id, declared, expected });
        }
    }
    assert.deepStrictEqual(wrong, [], `port/schema mismatch: ${JSON.stringify(wrong, null, 1)}`);
});

test('a node tool names its capability so an agent can see what it will spend on', () => {
    const missing = Object.entries(NODE_TYPES)
        .filter(([, def]) => def.capability)
        .filter(([id, def]) => !byName.get(toolNameForNodeType(id)).description.includes(def.capability));
    assert.deepStrictEqual(missing.map(([id]) => id), []);
});

// ── Set 2: the shipped HTTP route surface ───────────────────────────────────
//
// Parsed from the router itself. A route added to handleFlows without an MCP
// tool fails here, which is the drift this whole design is guarding against.

function handlersReachableFromRouter() {
    const src = fs.readFileSync(path.join(__dirname, '../routes/flows.js'), 'utf8');
    const body = src.slice(src.indexOf('function handleFlows'));
    return [...new Set([...body.matchAll(/return\s+(\w+)\(req,\s*res/g)].map(m => m[1]))].sort();
}

test('every handler reachable from the flows router has an MCP tool', () => {
    const reachable = handlersReachableFromRouter();
    assert.ok(reachable.length >= 14, `router parse found only ${reachable.length} handlers`);

    const covered = new Set(ROUTE_TOOLS.map(t => t.handler).filter(Boolean));
    const missing = reachable.filter(h => !covered.has(h) && h !== SSE_EXCEPTION);
    assert.deepStrictEqual(missing, [],
        `shipped routes with no MCP tool: ${missing.join(', ')}`);
});

test('the one uncovered route is the SSE stream, and it is named', () => {
    // Not an oversight: a single tools/call returns one result, so a streaming
    // route has nothing extra to offer. flow_run covers the same work.
    assert.strictEqual(SSE_EXCEPTION, 'runFlowStreamRoute');
    assert.ok(handlersReachableFromRouter().includes(SSE_EXCEPTION));
    assert.ok(ROUTE_TOOLS.every(t => t.handler !== SSE_EXCEPTION));
});

test('every flow tool maps to a route that actually dispatches', async () => {
    // The phase-6 lesson: a route claimed shipped must be proven dispatched.
    // 404 "Not found" is the router's fallthrough; 405 means the method is wrong.
    const bad = [];
    for (const tool of ROUTE_TOOLS) {
        const res = await callTool(tool.name, tool.probe || {});
        const status = res._status;
        // Exactly the router's fallthrough body. "Flow not found" from a real
        // handler is a dispatched route answering about a missing row, and must
        // not be mistaken for an unrouted one.
        if (status === 404 && res.body && res.body.error === 'Not found') {
            bad.push({ tool: tool.name, why: 'router fallthrough' });
        }
        if (status === 405) bad.push({ tool: tool.name, why: 'method not allowed' });
    }
    assert.deepStrictEqual(bad, [], `undispatched flow tools: ${JSON.stringify(bad)}`);
});

// ── Shape of the surface as a whole ─────────────────────────────────────────

test('tool names are unique and MCP-safe', () => {
    const names = TOOLS.map(t => t.name);
    assert.strictEqual(new Set(names).size, names.length, 'duplicate tool name');
    const illegal = names.filter(n => !/^[a-z][a-z0-9_]{0,62}$/.test(n));
    assert.deepStrictEqual(illegal, [], `illegal tool names: ${illegal.join(', ')}`);
});

test('every tool has a usable object inputSchema and a description', () => {
    const bad = TOOLS.filter(t =>
        !t.inputSchema || t.inputSchema.type !== 'object' ||
        typeof t.inputSchema.properties !== 'object' ||
        !t.description || t.description.length < 10);
    assert.deepStrictEqual(bad.map(t => t.name), []);
});

test('every advertised tool dispatches — none is a name with no code behind it', async () => {
    // Called with empty arguments on purpose: the assertion is only that the
    // dispatcher recognises the name. A generator with no bound shot fails at
    // payload-build time, before any provider is resolved, so this reaches no
    // network and spends nothing.
    const unknown = [];
    for (const tool of TOOLS) {
        const res = await callTool(tool.name, {});
        if (res && res.unknownTool) unknown.push(tool.name);
    }
    assert.deepStrictEqual(unknown, [], `advertised but not dispatched: ${unknown.join(', ')}`);
});

test('an unadvertised tool name is rejected rather than silently doing nothing', async () => {
    const res = await callTool('node_gen_nonexistent', {});
    assert.ok(res.unknownTool, 'dispatcher accepted a tool it never advertised');
});

// ── The stdio server itself ─────────────────────────────────────────────────

function rpc(requests, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, '../mcp-server.js')], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, FILM_ENGINE_MCP_TEST: '1' },
        });
        let out = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; stderr=${stderr}`)); }, timeoutMs);

        child.stdout.on('data', d => { out += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', () => {
            clearTimeout(timer);
            const messages = out.split('\n').filter(Boolean).map(l => {
                try { return JSON.parse(l); } catch (_) { return { _unparsed: l }; }
            });
            resolve({ messages, stderr });
        });

        for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
        child.stdin.end();
    });
}

test('the stdio server speaks JSON-RPC: initialize then tools/list', async () => {
    const { messages, stderr } = await rpc([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);

    const init = messages.find(m => m.id === 1);
    assert.ok(init && init.result, `no initialize result; stderr=${stderr}`);
    assert.ok(init.result.protocolVersion, 'initialize returned no protocolVersion');
    assert.ok(init.result.capabilities.tools, 'server did not advertise tools capability');
    assert.strictEqual(init.result.serverInfo.name, 'film-engine');

    const listed = messages.find(m => m.id === 2);
    assert.ok(listed && listed.result, 'no tools/list result');
    assert.strictEqual(listed.result.tools.length, TOOLS.length,
        'the wire tool list disagrees with the generated one');

    // A notification carries no id and must draw no response.
    assert.ok(!messages.some(m => m.id === undefined && m.result !== undefined),
        'server replied to a notification');
});

test('the stdio server returns a JSON-RPC error for an unknown method', async () => {
    const { messages } = await rpc([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
        { jsonrpc: '2.0', id: 7, method: 'nonexistent/method' },
    ]);
    const err = messages.find(m => m.id === 7);
    assert.ok(err && err.error, 'no error object for an unknown method');
    assert.strictEqual(err.error.code, -32601);
});

test('tools/call over the wire reaches a real tool', async () => {
    const { messages } = await rpc([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flow_node_types', arguments: {} } },
    ]);
    const called = messages.find(m => m.id === 3);
    assert.ok(called && called.result, 'tools/call returned no result');
    assert.ok(Array.isArray(called.result.content) && called.result.content[0].type === 'text');
    const payload = JSON.parse(called.result.content[0].text);
    assert.strictEqual(Object.keys(payload).length, Object.keys(NODE_TYPES).length,
        'flow_node_types did not return the registry');
});

test('a failing tool reports isError rather than a JSON-RPC error', async () => {
    // MCP draws this line deliberately: a tool that ran and failed is a result
    // the model can read and react to; a JSON-RPC error is a protocol fault.
    const { messages } = await rpc([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'flow_get', arguments: { flow_id: 'no-such-flow' } } },
    ]);
    const called = messages.find(m => m.id === 4);
    assert.ok(called && called.result, 'a tool failure became a protocol error');
    assert.strictEqual(called.result.isError, true);
});

// ── Pre-production surface ──────────────────────────────────────────────────
//
// These exist because a flows-only surface let an agent RUN generation while
// being unable to give it anything to be consistent about: a parsed screenplay
// leaves appearance_prompt empty, and nothing on the old surface could fill it,
// so every keyframe invented its own character on its own street. Iterated
// rather than spot-checked, so a tool added without a handler, or wired to the
// wrong verb, fails here rather than at the first tools/call.

test('every production tool names a real handler and a legal method', () => {
    const bad = [];
    for (const t of PRODUCTION_TOOLS) {
        if (typeof t.handler !== 'function') bad.push(`${t.name}: handler is not a function`);
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(t.method)) bad.push(`${t.name}: method '${t.method}'`);
        if (typeof t.path !== 'function') bad.push(`${t.name}: path is not a builder`);
        if (!t.description || t.description.length < 20) bad.push(`${t.name}: description too thin to route on`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('every production tool is advertised on the surface', () => {
    const advertised = new Set(listTools().map(t => t.name));
    const missing = PRODUCTION_TOOLS.map(t => t.name).filter(n => !advertised.has(n));
    assert.deepStrictEqual(missing, [], `defined but not advertised: ${missing.join(', ')}`);
});

test('the surface covers the whole pre-production chain, not just part of it', () => {
    // Continuity needs every link. A surface with shot_create but no
    // character_update lets an agent build a shot list and still produce
    // unrelated-looking frames — which is exactly what happened.
    const REQUIRED = [
        'script_get',                            // read the source
        'scene_list',                            // what scenes exist
        'character_list', 'character_update',    // who is in them, and what they look like
        'location_list', 'location_update',      // where, and what it looks like
        'shot_create', 'shot_list',              // the shot list
        'project_update',                        // the look
        'storyboard_generate',                   // and only then, generate
    ];
    const have = new Set(listTools().map(t => t.name));
    const missing = REQUIRED.filter(n => !have.has(n));
    assert.deepStrictEqual(missing, [], `pre-production chain incomplete: ${missing.join(', ')}`);
});

test('a read tool returns data rather than an HTTP envelope', async () => {
    const shown = presentResult(await callTool('project_list', {}));
    assert.ok(shown && typeof shown === 'object', 'presentResult returned nothing usable');
    assert.ok(!('_status' in shown), 'the HTTP envelope leaked to the model');
    assert.ok(Array.isArray(shown.projects), 'project_list did not return a projects array');
});

test('a missing required argument fails the tool instead of half-running it', async () => {
    assert.ok(isFailure(await callTool('character_update', {})),
        'an update with no character_id reported success');
});


/**
 * Anything an agent can create, it can remove.
 *
 * The surface grew to 77 tools with exactly ONE delete among them
 * (flow_delete). An agent could create characters, locations, props, shots,
 * mood board entries and annotations, and un-create none of them — so its only
 * recovery from its own mistake was to ask a human to click a button. That is
 * the same asymmetry that made entity creation impossible before
 * character_create existed, seen from the other end.
 *
 * Set-based over the CREATE tools rather than a list of deletes, because the
 * pairing is the invariant: adding a new create tool without its delete should
 * fail here rather than be noticed months later by someone stuck with a typo
 * they cannot remove.
 */
const CREATE_DELETE_PAIRS = [
    // A sequence is a plan a director builds and re-runs; it has to be
    // removable, and removing it must not take the clips with it.
    { create: 'sequence_create', remove: 'sequence_delete' },
    { create: 'project_create', remove: 'project_delete' },
    // A profile is a commitment, and one an agent can make it must be able to
    // withdraw — otherwise a wrong subject is locked in with no way back out.
    { create: 'consistency_create', remove: 'consistency_delete' },
    { create: 'character_create',  remove: 'character_delete' },
    { create: 'location_create',   remove: 'location_delete' },
    { create: 'prop_create',       remove: 'prop_delete' },
    { create: 'shot_create',       remove: 'shot_delete' },
    { create: 'mood_board_add',    remove: 'mood_board_remove' },
    { create: 'shot_annotate',     remove: 'annotation_delete' },
    { create: 'flow_create',       remove: 'flow_delete' },
    // A poster an agent can plan, it must be able to unplan. Deleting the
    // record deliberately leaves the artwork file: it cost money to generate.
    { create: 'marketing_create',  remove: 'marketing_delete' },
];

test('the pair list covers every create tool on the surface', () => {
    const tools = listTools().map(t => t.name);
    // A create tool with no entry here is a kind whose removability nobody
    // decided on.
    const creates = tools.filter(n => /_create$|_add$|_annotate$/.test(n)
        && !['flow_create_from_template', 'entities_create'].includes(n));
    const uncovered = creates.filter(c => !CREATE_DELETE_PAIRS.some(p => p.create === c));
    assert.deepStrictEqual(uncovered, [],
        `create tools with no delete decision: ${uncovered.join(', ')}`);
});

test('everything an agent can create, it can also remove', () => {
    const tools = new Set(listTools().map(t => t.name));
    const missing = CREATE_DELETE_PAIRS
        .filter(p => tools.has(p.create) && !tools.has(p.remove))
        .map(p => `${p.create} exists but ${p.remove} does not`);
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});

test('every delete tool actually dispatches to a route', () => {
    // A delete tool wired to nothing is worse than none: the agent believes the
    // thing is gone.
    const tools = listTools();
    const broken = [];
    for (const pair of CREATE_DELETE_PAIRS) {
        const tool = tools.find(t => t.name === pair.remove);
        if (!tool) continue;
        const spec = ALL_ROUTE_TOOLS.find(t => t.name === pair.remove);
        if (!spec) { broken.push(`${pair.remove}: not a route tool`); continue; }
        if (spec.method !== 'DELETE') broken.push(`${pair.remove}: method is ${spec.method}, not DELETE`);
        if (typeof spec.path !== 'function') broken.push(`${pair.remove}: no path`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});


/**
 * Every entity kind gets the same three verbs, and creating a duplicate is
 * refused rather than done.
 *
 * props had create and delete and no UPDATE, while characters and locations had
 * all three. So an agent asked to rewrite a prop description did the only thing
 * available — called prop_create again — and got a SECOND "Grocery bag" row
 * beside the first. Two rows with the same name is worse than an error: the
 * gather query picks one by created_at and the other silently rots, so a plate
 * is generated from a description nobody is reading.
 *
 * Set-based over the entity kinds and the verbs, because the gap was exactly
 * one cell of that grid and nothing was checking the grid.
 */
const ENTITY_VERBS = ['create', 'update', 'delete'];
const ENTITY_KINDS = ['character', 'location', 'prop'];

test('every entity kind has create, update and delete', () => {
    const tools = new Set(listTools().map(t => t.name));
    const missing = [];
    for (const kind of ENTITY_KINDS) {
        for (const verb of ENTITY_VERBS) {
            if (!tools.has(`${kind}_${verb}`)) missing.push(`${kind}_${verb}`);
        }
    }
    assert.deepStrictEqual(missing, [],
        `an agent can create these and not correct them: ${missing.join(', ')}`);
});

test('creating an entity that already exists is refused, not duplicated', async () => {
    // The failure this exists for: a second row with the same name, which the
    // gather query resolves by picking one, so the other is invisible work.
    const { db, generateId } = require('../db/database');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Dup Test');

    for (const kind of ENTITY_KINDS) {
        const first = await callTool(`${kind}_create`, { project_id: projectId, name: 'Grocery bag' });
        assert.ok(!isFailure(first), `${kind}_create failed outright: ${JSON.stringify(first).slice(0, 160)}`);

        const second = await callTool(`${kind}_create`, { project_id: projectId, name: 'Grocery bag' });
        assert.ok(isFailure(second),
            `${kind}_create made a duplicate instead of refusing: ${JSON.stringify(second).slice(0, 160)}`);
        // And it must say what to do instead, or the agent just tries again.
        assert.match(JSON.stringify(second), new RegExp(`${kind}_update`),
            `${kind}_create refused a duplicate without naming the update tool`);
    }
});


/**
 * Anything an agent can delete by id, it can find the id of.
 *
 * mood_board_remove takes an entry_id and there was no tool that listed board
 * entries, so an agent could only remove entries it had created in the same
 * session — it knew those ids from its own add responses. Asked to clear a
 * board someone else built, it correctly reported that it could not, three
 * times, and was right each time.
 *
 * That is the create/delete asymmetry one level along: having the verb is not
 * the same as being able to aim it. Set-based over the delete tools, because
 * three of seven had this hole and nothing was looking.
 */
test('every delete tool has a way to discover what to delete', () => {
    const tools = listTools().map(t => t.name);
    const blind = [];
    for (const name of tools.filter(n => /_delete$|_remove$/.test(n))) {
        const base = name.replace(/_delete$|_remove$/, '');
        const discovers = tools.some(n => n === `${base}_list` || n === `${base}_get`);
        if (!discovers) blind.push(name);
    }
    assert.deepStrictEqual(blind, [],
        `these can delete by id and cannot find one: ${blind.join(', ')}`);
});

/**
 * A tool in the wrong list is a tool that has never worked.
 *
 * `plate_generate` sat in BATCH_TOOLS carrying `handler`, `path` and
 * `handlerFor` — the shape of a ROUTE tool — and no `run()`. The batch branch
 * of callTool calls `.run(a)` unconditionally, so every invocation died on
 * "run is not a function" before it reached a route. It failed identically for
 * every subject and every kind, which reads like a data problem and is not: the
 * tool had never been callable once.
 *
 * Nothing else in the suite catches this, because every other check asks
 * whether a tool is LISTED. It was listed, described, schema'd and advertised.
 */
test('every batch tool can actually be run', () => {
    const broken = BATCH_TOOLS
        .filter(t => typeof t.run !== 'function')
        .map(t => t.name);
    assert.deepStrictEqual(broken, [],
        `these are advertised and cannot be called: ${broken.join(', ')}`);
});

test('a batch tool is not secretly a route tool', () => {
    // The fields are the tell. Carrying them means someone wrote a route tool
    // and filed it in the batch list, and the two dispatch differently.
    const ROUTE_ONLY = ['handler', 'path', 'method', 'handlerFor', 'bodyKeys'];
    const confused = BATCH_TOOLS
        .map(t => ({ name: t.name, fields: ROUTE_ONLY.filter(f => f in t) }))
        .filter(x => x.fields.length)
        .map(x => `${x.name} carries ${x.fields.join(', ')}`);
    assert.deepStrictEqual(confused, [], confused.join('; '));
});

test('every listed tool dispatches to something that exists', () => {
    // The general form of the same bug: listed is not callable.
    const uncallable = [];
    for (const name of listTools().map(t => t.name)) {
        const batch = BATCH_TOOLS.find(t => t.name === name);
        if (batch) { if (typeof batch.run !== 'function') uncallable.push(`${name} (batch, no run)`); continue; }
        const route = [...PRODUCTION_TOOLS, ...ROUTE_TOOLS].find(t => t.name === name);
        if (route) {
            // `path` is what every route tool dispatches on. `handler` is
            // deliberately null for the flow tools, which go through
            // handleFlows by path — asserting on handler instead reported two
            // working tools as broken, which is how a guard gets relaxed until
            // it protects nothing.
            if (typeof route.path !== 'function') uncallable.push(`${name} (route, no path)`);
            continue;
        }
        if (!name.startsWith('node_')) uncallable.push(`${name} (in no registry)`);
    }
    assert.deepStrictEqual(uncallable, [], `\n  ${uncallable.join('\n  ')}`);
});

/**
 * Every argument a tool advertises is actually read.
 *
 * `storyboard_regenerate` declared `use_scene_anchor` and its body builder read
 * `a.use_anchor`. Setting it from an agent host did nothing and reported
 * nothing — the call succeeded, the anchor stayed attached, and the only way to
 * find out was to compare the generated frame against what you asked for.
 *
 * That is the worst shape a bug can take here: the tool list is the contract a
 * model reads to decide what is possible, so a documented-but-ignored argument
 * is a lie told to the thing driving the pipeline. Derived over every route
 * tool rather than checked on the one that was wrong.
 */
test('no tool declares an argument its builder never reads', () => {
    const { ALL_ROUTE_TOOLS } = require('../lib/mcp-tools');
    const unread = [];

    for (const tool of ALL_ROUTE_TOOLS) {
        const keys = Object.keys(tool.schema || {});
        if (!keys.length) continue;

        /*
         * Comments are stripped before matching. Function.toString() includes
         * them, so a builder carrying a comment ABOUT an argument reads as one
         * that uses it — and the comment explaining this very bug made the test
         * pass while the bug was reintroduced. Substring matching cannot tell a
         * claim from prose about the claim; this codebase has paid for that
         * lesson twice already.
         */
        const strip = src => src
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ');

        const pathSrc = typeof tool.path === 'function' ? strip(tool.path.toString()) : '';

        // Three legitimate ways a tool forwards an argument, and the test has
        // to know all of them or it reports working tools as broken — which is
        // how a guard gets relaxed until it protects nothing.
        const bodySrc = typeof tool.body === 'function' ? strip(tool.body.toString()) : null;
        const forwardsAll = bodySrc !== null
            && (/\.\.\.\w+/.test(bodySrc)          // const { id, ...rest } = a
                || /^\s*\w+\s*=>\s*\w+\s*\|\|/.test(bodySrc));  // a => a || {}
        const declared = new Set(tool.bodyKeys || []);   // enumerated instead of built

        for (const k of keys) {
            if (forwardsAll) continue;
            if (declared.has(k)) continue;
            if (new RegExp(`\\b${k}\\b`).test(bodySrc || '')) continue;
            if (new RegExp(`\\b${k}\\b`).test(pathSrc)) continue;
            unread.push(`${tool.name}.${k}`);
        }
    }

    assert.deepStrictEqual(unread, [],
        'these tools advertise arguments that no builder reads, so setting them '
        + `is silently ignored: ${unread.join(', ')}`);
});
