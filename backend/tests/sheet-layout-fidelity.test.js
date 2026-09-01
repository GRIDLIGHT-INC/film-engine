/**
 * The three sheets, laid out as the reference images draw them
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "I have 3 templates that we've applied but the html didn't quite come out the
 *  same way the design was... The biggest issues are at the bottom where the
 *  images are too big, sections aren't organized properly on all three."
 *
 * The screenshots in the repo root are the spec — `design-ref-character.png`,
 * `design-ref-location.png`, `design-ref-prop.png` — and where the HTML
 * disagrees with them, the image wins. The checked-in `.dc.html` handoff is NOT
 * the authority here: it may predate these images, and 70 tests already pass
 * against it while the render is wrong.
 *
 * WHY THE EXISTING TESTS DID NOT CATCH THIS. `subject-sheet-design` asserts
 * every element the design LABELS is present; `subject-sheet-fidelity` asserts
 * each layout declaration is declared and worn. Both are about PRESENCE. The
 * complaint is about ORDER, COLUMN and SIZE — three things nothing measured.
 * Measured in a real browser before this test existed, on THE MAN's own sheet:
 * `PHYSICAL SPEC` rendered in the RIGHT column as three equal columns where the
 * design puts it in the LEFT as a 2x2, `PALETTE` sat bottom-right where the
 * design has it under the spec on the left, and `DESCRIPTION` / `PERSONALITY`
 * were stacked full width where the design sets them side by side.
 *
 * The denominator is the reference layout itself, one entry per section per
 * kind, so a section that moves fails rather than being noticed by eye.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');


/**
 * The stylesheet with every `@media` block removed.
 *
 * `.cs-spec` is declared TWICE: `repeat(3,1fr)` at the base and `1fr 1fr`
 * inside a narrow-viewport query. A search over the whole file found the
 * responsive one and passed, while the browser computed three columns at the
 * width the sheet actually opens at — the same mistake mobile-shell.test.js
 * exists to prevent, made in the other direction.
 */
function baseCss() {
    let out = UI, prev;
    do { prev = out; out = out.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, ''); }
    while (out !== prev);
    return out;
}

test('the reference images are present, and they are the spec', () => {
    for (const f of ['design-ref-character.png', 'design-ref-location.png', 'design-ref-prop.png']) {
        const p = path.join(ROOT, f);
        assert.ok(fs.existsSync(p), `${f} is missing — the spec for this layout is gone`);
        assert.ok(fs.statSync(p).size > 50000, `${f} is too small to be the screenshot`);
    }
});

/** A renderer's source, by brace depth from its declaration. */
function renderer(name) {
    const m = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(UI);
    assert.ok(m, `${name} is gone`);
    let i = UI.indexOf('(', m.index), depth = 0;
    for (; i < UI.length; i++) {
        if (UI[i] === '(') depth++;
        else if (UI[i] === ')') { depth--; if (!depth) { i++; break; } }
    }
    i = UI.indexOf('{', i); depth = 0;
    for (let j = i; j < UI.length; j++) {
        if (UI[j] === '{') depth++;
        else if (UI[j] === '}') { depth--; if (!depth) return UI.slice(m.index, j + 1); }
    }
    assert.fail(`${name} does not close`);
}

/** Where each marker first appears, so their ORDER can be compared. */
function orderOf(src, markers) {
    return markers.map(mk => ({ mk, at: src.indexOf(mk) }));
}

function assertOrder(src, markers, why) {
    const found = orderOf(src, markers);
    const missing = found.filter(f => f.at < 0).map(f => f.mk);
    assert.deepStrictEqual(missing, [], `${why}: these blocks are absent — ${missing.join(', ')}`);
    for (let i = 1; i < found.length; i++) {
        assert.ok(found[i].at > found[i - 1].at,
            `${why}: "${found[i].mk}" comes before "${found[i - 1].mk}" — `
            + `the reference orders them ${markers.join(' → ')}`);
    }
}

// ---------------------------------------------------------------------------
// CHARACTER — design-ref-character.png
// ---------------------------------------------------------------------------

test('CHARACTER: the left column is views → spec → palette, as the image draws it', () => {
    /*
     * Measured before the fix: the spec and the palette were both in the RIGHT
     * column, which is what "sections aren't organized properly" meant here.
     */
    const src = renderer('characterSheetHtml');
    const left = src.slice(src.indexOf('cs-col-l'), src.indexOf('cs-col-r'));
    assert.ok(left.length > 100, 'the left column is empty — the two-column split is gone');
    assertOrder(left, ['cs-views-block', 'cs-physical', 'cs-palette'],
        'character left column');
});

test('CHARACTER: the right column is appearance → description/personality → wardrobe', () => {
    const src = renderer('characterSheetHtml');
    const right = src.slice(src.indexOf('cs-col-r'));
    assertOrder(right, ['cs-details', 'cs-wardrobe'], 'character right column');
    assert.ok(!/cs-physical|cs-palette/.test(right),
        'the spec or the palette is still in the right column; the reference puts both on the left');
});

test('CHARACTER: description and personality sit side by side, not stacked', () => {
    /*
     * The image sets them as two columns under one rule. Stacked full-width is
     * what the build did, and it is why the right column ran long and pushed
     * the references below the fold.
     */
    const src = renderer('characterSheetHtml');
    assert.match(src, /cs-two-up|cs-dp/,
        'DESCRIPTION and PERSONALITY are not wrapped in a two-column block');
    assert.match(baseCss(), /\.cs-two-up\s*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(2)/,
        'the two-up block is not actually two columns in CSS');
});

test('CHARACTER: the physical spec is a 2x2, not a row of three', () => {
    assert.match(baseCss(), /\.cs-spec\s*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(2)[^}]*\}/,
        'the spec grid is not two columns — measured at three equal columns in the browser, '
        + 'where the reference draws AGE|HEIGHT over BUILD|ERA');
});

// ---------------------------------------------------------------------------
// The bottom strip — the complaint that was named first
// ---------------------------------------------------------------------------

test('the reference strip is a row of COMPACT uniform thumbnails on every sheet', () => {
    /*
     * "The biggest issues are at the bottom where the images are too big." In
     * all three references this is a compact row of small uniform tiles with a
     * caption underneath plus a dashed DROP REFERENCE — not large cards.
     */
    const rule = /\.cs-tiles\s*\{([^}]*)\}/.exec(baseCss());
    assert.ok(rule, '.cs-tiles is gone');
    const body = rule[1];
    const auto = /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\((\d+)px/.exec(body);
    assert.ok(auto, 'the reference strip is not an auto-filling row of fixed-width thumbnails: ' + body.trim());
    const w = Number(auto[1]);
    assert.ok(w <= 190,
        `the reference thumbnails are ${w}px wide; the image shows a compact strip and this is a card`);
});

test('a reference thumbnail is not as tall as a plate', () => {
    const tile = /\.cs-tile\s*\{([^}]*)\}/.exec(baseCss());
    assert.ok(tile, '.cs-tile is gone');
    const h = /(?:height|aspect-ratio):\s*([^;]+)/.exec(tile[1]);
    assert.ok(h, `.cs-tile declares no height or aspect: ${tile[1].trim()}`);
});

// ---------------------------------------------------------------------------
// View mode / edit mode — new behaviour, in neither the design nor the handoff
// ---------------------------------------------------------------------------

test('a sheet opens in VIEW mode', () => {
    assert.match(UI, /SHEET_MODE\s*=\s*'view'/,
        'sheets do not default to view mode; the reference is a read-only layout');
});

test('there is an EDIT button, at the top right with the other sheet actions', () => {
    /*
     * Not in the screenshots — it is new, and styled to match EXPORT SHEET and
     * GENERATE so it does not read as a different kind of control.
     */
    assert.match(UI, /toggleSheetMode/, 'nothing toggles the sheet between view and edit');
    /*
     * The MARKUP header, not the first mention of the class — `.cs-head` is a
     * CSS rule long before it is an element, and slicing from there checks the
     * stylesheet for a button.
     */
    for (const cls of ['cs-head', 'ss-head']) {
        const at = UI.indexOf(`class="${cls}"`);
        if (at < 0) continue;
        const head = UI.slice(at, at + 1600);
        assert.match(head, /toggleSheetMode/,
            `the ${cls} header has no edit control`);
        assert.ok(head.indexOf('toggleSheetMode') < head.indexOf('modal-close'),
            `the edit control is not among the top-right actions in ${cls}`);
    }
    // Both sheets, not just one.
    assert.strictEqual((UI.match(/onclick="toggleSheetMode\(\)"/g) || []).length, 2,
        'the edit control is on only one of the two sheet headers');
});

test('editing is off in view mode and on in edit mode, for every editable field', () => {
    /*
     * Set-based over the fields the sheet actually offers rather than a sample:
     * a mode that frees the description and leaves the appearance read-only is
     * the same defect as no mode at all.
     */
    assert.match(UI, /function sheetEditable\s*\(/,
        'there is no single rule deciding whether a field is editable');

    /*
     * Bound to `ssField`, the ONE place the subject sheets render a field.
     * Searching the whole page for "readonly" matched an unrelated attribute
     * and survived a mutation that made every field permanently editable.
     */
    const field = renderer('ssField');
    assert.match(field, /sheetEditable\s*\(\)/,
        'ssField does not consult the mode, so every field is editable in view mode');
    /*
     * PER SHAPE. Two weaker versions of this both survived a mutation that made
     * the text inputs permanently editable: checking that `readonly` appears
     * anywhere in ssField, and checking that a mode-derived lock appears
     * anywhere in it — the SELECT branch has its own `disabled` guard and kept
     * the assertion green while every textarea and input stayed open.
     */
    const roDecl = /const\s+(\w+)\s*=\s*sheetEditable\s*\(\)[^;]*\breadonly\b/.exec(field);
    assert.ok(roDecl,
        'no mode-derived readonly flag in ssField: setting one to a constant would leave '
        + 'every text field editable in view mode');
    const roVar = roDecl[1];

    // Each of the three shapes it can render must honour it.
    for (const shape of ['textarea', 'input']) {
        const at = field.indexOf(`<${shape}`);
        assert.ok(at > 0, `ssField no longer renders a ${shape}`);
        const tag = field.slice(at, field.indexOf('>', at) + 1);
        assert.ok(tag.includes('${' + roVar + '}'),
            `the ${shape} branch does not carry the readonly flag: ${tag.slice(0, 140)}`);
    }
    const selAt = field.indexOf('<select');
    assert.ok(selAt > 0, 'ssField no longer renders a select');
    const selTag = field.slice(selAt, field.indexOf('>', selAt) + 1);
    assert.match(selTag, /sheetEditable\s*\(\)[^>]*disabled/,
        `the select branch ignores the mode: ${selTag.slice(0, 140)}`);
});

test('upload and generate stay available in BOTH modes', () => {
    /*
     * Stated by the user and easy to lose. Asserted as the real invariant
     * rather than a marker string: no picture control may sit inside a
     * `sheetEditable()` branch. A constant declaring the intention would be one
     * more thing declared and consumed by nothing — the shape this codebase
     * keeps paying for.
     */
    const PICTURE_CONTROLS = ['slotUpload(', 'uploadControl(', 'ssPlateControls(',
                              'generateOfficialViews(', 'generateSheetView('];
    const gated = [];
    for (const call of PICTURE_CONTROLS) {
        let i = -1;
        while ((i = UI.indexOf(call, i + 1)) >= 0) {
            // The 400 characters before it: an editable guard wrapping the
            // control would appear here.
            const before = UI.slice(Math.max(0, i - 400), i);
            if (/sheetEditable\(\)\s*(\?|&&)/.test(before) && !/\}/.test(before.slice(before.lastIndexOf('sheetEditable')))) {
                gated.push(`${call} at ${i}`);
            }
        }
    }
    assert.deepStrictEqual(gated, [],
        'these picture controls are hidden in view mode:\n  ' + gated.join('\n  '));

    // And there must BE picture controls to speak of.
    assert.ok(PICTURE_CONTROLS.some(c => UI.includes(c)), 'the sheets render no picture controls at all');
});
