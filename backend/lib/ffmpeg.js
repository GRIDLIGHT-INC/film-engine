/**
 * THE ENCODER, AND JOINING CLIPS INTO ONE FILE.
 *
 * A sequence produced N-1 clips and told the director to join them in an NLE,
 * which makes the last step of the pipeline happen outside the pipeline. The
 * blocker was never the code — lib/conform.js has had a working concat since it
 * was written — it was that no encoder existed on the machine, so
 * availableExecutors() correctly reported nothing and the conform correctly
 * refused.
 *
 * WHY A DEPENDENCY, AGAINST ADR-002.
 *
 * ADR-002 is "one dependency, no framework", and its reasoning is about not
 * pulling a large ABSTRACTION over something the standard library already does.
 * This is not that. Node genuinely cannot mux MP4: joining clips from different
 * generators means rebuilding moov/stbl sample tables, and a hand-rolled muxer
 * that is subtly wrong writes files that play in QuickTime and fail in the NLE
 * — the worst possible failure for a delivery step, because it is discovered
 * last. The alternative was telling a director to install a system tool before
 * the app could produce its own output.
 *
 * It is the FLOOR, not the default. Resolution order is FFMPEG_PATH, then the
 * system PATH, then the bundled binary — so an install that already has ffmpeg
 * keeps using the one its operator chose, and the bundled copy only matters
 * where there is nothing else. Missing entirely is still a legitimate answer
 * and carries the remedy.
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

/*
 * Resolved ONCE per process.
 *
 * This probed on every call, and a probe is a subprocess: FFMPEG_PATH, then
 * five PATH candidates that mostly do not exist, then the bundled binary — up
 * to six spawns to answer a question whose answer cannot change while the
 * process runs. Under load one of those probes fails, resolveFfmpeg reports no
 * encoder, and the caller silently falls back — which is how duration
 * measurement returned 0 in roughly one full-suite run in two while being
 * perfect in isolation.
 *
 * Cached on the resolved answer only. An UNAVAILABLE result is not cached: an
 * operator who installs ffmpeg, or sets FFMPEG_PATH and restarts nothing,
 * should not be told for the life of the process that there is no encoder.
 */
let resolved = null;

/** Where ffmpeg is, and how we found it. Never throws. */
function resolveFfmpeg() {
    if (resolved) return resolved;
    const found = resolveFfmpegUncached();
    if (found.available) resolved = found;
    return found;
}

function resolveFfmpegUncached() {
    // 1. FFMPEG_PATH — an operator pointing at a specific build wins over
    //    everything, including a newer one on PATH.
    const declared = String(process.env.FFMPEG_PATH || '').trim();
    if (declared) {
        if (runs(declared)) return { available: true, bin: declared, source: 'env' };
        return {
            available: false, bin: null, source: 'env',
            reason: `FFMPEG_PATH is set to ${declared}, which will not run. Correct it or unset it.`,
        };
    }

    // 2. The system PATH, plus the places a package manager puts it that a
    //    server process's PATH often does not include.
    for (const candidate of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg',
        '/opt/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
        if (runs(candidate)) return { available: true, bin: candidate, source: 'path' };
    }

    // 3. The bundled binary.
    try {
        const bundled = require('ffmpeg-static');
        if (bundled && fs.existsSync(bundled) && runs(bundled)) {
            return { available: true, bin: bundled, source: 'bundled' };
        }
    } catch (_) { /* not installed; fall through to the honest answer */ }

    return {
        available: false, bin: null, source: null,
        reason: 'No encoder available. Install ffmpeg (brew install ffmpeg), or run '
            + '`npm install ffmpeg-static` in backend/, or point FFMPEG_PATH at a build.',
    };
}

function runs(bin) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 8000 }); return true; }
    catch (_) { return false; }
}

/** Run the encoder and hand back what it said. Never throws. */
function probe(bin, args, opts) {
    return new Promise(resolve => {
        execFile(bin, args, { timeout: (opts && opts.timeoutMs) || 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({
                code: err ? (err.code === undefined ? 1 : err.code) : 0,
                stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || ''),
            }));
    });
}

/**
 * ONE FRAME, AT ONE MOMENT, FROM ONE CLIP.
 *
 * `-ss <t> -i clip -frames:v 1` was written out four times across three files,
 * and they had already diverged — which is the whole argument for this
 * function rather than a style preference. review-proxy had learned that
 * SEEKING PAST THE END EXITS 0 AND WRITES NOTHING and retried at frame zero;
 * mcp-tools and characters had not, so a sample past the end was silently lost
 * in one and an orbit view silently skipped in the other. The site that learned
 * the lesson could not teach the other two while each kept its own copy.
 *
 * NEVER THROWS, and returns a REASON on failure. Every caller here is doing
 * something else at the time — sampling a clip for review, cutting an orbit
 * view, building a still for a proxy — and a sampling failure that takes down
 * the operation that asked for it is worse than a missing frame. The same rule
 * `stampAsset` and `resolveFfmpeg` already follow.
 *
 * THE PRESENCE OF THE FILE IS THE ONLY HONEST TEST. The exit code is not
 * evidence: ffmpeg reports success for a seek beyond the last frame and simply
 * produces nothing, so a caller gated on the throw sees success and finds an
 * empty path.
 *
 * A FALLBACK IS REPORTED, never silent. Handing back frame zero for a seek to
 * 30s is the right answer — a short clip is not a broken one — but a caller
 * told nothing will label that picture "30.0s", which is exactly what
 * shot_review's sample captions do.
 */
function extractFrame(clipPath, opts) {
    const o = opts || {};
    const out = o.out;
    if (typeof out !== 'string' || !out) {
        return { ok: false, reason: 'no output path was given for the frame' };
    }
    if (typeof clipPath !== 'string' || !clipPath) {
        return { ok: false, reason: 'no clip path was given to take a frame from' };
    }

    /*
     * The encoder may be passed in by a caller that has already resolved it —
     * review-proxy resolves it to answer a different question first — so this
     * does not resolve twice. An absent encoder and an unreadable file are
     * DIFFERENT ANSWERS with different remedies, and folding them together is
     * what made a missing ffmpeg read as corrupt footage.
     */
    const ff = o.ffmpeg || resolveFfmpeg();
    if (!ff || !ff.available) {
        return { ok: false, reason: ff && ff.reason ? ff.reason : 'no encoder is available on this machine' };
    }

    let stat = null;
    try { stat = fs.statSync(clipPath); } catch (_) { stat = null; }
    if (!stat) return { ok: false, reason: `there is no file at ${clipPath}` };
    if (stat.isDirectory()) return { ok: false, reason: `${clipPath} is a directory, not a clip` };
    if (stat.size === 0) return { ok: false, reason: 'that file is empty, so it holds no frames' };

    try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch (_) { /* the write below reports it */ }
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (_) { /* a stale frame is caught below */ }

    const at = Number(o.atSeconds) > 0 ? Number(o.atSeconds) : 0;
    const timeout = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 30000;
    /*
     * The quality flag is the callers' own: two of them passed `-q:v 2` and one
     * did not, so a proxy still and an orbit cut came off the same clip at
     * different quality. Defaulted to the stricter of the two rather than
     * dropped, since the looser one was the accident.
     */
    const quality = o.quality === null ? [] : ['-q:v', String(o.quality || 2)];

    const run = (args) => {
        try {
            execFileSync(ff.bin, args, { stdio: 'pipe', timeout });
        } catch (_) { /* the presence check below is the real test */ }
        try { return fs.existsSync(out) && fs.statSync(out).size > 0; } catch (_) { return false; }
    };

    /*
     * The nudge mcp-tools already applied: seeking to exactly the last frame
     * boundary lands past it often enough to matter, and a millisecond back is
     * the same picture.
     */
    if (at > 0) {
        const seek = Math.max(0, at - 0.001);
        if (run(['-y', '-loglevel', 'error', '-ss', String(seek), '-i', clipPath,
                 '-frames:v', '1', ...quality, out])) {
            return { ok: true, path: out, atSeconds: at, fellBack: false };
        }
    }

    // Past the end, or a seek this container will not honour: take the first frame.
    if (run(['-y', '-loglevel', 'error', '-i', clipPath, '-frames:v', '1', ...quality, out])) {
        return { ok: true, path: out, atSeconds: 0, fellBack: at > 0 };
    }

    return { ok: false, reason: 'the encoder could not read a frame from this file' };
}

/**
 * The arguments that join an ordered list of clips into one file.
 *
 * ONE implementation, shared by the sequence stitch and the whole-film conform.
 * Two concat filters is how one of them acquires the pix_fmt fix and the other
 * does not, and the one that misses it plays everywhere except the NLE the
 * director actually uses.
 *
 * The concat FILTER over decoded streams, not the demuxer: the clips come from
 * different generators and need not share codec parameters, and the demuxer
 * silently produces garbage when they do not.
 */
function buildConcatArgs(clips, outputPath, opts) {
    const o = opts || {};
    const args = [];
    for (const clip of clips) args.push('-i', clip.file_path);
    if (o.audio) args.push('-i', o.audio.file_path);

    const n = clips.length;
    if (n === 1 && !o.audio) {
        // One clip is a re-encode to the delivery settings, not a concat. A
        // concat filter with n=1 is legal and wasteful, and states nothing.
        args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
        if (o.fps) args.push('-r', String(o.fps));
        args.push('-y', outputPath);
        return { bin: null, args, output: outputPath };
    }

    /*
     * Every input must contribute BOTH streams to the filter, and a clip
     * without audio would break the graph — so silence is synthesised for any
     * input that has none. Without this, one silent generated clip in a
     * sequence fails the whole join with "Invalid file index".
     */
    let audioPrelude = '';
    const streams = clips.map((_, i) => {
        if (o.audio) return `[${i}:v:0]`;
        const info = Array.isArray(o.clipInfo) ? o.clipInfo[i] : null;
        if (!info) return `[${i}:v:0][${i}:a:0]`;
        if (info.hasAudio) {
            audioPrelude += `[${i}:a:0]aresample=44100,`
                + `aformat=sample_fmts=fltp:channel_layouts=stereo[aud${i}];`;
        } else {
            const duration = Math.max(0.001, Number(info.duration) || 0.001);
            audioPrelude += `anullsrc=r=44100:cl=stereo,atrim=duration=${duration.toFixed(6)}[aud${i}];`;
        }
        return `[${i}:v:0][aud${i}]`;
    }).join('');
    if (o.audio) {
        args.push('-filter_complex', `${streams}concat=n=${n}:v=1:a=0[outv]`);
        args.push('-map', '[outv]', '-map', `${n}:a:0`, '-shortest');
    } else {
        args.push('-filter_complex', `${audioPrelude}${streams}concat=n=${n}:v=1:a=1[outv][outa]`);
        args.push('-map', '[outv]', '-map', '[outa]');
    }
    args.push('-r', String(o.fps || 24), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
    args.push('-y', outputPath);
    return { bin: null, args, output: outputPath };
}

/**
 * Join clips into one file.
 *
 * Returns a RESULT, never throws: "nothing installed can do this" is an answer
 * a director needs and a stack trace is not — the rule runConform already sets.
 */
/**
 * WHY THE SPLICE IS OURS.
 *
 * RBF-001 established that Seedance `video-edit`'s `images_list` is style
 * references rather than keyframes — a red START card and a blue END card came
 * back composited into the scene together, for the whole clip. There is no
 * start/end anywhere in the vendor's surface, so substituting a section is
 * something this codebase does or nobody does.
 */

/**
 * The arguments that cut one range out of a clip.
 *
 * RE-ENCODED, not stream-copied. `-c copy` can only cut on keyframes, so it
 * silently moves the cut to the nearest one — up to a couple of seconds away on
 * a generated clip — and a director who marked a two-second fault gets a
 * different two seconds. The seam is already the stated risk in this epic;
 * paying an encode to land on the frame that was marked is the cheaper half of
 * that trade.
 */
function buildTrimArgs(clipPath, outputPath, opts) {
    const o = opts || {};
    const start = Math.max(0, Number(o.startSec) || 0);
    const length = Math.max(0, (Number(o.endSec) || 0) - start);
    const args = ['-y', '-loglevel', 'error'];
    // Seek BEFORE -i: the decoder skips rather than decoding and discarding,
    // which on a long source is the difference between instant and a minute.
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', clipPath, '-t', String(length));
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
    if (o.fps) args.push('-r', String(o.fps));
    args.push(outputPath);
    return { bin: null, args, output: outputPath };
}

/**
 * Every way a substitution can be refused, and why each one exists.
 *
 * A REGISTRY RATHER THAN SCATTERED RETURNS, so a rule that is declared and can
 * never fire is visible. This codebase has shipped that twice — `NEVER_WRITES`
 * exported and consumed by nothing, `describeResolution` with zero callers —
 * and both times the protection read as present while doing nothing at all.
 */
const SPLICE_REFUSALS = Object.freeze([
    { code: 'no_source', why: 'a plan naming a file that is not there is worthless; stitchClips refuses the same way' },
    { code: 'range_negative', why: 'a clip has no footage before zero' },
    { code: 'range_reversed', why: 'out before in reads as a model fault later, not as a bad mark' },
    { code: 'range_empty', why: 'replacing nothing is not a repair, and would spend on a generation nobody sees' },
    { code: 'range_past_end', why: 'the tail would be negative, and the join would silently drop footage' },
    { code: 'length_mismatch', why: 'the 4-second floor makes this the COMMON case, and splicing anyway shifts every cut after it' },
]);

const refuse = (code, reason) => ({ ok: false, code, reason });

/**
 * What a substitution would do, decided without spending or encoding anything.
 *
 * Pure and free, mirroring the planner/executor split `lib/video-sequence.js`
 * already follows: the plan is what a director is shown before any generation
 * is paid for, so it cannot be the thing that costs money to raise.
 */
function planSplice(input) {
    const o = input || {};
    const sourcePath = typeof o.sourcePath === 'string' ? o.sourcePath : '';
    if (!sourcePath) return refuse('no_source', 'no source clip was given to splice into');
    if (!fs.existsSync(sourcePath)) {
        return refuse('no_source', `there is no clip at ${sourcePath} to splice into`);
    }

    let sourceDuration = Number(o.sourceDuration);
    if (!(sourceDuration > 0) || !Number.isFinite(sourceDuration)) {
        return refuse('no_source',
            'the source clip\'s duration is not known, and it must be measured from the file '
            + 'rather than taken from the row — every existing video asset stores none');
    }

    const startSec = Number(o.startSec);
    const endSec = Number(o.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
        return refuse('range_empty', 'the marked range is not two numbers, so there is nothing to replace');
    }
    if (startSec < 0) return refuse('range_negative', `the range starts at ${startSec}s, and a clip has no footage before zero`);
    if (endSec < startSec) {
        return refuse('range_reversed',
            `the range ends at ${endSec}s before it starts at ${startSec}s — reversed, the repair would run backwards`);
    }
    if (endSec === startSec) {
        return refuse('range_empty', `the range is zero-length at ${startSec}s, so there is nothing to replace`);
    }

    /*
     * The tolerance is ONE FRAME, derived from the rate rather than a constant.
     * Encoders land a few milliseconds either side of an exact duration, and a
     * check that fires on every correct splice is one that gets switched off,
     * taking the real refusal with it.
     */
    const fps = Number(o.fps) > 0 ? Number(o.fps) : 24;
    const frame = 1 / fps;
    if (endSec > sourceDuration + frame) {
        return refuse('range_past_end',
            `the range ends at ${endSec.toFixed(2)}s but the clip is ${sourceDuration.toFixed(2)}s long`);
    }

    const rangeLength = endSec - startSec;
    const replacementDuration = Number(o.replacementDuration);
    if (Number.isFinite(replacementDuration) && replacementDuration > 0
        && Math.abs(replacementDuration - rangeLength) > frame) {
        /*
         * THE COMMON CASE, not an edge one. MIN_DURATION is 4, so a two-second
         * fault comes back as a four-second clip; splicing it in regardless
         * lengthens the film and shifts every cut after it — visible only to
         * somebody who watches the whole thing. Which way to resolve it is the
         * epic's open question 3 and belongs to a director, so both remedies
         * are named rather than one being chosen here.
         */
        return refuse('length_mismatch',
            `the marked range is ${rangeLength.toFixed(2)}s and the replacement is `
            + `${replacementDuration.toFixed(2)}s. Splicing it in would move every cut after it by `
            + `${Math.abs(replacementDuration - rangeLength).toFixed(2)}s. Either widen the marks to `
            + `${replacementDuration.toFixed(2)}s, or trim the replacement back to the range.`);
    }

    /*
     * Which pieces exist follows from where the range sits, and both ends can
     * legitimately be absent — replacing from frame zero has no head, replacing
     * to the last frame has no tail. An empty segment handed to the concat is
     * an invalid input, so it is never built rather than built and skipped.
     */
    const segments = [];
    if (startSec > frame) {
        segments.push({ role: 'head', path: sourcePath, startSec: 0, endSec: startSec, duration: startSec });
    }
    segments.push({ role: 'replacement', path: o.replacementPath || null,
        startSec: null, endSec: null, duration: replacementDuration > 0 ? replacementDuration : rangeLength });
    if (sourceDuration - endSec > frame) {
        segments.push({ role: 'tail', path: sourcePath, startSec: endSec, endSec: sourceDuration,
            duration: sourceDuration - endSec });
    }

    return {
        ok: true, segments, fps,
        outputDuration: segments.reduce((n, s2) => n + s2.duration, 0),
        shape: `${segments.some(x => x.role === 'head') ? 'head+' : ''}new`
            + `${segments.some(x => x.role === 'tail') ? '+tail' : ''}`,
    };
}

/** Cut one range to a real file. Never throws; a reason on failure. */
async function trimClip(clipPath, outputPath, opts) {
    const found = resolveFfmpeg();
    if (!found.available) return { ok: false, state: 'no_executor', error: found.reason };
    if (!fs.existsSync(clipPath)) return { ok: false, state: 'missing_clip', error: `no clip at ${clipPath}` };
    try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch (_) { /* reported below */ }
    const cmd = buildTrimArgs(clipPath, outputPath, opts);
    const run = await probe(found.bin, cmd.args, { timeoutMs: 10 * 60 * 1000 });
    if (run.code !== 0 || !fs.existsSync(outputPath)) {
        return { ok: false, state: 'failed',
            error: `Encoder failed: ${run.stderr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)}` };
    }
    return { ok: true, state: 'produced', output: outputPath, bytes: fs.statSync(outputPath).size };
}

/**
 * Head, new, tail — one file.
 *
 * The JOIN IS `stitchClips`, not a second concat. This module's own header
 * records why there is one: two concat filters is how one acquires the pix_fmt
 * fix and the other does not, and the one that misses it plays everywhere
 * except the NLE the director actually uses. A splice that grew its own would
 * be the third.
 */
async function spliceClip(input) {
    const o = input || {};
    const found = resolveFfmpeg();
    if (!found.available) return { ok: false, state: 'no_executor', error: found.reason };

    // Measured from the FILE. Every existing video asset carries no width, no
    // height and no provider_model, and imported footage never had them — which
    // is also the footage a director is most likely to be repairing.
    let sourceDuration = Number(o.sourceDuration);
    if (!(sourceDuration > 0)) {
        try {
            sourceDuration = (require('./media-imports').measureDurationMs(o.sourcePath) || 0) / 1000;
        } catch (_) { sourceDuration = 0; }
    }
    let replacementDuration = Number(o.replacementDuration);
    if (!(replacementDuration > 0)) {
        try {
            replacementDuration = (require('./media-imports').measureDurationMs(o.replacementPath) || 0) / 1000;
        } catch (_) { replacementDuration = 0; }
    }

    const plan = planSplice({ ...o, sourceDuration, replacementDuration });
    if (!plan.ok) return { ok: false, state: 'refused', code: plan.code, error: plan.reason, reason: plan.reason };
    if (!o.replacementPath || !fs.existsSync(o.replacementPath)) {
        return { ok: false, state: 'missing_clip', error: 'the replacement clip is not on disk' };
    }

    const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fe-splice-'));
    const made = [];
    try {
        for (const seg of plan.segments) {
            if (seg.role === 'replacement') { made.push({ file_path: o.replacementPath }); continue; }
            const cut = path.join(work, `${seg.role}.mp4`);
            const t = await trimClip(seg.path, cut, { startSec: seg.startSec, endSec: seg.endSec, fps: plan.fps });
            if (!t.ok) return { ok: false, state: 'failed', error: `the ${seg.role} could not be cut: ${t.error}` };
            made.push({ file_path: cut });
        }
        const joined = await stitchClips(made, o.outputPath, { fps: plan.fps });
        if (!joined.ok) return joined;
        return { ...joined, shape: plan.shape, segments: plan.segments.length,
                 expectedDuration: plan.outputDuration };
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* temp */ }
    }
}

/* The trim is part of the splice's surface, so it is reachable from it as well
 * as on its own — one import for a caller doing both. */
spliceClip.trim = trimClip;

async function stitchClips(clips, outputPath, opts) {
    const list = (clips || []).filter(c => c && c.file_path);
    if (!list.length) return { ok: false, state: 'no_clips', error: 'No clips to join.' };

    const missing = list.filter(c => !fs.existsSync(c.file_path)).map(c => path.basename(c.file_path));
    if (missing.length) {
        // Joining around a missing clip produces a shorter film that plays
        // fine, which is the failure nobody notices until they watch all of it.
        return {
            ok: false, state: 'missing_clip',
            error: `Missing on disk: ${missing.join(', ')}. Regenerate or re-upload before joining.`,
        };
    }

    const found = resolveFfmpeg();
    if (!found.available) return { ok: false, state: 'no_executor', error: found.reason, encoder: found };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const clipInfo = [];
    for (const clip of list) {
        // ffmpeg exits non-zero when asked only to inspect an input, but its
        // diagnostic is the portable stream probe bundled with ffmpeg-static.
        const inspected = await probe(found.bin, ['-i', clip.file_path], { timeoutMs: 30000 });
        const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(inspected.stderr);
        if (!duration) {
            return { ok: false, state: 'invalid_clip', error: `Cannot read ${path.basename(clip.file_path)}.` };
        }
        clipInfo.push({
            hasAudio: /Stream\s+#\d+:\d+(?:\([^)]*\))?:\s+Audio:/i.test(inspected.stderr),
            duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
        });
    }
    const cmd = buildConcatArgs(list, outputPath, { ...(opts || {}), clipInfo });
    const run = await probe(found.bin, cmd.args, opts);
    if (run.code !== 0 || !fs.existsSync(outputPath)) {
        return {
            ok: false, state: 'failed', encoder: found,
            error: `Encoder failed: ${run.stderr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)}`,
        };
    }
    return {
        ok: true, state: 'produced', output: outputPath, clips: list.length,
        bytes: fs.statSync(outputPath).size, encoder: { bin: found.bin, source: found.source },
    };
}

module.exports = { resolveFfmpeg, probe, extractFrame, buildConcatArgs, stitchClips,
    buildTrimArgs, planSplice, trimClip, spliceClip, SPLICE_REFUSALS };
