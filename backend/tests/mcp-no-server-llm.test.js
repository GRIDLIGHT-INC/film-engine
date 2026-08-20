/**
 * The agent host IS the model. No MCP tool may hand the reasoning back.
 *
 * This surface exists so that Claude connects, Claude reasons, and Film Engine
 * keeps the data and the media — which is also how the pipeline reaches an LLM
 * with no API key of its own. A tool that calls a server-side LLM breaks that
 * twice: it asks the user to hold a second key for a question the model on the
 * other end of the socket has already read, and when the key has no credit it
 * fails with a billing error the model cannot act on and will simply retry.
 *
 * It is an easy mistake — the route exists, it works over HTTP, and wrapping it
 * looks like closing a gap. `breakdown_run` was added for exactly that reason
 * and had to come straight back out. So this is derived from the SOURCE rather
 * than from a list of forbidden names: any route module that calls the LLM
 * client is off limits, and a tool pointed at one fails here rather than in
 * front of a user halfway through a revision.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-mcpllm-' + crypto.randomUUID().slice(0, 8));

const { PRODUCTION_TOOLS, ROUTE_TOOLS } = require('../lib/mcp-tools');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

/** Route modules that reach a server-side LLM, read off the source. */
function llmRouteModules() {
    return fs.readdirSync(ROUTES_DIR)
        .filter(f => f.endsWith('.js'))
        .filter(f => /callProjectLLM|streamProjectLLM|require\(['"]\.\.\/lib\/llm-client['"]\)/
            .test(fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8')));
}

/** The exported handler names of a route module. */
function handlerNames(file) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    const m = src.match(/module\.exports\s*=\s*\{([^}]*)\}/);
    if (!m) return [];
    return m[1].split(',').map(x => x.split(':')[0].trim()).filter(Boolean);
}

test('the set of LLM-calling routes is not empty, or this test proves nothing', () => {
    // A grep-driven guard that silently matches nothing is worse than no guard:
    // it reports success forever.
    const modules = llmRouteModules();
    assert.ok(modules.length > 0,
        'no route was detected as calling the LLM client — the detection has drifted from the code');
});

test('no MCP tool dispatches to a route that calls the server LLM', () => {
    const banned = new Set();
    for (const file of llmRouteModules()) {
        for (const name of handlerNames(file)) banned.add(name);
    }

    const offenders = [];
    for (const tool of PRODUCTION_TOOLS) {
        const handler = tool.handler && tool.handler.name;
        if (handler && banned.has(handler)) offenders.push(`${tool.name} -> ${handler}`);
    }
    assert.deepStrictEqual(offenders, [],
        'these tools ask a server-side LLM to do the reasoning the connected model is already doing: '
        + offenders.join(', '));
});

/**
 * What a model reaches for instead.
 *
 * Removing a tool is only correct if the work is still doable. Each removed
 * capability maps to plain data tools the connected model drives itself, and
 * the result is strictly better — a model composing a card or a description has
 * the whole revision in context rather than one scene of it.
 */
const REPLACEMENTS = {
    'breaking a scene into shots': ['script_get', 'shot_create', 'card_vocabulary'],
    'describing characters and locations': ['character_update', 'location_update', 'prop_update'],
};

test('every capability removed from the surface is still reachable', () => {
    const names = new Set([...PRODUCTION_TOOLS, ...ROUTE_TOOLS].map(t => t.name));
    const gaps = [];
    for (const [work, tools] of Object.entries(REPLACEMENTS)) {
        for (const t of tools) if (!names.has(t)) gaps.push(`${work} needs ${t}`);
    }
    assert.deepStrictEqual(gaps, [],
        `removing the LLM tools left work an agent cannot do: ${gaps.join(', ')}`);
});

test('the removal is explained where someone would re-add it', () => {
    // The mistake is easy and looks like closing a gap. A comment at the point
    // of temptation is the only thing that survives the next person's good idea.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-tools.js'), 'utf8');
    assert.ok(/breakdown_run/.test(src) && /entities_describe/.test(src),
        'the removed tools are not named, so the next person re-adds them');
    assert.ok(/agent host/i.test(src) || /AGENT HOST/.test(src),
        'nothing on the page says why a server-side LLM tool is wrong here');
});
