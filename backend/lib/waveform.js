/**
 * The shape of a sound, so a card can show it
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A cue card with no picture is a filename and a play button: you cannot tell
 * a sparse underscore from a wall of noise, or a clean take from one that
 * clips, without listening to both. A waveform answers that at a glance, which
 * is the whole reason the tile has one.
 *
 * PEAKS, NOT AN IMAGE. The page draws them on a canvas, so one small JSON
 * serves every size the card is ever rendered at, survives a theme change, and
 * costs no encoder work when the layout changes. An image would have to be
 * regenerated per width, exactly like the thumbnails this codebase just had to
 * retrofit.
 *
 * Cached beside the file under `.waves`, keyed by size and mtime like the
 * thumbnail cache — a path is not an identity here either: a regenerated cue
 * overwrites its own filename, and a stale waveform would show the shape of a
 * sound that no longer exists.
 *
 * Never throws. A waveform is decoration on a card whose job is to play audio;
 * failing the card because the picture could not be drawn would be the worse
 * trade, and it is the same rule `stampAsset` and `thumbnailFor` already state.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CACHE_DIRNAME = '.waves';
const BUCKETS = 96;          // enough shape for a 300px card, small enough to inline

/** ffmpeg, wherever this install found it. */
function encoder() {
    try {
        const { resolveFfmpeg } = require('./ffmpeg');
        const r = resolveFfmpeg();
        return r && r.available ? r.bin : null;
    } catch (_) { return null; }
}

function cachePathFor(sourcePath, stat) {
    const dir = path.join(path.dirname(sourcePath), CACHE_DIRNAME);
    const key = `${path.basename(sourcePath)}.${stat.mtimeMs}.${stat.size}.${BUCKETS}.json`;
    return { dir, file: path.join(dir, key) };
}

/**
 * Peaks in 0..1, one per bucket, or null when they cannot be produced.
 *
 * Decoded to mono 8kHz s16le — the lowest rate that still shows the envelope,
 * because the shape of a cue is all a card needs and decoding a 4-minute score
 * at 48k to draw 96 bars is work nobody sees.
 */
async function waveformFor(sourcePath) {
    let stat;
    try { stat = fs.statSync(sourcePath); } catch (_) { return null; }

    const { dir, file } = cachePathFor(sourcePath, stat);
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { /* a corrupt cache entry is recomputed, never fatal */ }

    const bin = encoder();
    if (!bin) return null;

    const pcm = await new Promise(resolve => {
        execFile(bin, ['-v', 'quiet', '-i', sourcePath,
            '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
        { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
        (err, stdout) => resolve(err ? null : stdout));
    });
    if (!pcm || pcm.length < 2) return null;

    const samples = Math.floor(pcm.length / 2);
    const per = Math.max(1, Math.floor(samples / BUCKETS));
    const peaks = [];
    for (let b = 0; b < BUCKETS; b++) {
        let peak = 0;
        for (let i = b * per; i < Math.min((b + 1) * per, samples); i++) {
            const v = Math.abs(pcm.readInt16LE(i * 2));
            if (v > peak) peak = v;
        }
        peaks.push(+(peak / 32768).toFixed(3));
    }

    const out = { peaks, buckets: BUCKETS };
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(out));
    } catch (_) { /* an uncacheable waveform is still a usable one */ }
    return out;
}

module.exports = { waveformFor, CACHE_DIRNAME, BUCKETS };
