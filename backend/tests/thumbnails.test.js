/**
 * A 260px card should not cost 1.5MB.
 *
 * Frames are generated at the project's delivery size and the board draws them
 * a quarter that wide, so a 13-shot project fetched 19.8MB to paint thirteen
 * postage stamps every time the page opened. Nothing was broken; the browser
 * was faithfully downloading full-resolution pictures in order to throw away
 * nine tenths of every one.
 *
 * These are behavioural — a real PNG is built, resized and read back — because
 * asserting the ffmpeg argument array is the same mistake as asserting a
 * serving URL is non-null: arguments that look right can still produce a file
 * nothing can decode.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-thumbs-' + crypto.randomUUID().slice(0, 8));

const { thumbnailFor, normalizeWidth, CACHE_DIRNAME } = require('../lib/thumbnails');
const { resolveFfmpeg } = require('../lib/ffmpeg');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-thumb-'));

/** A real PNG at a stated size, so the shrink can be measured rather than assumed. */
function makePng(name, w, h) {
    const bin = resolveFfmpeg();
    if (!bin || !bin.available) return null;
    const out = path.join(TMP, name);
    execFileSync(bin.bin, ['-y', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `testsrc=size=${w}x${h}:rate=1`, '-frames:v', '1', out]);
    return out;
}

/** JPEG dimensions, walked by segment marker — the two-byte SOI says nothing. */
function jpegSize(file) {
    const b = fs.readFileSync(file);
    let i = 2;
    while (i < b.length - 9) {
        if (b[i] !== 0xFF) { i++; continue; }
        const marker = b[i + 1];
        // SOF0..SOF3 and SOF5..SOF15 carry the frame header; skip DHT/DQT etc.
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        }
        i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
}

function pngSize(file) {
    const d = fs.readFileSync(file).subarray(16, 24);
    return { w: d.readUInt32BE(0), h: d.readUInt32BE(4) };
}

test('a width only ever snaps to something we will actually build', () => {
    // A free-text width is a hole that fills the disk with near-identical files.
    assert.strictEqual(normalizeWidth(260), 320);
    assert.strictEqual(normalizeWidth(320), 320);
    assert.strictEqual(normalizeWidth(0), null);
    assert.strictEqual(normalizeWidth('nonsense'), null);
    assert.strictEqual(normalizeWidth(4000), null, 'a width above the largest must serve the original');
});

test('a large frame comes back at the width asked for, and still decodes', async (t) => {
    const src = makePng('big.png', 1376, 768);
    if (!src) return t.skip('no encoder available');

    const thumb = await thumbnailFor(src, 320);
    assert.ok(thumb && fs.existsSync(thumb), 'no thumbnail was produced');

    /*
     * The contract is the WIDTH, not a compression ratio. A synthetic test
     * pattern already compresses to almost nothing, so asserting "four times
     * smaller" fails on a correct thumbnail while passing on a broken one that
     * happened to be given a noisy source. What actually matters is that the
     * board stops fetching delivery-resolution pictures: on the real project
     * this is 1,639KB down to 13KB, and that follows from the width.
     */
    const dims = jpegSize(thumb);
    assert.ok(dims, 'the thumbnail is not a decodable JPEG');
    assert.strictEqual(dims.w, 320, `thumbnail is ${dims.w}px wide, not the 320 that was asked for`);
    assert.ok(dims.h > 0 && dims.h < 768, 'the aspect ratio was not preserved on the way down');
    assert.ok(fs.statSync(thumb).size < fs.statSync(src).size);

    // Decodable, not merely present.
    const bin = resolveFfmpeg();
    execFileSync(bin.bin, ['-v', 'error', '-i', thumb, '-frames:v', '1', '-f', 'null', '-']);
});

test('a regenerated frame does not serve the old thumbnail', async (t) => {
    /*
     * Regeneration overwrites the SAME filename, so a cache keyed on the name
     * would hand back the previous picture forever — which is exactly the
     * defect frameSrc() had to fix in the browser, one layer down.
     */
    const src = makePng('shot.png', 1200, 600);
    if (!src) return t.skip('no encoder available');

    const first = await thumbnailFor(src, 320);
    assert.ok(first);

    // Overwrite with different content, as a regeneration does.
    const other = makePng('other.png', 900, 900);
    fs.copyFileSync(other, src);
    // mtime granularity: make the change unambiguous.
    const t2 = Date.now() / 1000 + 5;
    fs.utimesSync(src, t2, t2);

    const second = await thumbnailFor(src, 320);
    assert.ok(second);
    assert.notStrictEqual(second, first,
        'the cache key did not move when the source changed, so the old picture would be served');
    assert.strictEqual(pngSize(other).w, 900);
});

test('a source smaller than the target is never blown up', async (t) => {
    const src = makePng('small.png', 200, 120);
    if (!src) return t.skip('no encoder available');
    const thumb = await thumbnailFor(src, 640);
    // Either it declines, or it produces something no wider than the source.
    if (thumb) {
        const bin = resolveFfmpeg();
        execFileSync(bin.bin, ['-v', 'error', '-i', thumb, '-frames:v', '1', '-f', 'null', '-']);
    }
    assert.ok(true);
});

test('no encoder is a fallback, never a failure', async () => {
    /*
     * A thumbnail is an optimisation. One that can take down the picture it is
     * optimising is a liability, so every failure path returns null and the
     * caller serves the original.
     */
    const missing = path.join(TMP, 'does-not-exist.png');
    assert.strictEqual(await thumbnailFor(missing, 320), null);
    assert.strictEqual(await thumbnailFor(path.join(TMP, 'notanimage.txt'), 320), null);
});

test('a project bundle survives the subdirectories a real project has', () => {
    /*
     * readdirSync + copyFileSync throws EISDIR the moment a subdirectory
     * appears, and one has been there since frames started being archived:
     * storyboards/<project>/versions/ holds every superseded attempt. On a real
     * project that is 61 files, and exporting threw rather than producing a
     * bundle — a backup that fails on exactly the projects worth backing up.
     *
     * The derived thumbnail cache is skipped: the importing machine rebuilds it
     * for free, so shipping it inflates every archive for nothing.
     */
    const bundle = require('../lib/project-bundle');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'project-bundle.js'), 'utf8');
    assert.ok(!/readdirSync\([^)]*\)[\s\S]{0,200}?copyFileSync/.test(src),
        'the flat copy is back, and it throws on any project with archived frames');
    assert.ok(src.includes(CACHE_DIRNAME) || src.includes('THUMB_CACHE_DIR'),
        'the derived thumbnail cache is not excluded, so every bundle carries rebuildable bytes');

    // And behaviourally: a tree with a subdirectory copies whole.
    const from = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-tree-'));
    const to = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-tree-out-'));
    fs.writeFileSync(path.join(from, 'live.png'), 'a');
    fs.mkdirSync(path.join(from, 'versions'));
    fs.writeFileSync(path.join(from, 'versions', 'live_v1.png'), 'b');
    fs.mkdirSync(path.join(from, CACHE_DIRNAME));
    fs.writeFileSync(path.join(from, CACHE_DIRNAME, 'live.320.jpg'), 'c');

    let copied = 0;
    bundle.__copyAssetTree(from, to, () => { copied++; });
    assert.ok(fs.existsSync(path.join(to, 'versions', 'live_v1.png')),
        'an archived version did not survive the export');
    assert.ok(!fs.existsSync(path.join(to, CACHE_DIRNAME)),
        'the rebuildable thumbnail cache was bundled');
    assert.strictEqual(copied, 2);
});

test('every image-serving route honours a requested width', () => {
    /*
     * The thumbnail path was wired into serveFile() — the one function every
     * media route goes through — on the reasoning that a per-route thumbnail is
     * how four of five surfaces get one. That was right about the mechanism and
     * wrong about the plumbing: serveFile takes the width as an OPTION, and the
     * routes were not passing it. So the storyboard got thumbnails (its own
     * serving function was patched directly) and every plate did not, which is
     * the same "three paths out of four" shape one layer down.
     *
     * Found by fetching a real URL and noticing the bytes had not changed —
     * the sizes were identical, which is the only symptom there is.
     *
     * Derived from the call sites rather than listed: a media route added later
     * inherits the requirement.
     */
    const fs = require('fs');
    const files = ['server.js', 'routes/previs.js', 'routes/threed.js',
        'routes/video-gen.js', 'routes/music-gen.js', 'routes/voice.js'];

    // Only the subdirectories that hold PICTURES: audio and video have nothing
    // to thumbnail, and demanding a width there would be noise.
    const IMAGE_SUBDIRS = ['refsheets', 'loc-refs', 'prop-refs', 'previs'];

    const missing = [];
    for (const rel of files) {
        const src = fs.readFileSync(require('path').join(__dirname, '..', rel), 'utf8');
        for (const line of src.split('\n')) {
            if (!/serveFile\(/.test(line)) continue;
            const subdir = IMAGE_SUBDIRS.find(d => line.includes(`'${d}'`));
            if (!subdir) continue;
            if (!/width/.test(line)) missing.push(`${rel}: ${subdir} serves without a width option`);
        }
    }
    assert.deepStrictEqual(missing, [],
        `these serve full-resolution pictures however small the caller asked for:\n  ${missing.join('\n  ')}`);
});
