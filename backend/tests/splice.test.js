const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { lavfiSource } = require('./helpers');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * RBF-004 — cut a range out of a clip, and put a new one in its place.
 *
 * The provider will not do this for us. RBF-001 established that
 * `video-edit`'s `images_list` is style references rather than keyframes, so
 * there is no start/end anywhere in the vendor's surface and THE SPLICE IS
 * OURS. This is the piece with no model in it.
 *
 * WHY THIS TEST PRODUCES REAL FILES. The task says it and the reason is
 * specific: an argument array that looks right produces an unplayable file just
 * as happily as one that is right, and the failure is discovered by an editor
 * rather than by us. `buildConcatArgs` is already tested this way.
 *
 * AND WHY IT CHECKS COLOUR, NOT ONLY DURATION. A correct substitution PRESERVES
 * the source's length — head + range + tail is the same total as before — so a
 * splice that quietly returned the source unchanged would pass every duration
 * assertion in this file. The only thing that separates "substituted" from
 * "copied" is what is actually on screen at each moment.
 */

const { buildTrimArgs, planSplice, spliceClip, SPLICE_REFUSALS } = require('../lib/ffmpeg');
const { resolveFfmpeg, extractFrame } = require('../lib/ffmpeg');

let TMP;
const ff = () => resolveFfmpeg();

/** Flat-colour fixtures: a real container with a real duration, costing almost
 *  nothing under full-suite contention. The lesson clip-coverage.test.js records. */
function makeClip(name, colour, seconds) {
    const p = path.join(TMP, name);
    /*
     * EXACT frame counts, not `d=<seconds>`. `color=...:d=2` at 24fps produces
     * 50 frames — 2.08s — so a fixture asking for a 2s replacement of a 2s
     * range was a genuine 0.08s mismatch, and the splice refused it correctly.
     * The implementation was right and the fixture was lying about its length.
     */
    execFileSync(ff().bin, ['-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${colour}:s=32x32:d=${seconds + 1}`,
        '-frames:v', String(Math.round(seconds * 24)),
        '-c:v', 'mpeg4', '-r', '24', p], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return p;
}

/** Seconds of a real file, read back from the container rather than assumed. */
function durationOf(clip) {
    let err = '';
    try {
        execFileSync(ff().bin, ['-nostdin', '-i', clip], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    } catch (e) { err = String((e.stderr || '')); }
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * What is on screen at a moment, as one averaged pixel.
 *
 * Scaled to 1x1 raw RGB rather than decoded with a library — ADR-002 keeps
 * image decoding out of this repo, and a single averaged pixel is all that is
 * needed to tell a red segment from a blue one.
 */
function colourAt(clip, seconds) {
    const out = execFileSync(ff().bin, ['-nostdin', '-loglevel', 'error', '-ss', String(seconds), '-i', clip,
        '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1024 });
    return [out[0], out[1], out[2]];
}
const isRed = (c) => c[0] > 120 && c[1] < 90 && c[2] < 90;
const isBlue = (c) => c[2] > 120 && c[0] < 90 && c[1] < 90;

test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-splice-')); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

/* ── the trim builder ──────────────────────────────────────────────────── */

test('a trim produces a real range whose duration reads back', async () => {
    const src = makeClip('trim-src.mp4', 'red', 6);
    const out = path.join(TMP, 'trimmed.mp4');
    const r = await spliceClip.trim(src, out, { startSec: 1.5, endSec: 4.5, fps: 24 });
    assert.strictEqual(r.ok, true, `trim failed: ${r.error || r.reason}`);
    const d = durationOf(out);
    assert.ok(d !== null, 'the trimmed file has no readable duration — it is not a playable clip');
    assert.ok(Math.abs(d - 3) < 0.25, `expected a 3s range, read back ${d}s`);
});

test('buildTrimArgs names its own output and asks for the range it was given', () => {
    /*
     * The argument array is checked for the two things a duration test cannot
     * see — that the output path is honoured, and that the range travels — and
     * for nothing else. Behaviour is proven above by producing a file.
     */
    const cmd = buildTrimArgs('/in.mp4', '/out.mp4', { startSec: 2, endSec: 5 });
    assert.strictEqual(cmd.output, '/out.mp4');
    assert.ok(cmd.args.includes('-ss') && cmd.args.includes('2'), 'the start does not reach the encoder');
    assert.ok(cmd.args.includes('-t') || cmd.args.includes('-to'), 'no range length reaches the encoder');
});

/* ── the four shapes a substitution can take ───────────────────────────── */

/*
 * DERIVED, not listed: where the marked range sits decides which pieces exist,
 * so the set is the cross product of (has a head) x (has a tail). A test
 * written against the middle case alone passes while replacing from frame zero
 * produces an empty head segment and a broken join.
 */
const SHAPES = [true, false].flatMap(head => [true, false].map(tail => ({
    head, tail,
    name: head && tail ? 'a middle section' : head ? 'the end of the clip'
        : tail ? 'the start of the clip' : 'the whole clip',
})));

test('every positional shape produces a playable file of the right length', async () => {
    assert.strictEqual(SHAPES.length, 4, 'the shape cross-product is wrong');
    for (const shape of SHAPES) {
        const SRC = 6;
        const startSec = shape.head ? 2 : 0;
        const endSec = shape.tail ? 4 : SRC;
        const src = makeClip(`s-${shape.head}-${shape.tail}.mp4`, 'red', SRC);
        const rep = makeClip(`r-${shape.head}-${shape.tail}.mp4`, 'blue', endSec - startSec);
        const out = path.join(TMP, `o-${shape.head}-${shape.tail}.mp4`);

        const r = await spliceClip({ sourcePath: src, replacementPath: rep,
            startSec, endSec, outputPath: out, fps: 24 });
        assert.strictEqual(r.ok, true, `${shape.name}: ${r.error || r.reason}`);

        const d = durationOf(out);
        assert.ok(d !== null, `${shape.name}: the output is not a playable clip`);
        assert.ok(Math.abs(d - SRC) < 0.4,
            `${shape.name}: a substitution must preserve the clip's length; expected ~${SRC}s, read ${d}s`);
    }
});

test('the replacement is actually on screen, and the rest of the clip is not disturbed', async () => {
    /*
     * THE ASSERTION THAT SEPARATES A SPLICE FROM A COPY. Every duration check
     * above passes on an implementation that returns the source untouched.
     */
    const src = makeClip('col-src.mp4', 'red', 6);
    const rep = makeClip('col-rep.mp4', 'blue', 2);
    const out = path.join(TMP, 'col-out.mp4');
    const r = await spliceClip({ sourcePath: src, replacementPath: rep,
        startSec: 2, endSec: 4, outputPath: out, fps: 24 });
    assert.strictEqual(r.ok, true, r.error || r.reason);

    assert.ok(isRed(colourAt(out, 1)), 'the head was not preserved — it is not the original footage');
    assert.ok(isBlue(colourAt(out, 3)), 'the replacement is not on screen; the source was returned unchanged');
    assert.ok(isRed(colourAt(out, 5)), 'the tail was not preserved — the join dropped the original footage');
});

test('the head keeps its own footage when the replacement starts at zero', async () => {
    const src = makeClip('z-src.mp4', 'red', 5);
    const rep = makeClip('z-rep.mp4', 'blue', 2);
    const out = path.join(TMP, 'z-out.mp4');
    const r = await spliceClip({ sourcePath: src, replacementPath: rep,
        startSec: 0, endSec: 2, outputPath: out, fps: 24 });
    assert.strictEqual(r.ok, true, r.error || r.reason);
    assert.ok(isBlue(colourAt(out, 1)), 'replacing from frame zero did not put the new footage first');
    assert.ok(isRed(colourAt(out, 4)), 'the tail was lost when there was no head');
});

test('the head and tail come from their own offsets, not from the start of the clip', async () => {
    /*
     * THE GAP EVERY OTHER TEST HERE LEAVES OPEN. With a flat-colour source, a
     * trim that ignores `-ss` still produces a segment of exactly the right
     * LENGTH and exactly the right COLOUR — so duration and colour together
     * still pass while every piece is cut from the wrong place. Mutating `-ss`
     * away survived the whole file until this existed.
     *
     * A source that changes colour part way through is what makes the offset
     * observable: the tail must be the SECOND half's colour, not the first's.
     */
    const first = makeClip('two-a.mp4', 'red', 3);
    const second = makeClip('two-b.mp4', 'green', 3);
    const src = path.join(TMP, 'two-tone.mp4');
    const joined = await require('../lib/ffmpeg').stitchClips(
        [{ file_path: first }, { file_path: second }], src, { fps: 24 });
    assert.strictEqual(joined.ok, true, `fixture join failed: ${joined.error}`);

    const rep = makeClip('two-rep.mp4', 'blue', 2);
    const out = path.join(TMP, 'two-out.mp4');
    const r = await spliceClip({ sourcePath: src, replacementPath: rep,
        startSec: 2, endSec: 4, outputPath: out, fps: 24 });
    assert.strictEqual(r.ok, true, r.error || r.reason);

    assert.ok(isRed(colourAt(out, 1)), 'the head is not the first two seconds of the source');
    assert.ok(isBlue(colourAt(out, 3)), 'the replacement is not on screen');
    const tail = colourAt(out, 5);
    assert.ok(tail[1] > 90 && tail[0] < 90,
        `the tail was cut from the wrong offset — expected the source's second half (green), got rgb(${tail})`);
});

test('a replacement at a different raster than the source still splices', async () => {
    /*
     * FOUND BY RUNNING IT FOR REAL. The plan computes a target raster and the
     * PROVIDER IGNORES IT: asked for 854x366 against a 2206x946 source,
     * Seedance returned 1000x428. The concat filter requires every input to
     * share width, height and SAR, so the join produced
     * "at least one of its streams received no packets" and wrote a zero-byte
     * file — after the generation had been billed.
     *
     * The replacement is therefore conformed to the SOURCE's raster before the
     * join, not to the plan's: the surrounding footage is what it has to match,
     * and the plan's number is a request the provider is free to ignore.
     */
    const src = makeClip('ras-src.mp4', 'red', 6);          // 32x32 by default
    const rep = path.join(TMP, 'ras-rep.mp4');
    execFileSync(ff().bin, ['-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:d=3',    // deliberately a different shape
        '-frames:v', '48', '-c:v', 'mpeg4', '-r', '24', rep], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

    const out = path.join(TMP, 'ras-out.mp4');
    const r = await spliceClip({ sourcePath: src, replacementPath: rep,
        startSec: 2, endSec: 4, outputPath: out, fps: 24 });
    assert.strictEqual(r.ok, true, `a mismatched raster broke the join: ${r.error || r.reason}`);

    const d = durationOf(out);
    assert.ok(d !== null && Math.abs(d - 6) < 0.4, `expected ~6s, read ${d}`);
    assert.ok(isBlue(colourAt(out, 3)), 'the replacement is not on screen after conforming');
    assert.ok(isRed(colourAt(out, 1)) && isRed(colourAt(out, 5)), 'the original footage was disturbed');
});

test('the source\'s own sound runs under the repair, unbroken', async () => {
    /*
     * MEASURED ON THE REAL REPAIR AND WRONG. Wingfall 1A carries dialogue and
     * room tone at about -34 dB throughout. The repair replaced the picture
     * between 8s and 13s AND PUNCHED A SILENT HOLE THROUGH THE SOUND: head
     * -34.4 dB, middle -91.0 dB (digital silence), tail -33.6 dB — while the
     * original at that exact moment was -34.1 dB.
     *
     * A REPAIR REPLACES PICTURE. The audio was never the fault, so it must run
     * underneath the whole clip untouched. That is not merely a fix, it is
     * better than anything the model could return: dialogue and room tone
     * continue with no seam at all, because they were never cut.
     *
     * The provider CAN generate audio and this engine deliberately asks it not
     * to — `generate_audio` defaults off because Film Engine owns dialogue,
     * music, SFX and ambient. That house rule is right, and it is exactly why
     * the source's audio has to be carried: nothing else is going to supply it.
     */
    const src = path.join(TMP, 'snd-src.mp4');
    execFileSync(ff().bin, ['-nostdin', '-y', '-loglevel', 'error',
        ...lavfiSource('color=c=red:s=32x32:d=7', 'sine=frequency=440:duration=6'),
        '-c:v', 'mpeg4', '-r', '24', '-c:a', 'aac', '-shortest', src],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    const rep = makeClip('snd-rep.mp4', 'blue', 2);          // silent, like a real generation

    const out = path.join(TMP, 'snd-out.mp4');
    const r = await spliceClip({ sourcePath: src, replacementPath: rep,
        startSec: 2, endSec: 4, outputPath: out, fps: 24 });
    assert.strictEqual(r.ok, true, r.error || r.reason);

    const meanVolume = (f, at, dur) => {
        const p2 = require('child_process').spawnSync(ff().bin,
            ['-nostdin', '-hide_banner', '-ss', String(at), '-t', String(dur), '-i', f,
             '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000 });
        const m = /mean_volume:\s*(-?[\d.]+)/.exec(String(p2.stderr || ''));
        return m ? Number(m[1]) : null;
    };

    const head = meanVolume(out, 0, 2);
    const middle = meanVolume(out, 2, 2);
    assert.ok(head !== null && head > -60, `the fixture itself is silent (${head} dB)`);
    assert.ok(middle !== null && middle > -60,
        `the repaired section is silent (${middle} dB) while the audio either side is ${head} dB — `
        + 'the repair punched a hole through sound that was never faulty');
    assert.ok(isBlue(colourAt(out, 3)), 'the new picture is not on screen');
});

/* ── refusals ──────────────────────────────────────────────────────────── */

test('every declared refusal is reachable and returns its own code', () => {
    /*
     * The denominator is the module's OWN registry, so a refusal that is
     * declared and can never fire is caught — the `NEVER_WRITES` and
     * `describeResolution` failure this codebase has paid for twice, where a
     * constant is exported and consumed by nothing.
     */
    assert.ok(SPLICE_REFUSALS.length >= 5,
        `only ${SPLICE_REFUSALS.length} refusals declared; this is not the real set`);
    const src = makeClip('ref-src.mp4', 'red', 6);
    const rep = makeClip('ref-rep.mp4', 'blue', 2);
    const base = { sourcePath: src, sourceDuration: 6, replacementPath: rep,
        replacementDuration: 2, startSec: 2, endSec: 4, fps: 24 };

    /* Each refusal states the input that triggers it; a refusal whose probe
     * does not fire is a rule nothing can reach. */
    const PROBES = {
        range_reversed: { startSec: 4, endSec: 2 },
        range_empty: { startSec: 3, endSec: 3 },
        range_negative: { startSec: -1, endSec: 2 },
        range_past_end: { startSec: 2, endSec: 99 },
        length_mismatch: { replacementDuration: 5 },
        no_source: { sourcePath: path.join(TMP, 'gone.mp4') },
    };
    const unreachable = [];
    for (const r of SPLICE_REFUSALS) {
        const probe = PROBES[r.code];
        if (!probe) { unreachable.push(`${r.code} (no probe: ${r.why})`); continue; }
        const got = planSplice({ ...base, ...probe });
        if (got.ok !== false || got.code !== r.code) {
            unreachable.push(`${r.code} → ${got.ok ? 'accepted' : got.code}`);
        }
        if (got.ok === false) {
            assert.ok(typeof got.reason === 'string' && got.reason.length > 15,
                `${r.code} refuses without a reason a director can act on: ${got.reason}`);
        }
    }
    assert.deepStrictEqual(unreachable, [],
        `these declared refusals do not fire on the input that should trigger them: ${unreachable.join(', ')}`);
});

test('a replacement that does not fit the marked range is refused, with the shortfall named', () => {
    /*
     * THE ACCEPTANCE CRITERION. The 4-second floor means a 2-second fault very
     * often comes back as a 4-second clip, and splicing it in regardless
     * silently lengthens the film and shifts every cut after it — visible only
     * to somebody who watches the whole thing. The epic's open question 3
     * (widen the marks, or trim back) is exactly this decision, and it is not
     * ours to make silently.
     */
    const src = makeClip('mm-src.mp4', 'red', 6);
    const r = planSplice({ sourcePath: src, sourceDuration: 6, replacementPath: '/b.mp4',
        replacementDuration: 4, startSec: 2, endSec: 4, fps: 24 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'length_mismatch');
    assert.match(r.reason, /2(\.0+)?\s*s/, `the reason does not name the range it had to fill: ${r.reason}`);
    assert.match(r.reason, /4(\.0+)?\s*s/, `the reason does not name what it was given: ${r.reason}`);
    assert.ok(/widen|trim/i.test(r.reason), `the reason names no remedy: ${r.reason}`);
});

test('a sub-frame difference is not a mismatch', () => {
    /*
     * A tolerance derived from the frame rate, not a constant. Encoders land a
     * few milliseconds either side of an exact duration, and refusing that
     * would make the check fire on every correct splice — which is how a gate
     * gets switched off, taking the real refusal with it.
     */
    const src = makeClip('sf-src.mp4', 'red', 6);
    const r = planSplice({ sourcePath: src, sourceDuration: 6, replacementPath: '/b.mp4',
        replacementDuration: 2 + (1 / 24) * 0.5, startSec: 2, endSec: 4, fps: 24 });
    assert.strictEqual(r.ok, true, `a half-frame difference was refused: ${r.reason}`);
});

test('planning spends nothing and never throws', () => {
    const bad = [
        undefined, null, {}, { sourcePath: '/a.mp4' },
        { sourcePath: '/a.mp4', sourceDuration: 'six', startSec: 'x', endSec: {} },
        { sourcePath: '/a.mp4', sourceDuration: NaN, replacementDuration: Infinity, startSec: 0, endSec: 1 },
    ];
    for (const input of bad) {
        let r;
        assert.doesNotThrow(() => { r = planSplice(input); }, `planSplice threw on ${JSON.stringify(input)}`);
        assert.strictEqual(r.ok, false, `planSplice accepted ${JSON.stringify(input)}`);
        assert.ok(r.code && r.reason, `refused with no code or reason: ${JSON.stringify(r)}`);
    }
});

test('the splice joins through the one concat rather than a second implementation', () => {
    /*
     * Two concat filters is how one acquires the pix_fmt fix and the other does
     * not — already recorded in this module's own header, and the reason
     * buildConcatArgs is shared by the sequence stitch and the whole-film
     * conform. A splice that grew its own join would be the third.
     */
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ffmpeg.js'), 'utf8')
        .split('\n').map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
    /*
     * Bound to the FUNCTION, not to a count. The first version asserted exactly
     * one `concat=n=` in the module and was simply wrong about the codebase:
     * buildConcatArgs has two branches, one for a supplied audio bed and one
     * for clips carrying their own. What matters is that no concat is built
     * anywhere else, which counting cannot express.
     */
    const at = src.indexOf('function buildConcatArgs');
    assert.ok(at > 0, 'buildConcatArgs is gone; this scan is broken');
    let depth = 0, end = at;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    const outside = src.slice(0, at) + src.slice(end);
    assert.ok(!/concat=n=/.test(outside),
        'a concat filter is built outside buildConcatArgs; the splice must reuse the existing one');
    assert.ok(/concat=n=/.test(src.slice(at, end)),
        'buildConcatArgs no longer builds a concat; this scan is measuring nothing');
});
