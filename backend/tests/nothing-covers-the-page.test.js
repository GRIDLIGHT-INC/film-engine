/**
 * AT PHONE WIDTH, WITH NOTHING OPEN, NOTHING MAY COVER THE PAGE.
 *
 * `.fe-scrim` — the drawer's backdrop — was declared `display:block` for every
 * viewport under 700px, gated on nothing. The panel beside it IS gated
 * (`body.fe-drawer .fe-panel`), so the drawer slid away correctly and its
 * backdrop stayed: a 390x844 layer at z-index 350, opacity 1,
 * `pointer-events: auto`, sitting over `.main` AND over the burger that opens
 * the drawer.
 *
 * Every touch landed on it. Measured in a real browser at 390px:
 * `document.elementFromPoint()` at the burger's own centre returned
 * `fe-scrim`, and clicking the burger left the panel's transform unchanged.
 *
 * IT IS INVISIBLE AS A BUG because the app is dark themed — 55% black over a
 * dark UI reads as "dark", not as "there is a sheet of glass over everything".
 * So the report was "I can't tap anything", which sends you to JavaScript.
 *
 * mobile-shell.test.js passed throughout. It asks what specific properties
 * compute to on specific selectors; it never asks whether something is ON TOP.
 * That is the same blindness the modal-stacking bug had, where every test
 * checked the dialog's markup and none could see it painted underneath.
 *
 * SET-BASED over every full-viewport overlay the phone breakpoint declares,
 * because the next one added will have the same failure mode and nobody will
 * be looking for it.
 */

const test = require('node:test');
const assert = require('node:assert');

const { RULES, declared } = require('./css-cascade');

const PHONE = 390;
const DESKTOP = 1440;

/**
 * Every rule that paints over the whole viewport: fixed, and pinned to all
 * four edges either by `inset` or by the four sides.
 */
function fullScreenOverlays() {
    const out = [];
    for (const r of RULES) {
        const has = (p) => r.decls.find(d => d.prop === p);
        const fixed = has('position') && /fixed/.test(has('position').value);
        if (!fixed) continue;
        const inset = has('inset');
        const sides = ['top', 'right', 'bottom', 'left'].every(s => has(s));
        const coversAll = (inset && /^0/.test(inset.value.trim())) || sides;
        if (!coversAll) continue;
        for (const sel of r.selectors) out.push({ sel, media: r.media });
    }
    return out;
}

test('the scan finds the overlays it is meant to police', () => {
    const found = fullScreenOverlays();
    assert.ok(found.length >= 1,
        'no full-viewport overlay found at all — the scan is broken, and one that finds nothing '
        + 'reports every gap as closed');
    assert.ok(found.some(o => /fe-scrim/.test(o.sel)),
        'the drawer scrim is not in the denominator, which is the rule this exists for');
});

/**
 * A selector is STATE-GATED when it only applies while the page is in a named
 * state — a class on body. `.fe-scrim` applies always; `body.fe-drawer
 * .fe-scrim` applies only with the drawer open.
 */
/**
 * Selectors that are pinned to all four edges and are NOT something laid over
 * the page. Named with a reason, never matched by pattern: an exemption that
 * matched on shape would quietly excuse the next real overlay.
 */
const NOT_AN_OVERLAY = Object.freeze({
    '.main': 'the page content itself — it is fixed and inset so the shell can position it by '
        + 'variables, and it is what everything else is on top OF',
});

const stateGated = (sel) => /^(body|html)\s*\.[\w-]+\s+/.test(sel.trim());

test('EVERY full-viewport overlay is gated on a state, or is hidden by default', () => {
    /*
     * Both halves are allowed. A scrim may be declared ungated as long as its
     * DEFAULT is hidden and only a state shows it — which is what `.fe-scrim {
     * display:none }` plus `body.fe-drawer .fe-scrim { display:block }` does.
     * What is not allowed is an overlay that is displayed with nothing open.
     */
    const bad = [];
    for (const { sel } of fullScreenOverlays()) {
        if (stateGated(sel)) continue;
        if (NOT_AN_OVERLAY[sel]) continue;
        const shown = declared(sel, 'display', PHONE);
        const inert = declared(sel, 'pointer-events', PHONE);
        /*
         * THREE ways to be inert, not two. `visibility: hidden` removes an
         * element from hit testing exactly as `display: none` does — the
         * shortcut overlay uses it so it can transition in — and a predicate
         * that knew only the first two reported a correct overlay as a defect.
         */
        const hidden = declared(sel, 'visibility', PHONE);
        if (shown !== 'none' && inert !== 'none' && hidden !== 'hidden') {
            bad.push(`${sel} computes display:${shown} pointer-events:${inert} `
                + `visibility:${hidden} at ${PHONE}px with nothing open`);
        }
    }
    assert.deepStrictEqual(bad, [],
        'these cover the whole page and swallow every tap when nothing is open:\n  ' + bad.join('\n  '));
});

test('the scrim appears ONLY with the drawer open, and covers when it does', () => {
    /*
     * The other direction, and it matters: a scrim that never shows leaves the
     * open drawer with no way to dismiss it by tapping away, and no dimming to
     * say the page behind is inert.
     */
    assert.strictEqual(declared('.fe-scrim', 'display', PHONE), 'none',
        'the scrim is displayed with the drawer closed — it swallows every tap on the page');
    const open = declared('body.fe-drawer .fe-scrim', 'display', PHONE);
    assert.strictEqual(open, 'block',
        'nothing shows the scrim when the drawer IS open, so there is no backdrop to tap away on');
});

test('the drawer and its backdrop are gated by the SAME state', () => {
    /*
     * They were not, and that is the whole defect: the panel moved on
     * `body.fe-drawer` and the backdrop did not, so the two disagreed about
     * whether the drawer was open.
     */
    const panelOpen = declared('body.fe-drawer .fe-panel', 'transform', PHONE);
    assert.ok(panelOpen && /translateX\(0\)/.test(panelOpen),
        'the panel is no longer opened by body.fe-drawer; re-derive this test');
    assert.strictEqual(declared('body.fe-drawer .fe-scrim', 'display', PHONE), 'block',
        'the backdrop is gated on a different state from the panel it belongs to');
});

test('none of this reaches the desktop layout', () => {
    // The scrim and burger are phone furniture. On a laptop they must be inert
    // rather than merely invisible — a fixed overlay at z-index 350 over a
    // desktop page is the same bug on a bigger screen.
    assert.strictEqual(declared('.fe-scrim', 'display', DESKTOP), 'none',
        'the scrim is displayed on desktop');
    assert.strictEqual(declared('.fe-burger', 'display', DESKTOP), 'none',
        'the phone burger is shown on desktop');
});

test('every exemption names a selector that still exists', () => {
    // A stale exemption makes the list a lie: it reads as a considered
    // decision about something that is no longer there.
    const all = new Set(fullScreenOverlays().map(o => o.sel));
    for (const [sel, why] of Object.entries(NOT_AN_OVERLAY)) {
        assert.ok(all.has(sel), `${sel} is exempted and no longer matches the scan`);
        assert.ok(why.length > 30, `${sel}: the exemption states no real reason`);
    }
});
