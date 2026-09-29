/**
 * A PLATE TOO BIG TO SEND USED TO TRAVEL AS NOTHING AT ALL.
 *
 * `toDataUri` refused anything past MAX_INLINE_BYTES and `selectReferences`
 * treats a null uri as an unreadable file and skips it — "skip, don't fail".
 * That pairing is only safe while oversize is rare. It is not: a 2K location
 * plate out of a current generator is 7-10MB, so on a real project EVERY
 * location plate was silently dropped. Nothing errored, the prompt read
 * perfectly, and the street was rebuilt from prose in every frame — which is
 * the precise failure reference images exist to prevent, arriving with no
 * symptom that points at it.
 *
 * So the ceiling is now a resize instruction rather than a refusal, and these
 * tests pin the three things that has to keep true:
 *
 *   - an oversize picture comes back as a data URI that FITS,
 *   - the identity cache still keys on the SOURCE, so a regenerated plate at
 *     the same filename is not served as its predecessor,
 *   - and nothing here can throw, because the whole call sits behind a
 *     `try { } catch (_) { return null; }` whose job is to never take down a
 *     generation over a picture.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ri = require('../lib/reference-images');
const { resolveFfmpeg } = require('../lib/ffmpeg');

const HAVE_FFMPEG = (() => {
    try { const f = resolveFfmpeg(); return !!(f && f.available && f.bin); } catch (_) { return false; }
})();

/**
 * A PNG big enough to be refused: noise, because noise does not compress.
 *
 * `variant` changes the picture, not just the file. ffmpeg's random() is seeded
 * deterministically, so two "different" noise frames come out byte-identical —
 * which would make the regeneration test assert nothing at all.
 */
function makeOversizePng(dir, variant = 0) {
    const file = path.join(dir, 'location_BIG.png');
    const f = resolveFfmpeg();
    execFileSync(f.bin, [
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'nullsrc=s=3168x1344',
        // The expression, not a seed: ffmpeg's random() takes a plane index, so
        // "different seeds" produce byte-identical frames. Changing the maths
        // is what actually changes the picture.
        '-vf', variant === 0
            ? 'geq=random(1)*255:random(2)*255:random(3)*255'
            : 'geq=random(1)*180+40:random(2)*120+90:random(3)*200+20',
        '-frames:v', '1', file,
    ], { timeout: 120000, stdio: 'ignore' });
    return file;
}

test('an oversize plate is shrunk to fit rather than dropped', { skip: !HAVE_FFMPEG }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refimg-'));
    const file = makeOversizePng(dir);
    assert.ok(fs.statSync(file).size > ri.MAX_INLINE_BYTES,
        'fixture must actually exceed the ceiling or this test proves nothing');

    ri.clearDataUriCache();
    const uri = ri.toDataUri(file);

    assert.ok(uri, 'an oversize plate must still produce a reference');
    assert.match(uri, /^data:image\/jpeg;base64,/, 'the shrunk copy is a JPEG');
    // Base64 is four thirds of the bytes it carries.
    assert.ok((uri.length * 3) / 4 <= ri.MAX_INLINE_BYTES, 'the result has to fit the ceiling');
});

test('the shrunk copy is cached on disk beside its source', { skip: !HAVE_FFMPEG }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refimg-'));
    const file = makeOversizePng(dir);

    ri.clearDataUriCache();
    const first = ri.toDataUri(file);
    const cacheDir = path.join(dir, ri.SENDABLE_DIRNAME);
    assert.ok(fs.existsSync(cacheDir), 'a shrunk copy is kept for the next call');
    assert.ok(fs.readdirSync(cacheDir).some(n => n.endsWith('.jpg')));

    // A cold memory cache must not mean re-encoding.
    ri.clearDataUriCache();
    assert.equal(ri.toDataUri(file), first, 'the same source yields the same reference');
});

test('a regenerated plate at the same path is not served as its predecessor',
    { skip: !HAVE_FFMPEG }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refimg-'));
        const file = makeOversizePng(dir);

        ri.clearDataUriCache();
        const before = ri.toDataUri(file);

        // What a regeneration does: same filename, a different picture.
        fs.rmSync(file);
        makeOversizePng(dir, 1);
        assert.notEqual(fs.readFileSync(file).length, 0);
        const after = ri.toDataUri(file);

        assert.ok(after, 'the replacement still resolves');
        assert.notEqual(after, before, 'the cache keys on the source, not the path');
    });

test('a picture already under the ceiling is inlined untouched, not re-encoded',
    { skip: !HAVE_FFMPEG }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refimg-'));
        const file = path.join(dir, 'THE_MAN_front.png');
        const f = resolveFfmpeg();
        execFileSync(f.bin, ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi',
            '-i', 'color=c=gray:s=256x256', '-frames:v', '1', file],
        { timeout: 30000, stdio: 'ignore' });
        assert.ok(fs.statSync(file).size < ri.MAX_INLINE_BYTES);

        ri.clearDataUriCache();
        assert.match(ri.toDataUri(file), /^data:image\/png;base64,/,
            'a small PNG stays a PNG — shrinking is only for what does not fit');
        assert.ok(!fs.existsSync(path.join(dir, ri.SENDABLE_DIRNAME)),
            'nothing is written for a picture that already fits');
    });

test('a missing, empty or unencodable file still answers null rather than throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refimg-'));
    const empty = path.join(dir, 'empty.png');
    fs.writeFileSync(empty, '');
    const notAnImage = path.join(dir, 'notes.txt');
    fs.writeFileSync(notAnImage, 'x'.repeat(16));

    ri.clearDataUriCache();
    assert.equal(ri.toDataUri(path.join(dir, 'gone.png')), null);
    assert.equal(ri.toDataUri(empty), null);
    assert.equal(ri.toDataUri(notAnImage), null);
    assert.equal(ri.toDataUri(null), null);
});

test('selectReferences now keeps an oversize location plate', { skip: !HAVE_FFMPEG }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refimg-'));
    const big = makeOversizePng(dir);

    ri.clearDataUriCache();
    const picked = ri.selectReferences([
        { name: 'DOWNTOWN AVENUE', kind: 'location', file_path: big },
    ], { limit: 3 });

    assert.equal(picked.length, 1, 'the location plate has to reach the request');
    assert.equal(picked[0].kind, 'location');
    assert.ok(picked[0].uri.startsWith('data:image/'));
});
