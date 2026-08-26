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

test('the search that was not a search is gone', () => {
    // The element and its styles, not the comment explaining why they went.
    assert.ok(!/class="fe-search"|\.fe-search/.test(html), 'the pill or its styles survive');
    assert.ok(!/id="feSearch"|#feSearch/.test(html), 'the pill is still built or wired');
});

test('everything the removed pill reached is still reachable', () => {
    // Its only behaviour was opening the glossary, and the sidebar link to the
    // glossary is display:none in this layout.
    const rail = html.slice(html.indexOf('var RAIL = ['), html.indexOf('var RAIL = [') + 1400);
    assert.match(rail, /id:'glossary'/, 'the glossary has no entrance left');
    assert.match(html, /r\.id === 'glossary'/, 'the glossary button is wired to nothing');
});

test('every rail button reaches something', () => {
    // A button wired to nothing looks identical to a working one until clicked.
    const rail = html.slice(html.indexOf('var RAIL = ['), html.indexOf('var RAIL = [') + 1400);
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
