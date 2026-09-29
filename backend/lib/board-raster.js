/**
 * A generated frame is stored at the size it was ASKED for.
 *
 * The engine asks an image provider for a raster and the provider answers on
 * its own terms. Two different ways, and they need two different corrections:
 *
 *   NEARLY RIGHT — Nano Banana via Meshy, asked 1368x768, returns 1376x768. A
 *   fraction of a percent of ratio drift, from the provider snapping to its own
 *   32-pixel grid. The fix is a CENTRE CROP: it loses a sliver of edge nobody
 *   framed for.
 *
 *   PROPORTIONALLY LARGER — Nano Banana via MuAPI, asked 2560x1440, serves its
 *   4k tier and returns 4096x2304. Same shape, more pixels. The fix here is a
 *   DOWNSCALE, and cropping would be a catastrophe: a centre crop of 4096x2304
 *   to 2560x1440 throws away 60% of the frame and returns a punched-in shot
 *   nobody composed. The first version of this file did exactly that.
 *
 * So the shape decides the correction. Ratio drift is cropped away; size is
 * scaled away; a frame that is both is cropped to the right SHAPE first and
 * then scaled to the right SIZE. Lanczos on the way down, because a board is
 * the keyframe a video model is pinned to and softness here becomes softness in
 * every frame of the clip.
 *
 * A frame SMALLER than the ask is left alone and reported. Upscaling invents
 * detail, and a slightly small frame that is honestly labelled beats a soft one
 * claiming to be sharp.
 *
 * Never throws. A frame that cannot be conformed is stored exactly as it
 * arrived: the generation is paid for either way, and bytes on disk beat a
 * clean raster that failed to save.
 */

const { dimensionsOfBuffer } = require('./image-raster');

/** Half a percent — below this no editor sees the difference. */
const RATIO_TOLERANCE = 0.005;

/**
 * The filter chain that takes `got` to exactly `want`, or null when nothing
 * needs doing. Pure and exported so the decision is testable without ffmpeg.
 */
function conformFilter(got, want) {
    const gw = got.width, gh = got.height, w = want.width, h = want.height;
    if (gw === w && gh === h) return null;
    if (gw < w || gh < h) return null;            // never upscale

    const wantRatio = w / h;
    const gotRatio = gw / gh;
    const even = n => Math.max(2, Math.round(n / 2) * 2);

    // The largest box of the TARGET shape that fits inside what arrived.
    let cw = gw, ch = gh;
    if (Math.abs(gotRatio - wantRatio) / wantRatio > RATIO_TOLERANCE) {
        if (gotRatio > wantRatio) { ch = gh; cw = even(Math.min(gw, gh * wantRatio)); }
        else { cw = gw; ch = even(Math.min(gh, gw / wantRatio)); }
    }

    const steps = [];
    // crop centres by default when x/y are omitted.
    if (cw !== gw || ch !== gh) steps.push(`crop=${cw}:${ch}`);
    if (cw !== w || ch !== h) steps.push(`scale=${w}:${h}:flags=lanczos`);
    return steps.length ? steps.join(',') : null;
}

/**
 * Conform the BYTES, before anything is written.
 *
 * Before, because the archive of earlier attempts is written from the same
 * buffer — conforming the live file afterwards would leave every archived
 * version at the provider's raster, and `shot_frames` restore would put an
 * off-spec frame straight back on the board.
 */
function conformBoardBuffer(buffer, want) {
    const w = Number(want && want.width), h = Number(want && want.height);
    if (!Buffer.isBuffer(buffer) || !(w > 0) || !(h > 0)) return { buffer, conformed: false };

    const got = dimensionsOfBuffer(buffer);
    if (!got) return { buffer, conformed: false, reason: 'could not read the frame' };
    if (got.width === w && got.height === h) return { buffer, conformed: false, exact: true, got };
    if (got.width < w || got.height < h) {
        return {
            buffer, conformed: false, got, wanted: { width: w, height: h },
            reason: `the provider returned ${got.width}x${got.height}, smaller than the ${w}x${h} `
                + 'asked for — left as it is, because upscaling a board invents detail.',
        };
    }

    const vf = conformFilter(got, { width: w, height: h });
    if (!vf) return { buffer, conformed: false, got };

    try {
        const { resolveFfmpeg } = require('./ffmpeg');
        const ff = resolveFfmpeg();
        if (!ff || !ff.available) return { buffer, conformed: false, got, reason: 'ffmpeg is not available here' };
        const { execFileSync } = require('child_process');
        const out = execFileSync(ff.bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', 'pipe:0', '-vf', vf, '-frames:v', '1',
            '-f', 'image2', '-vcodec', 'png', 'pipe:1'],
        { input: buffer, timeout: 120000, maxBuffer: 512 * 1024 * 1024 });
        if (!out || out.length < 512) return { buffer, conformed: false, got, reason: 'conform produced nothing' };
        return { buffer: out, conformed: true, from: got, to: { width: w, height: h }, filter: vf };
    } catch (err) {
        return { buffer, conformed: false, got, reason: err.message };
    }
}

module.exports = { conformBoardBuffer, conformFilter, RATIO_TOLERANCE };
