'use strict';

/**
 * -- A report nobody waits six seconds for ----------------------------------
 *
 * Measured on the real project: the staleness report took SIX SECONDS while
 * every other call on the page took 2-10ms. The cause is a consequence of a
 * decision that is otherwise right — "the payload IS the fingerprint" — because
 * building an image payload INLINES every reference plate as a base64 data URI.
 *
 * Fingerprinting 76 keyframes therefore read 19 distinct files 314 times and
 * moved 487MB off disk to produce one JSON report. `MAYA_front.png` alone was
 * read 61 times, and each read was followed by base64-encoding a megabyte.
 *
 * The fix is a CACHE, not a different formula. Weakening the fingerprint to
 * make it cheap would mark every existing artefact stale — the "warning you
 * cannot act on" this codebase has already paid for once — so the same bytes
 * produce the same hash and only the reading is avoided.
 */

process.env.FILM_DATA_DIR = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'fe-stalecost-'));

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { toDataUri, clearDataUriCache } = require('../lib/reference-images');

/** A real PNG on disk, because the cache keys on what the filesystem says. */
function png(dir, name, byte) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(4096, byte === undefined ? 1 : byte),
    ]));
    return p;
}

test('the same plate is read once, not once per shot that references it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-uri-'));
    const plate = png(dir, 'MAYA_front.png');
    clearDataUriCache();

    let reads = 0;
    const real = fs.readFileSync;
    fs.readFileSync = function (p, ...a) {
        if (typeof p === 'string' && p.endsWith('MAYA_front.png')) reads++;
        return real.call(fs, p, ...a);
    };
    try {
        const first = toDataUri(plate);
        for (let i = 0; i < 60; i++) {
            assert.equal(toDataUri(plate), first, 'the cached value differs from the first read');
        }
    } finally { fs.readFileSync = real; }

    assert.equal(reads, 1,
        `one plate referenced by 61 shots was read ${reads} times — on the real project that was `
        + '61 reads of one file and 487MB of disk for a single report');
});

test('a regenerated plate is NOT served from the cache', () => {
    /*
     * The whole hazard of caching here: a plate is written to the SAME per-view
     * filename and overwrites, so a path is not an identity. Cached on the path
     * alone, a regenerated plate would fingerprint as its old self and the
     * staleness report would go quietly wrong — which is worse than being slow,
     * because it is the report that says whether anything is out of date.
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-uri2-'));
    const plate = png(dir, 'plate.png', 1);
    clearDataUriCache();

    const before = toDataUri(plate);
    assert.ok(before, 'the plate did not encode at all');

    // Overwrite with different bytes AND a different size, which is what a
    // regeneration does.
    fs.writeFileSync(plate, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(8192, 2),
    ]));
    const after = toDataUri(plate);
    assert.notEqual(after, before,
        'a regenerated plate was served from the cache — its fingerprint would be its old self');
});

test('the cache changes nothing about the value, only the reading', () => {
    // Byte-identical, because a different value here is a different fingerprint
    // and every artefact in every project would read as stale.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-uri3-'));
    const plate = png(dir, 'p.png');
    clearDataUriCache();
    const cached = toDataUri(plate);
    clearDataUriCache();
    const uncached = toDataUri(plate);
    assert.equal(cached, uncached, 'the cached data URI is not the one an uncached read produces');
});

test('the cache is bounded, so a long-lived server does not hold every plate', () => {
    /*
     * A server runs for days. An unbounded cache of megabyte data URIs is a
     * memory leak that looks like a performance fix — and the reference set
     * grows with the project, so it would be worst on exactly the productions
     * that need it most.
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-uri4-'));
    clearDataUriCache();
    const paths = [];
    for (let i = 0; i < 40; i++) paths.push(png(dir, `p${i}.png`, i % 250));
    for (const p of paths) toDataUri(p);

    const { dataUriCacheSize } = require('../lib/reference-images');
    assert.ok(typeof dataUriCacheSize === 'function', 'the cache does not report its own size');
    assert.ok(dataUriCacheSize() < paths.length,
        `the cache holds ${dataUriCacheSize()} of ${paths.length} entries — it is unbounded`);
});

test('the board paints its frames before it waits for any report', () => {
    /*
     * Reported as "the server sometimes takes a while on showing items", and it
     * was not the server: `loadStoryboard` AWAITED the drift report and the
     * impact report before writing a single frame into the grid. On the real
     * project those cost about a second together, and the staleness report they
     * are built on costs six — so the board sat empty while the engine worked
     * out what was out of date.
     *
     * The file's own comment already said the right thing — "the board still
     * renders; the warning is additive" — and the awaits made it untrue. A
     * warning is additive exactly when it arrives LATER and changes nothing
     * about whether the pictures appear.
     */
    const fs_ = require('fs');
    const page = fs_.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const at = page.indexOf('async function loadStoryboard()');
    assert.ok(at > 0, 'loadStoryboard is gone');
    const body = page.slice(at, page.indexOf('\n    async function ', at + 10));

    const paintAt = body.indexOf('grid.innerHTML =');
    assert.ok(paintAt > 0, 'loadStoryboard never writes to the grid');

    for (const report of ['loadScreenplayDrift', 'loadImpact']) {
        const awaited = new RegExp(`await\\s+${report}\\s*\\(`).exec(body);
        if (!awaited) continue;
        assert.ok(awaited.index > paintAt,
            `loadStoryboard awaits ${report}() BEFORE painting the grid — the board sits empty `
            + 'while a report that only adds a warning is computed');
    }

    /*
     * And the banners still arrive: additive means LATER, not never.
     *
     * The HOST moved out of the grid and into the static markup -- as a grid
     * child an empty banner div took the first cell and pushed the top row of
     * frames one column across. So loadStoryboard no longer names the element;
     * what it must still do is kick off the load, un-awaited.
     */
    assert.match(body, /loadBoardBanners\s*\(/,
        'the board never starts the banner load, so a drift or impact warning never arrives');
    assert.ok(!/await\s+loadBoardBanners/.test(body),
        'loadStoryboard AWAITS the banners, which is what made the grid sit empty for six '
        + 'seconds on a real project');
    assert.match(page, /id="boardBanners"/,
        'there is no #boardBanners host anywhere, so the banners have nowhere to land');
    const filler = page.indexOf('async function loadBoardBanners');
    assert.ok(filler > 0, 'nothing fills the banner strip after the frames are painted');
    const fill = page.slice(filler, page.indexOf('\n    /**', filler + 10));
    assert.ok(/screenplayDriftBanner\(\)/.test(fill) && /impactBanner\(\)/.test(fill),
        'the banners are never rendered at all');

    /*
     * And the PER-FRAME marks are repainted with them. A banner saying six
     * shots are behind while no frame carries a mark is a warning with nothing
     * to point at — which is the state the tag exists to prevent, and exactly
     * what deferring the reports would cause if the tiles were never revisited.
     */
    assert.ok(/data-facets=/.test(body), 'the frame tiles have no target for a repainted mark');
    assert.ok(/storyboardFacetTags\(f\)/.test(fill),
        'the per-frame drift and impact marks are never repainted, so the banner points at nothing');
});
