/**
 * While a generation runs, the thing you clicked says so
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "As it generates I still don't see a spinner until we get the content back
 *  into the engine."
 *
 * `every-generate-button.test.js` already asks every generating function to
 * show that it is working — and its predicate accepts `setStatus(msg, true)`,
 * which is the BOTTOM STATUS BAR. Measured across the 29 functions it
 * discovers, only 6 put any state on the control that was clicked; 19 write to
 * the status bar alone and 4 say nothing at all.
 *
 * The status bar is not the fix, and this codebase already knows it. From the
 * storyboard work: "`Regenerating...` went to the status bar at the bottom of
 * the screen while the card you clicked looked exactly as it had a moment
 * before — for up to a minute... feedback belongs on the thing you touched."
 * That lesson was applied to one surface and not made general.
 *
 * SO THE MECHANISM GOES IN `api()`, not into 23 function bodies. Every one of
 * those functions reaches a provider through that single call, so marking the
 * originating control there covers all of them — and covers the next one added,
 * with nothing to remember. Threading a busy flag through 23 call sites is how
 * 21 of them get it.
 *
 * The ORIGIN is the control that opened the confirmation, never the
 * confirmation's own Generate button: `confirmGenResolve` closes the dialog
 * before the work starts, so marking that button decorates something already
 * hidden. What the director is looking at is the sheet they pressed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const UI = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

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

/** Every function that POSTs to a generating endpoint — the same discovery. */
function generatingFunctions() {
    const PAID_URL = /\/(generate|regenerate|refine|recompose|orbit|compass|plate|refsheet|explore|sequence|stitch|models?\/|inbetweens)/;
    const out = new Map();
    for (const m of UI.matchAll(/(?:async\s+)?function ([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (out.has(m[1]) || /^confirm/.test(m[1])) continue;
        const body = fnSource(m[1]);
        if (!body) continue;
        for (const a of body.matchAll(/api\(/g)) {
            const url = (body.slice(a.index, a.index + 220).match(/api\(\s*([^,)]*)/) || [])[1] || '';
            if (!PAID_URL.test(url)) continue;
            if (/preview|\/plan\b|\/brief|prompt'|\/views|\/gallery/.test(url)) continue;
            if (!/method:\s*'POST'/.test(body.slice(a.index, a.index + 300))) continue;
            out.set(m[1], body);
            break;
        }
    }
    return out;
}

test('the discovery still finds the generating functions', () => {
    const found = generatingFunctions();
    assert.ok(found.size >= 20, `expected the real set, found ${found.size}`);
});

test('every generating function reaches the provider through api()', () => {
    /*
     * The premise the whole mechanism rests on. If one of them called `fetch`
     * directly it would spend without ever passing the one place that marks the
     * control busy — and it would look identical from the outside.
     */
    const direct = [];
    for (const [name, body] of generatingFunctions()) {
        if (/\bfetch\s*\(/.test(body)) direct.push(name);
    }
    assert.deepStrictEqual(direct, [],
        'these bypass api() and so escape the busy state entirely:\n  ' + direct.join('\n  '));
});

// ---------------------------------------------------------------------------
// The mechanism, executed
// ---------------------------------------------------------------------------

/** A DOM and a fetch small enough to run `api()` against. */
function harness(opts = {}) {
    const el = (id, extra = {}) => ({
        id, tagName: 'BUTTON', disabled: false, style: {}, dataset: {},
        innerHTML: 'Generate', isConnected: true,
        classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                     contains(c) { return this._s.has(c); } },
        closest: () => null, ...extra,
    });

    const doc = { addEventListener() {}, getElementById: () => null,
                  querySelector: () => null, querySelectorAll: () => [] };

    /*
     * The pieces the mechanism is made of, pulled by name so the sandbox runs
     * the page's own code rather than a copy written here that could disagree.
     * The click listener is NOT injected -- what it decides (never the
     * confirmation's own buttons) is asserted separately against the source;
     * what this harness exercises is what api() does once an origin is set.
     */
    const consts = [...UI.matchAll(/^\s*(?:const|let)\s+(GEN_BUSY_[A-Z_]+|GENERATION_ORIGIN)\s*=.*$/gm)]
        .map(m => m[0]).join('\n');
    const parts = ['spendsOnThisCall', 'beginGenerationBusy', 'api'].map(n => {
        const src = fnSource(n);
        assert.ok(src, `${n} is gone — the busy mechanism has been removed`);
        return src;
    });

    const build = new Function('document', 'fetch', 'API', 'setStatus', 'setInterval', 'clearInterval', `
        // api() schedules a refresh of the current page after a successful
        // write (see live-after-write). This harness is about the BUSY refcount,
        // so the refresh is stubbed rather than simulated — and stubbed rather
        // than omitted, because an undefined call throws inside api() and would
        // report the spinner as broken.
        let refreshed = 0;
        function refreshAfterWrite() { refreshed++; }
        ${consts}
        ${parts.join('\n')}
        return { api, setOrigin(e) { GENERATION_ORIGIN = e; } };
    `);
    return Object.assign(
        build(doc, opts.fetch, () => '', () => {}, () => 0, () => {}),
        { el });
}

function okFetch() {
    return async () => ({ ok: true, status: 200, json: async () => ({ done: true }) });
}
function failFetch() {
    return async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
}

test('a generating POST marks the control that started it', async () => {
    const h = harness({ fetch: async () => {
        // Asserted DURING the request, which is the only moment it is true.
        assert.ok(btn.classList.contains('is-generating'),
            'the control carries no working state while the generation is in flight');
        assert.strictEqual(btn.disabled, true, 'the control stayed clickable during a paid generation');
        return { ok: true, status: 200, json: async () => ({}) };
    } });
    const btn = h.el('sheetGenerate');
    h.setOrigin(btn);
    await h.api('/characters/x/refsheet/generate', { method: 'POST' });
    assert.ok(!btn.classList.contains('is-generating'), 'the working state was never cleared');
});

test('a free GET marks nothing', async () => {
    /*
     * A busy state on every read would be noise, and noise is what makes a real
     * one unreadable. Only a POST to a generating endpoint counts.
     */
    let markedDuring = false;
    const h = harness({ fetch: async () => {
        markedDuring = btn.classList.contains('is-generating');
        return { ok: true, status: 200, json: async () => ({}) };
    } });
    const btn = h.el('sheetGenerate');
    h.setOrigin(btn);
    await h.api('/shots/x/prompt');
    assert.strictEqual(markedDuring, false, 'a free read marked the control busy');

    /*
     * And a POST that is not a GENERATION. Testing only the GET left the URL
     * check unexercised -- the method check carried the assertion on its own,
     * and replacing the URL predicate with `true` survived.
     */
    let markedOnPlainPost = false;
    const h2 = harness({ fetch: async () => {
        markedOnPlainPost = btn2.classList.contains('is-generating');
        return { ok: true, status: 200, json: async () => ({}) };
    } });
    const btn2 = h2.el('saveButton');
    h2.setOrigin(btn2);
    await h2.api('/scenes/abc', { method: 'PUT' });
    await h2.api('/projects/abc/staleness/accept', { method: 'POST' });
    assert.strictEqual(markedOnPlainPost, false,
        'a POST that generates nothing marked the control busy — every save would spin');
});

test('the control is released when the generation fails, not only when it succeeds', async () => {
    const h = harness({ fetch: failFetch() });
    const btn = h.el('sheetGenerate');
    h.setOrigin(btn);
    await h.api('/characters/x/refsheet/generate', { method: 'POST' }).catch(() => {});
    assert.ok(!btn.classList.contains('is-generating'),
        'a failed generation left the control spinning for ever — worse than no spinner');
    assert.strictEqual(btn.disabled, false, 'a failed generation left the control disabled');
});

test('the confirmation dialog\'s own buttons are never the origin', () => {
    /*
     * `confirmGenResolve` CLOSES the dialog before the work begins, so marking
     * the button inside it decorates something already hidden while the sheet
     * the director is actually looking at stays silent.
     *
     * Bound to the LISTENER, not to the file: a search for "confirmGenModal"
     * anywhere in a 2.4MB page passes against a tracker that excludes nothing.
     */
    const listener = /document\.addEventListener\('click',([\s\S]*?)\}, true\);/.exec(UI);
    assert.ok(listener, 'the origin tracker is gone — nothing records what was clicked');
    const body = listener[1];
    assert.match(body, /GENERATION_ORIGIN\s*=/, 'the click listener does not record an origin');
    assert.match(body, /confirmGenModal/,
        'the origin tracker does not exclude the confirmation\'s own controls, so the busy state '
        + 'would land on a button the dialog has already hidden');
    // And the exclusion must RETURN, not merely mention it.
    assert.match(body, /confirmGenModal[^\n]*\)\s*return/,
        'confirmGenModal is mentioned but nothing skips it');
});

test('a batch against one control releases only when the last generation ends', async () => {
    /*
     * Refcounted. A batch fires several generations from one button, and the
     * first to finish would otherwise clear the state while the rest still run —
     * the control reads as finished with money still going out.
     *
     * Asserted BETWEEN the two completions, which is the only moment the
     * refcount is observable: awaiting both first passes against no refcount at
     * all, and did.
     */
    let releaseFirst, releaseSecond;
    const gates = [
        new Promise(r => { releaseFirst = r; }),
        new Promise(r => { releaseSecond = r; }),
    ];
    let n = 0;
    const h = harness({ fetch: async () => {
        await gates[n++];
        return { ok: true, status: 200, json: async () => ({}) };
    } });
    const btn = h.el('generateAll');
    h.setOrigin(btn);

    const a = h.api('/projects/x/storyboard/generate', { method: 'POST' });
    const b = h.api('/projects/x/video/generate', { method: 'POST' });

    releaseFirst();
    await a;
    assert.ok(btn.classList.contains('is-generating'),
        'the first generation to finish cleared the control while the second was still running');
    assert.strictEqual(btn.disabled, true, 'the control became clickable with a generation still in flight');

    releaseSecond();
    await b;
    assert.ok(!btn.classList.contains('is-generating'), 'the control never cleared');
    assert.strictEqual(btn.disabled, false, 'the control was left disabled after a batch');
});
