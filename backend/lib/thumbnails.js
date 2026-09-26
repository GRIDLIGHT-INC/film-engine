/**
 * A 260px card should not cost 1.5MB.
 *
 * Storyboard frames are generated at the project's delivery size — 1376x768 and
 * up — and the board renders them into thumbnails a quarter that wide. On a real
 * 13-shot project that is **19.8MB downloaded to draw thirteen postage stamps**,
 * every time the page is opened, and it is why moving between sections feels
 * slow. Nothing is broken; the browser is faithfully fetching full-resolution
 * pictures in order to throw away nine tenths of every one.
 *
 * The encoder is already here. `ffmpeg-static` was added for the sequence stitch
 * and the conform, so resizing needs no new dependency — which is the only
 * reason this is worth doing at the serving layer rather than by generating
 * thumbnails at write time and having to backfill every asset that already
 * exists.
 *
 * Three rules:
 *
 *   - **Cached by SOURCE IDENTITY, not by name.** The cache key carries the
 *     source's mtime and size, so a regenerated frame — which overwrites the
 *     same filename — misses the cache and rebuilds. Keying on the name alone
 *     would serve the old picture forever, which is the exact defect
 *     `frameSrc()` had to fix in the browser.
 *   - **Never fails the request.** No encoder, a broken source, a race: serve
 *     the original. A thumbnail is an optimisation, and an optimisation that can
 *     take down the picture is a liability.
 *   - **Only shrinks.** Asking for a width larger than the source returns the
 *     source rather than upscaling, which would cost time to produce something
 *     worse.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { resolveFfmpeg } = require('./ffmpeg');

/** Widths we will actually produce. A free-text width is a disk-filling hole. */
const WIDTHS = [160, 320, 480, 640, 960];

const CACHE_DIRNAME = '.thumbs';

/** Snap a requested width to the nearest allowed one at or above it. */
function normalizeWidth(requested) {
    const w = Number(requested);
    if (!Number.isFinite(w) || w <= 0) return null;
    return WIDTHS.find(x => x >= w) || null;   // above the largest → serve the original
}

function cachePathFor(sourcePath, width) {
    let st;
    try { st = fs.statSync(sourcePath); } catch (_) { return null; }
    // Identity, not name: a regenerated frame keeps its filename and must miss.
    const key = `${path.basename(sourcePath)}.${st.mtimeMs.toFixed(0)}.${st.size}.${width}.jpg`;
    return path.join(path.dirname(sourcePath), CACHE_DIRNAME, key);
}

const inFlight = new Map();

/**
 * A JPEG of `sourcePath` no wider than `width`, or null to serve the original.
 * Never throws.
 */
async function thumbnailFor(sourcePath, requestedWidth) {
    const width = normalizeWidth(requestedWidth);
    if (!width) return null;
    if (!/\.(png|jpe?g|webp)$/i.test(sourcePath)) return null;

    const out = cachePathFor(sourcePath, width);
    if (!out) return null;
    if (fs.existsSync(out)) return out;

    // One build per file: a board opening paints thirteen cards at once, and
    // thirteen encoders racing on one output writes a torn file.
    if (inFlight.has(out)) { try { return await inFlight.get(out); } catch (_) { return null; } }

    const job = (async () => {
        const bin = resolveFfmpeg();
        if (!bin || !bin.available) return null;
        try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch (_) { return null; }

        const tmp = `${out}.${process.pid}.tmp.jpg`;
        const args = [
            '-y', '-loglevel', 'error', '-i', sourcePath,
            // Only ever downscale: -1 keeps the aspect, and min() leaves a
            // source narrower than the target untouched.
            '-vf', `scale='min(${width},iw)':-2:flags=lanczos`,
            '-q:v', '4', tmp,
        ];
        const ok = await new Promise(resolve => {
            execFile(bin.bin, args, { timeout: 20000 }, err => resolve(!err));
        });
        if (!ok) { try { fs.unlinkSync(tmp); } catch (e) { console.error('[thumbnails] could not remove a temporary file:', e.message); } return null; }
        try {
            // Rename is atomic on one filesystem, so a reader never sees a
            // half-written thumbnail.
            fs.renameSync(tmp, out);
        } catch (_) { try { fs.unlinkSync(tmp); } catch (e) { console.error('[thumbnails] could not remove a temporary file:', e.message); } return null; }
        return out;
    })().finally(() => inFlight.delete(out));

    inFlight.set(out, job);
    try { return await job; } catch (_) { return null; }
}

/**
 * A keyframe small enough to send INLINE to a video model.
 *
 * The house standard makes a board frame 4K, and a 4K PNG is ~10MB — twice
 * Runway's documented 5MB ceiling for a data URI. So every 4K keyframe was
 * refused for the clip it existed to pin: the image-to-video call either sent
 * no frame at all or was refused before spending. A video model renders at 720p
 * to 1080p and cannot use the extra pixels anyway, so it is handed a JPEG at a
 * 1920 long edge — the SAME frame, the size the clip is actually made at.
 *
 * Synchronous, because the payload is built synchronously. Cached by source
 * identity like a thumbnail, so a regenerated frame misses and rebuilds. Never
 * throws: no encoder or a failed encode returns null and the caller keeps the
 * original.
 */
function videoKeyframeFor(sourcePath, longEdge) {
    const edge = Number(longEdge) > 0 ? Number(longEdge) : 1920;
    if (!/\.(png|jpe?g|webp)$/i.test(sourcePath || '')) return null;
    let st;
    try { st = fs.statSync(sourcePath); } catch (_) { return null; }
    const out = path.join(path.dirname(sourcePath), CACHE_DIRNAME,
        `${path.basename(sourcePath)}.${st.mtimeMs.toFixed(0)}.${st.size}.video${edge}.jpg`);
    if (fs.existsSync(out)) return out;
    const bin = resolveFfmpeg();
    if (!bin || !bin.available) return null;
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch (_) { return null; }
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    try {
        require('child_process').execFileSync(bin.bin, [
            '-y', '-loglevel', 'error', '-i', sourcePath,
            // Long edge to `edge`, only ever down, aspect kept, even dimensions.
            '-vf', `scale='if(gte(iw,ih),min(${edge},iw),-2)':'if(gte(iw,ih),-2,min(${edge},ih))':flags=lanczos`,
            '-q:v', '2', tmp,
        ], { timeout: 30000, stdio: 'ignore' });
        fs.renameSync(tmp, out);
        return out;
    } catch (_) {
        try { fs.unlinkSync(tmp); } catch (e) { console.error('[thumbnails] could not remove a temporary file:', e.message); }
        return null;
    }
}

module.exports = { thumbnailFor, normalizeWidth, WIDTHS, CACHE_DIRNAME, videoKeyframeFor };
