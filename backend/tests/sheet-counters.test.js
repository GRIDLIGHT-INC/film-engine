/**
 * A progress counter cannot exceed its own total
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The prop sheet read "Turntable locked 7/5" — a number that is impossible on
 * its face, wrong in the reassuring direction, and printed beside two empty
 * slots on the same screen.
 *
 * The cause is a SHAPE, not an arithmetic slip. There are three of these
 * counters and two of them iterate the CANONICAL SET and ask which members have
 * a picture, so they cannot overflow however many pictures exist. The prop one
 * iterated the PICTURES and asked which were canonical — and a subject can hold
 * two pictures for one slot, because a view-less plate is the identity plate and
 * defaults to `front` while an explicit `front` view may also exist. Measured on
 * the live install: 9 views, 6 counted, 5 distinct slots actually filled, front
 * counted twice.
 *
 * Filtering harder does not fix that: a first pass restricted the count to
 * canonical names and still returned 6/5, because both rows are legitimately
 * `front`. Only counting SLOTS can be bounded by the number of slots.
 *
 * So the invariant is structural, and this test asserts the shape rather than
 * one arithmetic outcome: every counter filters the same collection it divides
 * by. Set-based over all three sheets, because the failure is per-sheet — two
 * were already immune and one was not, and a fix proven on props says nothing
 * about the other two.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const UI = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/*
 * The three counters, found by their rendered label rather than by a list —
 * a hand-written list is only as complete as the afternoon it was written, and
 * a fourth sheet must land in the denominator on its own.
 */
function counters() {
    const found = [];
    const re = /\$\{(\w+)\}\/\$\{([^}]+)\}|Views \$\{(\w+)\}\/(\d+)/g;
    let m;
    while ((m = re.exec(UI))) {
        const line = UI.slice(Math.max(0, m.index - 200), m.index + 60);
        if (!/locked|Views /i.test(line)) continue;
        found.push({
            countVar: m[1] || m[3],
            denominator: m[2] || m[4],
            at: m.index,
        });
    }
    return found;
}

test('all three sheet counters are discovered, not listed', () => {
    const c = counters();
    assert.ok(c.length >= 3,
        `found ${c.length} progress counters; the scan is not seeing the sheets it audits`);
});

test('every counter filters the same collection it divides by', () => {
    for (const c of counters()) {
        // The assignment that produced the counted number, searched backwards
        // from the label so each counter is judged on its own code.
        const before = UI.slice(Math.max(0, c.at - 1400), c.at);
        const assign = [...before.matchAll(new RegExp(`const ${c.countVar}\\s*=([\\s\\S]*?);\\n`, 'g'))].pop();
        assert.ok(assign, `${c.countVar}: no assignment found before its own label`);
        const expr = assign[1];

        /*
         * The collection being counted, and the collection being divided by,
         * must be the same one. `slots.filter(...)` over `slots.length` is
         * bounded by construction; `SS.views.filter(...)` over
         * `SS.propViews.length` is not, and that is exactly how 7/5 and then
         * 6/5 were printed.
         */
        const denomCollection = String(c.denominator).replace(/\.length\s*$/, '').trim();
        if (/^\d+$/.test(c.denominator)) {
            // A literal total is acceptable only if the count walks a registry
            // rather than the pictures — the character sheet's CS_VIEWS/4.
            assert.match(expr, /[A-Z_]{4,}|VIEWS/,
                `${c.countVar}: counts against a literal ${c.denominator} without walking a registry`);
            continue;
        }
        assert.ok(expr.includes(denomCollection),
            `${c.countVar} is counted from a different collection than the ${c.denominator} it is `
            + `shown against, so it can exceed its own total — which is how "locked 7/5" reached the `
            + `screen. Counted from: ${expr.trim().slice(0, 80)}`);
    }
});
