const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { lavfiSource } = require('./helpers');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * RBF-005 — what the source clip actually IS, read from the file.
 *
 * The row cannot answer it. Measured on the live database when this epic was
 * written: all five video assets carry no `provider_model` and no width or
 * height, INCLUDING the three generated in-engine. Imported footage never had
 * them at all — and imported footage is exactly what a director is most likely
 * to be repairing.
 *
 * THE TASK SAYS "with ffprobe" AND THERE IS NO FFPROBE. `ffmpeg-static` ships
 * one binary — checked: the package directory contains `ffmpeg` and no
 * `ffprobe` — and there is none on this machine's PATH either. Adding one is a
 * new runtime dependency, which ADR-002 and this epic's own constraints both
 * refuse. So this reads the diagnostic `ffmpeg -i` prints to stderr, which is
 * the idiom `stitchClips` already documents in its own comment: ffmpeg exits
 * non-zero when asked only to inspect an input, and that is the normal path
 * rather than an error.
 *
 * The denominator is the module's own MEDIA_FIELDS registry, so a field that is
 * declared and never actually parsed is caught rather than assumed.
 */

const { inspectMedia, MEDIA_FIELDS, spliceClip, resolveFfmpeg } = require('../lib/ffmpeg');

let TMP;
const bin = () => resolveFfmpeg().bin;

function make(name, args) {
    const p = path.join(TMP, name);
    execFileSync(bin(), ['-nostdin', '-y', '-loglevel', 'error', ...args, p], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return p;
}
/** A clip whose parameters are known because they were asked for. */
const clip = (name, { w = 640, h = 480, fps = 25, codec = 'libx264', secs = 2 } = {}) =>
    make(name, ['-f', 'lavfi', '-i', `color=c=red:s=${w}x${h}:d=${secs + 1}`,
        '-frames:v', String(Math.round(secs * fps)), '-c:v', codec, '-r', String(fps)]);

test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-inspect-')); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

/* ── the declared set ──────────────────────────────────────────────────── */

test('every declared field is actually read from a real file', () => {
    assert.ok(Array.isArray(MEDIA_FIELDS) && MEDIA_FIELDS.length >= 6,
        `only ${(MEDIA_FIELDS || []).length} fields declared; this is not the real set`);
    for (const f of MEDIA_FIELDS) {
        assert.ok(f.id && typeof f.why === 'string' && f.why.length > 20,
            `${f.id} is declared without a reason anyone can check`);
    }
    const r = inspectMedia(clip('known.mp4'));
    assert.strictEqual(r.ok, true, `inspection failed: ${r.reason}`);

    const missing = MEDIA_FIELDS.filter(f => r[f.id] === undefined).map(f => f.id);
    assert.deepStrictEqual(missing, [],
        `declared and never parsed — a field nobody reads reports coverage it does not have: ${missing.join(', ')}`);
});

test('the values are the ones the file was built with', () => {
    const r = inspectMedia(clip('vals.mp4', { w: 640, h: 480, fps: 25 }));
    assert.strictEqual(r.width, 640);
    assert.strictEqual(r.height, 480);
    assert.ok(Math.abs(r.fps - 25) < 0.01, `expected 25fps, read ${r.fps}`);
    assert.strictEqual(r.codec, 'h264', `expected h264, read ${r.codec}`);
    assert.ok(Math.abs(r.durationSeconds - 2) < 0.15, `expected ~2s, read ${r.durationSeconds}`);
    assert.strictEqual(r.hasAudio, false, 'a silent clip reported audio');
});

test('it works on footage that carries no provider metadata at all', () => {
    /*
     * The acceptance criterion. An imported clip has no provider_model, no
     * width and no height in the row — so if the reader depended on any of
     * that it would work only on in-engine output, which is the footage least
     * likely to need repairing.
     */
    const imported = clip('imported.mp4', { w: 320, h: 240, fps: 30, codec: 'mpeg4' });
    const r = inspectMedia(imported);
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.width, 320);
    assert.strictEqual(r.height, 240);
    assert.ok(Math.abs(r.fps - 30) < 0.01, `expected 30fps, read ${r.fps}`);
    assert.strictEqual(r.codec, 'mpeg4');
});

/* ── the ways this parse goes wrong ────────────────────────────────────── */

test('the aspect-ratio annotation is not mistaken for the raster', () => {
    /*
     * The stream line reads `640x480 [SAR 1:1 DAR 4:3]`. A pattern reaching for
     * "numbers either side of a separator" finds 1:1 and 4:3 as happily as the
     * dimensions, and a repair built at 4x3 pixels would fail at the encoder
     * with something that reads as a codec problem.
     */
    const r = inspectMedia(clip('sar.mp4', { w: 640, h: 480 }));
    assert.strictEqual(r.width, 640, `read ${r.width}x${r.height} — the SAR/DAR annotation was parsed as the raster`);
    assert.strictEqual(r.height, 480);
});

test('a fractional frame rate survives', () => {
    /*
     * 23.976, 29.97 and 59.94 are the rates a real delivery uses, and rounding
     * one to 30 is how a repaired section drifts against the rest of the cut.
     */
    const r = inspectMedia(clip('ntsc.mp4', { fps: 30000 / 1001 }));
    assert.strictEqual(r.ok, true, r.reason);
    assert.ok(r.fps > 29.9 && r.fps < 30, `expected ~29.97, read ${r.fps}`);
    assert.notStrictEqual(r.fps, 30, 'an NTSC rate was rounded to its nominal value');
});

test('an audio-only file reports no raster rather than inventing one', () => {
    /*
     * And it must not read cover art as the picture: an MP3 with album art
     * carries a `Video: mjpeg` stream, so a reader that takes the first stream
     * calling itself Video returns the artwork's dimensions for the clip.
     */
    const a = make('audio.m4a', ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', '-c:a', 'aac']);
    const r = inspectMedia(a);
    assert.strictEqual(r.hasAudio, true, 'an audio file reported no audio');
    assert.strictEqual(r.width, null, `an audio-only file reported a width of ${r.width}`);
    assert.strictEqual(r.height, null);
    assert.ok(r.durationSeconds > 0.5, 'the duration of an audio file was not read');
    assert.ok(typeof r.videoReason === 'string' && r.videoReason.length > 10,
        'no raster and no explanation of why');
});

test('cover art is not read as the clip\'s picture', () => {
    /*
     * WRITTEN AFTER A MUTATION SURVIVED. The audio-only fixture above has no
     * video stream at all, so the guard against cover art was never exercised —
     * and the guard as first written did not work: an attached picture carries
     * BOTH a raster and a rate (`300x300 ... 90k tbr`), so a check requiring
     * one or the other accepted it. Measured before this fixture existed, an
     * audio file reported a 300x300 raster at 90000fps.
     */
    const png = make('cover.png', ['-f', 'lavfi', '-i', 'color=c=blue:s=300x300:d=1', '-frames:v', '1']);
    const aud = make('bare.m4a', ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', '-c:a', 'aac']);
    const withCover = path.join(TMP, 'cover.m4a');
    execFileSync(bin(), ['-nostdin', '-y', '-loglevel', 'error', '-i', aud, '-i', png,
        '-map', '0:a', '-map', '1:v', '-c:a', 'copy', '-c:v', 'mjpeg',
        '-disposition:v', 'attached_pic', withCover], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

    const r = inspectMedia(withCover);
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.hasAudio, true);
    assert.strictEqual(r.width, null,
        `the album artwork was reported as the clip's raster (${r.width}x${r.height})`);
    assert.strictEqual(r.fps, null, `the artwork's timebase was reported as a frame rate (${r.fps})`);
});

test('every unreadable input returns a reason and never throws', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
    const text = path.join(TMP, 'nope.mp4'); fs.writeFileSync(text, 'not a video');
    const empty = path.join(TMP, 'zero.mp4'); fs.writeFileSync(empty, '');
    for (const [what, input] of [
        ['a missing path', path.join(TMP, 'gone.mp4')],
        ['a directory', dir],
        ['a text file with a video name', text],
        ['an empty file', empty],
        ['no path', undefined],
        ['a number', 7],
    ]) {
        let r;
        assert.doesNotThrow(() => { r = inspectMedia(input); }, `${what} threw`);
        assert.strictEqual(r.ok, false, `${what} reported success`);
        assert.ok(typeof r.reason === 'string' && r.reason.length > 10,
            `${what} failed without a usable reason: ${JSON.stringify(r.reason)}`);
    }
});

test('with no encoder it says so rather than reporting an unreadable file', () => {
    const r = inspectMedia(path.join(TMP, 'x.mp4'),
        { ffmpeg: { available: false, reason: 'no encoder is available on this machine' } });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /encoder/i, `the reason does not name the encoder: ${r.reason}`);
});

/* ── what it is for ────────────────────────────────────────────────────── */

test('a splice inherits the source clip\'s real rate rather than a default', async () => {
    /*
     * THE POINT OF THIS TASK. buildConcatArgs falls back to 24fps when nobody
     * says otherwise, so a 25fps production repaired without this reads its
     * source at 25, re-encodes the join at 24, and drifts against every cut
     * around it — the seam this epic names as its main risk, produced by a
     * default rather than by the model.
     */
    const src = clip('rate-src.mp4', { w: 320, h: 240, fps: 25, secs: 4 });
    const rep = clip('rate-rep.mp4', { w: 320, h: 240, fps: 25, secs: 2 });
    const out = path.join(TMP, 'rate-out.mp4');
    const r = await spliceClip({ sourcePath: src, replacementPath: rep,
        startSec: 1, endSec: 3, outputPath: out });          // NOTE: no fps given
    assert.strictEqual(r.ok, true, r.error || r.reason);
    const got = inspectMedia(out);
    assert.ok(Math.abs(got.fps - 25) < 0.02,
        `the repair was conformed at ${got.fps}fps against a 25fps source`);
});

test('a join keeps the clips\' own audio instead of replacing it with silence', async () => {
    /*
     * THE DEFECT THIS TASK UNCOVERED, pinned so it cannot come back.
     *
     * stitchClips decided whether a clip had audio with a pattern requiring the
     * stream index to be followed by nothing or by `(...)`. Real output from
     * this ffmpeg is `Stream #0:0[0x1](und): Audio:`, so it matched NOTHING —
     * hasAudio was false for every clip ever joined, and buildConcatArgs
     * dutifully synthesised anullsrc silence for all of them.
     *
     * Nothing failed. The file plays, with a silent track that reads as a
     * creative choice, and every sequence stitch and whole-film conform has
     * been shipping one. Measured before the fix: sources at -21.2 dB joined
     * to -91 dB, which is digital silence.
     *
     * ASSERTED BY MEASURING VOLUME, not by checking an audio stream EXISTS —
     * the silent output had a perfectly good audio stream, which is why this
     * was invisible.
     */
    const { stitchClips } = require('../lib/ffmpeg');
    const tone = (n) => make(n, [...lavfiSource('color=c=red:s=32x32:d=1', 'sine=frequency=440:duration=1'),
        '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest']);

    const meanVolume = (f) => {
        const r = require('child_process').spawnSync(bin(),
            ['-nostdin', '-hide_banner', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'],
            { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000 });
        const m = /mean_volume:\s*(-?[\d.]+)/.exec(String(r.stderr || ''));
        return m ? Number(m[1]) : null;
    };

    const a = tone('tone-a.mp4');
    const srcVol = meanVolume(a);
    assert.ok(srcVol !== null && srcVol > -60,
        `the fixture itself is silent (${srcVol} dB); this test would pass over nothing`);

    assert.strictEqual(inspectMedia(a).hasAudio, true, 'a clip with a tone was read as having no audio');

    const out = path.join(TMP, 'tone-join.mp4');
    const r = await stitchClips([{ file_path: a }, { file_path: tone('tone-b.mp4') }], out, { fps: 24 });
    assert.strictEqual(r.ok, true, `join failed: ${r.error}`);

    const joined = meanVolume(out);
    assert.ok(joined !== null && joined > -60,
        `the join replaced real audio with silence: sources at ${srcVol} dB, output at ${joined} dB`);
});

test('the video parameters are read in one place', () => {
    /*
     * A fifth parser of the same stderr would undo what RBF-003 spent a whole
     * dispatch establishing. The duration readers that remain are named with
     * their reason, so the ones outstanding are visible work rather than
     * forgotten copies — a stale entry fails, so this cannot become a story.
     */
    const REMAINING = {
        'audio-features.js': 'reads AUDIO stream fields — sample rate, channels, layout, bitrate — '
            + 'which a video inspector has no business knowing; folding it in would make this an audio analyser',
        'review-proxy.js': 'parses only a duration, exported as parseDuration with its own tests; '
            + 'routing it buys nothing for the repair path and risks a surface this task does not touch',
    };
    const dir = path.join(__dirname, '..', 'lib');
    const hits = [];
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
        const s = fs.readFileSync(path.join(dir, f), 'utf8')
            .split('\n').map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
        if (/Duration:\s*\\?\(?\\?d|Duration: \(/.test(s) || /\/Duration:/.test(s)) hits.push(f);
    }
    assert.ok(hits.length >= 2, `only ${hits.length} duration parsers found; this scan is broken`);
    for (const [name, why] of Object.entries(REMAINING)) {
        assert.ok(hits.includes(name), `${name} is exempted (${why}) but no longer parses one — a stale exemption is a lie`);
    }
    const unexpected = hits.filter(f => f !== 'ffmpeg.js' && !REMAINING[f]);
    assert.deepStrictEqual(unexpected, [],
        `new parsers of ffmpeg's diagnostic, outside the one reader: ${unexpected.join(', ')}`);
});
