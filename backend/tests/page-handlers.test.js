'use strict';

/**
 * -- A handler that calls a function nobody defined --------------------------
 *
 * Removing a page is only finished when everything it left behind goes with it.
 * The nine-page removal swept the buttons, the panels and 247 lines of loader,
 * and left NINE handlers calling loaders that no longer exist:
 * `loadRightsPage`, `loadProvenancePage`, `loadColorPipelinePage`,
 * `loadDubbingPage`, `loadBroadcastQCPage`, `loadSelects`, `loadContinuity`,
 * `loadColorPresets`, and `loadScreenplay`.
 *
 * Seven were unreachable and merely dead. The last one was NOT: `saveLocation`
 * calls it on the success path, so renaming a location that appears in the
 * screenplay saved correctly, updated the screenplay correctly, and then threw
 * `loadScreenplay is not defined` inside the surrounding try/catch — reporting
 * a successful write as `Error: ...`. That is the failure this codebase keeps
 * paying for from the other direction: something that worked, reported as
 * broken, which invites doing it again.
 *
 * Derived from the page rather than from a list, because the list is exactly
 * what nobody updates. The vendored three.js is excluded BY REGION rather than
 * by name: it is a minified library whose internal methods are indistinguishable
 * from calls by any textual rule, and including it produced 233 false positives
 * — a check that cries wolf 233 times is one nobody runs twice.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/**
 * The SPA's own script, with the vendored 3D library cut out.
 *
 * Sliced between the markers the vendor block is wrapped in rather than by line
 * number, so the region survives the file growing around it.
 */
function ownScript() {
    const blocks = [...PAGE.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(blocks.length >= 2, 'the page has no script blocks to read');
    const isVendor = src => /Three\.js Authors/.test(src) || /THREE\.GLTFLoader\s*=/.test(src);
    const mine = blocks.filter(b => !isVendor(b));
    /*
     * Both halves asserted. Dropping nothing means the library moved and every
     * one of its internals is back in the denominator (233 false positives, and
     * a check nobody runs twice); dropping everything means the SPA's own script
     * stopped matching and the test passes while checking an empty string.
     */
    assert.ok(mine.length < blocks.length, 'the vendored library was not excluded — the exclusion is stale');
    assert.ok(mine.length > 0, 'every script block was read as vendored — nothing of the page is being checked');
    return mine.join('\n');
}

/** Functions the page declares, at any nesting. */
function declared(src) {
    const out = new Set();
    for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1]);
    // `const f = async (…) =>` and `const f = function` count as declarations.
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g)) out.add(m[1]);
    return out;
}

test('no page handler calls a loader that does not exist', () => {
    /*
     * Scoped to PAGE LOADERS specifically — `loadX` / `renderXPage`. A general
     * "every call resolves" rule cannot be written against a 2MB page without a
     * parser: `createElement`, `updateMatrix` and every other method call looks
     * identical to a bare call by any regex. Page loaders are the class that
     * actually rots when a page is deleted, and are the class all nine belonged
     * to.
     */
    const src = ownScript();
    const decl = declared(src);
    const missing = new Map();

    for (const m of src.matchAll(/(?:^|[^\w.$])(load[A-Z][\w$]*)\s*\(/gm)) {
        const name = m[1];
        if (decl.has(name)) continue;
        // A method call on something (`x.loadFoo()`) is excluded by the leading
        // character class above; what is left is a bare call.
        if (!missing.has(name)) missing.set(name, []);
        // Name the enclosing function, or the report is a name with no address.
        const before = src.slice(0, m.index);
        const fn = [...before.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].pop();
        missing.get(name).push(fn ? fn[1] : '(top level)');
    }

    const lines = [...missing].map(([name, callers]) =>
        `  ${name}() — called by ${[...new Set(callers)].join(', ')}`);
    assert.equal(missing.size, 0,
        `${missing.size} page loader(s) are called and never defined. A removed page is not `
        + `removed until its callers go with it, and one of these sits on a SUCCESS path:\n${lines.join('\n')}`);
});

test('a successful location save is not reported as an error', () => {
    /*
     * The specific live case, pinned by behaviour rather than by the name that
     * happened to be wrong: the branch that runs when the screenplay WAS updated
     * must reach only functions that exist. Asserting the absence of the old
     * name would pass the moment somebody typos a different one.
     */
    const src = ownScript();
    const at = src.indexOf('async function saveLocation');
    assert.ok(at > -1, 'saveLocation is gone — this test names a function that no longer exists');
    const body = src.slice(at, src.indexOf('\n    async function ', at + 10));
    assert.ok(/screenplay_update/.test(body), 'saveLocation no longer handles a screenplay rename');

    const decl = declared(ownScript());
    for (const m of body.matchAll(/(?:^|[^\w.$])(load[A-Z][\w$]*)\s*\(/gm)) {
        assert.ok(decl.has(m[1]),
            `saveLocation calls ${m[1]}() on its success path and nothing defines it — `
            + 'the save works and the page reports "Error: ' + m[1] + ' is not defined"');
    }
});

test('every onclick names a function that exists', () => {
    /*
     * The other half of the same removal. Deleting a handler and leaving its
     * button is not a smaller version of the bug — it is the SAME bug pointed
     * the other way: a control that looks live, does nothing, and reports
     * nothing, which is indistinguishable from a broken feature.
     *
     * Nine handlers were removed with this page's dead pages, and three of them
     * still had a Save button sitting in an orphaned modal.
     */
    const src = ownScript();
    const decl = declared(src);
    // Names the page hands to the browser rather than calling itself.
    for (const g of ['alert', 'confirm', 'print', 'history', 'window', 'location', 'event']) decl.add(g);

    const dangling = new Map();
    for (const m of PAGE.matchAll(/on(?:click|change|input|submit)="\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (decl.has(m[1])) continue;
        if (!dangling.has(m[1])) dangling.set(m[1], 0);
        dangling.set(m[1], dangling.get(m[1]) + 1);
    }
    const lines = [...dangling].map(([n, c]) => `  ${n}() — ${c} control(s) point at it`);
    assert.equal(dangling.size, 0,
        `${dangling.size} control(s) call a function nothing defines. A button wired to nothing `
        + `looks identical to a working one until it is clicked:\n${lines.join('\n')}`);
});

test('every modal is shown with the class its own CSS displays', () => {
    /*
     * `.modal-overlay` is `display:none`, and exactly one class turns it back
     * on. Three modals were being shown by adding a DIFFERENT class, so they
     * never appeared at all: the screenplay's Title Page button, the screenplay
     * importer, and the live-action cost editor. Nothing threw, nothing was
     * logged, and the button simply did nothing — which reads as a dead feature
     * and is why the missing travel_allowance field on that form went unnoticed
     * for so long: the form it belongs to never opened.
     *
     * The display class is DERIVED from the stylesheet, not asserted as
     * 'open' — hardcoding it here would just move the second copy of the rule
     * into the test.
     */
    const shows = [...PAGE.matchAll(/\.modal-overlay\.([\w-]+)\s*\{([^}]*)\}/g)]
        .filter(m => /display\s*:\s*(?!none)/.test(m[2]))
        .map(m => m[1]);
    assert.equal(shows.length, 1,
        `expected exactly one class to display a .modal-overlay, found ${shows.length}: ${shows.join(', ')}`);
    const SHOW = shows[0];

    // Every id in the markup carrying class="modal-overlay", either order.
    const overlays = new Set();
    for (const m of PAGE.matchAll(/<div[^>]*class="[^"]*modal-overlay[^"]*"[^>]*id="([^"]+)"/g)) overlays.add(m[1]);
    for (const m of PAGE.matchAll(/<div[^>]*id="([^"]+)"[^>]*class="[^"]*modal-overlay[^"]*"/g)) overlays.add(m[1]);
    assert.ok(overlays.size > 5, `only ${overlays.size} overlays found — the scan is not seeing the markup`);

    const src = ownScript();
    const wrong = [];
    for (const m of src.matchAll(/getElementById\('([^']+)'\)\.classList\.add\('([^']+)'\)/g)) {
        if (overlays.has(m[1]) && m[2] !== SHOW) wrong.push(`${m[1]} is shown with "${m[2]}", not "${SHOW}"`);
    }
    /*
     * Via a local, which is how the third one hid: `const modal =
     * getElementById('titlePageModal')` … `modal.classList.add('active')`. An
     * inline-only rule reports that modal as correct, and the screenplay's
     * Title Page button silently does nothing.
     */
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\('([^']+)'\)/g)) {
        if (!overlays.has(m[2])) continue;
        const after = src.slice(m.index, m.index + 4000);
        const add = after.match(new RegExp('\\b' + m[1] + '\\.classList\\.add\\(\'([^\']+)\'\\)'));
        if (add && add[1] !== SHOW) wrong.push(`${m[2]} is shown with "${add[1]}", not "${SHOW}"`);
    }
    /*
     * And the modals built at runtime, which never appear in the markup: a
     * function that sets className to modal-overlay and then adds a class.
     */
    for (const m of src.matchAll(/className\s*=\s*'modal-overlay'[\s\S]{0,1200}?classList\.add\('([^']+)'\)/g)) {
        if (m[1] !== SHOW) wrong.push(`a modal built at runtime is shown with "${m[1]}", not "${SHOW}"`);
    }
    assert.equal(wrong.length, 0,
        `${wrong.length} modal(s) are shown with a class the stylesheet does not display, so they never `
        + `appear and the control that opens them looks dead:\n  ${wrong.join('\n  ')}`);
});

test('the cue rights editor sends every field the route accepts, from the served vocabulary', () => {
    /*
     * A control that EXISTS and whose value never reaches the request is the
     * same defect as no control at all, and it looks identical from the page:
     * you type a territory, press Save, and the field comes back empty. The
     * manual-edit audit checks that a control exists; this checks the value
     * travels.
     *
     * Derived from the route's own field list, so a seventh licence field is
     * covered with nothing to remember.
     */
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'assets.js'), 'utf8');
    const fn = routeSrc.slice(routeSrc.indexOf('function updateMusicRights'));
    const body = fn.slice(0, fn.indexOf('\nfunction ', 10));
    const fields = [...new Set([...body.matchAll(/body\.([a-z_]+)\s*!==\s*undefined/g)].map(m => m[1]))];
    assert.ok(fields.length >= 6, `only ${fields.length} licence fields found — the scan is not reading the route`);

    const page = ownScript();
    const at = page.indexOf('async function saveCueRights');
    assert.ok(at > -1, 'saveCueRights is gone — nothing saves a cue\'s rights');
    const saver = page.slice(at, page.indexOf('\n    /*', at));
    for (const f of fields) {
        assert.ok(new RegExp(`${f}\\s*:`).test(saver),
            `the rights editor never sends ${f} — the control is there and its value goes nowhere`);
    }

    /*
     * And the vocabulary is SERVED, not typed into the page. The route refuses
     * a status it does not know, so a second copy here is a set of options that
     * are rejected on save the first time somebody adds one — and the refusal
     * reads as saving being broken.
     */
    assert.ok(/vocabulary:\s*\{[^}]*license_status:\s*VALID_LICENSE_STATUSES/.test(routeSrc),
        'the rights vocabulary is not served, so the editor has nothing to build its options from');
    const statuses = routeSrc.match(/const VALID_LICENSE_STATUSES = \[([^\]]+)\]/);
    assert.ok(statuses, 'the status vocabulary is gone from the route');
    /*
     * Scoped to the editor's own body. Page-wide, this fires on the cost
     * modal's `<option value="unknown">Unknown</option>` for location type,
     * which is an unrelated field that happens to share a word — and a check
     * that cries wolf is one that gets switched off.
     */
    const opener = page.slice(page.indexOf('async function openCueRights'));
    const editor = opener.slice(0, opener.indexOf('\n    async function ', 10));
    /*
     * Bound to the vocabulary being the SOURCE of the options, not merely
     * mentioned: `['unknown','licensed'].map(...)` still renders
     * `value="${esc(v)}"`, so an attribute-level check passes on a hardcoded
     * list, and `/CUE_RIGHTS_VOCAB/` passes because the opener still fetches it.
     */
    assert.ok(/const opts = \(list, current\) => list\.map/.test(editor),
        'the option builder does not render the list it is handed');
    for (const field of ['license_status', 'license_type']) {
        assert.ok(new RegExp(`opts\\(CUE_RIGHTS_VOCAB\\.${field}`).test(editor),
            `${field} is not built from the served vocabulary — the page holds its own copy, `
            + 'which the route will refuse the first time somebody adds a value');
    }
    for (const v of statuses[1].split(',').map(x => x.trim().replace(/'/g, ''))) {
        assert.ok(!new RegExp(`value="${v}"`).test(editor),
            `the rights editor hardcodes the licence status "${v}" instead of rendering the served vocabulary`);
    }
});

test('the delivery pages reach every field their routes accept', () => {
    /*
     * Credits, title cards and subtitles all shipped their routes with the
     * delivery work and none of them shipped a page, so a credit's role, a
     * card's hold and a cue's language could only be written by curl or by an
     * agent. Derived from the routes, so a field added later is covered.
     *
     * Checked three ways per surface, because each fails differently: the page
     * exists, the editor sends the field, and the vocabulary is served rather
     * than typed into the page.
     */
    const page = ownScript();
    const surfaces = [
        { route: 'credits.js', fn: 'createCredit', saver: 'saveCredit', nav: 'titles' },
        { route: 'credits.js', fn: 'createTitleCard', saver: 'saveTitleCard', nav: 'titles' },
        { route: 'subtitles.js', fn: 'createSubtitle', saver: 'saveSubtitle', nav: 'subtitles' },
    ];

    for (const sf of surfaces) {
        assert.ok(new RegExp(`data-page="${sf.nav}"`).test(PAGE), `no nav button for ${sf.nav}`);
        assert.ok(new RegExp(`id="page-${sf.nav}"`).test(PAGE), `no page markup for ${sf.nav}`);

        const src = fs.readFileSync(path.join(__dirname, '..', 'routes', sf.route), 'utf8');
        const at = src.indexOf(`function ${sf.fn}`);
        assert.ok(at > -1, `${sf.fn} is gone from ${sf.route}`);
        const routeBody = src.slice(at, src.indexOf('\nfunction ', at + 10));
        const fields = [...new Set([...routeBody.matchAll(/body\.([a-z_]+)/g)].map(m => m[1]))]
            .filter(f => f !== 'project_id');
        assert.ok(fields.length >= 5, `${sf.fn}: only ${fields.length} fields found — the scan is not reading the route`);

        const sAt = page.indexOf(`async function ${sf.saver}`);
        assert.ok(sAt > -1, `${sf.saver} does not exist — the page cannot save this`);
        const saver = page.slice(sAt, page.indexOf('\n    async function ', sAt + 10));
        for (const f of fields) {
            assert.ok(new RegExp(`${f}\\s*:`).test(saver),
                `${sf.saver} never sends ${f} — the route accepts it and nothing on the page can set it`);
        }
    }

    /*
     * The vocabularies, served rather than retyped. `sections` and `card_types`
     * are validated on the way in, so a page holding its own copy offers values
     * the route silently coerces or refuses.
     */
    const credits = fs.readFileSync(path.join(__dirname, '..', 'routes', 'credits.js'), 'utf8');
    /*
     * Bound to the LIST handlers the page actually calls. credits.js answers
     * with a credit list from two places, so a file-wide check passes while the
     * one the editor reads serves nothing.
     */
    for (const [fn, key, constant] of [['listCredits', 'sections', 'VALID_SECTIONS'],
                                       ['listTitleCards', 'card_types', 'VALID_CARD_TYPES']]) {
        const at = credits.indexOf(`function ${fn}`);
        assert.ok(at > -1, `${fn} is gone from credits.js`);
        const body = credits.slice(at, credits.indexOf('\nfunction ', at + 10));
        assert.ok(new RegExp(`${key}:\\s*${constant}`).test(body),
            `${fn} does not serve its vocabulary, so the editor has nothing to build its options from`);
    }
    assert.ok(/vocabOptions\(TITLE_VOCAB\.sections/.test(page),
        'the credit editor does not build its sections from the served vocabulary');
    assert.ok(/vocabOptions\(TITLE_VOCAB\.card_types/.test(page),
        'the title-card editor does not build its types from the served vocabulary');
});

test('every page in the menu has a loader', () => {
    /*
     * A page can have a nav button, page markup and a place in both copies of
     * the grouping, and still open EMPTY because nothing is registered to fill
     * it — which reads as a broken feature rather than a missing wire, since
     * the button works and the panel appears.
     *
     * Derived from the server's own map, so a page added later is covered.
     */
    const { NAV_FLOW, ALWAYS_AVAILABLE } = require('../lib/nav-flow');
    const src = ownScript();
    const at = src.indexOf('const PAGE_LOAD');
    const mapAt = at > -1 ? at : src.search(/\b\w+\s*=\s*\{[^}]*dashboard:\s*load/);
    assert.ok(mapAt > -1, 'the page-loader map cannot be found — this check is looking at the wrong thing');
    const map = src.slice(mapAt, src.indexOf('};', mapAt));

    const pages = [...Object.values(NAV_FLOW).flatMap(g => g.pages), ...ALWAYS_AVAILABLE];
    const noLoader = pages.filter(pg => !new RegExp(`\\b${pg}\\s*:`).test(map));
    assert.deepEqual(noLoader, [],
        `these pages are in the menu with nothing registered to fill them, so they open empty: ${noLoader.join(', ')}`);
});
