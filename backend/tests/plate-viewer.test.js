/**
 * A plate you cannot see full size is a plate you cannot judge.
 *
 * "If we click on a location, character or prop I'd like to see the full
 * picture, like the storyboard."
 *
 * Every plate in the app was rendered at the width of whatever box it sat in —
 * a 48px avatar on a character card, a 120px banner on a location, a ~340px
 * column in the detail panel. A reference plate is the picture that conditions
 * every frame its subject appears in, and it was never viewable at the size it
 * was generated at. The storyboard has had a full-screen frame viewer since it
 * shipped; the plates had nothing.
 *
 * SET-BASED over the surfaces that render a plate, because the failure is
 * partial by nature: making the detail panel clickable and leaving the
 * turnaround views un-clickable is exactly the half-fix that reads as done.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/**
 * Every place the SPA renders a subject's plate.
 *
 * Named with the marker that identifies each site, because these are template
 * literals assembled at runtime — there is no registry to derive from, and a
 * bare `<img>` count would sweep in storyboard frames, mood-board pins and
 * marketing art, which are not plates and have their own viewers.
 */
const PLATE_SURFACES = [
    { id: 'entity detail panel', marker: "'<p class=text-muted>The plate file is missing.</p>'" },
    { id: 'character turnaround', marker: 'function characterViewsHtml' },
    { id: 'location views', marker: "getElementById('locationViewsSection')" },
    { id: 'character card', marker: 'c.reference_image_url' },
    { id: 'location card', marker: 'l.reference_image_url' },
    { id: 'prop card', marker: 'p.reference_image_url' },
];

/** The region of source a surface owns, for checking what it renders. */
function regionFor(surface) {
    const at = SPA.indexOf(surface.marker);
    assert.notStrictEqual(at, -1, `${surface.id}: its marker is gone — the surface was renamed`);
    return SPA.slice(Math.max(0, at - 900), at + 1200);
}

test('there is one plate viewer, not one per surface', () => {
    /*
     * One opener, because two is how the board and the viewer came to disagree
     * about their own markup tools, and how the grid and the full-screen
     * viewer came to normalise coordinates differently.
     */
    assert.match(SPA, /function openPlateViewer/, 'no plate viewer exists');
    assert.match(SPA, /id="plateViewerModal"/, 'the viewer has no panel to render into');

    const definitions = (SPA.match(/function openPlateViewer/g) || []).length;
    assert.strictEqual(definitions, 1, `openPlateViewer is defined ${definitions} times`);
});

test('every surface that shows a plate can open it full size', () => {
    const unclickable = PLATE_SURFACES.filter(s => !regionFor(s).includes('openPlateViewer'));
    assert.deepStrictEqual(unclickable.map(s => s.id), [],
        'these render a plate with no way to see it at full size');
});

test('the viewer shows the picture whole, not cropped to a box', () => {
    /*
     * `object-fit: cover` is right for a card thumbnail and wrong for a
     * viewer: it fills the frame by cutting the picture, which on a plate hides
     * exactly the edges a director is checking. The storyboard viewer uses
     * `contain` for the same reason.
     */
    const at = SPA.indexOf('id="plateViewerModal"');
    const modal = SPA.slice(at, at + 1400);
    assert.match(modal, /object-fit:\s*contain/,
        'the plate viewer crops the picture instead of showing all of it');
});

test('opening the viewer does not also trigger the card underneath', () => {
    /*
     * A card is itself clickable — it opens the inspector. Without
     * stopPropagation, clicking the picture opens the viewer AND the panel
     * behind it, and the one you asked for is the one underneath.
     */
    for (const surface of PLATE_SURFACES.filter(s => /card$/.test(s.id))) {
        const region = regionFor(surface);
        const call = region.slice(region.indexOf('openPlateViewer') - 220, region.indexOf('openPlateViewer'));
        assert.match(call, /stopPropagation/,
            `${surface.id}: clicking the plate also fires the card's own click`);
    }
});

test('the viewer is told what it is showing', () => {
    // A full-screen picture with no label is one you cannot place — which view
    // of which subject is exactly what a turnaround makes ambiguous.
    const at = SPA.indexOf('function openPlateViewer');
    const fn = SPA.slice(at, at + 700);
    assert.match(fn, /title|label|caption/i, 'openPlateViewer takes no title');
    assert.match(SPA, /id="plateViewerTitle"/, 'the viewer has nowhere to show what it is showing');
});

test('the click handlers are well-formed JavaScript, not truncated', () => {
    /*
     * THE FAILURE THIS EXISTS FOR.
     *
     * The first version built its title with `JSON.stringify`, which emits
     * DOUBLE quotes — and inside onclick="…" a double quote ends the
     * attribute. The browser kept `openPlateViewer('…', ` and silently
     * discarded the rest, so every plate click did nothing while the card's
     * own handler ran instead.
     *
     * Every source check passed, because all the text is present in the
     * template. Only the RENDERED attribute was broken. So this parses what
     * would actually be emitted rather than looking for the words.
     */
    const calls = [...SPA.matchAll(/openPlateViewer\([^\n]*/g)].map(m => m[0]);
    assert.ok(calls.length >= 6, `only ${calls.length} plate-viewer calls found`);

    const malformed = [];
    for (const call of calls) {
        if (call.startsWith('openPlateViewer(') && /^openPlateViewer\(src/.test(call)) continue; // the definition
        // A title argument built with JSON.stringify cannot survive a
        // double-quoted attribute.
        if (/JSON\.stringify/.test(call)) malformed.push(`JSON.stringify in: ${call.slice(0, 90)}`);
    }
    assert.deepStrictEqual(malformed, [],
        'these emit double quotes into a double-quoted attribute, truncating the handler');

    // And the helper that makes it safe exists and is used.
    assert.match(SPA, /function jsAttr/, 'no attribute-safe string helper');
});

test('jsAttr produces something that survives an HTML attribute', () => {
    // Executed, not read: the escaping is the whole point and a regex over its
    // source proves nothing.
    const src = SPA.slice(SPA.indexOf('function jsAttr'), SPA.indexOf('function jsAttr') + 600);
    const body = src.slice(0, src.lastIndexOf('}') + 1);
    // eslint-disable-next-line no-new-func
    const jsAttr = new Function(`${body}; return jsAttr;`)();

    for (const [input, mustNotContain] of [["MAYA", '"'], ["Ray's plate", '"'], ['a "quoted" name', '"']]) {
        const out = jsAttr(input);
        assert.ok(!out.includes(mustNotContain),
            `jsAttr(${JSON.stringify(input)}) = ${out} — a double quote would end the attribute`);
        assert.ok(out.startsWith("'") && out.endsWith("'"), `jsAttr must return a quoted literal: ${out}`);
    }
    // An apostrophe must be escaped, not left to close the literal early.
    assert.match(jsAttr("Ray's plate"), /\\'/, "an apostrophe closes the string literal early");
});
