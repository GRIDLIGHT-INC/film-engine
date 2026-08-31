/**
 * A grid child that is not a card takes a card's place
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Reported as "why is there space now on the left of the top panel in the
 * storyboard screen": the first row of frames started in column TWO while the
 * next row started in column one.
 *
 * `.entity-grid` is a real CSS grid, so EVERY direct child occupies a cell —
 * including an empty one. loadStoryboard wrote
 *
 *     grid.innerHTML = '<div id="boardBanners"></div>' + frames.map(...)
 *
 * and `#boardBanners` is empty until the drift and impact reports land a second
 * later. Empty or not it is a grid item, so it took the first cell and pushed
 * 1A, 1B and 1C one column to the right. Nothing was broken and nothing was
 * logged; the board simply had a hole in it.
 *
 * The page already knows the rule — both `banner` literals carry
 * `grid-column:1/-1`, and every empty-state does too. This one did not, which
 * is why the convention is worth asserting rather than remembering.
 *
 * Set-based over every entity-grid and every write into it, because the failure
 * is per-write: the storyboard's empty-state spans correctly while the banner
 * beside it does not, so a test written against one passes in exactly the state
 * being reported.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const UI = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** Derived: every container the page styles as a grid. */
function gridContainers() {
    return [...new Set([...UI.matchAll(/id="([a-zA-Z0-9_]+)"[^>]*class="[^"]*entity-grid/g)]
        .map(m => m[1]))];
}

function enclosingFn(idx) {
    const m = [...UI.slice(0, idx).matchAll(/(?:async\s+)?function ([A-Za-z_$][\w$]*)\s*\(/g)].pop();
    return m ? m[1] : null;
}

/** Brace-bounded, so a one-line function does not swallow the next one. */
function fnBody(name) {
    const i = UI.indexOf(`function ${name}(`);
    if (i < 0) return '';
    let j = UI.indexOf('{', i), d = 0, e = -1;
    for (let k = j; k < UI.length; k++) {
        if (UI[k] === '{') d++;
        else if (UI[k] === '}') { d--; if (!d) { e = k + 1; break; } }
    }
    return UI.slice(i, e < 0 ? i + 20000 : e);
}

/**
 * Every top-level element a write can emit into a grid.
 *
 * Both the LEAD element and any empty-list fallback — `…join('') || '<div…>'`
 * and `list.length ? … : '<div…>'` are the two idioms this page uses, and the
 * fallback is a direct grid child exactly as the lead is.
 */
function emittedTopLevel(tail) {
    /*
     * DEPTH-AWARE, because the alternative over-reports wildly.
     *
     * A card template is full of ternaries — `${x ? `<p …>` : ''}` — and a
     * regex for "a tag after a ? or :" matches every one of them, reporting
     * elements nested three levels inside a card as direct grid children. Three
     * such false positives appeared the moment the scan window was widened.
     *
     * A real top-level element is one written at bracket depth zero: the lead
     * of the expression, or the `|| '<div…>'` empty fallback at the end of it.
     */
    const out = [];
    let depth = 0, inTpl = false, i = 0;
    const atDepthZero = [];
    for (; i < tail.length; i++) {
        const ch = tail[i];
        if (ch === '`') { inTpl = !inTpl; continue; }
        if (inTpl) {
            // ${ … } re-enters expression context; treat it as nesting
            if (ch === '{' && tail[i - 1] === '$') depth++;
            continue;
        }
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if ((ch === "'" || ch === '"') && depth === 0) atDepthZero.push(i);
    }
    for (const q of atDepthZero) {
        const lit = tail.slice(q, q + 400);
        const tag = lit.match(/^['"]\s*(<(?:div|p|span|section)[^>]*>)/);
        if (tag) out.push(tag[1]);
    }
    // and the lead, when the write opens with a template literal
    const lead = tail.match(/^\s*[`'"]\s*(<(?:div|p|span|section)[^>]*>)/);
    if (lead && !out.includes(lead[1])) out.unshift(lead[1]);
    return out;
}

function writesIntoGrids() {
    const found = [];
    for (const id of gridContainers()) {
        for (const m of UI.matchAll(new RegExp(`document\\.getElementById\\('${id}'\\)`, 'g'))) {
            const fn = enclosingFn(m.index);
            if (!fn) continue;
            const body = fnBody(fn);
            const vm = body.match(
                new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*document\\.getElementById\\('${id}'\\)`));
            const targets = [];
            if (vm) targets.push(vm[1]);
            if (body.includes(`getElementById('${id}').innerHTML`)) {
                targets.push(`document.getElementById('${id}')`);
            }
            for (const t of targets) {
                const re = new RegExp(`${t.replace(/[.()']/g, c => '\\' + c)}\\.innerHTML\\s*=\\s*`, 'g');
                for (const a of body.matchAll(re)) {
                    /*
                     * Bounded by the STATEMENT, not by a fixed window.
                     *
                     * A 400-character slice stops inside the card template and
                     * never reaches the `|| '<div…>'` empty fallback at the end
                     * of the expression — so a second real offender read as
                     * absent. Fixed-window slices have cost this codebase twice
                     * already; the end of the statement is the honest boundary.
                     */
                    let at = a.index + a[0].length;
                    let depth = 0, end = body.length;
                    for (let k = at; k < body.length; k++) {
                        const ch = body[k];
                        if ('([{`'.includes(ch)) depth++;
                        else if (')]}`'.includes(ch)) depth--;
                        else if (ch === ';' && depth <= 0) { end = k; break; }
                    }
                    found.push({ id, fn, tail: body.slice(at, end).replace(/\s+/g, ' ') });
                }
            }
        }
    }
    // de-duplicate: the same write is reachable from several getElementById hits
    const seen = new Set();
    return found.filter(f => {
        const k = `${f.id}|${f.fn}|${f.tail}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

const ITEM = /class="[^"]*(?:\bcard\b|entity-card|empty-state|home-panel)/;
const SPANS = /grid-column\s*:\s*1\s*\/\s*-1/;

test('the scan sees the grids and the writes into them', () => {
    const grids = gridContainers();
    assert.ok(grids.includes('storyboardGrid'),
        `the scan no longer sees storyboardGrid — it found ${grids.join(', ')}`);
    assert.ok(grids.length >= 4, `only ${grids.length} grid containers found; the scan is broken`);
    assert.ok(writesIntoGrids().length >= 3, 'the scan found no writes into the grids');
});

test('every element written into a grid is a card, or spans the whole row', () => {
    const offenders = [];
    for (const w of writesIntoGrids()) {
        for (const el of emittedTopLevel(w.tail)) {
            if (ITEM.test(el) || SPANS.test(el)) continue;
            offenders.push(`${w.id} (${w.fn}): ${el.slice(0, 70)}`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'these are direct children of a CSS grid and are neither a grid item nor full-width, so '
        + 'each takes a cell a frame should occupy and pushes the row across:\n  '
        + offenders.join('\n  '));
});

test('the board banner is not a grid child at all', () => {
    /*
     * Spanning the row would fix the reported hole and leave a second one: an
     * empty full-width child still opens a grid row and the 12px gap after it.
     * The banner is about the whole board rather than any frame, so it belongs
     * OUTSIDE the grid — which also stops a background repaint of the grid
     * destroying banners that arrive a second later, asynchronously, by design.
     */
    const at = UI.indexOf('async function loadStoryboard(');
    assert.ok(at > -1, 'loadStoryboard is gone');
    let j = UI.indexOf('{', at), d = 0, e = -1;
    for (let k = j; k < UI.length; k++) {
        if (UI[k] === '{') d++;
        else if (UI[k] === '}') { d--; if (!d) { e = k + 1; break; } }
    }
    const body = UI.slice(at, e);

    assert.ok(!/grid\.innerHTML\s*=\s*'<div id="boardBanners">/.test(body),
        'loadStoryboard still writes #boardBanners as the first child of the grid, so it takes '
        + 'the first cell and the top row of frames starts one column across');
    assert.match(UI, /id="boardBanners"[^>]*>\s*<\/div>/,
        '#boardBanners must exist in the static markup, outside the grid, or the async drift and '
        + 'impact banners have nowhere to land');
});
