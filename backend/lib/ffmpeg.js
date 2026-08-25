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

module.exports = { resolveFfmpeg, probe, buildConcatArgs, stitchClips };
