/**
 * The style-book QA specification, held to the code it describes.
 *
 * A test plan is only worth the coverage it can prove. This derives the
 * subsystem's surface from the CODE — the route dispatch, the library's own
 * exports, the MCP registry, the facet lists, the link classifier — and
 * requires the specification to name a case for every item in it. A plan
 * written from the feature description instead would be complete on the day
 * it was written and silently short one route the next.
 *
 * It also requires each case to carry all four parts the brief asks for
 * (scenario, inputs, expected, what failure means). "What failure means" is
 * the one that gets dropped, and it is the one that decides whether a red
 * test gets fixed or deleted.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DOC_PATH = path.join(__dirname, '../../docs/plans/style-book-qa.md');
const doc = () => fs.readFileSync(DOC_PATH, 'utf8');

/** Identifier match, not substring: `deleteMedia` must not match `deleteMediaX`. */
const names = (text, id) => new RegExp('\\b' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text);

const routeSrc = fs.readFileSync(path.join(__dirname, '../routes/style-book.js'), 'utf8');
const lib = require('../lib/style-book');

/* ── the derived surface ─────────────────────────────────────────────── */

/** Every (method, handler) the router actually dispatches. */
function routeOps() {
    const h = routeSrc.slice(routeSrc.indexOf('function handleStyleBook'));
    return [...h.matchAll(/req\.method === '(\w+)'\) return (\w+)\(/g)]
        .map(m => ({ method: m[1], handler: m[2] }));
}

/** Every link kind the classifier can return, plus its refusal. */
function linkKinds() {
    const fn = routeSrc.slice(routeSrc.indexOf('function classifyLink'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const kinds = [...body.matchAll(/link_kind: '(\w+)'/g)].map(m => m[1]);
    return [...new Set(kinds)];
}

function mcpTools() {
    const m = require('../lib/mcp-tools');
    return (m.buildTools || m.listTools)().filter(t => /^stylebook_/.test(t.name)).map(t => t.name);
}

/**
 * The tests that police this subsystem, from the implementation plan rather
 * than from memory — the plan is what the architecture step committed to.
 */
const INTEGRATION_CONTRACTS = ['docs-drift', 'mcp-no-server-llm', 'nav-chrome',
    'nav-flow', 'test-isolation', 'manual-edit', 'project-delete', 'card-overflow'];

/* ── the specification must exist and be a specification ─────────────── */

test('the QA specification exists and is a specification, not a sketch', () => {
    assert.ok(fs.existsSync(DOC_PATH), 'docs/plans/style-book-qa.md does not exist');
    const d = doc();
    assert.ok(d.length > 6000, `the spec is ${d.length} bytes — too short to cover 53 items`);
    assert.match(d, /acceptance/i, 'a QA spec must state acceptance criteria');
});

test('every case carries all four parts, including what failure means', () => {
    const d = doc();
    const cases = [...d.matchAll(/^#### (SB-[A-Z]+-\d+)\b(.*)$/gm)];
    assert.ok(cases.length >= 40, `only ${cases.length} identified cases found`);
    for (const c of cases) {
        const start = c.index;
        const next = d.indexOf('\n#### ', start + 1);
        const body = d.slice(start, next === -1 ? d.length : next);
        for (const part of ['Scenario', 'Inputs', 'Expected', 'Failure means']) {
            assert.ok(new RegExp('\\*\\*' + part + '\\*\\*').test(body),
                `${c[1]} is missing its **${part}** line`);
        }
    }
});

test('case ids are unique — a duplicate id hides a case', () => {
    const ids = [...doc().matchAll(/^#### (SB-[A-Z]+-\d+)/gm)].map(m => m[1]);
    assert.strictEqual(new Set(ids).size, ids.length,
        'duplicate case ids: ' + ids.filter((v, i) => ids.indexOf(v) !== i).join(', '));
});

/* ── coverage, set-based over each derived registry ──────────────────── */

test('every route operation the router dispatches has at least one case', () => {
    const d = doc();
    const ops = routeOps();
    assert.strictEqual(ops.length, 11, `the route surface changed: ${ops.length} operations`);
    for (const { method, handler } of ops) {
        assert.ok(names(d, method) && names(d, handler),
            `no case covers ${method} -> ${handler}()`);
    }
});

test('every library export is accounted for', () => {
    const d = doc();
    for (const name of Object.keys(lib)) {
        assert.ok(names(d, name), `the spec never mentions lib/style-book.js export ${name}`);
    }
});

test('every MCP tool has a case — the agent path is how this pipeline is driven', () => {
    const d = doc();
    const tools = mcpTools();
    assert.strictEqual(tools.length, 6, `expected 6 stylebook_* tools, got ${tools.length}`);
    for (const t of tools) assert.ok(names(d, t), `no case covers the ${t} tool`);
});

test('every camera facet is given a disposition — carried or skipped', () => {
    const d = doc();
    const facets = [...lib.mergeableFacets(), ...lib.POSE_FACETS];
    assert.strictEqual(facets.length, 10, `facet set changed: ${facets.length}`);
    for (const f of facets) assert.ok(names(d, f), `facet ${f} has no stated disposition`);
});

test('every field an entry must NEVER write is named', () => {
    // A style-book entry writing a delivery spec onto a card would put look
    // development into one shot. The list exists; nothing tested it.
    const d = doc();
    for (const f of lib.NEVER_WRITES) {
        assert.ok(names(d, f), `NEVER_WRITES field ${f} is not covered by any case`);
    }
});

test('every link classification, and the refusal, has a case', () => {
    const d = doc();
    const kinds = linkKinds();
    assert.strictEqual(kinds.length, 5, `link kinds changed: ${kinds.join(', ')}`);
    for (const k of kinds) assert.ok(new RegExp(`\\b${k}\\b`).test(d), `link kind ${k} is uncovered`);
    assert.match(d, /javascript:|data:|non-http|protocol/i,
        'the spec does not cover refusing a non-http(s) URL, which is a script-injection path');
});

test('every integration contract the plan committed to is carried into QA', () => {
    const d = doc();
    for (const c of INTEGRATION_CONTRACTS) {
        assert.ok(names(d, c), `integration contract ${c} is not covered`);
    }
});

/* ── the audit has to be honest about what is NOT covered today ──────── */

test('the gap list matches reality in BOTH directions', () => {
    /*
     * A gap list is only useful while it is true. Checked both ways: an
     * identifier the shipped tests now exercise must NOT still be listed as a
     * gap, and one they do not must still be listed. A stale gap list is worse
     * than none, because it is believed.
     */
    const d = doc();
    const shipped = ['style-book', 'style-book-media', 'style-book-gaps'].map(f =>
        fs.readFileSync(path.join(__dirname, `${f}.test.js`), 'utf8')).join('\n');

    const gapSection = d.slice(d.search(/^## Gaps/im));
    for (const id of ['NEVER_WRITES', 'NAME_MAX', 'sort_order']) {
        const covered = shipped.includes(id);
        const listedAsGap = /\*\*GAP\*\*/.test(gapSection) && gapSection.includes(id)
            && /what is NOT covered/i.test(gapSection);
        assert.ok(covered, `${id} is still not exercised by any shipped test`);
        assert.ok(!listedAsGap, `${id} is covered but the spec still lists it as a gap`);
    }
    // Scoped to CASE BODIES: the document's own sentence explaining the
    // COVERED/GAP convention is prose, not a case marking.
    const cases = [...d.matchAll(/^#### (SB-[A-Z]+-\d+)/gm)];
    const open = cases.filter((c, i) => /\*\*GAP\*\*/.test(
        d.slice(c.index, i + 1 < cases.length ? cases[i + 1].index : d.length))).map(c => c[1]);
    assert.deepStrictEqual(open, [],
        'still marked GAP — close them or say in the gap section why they stay open');
    assert.match(d, /^##.*gap/im, 'the spec has no gap section');
});

test('the spec states which cases are already covered, so it is an audit', () => {
    const d = doc();
    assert.ok(/covered/i.test(d) && /gap/i.test(d),
        'a QA spec for a built subsystem must say what is already covered and what is not');
    for (const f of ['style-book.test.js', 'style-book-media.test.js'])
        assert.ok(d.includes(f), `the spec does not reference the existing ${f}`);
});
