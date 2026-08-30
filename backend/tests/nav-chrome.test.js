/**
 * Global actions live in the top bar, and nothing is orphaned by moving them.
 *
 * Five buttons — Home, Jobs, Notes, Guide, Setup — held a 64px column down the
 * full height of the screen, on every page, permanently. They are global
 * actions, and a global action belongs beside the other global furniture rather
 * than in a column of its own.
 *
 * The "Search anything" pill went with it, because it never searched anything:
 * its only behaviour was to open the glossary. Which is exactly the trap —
 * removing it orphaned the glossary, since the sidebar that also links it is
 * display:none in this layout. A removal is only finished when everything that
 * was reachable still is.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

test('the vertical rail no longer reserves a column', () => {
    assert.match(html, /--fe-rail:0px/, 'the rail still holds width across every page');
    // Read as a variable, not edited in five places: panel, main and status bar
    // all offset by it.
    const readers = (html.match(/var\(--fe-rail\)/g) || []).length;
    assert.ok(readers >= 3, `only ${readers} layout rules read the rail width; the rest are hand-edited`);
});

test('the rail buttons are in the top bar, not the body', () => {
    assert.match(html, /top\.appendChild\(rail\)/, 'the rail is still appended to the body');
    assert.ok(!/document\.body\.appendChild\(rail\)/.test(html));
});

/** The rail array, whole, however many entries it grows to carry. */
function railSource(html) {
    const at = html.indexOf('var RAIL = [');
    assert.ok(at > 0, 'the rail is gone');
    const end = html.indexOf('];', at);
    assert.ok(end > at, 'the rail array does not close');
    return html.slice(at, end);
}

test('the search that was not a search is gone', () => {
    // The element and its styles, not the comment explaining why they went.
    assert.ok(!/class="fe-search"|\.fe-search/.test(html), 'the pill or its styles survive');
    assert.ok(!/id="feSearch"|#feSearch/.test(html), 'the pill is still built or wired');
});

test('everything the removed pill reached is still reachable', () => {
    // Its only behaviour was opening the glossary, and the sidebar link to the
    // glossary is display:none in this layout.
    /*
     * Bounded by the ARRAY, not by a character count. A fixed 1400-character
     * window stopped containing the glossary the moment a brand entry was added
     * above it — reading here as the glossary having lost its only entrance,
     * which is the opposite of what happened.
     */
    const rail = railSource(html);
    assert.match(rail, /id:'glossary'/, 'the glossary has no entrance left');
    assert.match(html, /r\.id === 'glossary'/, 'the glossary button is wired to nothing');
});

test('every rail button reaches something', () => {
    // A button wired to nothing looks identical to a working one until clicked.
    /*
     * Bounded by the ARRAY, not by a character count. A fixed 1400-character
     * window stopped containing the glossary the moment a brand entry was added
     * above it — reading here as the glossary having lost its only entrance,
     * which is the opposite of what happened.
     */
    const rail = railSource(html);
    const ids = [...rail.matchAll(/id:'([a-z]+)'/g)].map(m => m[1]);
    assert.ok(ids.length >= 5, `only ${ids.length} rail buttons found`);
    for (const id of ids) {
        const handled = new RegExp(`r\\.id === '${id}'`).test(html);
        const isPage = new RegExp(`data-page="${id}"`).test(html);
        assert.ok(handled || isPage, `${id} is neither a page nor handled explicitly`);
    }
});

test('the project list is reachable from the current layout', () => {
    /*
     * There was no way to switch projects at all. The list is a real page and
     * both routes to it — the sidebar's "All Projects" button and the sidebar
     * project list — are display:none in this layout. Identical to the
     * glossary, which is the reason that one is on the rail: a removal is only
     * finished when everything that was reachable still is.
     *
     * Asserted on the BRAND's handler rather than on the existence of the page,
     * because the page existed the whole time.
     */
    const html = require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

    const brand = html.slice(html.indexOf("querySelector('#feBrand')"));
    const handler = brand.slice(0, brand.indexOf('PHASES.forEach'));
    assert.ok(/backToProjectList|navBtn\('projects'\)|navigateTo\('projects'\)/.test(handler),
        'the project name does not lead to the project list, and nothing else in this layout does');
    assert.ok(/brand\.title\s*=/.test(handler),
        'the only way to switch projects carries no label, so nobody would find it');
});

test('the chrome can actually read the app state it renders from', () => {
    /*
     * The chrome lives in a different <script> from the app, and `const` is not
     * a window property — so `window.state` was undefined and three things had
     * been quietly dead for as long as this layout has existed:
     *
     *   - the top bar never showed the current project's name (it read
     *     "Film Engine" on every project),
     *   - progress() read an empty object, so every phase fraction in the nav
     *     panel rendered nothing,
     *   - and the project-name click could not tell whether a project was open.
     *
     * Every one of those failures is silent. A bar that says "Film Engine" and
     * a fraction that shows nothing both look like design decisions, which is
     * why this went unnoticed rather than being reported.
     */
    const html = require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

    assert.ok(/window\.state\s*=\s*state\s*;/.test(html),
        'the app state is not exported to window, so every cross-script reader of '
        + 'window.state silently sees undefined');

    // And the readers really are in another script block — which is the whole
    // reason the export is needed rather than a stylistic choice.
    const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    const declaring = scripts.findIndex(s => /window\.state\s*=\s*state\s*;/.test(s));
    const reading = scripts.findIndex((s, i) => i !== declaring && /window\.state/.test(s));
    assert.ok(declaring >= 0 && reading >= 0 && reading !== declaring,
        'window.state is read and written in one script — the export may be unnecessary, '
        + 'or a reader has moved and this check no longer proves anything');
});
