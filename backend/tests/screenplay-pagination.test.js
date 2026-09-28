/**
 * A PAGE MAY NOT END BETWEEN THINGS THAT BELONG TOGETHER.
 *
 * Reported as "it adds double lines as I write, then fixes it when I leave the
 * screen and come back". The text was never damaged — the saved Fountain was
 * correct throughout, which is why returning to the page repaired it. What was
 * wrong was where the editor drew its page breaks: it counted lines and cut the
 * moment the count crossed 55, wherever that landed.
 *
 * On a real five-page screenplay that put THREE of five breaks in places the
 * format forbids — twice between a character cue and its dialogue, once between
 * a parenthetical and its dialogue. A cue stranded at the foot of a page leaves
 * its dialogue alone at the top of the next, where it reads as ACTION because
 * nothing above it says who is speaking.
 *
 * Set-based over ELEMENT_TYPES, the editor's own list of what it can produce,
 * because the failure is per type: fixing `character` while leaving
 * `parenthetical` and `scene-heading` broken passes any test written about the
 * case somebody happened to screenshot.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    ELEMENT_TYPES, MAY_END_PAGE, LINES_PER_PAGE, elementLines, pageBreakPositions,
} = require('../lib/screenplay-pagination');

/** The SPA itself: the rule is inlined there (build.target is single-html). */
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

test('every element type states whether a page may end after it', () => {
    /*
     * Declared per type rather than as a list of exceptions: a new element type
     * has to answer, instead of defaulting to breakable and being discovered in
     * a screenshot.
     */
    const missing = ELEMENT_TYPES.filter(t => typeof MAY_END_PAGE[t] !== 'boolean');
    assert.deepStrictEqual(missing, [],
        `these element types do not say whether a page may end after them: ${missing.join(', ')}`);

    const unknown = Object.keys(MAY_END_PAGE).filter(t => !ELEMENT_TYPES.includes(t));
    assert.deepStrictEqual(unknown, [],
        `the rule names types the editor cannot produce: ${unknown.join(', ')}`);

    /*
     * The ANSWERS are pinned, not just their presence.
     *
     * Every other assertion here derives its set FROM MAY_END_PAGE, so relaxing
     * the rule would shrink what is checked rather than fail anything — a
     * tautology, and mutation testing found it: flipping `parenthetical` to
     * breakable passed cleanly.
     *
     * These four are facts about screenplay format rather than preferences. A
     * cue without its dialogue, a parenthetical without the line it modifies, a
     * heading without its scene, and half a dual-dialogue are all things no
     * screenplay page is allowed to end on.
     */
    const MUST_NOT_END_A_PAGE = ['scene-heading', 'character', 'parenthetical', 'dual-dialogue'];
    const relaxed = MUST_NOT_END_A_PAGE.filter(t => MAY_END_PAGE[t] !== false);
    assert.deepStrictEqual(relaxed, [],
        `a page may now end on ${relaxed.join(', ')}, which orphans what follows`);
});

test('no page ends on an element that belongs with the next one', () => {
    /*
     * The whole rule, checked for EVERY keep-with-next type rather than for the
     * one that was reported. Each case builds a script whose break lands exactly
     * on that type and asserts the break moved up.
     */
    const keepWithNext = ELEMENT_TYPES.filter(t => MAY_END_PAGE[t] === false);
    assert.ok(keepWithNext.length >= 4,
        `expected several keep-with-next types, found ${keepWithNext.length}`);

    const broken = [];
    for (const type of keepWithNext) {
        // Fill to one line short of a page, then place the type under test so
        // the naive count breaks precisely after it.
        const blocks = [];
        let lines = 0;
        while (lines < LINES_PER_PAGE - 1) {
            blocks.push({ type: 'action', length: 50 });
            lines += elementLines('action', 50);
        }
        blocks.push({ type, length: 20 });               // the break would land here
        blocks.push({ type: 'dialogue', length: 40 });   // what it must not be split from
        blocks.push({ type: 'action', length: 50 });

        for (const at of pageBreakPositions(blocks)) {
            if (MAY_END_PAGE[blocks[at].type] === false) {
                broken.push(`${type}: a page still ends on "${blocks[at].type}"`);
            }
        }
    }
    assert.deepStrictEqual(broken, [],
        `page breaks orphan an element from what it belongs with:\n  ${broken.join('\n  ')}`);
});

test('the real screenplay that reported this no longer breaks illegally', () => {
    /*
     * The actual file, parsed to the same block shapes the editor holds. An
     * invented sequence can be made to pass; this is the document that produced
     * the screenshots.
     */
    const fixture = path.join(__dirname, 'fixtures', 'page-break-orphans.fountain');
    if (!fs.existsSync(fixture)) return;    // fixture optional; the synthetic cases carry the rule

    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    const blocks = [];
    let prev = null;
    for (const raw of lines) {
        const t = raw.trim();
        if (!t) { prev = null; continue; }
        let type = 'action';
        if (/^(INT|EXT|EST|INT\.\/EXT)[. ]/i.test(t)) type = 'scene-heading';
        else if (/^\(.*\)$/.test(t)) type = 'parenthetical';
        else if (/^[A-Z][A-Z0-9 .'()\-]*$/.test(t) && t.length < 40 && !prev) type = 'character';
        else if (prev === 'character' || prev === 'parenthetical' || prev === 'dialogue') type = 'dialogue';
        blocks.push({ type, length: t.length });
        prev = type;
    }

    const offenders = pageBreakPositions(blocks)
        .filter(at => MAY_END_PAGE[blocks[at].type] === false)
        .map(at => `page ends on ${blocks[at].type} at block ${at}`);
    assert.deepStrictEqual(offenders, [], offenders.join('; '));
});

test('the editor uses this rule rather than a second copy of it', () => {
    /*
     * The SPA cannot require a node module — build.target is single-html — so
     * the rule is inlined there and held to this one by assertion, the same
     * arrangement flow-seed has with PIPELINE_STEPS. Two paginators that
     * disagree is how the fix survives in tests and not on screen.
     */
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/MAY_END_PAGE/.test(html),
        'the editor does not consult the keep-with-next rule at all, so the page it draws '
        + 'can still break between a character cue and its dialogue');

    for (const type of ELEMENT_TYPES.filter(t => MAY_END_PAGE[t] === false)) {
        assert.ok(new RegExp(`'${type}'\\s*:\\s*false`).test(html),
            `the editor's copy of the rule does not mark '${type}' as keep-with-next`);
    }
});

test('no code reads the block next to a page break without stepping over it', () => {
    /*
     * The indicator is a divider with no data-element-type, so anything reading
     * the immediate sibling's TYPE sees undefined where a block should be.
     *
     * Most sibling walks in the editor loop with a type test and step over it
     * on their own — findSpeakingCharacter does, and returns the right speaker
     * with a break between the cue and its dialogue. The hazard is code that
     * reads `previousElementSibling.dataset.elementType` in ONE hop: Tab after a
     * scene heading silently changed behaviour when a break happened to land
     * between them.
     */
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    const offenders = [];
    const lines = html.split('\n');
    lines.forEach((line, i) => {
        // a one-hop read of a sibling's element type
        if (!/(?:previous|next)ElementSibling\s*;?\s*$/.test(line.trim())) return;
        const varName = (line.match(/(?:const|let|var)\s+(\w+)\s*=/) || [])[1];
        if (!varName) return;
        const window_ = lines.slice(i + 1, i + 4).join('\n');
        const readsType = new RegExp(`${varName}\\.dataset\\.elementType`).test(window_);
        const stepsOver = new RegExp(`while\\s*\\(${varName}[\\s\\S]{0,80}page-break-indicator`).test(window_);
        if (readsType && !stepsOver) offenders.push(`line ${i + 1}: reads ${varName}.dataset.elementType without skipping the indicator`);
    });

    assert.deepStrictEqual(offenders, [],
        `these would see a page break where a block should be:\n  ${offenders.join('\n  ')}`);
});

/*
 * THE TITLE PAGE IS NOT BODY PAGES.
 *
 * Found by enumerating the element types the EDITOR emits rather than the ones
 * this module happens to list. The editor emits eleven; `MAY_END_PAGE` answers
 * ten. The eleventh is `title-page`, and the paginator was reading it as an
 * ordinary block.
 *
 * It is display:none on screen and its own page in print, and
 * `film_script_elements` has no row for it — index 0 is the first scene
 * heading. Two consumers already excluded it by name and three did not, which
 * produced two separate defects from one cause:
 *
 *  - PAGINATION: measured on The Glass Harbour, the block reports
 *    display "none" and still scores 2 lines (46 characters of stored title
 *    data) against the 55-line budget, so EVERY page break in EVERY screenplay
 *    was placed two lines early. After the fix all five breaks on that file
 *    moved and all five are still legal.
 *  - INLINE COMMENTS: the anchor was `blocks.indexOf(block)` over a list whose
 *    index 0 is the title page, so the stored `element_index` was one higher
 *    than the element's real index. Read and write were off by the same one,
 *    so it LOOKED right in the editor while the value written to the database
 *    pointed at the previous element — wrong for the server, the export, and
 *    every reader that is not that one function. Nothing had been stored yet
 *    (0 rows in the live database and in the repo's), so there was nothing to
 *    migrate.
 */

/** Every `[data-element-type]` query the SPA makes against the editor. */
function blockQueries() {
    const out = [];
    const re = /(\w+)\.querySelectorAll\('\[data-element-type\][^']*'\)/g;
    let m;
    while ((m = re.exec(SPA))) {
        out.push({
            root: m[1],
            line: SPA.slice(0, m.index).split('\n').length,
            text: m[0],
            excludesTitlePage: /:not\(\[data-element-type="title-page"\]\)/.test(m[0]),
        });
    }
    return out;
}

test('the paginator does not count the title page', () => {
    const fn = SPA.slice(SPA.indexOf('function bodyBlocks'), SPA.indexOf('function bodyBlocks') + 700);
    assert.match(fn, /:not\(\[data-element-type="title-page"\]\)/,
        'bodyBlocks() must exclude the title page — it is not body pages');

    // And the paginator must actually USE it. A helper nothing calls is the
    // failure this codebase has paid for five times.
    const pag = SPA.slice(SPA.indexOf('// Remove existing page break indicators'));
    const body = pag.slice(0, pag.indexOf('page-break-indicator\';'));
    assert.match(body, /bodyBlocks\(/,
        'the paginator still builds its own block list, so the title page is still counted');
});

test('a comment is anchored against the body, not the DOM', () => {
    // Both ends of the round trip, because being wrong at BOTH ends is what
    // made this invisible: the offsets cancelled on screen and the stored
    // index was wrong for everyone else.
    for (const marker of ['const elementIndex = blocks.indexOf(block);',
                          'const block = blocks[c.element_index];']) {
        const at = SPA.indexOf(marker);
        assert.notStrictEqual(at, -1, `comment site missing: ${marker}`);
        const preceding = SPA.slice(Math.max(0, at - 400), at);
        assert.match(preceding, /const blocks = bodyBlocks\(/,
            `this comment site builds its own block list, so element_index is off by one: ${marker}`);
    }
});

test('every editor block query either excludes the title page or is exempt by name', () => {
    /*
     * Exempt by NAME with a reason, never by pattern. These are the queries
     * that genuinely may see the title page: the dual-dialogue columns cannot
     * contain one, and the rest iterate for styling or compute an index
     * RELATIVE to the same list they built, so a constant offset cancels.
     *
     * An exemption matching on text would quietly excuse the next site that
     * gets it wrong, which is exactly how three of five ended up wrong.
     */
    const EXEMPT_ROOTS = new Set(['leftCol', 'rightCol']);

    const offenders = blockQueries().filter(q => {
        if (q.excludesTitlePage) return false;
        if (EXEMPT_ROOTS.has(q.root)) return false;
        // Relative/cosmetic uses are allowed, but only where nothing downstream
        // treats the position as an absolute element index or a line budget.
        const after = SPA.slice(SPA.indexOf(q.text), SPA.indexOf(q.text) + 500);
        return /element_index|currentLine\s*[+=]/.test(after);
    });

    assert.deepStrictEqual(offenders.map(o => `line ${o.line}: ${o.text}`), [],
        'these sites treat a DOM position as a body index or a line budget while counting the title page');
});

/*
 * ── NO PAGE MAY RUN LONG ────────────────────────────────────────────────────
 *
 * The keep-with-next rule above was correct and was still not what people saw
 * on the page. The reason was one line earlier: the break was placed AFTER the
 * element that crossed 55, so a long action paragraph could carry a page to 69
 * lines. A print sheet is a fixed 11 inches and does not stretch — the browser
 * reflows an overfull page and inserts its OWN break, which lands wherever it
 * likes, and that is how a scene heading ended up alone at the foot of a page
 * with its action overleaf. MAY_END_PAGE never got a say, because the break
 * that stranded the heading was not one this module placed.
 *
 * Measured on the live Drive-In draft before the fix: page one, 69 lines.
 */

const P = require('../lib/screenplay-pagination');

function pagesOf(blocks) {
    const breaks = P.pageBreakPositions(blocks);
    const lines = blocks.map(b => P.elementLines(b.type, b.length || 0));
    const pages = [];
    let start = 0;
    for (const b of breaks.concat([blocks.length - 1])) {
        let sum = 0;
        for (let k = start; k <= b; k++) sum += lines[k];
        pages.push({ from: start, to: b, lines: sum });
        start = b + 1;
    }
    return pages;
}

test('no page carries more lines than fit on one', () => {
    // A long action paragraph in the middle, which is what a product-morph
    // script is full of and what the old rule overflowed on.
    const blocks = [];
    for (let i = 0; i < 20; i++) blocks.push({ type: 'action', length: 120 });   // 3 lines each
    blocks.push({ type: 'action', length: 1000 });                                // 18 lines
    for (let i = 0; i < 20; i++) blocks.push({ type: 'action', length: 120 });

    for (const page of pagesOf(blocks)) {
        assert.ok(page.lines <= P.LINES_PER_PAGE,
            `a page carries ${page.lines} lines against a budget of ${P.LINES_PER_PAGE} — `
            + 'the sheet cannot stretch, so the browser will break it somewhere the format forbids');
    }
});

test('a scene heading is never the last thing on a page', () => {
    // Heading + a paragraph too long to follow it on the same page: the pair
    // must travel together, which is the case the overflow used to hide.
    const blocks = [];
    for (let i = 0; i < 17; i++) blocks.push({ type: 'action', length: 120 });   // 51 lines
    blocks.push({ type: 'scene-heading', length: 30 });                          // 2
    blocks.push({ type: 'action', length: 600 });                                // 11
    blocks.push({ type: 'action', length: 120 });

    const breaks = P.pageBreakPositions(blocks);
    for (const at of breaks) {
        assert.notStrictEqual(blocks[at].type, 'scene-heading',
            'a page ends on a scene heading — its action is overleaf and the heading reads as a title');
    }
});

test('a page still ends somewhere, even when everything wants to stay together', () => {
    // A wall of unbreakable elements must not loop for ever or return nothing.
    const blocks = [];
    for (let i = 0; i < 80; i++) blocks.push({ type: 'character', length: 6 });
    const breaks = P.pageBreakPositions(blocks);
    assert.ok(breaks.length > 0, 'a document longer than a page produced no break at all');
    assert.ok(breaks.every((b, i) => i === 0 || b > breaks[i - 1]),
        'the breaks are not in ascending order — one page starts before the one before it ended');
});

test('the editor and this module place the SAME breaks', () => {
    /*
     * Two paginators that disagree is how a fix survives in tests and not on
     * screen. The SPA cannot require a node module (build.target is
     * single-html), so the rule is duplicated and this is what holds it.
     */
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const body = src.slice(src.indexOf('function paginateInto(container)'));
    const fn = body.slice(0, body.indexOf('\n    }\n'));

    assert.ok(/used > 0 && used \+ lineCount\[i\] > 55/.test(fn),
        'the editor still breaks AFTER the block that overflows, so its pages run long');
    assert.ok(/let at = i - 1;/.test(fn),
        'the editor walks up from the wrong element');
    assert.ok(/for \(let k = at \+ 1; k <= i; k\+\+\) used \+= lineCount\[k\]/.test(fn),
        'the editor does not carry the walked-past blocks onto the new page, so its next page starts empty');
    assert.ok(!/currentLine/.test(fn),
        'the editor still keeps a running document-wide line count, which is the overflowing rule');
});
