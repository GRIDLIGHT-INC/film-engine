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
 * The advanced formats, and how the DEVICE is asked whether it has them.
 *
 * A MODEL STRING IS THE WRONG GATE and it fails in both directions: it has
 * never heard of the phone that shipped this morning — which is exactly the one
 * with the feature — and it goes stale again when Apple brings a capability to
 * older hardware. Asking the device needs no maintenance and is right on both
 * counts.
 *
 * Every symbol below was PROBED out of the installed SDK rather than recalled:
 *   AVCaptureColorSpace_AppleLog2 .......... ios(26.0)
 *   AVVideoCodecTypeAppleProResRAW ......... ios(26.0), NS_SWIFT_NAME(proResRAW)
 *   availableVideoCodecTypesForAssetWriterWithOutputFileType: ... ios(11.0)
 *
 * Open gate has NO symbol anywhere in AVFoundation, and that is a finding
 * rather than an omission: it is a FORMAT, not a flag, so the only honest gate
 * is asking the device which formats it has — and its raster must be read from
 * the one it reports rather than typed here, because nothing published gives a
 * pixel count for it.
 */
const CAPABILITIES = Object.freeze({
    apple_log2: Object.freeze({
        label: 'Apple Log 2',
        min_ios: '26.0',
        probe: "the active format's own supportedColorSpaces list is asked whether it contains "
            + 'appleLog2',
        probe_symbol: 'supportedColorSpaces',
        degrade: 'This camera cannot record Apple Log 2 — the take records the log format it can, '
            + 'and can still be graded.',
    }),
    prores_raw: Object.freeze({
        label: 'ProRes RAW',
        min_ios: '26.0',
        /*
         * The right probe for an AVAssetWriter pipeline, and the SDK says so:
         * this list is what may be used for AVVideoCodecKey with an asset
         * writer, and passing anything absent from it raises.
         */
        probe: 'the video output is asked which codecs it can hand an asset writer for a '
            + 'QuickTime movie, and whether proResRAW is among them',
        probe_symbol: 'availableVideoCodecTypesForAssetWriter',
        degrade: 'This camera cannot record ProRes RAW — the take records ProRes 422, which is '
            + 'the closest format it has.',
    }),
    open_gate: Object.freeze({
        label: 'open gate',
        min_ios: '26.0',
        probe: "the device's own format list is walked for the full-sensor one, because there is "
            + 'no open-gate flag in AVFoundation to ask for',
        probe_symbol: 'CMVideoFormatDescriptionGetDimensions',
        degrade: 'This camera has no open-gate format — the take records the ordinary 16:9 crop '
            + 'of the sensor.',
    }),
});

/**
 * What the writer can encode, and what can carry it.
 *
 * The container is not decoration: ProRes cannot be written into an mp4, and a
 * writer that discovers that when the director presses record has already lost
 * the take. Naming it per codec means the file type follows the format rather
 * than being remembered.
 */
const CODECS = Object.freeze({
    hevc: Object.freeze({
        label: 'HEVC',
        container: 'mov',
        source: "Apple's published iPhone figures are HEVC; every mode before FCC-007 was this",
    }),
    prores422: Object.freeze({
        label: 'ProRes 422',
        container: 'mov',
        source: 'ProRes is a QuickTime codec — an mp4 cannot carry it',
    }),
    prores422hq: Object.freeze({
        label: 'ProRes 422 HQ',
        container: 'mov',
        source: 'ProRes is a QuickTime codec — an mp4 cannot carry it',
    }),
    prores_raw: Object.freeze({
        label: 'ProRes RAW',
        container: 'mov',
        source: 'AVVideoCodecTypeAppleProResRAW, ios(26.0), probed from the installed SDK; also '
            + 'a QuickTime codec',
    }),
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
        color_space: 'rec709',
        codec: 'hevc',
        transports: Object.freeze(['upload']),
        label: '1080p at 30fps',
        source: "Apple's published iPhone figure, about 45MB per minute (HEVC, nominal)",
    }),
    '4k30': Object.freeze({
        bytes_per_second: Math.round(135 * 1048576 / 60),
        color_space: 'rec709',
        codec: 'hevc',
        transports: Object.freeze(['upload']),
        label: '4K at 30fps',
        source: "Apple's published iPhone figure, about 135MB per minute (HEVC, nominal)",
    }),
    '4k60': Object.freeze({
        bytes_per_second: Math.round(400 * 1048576 / 60),
        color_space: 'rec709',
        codec: 'hevc',
        transports: Object.freeze(['upload']),
        label: '4K at 60fps',
        source: "Apple's published iPhone figure, about 400MB per minute (HEVC, nominal)",
    }),
    /*
     * The gradeable one, added by FCC-005 (GRD-3801).
     *
     * It is a SEPARATE mode rather than a flag on 4k30 because it costs half as
     * much again: 200MB/min against 135. Pricing log at the Rec.709 rate would
     * promise a 44-second take and deliver about 30 — the failure discovered at
     * upload that this whole module exists to prevent.
     *
     * ONLY 4K30 is offered in log, and that is deliberate. It is the one rate
     * the epic publishes a figure for; inventing rates for 1080p30 and 4K60 log
     * would put numbers nobody measured in front of a director, and a duration
     * that is confidently wrong is worse than one that is absent. A measured
     * figure — or FCC-011, which extends this table to every format — adds them.
     */
    '4k30-log': Object.freeze({
        bytes_per_second: Math.round(200 * 1048576 / 60),
        color_space: 'apple_log',
        codec: 'hevc',
        transports: Object.freeze(['upload']),
        label: '4K at 30fps, Apple Log',
        source: 'the FCC epic\'s own figure for HEVC Apple Log at 4K30, about 200MB per minute',
    }),

    /*
     * PRORES — added by FCC-007 (GRD-3803), and every one of them REFUSED.
     *
     * They travel only by `external`, which does not exist until FCC-009, so
     * `formatChoices()` refuses them with that transport's remedy and the
     * picker shows them greyed with the reason. That is the epic's constraint
     * — "must not be offered without FCC-009" — expressed as a rule rather
     * than remembered: declaring `upload` here would offer them immediately.
     *
     * THE ANCHOR IS 1.7 GB/min FOR 422 HQ AT 1080p30. The brief states it and
     * `fcc-parity-brief.test.js` recomputes its "3 seconds" headline from it,
     * so the registry must reproduce that or two documents state two different
     * costs for one format. Everything else is DERIVED and flagged `inferred`,
     * on the `provider-pricing.js` precedent: a figure that is not published is
     * marked rather than quietly averaged, because FCC-009 and FCC-011 will
     * trust these and a derived number presented as fact is one nobody
     * re-checks.
     *
     * The 4K derivation corroborates independently: four times the pixels at
     * the same rate gives 6.8 GiB/min, and the epic's own figure is "~7 GB/min
     * at 4K30", arrived at separately.
     */
    '1080p30-prores422hq': Object.freeze({
        bytes_per_second: Math.round(1.7 * 1024 * 1048576 / 60),
        color_space: 'rec709',
        codec: 'prores422hq',
        transports: Object.freeze(['external']),
        label: 'ProRes 422 HQ, 1080p at 30fps',
        source: "Apple's published iPhone figure, 1.7 GB per minute — the same number the brief "
            + 'states and fcc-parity-brief recomputes its 3-second headline from',
    }),
    '4k30-prores422hq': Object.freeze({
        // Four times the pixels of the anchor above, at the same frame rate.
        bytes_per_second: Math.round(1.7 * 4 * 1024 * 1048576 / 60),
        color_space: 'rec709',
        codec: 'prores422hq',
        transports: Object.freeze(['external']),
        inferred: true,
        label: 'ProRes 422 HQ, 4K at 30fps',
        source: 'derived from the 1080p30 anchor — four times the pixels at the same rate, giving '
            + "6.8 GiB/min, which corroborates the epic's separately-stated ~7 GB/min at 4K30",
    }),
    '1080p30-prores422': Object.freeze({
        // Apple publishes ProRes 422 and 422 HQ target data rates as 147 and
        // 220 Mbps at 1080p; the ratio is what carries across.
        bytes_per_second: Math.round(1.7 * (147 / 220) * 1024 * 1048576 / 60),
        color_space: 'rec709',
        codec: 'prores422',
        transports: Object.freeze(['external']),
        inferred: true,
        label: 'ProRes 422, 1080p at 30fps',
        source: "derived from the 422 HQ anchor by Apple's published ProRes target data-rate "
            + 'ratio, 147 against 220 Mbps at 1080p',
    }),
    /*
     * THE HARDWARE TIER — added by FCC-008 (GRD-3804), and each declares the
     * capability it needs so a phone without it is told rather than failing.
     *
     * Neither rate is published. Apple states no iPhone figure for Apple Log 2
     * or for ProRes RAW, so both are DERIVED from an anchored sibling and
     * flagged — the rule FCC-007 had to strengthen after a mutation walked
     * through a one-directional version of it.
     *
     * OPEN GATE HAS NO ENTRY HERE, deliberately. Its raster is a property of
     * the sensor and nothing published gives a pixel count, so a fixed mode
     * would be an invented number for hardware nobody here has measured. The
     * camera builds it from the format the device reports, or does not offer
     * it at all.
     */
    '4k30-log2': Object.freeze({
        // The same HEVC encoder at the same target; only the transfer function
        // differs, so the rate is Apple Log's.
        bytes_per_second: Math.round(200 * 1048576 / 60),
        color_space: 'apple_log2',
        codec: 'hevc',
        transports: Object.freeze(['upload']),
        requires: Object.freeze(['apple_log2']),
        inferred: true,
        label: '4K at 30fps, Apple Log 2',
        source: 'derived — the same rate as Apple Log at 4K30, because it is the same HEVC '
            + 'encoder at the same target and only the transfer function differs',
    }),
    '4k30-prores_raw': Object.freeze({
        // Apple describes ProRes RAW as comparable in size to ProRes 422.
        bytes_per_second: Math.round(1.7 * 4 * (147 / 220) * 1024 * 1048576 / 60),
        color_space: 'rec709',
        codec: 'prores_raw',
        transports: Object.freeze(['external']),
        requires: Object.freeze(['prores_raw']),
        inferred: true,
        label: 'ProRes RAW, 4K at 30fps',
        source: 'derived — the same rate as ProRes 422 at 4K30, which is the comparison Apple '
            + 'itself draws for ProRes RAW file sizes',
    }),

    '4k30-prores422': Object.freeze({
        bytes_per_second: Math.round(1.7 * 4 * (147 / 220) * 1024 * 1048576 / 60),
        color_space: 'rec709',
        codec: 'prores422',
        transports: Object.freeze(['external']),
        inferred: true,
        label: 'ProRes 422, 4K at 30fps',
        source: 'derived from the 422 HQ anchor by four times the pixels and Apple\'s published '
            + 'ProRes ratio of 147 against 220 Mbps',
    }),
});

/**
 * The ways footage can leave the phone.
 *
 * A format is not usable because it can be RECORDED — it is usable because the
 * file can then go somewhere. ProRes is roughly seven gigabytes a minute, which
 * is under a second of the ceiling below, so recording it without somewhere to
 * put it produces takes nothing can carry.
 *
 * An absent transport declares its REMEDY, and that is the whole point of
 * declaring it at all. Refusing a format with no way forward is a dead end; the
 * value of the refusal is telling a director what would make it work.
 */
const TRANSPORTS = Object.freeze({
    upload: Object.freeze({
        label: 'uploaded to the Mac',
        available: true,
        source: 'the ceilings above — the body this engine accepts, after base64 inflation, '
            + "against Marble's own cap on a video",
    }),
    external: Object.freeze({
        /*
         * Declared before it exists, deliberately. FCC-007 adds ProRes and the
         * epic says it "must not be offered without FCC-009"; without an absent
         * transport to refuse against, that rule has nothing to hang on and the
         * first format needing it ships offered.
         */
        label: 'recorded straight to an external USB-C drive',
        available: false,
        remedy: 'recording to external USB-C storage is not built yet (FCC-009) — until it is, '
            + 'there is nowhere to put a file this size',
        source: 'FCC-009 in docs/plans/fcc-parity-epic.md',
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

/**
 * What a director is choosing between, and what each choice costs.
 *
 * THE COST IS THE POINT, NOT THE LIST. "4K60" and "4K30 Apple Log" are two
 * equal-looking buttons until the durations are on them: 14 seconds against 30,
 * on the same phone, against the same ceiling. Every choice therefore carries
 * what it costs a minute, how long a take may be, and how the file will leave
 * the phone.
 *
 * A REFUSED FORMAT IS RETURNED, NOT OMITTED. Dropping it would make a format
 * that needs a drive indistinguishable from one that was never built, and the
 * director would never learn that a drive is what closes it.
 *
 * `extra` exists so the refusal rules can be exercised without adding a format
 * to the shipped registry to test them — which is how a probe becomes a mode.
 */
function formatChoices(extra = []) {
    const entries = [
        ...Object.entries(MODES).map(([id, m]) => ({ id, ...m })),
        ...extra,
    ];
    return entries.map((m) => {
        const perSecond = m.bytes_per_second;
        const maxSeconds = Math.floor(bindingBytes() / perSecond);
        const declared = m.transports || [];

        /*
         * The first DECLARED transport that is actually available. Order is the
         * format's own preference; availability is the world's answer.
         */
        const usable = declared.find((t) => TRANSPORTS[t] && TRANSPORTS[t].available);
        const choice = {
            id: m.id,
            label: m.label,
            color_space: m.color_space,
            mb_per_min: Math.round(perSecond * 60 / 1048576),
            max_seconds: maxSeconds,
            transport: usable || null,
            transport_label: usable ? TRANSPORTS[usable].label : null,
            offered: true,
            refusal: null,
        };

        if (!usable) {
            // Refused because there is nowhere for the file to go. The remedy
            // is carried through verbatim: being told no without being told
            // what would work is a dead end.
            const first = declared.map((t) => TRANSPORTS[t]).find(Boolean);
            choice.offered = false;
            choice.refusal = first
                ? `${m.label} travels only by ${first.label}, and ${first.remedy}.`
                : `${m.label} declares no way to leave the phone, so a take could not be delivered.`;
            return choice;
        }

        if (maxSeconds < 1) {
            /*
             * A different refusal from the one above, and both are needed. The
             * transport can be perfectly available and still far too small: at
             * ~7GB/min ProRes is 117MB a second against a 100MB ceiling, so
             * "offered, 0 seconds" is a button that cannot produce one usable
             * frame.
             */
            choice.offered = false;
            choice.refusal = `${m.label} costs ${choice.mb_per_min}MB a minute, which does not fit `
                + `one second under the ${Math.floor(bindingBytes() / 1048576)}MB ceiling. It needs `
                + `a larger transport before it can be recorded at all.`;
        }
        return choice;
    });
}

module.exports = {
    CEILINGS, MODES, CODECS, CAPABILITIES, TRANSPORTS, bindingBytes, maxSecondsFor, recommended, checkCapture,
    formatChoices,
};
