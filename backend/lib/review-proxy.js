/**
 * A clip small enough to look at, and a frame small enough to glance at.
 *
 * A production clip will not survive most transports and a master never should
 * — not for size, and not because an unreleased master has no business sitting
 * anywhere it can be fetched without asking. Reviewing is a different act from
 * delivering, and it needs a different file.
 *
 * `maxBytes` IS AN ARGUMENT, ALWAYS. This module has no opinion about any
 * particular destination's ceiling, and hardcoding one would bake a third
 * party's limit into a codebase that deliberately names none. The caller knows
 * what it is transferring into; this knows how to make something that fits.
 *
 * IT RETURNS NULL RATHER THAN SOMETHING OVERSIZED. That is the whole contract:
 * a caller that receives null can say WHY — post the still, name the size —
 * whereas one handed a file that is too big discovers it at the transfer, which
 * is the point at which nothing useful can be done about it.
 *
 * Uses the ffmpeg this repo already vendors. Nothing new is depended on.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveFfmpeg, extractFrame } = require('./ffmpeg');

/** Where derived review files live: beside the asset, out of the way. */
const CACHE_DIR = '.review';

/** What a proxy is capped at when the caller says nothing. */
const DEFAULT_MAX_SECONDS = 30;
const PROXY_HEIGHT = 720;

/**
 * Cache identity is SIZE AND MTIME, never the path alone.
 *
 * A regenerated clip is written to the same filename and overwrites, so a
 * cache keyed on the path serves the previous take's proxy for ever — the
 * exact bug the plate thumbnail cache was written to avoid, one media type
 * over.
 */
function sourceKey(file) {
    const st = fs.statSync(file);
    return `${st.size}-${Math.round(st.mtimeMs)}`;
}

function cachePathFor(file, suffix) {
    const dir = path.join(path.dirname(file), CACHE_DIR);
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    return path.join(dir, `${base}.${sourceKey(file)}.${suffix}`);
}

function ensureDir(p) {
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) { /* exists */ }
}

/** Every failure here is a REASON, never a throw: review is not the job. */
function unavailable(reason) { return { ok: false, path: null, reason }; }

/**
 * One representative frame.
 *
 * Taken a second in rather than at 0, because the first frame of a generated
 * clip is very often the keyframe it was conditioned on — which makes every
 * still identical to the plate and tells a reviewer nothing about the clip.
 */
function stillFor(videoPath, opts) {
    const o = opts || {};
    if (!videoPath || !fs.existsSync(videoPath)) {
        return unavailable('there is no file at that path');
    }
    const ff = resolveFfmpeg();
    if (!ff.available) return unavailable(ff.reason || 'no encoder is available on this machine');

    const out = cachePathFor(videoPath, 'still.png');
    if (fs.existsSync(out)) {
        return { ok: true, path: out, bytes: fs.statSync(out).size, cached: true };
    }
    ensureDir(out);
    const at = Number(o.atSeconds) >= 0 ? Number(o.atSeconds) : 1;

    /*
     * SEEKING PAST THE END SUCCEEDS AND WRITES NOTHING.
     *
     * ffmpeg exits 0 for `-ss 1` on a 0.4-second clip and simply produces no
     * file, so a retry gated on the throw never fired — and a short clip
     * reported as unreadable when it was merely short. The presence of the
     * file is the only honest test of whether a frame was taken.
     *
     * That rule and its retry now live in `extractFrame`, because this file
     * was the only one of three that had learned it: the other two silently
     * lost the frame. Shared, the lesson reaches them.
     */
    const got = extractFrame(videoPath, { atSeconds: at, out, ffmpeg: ff, quality: null });
    if (!got.ok) return unavailable(got.reason);
    if (!fs.existsSync(out)) return unavailable('no frame was produced');
    return { ok: true, path: out, bytes: fs.statSync(out).size, cached: false };
}

/**
 * A clip that fits, or nothing.
 *
 * Re-encoded at 720p and capped in length. The bitrate is DERIVED from the
 * budget and the duration rather than picked: a fixed bitrate produces a file
 * whose size depends on how long the shot happens to be, which is precisely
 * the thing the caller asked us to control.
 */
function proxyFor(videoPath, opts) {
    const o = opts || {};
    const maxBytes = Number(o.maxBytes);
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        return unavailable('proxyFor needs a maxBytes — this module has no opinion about any '
            + 'particular destination\'s ceiling');
    }
    if (!videoPath || !fs.existsSync(videoPath)) {
        return unavailable('there is no file at that path');
    }
    const ff = resolveFfmpeg();
    if (!ff.available) return unavailable(ff.reason || 'no encoder is available on this machine');

    const out = cachePathFor(videoPath, `proxy-${maxBytes}.mp4`);
    if (fs.existsSync(out)) {
        const bytes = fs.statSync(out).size;
        // A cached proxy over the cap is not a proxy. It can only come from a
        // changed ceiling, and honouring it would break the one promise here.
        if (bytes <= maxBytes) return { ok: true, path: out, bytes, cached: true };
        try { fs.unlinkSync(out); } catch (_) { /* rebuild below */ }
    }

    // The source is already small enough: hand it back rather than spending an
    // encode to make a slightly smaller copy of something that already fits.
    const srcBytes = fs.statSync(videoPath).size;
    if (srcBytes <= maxBytes && o.alwaysReencode !== true) {
        return { ok: true, path: videoPath, bytes: srcBytes, cached: false, reencoded: false };
    }

    const maxSeconds = Number(o.maxSeconds) > 0 ? Number(o.maxSeconds) : DEFAULT_MAX_SECONDS;
    const seconds = Math.min(maxSeconds, durationOf(videoPath, ff) || maxSeconds);

    /*
     * 90% of the budget, and audio taken out of it first. Aiming at exactly
     * the ceiling lands over it as often as under — a container has overhead
     * this arithmetic cannot see, and being 2% over is the same failure as
     * being double.
     */
    const audioKbps = 64;
    const totalKbits = (maxBytes * 8 * 0.9) / 1000;
    const videoKbps = Math.max(120, Math.floor(totalKbits / Math.max(1, seconds)) - audioKbps);

    ensureDir(out);
    try {
        execFileSync(ff.bin, [
            '-y', '-loglevel', 'error',
            '-i', videoPath,
            '-t', String(seconds),
            '-vf', `scale=-2:${PROXY_HEIGHT}`,
            '-c:v', 'libx264', '-preset', 'veryfast',
            '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', `${audioKbps}k`,
            '-movflags', '+faststart',
            out,
        ], { stdio: 'pipe' });
    } catch (err) {
        return unavailable('the encoder could not produce a proxy from this file');
    }

    if (!fs.existsSync(out)) return unavailable('no proxy was produced');
    const bytes = fs.statSync(out).size;
    if (bytes > maxBytes) {
        // NULL RATHER THAN OVERSIZED. The file is removed so a later call does
        // not find it cached and trust it.
        try { fs.unlinkSync(out); } catch (_) { /* best effort */ }
        return unavailable(`a 720p proxy of this clip still comes to ${bytes} bytes, over the `
            + `${maxBytes} allowed — send the still instead, or raise the ceiling`);
    }
    return { ok: true, path: out, bytes, cached: false, reencoded: true, seconds };
}

/** How long the source runs, so the bitrate can be aimed. Null if unreadable. */
function durationOf(file, ff) {
    try {
        const out = execFileSync(ff.bin, ['-i', file], { stdio: ['pipe', 'pipe', 'pipe'] });
        return parseDuration(String(out));
    } catch (err) {
        // ffmpeg with no output file exits non-zero and prints the metadata to
        // stderr. That is the normal path, not an error.
        const text = `${(err && err.stderr) || ''}${(err && err.stdout) || ''}`;
        return parseDuration(text);
    }
}

function parseDuration(text) {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text || '');
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

module.exports = {
    stillFor, proxyFor, sourceKey, cachePathFor, parseDuration,
    CACHE_DIR, DEFAULT_MAX_SECONDS, PROXY_HEIGHT,
};
