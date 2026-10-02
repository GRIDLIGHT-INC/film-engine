/**
 * A 48px avatar should not cost 824 kilobytes
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "Every once in a while when I load a project or an area the data takes time
 *  loading. This has been a repeating issue."
 *
 * It is not the API. Every endpoint answers in 1–12ms, including on the
 * largest project. It is the PICTURES: measured on the live install, the
 * reference plates total 77MB with individual files between 668KB and 1.2MB,
 * and a character card renders one at 48x48. The first visit to an area drags
 * full-resolution plates down to paint thumbnails; the second is instant
 * because the browser cached them, which is exactly why the symptom is
 * intermittent — `loadCharacters` measured 863ms cold and 4ms warm.
 *
 * The machinery already exists and is already documented: `file-storage.js`
 * serves a thumbnail whenever a width is asked for, cached under `.thumbs`,
 * and falls through to the original on any failure so it can never take down
 * the picture it is optimising. Nothing asked. Four thumbnails existed on the
 * whole install, all under `storyboards/`.
 *
 * The denominator is every `<img>` in the page pointed at served media, read
 * from the page rather than listed, so a twentieth site added later is covered
 * with nothing to remember.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const UI = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/**
 * Every <img> the page builds with a dynamic src.
 *
 * The first version of this scan required a literal `API_BASE` or `/film/` in
 * the src and found 19. There are 33: the character sheet's plate tiles go
 * through `csImg(...)`, so the origin is already inside the variable and the
 * scan could not see the very files that prompted this — the 824KB ones.
 */
function servedImageTags() {
    return [...UI.matchAll(/<img\b[^>]*\bsrc="([^"]*)"[^>]*>/g)]
        .filter(m => /\$\{|' \+/.test(m[1]))
        .map(m => m[0]);
}

test('the page has served images at all — the scan is not blind', () => {
    assert.ok(servedImageTags().length >= 30,
        `found ${servedImageTags().length} served <img> tags — the scan is not seeing the markup`);
});

test('every picture with real weight asks for a size', () => {
    /*
     * The contract is about WEIGHT, not about every tag. A site is exempt when
     * it is already serving something small, and each exemption is named with
     * its reason — an exemption matching on a pattern would quietly excuse the
     * next site that gets it wrong.
     *
     *   frameSrc(f, 640)      already takes a width; it is the pattern plateSrc
     *                         was built to mirror rather than duplicate
     *   thumbnail_path        the row already points at a generated thumbnail
     *   esc(thumb) / ${src}   the caller resolved a thumbnail before this point
     *   style-book media      author-supplied reference, served whole by design
     *   marketingImgSrc       posters are judged at full size, like a viewer
     *   openPlateViewer tiles the tile hands its own src to the full-size
     *                         viewer; thumbnailing it would thumbnail the viewer
     */
    const EXEMPT = [
        [/frameSrc\(/, 'frameSrc already takes a width'],
        [/thumbnail_path/, 'the row already points at a thumbnail'],
        [/esc\(thumb\)|\$\{src\}/, 'the caller already resolved a thumbnail'],
        [/style-book\/media/, 'author-supplied reference, served whole by design'],
        [/marketingImgSrc/, 'posters are judged at full size'],
        [/openPlateViewer/, 'the tile hands its own src to the full-size viewer'],
        // The production graph's drawer shows the SELECTED frame at the size it
        // is judged at, like the viewer; its node thumbnails ask for w=320.
        [/class="pg-dimg"/, 'the drawer is where a frame is judged, full size'],
        // The A/B wipe compares two versions of one frame: judging them is the
        // whole point, and a thumbnail would compare two blurs.
        [/pg-wipe-top/, 'an A/B wipe compares frames at the size they are judged'],
        [/src\(m\.still\.path\)/, 'the playback monitor plays the frame the cut holds, like the Playback page'],
        // Rendered in the page from the world itself: a 320x180 JPEG data URI
        // drawn by SPLAT.thumb's renderer, never a file fetched from the server.
        [/EXPLORE\.thumbs\[/, 'a 320x180 JPEG the page renders itself — nothing is downloaded'],
        // Previs's Board view is the frame filling the director's monitor, where
        // the shot is judged against the set; a thumbnail would judge a blur.
        [/class="pv-board-img"/, 'the Previs Board view is where a frame is judged, full size'],
    ];
    const offenders = [];
    for (const tag of servedImageTags()) {
        // pgThumb(url, w) asks for a width: it joins ?w= onto the URL itself.
        if (/[?&]w=|plateSrc\(|pgThumb\(/.test(tag)) continue;
        if (EXEMPT.some(([re]) => re.test(tag))) continue;
        offenders.push(tag.replace(/\s+/g, ' ').slice(0, 84));
    }
    assert.deepStrictEqual(offenders, [],
        `these ${offenders.length} sites download a full-resolution picture to paint a card:\n  `
        + offenders.join('\n  ') + '\n');
});

test('opening a picture full size still opens the FULL picture', () => {
    /*
     * The trap this change creates if it is done carelessly. A tile passes its
     * OWN src to the viewer — `<img src="${url}" onclick="openPlateViewer(url)">`
     * — so thumbnailing the tile would hand the viewer a thumbnail, and the
     * surface whose entire job is judging a plate at full size would be judging
     * a 480px JPEG of it.
     *
     * CLAUDE.md already states the rule this protects: "A plate you cannot see
     * full size is one you cannot judge."
     */
    const handoffs = [...UI.matchAll(/openPlateViewer\(([^)]*)\)/g)].map(m => m[1]);
    assert.ok(handoffs.length >= 3,
        `found ${handoffs.length} openPlateViewer calls — the scan is not seeing them`);
    const thumbed = handoffs.filter(a => /\bw=|cardImg\(/.test(a));
    assert.deepStrictEqual(thumbed, [],
        'these hand the full-size viewer a THUMBNAIL:\n  ' + thumbed.join('\n  '));
});
