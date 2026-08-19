/**
 * The sidebar must follow the order a film is actually made in.
 *
 * The app grew 34 pages across eighteen phases of work, and they were grouped
 * by what they ARE — production, elements, media, workflow — rather than by
 * when a filmmaker needs them. So Previs, which is a pre-production tool, sat
 * below Export; and Storyboard sat three groups away from the Shot Board it
 * feeds. The nav told you what the software contains instead of what to do next.
 *
 * The order is NOT invented here. `routes/production-status.js` already
 * declares the canonical one in PROJECT_PHASES, and the status machine advances
 * a project through exactly those nine. Deriving the sidebar from it means the
 * menu and the state machine cannot disagree about what phase a project is in.
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
const { NAV_FLOW, phaseOf, orderedPhases, ALWAYS_AVAILABLE } = require('../lib/nav-flow');

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

test('the phase order is the one the status machine already declares', () => {
    assert.ok(Array.isArray(PROJECT_PHASES) && PROJECT_PHASES.length === 9,
        'PROJECT_PHASES changed shape; the sidebar derives from it');
    const declared = orderedPhases().map(p => p.id);
    const expected = PROJECT_PHASES.filter(id => NAV_FLOW[id] && NAV_FLOW[id].pages.length);
    assert.deepStrictEqual(declared, expected,
        'the sidebar groups are not in production order');
});

test('every phase in the map is a real project phase', () => {
    const invented = Object.keys(NAV_FLOW).filter(id => !PROJECT_PHASES.includes(id));
    assert.deepStrictEqual(invented, [],
        `phases the status machine does not know: ${invented.join(', ')}`);
});

test('every phase group has a label a filmmaker would recognise', () => {
    const bad = Object.entries(NAV_FLOW).filter(([, p]) => !p.label || p.label.length < 3);
    assert.deepStrictEqual(bad.map(([id]) => id), []);
});

// ── Total coverage of the pages that exist ──────────────────────────────────

test('every page in the SPA is placed in exactly one phase', () => {
    const pages = pagesInSpa();
    assert.ok(pages.length >= 30, `only found ${pages.length} pages — the parse is wrong`);

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
    const order = page => PROJECT_PHASES.indexOf(phaseOf(page));
    assert.ok(order('screenplay') < order('shotboard'), 'the screenplay comes after the shot board');
    assert.ok(order('characters') < order('videoshots'), 'casting comes after shooting');
    assert.ok(order('videoshots') < order('colorgrading'), 'grading comes before shooting');
    assert.ok(order('colorgrading') <= order('exportpage'), 'export comes before the grade');
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
