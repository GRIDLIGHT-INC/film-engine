const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lavfiSource } = require('./helpers');
const { execFileSync } = require('child_process');

const rp = require('../lib/review-proxy');
const { resolveFfmpeg } = require('../lib/ffmpeg');

const FF = resolveFfmpeg();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proxy-'));

/** A real clip, because asserting on an argument array proves nothing about
 *  whether the file that comes out is playable or the right size. */
function makeClip(name, seconds, size) {
    const out = path.join(TMP, name);
    execFileSync(FF.bin, ['-nostdin', 
        '-y', '-loglevel', 'error',
        ...lavfiSource(`testsrc=size=${size}:rate=24:duration=${seconds}`, `sine=frequency=440:duration=${seconds}`),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', out,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return out;
}

test('review proxy', { skip: FF.available ? false : 'no encoder on this machine' }, async (t) => {

    await t.test('stillFor produces a decodable PNG', () => {
        const clip = makeClip('still.mp4', 3, '320x240');
        const r = rp.stillFor(clip);
        assert.ok(r.ok, `no still: ${r.reason}`);
        const bytes = fs.readFileSync(r.path);
        assert.ok(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
            'the still is not a PNG whatever its extension says');
        assert.ok(bytes.length > 100, 'the still is empty');
    });

    await t.test('stillFor survives a clip shorter than its seek point', () => {
        // The default seek is one second in; a clip shorter than that yields no
        // frame, and reporting it as unreadable would be wrong.
        const clip = makeClip('tiny.mp4', 0.4, '160x120');
        const r = rp.stillFor(clip);
        assert.ok(r.ok, `a sub-second clip produced no still: ${r.reason}`);
    });

    /*
     * THE CONTRACT: null rather than something oversized. A caller handed a
     * too-big file discovers it at the transfer, where nothing useful can be
     * done; a caller handed null can say why.
     */
    await t.test('proxyFor returns null rather than a file over maxBytes', () => {
        const clip = makeClip('big.mp4', 6, '1920x1080');
        const impossible = 900;                       // no 720p second fits here
        const r = rp.proxyFor(clip, { maxBytes: impossible, alwaysReencode: true });
        assert.strictEqual(r.ok, false, 'an impossible ceiling produced a proxy');
        assert.strictEqual(r.path, null, 'a refused proxy still handed back a path');
        assert.match(r.reason, /over the 900|still comes to/,
            'the refusal does not say what it could not fit');
        // And nothing oversized is left cached for a later call to trust.
        const cached = rp.cachePathFor(clip, `proxy-${impossible}.mp4`);
        assert.ok(!fs.existsSync(cached), 'an oversized proxy was left in the cache');
    });

    await t.test('proxyFor produces a proxy under a workable ceiling', () => {
        const clip = makeClip('work.mp4', 4, '1920x1080');
        const cap = 400 * 1024;
        const r = rp.proxyFor(clip, { maxBytes: cap, alwaysReencode: true });
        assert.ok(r.ok, `no proxy: ${r.reason}`);
        assert.ok(r.bytes <= cap, `the proxy is ${r.bytes} bytes, over the ${cap} cap`);
    });

    await t.test('a second call for an unchanged source does not re-encode', () => {
        const clip = makeClip('cache.mp4', 3, '1280x720');
        const cap = 400 * 1024;
        const first = rp.proxyFor(clip, { maxBytes: cap, alwaysReencode: true });
        assert.ok(first.ok && first.cached === false, 'the first call was already cached');
        const mtime = fs.statSync(first.path).mtimeMs;

        const second = rp.proxyFor(clip, { maxBytes: cap, alwaysReencode: true });
        assert.ok(second.cached, 'the second call re-encoded an unchanged source');
        assert.strictEqual(fs.statSync(second.path).mtimeMs, mtime,
            'the cached proxy was rewritten');
    });

    /*
     * Identity is size AND mtime, never the path. A regenerated clip is written
     * to the same filename and overwrites — a path-keyed cache would serve the
     * previous take's proxy for ever, which is the plate-cache bug one media
     * type over.
     */
    await t.test('a changed source invalidates the cache', () => {
        const clip = path.join(TMP, 'same-name.mp4');
        fs.copyFileSync(makeClip('src-a.mp4', 2, '640x480'), clip);
        const keyA = rp.sourceKey(clip);

        fs.copyFileSync(makeClip('src-b.mp4', 5, '640x480'), clip);
        const keyB = rp.sourceKey(clip);
        assert.notStrictEqual(keyA, keyB,
            'the same filename with different contents produced the same cache key');
    });

    await t.test('a source already under the ceiling is handed back, not re-encoded', () => {
        const clip = makeClip('small.mp4', 1, '160x120');
        const r = rp.proxyFor(clip, { maxBytes: 50 * 1024 * 1024 });
        assert.ok(r.ok);
        assert.strictEqual(r.path, clip, 'a file that already fits was needlessly re-encoded');
        assert.strictEqual(r.reencoded, false);
    });
});

/* maxBytes is an ARGUMENT. This module must carry no destination's limit. */
test('review-proxy names no particular transport ceiling', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'review-proxy.js'), 'utf8');
    const r = rp.proxyFor(__filename, {});
    assert.strictEqual(r.ok, false, 'proxyFor accepted a call with no maxBytes');
    assert.match(r.reason, /maxBytes/, 'the refusal does not name the missing argument');
    // 8 MB, 10 MB, 25 MB, 50 MB — the ceilings of particular services.
    assert.ok(!/\b(8|10|25|50|100)\s*\*\s*1024\s*\*\s*1024\b/.test(src),
        'review-proxy hardcodes a transport ceiling; maxBytes is the caller\'s to name');
});
