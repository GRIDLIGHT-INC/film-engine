/**
 * Could Film Engine be worked from a phone?
 *
 * Asked against the NeonCore precedent — a native React Native companion, iOS,
 * LAN-only, no cloud relay, talking to the orchestrator's HTTP API and scoped
 * to "answer approvals, launch workflows, unblock work" rather than porting the
 * dashboard.
 *
 * This checks the ASSESSMENT, not a mobile build. It exists because the answer
 * turns on facts about this codebase that are cheap to get wrong from memory:
 * how many surfaces there are, whether the API is reachable from another
 * device, and how much responsive layout actually exists. Every one of those is
 * derived here rather than recalled.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'plans', 'mobile-feasibility.md');
const SPA = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

function doc() {
    assert.ok(fs.existsSync(DOC), `the assessment does not exist at ${DOC}`);
    return fs.readFileSync(DOC, 'utf8');
}

/** Every page the SPA can show. */
function pages() {
    return [...new Set([...SPA.matchAll(/id="page-([a-z0-9]+)"/g)].map(m => m[1]))].sort();
}

/** Every media query, and what it governs. */
function mediaQueries() {
    const out = [];
    for (const m of SPA.matchAll(/@media\s*([^{]+)\{/g)) {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < SPA.length && depth > 0) {
            if (SPA[i] === '{') depth++;
            else if (SPA[i] === '}') depth--;
            i++;
        }
        out.push({ query: m[1].trim(), body: SPA.slice(m.index + m[0].length, i - 1) });
    }
    return out;
}

test('the assessment exists and is an assessment, not a wish', () => {
    const d = doc();
    assert.ok(d.length > 6000, `${d.length} characters is a note, not an assessment`);
    for (const heading of ['Precedent', 'Measured', 'Option', 'Recommendation']) {
        assert.ok(new RegExp(heading, 'i').test(d), `no "${heading}" section`);
    }
});

test('every page is classified, none left out', () => {
    /*
     * 38 pages. A mobile plan that covers the interesting ones and quietly
     * omits the rest is the half-done answer this standard exists to prevent —
     * and "which pages are worth a phone" is the whole design question, so the
     * omission would be the deliverable going missing.
     */
    const d = doc();
    const missing = pages().filter(p => !d.includes(p));
    assert.deepStrictEqual(missing, [],
        `these pages have no place in the mobile assessment: ${missing.join(', ')}`);
});

test('the count of pages is stated, and is the real one', () => {
    // A stated number that drifts is worse than none: the next reader plans
    // against it.
    const d = doc();
    assert.ok(d.includes(`${pages().length} page`),
        `the assessment does not state the real page count (${pages().length})`);
});

test('the responsive reality is stated, not assumed', () => {
    /*
     * There ARE media queries, which makes "it is already responsive" an easy
     * and wrong conclusion. Derived: how many touch the APP SHELL — the
     * sidebar, the top bar, the page grids — versus one home widget, the guide
     * and an onboarding dock.
     */
    const shellSelectors = /\.sidebar|\.main-content|\.fe-rail|\.fe-top|body\s*\{/;
    const queries = mediaQueries().filter(q => !/print/.test(q.query));
    const shellAware = queries.filter(q => shellSelectors.test(q.body));

    assert.ok(queries.length >= 3, 'the media-query detector is not reading the page');

    const d = doc();
    assert.ok(d.includes(`${queries.length} media`) || d.includes(`${queries.length} screen`),
        `the assessment does not state how many non-print media queries exist (${queries.length})`);

    /*
     * The load-bearing claim, inverted by Option B. It used to be "no query
     * touches the shell"; it is now "exactly one does, and it is the phone
     * breakpoint". A second shell-aware query is the thing to catch: two
     * breakpoints editing the same offsets is how a layout acquires a width
     * at which it is broken and nobody owns the rule.
     */
    assert.strictEqual(shellAware.length, 1,
        `expected exactly one shell-aware media query (the phone breakpoint), got ${shellAware.length}`);
    assert.match(shellAware[0].query, /max-width:\s*700px/,
        'the one shell-aware query should be the phone breakpoint');
    assert.match(d, /shell/i, 'the assessment does not distinguish the app shell from incidental rules');
});

test('the transport facts are stated, and each is true', () => {
    /*
     * These decide whether ANY mobile surface is possible, and all three are
     * checkable. Getting one wrong turns a two-line fix into a rewrite, or the
     * reverse.
     */
    const d = doc();
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const dev = fs.readFileSync(path.join(__dirname, '..', 'dev-server.js'), 'utf8');

    // 1. the API binds every interface (no host argument to listen)
    assert.match(server, /server\.listen\(PORT,\s*\(\)/,
        'the API now binds a specific host — the assessment assumes it is LAN-reachable');
    assert.match(d, /LAN|0\.0\.0\.0|every interface/i, 'the assessment does not say whether the API is reachable');

    // 2. CORS permits any origin
    assert.match(server, /Access-Control-Allow-Origin', '\*'/,
        'CORS no longer allows any origin — a phone app could not call it');
    assert.match(d, /CORS/i, 'the assessment does not mention CORS');

    // 3. the PAGE server was localhost-only — the concrete blocker, now openable
    assert.match(dev, /FILM_ENGINE_HOST/,
        'the page server must offer a way onto the LAN — it was the one hard blocker');
    assert.match(d, /127\.0\.0\.1|localhost only|loopback/i,
        'the assessment does not name the page server binding, which is the one hard blocker');
    // ...and that blocker is now openable, without the default moving.
    assert.strictEqual(require('../dev-server.js').bindHost({}), '127.0.0.1',
        'the page server must still default to loopback');
});

test('the agent surface is weighed, because it is already mobile', () => {
    /*
     * 179 MCP tools reachable from Claude on a phone is a working mobile
     * surface that exists TODAY and cost nothing. An assessment that proposes
     * building an app without weighing it is recommending work against a
     * baseline it has not measured.
     */
    const d = doc();
    const tools = require('../lib/mcp-tools').listTools().length;
    assert.ok(d.includes(String(tools)), `the assessment does not state the real tool count (${tools})`);
    assert.match(d, /MCP/, 'the assessment never considers the agent path');
});

test('the NeonCore precedent is read, not imagined', () => {
    // The question was asked in its terms, so the answer has to engage with
    // what it actually is rather than with "a mobile app".
    const d = doc();
    assert.match(d, /React Native/i, 'the assessment does not say what NeonCore mobile is built with');
    assert.match(d, /LAN|companion/i, 'the assessment misses that it is a LAN-only companion, not a port');
});

test('options are compared with their costs, not just listed', () => {
    const d = doc();
    // At least three genuinely different shapes, each with a stated cost.
    for (const option of ['responsive', 'native', 'agent']) {
        assert.ok(new RegExp(option, 'i').test(d), `no ${option} option considered`);
    }
    assert.match(d, /single-html|build\.target/,
        'the assessment ignores the constraint that shapes every option here');
});
