/**
 * A guide to what Film Engine can do from Claude Desktop, held to the registry.
 *
 * The ask: what is possible over MCP, and do I invoke tools by name or just say
 * what I want? The second half has a real answer — Claude picks the tool from
 * the descriptions — but only if the descriptions and the server's own
 * INSTRUCTIONS actually cover the work. They did not: INSTRUCTIONS described
 * `flow_*` and `node_*`, which is 38 of 133 tools, and said nothing about
 * writing a screenplay or taking it to a film. A model reading that would
 * reasonably conclude this is a graph-execution service.
 *
 * A guide is a document and documents drift, so this holds it to the code the
 * way `previs-plan.test.js` holds the previs plan. Every check derives its
 * expectation from `listTools()` — a 134th tool, or a renamed family, fails
 * here rather than being discovered by a reader who trusted the guide.
 *
 * Set-based over the tool FAMILIES rather than over an example workflow: a
 * guide that covers the six things I happened to think of passes any test
 * written around those six, and the ones it omits are exactly the ones nobody
 * knows exist.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-guide-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..', '..');
const GUIDE = path.join(ROOT, 'docs', 'claude-desktop-guide.md');
const guide = () => fs.readFileSync(GUIDE, 'utf8');
const tools = () => require('../lib/mcp-tools').listTools();

/** Families, derived. A family is the first segment of a tool name. */
function families() {
    const out = new Map();
    for (const t of tools()) {
        const f = t.name.split('_')[0];
        if (!out.has(f)) out.set(f, []);
        out.get(f).push(t.name);
    }
    return out;
}

test('the guide exists and states the real tool count', () => {
    assert.ok(fs.existsSync(GUIDE), 'docs/claude-desktop-guide.md does not exist');
    const n = tools().length;
    assert.ok(guide().includes(String(n)),
        `the guide does not state the real tool count (${n}) — it will read as stale on the first count anyone checks`);
});

test('every tool is named in the guide, not just every family', () => {
    // Family coverage was the first check and it is too weak: one `scene_get`
    // documents a family of ten and nine stay invisible. The guide currently
    // names all 133, and this holds it there — a 134th tool fails here rather
    // than being discovered by a reader who trusted the page.
    const named = new Set([...guide().matchAll(/`([a-z][a-z0-9_]*)`/g)].map(m => m[1]));
    const missing = tools().map(t => t.name).filter(n => !named.has(n));
    assert.deepStrictEqual(missing, [],
        `${missing.length} tool(s) exist and are not in the guide: ${missing.join(', ')}`);
});

test('every tool family is covered', () => {
    // The failure this prevents: a guide covering the workflows its author
    // remembered. The families it omits are the ones nobody knows exist.
    const doc = guide();
    // A family is usually a prefix (`scene_`), but two tools are single words
    // (`setups`, `dood_report`'s sibling). Match either shape, or the check
    // demands documentation in a form the registry does not use.
    const missing = [...families().keys()].filter(f =>
        !new RegExp(`\`${f}_`).test(doc) && !new RegExp(`\`${f}\``).test(doc));
    assert.deepStrictEqual(missing, [],
        `these tool families are undocumented: ${missing.join(', ')}`);
});

test('every tool that spends money is named as one that does', () => {
    // The single most consequential thing a reader can be wrong about. A tool
    // that resolves a provider bills the user, and a guide that lists it beside
    // free ones invites an expensive accident.
    const spend = tools()
        .filter(t => /^(node_gen|storyboard_(generate|regenerate|refine)|plate_generate)/.test(t.name))
        .map(t => t.name);
    assert.ok(spend.length >= 12, `only ${spend.length} generating tools found — the scan is broken`);

    const doc = guide();
    const section = doc.slice(doc.indexOf('## What costs money'));
    assert.ok(section.length > 100, 'the guide has no section on what costs money');
    const unlisted = spend.filter(n => !section.includes(n));
    assert.deepStrictEqual(unlisted, [],
        `these spend money and are not in the cost section: ${unlisted.join(', ')}`);
});

test('the guide answers the natural-language question directly', () => {
    // The literal ask. The answer is yes — Claude selects from the tool
    // descriptions — and a guide that only lists names implies the opposite.
    const doc = guide();
    for (const phrase of ['natural language', 'You do not need to name']) {
        assert.ok(doc.includes(phrase),
            `the guide never says whether you can just ask for what you want (missing: "${phrase}")`);
    }
});

test('the server instructions cover the pipeline, not only the graph tools', () => {
    // What Claude Desktop reads BEFORE any tool call, and the thing a written
    // guide cannot substitute for: the guide is for the human, INSTRUCTIONS is
    // for the model. It described flow_* and node_* — 38 of 133 tools — so a
    // model reading it would conclude this is a graph-execution service.
    const src = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf8');
    const m = src.match(/const INSTRUCTIONS = \[([\s\S]*?)\]\.join/);
    assert.ok(m, 'the MCP server no longer sends instructions');
    const text = m[1];

    const missing = [];
    // The stages of the acceptance criterion: screenplay → shots → media → film.
    for (const [word, why] of [
        ['screenplay', 'the thing a user starts from'],
        ['scene_append', 'how a novel is imported chapter by chapter'],
        ['shot', 'the step between a script and any media'],
        ['storyboard', 'the first generated artefact'],
        ['costs the user money|spends money', 'the warning that matters most'],
    ]) {
        if (!new RegExp(word, 'i').test(text)) missing.push(`${word} — ${why}`);
    }
    assert.deepStrictEqual(missing, [], `the model is never told about:\n  ${missing.join('\n  ')}`);
});

test('every tool named in the guide exists', () => {
    // A guide naming a tool that was renamed is worse than one that omits it:
    // the reader asks for it, the model cannot find it, and the tool that DID
    // survive goes unused.
    const known = new Set(tools().map(t => t.name));
    const named = [...guide().matchAll(/`([a-z][a-z0-9_]{3,})`/g)].map(m => m[1]);
    const candidates = named.filter(n => n.includes('_') && !/^(film_|node_modules)/.test(n));
    const ghosts = [...new Set(candidates)].filter(n => !known.has(n) && /^[a-z]+_[a-z_0-9]+$/.test(n));
    // Allow prose that names a database column or a field rather than a tool.
    const notTools = ghosts.filter(n => !/_(id|at|json|path|name|content|preset|percent|fingerprint|feedback|refs|shot|version|number|character|prompt|image|images|alternative|seen)$/.test(n)
        && !/^(scene_card|source_|asset_|input_|provider_|prompt_|use_|after_|before_|is_|has_|style_|target_|writing_|annotation_|anchor_|include_)/.test(n));
    assert.deepStrictEqual(notTools, [],
        `the guide names tools that do not exist: ${notTools.join(', ')}`);
});

test('the guide shows the whole pipeline in order', () => {
    // The acceptance criterion is a finished film, and the question a new user
    // has is "what order". A reference list sorted alphabetically answers
    // neither.
    const doc = guide();
    const stages = ['screenplay', 'entities', 'plates', 'storyboard', 'previs', 'video', 'audio', 'export'];
    const at = stages.map(s => ({ s, i: doc.toLowerCase().indexOf(s) }));
    const missing = at.filter(x => x.i < 0).map(x => x.s);
    assert.deepStrictEqual(missing, [], `the pipeline walkthrough omits: ${missing.join(', ')}`);

    const order = at.map(x => x.i);
    const sorted = [...order].sort((a, b) => a - b);
    assert.deepStrictEqual(order, sorted,
        'the stages are not described in the order they are performed');
});

test('the guide says how to connect Claude Desktop at all', () => {
    // Everything else is useless without this, and it is the one step that
    // happens outside the app.
    const doc = guide();
    for (const bit of ['claude_desktop_config.json', 'mcp-server.js', 'FILM_DATA_DIR']) {
        assert.ok(doc.includes(bit), `the guide never mentions ${bit} — nobody can connect`);
    }
});
