/**
 * What a capture may be, derived from the ceilings that actually bind it.
 *
 * Three separate limits sit between a phone and a reconstructed world and they
 * are not the same number: the body this engine accepts, that same body after
 * base64 inflation, and Marble's own cap on a video. A cap stated as a constant
 * would be wrong the moment any of the three moved, so every figure here is
 * COMPUTED from the place its ceiling is defined and carries the source.
 *
 * The number that makes this worth writing down: an iPhone shooting 4K60 —
 * which is the default on a modern one — produces about 400MB a minute, so it
 * breaches the smallest ceiling in roughly fifteen seconds. That is shorter
 * than any orbit worth reconstructing from, and it is discovered at upload
 * unless somebody says so first.
 */

const path = require('path');
const { FILE_LIMIT } = require('./body-limit');

/** Marble's own cap, from the contract ICP-004 probed and recorded. */
function marbleVideoCap() {
    // Read rather than copied: a second literal is how the two come to disagree.
    const c = require(path.join(__dirname, '..', 'tests', 'fixtures', 'marble-contract.json'));
    return { bytes: c.limits.video_max_bytes, source: c.limits.video_max_bytes_source };
}

const CEILINGS = Object.freeze({
    transport_raw: Object.freeze({
        bytes: FILE_LIMIT,
        source: 'backend/lib/body-limit.js FILE_LIMIT — the body this engine accepts',
    }),
    transport_base64: Object.freeze({
        /*
         * The same ceiling seen by anything that encodes. base64 is four thirds
         * of the bytes, so the file that fits is three quarters of the body —
         * and this is the number a director experiences, not FILE_LIMIT.
         */
        bytes: Math.floor(FILE_LIMIT * 3 / 4),
        source: 'the same body ceiling after base64 inflation, which is four thirds of the file',
    }),
    marble_video: Object.freeze(marbleVideoCap()),
});

/**
 * Capture modes and what they cost per second.
 *
 * Apple publishes these as MB-per-minute in the Camera settings screen, which
 * is where a director would look; they are nominal HEVC rates, not measured
 * here, and they are labelled as such rather than presented as exact.
 */
const MODES = Object.freeze({
    '1080p30': Object.freeze({
        bytes_per_second: Math.round(45 * 1048576 / 60),
        label: '1080p at 30fps',
        source: "Apple's published iPhone figure, about 45MB per minute (HEVC, nominal)",
    }),
    '4k30': Object.freeze({
        bytes_per_second: Math.round(135 * 1048576 / 60),
        label: '4K at 30fps',
        source: "Apple's published iPhone figure, about 135MB per minute (HEVC, nominal)",
    }),
    '4k60': Object.freeze({
        bytes_per_second: Math.round(400 * 1048576 / 60),
        label: '4K at 60fps',
        source: "Apple's published iPhone figure, about 400MB per minute (HEVC, nominal)",
    }),
});

/** The smallest ceiling — the one that actually decides. */
function bindingBytes() {
    return Math.min(...Object.values(CEILINGS).map((c) => c.bytes));
}

/** How many seconds of this mode fit under the binding ceiling. */
function maxSecondsFor(mode) {
    const m = MODES[mode];
    if (!m) throw new Error(`unknown capture mode ${mode}`);
    return Math.floor(bindingBytes() / m.bytes_per_second);
}

/**
 * What to actually shoot.
 *
 * The longest usable clip, not the highest resolution: a world is
 * reconstructed from COVERAGE of a room, so fifteen seconds of 4K is worth less
 * than two minutes of 1080p. Chosen rather than hardcoded, so a change to any
 * ceiling moves the advice.
 */
function recommended() {
    const best = Object.keys(MODES)
        .map((mode) => ({ mode, max_seconds: maxSecondsFor(mode) }))
        .sort((a, b) => b.max_seconds - a.max_seconds)[0];
    return {
        ...best,
        why: `${MODES[best.mode].label} fits ${best.max_seconds}s under the binding ceiling of `
            + `${Math.floor(bindingBytes() / 1048576)}MB. A world is reconstructed from coverage of a `
            + 'room, so a longer clip at this resolution is worth more than a short one at a higher '
            + 'resolution — 4K60 allows only ' + maxSecondsFor('4k60') + 's.',
    };
}

/**
 * May this capture be uploaded?
 *
 * A still is bound by the TRANSPORT and a clip by MARBLE. Holding a panorama to
 * the video cap would refuse a perfectly good 120MB pano, and holding a clip to
 * the transport cap would accept one Marble then rejects — which is a paid
 * round trip to learn something knowable here.
 */
function checkCapture(input) {
    const { kind, bytes } = input || {};
    const ceiling = kind === 'video' ? CEILINGS.marble_video : CEILINGS.transport_base64;
    if (!(bytes > ceiling.bytes)) return { ok: true, ceiling };
    const mb = (n) => `${Math.floor(n / 1048576)}MB`;
    return {
        ok: false,
        ceiling,
        why: kind === 'video'
            ? `That clip is ${mb(bytes)}. Marble accepts ${mb(ceiling.bytes)} of video — `
                + `${recommended().why}`
            : `That file is ${mb(bytes)}. The upload ceiling is ${mb(ceiling.bytes)} of file.`,
    };
}

module.exports = { CEILINGS, MODES, bindingBytes, maxSecondsFor, recommended, checkCapture };
