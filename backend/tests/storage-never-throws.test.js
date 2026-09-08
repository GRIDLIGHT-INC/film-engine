/**
 * A THROWING localStorage MUST NOT TAKE THE PAGE WITH IT.
 *
 * `let API_BASE = localStorage.getItem('film_api_url') || DEFAULT_API_BASE;`
 * sat at the TOP LEVEL of the script, unguarded. localStorage throws — not
 * returns null, THROWS — on an opaque or restricted origin, and a WKWebView
 * custom scheme can be one. When it did, the whole script died on that line:
 * every function after it was never defined, so no API call was ever made and
 * every `onclick` in the markup named a function that did not exist.
 *
 * The symptom is the worst kind: the app looks like it loaded. The shell
 * paints, the menu is drawn, and nothing responds — indistinguishable from a
 * dead server, and it sends you looking at the network.
 *
 * THIS FILE'S OWN CODEBASE ALREADY KNEW. The artifact guidance says it in as
 * many words: "in some contexts the accessor itself throws — so wrap every
 * read and write in try/catch and render the page correctly with no stored
 * value." Seven sites did not.
 *
 * SET-BASED over every localStorage access in the page, because the failure is
 * partial by nature: guarding six of seven leaves one line that can still kill
 * the app, and it will be the one nobody tested on.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const LINES = UI.split('\n');

/** Every line that touches web storage, with its number. */
function storageSites() {
    return LINES.map((line, i) => ({ n: i + 1, line }))
        .filter(({ line }) => /\b(localStorage|sessionStorage)\s*\./.test(line))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));   // prose, not code
}

/**
 * Is this access protected?
 *
 * Either it is lexically inside a try, or it goes through the shared helper —
 * which is the better answer, because a helper cannot be forgotten the way a
 * try can.
 */
function guarded(site, index) {
    if (/\bfeStore\b/.test(site.line)) return true;
    // The helper's own body IS the guard — it runs inside its `ok()` wrapper.
    if (/\bok\(\s*\(\)\s*=>/.test(site.line)) return true;
    // A try and its catch on ONE line is guarded; counting opens against
    // closes over a window reads that as balanced and calls it bare.
    if (/try\s*\{[^}]*localStorage/.test(site.line)) return true;
    const before = LINES.slice(Math.max(0, index - 6), index + 1).join('\n');
    const opens = (before.match(/try\s*\{/g) || []).length;
    const closes = (before.match(/\}\s*catch/g) || []).length;
    return opens > closes;
}

test('the scan finds the storage sites at all', () => {
    const sites = storageSites();
    assert.ok(sites.length >= 8,
        `only ${sites.length} storage accesses found — the scan is broken, and one that finds too `
        + 'few reports the gap as closed');
});

test('EVERY storage access is protected — one that throws kills the whole page', () => {
    const bare = [];
    for (const site of storageSites()) {
        if (!guarded(site, site.n - 1)) bare.push(`${site.n}: ${site.line.trim().slice(0, 90)}`);
    }
    assert.deepStrictEqual(bare, [],
        'these can throw and take every function defined after them with it:\n  ' + bare.join('\n  '));
});

test('the API base does NOT depend on storage working at all', () => {
    /*
     * The one that mattered. Even guarded, reading the engine's address from
     * storage means a phone that cannot store anything has no address — so the
     * app injects it as a plain global too, and that is read FIRST. A channel
     * that cannot fail beats a channel that fails quietly.
     */
    /*
     * COMMENTS STRIPPED. The comment explaining the bug quotes the old line, so
     * indexOf found the prose rather than the declaration — the sixth comment
     * false positive in this run of work. Match the thing, not a description.
     */
    const CODE = LINES.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const at = CODE.indexOf('let API_BASE');
    assert.ok(at > -1, 'API_BASE is gone; re-derive this test');
    // The whole statement, which spans two lines.
    const decl = CODE.slice(at, CODE.indexOf(';', at) + 1);
    assert.match(decl, /__filmEngineApiBase|apiBaseFromHost/,
        'API_BASE is read only from storage, so a device that cannot store has no engine address');
    assert.ok(!/^\s*let API_BASE = localStorage/.test(decl),
        'API_BASE still reads localStorage first and unguarded');
});

test('the app injects the address by a route that cannot throw', () => {
    const cv = fs.readFileSync(path.join(ROOT, 'ios', 'FilmEngine', 'ContentView.swift'), 'utf8');
    assert.match(cv, /__filmEngineApiBase/,
        'the app sets only localStorage, which is exactly the thing that may be unavailable');
    // And it must still set the stored copy, so a later web visit keeps working.
    assert.match(cv, /film_api_url/,
        'the app no longer stores the address, so opening the page in a browser forgets it');
});

test('the page survives storage being hostile, not merely absent', () => {
    /*
     * Executed, because the whole point is behaviour under a throw. A stub that
     * returns null is the EASY case; the case that broke the app is an accessor
     * that raises.
     */
    const at = UI.indexOf('const feStore');
    assert.ok(at > -1, 'there is no shared storage helper');
    /*
     * To the STATEMENT's end, not the first balanced brace. feStore is an IIFE
     * — `const feStore = (() => { ... })();` — so stopping at the arrow body's
     * closing brace yields `const feStore = (() => { ... }`, which parses into
     * something with no .get on it and reports the helper as broken.
     */
    let depth = 0, end = -1;
    for (let i = at; i < UI.length; i++) {
        const c = UI[i];
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        else if (c === ';' && depth === 0) { end = i + 1; break; }
    }
    assert.ok(end > -1, 'the feStore declaration does not terminate');
    const src = UI.slice(at, end);

    const hostile = `const localStorage = new Proxy({}, {
        get() { throw new Error('The operation is insecure.'); },
        set() { throw new Error('The operation is insecure.'); } });`;
    const store = new Function(`${hostile}\n${src}\nreturn feStore;`)();

    assert.strictEqual(store.get('anything'), null,
        'reading through the helper throws when storage does');
    assert.doesNotThrow(() => store.set('k', 'v'), 'writing through the helper throws');
    assert.doesNotThrow(() => store.remove('k'), 'removing through the helper throws');
});
