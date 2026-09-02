/**
 * What size a picture on disk actually IS.
 *
 * Read from the file header rather than from what the engine asked for, because
 * those are different numbers and the difference is the whole problem: this
 * project asked its image provider for 1368x768 and got 1376x768 back — the
 * provider re-quantised to its own grid, silently, and nothing looked at the
 * result. A generator's answer is evidence; a generator's request is a hope.
 *
 * Header-only and dependency-free. A storyboard frame is megabytes and decoding
 * one to learn two integers is work nobody needs done.
 */

const fs = require('fs');

/**
 * The same read, from bytes already in hand.
 *
 * Split out because the conform happens BEFORE the frame is written — the
 * archive of previous attempts must hold the same raster as the live board, and
 * conforming after the write would leave every archived version off-spec.
 *
 * @returns {{width:number,height:number}|null}
 */
function dimensionsOfBuffer(buf) {
    try {
        if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
        if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            let pos = 2;
            while (pos < buf.length - 9) {
                if (buf[pos] !== 0xff) { pos += 1; continue; }
                const marker = buf[pos + 1];
                const len = buf.readUInt16BE(pos + 2);
                if (marker >= 0xc0 && marker <= 0xcf
                    && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
                }
                if (len < 2) break;
                pos += 2 + len;
            }
        }
        return null;
    } catch (_) { return null; }
}

/** @returns {{width:number,height:number}|null} */
function readDimensions(filePath) {
    let fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const head = Buffer.alloc(64);
        fs.readSync(fd, head, 0, 64, 0);

        // PNG: 8-byte signature, then IHDR whose first two fields are the size.
        if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
        }

        // JPEG: walk the segment chain to the first frame header.
        if (head[0] === 0xff && head[1] === 0xd8) {
            const size = fs.fstatSync(fd).size;
            let pos = 2;
            const buf = Buffer.alloc(9);
            while (pos < size - 9) {
                fs.readSync(fd, buf, 0, 9, pos);
                if (buf[0] !== 0xff) { pos += 1; continue; }
                const marker = buf[1];
                const len = buf.readUInt16BE(2);
                // SOF0..SOF15, excluding the four that are not frame headers.
                if (marker >= 0xc0 && marker <= 0xcf
                    && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { height: buf.readUInt16BE(5), width: buf.readUInt16BE(7) };
                }
                if (len < 2) break;
                pos += 2 + len;
            }
        }
        return null;
    } catch (_) {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
}

/**
 * Whether the pictures a video generation will be pinned to actually carry the
 * shape the project says it delivers in.
 *
 * THIS IS NOT COSMETIC, and it is not something the `aspect_ratio` field fixes.
 * Seedance derives its output raster from the KEYFRAME it is handed, not from
 * the aspect ratio sent beside it. Measured on this project: legs whose first
 * frame was 1376x768 (1.792:1) came back 1926x1076 (1.790:1), while the leg
 * whose frames were a true 1920x1080 came back exactly 1920x1080 — three legs
 * of one sequence in two different rasters, which is a stitch that will not
 * join and a conform that cannot hit its spec.
 *
 * So the frames are measured BEFORE the money is spent, and a mismatch is
 * reported rather than discovered in an NLE.
 */
const TOLERANCE = 0.005;   // half a percent: below this no editor will see it

function keyframeRasterReport(aspect, frames) {
    const m = String(aspect || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i);
    const want = m ? Number(m[1]) / Number(m[2]) : null;

    const seen = [];
    for (const f of (frames || [])) {
        if (!f || !f.uri) continue;
        const dim = readDimensions(f.uri);
        if (!dim || !dim.width || !dim.height) continue;
        seen.push({ uri: f.uri, shot_code: f.shot_code || null,
                    width: dim.width, height: dim.height, ratio: dim.width / dim.height });
    }
    if (!seen.length) return null;

    const offSpec = want
        ? seen.filter(s => Math.abs(s.ratio - want) / want > TOLERANCE)
        : [];
    const rasters = [...new Set(seen.map(s => `${s.width}x${s.height}`))];

    const notes = [];
    if (offSpec.length) {
        const worst = offSpec[0];
        notes.push(`${offSpec.length} of ${seen.length} keyframe(s) are not ${aspect}: `
            + `${worst.width}x${worst.height} is ${worst.ratio.toFixed(4)}:1 against ${want.toFixed(4)}:1. `
            + 'The video model takes its output raster from the keyframe, NOT from the aspect_ratio '
            + 'field — so the footage will come back in the frame\'s shape, not the project\'s.');
    }
    if (rasters.length > 1) {
        notes.push(`These keyframes are not all the same size (${rasters.join(', ')}). Legs generated `
            + 'from them will come back in different rasters, which will not stitch and cannot be '
            + 'conformed to one spec without a rescale.');
    }
    return notes.length ? { notes, rasters, frames: seen } : null;
}

module.exports = { readDimensions, dimensionsOfBuffer, keyframeRasterReport, TOLERANCE };
