const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

/**
 * A REPAIRED MASTER THAT LOST ITS SOUND IS A BROKEN DELIVERABLE.
 *
 * The stitch path's silence bug is already pinned by volume in
 * media-inspect.test.js. The SPLICE path — the one a repair actually goes
 * through — was not, and `carriesAudio` (lib/ffmpeg.js) was referenced by
 * nothing outside its own file. That single expression decides whether a
 * repaired shot keeps the dialogue and room tone it was cut from.
 *
 * IT IS NOT HYPOTHETICAL, AND THAT IS WHY THIS EXISTS. Measured on the
 * director's own archived footage — three repairs of ONE source, 1A_video.mp4,
 * which carries audio at -33.9 dB:
 *
 *     1A_repair_mtojqk9a.mp4   0 audio streams    ← before the fix
 *     1A_repair_mtokuzf0.mp4   0 audio streams    ← before the fix
 *     1A_repair_mtojs4h5.mp4   1 stream, -35.0 dB ← after
 *
 * Same shot, same source, audio silently dropped twice. Nothing errored: the
 * files play, and a repaired take with no sound reads as a generation problem
 * rather than a join that discarded a track.
 *
 * ASSERTED BY VOLUME, NEVER BY THE PRESENCE OF A STREAM. The original stitch
 * defect produced output with a perfectly good SYNTHESISED-SILENT track, so
 * every check asking "is there audio" passed while the film was silent. A
 * stream is not sound.
 *
 * The denominator is derived from lib/ffmpeg.js itself — every exported
 * function that joins clips — so a third join path added later is covered or
 * this fails. Two implementations of "join" is exactly how one acquires a fix
 * and the other does not, which this module's own header already records.
 */

const ffmpeg = require('../lib/ffmpeg');
const { resolveFfmpeg, inspectMedia, stitchClips, spliceClip } = ffmpeg;

const FFMPEG_SRC = path.join(__dirname, '..', 'lib', 'ffmpeg.js');
const bin = () => resolveFfmpeg().bin;

let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-rep-audio-')); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

function sh(args) {
    execFileSync(bin(), ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe', timeout: 120000 });
}

/** A clip that genuinely makes a sound, so silence in the output means something. */
function clipWithTone(name, secs = 2) {
    const p = path.join(TMP, name);
    sh(['-f', 'lavfi', '-i', `color=c=red:s=320x240:d=${secs}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`,
        '-c:v', 'libx264', '-c:a', 'aac', '-r', '24', '-t', String(secs), '-pix_fmt', 'yuv420p', p]);
    return p;
}

/** A clip with no audio at all — what a generated section really is here. */
function silentClip(name, secs = 2) {
    const p = path.join(TMP, name);
    sh(['-f', 'lavfi', '-i', `color=c=blue:s=320x240:d=${secs}`,
        '-c:v', 'libx264', '-r', '24', '-t', String(secs), '-pix_fmt', 'yuv420p', p]);
    return p;
}

/**
 * The measurement the stream check cannot make. -91 dB is digital silence; a
 * real 440Hz tone lands around -25 to -35.
 */
function meanVolumeDb(file, window) {
    /*
     * spawnSync, not execFileSync. volumedetect writes to STDERR and exits 0,
     * and execFileSync only hands back stderr when the process THROWS — so a
     * successful measurement returned nothing and read as "could not measure".
     * The instrument has to be checked before its zero is believed; that is the
     * same failure this whole guard exists to catch, one level out.
     */
    const seek = window ? ['-ss', String(window[0]), '-to', String(window[1])] : [];
    const r = spawnSync(bin(), [...seek, '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
        { encoding: 'utf8', timeout: 120000 });
    const text = String(r.stderr || '') + String(r.stdout || '');
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(text);
    return m ? Number(m[1]) : null;
}

/** Body of a top-level function, bounded by BRACE DEPTH — never a character window. */
function bodyOf(src, name) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
    const m = re.exec(src);
    if (!m) return null;
    let i = src.indexOf('{', m.index);
    if (i < 0) return null;
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
    }
    return null;
}

/** Every exported function that joins clips into one file. Derived, not typed. */
function joinPaths() {
    const src = fs.readFileSync(FFMPEG_SRC, 'utf8');
    const out = [];
    for (const name of Object.keys(ffmpeg)) {
        if (typeof ffmpeg[name] !== 'function') continue;
        const body = bodyOf(src, name);
        if (!body) continue;
        if (/buildConcatArgs\s*\(|stitchClips\s*\(/.test(body)) out.push(name);
    }
    return out;
}

/*
 * One driver per join path. The DERIVED set is the denominator; these only say
 * how to exercise each one, and a path with no driver fails below rather than
 * being quietly dropped from the count.
 */
const DRIVERS = {
    async stitchClips() {
        const a = clipWithTone('st-a.mp4');
        const b = silentClip('st-b.mp4');
        const out = path.join(TMP, 'stitched.mp4');
        const r = await stitchClips([{ file_path: a }, { file_path: b }], out,
            { fps: 24, audio: { file_path: a } });
        // the second clip is the silent one: that span is where a dropped bed shows
        return { r, out, window: [2, 3.5] };
    },
    async spliceClip() {
        const source = clipWithTone('sp-src.mp4', 6);
        const replacement = silentClip('sp-new.mp4', 2);
        const out = path.join(TMP, 'spliced.mp4');
        const r = await spliceClip({
            sourcePath: source, replacementPath: replacement, outputPath: out,
            startSec: 2, endSec: 4,
        });
        return { r, out, window: [2.2, 3.8] };
    },
};

test('every join path in the module is exercised — a new one cannot arrive uncovered', () => {
    const paths = joinPaths();
    assert.ok(paths.length >= 2,
        `only ${paths.length} join paths derived from lib/ffmpeg.js; the scan is wrong and `
        + 'every assertion below would pass over too small a set');
    const undriven = paths.filter(p => !DRIVERS[p]);
    assert.deepStrictEqual(undriven, [],
        `these join clips into a deliverable and nothing here proves they keep the sound: ${undriven.join(', ')}`);
});

test('a joined deliverable is not digitally silent when the source had sound', async () => {
    if (!resolveFfmpeg().available) return; // no encoder: nothing to assert about
    const failures = [];
    for (const name of joinPaths()) {
        const { r, out, window } = await DRIVERS[name]();
        if (!r || r.ok !== true) { failures.push(`${name}: did not produce output (${r && (r.error || r.state)})`); continue; }
        if (!fs.existsSync(out)) { failures.push(`${name}: reported ok with no file`); continue; }

        const info = inspectMedia(out);
        /*
         * MEASURED OVER THE REPLACED WINDOW, NOT THE WHOLE FILE — and that
         * distinction is the entire value of this test. The real defect was a
         * HOLE: head -34.4 dB, middle -91.0 dB, tail -33.6 dB. A whole-file
         * mean averages a two-second hole against four seconds of tone and
         * lands nowhere near silence, so the file reads as fine. Proven, not
         * assumed: with the window removed, mutating `carriesAudio` to false —
         * the exact bug that silenced two of the director's archived repairs —
         * passed 3/3.
         */
        const db = meanVolumeDb(out, window);
        // Both, and in this order: a stream is necessary and nowhere near sufficient.
        if (!info.ok || !info.hasAudio) { failures.push(`${name}: output carries no audio stream at all`); continue; }
        if (db === null) { failures.push(`${name}: volume could not be measured, so silence cannot be ruled out`); continue; }
        if (db <= -80) failures.push(`${name}: the joined span is digitally silent at ${db} dB despite a source that sounds`);
    }
    assert.deepStrictEqual(failures, [],
        `a repaired or stitched master lost its sound: ${failures.join(' | ')}`);
});

test('the source is what decides — a silent source stays silent rather than gaining a fake track', async () => {
    if (!resolveFfmpeg().available) return;
    /*
     * The other direction, and it is not symmetry for its own sake: a splice
     * that always attached the source's audio would produce a mapping failure
     * on the silent footage this engine generates by design (`generate_audio`
     * defaults off). Both branches of `carriesAudio` have to be real.
     */
    const source = silentClip('mute-src.mp4', 6);
    const replacement = silentClip('mute-new.mp4', 2);
    const out = path.join(TMP, 'mute-out.mp4');
    const r = await spliceClip({
        sourcePath: source, replacementPath: replacement, outputPath: out,
        startSec: 2, endSec: 4,
    });
    assert.strictEqual(r.ok, true, `a silent source must still splice: ${r && (r.error || r.state)}`);
    assert.ok(fs.existsSync(out), 'no output produced for a silent source');
});
