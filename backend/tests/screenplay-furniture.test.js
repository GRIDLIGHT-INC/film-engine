/**
 * The editor's own furniture is not content, and must not be adopted or swept.
 *
 * `updateEditorStats()` runs at the TOP of onEditorInput and inserts the page
 * break indicators. The orphan-adoption loop then walks the editor's children
 * and sees each indicator as an untyped element — because that is exactly what
 * it is: a <div> with a class, no data-element-type and no text.
 *
 * Measured in a real browser on The Glass Harbour: 5 indicators, and the loop
 * treats all 5 as orphans on EVERY keystroke.
 *
 *   before this fix   each indicator became an empty `action` block — 32px of
 *                     nothing, five per keystroke, and they were then counted
 *                     as lines, which inflated the page estimate (6 -> 9 -> 15),
 *                     which inserted MORE indicators, which became more empty
 *                     blocks. That is the "huge space" and why it grew.
 *
 *   after the empty-  the loop deleted them instead, which stopped the growth
 *   block fix         and silently removed the pagination display.
 *
 * Neither is right. Furniture must be INVISIBLE to both passes.
 *
 * Set-based over every class the page inserts as a non-block child of the
 * editor, derived from the source, so a second piece of furniture added later
 * cannot quietly start being eaten.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
const blocks = require('../lib/screenplay-blocks');

/* ── the denominator, derived from the page ──────────────────────────── */

/**
 * Classes the SPA creates as bare <div>s and inserts among the editor's
 * children — i.e. things the orphan loop will meet that are not blocks.
 */
function furnitureInSource() {
    const found = new Set();
    // createElement(...) ... className = 'x' ... .after( | insertBefore | appendChild
    const re = /createElement\('div'\);?([\s\S]{0,400}?)(\w[\w.\[\]]*)\.(?:after|insertBefore|appendChild)\(/g;
    let m;
    while ((m = re.exec(SPA))) {
        const seg = m[1];
        const target = m[2];
        if (/dataset\.elementType\s*=/.test(seg)) continue;      // that is a block
        // Only insertions among the EDITOR's own children count. Without this
        // the scan swept up the sidebar and reported `nav-group` as furniture.
        if (!/^(editor|blocks\[[^\]]*\]|block)$/.test(target)) continue;
        const cls = seg.match(/className\s*=\s*'([a-z0-9-]+)'/i);
        if (cls) found.add(cls[1]);
    }
    return [...found];
}

test('the editor really does insert non-block furniture', () => {
    const found = furnitureInSource();
    assert.ok(found.includes('page-break-indicator'),
        `the page-break indicator was not detected as furniture; found ${found.join(', ') || 'nothing'}`);
});

test('every piece of furniture the page inserts is declared', () => {
    for (const cls of furnitureInSource()) {
        assert.ok(blocks.FURNITURE_CLASSES.includes(cls),
            `"${cls}" is inserted among the editor's children and is not declared furniture — `
            + 'the orphan loop will adopt or delete it');
    }
});

test('the rule never reports furniture as droppable, whatever its type', () => {
    for (const cls of blocks.FURNITURE_CLASSES) {
        assert.strictEqual(blocks.isFurniture({ className: cls }), true);
        // furniture has no text and no element type — the exact shape that
        // makes it look like an empty block
        const doc = [
            { type: 'dialogue', text: 'I know what I did.' },
            { className: cls, text: '' },
            { type: 'character', text: 'RAY' },
        ];
        assert.deepStrictEqual(blocks.droppableEmpties(doc), [],
            `furniture "${cls}" was reported as a droppable empty block`);
    }
});

test('a real empty block is still droppable beside furniture', () => {
    const doc = [
        { type: 'dialogue', text: 'x' },
        { className: 'page-break-indicator', text: '' },
        { type: 'action', text: '' },
    ];
    assert.deepStrictEqual(blocks.droppableEmpties(doc), [2],
        'the furniture exemption swallowed the empty block it sits next to');
});

test('isFurniture is not fooled by a block that merely has classes', () => {
    assert.strictEqual(blocks.isFurniture({ className: 'sp-action', type: 'action' }), false);
    assert.strictEqual(blocks.isFurniture({}), false);
    assert.strictEqual(blocks.isFurniture(null), false);
});

/* ── the page must skip it in BOTH passes ────────────────────────────── */

function bodyOf(fnName) {
    const i = SPA.indexOf(`function ${fnName}(`);
    assert.ok(i > 0, `${fnName} not found`);
    let depth = 0, j = SPA.indexOf('{', i), end = j;
    for (; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    return SPA.slice(i, end);
}

test('the orphan-adoption loop skips furniture before it decides anything', () => {
    const body = bodyOf('onEditorInput');
    assert.match(body, /SP_FURNITURE|Furniture\s*\(|page-break-indicator/,
        'onEditorInput does not recognise the editor\'s own furniture — it will adopt it '
        + 'into an empty block or delete it, and both destroy the pagination');
});

test('the sweep skips furniture too', () => {
    const body = bodyOf('sweepEmptyBlocks');
    assert.match(body, /SP_FURNITURE|Furniture\s*\(|page-break-indicator/,
        'the sweep does not recognise furniture');
});

test('the page and the rule declare the same furniture — held in lockstep', () => {
    const i = SPA.indexOf('const SP_FURNITURE');
    assert.ok(i > 0, 'the page does not declare its furniture list where it can be compared');
    const line = SPA.slice(i, SPA.indexOf(';', i));
    const pageList = [...line.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(pageList, blocks.FURNITURE_CLASSES,
        'the two furniture lists have drifted');
});

/* ── and the thing this protects ─────────────────────────────────────── */

test('the indicators are inserted before the loop that must ignore them', () => {
    // The ordering is the trap: updateEditorStats() paginates at the TOP of
    // onEditorInput, so by the time the orphan loop runs the furniture is
    // already there. Reordering would "fix" it by accident and break again the
    // next time something inserts during input.
    const body = bodyOf('onEditorInput');
    const stats = body.indexOf('updateEditorStats(');
    const loop = body.indexOf('for (const node of childNodes)');
    assert.ok(stats >= 0 && loop > stats,
        'the pagination no longer runs before the orphan loop — if that is deliberate, this '
        + 'test should be updated to say so, because the skip is what makes the order safe');
});
