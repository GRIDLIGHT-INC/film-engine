/**
 * The editor is one continuous scroll; pages are for the page COUNT and the PRINT.
 *
 * Page-break indicators lived inside the contenteditable, which is what made
 * them fragile: an indicator is a <div> with a class, no element type and no
 * text — indistinguishable from an empty block — so the orphan-adoption loop
 * ate five of them on every keystroke and turned each into 32px of nothing.
 * That was patched by teaching two passes to recognise furniture. Removing the
 * furniture from the editor entirely removes the CLASS of bug instead.
 *
 * But they were doing a SECOND job, and dropping them blindly would have been a
 * silent regression: `generatePrintHTML` carries
 * `.page-break-indicator { page-break-after: always }`, so those same nodes are
 * what break the pages in an exported PDF. Without them the browser breaks
 * wherever it likes — including between a character cue and its dialogue, which
 * is exactly what MAY_END_PAGE exists to prevent.
 *
 * So: paginate a DETACHED CLONE at print time, never the live editor.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

function bodyOf(name) {
    const i = SPA.indexOf(`function ${name}(`);
    assert.ok(i > 0, `${name} not found`);
    let depth = 0, j = SPA.indexOf('{', i), end = j;
    for (; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    return SPA.slice(i, end);
}

/* ── the editor holds no furniture ───────────────────────────────────── */

test('the stats pass no longer paginates the live editor', () => {
    const body = bodyOf('updateEditorStats');
    assert.ok(!/paginateInto\s*\(|updatePageBreakIndicators\s*\(/.test(body),
        'updateEditorStats still inserts page breaks into the editor the writer is typing in — '
        + 'that is what made them get adopted as empty blocks in the first place');
});

test('nothing inserts an indicator into the live editor', () => {
    // Derived: every call site of the paginator must be handed something other
    // than the live editor element.
    const calls = [...SPA.matchAll(/paginateInto\s*\(([^)]*)\)/g)].map(m => m[1].trim());
    assert.ok(calls.length >= 1, 'nothing paginates at all any more — the PDF would lose its pages');
    for (const arg of calls) {
        assert.ok(!/^editor$|getElementById\('screenplayEditor'\)/.test(arg),
            `paginateInto(${arg}) targets the live editor`);
    }
});

test('the page count survives, and never needed the indicators', () => {
    const body = bodyOf('calculatePageEstimate');
    assert.match(body, /\[data-element-type\]/,
        'the estimate should count BLOCKS, so it is independent of any page furniture');
    assert.ok(!/page-break-indicator/.test(body),
        'the page estimate reads the furniture it no longer has');
    // and it is still shown
    assert.match(SPA, /editorPageCount/, 'the page count is no longer displayed anywhere');
});

/* ── print keeps its pages ───────────────────────────────────────────── */

test('the PDF is paginated, on a detached copy', () => {
    const body = bodyOf('exportToPDF');
    assert.match(body, /paginateInto\s*\(/,
        'the export no longer paginates — the browser would break pages wherever it likes, '
        + 'including between a character cue and its dialogue');
    assert.ok(!/paginateInto\s*\(\s*editor\s*\)/.test(body),
        'the export paginates the LIVE editor, which puts the furniture straight back');
    assert.match(body, /cloneNode\s*\(\s*true\s*\)/,
        'the export must work on a clone, or it mutates what the writer is looking at');
});

test('the print stylesheet still knows what a page break is', () => {
    const body = bodyOf('generatePrintHTML');
    assert.match(body, /page-break-indicator/, 'the print CSS lost its page-break rule');
    assert.match(body, /page-break-after:\s*always/, 'the rule no longer breaks a page');
});

test('the paginator still honours what may not be split', () => {
    // The rule this whole thing exists for. Held in lockstep with
    // lib/screenplay-pagination.js by screenplay-pagination.test.js.
    const body = bodyOf('paginateInto');
    // Not just a mention of the table — the WALK. A break that lands between a
    // cue and its dialogue must move UP, taking the whole unit to the next
    // page; pushing it down orphans the dialogue, which is the bug itself.
    // The index expression is `MAY_END_PAGE[blocks[at].dataset.elementType]`,
    // which contains a ']' — so a [^\]] class cannot cross it and matches
    // nothing. Third time this codebase has paid for that; non-greedy instead.
    assert.match(body, /while\s*\([\s\S]{0,140}?MAY_END_PAGE[\s\S]{0,80}?===\s*false\s*\)\s*at--/,
        'pagination no longer walks the break up past things that belong together');
    assert.match(body, /lastBreakAt/,
        'nothing stops the walk landing on the same block twice');
});

/* ── and the defences stay, because a browser still leaves divs ──────── */

test('the furniture defences remain, even with no furniture to defend', () => {
    // A contenteditable will still hand us bare <div>s. Removing the
    // recognition because the indicators left would re-open the empty-block
    // bug the moment anything else inserts a node.
    assert.match(SPA, /function isEditorFurniture\s*\(/, 'furniture recognition was removed');
    assert.match(bodyOf('normalizeEditor'), /Furniture\s*\(/,
        'the normaliser stopped recognising furniture');
    assert.match(bodyOf('normalizeEditor'), /sweepEmptyBlocks\s*\(/,
        'the normaliser stopped sweeping empty blocks');
});
