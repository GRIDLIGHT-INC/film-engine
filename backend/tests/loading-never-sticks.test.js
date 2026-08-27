/**
 * A spinner that never resolves is worse than an error.
 *
 * Three compass plates were generated, stored correctly, served correctly by
 * the API — and reported as MISSING, because the panel that shows them sat on
 * "Loading views…" forever. The render built its markup with `r.location`,
 * and there was no `r` in that scope. It threw mid-template, nothing caught
 * it, and the placeholder stayed.
 *
 * From the outside that is indistinguishable from the plates not existing,
 * which is exactly how it was reported. An error can be acted on; a permanent
 * spinner teaches you the data is gone.
 *
 * The invariant is general and cheap: any renderer that writes a loading
 * placeholder must have a path that replaces it on failure. Checked over
 * EVERY such renderer, because the next one will make the same mistake in a
 * different function.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/**
 * Every function that paints a loading placeholder, found by the placeholder
 * itself rather than by a list — a new panel is in the denominator without
 * anyone remembering.
 */
function loadingRenderers() {
    const out = [];
    /*
     * A placeholder written INTO A PANEL, not a status-bar message.
     *
     * The first version matched any "Loading…" string and swept in nine
     * `setStatus('Loading scenes…')` calls — which write to the status bar and
     * cannot leave a panel stuck. A detector that reports nine false positives
     * gets switched off, and the one real case goes with it.
     */
    for (const m of SPA.matchAll(/\w+\.innerHTML\s*=\s*['"`][^;]{0,120}?Loading/g)) {
        // Walk back to the enclosing function declaration.
        const before = SPA.slice(0, m.index);
        const at = Math.max(
            before.lastIndexOf('\n    function '),
            before.lastIndexOf('\n    async function ')
        );
        if (at === -1) continue;
        const nameMatch = /function\s+(\w+)/.exec(SPA.slice(at, at + 80));
        if (!nameMatch) continue;

        // The function body: up to the next top-level function.
        const next = SPA.indexOf('\n    function ', m.index);
        const nextAsync = SPA.indexOf('\n    async function ', m.index);
        const end = Math.min(next === -1 ? Infinity : next, nextAsync === -1 ? Infinity : nextAsync);
        out.push({ name: nameMatch[1], body: SPA.slice(at, end === Infinity ? at + 6000 : end) });
    }
    // One entry per function.
    return [...new Map(out.map(o => [o.name, o])).values()];
}

test('there are loading renderers to check', () => {
    const found = loadingRenderers();
    assert.ok(found.length >= 3,
        `only ${found.length} loading renderers found — the detector is not reading the page`);
});

test('every renderer that shows a spinner can also stop showing it', () => {
    /*
     * A `catch` that writes into the same host, or a guarded render. What must
     * not exist is a placeholder with no failure path: that is the state that
     * made three good plates look deleted.
     */
    const stuck = [];
    for (const r of loadingRenderers()) {
        /*
         * The LAST catch, not the first.
         *
         * Looking after the first `catch` finds the fetch's handler, and the
         * whole main render sits after that — so the check passed no matter
         * what the render's own handler did. Measured: a mutation replacing
         * the render's recovery with setStatus() still passed.
         *
         * The render is the last thing that can throw, so its handler is the
         * last one, and that is the one that has to put something in the host.
         */
        const lastCatch = r.body.lastIndexOf('catch');
        const recovers = lastCatch !== -1
            && /\.innerHTML\s*=/.test(r.body.slice(lastCatch));
        if (!recovers) stuck.push(r.name);
    }
    assert.deepStrictEqual(stuck, [],
        'these paint a loading placeholder and have no path that replaces it on failure, '
        + 'so a throw leaves the panel loading forever');
});

test('the location views renderer builds its title from something in scope', () => {
    /*
     * The specific fault, pinned. `r.location` was a leftover from the
     * character turnaround renderer, where `r` IS the response — here the
     * response was destructured into `views` and there was no `r` at all.
     *
     * Checked by reading what the template references against what the
     * function defines, because a source check for `openPlateViewer` passed
     * while the panel was dead.
     */
    const at = SPA.indexOf('async function renderLocationViews');
    assert.notStrictEqual(at, -1, 'the location views renderer is gone');
    const next = SPA.indexOf('\n    async function ', at + 10);
    const body = SPA.slice(at, next > at ? next : at + 6000);

    assert.ok(!/\br\.location\b/.test(body),
        'the renderer reads r.location, and there is no r in that scope — it throws mid-render');

    // Whatever it uses for the title must be declared in the function.
    // [\s\S]*? rather than [^)]* — a bounded class cannot cross the ')' in
    // esc(v.image_url), which is the same mistake that made an earlier SQL
    // check match nothing and pass.
    const titleArg = /openPlateViewer\([\s\S]{0,120}?\$\{jsAttr\((\w+)/.exec(body);
    assert.ok(titleArg, 'the view cards no longer open the plate viewer');
    const identifier = titleArg[1];
    assert.ok(new RegExp(`(const|let|var)\\s+${identifier}\\b`).test(body),
        `the viewer title uses "${identifier}", which is not declared in renderLocationViews — `
        + 'the template throws and the panel stays on Loading');
});
