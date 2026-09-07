/**
 * THE CONSOLE'S GEOMETRY, HELD TO THE HANDOFF'S OWN NUMBERS.
 *
 * ICP-016 asked whether each region renders and in which column. This asks the
 * question underneath it: is the layout the SHAPE the design specifies. A rail
 * that renders in the left column at 320px is in the right column and the
 * wrong screen.
 *
 * EVERY NUMBER IS PARSED FROM design_handoff_world_engine_previz/README.md, so
 * changing the design fails the test and no reading of mine sits in between.
 * A hand-typed 206 would agree with the design on the day it was written and
 * silently stop agreeing afterwards — which is exactly what a fidelity test is
 * for.
 *
 * HOW, WITHOUT A DOM. There is no jsdom here (ADR-002), so this evaluates the
 * CASCADE — media queries, !important, source order — rather than grepping for
 * a declaration. A grep passes the moment one exists and says nothing about
 * whether it wins; mobile-shell shipped that bug once, where a rule written
 * after a media query beat the query on source order and the grep reported the
 * breakpoint as working. The real pixel measurement is taken once in a browser
 * and recorded below.
 *
 * MEASURED IN CHROME against the real page, console injected, every flag on.
 * Recorded because a test here cannot take it:
 *
 *   at 1920px          at 1600px (the design's stacking floor)
 *     .we-console  padding 24px 26px 34px   .we-head padding-bottom 16px
 *     .we-main     1866  gap 14px  row        1546  gap 14px  row
 *     .we-rail      206            fixed       206            fixed
 *     .we-center   1180  gap 12px  column       860  gap 12px  column
 *     .we-right     452  gap 12px  column       452  gap 12px  column
 *     .we-secondary 1866 gap 12px  row         1866 gap 12px  row
 *
 * 1866 − 206 − 452 − (2 × 14) = 1180 exactly, so the centre takes precisely
 * the space the two fixed columns and the two gaps leave. Between 1920 and
 * 1600 ONLY the centre changes, which is what a fixed/fixed/flexible row must
 * do — and it is the measurement behind the "nothing changes above the
 * stacking width" check below.
 *
 * All 14 regions render with the flags on; with them off the four gated ones
 * disappear, which is how the flag wiring was confirmed from the browser side.
 *
 * THE NARROW CASE IS NOT BROWSER-MEASURED. A media query keys off the VIEWPORT
 * and the injected host is sized as a container, so narrowing the host proves
 * nothing; the window resize did not take on this machine. The reflow below
 * 1200px is therefore held by the cascade evaluator, which answers the same
 * question deterministically — and says so rather than claiming a measurement
 * that was not made.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { declared, px, RULES } = require('./css-cascade');

const ROOT = path.join(__dirname, '..', '..');
const DESIGN = fs.readFileSync(
    path.join(ROOT, 'design_handoff_world_engine_previz', 'README.md'), 'utf8');

/* ── the design's stated geometry, parsed ───────────────────────────────── */

/**
 * The layout section: the numbered "Overall layout" list plus the Canvas
 * paragraph above it, which is where the page padding and the design width
 * are stated.
 */
function layoutProse() {
    const from = DESIGN.indexOf('**Canvas:**');
    const to = DESIGN.indexOf('### Header bar');
    assert.ok(from > -1 && to > from, 'the layout section is gone from the design; re-derive this');
    return DESIGN.slice(from, to);
}

/**
 * Every `property: value` the layout prose states, in backticks.
 *
 * Parsed rather than listed: a declaration added to the design is in the
 * denominator with nothing to remember, and one removed fails the map below
 * rather than sitting here forever.
 */
function statedDeclarations() {
    const out = [];
    for (const m of layoutProse().matchAll(/`([^`]+)`/g)) {
        for (const part of m[1].split(';')) {
            const at = part.indexOf(':');
            if (at < 0) continue;
            const prop = part.slice(0, at).trim();
            const value = part.slice(at + 1).trim();
            if (!/^[a-z-]+$/.test(prop) || !value) continue;
            out.push({ prop, value, context: m.input.slice(Math.max(0, m.index - 90), m.index) });
        }
    }
    return out;
}

/**
 * Which selector carries each stated declaration.
 *
 * The ONLY hand-written part, and the test below refuses a stated declaration
 * that lands in none of these — so the map cannot quietly stop covering the
 * design.
 */
const CARRIES = [
    { when: /Canvas/i,           selector: '.we-console' },
    { when: /Header bar/i,       selector: '.we-head' },
    { when: /Main row/i,         selector: '.we-main' },
    { when: /Left rail/i,        selector: '.we-rail' },
    { when: /Center column/i,    selector: '.we-center' },
    { when: /Right column/i,     selector: '.we-right' },
    { when: /Secondary strip/i,  selector: '.we-secondary' },
];

/*
 * THE NEAREST PRECEDING LABEL, not the first in this array.
 *
 * `.find()` returned "Main row" for `width: 206px`, because the ninety
 * characters before it still contain the Main row line — so the rail's width
 * was attributed to the row and reported as a 452px mismatch. The label that
 * owns a declaration is the one closest to it.
 */
function selectorFor(decl) {
    let best = null, at = -1;
    for (const c of CARRIES) {
        const m = [...decl.context.matchAll(new RegExp(c.when.source, 'gi'))].pop();
        if (m && m.index > at) { at = m.index; best = c; }
    }
    return best ? best.selector : null;
}

/** The widths the design is drawn at, and the one below which it may reflow. */
function designWidth() {
    const m = /designed at \*\*(\d+)px wide\*\*/.exec(DESIGN);
    assert.ok(m, 'the design no longer states the width it was drawn at');
    return Number(m[1]);
}
function stackBelow() {
    const m = /Below ~(\d+)px the three columns should stack/.exec(DESIGN);
    assert.ok(m, 'the design no longer states where the columns stack');
    return Number(m[1]);
}

/* ── the tests ──────────────────────────────────────────────────────────── */

test('the design states enough geometry to be worth holding to', () => {
    const stated = statedDeclarations();
    assert.ok(stated.length >= 8,
        `only ${stated.length} declarations parsed out of the layout section — the scan is broken, `
        + 'and a scan that finds too few reports the gap as closed');
    // The four the task names must all be in there, or the parse has drifted.
    for (const want of ['206px', '452px', '1.62', '24px 26px 34px']) {
        assert.ok(stated.some(d => d.value.includes(want)),
            `the design no longer states ${want}; re-derive this test`);
    }
});

test('EVERY stated declaration is carried by a selector this test knows', () => {
    /*
     * The map is the one hand-written thing here. A declaration the design
     * states and this cannot place is a piece of geometry nobody is checking —
     * which is the failure a fidelity test exists to prevent, one level up.
     */
    const orphans = statedDeclarations().filter(d => !selectorFor(d))
        .map(d => `${d.prop}: ${d.value}`);
    assert.deepStrictEqual([...new Set(orphans)], [],
        `the design states these and nothing here knows where they live: ${orphans.join(', ')}`);
});

test('EVERY number the design states is what the page COMPUTES at the design width', () => {
    /*
     * Computed, not grepped. A declaration that exists and is overridden later
     * in source order reads identically to a grep and lays out differently.
     */
    const W = designWidth();
    const wrong = [];
    for (const d of statedDeclarations()) {
        const sel = selectorFor(d);
        const got = declared(sel, d.prop, W);
        if (got == null) { wrong.push(`${sel} { ${d.prop} } is not declared at all`); continue; }
        // Compare as pixels where both sides are a single length, else as text.
        const a = px(got, W), b = px(d.value, W);
        const same = Number.isFinite(a) && Number.isFinite(b)
            ? Math.abs(a - b) < 0.01
            : String(got).replace(/\s+/g, ' ') === String(d.value).replace(/\s+/g, ' ');
        if (!same) wrong.push(`${sel} { ${d.prop} } computes to "${got}", the design says "${d.value}"`);
    }
    assert.deepStrictEqual(wrong, [],
        'the console disagrees with the design about its own geometry:\n  ' + wrong.join('\n  '));
});

test('the columns are fixed where the design fixes them, and flexible where it does not', () => {
    /*
     * A fixed column that can shrink is not fixed. `width: 452px` on a flex
     * child still shrinks unless flex-shrink is off — which is why the design's
     * word is "fixed" and a width alone does not deliver it.
     */
    const W = designWidth();
    for (const sel of ['.we-rail', '.we-right']) {
        const flex = declared(sel, 'flex', W) || declared(sel, 'flex-shrink', W);
        assert.ok(flex && /none|0/.test(flex),
            `${sel} is given a fixed width and can still shrink — the design calls it fixed`);
    }
    assert.strictEqual(declared('.we-center', 'min-width', W), '0',
        'the centre column has no min-width:0, so a wide child pushes it past its flex ratio and '
        + 'squeezes the fixed columns');
});

test('NO computed value changes above the width the design stacks at', () => {
    /*
     * The design says the columns stack below ~1600px and does not design that
     * state. Above it, the layout must be exactly what the design draws — so a
     * breakpoint that reaches up into the designed range would change a
     * measured value without anyone deciding to.
     */
    const top = designWidth();
    const floor = stackBelow();
    const props = ['width', 'flex', 'gap', 'display', 'flex-direction', 'padding', 'align-items'];
    const drift = [];
    for (const sel of ['.we-console', '.we-main', '.we-rail', '.we-center', '.we-right', '.we-secondary']) {
        for (const p of props) {
            const a = declared(sel, p, top);
            const b = declared(sel, p, floor);
            if (a !== b) drift.push(`${sel} { ${p} }: ${a} at ${top}px, ${b} at ${floor}px`);
        }
    }
    assert.deepStrictEqual(drift, [],
        'a breakpoint reaches into the range the design draws:\n  ' + drift.join('\n  '));
});

test('the console DOES reflow below the stacking width, so a narrow screen is usable', () => {
    /*
     * The other half. A layout that never reflows is not fidelity, it is a
     * 1920px page on a laptop — and the console sits inside a shell that
     * already collapses to a phone.
     */
    const narrow = 900;
    const wide = designWidth();
    assert.notStrictEqual(declared('.we-main', 'flex-direction', narrow),
                          declared('.we-main', 'flex-direction', wide),
                          'the three columns never stack, at any width');
    assert.strictEqual(px(declared('.we-right', 'width', narrow), narrow), null || NaN,
        'the right column keeps a fixed pixel width on a narrow screen');
});

test('the panels that the design has NO geometry for are named, not silently ignored', () => {
    /*
     * The console carries three right-column panels the handoff does not draw —
     * Measurements, Generation Risk and Handover — added after it as product
     * features. Saying so is the difference between a deliberate extension and
     * a layout nobody checked; an unnamed extra is how a design test comes to
     * cover half the screen.
     */
    const { renderConsole } = require('./console-render');
    const html = renderConsole({ world_engine: true, marble_generation: true,
        cinematography_ai: true, reference_match: true, camera_explore: true, world_splats: true });
    const EXTRA = {
        MEASUREMENTS: 'world scale calibration — added after the handoff, no design geometry',
        'GENERATION RISK': 'shot complexity scoring — added after the handoff',
        HANDOVER: 'export readiness — added after the handoff',
    };
    for (const [label, why] of Object.entries(EXTRA)) {
        assert.ok(html.includes(label), `${label} is gone; the exemption is stale and now a lie`);
        assert.ok(why.length > 20, `${label}: the exemption states no real reason`);
    }
});
