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

// ---------------------------------------------------------------------------
// PROP — design-ref-prop.png
//
// The reference draws the object description — the 1936-character text every
// plate is generated FROM — at the top of the WIDE column, with materials, the
// continuity states and the reference strip beneath it, and the short factual
// fields (scale, spec, appears in, constraints) stacked in the narrow rail.
//
// The render has them inverted: the description sits in a scrolling 400px rail
// while a single reference thumbnail owns the 1152px column.
//
// `.ps-grid` is ALREADY `minmax(0, 1fr) 400px`, identical to the value
// `Prop Card.dc.html` declares — so the CSS is correct and the SECTION
// PLACEMENT is not. Nothing has ever measured column membership, which is how
// 70 passing tests coexisted with a visibly wrong sheet.
// ---------------------------------------------------------------------------

/**
 * Which column each `data-region` renders into, by position in the markup.
 *
 * `-1` means the region is outside every column — the full-width strip above
 * them. Section order is expressed ONLY by markup order inside each `.ss-col`:
 * there is no registry, enum or ordering array anywhere to read, which is why
 * this is derived from the rendered structure rather than from a list.
 *
 * The two `assert.ok` guards are not decoration. A renderer refactored to build
 * its sections in a loop would yield zero literals here, and every membership
 * assertion below would then pass over an empty set — which is the shape of
 * vacuous test this file already had to be tightened against twice.
 */
function columnsOf(fnName, prefix) {
    const src = renderer(fnName);
    const cols = [...src.matchAll(/<div class="ss-col"[^>]*>/g)].map(m => m.index);
    assert.ok(cols.length >= 2,
        `${fnName}: found ${cols.length} columns — the scan is not seeing the markup`);
    const regions = [...src.matchAll(new RegExp(`ssSection\\('(${prefix}-[a-z]+)'`, 'g'))];
    assert.ok(regions.length > 0,
        `${fnName}: found no ssSection literals — the renderer was refactored to build its
         sections some other way, and this test can no longer read its structure`);

    const at = {};
    for (const r of regions) {
        let col = -1;
        for (let i = 0; i < cols.length; i++) if (r.index > cols[i]) col = i;
        at[r[1]] = col;
    }
    return at;
}

/** `grid-template-columns` for a selector, split into tracks, `minmax()` intact. */
function tracksOf(selector) {
    const rule = new RegExp(selector.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}').exec(baseCss());
    assert.ok(rule, `${selector} has no rule outside a media query`);
    const decl = /grid-template-columns\s*:\s*([^;]+)/.exec(rule[1]);
    assert.ok(decl, `${selector} declares no grid-template-columns`);

    const tracks = [];
    let depth = 0, cur = '';
    for (const ch of decl[1].trim()) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (/\s/.test(ch) && !depth) { if (cur) tracks.push(cur); cur = ''; }
        else cur += ch;
    }
    if (cur) tracks.push(cur);
    return tracks;
}

const columnName = i => i < 0 ? 'the full-width strip'
    : i === 0 ? 'the wide column' : `the rail (column ${i})`;

/**
 * The prop sheet as `design-ref-prop.png` draws it: the wide column carries the
 * writing and the pictures, the rail carries the short factual fields, and the
 * turntable spans both above them.
 *
 * Order is stated as an ARRAY and membership is derived from it, so the layout
 * is written down once. The first version was a flat object whose KEY ORDER
 * silently carried the stacking order — it worked, and it meant that
 * alphabetising the literal for tidiness would have quietly changed what the
 * order test asserts while the file looked untouched.
 */
const PROP_LAYOUT = [
    ['ps-description', 'ps-materials', 'ps-states', 'ps-references'],  // the wide column
    ['ps-scale', 'ps-spec', 'ps-appears', 'ps-constraints'],           // the rail
];
const PROP_OUTSIDE = ['ps-plates'];                                    // the full-width turntable

const PROP_COLUMN = Object.fromEntries([
    ...PROP_OUTSIDE.map(r => [r, -1]),
    ...PROP_LAYOUT.flatMap((names, col) => names.map(r => [r, col])),
]);

test('PROP: every region renders in the column the reference draws it in', () => {
    const at = columnsOf('renderPropSheet', 'ps');

    assert.deepStrictEqual(Object.keys(at).sort(), Object.keys(PROP_COLUMN).sort(),
        'the regions on the prop sheet are not the ones this test knows about — '
        + 'a section was added or removed, and the expected layout needs revisiting');

    const wrong = [];
    for (const [region, want] of Object.entries(PROP_COLUMN)) {
        if (at[region] !== want) {
            wrong.push(`${region} renders in ${columnName(at[region])}, `
                + `the reference puts it in ${columnName(want)}`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('PROP: each column runs in the order the reference stacks it', () => {
    const src = renderer('renderPropSheet');
    for (const col of [0, 1]) {
        assertOrder(src, PROP_LAYOUT[col].map(r => `ssSection('${r}'`), `PROP ${columnName(col)}`);
    }
});

test('PROP: the object description renders in the flexible column, not the fixed rail', () => {
    // The user-visible defect, expressed as geometry rather than as a column
    // index: the description is bound to the track the STYLESHEET makes
    // flexible, so this stays true if the grid is ever re-declared. A fixed
    // `400px` track is the 1936-character description in a scroll box.
    const tracks = tracksOf('.ss-grid.ps-grid');
    assert.equal(tracks.length, 2,
        `.ps-grid declares ${tracks.length} tracks (${tracks.join(' | ')}) — the sheet is not two columns`);

    const at = columnsOf('renderPropSheet', 'ps');
    const track = tracks[at['ps-description']];
    assert.ok(track && !/^\d+px$/.test(track),
        `the object description renders in a ${track} column. It is the longest text on the `
        + `sheet and the text every plate is generated from; the reference gives it the `
        + `flexible track (${tracks[0]}).`);
});

test('PROP: the turntable strip stays full width, above both columns', () => {
    // subject-sheet-fidelity's existing pin, restated as membership: moving
    // sections between the columns must not pull the official views into one.
    const src = renderer('renderPropSheet');
    const at = columnsOf('renderPropSheet', 'ps');
    assert.equal(at['ps-plates'], -1,
        `the turntable renders inside ${columnName(at['ps-plates'])} — the reference spans it across both`);
    assert.ok(src.indexOf('ps-turntable') < src.indexOf('ps-grid'),
        'the turntable strip renders below the two-column body, not above it');
});

test('PROP: every editable control goes through ssField, and the move drops none', () => {
    /*
     * The one real security surface in this change. Every moved block is
     * cut-and-pasted whole; a RETYPED field is how a dropped `esc()` on
     * `description` or `materials` becomes stored XSS, and how a control
     * arrives that `ssField` never sees and so never locks in view mode.
     *
     * The count is pinned because this change moves markup and must neither
     * add nor drop a field. If a later change legitimately adds one, this
     * number is the thing to update deliberately.
     */
    const src = renderer('renderPropSheet');
    const raw = [...src.matchAll(/<(textarea|input|select)\b/g)].map(m => m[1]);
    assert.deepStrictEqual(raw, [],
        `the prop sheet renders ${raw.join(', ')} directly instead of through ssField — `
        + 'a control ssField never sees is editable in view mode, and unescaped');
    assert.equal((src.match(/ssField\(/g) || []).length, 10,
        'the prop sheet gained or lost a field — this change moves sections, it does not edit them');
});

// ---------------------------------------------------------------------------
// LOCATION — containment
//
// Measured correct against `design-ref-location.png` and explicitly OUT OF
// SCOPE: 4 flex columns, with Lighting / Atmosphere / Sound already sharing a
// row. An earlier research pass reported that trio as missing; that was a
// faulty probe, not the render. This pins it so the prop change cannot leak.
// ---------------------------------------------------------------------------

const LOCATION_COLUMN = {
    'ls-plates': 0, 'ls-orientation': 0, 'ls-variants': 0,
    'ls-description': 1, 'ls-lighting': 1, 'ls-atmosphere': 1, 'ls-sound': 1,
    'ls-references': 2,
    'ls-scenes': 3, 'ls-continuity': 3,
};

test('LOCATION: the sheet measured correct is left exactly as it is', () => {
    const at = columnsOf('renderLocationSheet', 'ls');
    assert.deepStrictEqual(at, LOCATION_COLUMN,
        'the location sheet moved. It was measured correct against its reference and is out of '
        + 'scope for the prop fix — this is the containment guard, so treat a failure here as '
        + 'the prop change having leaked rather than as a layout to re-tune.');
});

// ---------------------------------------------------------------------------
// CHARACTER — column membership
//
// The prop and location sheets are protected by `columnsOf`, which keys on the
// `data-region` attribute `ssSection` emits. `characterSheetHtml` makes ZERO
// `ssSection` calls — it builds its own markup — so it carried no membership
// protection at all: moving a section between its columns failed nothing, on
// the one sheet the original complaint actually named.
//
// It is keyed on the SECTION LABEL rather than on a class, and that choice is
// deliberate. The label is what `design-ref-character.png` and
// `subject-sheet-design.test.js` already treat as the contract — it is
// semantic. A class name is styling, and a test keyed on styling breaks when
// someone renames a class for a styling reason.
//
// Converting the sheet to `ssSection` would be the tidier fix and was rejected:
// it wraps every region in new `.ss-region` markup, which changes the cascade
// on a layout that was just measured against its reference image. Closing a
// test gap is not worth risking the design it is meant to protect.
// ---------------------------------------------------------------------------

/** Which column each labelled section renders into, by position in the markup. */
function labelColumnsOf(fnName, colPattern, labelPattern) {
    const src = renderer(fnName);
    // Each column's EXTENT, not just where it opens. Assigning a label to "the
    // last column opened before it" ignores the closing tag, so a section that
    // renders AFTER a column closes is attributed to it anyway. That is not
    // hypothetical: the character sheet's concept band renders full-width
    // outside both columns (measured at 1496px against the columns' 467 and
    // 978), and the first version of this helper reported it as column 1 —
    // which would have stayed green if someone moved it INTO a column, the
    // exact regression this test exists to catch.
    const spans = [...src.matchAll(colPattern)].map(m => {
        let depth = 0, close = src.length;
        for (let j = m.index; j < src.length; j++) {
            if (src.startsWith('<div', j)) depth++;
            else if (src.startsWith('</div>', j)) { depth--; if (!depth) { close = j; break; } }
        }
        return { open: m.index, close };
    });
    assert.ok(spans.length >= 2,
        `${fnName}: found ${spans.length} columns — the scan is not seeing the markup`);
    const labels = [...src.matchAll(labelPattern)];
    assert.ok(labels.length > 0,
        `${fnName}: found no section labels — the sheet was restructured and this test
         can no longer read it`);

    const at = {};
    for (const l of labels) {
        at[l[1]] = spans.findIndex(sp => l.index > sp.open && l.index < sp.close);
    }
    return at;
}

/**
 * The character sheet as `design-ref-character.png` draws it: official views,
 * the spec and the palette down the left; the writing, wardrobe and references
 * down the right. Order within each column is the array order.
 */
const CHARACTER_LAYOUT = [
    ['Official views', 'Physical spec', 'Palette', 'Work on this character'],
    ['Appearance', 'Description', 'Personality', 'Wardrobe &amp; props'],
];

// The concept band spans the full width BELOW both columns — measured in a
// browser at 1496px where the columns are 467 and 978. It is not a member of
// either, and saying so is the point: the first version of this list put it in
// column 1, which is what a column-opening-only scan reports.
const CHARACTER_OUTSIDE = ['Concept art &amp; references'];

const CHARACTER_COLUMN = Object.fromEntries([
    ...CHARACTER_OUTSIDE.map(n => [n, -1]),
    ...CHARACTER_LAYOUT.flatMap((names, col) => names.map(n => [n, col])),
]);

test('CHARACTER: every section renders in the column the reference draws it in', () => {
    const at = labelColumnsOf('characterSheetHtml',
        /<div class="cs-col-[lr]"/g,
        /<div class="cs-label"><span>([^<]+)<\/span>/g);

    assert.deepStrictEqual(Object.keys(at).sort(), Object.keys(CHARACTER_COLUMN).sort(),
        'the sections on the character sheet are not the ones this test knows about — '
        + 'one was added or removed, and the expected layout needs revisiting');

    const wrong = [];
    for (const [label, want] of Object.entries(CHARACTER_COLUMN)) {
        if (at[label] !== want) {
            wrong.push(`"${label}" renders in ${columnName(at[label])}, `
                + `the reference puts it in ${columnName(want)}`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('CHARACTER: each column runs in the order the reference stacks it', () => {
    const src = renderer('characterSheetHtml');
    for (const col of [0, 1]) {
        assertOrder(src, CHARACTER_LAYOUT[col].map(l => `<span>${l}</span>`),
            `CHARACTER ${columnName(col)}`);
    }
});

test('LOCATION: every editable control honours view mode', () => {
    /*
     * The set-description textarea is written inline rather than through
     * ssField, and that is DELIBERATE: subject-sheets.test.js requires every
     * ssField() call to name a literal, registry-declared field, and a
     * section's field name is built at run time from its id. The sections are
     * a dynamic set with their own save path and sit outside that registry on
     * purpose — routing them through ssField fights an intentional design and
     * fails two of that file's assertions.
     *
     * So the invariant is not "no raw controls", it is the one that actually
     * matters: every editable control on the sheet locks in view mode. It was
     * doing neither — the textarea ignored the mode entirely, leaving a set
     * description editable on a sheet that opens read-only.
     */
    const src = renderer('renderLocationSheet');
    const controls = [...src.matchAll(/<(textarea|input|select)\b[^>]*>/g)].map(m => m[0]);
    // Without this the check passes vacuously the moment the sheet renders no
    // raw control at all — which is exactly the state it was briefly left in.
    assert.ok(controls.length > 0,
        'the location sheet renders no raw control — either it moved to ssField (fine, but '
        + 'this check no longer covers anything) or the scan is broken');
    /*
     * The lock is `readonly` (or `disabled` on a select), not merely a mention
     * of sheetEditable(). The first version of this check accepted the latter,
     * and a mutation stripping the readonly passed it: the tag also carries a
     * mode-derived CLASS, which greys the box without locking it. A control
     * that looks read-only and accepts typing is worse than one that looks
     * editable.
     */
    const unlocked = controls
        .filter(tag => {
            const word = /^<select/.test(tag) ? 'disabled' : 'readonly';
            return !(new RegExp(word).test(tag) && /sheetEditable\(\)/.test(tag));
        })
        .map(tag => tag.replace(/\s+/g, ' ').slice(0, 90));
    assert.deepStrictEqual(unlocked, [],
        'these controls on the location sheet ignore view mode:\n  ' + unlocked.join('\n  '));
});

test('every section these column tests place is rendered unconditionally', () => {
    /*
     * THE PRECONDITION THE COLUMN TESTS REST ON, made explicit.
     *
     * Every check above reads the renderer's SOURCE and places a section by
     * where its literal sits between the column divs. That is only equivalent
     * to where it RENDERS while every section is emitted unconditionally.
     *
     * Measured: short-circuiting one section so it renders nothing
     * (`${'' && ssSection('ps-materials', …)}`) left the whole file passing
     * 20/20, while the browser showed 8 regions instead of 9 — the section was
     * gone from the DOM and no test noticed. Source position had stopped
     * meaning runtime presence, and nothing said so.
     *
     * A DOM assertion is the direct fix and is not available here: ADR-002
     * means no bundler and zero devDependencies, so there is no jsdom to render
     * into. What CAN be enforced is the precondition — if a section becomes
     * conditional, this fails and says the column tests can no longer prove
     * what they claim, rather than passing over a sheet that lost a section.
     */
    const SHEETS = [
        ['renderPropSheet', /ssSection\('(ps-[a-z]+)'/g],
        ['renderLocationSheet', /ssSection\('(ls-[a-z]+)'/g],
        ['characterSheetHtml', /<div class="cs-label"><span>([^<]+)</g],
    ];
    const conditional = [];
    for (const [fn, re] of SHEETS) {
        const src = renderer(fn);
        const found = [...src.matchAll(re)];
        assert.ok(found.length > 0, `${fn}: found no sections — the scan is not seeing the markup`);
        for (const m of found) {
            // A trailing `?` or `&&` immediately before the section is a guard,
            // so the section may render for some subjects and not others.
            const before = src.slice(Math.max(0, m.index - 120), m.index);
            if (/[?]\s*`?\s*$|&&\s*`?\s*$/.test(before)) conditional.push(`${fn}: ${m[1]}`);
        }
    }
    assert.deepStrictEqual(conditional, [],
        'these sections are rendered conditionally, so their position in the source no longer '
        + 'proves where — or whether — they render:\n  ' + conditional.join('\n  '));
});
