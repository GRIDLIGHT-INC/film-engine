/**
 * The sidebar must follow the order a film is actually made in.
 *
 * The app grew 34 pages across eighteen phases of work, and they were grouped
 * by what they ARE — production, elements, media, workflow — rather than by
 * when a filmmaker needs them. So Previs, which is a pre-production tool, sat
 * below Export; and Storyboard sat three groups away from the Shot Board it
 * feeds. The nav told you what the software contains instead of what to do next.
 *
 * The order USED to be derived from PROJECT_PHASES, so the menu and the status
 * machine could not disagree about what phase a project was in. That derivation
 * was given up when the menu was reorganised into four groups that cut across
 * the nine phases — Consistency is pre-production and sits under Plan, Assets is
 * an export surface and sits under Post — and no merge of the nine produces the
 * four. See `lib/nav-flow.js` and `tests/nav-reorg.test.js`.
 *
 * What survives here is the part that was doing the work: no page vanishes, no
 * page appears twice, every page has a panel, and the order still runs write →
 * plan → shoot → finish.
 *
 * Set-based over every data-page in the SPA: a page missing from the map is a
 * page that disappears from the sidebar, which is a worse failure than being in
 * the wrong group.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PROJECT_PHASES } = require('../routes/production-status');
const { NAV_FLOW, GROUP_ORDER, phaseOf, orderedPhases, ALWAYS_AVAILABLE } = require('../lib/nav-flow');

const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');

/** Every page the SPA can navigate to, straight out of the markup. */
function pagesInSpa() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    return [...new Set([...html.matchAll(/data-page="([a-z0-9]+)"/g)].map(m => m[1]))].sort();
}

/** Every page that has a panel to show. */
function pagePanels() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    return [...new Set([...html.matchAll(/id="page-([a-z0-9]+)"/g)].map(m => m[1]))].sort();
}

// ── The order comes from the state machine ──────────────────────────────────

test('the group order is declared once, and the map matches it', () => {
    // GROUP_ORDER is the single statement of sequence. Two lists — one implicit
    // in object key order and one explicit — is how a menu comes to disagree
    // with itself depending on which the reader trusts.
    const declared = orderedPhases().map(p => p.id);
    const expected = GROUP_ORDER.filter(id => NAV_FLOW[id] && NAV_FLOW[id].pages.length);
    assert.deepStrictEqual(declared, expected,
        'the sidebar groups are not in the declared order');
});

test('every group in the map is one the order knows about', () => {
    const orphaned = Object.keys(NAV_FLOW).filter(id => !GROUP_ORDER.includes(id));
    assert.deepStrictEqual(orphaned, [],
        `groups missing from GROUP_ORDER would never be shown: ${orphaned.join(', ')}`);
});

test('every phase group has a label a filmmaker would recognise', () => {
    const bad = Object.entries(NAV_FLOW).filter(([, p]) => !p.label || p.label.length < 3);
    assert.deepStrictEqual(bad.map(([id]) => id), []);
});

// ── Total coverage of the pages that exist ──────────────────────────────────

test('every page in the SPA is placed in exactly one phase', () => {
    const pages = pagesInSpa();
    assert.ok(pages.length >= 25, `only found ${pages.length} pages — the parse is wrong`);

    // "In exactly one phase" OR pinned as always-available — those are the two
    // legal homes, and a page in neither is one that vanishes from the sidebar.
    const unplaced = pages.filter(p => !phaseOf(p) && !ALWAYS_AVAILABLE.includes(p));
    assert.deepStrictEqual(unplaced, [],
        `pages that would vanish from the sidebar: ${unplaced.join(', ')}`);

    const duplicated = [];
    for (const page of pages) {
        const owners = Object.entries(NAV_FLOW).filter(([, p]) => p.pages.includes(page)).map(([id]) => id);
        const alsoAlways = ALWAYS_AVAILABLE.includes(page) ? 1 : 0;
        if (owners.length + alsoAlways > 1) duplicated.push(`${page}: ${owners.concat(alsoAlways ? ['always'] : []).join(', ')}`);
    }
    assert.deepStrictEqual(duplicated, [], `pages in two places: ${duplicated.join('; ')}`);
});

test('the map never names a page the SPA does not have', () => {
    const pages = new Set(pagesInSpa());
    const ghosts = [...Object.values(NAV_FLOW).flatMap(p => p.pages), ...ALWAYS_AVAILABLE]
        .filter(p => !pages.has(p));
    assert.deepStrictEqual(ghosts, [], `map points at pages that do not exist: ${ghosts.join(', ')}`);
});

test('every navigable page has a panel to show', () => {
    // Catches a nav entry whose panel was renamed: the click would blank the
    // main area rather than error, which is the kind of break nobody reports.
    const panels = new Set(pagePanels());
    const missing = pagesInSpa().filter(p => !panels.has(p));
    assert.deepStrictEqual(missing, [], `nav items with no panel: ${missing.join(', ')}`);
});

// ── The flow makes sense as a flow ──────────────────────────────────────────

test('previs sits with the storyboard, because they are one loop', () => {
    // This originally asserted previs came BEFORE the storyboard, on the
    // reasoning that blocking informs the frame. That was true when the two
    // were a hand-off. They are now a loop — a blocking shapes the keyframe,
    // the keyframe is blocked against, and /previs/apply writes the result back
    // to the card — so separating them by a phase boundary describes a
    // workflow nobody has any more. The original complaint (previs stranded
    // below Export) is still guarded: it must not fall after the board.
    assert.strictEqual(phaseOf('previs'), phaseOf('storyboard'),
        'previs and the storyboard are the same decision seen twice and belong together');
    assert.ok(PROJECT_PHASES.indexOf(phaseOf('previs')) <= PROJECT_PHASES.indexOf(phaseOf('production')),
        'previs is ordered after the shoot it is supposed to plan');
});

test('you write before you shoot, and shoot before you finish', () => {
    // Grading and the colour pipeline were removed from the app, so the two
    // assertions anchored on them are replaced by the same claim over surfaces
    // that still exist. Deleting them outright would have quietly dropped the
    // half of this test that checks POST comes last.
    const order = page => GROUP_ORDER.indexOf(phaseOf(page));
    assert.ok(order('screenplay') < order('shotboard'), 'the screenplay comes after the shot board');
    assert.ok(order('characters') < order('videoshots'), 'casting comes after shooting');
    assert.ok(order('videoshots') < order('exportpage'), 'export comes before shooting');
    assert.ok(order('storyboard') < order('videoshots'), 'the board comes after the footage');
});

test('the always-available pages are the ones with no phase', () => {
    // A dashboard and a settings screen belong to no phase; forcing them into
    // one would put them in the wrong place eight times out of nine.
    for (const page of ALWAYS_AVAILABLE) {
        assert.strictEqual(phaseOf(page), null, `${page} is both always-available and in a phase`);
    }
    assert.ok(ALWAYS_AVAILABLE.includes('dashboard'));
    assert.ok(ALWAYS_AVAILABLE.includes('settings'));
});

test('no phase is a dumping ground', () => {
    // A group holding half the app is the old "workflow" bucket under a new
    // name, and communicates nothing about order.
    const total = Object.values(NAV_FLOW).reduce((n, p) => n + p.pages.length, 0);
    for (const [id, phase] of Object.entries(NAV_FLOW)) {
        assert.ok(phase.pages.length <= Math.ceil(total * 0.4),
            `${id} holds ${phase.pages.length} of ${total} pages`);
    }
});

test('the SPA renders the sidebar from this map rather than a second copy', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.ok(html.includes('/nav-flow'), 'the SPA never fetches the flow');
    assert.ok(html.includes('applyNavFlow'), 'no function applies the flow to the sidebar');
});

test('the panel and the server agree about which pages exist', () => {
    /*
     * There are TWO copies of the grouping: lib/nav-flow.js on the server, and
     * `var PHASES` in the chrome, which is what a person actually sees. They
     * used to be different groupings that merely had to overlap; they are now
     * the SAME four groups, and tests/nav-reorg.test.js holds them equal
     * element by element. This check stays as the weaker containment one,
     * because it is what caught the marketing page and costs nothing.
     *
     * So a page could be correctly placed server-side, pass every test here,
     * and still be absent from the panel a director actually reads. That is
     * what happened to the marketing page: reachable by its nav button, listed
     * nowhere. Silent, and indistinguishable from the page not existing.
     */
    const fs = require('fs'), path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

    const block = html.slice(html.indexOf('var PHASES = ['));
    const panelPages = new Set([...block.slice(0, block.indexOf('var RAIL'))
        .matchAll(/pages:\[([^\]]*)\]/g)]
        .flatMap(m => m[1].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')))
        .filter(Boolean));
    assert.ok(panelPages.size >= 20, `parsed only ${panelPages.size} panel pages — the parse is wrong`);

    const missing = [];
    for (const [phase, spec] of Object.entries(NAV_FLOW)) {
        for (const page of spec.pages) {
            if (!panelPages.has(page)) missing.push(`${page} (server phase: ${phase})`);
        }
    }
    assert.deepStrictEqual(missing, [],
        `placed on the server but absent from the panel, so they are unreachable there: ${missing.join(', ')}`);
});
