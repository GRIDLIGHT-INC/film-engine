/**
 * A button drawn outside its own card.
 *
 * Reported as "the delete button leaks out of the character cards". The cause
 * was one line: `.entity-card .card-actions` was `display:flex` with no
 * `flex-wrap`, and `.entity-card` is `overflow: visible`. Four buttons
 * (Regen Image | Upload | Edit | Delete) measure 233px inside a 222px row, so
 * the last one is simply painted 11px past the card's own border.
 *
 * Measured in the real page before the fix: characters 1 overflowing row,
 * locations 1, props 4 — every one of them the same row, every one over by
 * 11px. Characters looked like the reported case only because its three-button
 * row fits with 6px to spare and it was the page being looked at.
 *
 * WHY THIS IS A SOURCE TEST AND NOT A LAYOUT TEST.
 * There is no layout engine here: the SPA is one HTML file with no bundler
 * (`build.target: single-html`), and jsdom computes no box geometry, so
 * `scrollWidth` is 0 for everything. The measurement was done in a real
 * browser and is quoted above; what a test can hold permanently is the two
 * invariants that measurement rests on — the row wraps, and there is only ONE
 * row rule for every card to share. The second is what stops the next page
 * from writing its own nowrap literal, which is exactly how the continuity
 * card acquired the same defect a screen away from the one being fixed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

/** The declaration block of a CSS rule, by exact selector. */
function ruleFor(selector) {
    const at = HTML.indexOf(selector + ' {');
    if (at === -1) return null;
    return HTML.slice(at, HTML.indexOf('}', at));
}

/**
 * Every flex row rendered INSIDE a card template, found by walking each
 * `<div class="entity-card"` occurrence rather than by listing the pages.
 * A card added next month is in the denominator with nothing to remember.
 */
function cardRows() {
    const rows = [];
    const re = /<div class="entity-card"/g;
    let m;
    while ((m = re.exec(HTML))) {
        const line = HTML.slice(0, m.index).split('\n').length;
        // Bounded slice: a card template is far shorter than this, and an
        // unbounded walk would run into the next card's markup.
        const seg = HTML.slice(m.index, m.index + 2600);
        for (const s of seg.matchAll(/style="([^"]*display:\s*flex[^"]*)"/g)) {
            rows.push({ line, kind: 'inline', css: s[1] });
        }
        for (const c of seg.matchAll(/class="([^"]*\b(?:card-actions|flex-between)\b[^"]*)"/g)) {
            rows.push({ line, kind: 'class', css: c[1] });
        }
    }
    return rows;
}

test('the card button row wraps', () => {
    const rule = ruleFor('.entity-card .card-actions');
    assert.ok(rule, '.entity-card .card-actions rule is missing entirely');
    assert.match(rule, /flex-wrap:\s*wrap/,
        'the row does not wrap, so a button past the card width is drawn outside the card');
});

test('the card and its row can shrink below their content', () => {
    // A flex item and a grid item both default to `min-width: auto`, i.e.
    // min-content — so an unbreakable button row makes the CARD wider than its
    // grid track, and wrapping alone would not save it.
    for (const sel of ['.entity-card', '.entity-card .card-actions']) {
        assert.match(ruleFor(sel) || '', /min-width:\s*0/,
            `${sel} defaults to min-content width and will refuse to shrink`);
    }
});

test('every flex row inside a card wraps', () => {
    const bad = cardRows().filter(r => {
        if (r.kind === 'class') {
            // Named rows are governed by a rule; check the rule, not the tag.
            const cls = /card-actions/.test(r.css) ? '.entity-card .card-actions'
                : '.entity-card .flex-between';
            return !/flex-wrap:\s*wrap/.test(ruleFor(cls) || '');
        }
        return !/flex-wrap:\s*wrap/.test(r.css);
    });
    assert.deepStrictEqual(bad, [],
        'these rows inside a card cannot wrap, so their last child is painted outside the card');
});

test('the card button row is declared once, not per page', () => {
    // Three pages render this row (characters, locations, props) and every one
    // of them reaches for the same class. The moment a page writes its own
    // inline row instead, it opts out of the wrap and the bug comes back on
    // that page only — which is how it looked like a Characters problem.
    const uses = HTML.match(/class="card-actions"/g) || [];
    assert.ok(uses.length >= 3,
        `expected the shared row class on every entity page, found ${uses.length}`);

    const literals = HTML.match(/\.entity-card \.card-actions\s*\{/g) || [];
    assert.strictEqual(literals.length, 1,
        'two rules for one row is how the pages come to disagree about wrapping');
});
