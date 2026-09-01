/**
 * A modal opened on top of another must paint on top of it
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "I probably asked 4 times to check every place on the app where we click
 *  generate... and I still don't get the modal with the prompt that will be
 *  sent." Then, mid-session: "the prompt pops up BEHIND the character modal."
 *
 * The confirmation was never missing. It opened correctly, with the prompt, the
 * provider, the model, the quality and the size — underneath whatever sheet it
 * was launched from, where it could be neither seen nor clicked.
 *
 * Every `.modal-overlay` carries the SAME `z-index: 1000`, so paint order falls
 * to DOM order, and `confirmGenModal` is declared at DOM index 3 with 31
 * overlays after it — including both subject sheets. Measured in the running
 * page: with the sheet and the confirmation both open,
 * `document.elementFromPoint()` at the confirmation's own centre returns
 * `characterSheetModal`.
 *
 * THIS IS WHY FIVE TEST FILES PASSED THROUGHOUT. every-generate-button,
 * paid-preview, generation-controls, prompt-visibility and loading-never-sticks
 * all check that the confirmation is INVOKED and that its markup is right.
 * None of them could see that it was invisible. A gate nobody can read is a
 * gate that is not there, and the user pressed on regardless — which is the
 * spend this whole mechanism exists to prevent.
 *
 * The fix is a stacking rule in the one helper that opens modals, NOT new
 * confirmation plumbing. Two things have to hold for that to work, and both are
 * checked as SETS derived from the source rather than from a list:
 *
 *   1. every open and every close goes THROUGH the helper — nine functions
 *      added the class directly and would silently escape any rule the helper
 *      applies. That is the same shape as the three modals once shown with a
 *      class the stylesheet ignores: "a caller that cannot choose the class
 *      cannot get that wrong."
 *   2. the helper actually raises each modal above the one below it, proven by
 *      EXECUTING it rather than by matching its text.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const UI = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const LINES = UI.split('\n');

/** The nearest preceding function declaration for a 1-based line. */
function enclosingFn(line) {
    for (let i = line - 1; i >= 0; i--) {
        const m = /function\s+([A-Za-z0-9_$]+)\s*\(/.exec(LINES[i]);
        if (m) return m[1];
    }
    return '(top level)';
}

/** Every id that is actually a `.modal-overlay` in the markup. */
const MODAL_IDS = new Set(
    [...UI.matchAll(/class="modal-overlay[^"]*"\s+id="([^"]+)"/g)].map(m => m[1]));

/**
 * Sites that toggle the `open` class ON A MODAL.
 *
 * Scoped, because `open` is not the modals' word alone -- `exportDropdown` uses
 * it too, and a bare regex reported four working dropdown handlers as escaping
 * the modal stack. A check that cries wolf four times out of ten is one that
 * gets switched off, and the six real sites would go with it.
 *
 * The receiver is resolved: a literal `getElementById('x')` must name a modal,
 * and a variable is traced back to its assignment inside the same function.
 */
function modalToggleSites(re) {
    const out = [];
    LINES.forEach((l, i) => {
        if (!re.test(l)) return;
        const line = i + 1;
        const fn = enclosingFn(line);

        const direct = /getElementById\(\s*['"]([^'"]+)['"]\s*\)\s*\.classList/.exec(l);
        if (direct) { if (MODAL_IDS.has(direct[1])) out.push({ line, fn, target: direct[1] }); return; }

        const via = /([A-Za-z_$][\w$]*)\.classList\.(?:add|remove)\(/.exec(l);
        if (via) {
            const name = via[1];
            // Trace the variable back within the enclosing function.
            const src = fnSource(fn) || '';
            const assign = new RegExp(`${name}\\s*=\\s*document\\.getElementById\\(\\s*['"]([^'"]+)['"]`).exec(src);
            if (assign && MODAL_IDS.has(assign[1])) { out.push({ line, fn, target: assign[1] }); return; }
            /*
             * A traced id that is not in the markup is NOT proof it is not a
             * modal: `showCostInputModal` and `showModalHtml` BUILD theirs at
             * run time, so it exists in no static id set. Falling through on
             * that rather than returning is what keeps the dynamically created
             * ones in the denominator -- and one of them was escaping.
             */
            if (/modal-overlay/.test(src) || /overlay/i.test(name)) {
                out.push({ line, fn, target: (assign && assign[1]) || name });
            }
        }
    });
    return out;
}

/** A named function's source, bounded by brace depth. */
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(UI);
    if (!m) return null;
    /*
     * The body's brace, NOT the first one after the name: `api(path, opts = {})`
     * carries a brace in a PARAMETER DEFAULT, and starting there matched `{}`
     * and returned a 34-character stub. Walk the parameter list to its closing
     * paren first.
     */
    let i = UI.indexOf('(', m.index), depth = 0;
    for (; i < UI.length; i++) {
        if (UI[i] === '(') depth++;
        else if (UI[i] === ')') { depth--; if (!depth) { i++; break; } }
    }
    i = UI.indexOf('{', i);
    depth = 0;
    for (let j = i; j < UI.length; j++) {
        if (UI[j] === '{') depth++;
        else if (UI[j] === '}') { depth--; if (!depth) return UI.slice(m.index, j + 1); }
    }
    return null;
}

// ---------------------------------------------------------------------------
// 1. One way in, one way out
// ---------------------------------------------------------------------------

const OPEN_HELPERS = new Set(['showModal', 'showModalHtml']);

test('the overlay set is real, and they all share one z-index', () => {
    const overlays = (UI.match(/class="modal-overlay/g) || []).length;
    assert.ok(overlays >= 20, `expected the real overlay set, saw ${overlays}`);
    /*
     * The base rule stays. A modal opened by something this fix does not reach
     * must still APPEAR — it is only the ordering that the helper supplies.
     */
    assert.match(UI, /\.modal-overlay\s*\{[^}]*z-index:\s*1000/,
        'the base overlay z-index is gone; an unstacked modal would not appear at all');
});

test('nothing opens a modal except the helper', () => {
    const stray = modalToggleSites(/classList\.add\(['"]open['"]\)/)
        .filter(s => !OPEN_HELPERS.has(s.fn));
    assert.deepStrictEqual(stray.map(s => `${s.fn} (line ${s.line})`), [],
        'these add the open class directly, so any stacking rule the helper applies '
        + 'never reaches them:\n  ' + stray.map(s => `${s.fn} (line ${s.line})`).join('\n  '));
});

test('nothing closes a modal except the helper', () => {
    /*
     * The close side matters as much: a modal removed from the stack only by
     * the helper is one whose depth stays correct. A direct `remove('open')`
     * leaves it counted as open forever, and every later modal stacks above a
     * ghost.
     */
    const stray = modalToggleSites(/classList\.remove\(['"]open['"]\)/)
        .filter(s => s.fn !== 'closeModal');
    assert.deepStrictEqual(stray.map(s => `${s.fn} (line ${s.line})`), [],
        'these remove the open class directly, so the stack never learns they closed:\n  '
        + stray.map(s => `${s.fn} (line ${s.line})`).join('\n  '));
});

// ---------------------------------------------------------------------------
// 2. The helper actually stacks — executed, not matched
// ---------------------------------------------------------------------------

/** A DOM small enough to run the helpers against, and honest about what they touch. */
function harness() {
    const made = new Map();
    const el = id => {
        if (!made.has(id)) {
            made.set(id, {
                id, style: {},
                classList: {
                    _s: new Set(),
                    add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                    contains(c) { return this._s.has(c); },
                },
            });
        }
        return made.get(id);
    };
    const doc = {
        getElementById: el,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
        body: { appendChild() {} },
    };

    /*
     * The helpers, plus anything they CALL that is itself a page function --
     * one level, the rule manual-edit and generation-handles already follow. The
     * stacking rule may legitimately live in a helper of its own, and extracting
     * only the two named functions would leave the sandbox throwing on a name it
     * cannot see, which reads as the feature being broken.
     */
    const names = ['showModal', 'closeModal'];
    for (const n of [...names]) {
        const body = fnSource(n) || '';
        for (const m of body.matchAll(/\b([a-z][A-Za-z0-9_$]*)\s*\(/g)) {
            if (names.includes(m[1])) continue;
            if (fnSource(m[1])) names.push(m[1]);
        }
    }
    const parts = names.map(fnSource);
    assert.ok(parts.every(Boolean), 'showModal or closeModal is gone');

    /*
     * Anything the helpers close over -- the stack, the base -- declared at the
     * top level beside them. Pulled by name so the sandbox sees exactly what
     * the page does, rather than a copy written here that could disagree.
     */
    const consts = [...UI.matchAll(/^\s*(?:const|let|var)\s+(MODAL_[A-Z_]+)\s*=.*$/gm)]
        .map(m => m[0]).join('\n');

    const fn = new Function('document', 'setTimeout', `
        ${consts}
        ${parts.join('\n')}
        return { showModal, closeModal, el: id => document.getElementById(id) };
    `);
    return fn(doc, () => {});
}

const z = e => Number(e.style.zIndex || 0);

test('a modal opened second paints above the one already open', () => {
    const h = harness();
    h.showModal('characterSheetModal');
    h.showModal('confirmGenModal');

    const sheet = h.el('characterSheetModal');
    const confirm = h.el('confirmGenModal');
    assert.ok(confirm.classList.contains('open'), 'the confirmation did not open');
    assert.ok(z(confirm) > z(sheet),
        `the confirmation (z ${z(confirm) || 'unset'}) does not paint above the sheet `
        + `(z ${z(sheet) || 'unset'}) — this is the reported bug`);
});

test('it stacks to any depth, not just two', () => {
    const h = harness();
    const ids = ['characterSheetModal', 'galleryModal', 'confirmGenModal', 'plateViewerModal'];
    ids.forEach(h.showModal);
    const zs = ids.map(i => z(h.el(i)));
    for (let i = 1; i < zs.length; i++) {
        assert.ok(zs[i] > zs[i - 1],
            `modal ${i + 1} does not paint above modal ${i}: ${JSON.stringify(zs)}`);
    }
});

test('closing releases the depth, so it cannot climb without bound', () => {
    /*
     * An ever-increasing counter would work on the day it shipped and drift
     * upward for the life of the session, eventually clearing the top bar and
     * the sidebar. The depth has to come back down.
     */
    const h = harness();
    h.showModal('a'); h.showModal('b');
    const top = z(h.el('b'));
    h.closeModal('b'); h.closeModal('a');
    h.showModal('c'); h.showModal('d');
    assert.strictEqual(z(h.el('d')), top,
        `after closing everything a second pair reached z ${z(h.el('d'))} where the first reached ${top}`);
});

test('a closed modal gives up its raised z-index', () => {
    const h = harness();
    h.showModal('a');
    h.closeModal('a');
    const raised = h.el('a').style.zIndex;
    assert.ok(!raised, `a closed modal kept z-index ${raised}, so it still sits above the page`);
});

test('re-showing an already open modal raises it rather than double-counting', () => {
    /*
     * `showModal` is called again on a modal that is already open in several
     * places -- refreshing one, or re-entering a flow. Pushing it twice would
     * leave a depth that never comes back down.
     */
    /*
     * Anchored to a CLEAN baseline, not to a later value. Comparing two
     * post-drift numbers passes while a ghost entry sits in the stack for the
     * life of the session -- proven by mutation: removing the splice left one
     * modal counted twice and this still went green.
     */
    const baseline = (() => { const b = harness(); b.showModal('only'); return z(b.el('only')); })();

    const h = harness();
    h.showModal('a'); h.showModal('b');
    h.showModal('a');                       // raise the lower one
    assert.ok(z(h.el('a')) > z(h.el('b')), 're-showing did not raise it to the top');

    h.closeModal('a'); h.closeModal('b');
    h.showModal('c');
    assert.strictEqual(z(h.el('c')), baseline,
        `after a re-show and two closes the next modal opened at z ${z(h.el('c'))} `
        + `where the first modal on a clean stack opens at ${baseline} — a ghost is still counted`);
});
