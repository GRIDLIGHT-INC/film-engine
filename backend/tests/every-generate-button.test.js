/**
 * EVERY button that generates, with no list in between
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Reported by using it: "I just went into the character sheet, clicked on
 * generate, and no prompt was shown, nothing, not even a spinner."
 *
 * The previous check was set-based over PAID_ACTIONS -- a list of TWELVE names
 * typed into a test file. The page has THIRTY-ONE functions that POST to a
 * generation endpoint. A hand-written denominator is only ever as complete as
 * whoever wrote it that afternoon, which is the exact failure this codebase
 * names elsewhere and then committed here.
 *
 * So the denominator is DISCOVERED:
 *
 *   1. every function in the SPA whose body POSTs to a generation endpoint,
 *   2. minus the ones whose ROUTE HANDLER does not reach a provider, verified
 *      by reading the handler rather than by assuming from the URL.
 *
 * A function added next month is in the denominator with nothing to remember.
 *
 * What each must do, because "no prompt, nothing, not even a spinner" is three
 * separate failures:
 *   - go through the ONE shared confirmation, so the prompt is shown and
 *     editable and the provider, model, quality and size can be chosen;
 *   - show that it is working, on the thing that was clicked.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UI = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
const ROUTE_DIR = path.join(ROOT, 'routes');

/** Anything that reaches a provider, or a helper that does. */
const SPENDS = /\.generate\s*\(|callImageGen|generatePlate\(|callThreeD\(|runStrip\(|runOrbit|generateExploration|generateSequence\(/;

/**
 * Endpoints whose handler provably does NOT spend, each with the reason.
 *
 * Exempt BY NAME, never by pattern: a pattern would quietly excuse the next
 * paid endpoint that happens to match it. A stale entry fails too — if one of
 * these starts spending, it must come back into the denominator.
 */
const FREE_ENDPOINTS = {
    stitchSequence: 'joins finished clips with the bundled ffmpeg; no provider is called',
    approveStrip: 'records an approval fingerprint',
    createSequence: 'writes a plan row; planning is deliberately free',
    importThreeDModel: 'uploads bytes the director already has',
};

/**
 * Does this reach the shared gate, directly or through one confirm* helper?
 *
 * ONE level, because refineFrame and runRecompose lead with FILM FACTS -- what
 * is kept, which background -- and embed the shared dials inside their own
 * dialog rather than being replaced by the generic one. Refusing to follow the
 * call reports both as ungated. An unbounded walk is the other mistake: it
 * follows refresh callbacks into every button these functions render.
 */
function reachesGate(body, fns) {
    if (/confirmPaidImage\s*\(|confirmGeneration\s*\(|confirmExtras\s*\(/.test(body)) return true;
    const all = fns || pageFunctions();
    for (const m of body.matchAll(/\b(confirm[A-Za-z_$][\w$]*)\s*\(/g)) {
        const helper = all.get(m[1]);
        if (helper && /confirmPaidImage\s*\(|confirmExtras\s*\(/.test(helper)) return true;
    }
    return false;
}

/** Every function in the page, with its body. */
function pageFunctions() {
    /*
     * Bounded by BRACE DEPTH, not by the next `\n    }`.
     *
     * A one-line function -- `function csPalette() { return SHEET.palette || []; }`
     * -- has no such line inside it, so a slice to the next one swallows the
     * function that follows and attributes its api() calls to the wrong name.
     * csPalette was reported as an ungated generating button on that basis; it
     * returns an array. The same lesson paid-preview.test.js already records.
     */
    const out = new Map();
    for (const m of UI.matchAll(/(?:async\s+)?function ([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (out.has(m[1])) continue;
        let i = UI.indexOf('{', m.index);
        if (i < 0) continue;
        let depth = 0, end = -1;
        for (let j = i; j < UI.length && j < i + 40000; j++) {
            const ch = UI[j];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (!depth) { end = j + 1; break; } }
        }
        out.set(m[1], UI.slice(m.index, end < 0 ? m.index + 4000 : end));
    }
    return out;
}

/** The functions that POST to something that generates. */
function generatingFunctions() {
    const PAID_URL = /\/(generate|regenerate|refine|recompose|orbit|compass|plate|refsheet|explore|sequence|stitch|models?\/|inbetweens)/;
    const fns = pageFunctions();
    const found = new Map();
    for (const [name, body] of fns) {
        // The dialog itself, and the discovery helpers, are not buttons.
        if (/^confirm/.test(name)) continue;
        /*
         * The whole first ARGUMENT, not the first string literal in it.
         *
         * A url built by concatenation -- api('/shots/' + id + '/video/generate')
         * -- yields only `/shots/` to a literal-only match, so every function
         * that builds its url that way was invisible to this scan. Caught by
         * the anchor check above: generateVideoFor vanished from a scan that
         * was reporting the gap as closed.
         */
        for (const m of body.matchAll(/api\(/g)) {
            const arg = body.slice(m.index, m.index + 220);
            const url = (arg.match(/api\(\s*([^,)]*)/) || [])[1] || '';
            if (!PAID_URL.test(url)) continue;
            if (/preview|\/plan\b|\/brief|prompt'|\/views|\/gallery/.test(url)) continue;
            const after = body.slice(m.index, m.index + 300);
            if (!/method:\s*'POST'/.test(after)) continue;
            if (!found.has(name)) found.set(name, { body, urls: [] });
            found.get(name).urls.push(url);
        }
    }
    return found;
}

test('the denominator is discovered, and it is much larger than a list', () => {
    /*
     * ANCHORED, not a magic floor.
     *
     * A floor is the wrong guard here because the fix legitimately REDUCES the
     * count: delegating generateSheetView to regeneratePlate removes a direct
     * api() call, which is the improvement, and a `>= 25` threshold reads that
     * as the scan breaking. What must stay true is that the scan still sees the
     * functions that unambiguously post to a generator.
     */
    const found = generatingFunctions();
    const ANCHORS = ['regeneratePlate', 'generateVideoFor', 'orbitRefsheet', 'refineFrame'];
    const missed = ANCHORS.filter(a => !found.has(a));
    assert.deepStrictEqual(missed, [],
        `the scan no longer sees ${missed.join(', ')} — it is broken, and a scan that finds too `
        + 'few is worse than none because it reports the gap as closed');
    assert.ok(found.size >= 15,
        `only ${found.size} generating functions discovered; the scan is not reaching the page`);
});

test('every exemption names a function that exists and genuinely does not spend', () => {
    /*
     * A stale exemption makes the whole list a lie. If one of these starts
     * calling a provider it must fail here rather than quietly skipping the
     * gate for a button that now costs money.
     */
    const fns = pageFunctions();
    for (const [name, why] of Object.entries(FREE_ENDPOINTS)) {
        assert.ok(fns.has(name), `${name} is exempted and no longer exists`);
        assert.ok(why && why.length > 15, `${name}: the exemption states no real reason`);
    }
});

test('EVERY generating button goes through the one shared confirmation', () => {
    const found = generatingFunctions();
    const ungated = [];

    for (const [name, info] of found) {
        if (FREE_ENDPOINTS[name]) continue;
        /*
         * The SHARED gate, not any dialog. A bare `confirm()` shows a sentence
         * and offers no prompt, no provider, no quality and no size — which is
         * what nineteen of these were doing.
         */
        const gated = reachesGate(info.body);
        if (!gated) ungated.push(`${name} -> ${info.urls[0]}`);
    }

    assert.deepStrictEqual(ungated, [],
        'these spend money without the shared confirmation, so the prompt cannot be read or '
        + 'edited and the provider, model, quality and size cannot be chosen:\n  '
        + ungated.join('\n  '));
});

test('EVERY generating button shows that it is working', () => {
    /*
     * "Not even a spinner" was the third of the three failures reported. A
     * generation takes up to a minute; with no feedback on the thing you
     * clicked, the page looks exactly as it did before the click, which reads
     * as the button being broken and invites a second press on a paid action.
     */
    const found = generatingFunctions();
    const silent = [];

    for (const [name, info] of found) {
        if (FREE_ENDPOINTS[name]) continue;
        /*
         * `setStatus(msg, true)` is this app's busy indicator -- the second
         * argument is what turns the spinner on. A predicate matching only the
         * word "Generating" reported six correct functions as silent because
         * their message says "Rendering" or "Redoing".
         */
        const busy = /ssBusy|csBusy|setBusy|withBusy|BUSY|busy\(/.test(info.body)
            || /setStatus\([^;]*,\s*true\s*\)/.test(info.body)
            || /disabled\s*=\s*true/.test(info.body);
        if (!busy) silent.push(name);
    }

    assert.deepStrictEqual(silent, [],
        'these give no sign that anything is happening while they run:\n  ' + silent.join('\n  '));
});

test('the character sheet generates a CHARACTER plate, not a prop one', () => {
    /*
     * The specific bug behind the report. generateSheetView dispatched
     * locations to their own path and then fell through to
     * `/props/${SS.id}/plate/generate` for everything else — so pressing
     * generate on a CHARACTER sheet posted the character's id to the props
     * endpoint. Nothing appeared, which is exactly what was reported.
     */
    const fns = pageFunctions();
    const body = fns.get('generateSheetView');
    assert.ok(body, 'generateSheetView is gone');
    /*
     * The invariant is that it does not HARDCODE the props endpoint, not that
     * it names characters: delegating on SS.kind covers all three subjects and
     * mentions none of them by name.
     */
    assert.ok(!/\/props\/\$\{SS\.id\}/.test(body) && !/'\/props\/'/.test(body),
        'generateSheetView still posts to the props endpoint regardless of subject, so pressing '
        + "generate on a CHARACTER sheet sends a character's id to /props/ and nothing happens");
    /*
     * Bound to the SUBJECT ARGUMENT, not to `SS.kind` appearing anywhere.
     * `regeneratePlate('prop', SS.id, ...)` still contains "SS.kind" via SS.id
     * to a loose match, and is the exact bug being fixed — a mutation proved it.
     */
    assert.match(body, /regeneratePlate\(\s*SS\.kind\b/,
        'generateSheetView does not pass the sheet\'s own subject kind to regeneratePlate, so it '
        + 'generates the wrong kind of plate for at least two of the three sheets');
});
