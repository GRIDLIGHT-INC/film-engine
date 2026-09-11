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

/**
 * A tool that promises the screenplay has to return the screenplay.
 *
 * `script_get` pointed at the LIST endpoint, which returns versions and word
 * counts and no source at all, while its description promised "the Fountain
 * source and its parsed elements". That is worse than a missing tool: the model
 * believes it has read the script, and then rewrites it from the summary it was
 * handed. It surfaced as an agent stopping mid-revision to ask where the text
 * was, which is the good outcome and not the likely one.
 *
 * Set-based over the tools whose descriptions promise content, because the
 * failure is a mismatch between what a description claims and what a path
 * returns, and nothing else in the suite compares those two.
 */
const CONTENT_TOOLS = [
    { name: 'script_get', promises: /Fountain source/i, path: /script\/latest\/fountain/ },
    { name: 'shot_get', promises: /scene card/i, path: /\/shots\/\$\{a\.shot_id\}/ },
];

test('a tool that promises content points at a route that returns it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-tools.js'), 'utf8');
    const broken = [];
    for (const t of CONTENT_TOOLS) {
        const tool = PRODUCTION_TOOLS.find(x => x.name === t.name);
        if (!tool) { broken.push(`${t.name} is missing`); continue; }
        if (!t.promises.test(tool.description)) {
            broken.push(`${t.name} no longer describes what it returns`);
            continue;
        }
        const built = String(tool.path({ project_id: 'P', shot_id: 'S' }));
        const expected = t.name === 'script_get' ? /script\/latest\/fountain/ : /\/shots\/S$/;
        if (!expected.test(built)) broken.push(`${t.name} promises content and fetches ${built}`);
    }
    assert.deepStrictEqual(broken, [], broken.join('; '));
    assert.ok(/script_versions/.test(src),
        'the version list has no tool, so confirming a rewrite was saved is impossible');
});

/**
 * A route that ships without a tool is a thing the app can do and an agent cannot.
 *
 * `POST /film/projects` worked from the first week and had no `project_create`
 * for months, so an agent connected to this server could write a screenplay
 * into a project and could not bring one into existence. Nothing failed; the
 * capability was simply absent, which is the hardest kind of gap to notice
 * because there is no error to read.
 *
 * The tool list is hand-written, so a test over the tool list can only confirm
 * what someone remembered. This derives the expectation from the ROUTES: for
 * each entity, read which HTTP methods its module actually dispatches, and
 * require a tool for each. The registry below names entities and files — a much
 * smaller and more stable thing than the tool list — and every deliberate
 * omission has to be written down with its reason.
 */
const ENTITY_ROUTES = [
    { kind: 'project', file: 'projects.js', verbs: { POST: 'project_create', PUT: 'project_update', DELETE: 'project_delete' } },
    { kind: 'scene', file: 'scenes.js', verbs: { PUT: 'scene_update', DELETE: 'scene_delete' } },
    { kind: 'shot', file: 'shots.js', verbs: { POST: 'shot_create', PUT: 'shot_update', DELETE: 'shot_delete' } },
    { kind: 'character', file: 'characters.js', verbs: { POST: 'character_create', PUT: 'character_update', DELETE: 'character_delete' } },
    { kind: 'location', file: 'locations.js', verbs: { POST: 'location_create', PUT: 'location_update', DELETE: 'location_delete' } },
    { kind: 'annotation', file: 'annotations.js', verbs: { POST: 'shot_annotate', DELETE: 'annotation_delete' } },
    { kind: 'mood board', file: 'mood-board.js', verbs: { POST: 'mood_board_add', DELETE: 'mood_board_remove' } },
    { kind: 'consistency', file: 'consistency.js', verbs: { POST: 'consistency_create', DELETE: 'consistency_delete' } },
    // A cue carries the music DIRECTION. An agent that can generate music and 
    // cannot write the brief for it has the wrong half of the job.
    { kind: 'music cue', file: 'assets.js', verbs: { POST: 'music_cue_create', PUT: 'music_cue_update', DELETE: 'music_cue_delete' } },
    // A score session is where the soundtrack is arranged. The agent host is
    // the model, so a session it cannot create, change or remove is a
    // soundtrack that has to be built by hand.
    { kind: 'score session', file: 'music-sessions.js', verbs: { POST: 'music_session_create', PUT: 'music_session_update', DELETE: 'music_session_delete' } },
];

test('every entity route an agent should reach has a tool', () => {
    const names = new Set([...PRODUCTION_TOOLS, ...ROUTE_TOOLS].map(t => t.name));
    const gaps = [];

    for (const entity of ENTITY_ROUTES) {
        const src = fs.readFileSync(path.join(ROUTES_DIR, entity.file), 'utf8');
        for (const [method, tool] of Object.entries(entity.verbs)) {
            // Both forms count. annotations.js guards its delete with
            // `req.method !== 'DELETE'` and a detector that only looked for
            // `===` reported a gap where there was none — a derived test that
            // is wrong about the code is worse than a hand-written one, because
            // it is believed.
            const dispatches = new RegExp(`req\\.method (===|!==) '${method}'`).test(src);
            if (!dispatches) {
                gaps.push(`${entity.kind}: ${tool} is expected but ${entity.file} handles no ${method}`);
                continue;
            }
            if (!names.has(tool)) {
                gaps.push(`${entity.kind}: ${entity.file} handles ${method} and there is no ${tool}`);
            }
        }
    }
    assert.deepStrictEqual(gaps, [], `\n  ${gaps.join('\n  ')}`);
});

test('the entity registry names files that exist', () => {
    // A registry pointing at a renamed file silently checks nothing.
    const missing = ENTITY_ROUTES
        .filter(e => !fs.existsSync(path.join(ROUTES_DIR, e.file)))
        .map(e => e.file);
    assert.deepStrictEqual(missing, [], `these route files are gone: ${missing.join(', ')}`);
});
