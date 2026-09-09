/**
 * What a capture may be, derived from the ceilings that actually bind it.
 *
 * Three separate limits sit between a phone and a finished film and they are
 * not the same number: the body this engine accepts, that same body after
 * base64 inflation, and Marble's own cap on a video. A cap stated as a constant
 * would be wrong the moment any of the three moved, so every figure here is
 * COMPUTED from the place its ceiling is defined and carries the source.
 *
 * EVERY ONE OF THEM ALSO SAYS WHAT IT BINDS, which is what FCC-011 added and
 * the reason the durations were wrong for as long as they were. The three were
 * reduced with a blind `Math.min` and the answer applied to everything — and
 * the smallest is World Labs' cap on a video handed to Marble, so a shot
 * recorded for the CUT was priced against a service it never reaches. A
 * director shooting 4K60 was told to stop at fourteen seconds when twenty-two
 * fit; 4K30 said 44 against 66; 1080p30, the recommended mode, said 133 against
 * 200. A third of every take, thrown away by a limit belonging to something
 * else. `bindingBytesFor({transport, destination})` is the answer now and
 * `bindingBytes()` is gone: there is no such thing as THE ceiling, and leaving
 * an accessor that answers as though there were is how the next caller
 * reintroduces this.
 *
 * The number that makes the module worth writing down at all: an iPhone
 * shooting 4K60 — the default on a modern one — produces about 400MB a minute,
 * so it breaches even the upload ceiling in under half a minute. That is
 * shorter than many useful shots, and it is discovered at upload unless
 * somebody says so first.
 */

const path = require('path');
const { FILE_LIMIT } = require('./body-limit');

/** Marble's own cap, from the contract ICP-004 probed and recorded. */
function marbleVideoCap() {
    // Read rather than copied: a second literal is how the two come to disagree.
    const c = require(path.join(__dirname, '..', 'tests', 'fixtures', 'marble-contract.json'));
    return { bytes: c.limits.video_max_bytes, source: c.limits.video_max_bytes_source };
}

/**
 * WHERE the footage is going. A ceiling that belongs to a destination binds
 * only the captures that actually travel there.
 *
 * Two, and the distinction is the whole of FCC-011: a world capture is handed
 * to World Labs and is capped by what World Labs accepts; a shot recorded for
 * the cut goes into the film and never meets that service at all. Applying one
 * to the other is how Marble's 100MB came to shorten every take in the picture.
 */
const DESTINATIONS = Object.freeze({
    footage: Object.freeze({
        label: 'the film',
        source: 'a take that goes into the cut — it reaches this engine and stops there',
    }),
    world: Object.freeze({
        label: "World Labs' Marble",
        source: 'a capture handed to a reconstruction service, which has its own limits',
    }),
});

/**
 * The ceilings, and WHAT EACH ONE BINDS.
 *
 * `applies_to` is the field this module was missing and the reason the numbers
 * were wrong. A ceiling is not a property of the engine, it is a property of a
 * ROUTE — a transport, an encoding, a destination, sometimes a medium — and a
 * ceiling that declares none of those is one a blind minimum applies to
 * everything. A route is bound by a ceiling only when it matches EVERY
 * dimension that ceiling names.
 */
const CEILINGS = Object.freeze({
    transport_raw: Object.freeze({
        bytes: FILE_LIMIT,
        label: 'the upload to the Mac',
        applies_to: Object.freeze({
            transports: Object.freeze(['upload']),
            encodings: Object.freeze(['raw']),
        }),
        source: 'backend/lib/body-limit.js FILE_LIMIT — the body this engine accepts',
    }),
    transport_base64: Object.freeze({
        /*
         * The same ceiling seen by anything that ENCODES. base64 is four thirds
         * of the bytes, so the file that fits is three quarters of the body.
         *
         * FCC-010 moved media off this path — a take travels raw and in chunks
         * now — so this is no longer the number a director experiences when
         * shooting. It is still live for everything that arrives as a `data:`
         * URI, which is how the page and the world-capture route still post,
         * and that is exactly why it now says so: a right number applied to the
         * wrong thing is worse than a wrong number, because nobody re-checks it.
         */
        bytes: Math.floor(FILE_LIMIT * 3 / 4),
        label: 'the upload, base64-encoded',
        applies_to: Object.freeze({
            transports: Object.freeze(['upload']),
            encodings: Object.freeze(['base64']),
        }),
        source: 'the same body ceiling after base64 inflation, which is four thirds of the file',
    }),
    marble_video: Object.freeze({
        ...marbleVideoCap(),
        label: "Marble's own cap on a video",
        /*
         * A DESTINATION and a MEDIUM, never a transport. A world capture and a
         * shot video leave the phone the same way; only one of them is handed
         * to World Labs, and only its video is capped. Naming a transport here
         * would put this back in front of footage that never goes there.
         */
        applies_to: Object.freeze({
            destinations: Object.freeze(['world']),
            kinds: Object.freeze(['video']),
        }),
    }),
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
        /*
         * The one capability with no entry in MODES, and it is a decision
         * rather than a gap — so it is stated here where the completeness rule
         * can read it. Open gate's raster is a property of the SENSOR and
         * nothing published gives a pixel count, so a fixed mode would be an
         * invented rate for hardware nobody here has measured. The camera
         * builds it from the format the device reports, or does not offer it.
         */
        no_fixed_mode: 'its raster is the sensor\'s own and nothing published gives a pixel '
            + 'count, so a fixed rate here would be a number nobody measured — the camera reads '
            + 'it from the format the device reports instead',
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
         * Declared before it existed by FCC-006, so ProRes could be refused
         * with a remedy rather than offered or hidden. FCC-009 made the remedy
         * true.
         *
         * ITS AVAILABILITY IS A RUNTIME FACT. Whether a drive is plugged in is
         * a property of this moment, not of the policy, so a constant either
         * offers ProRes with no drive attached or refuses it with one. The
         * phone answers; this only says that the phone is who to ask.
         */
        label: 'recorded straight to an external USB-C drive',
        device_reported: true,
        available: false,
        /*
         * The ceiling is the DRIVE, and that matters by four orders of
         * magnitude: ProRes 422 HQ at 4K30 fits zero seconds under the 100MB
         * upload cap and about ninety on a terabyte.
         */
        ceiling_is: 'the free space the drive reports',
        remedy: 'no external drive is attached — plug in a USB-C drive the camera can record to, '
            + 'and this format becomes available',
        source: 'AVExternalStorageDevice, ios(17.0), probed from the installed SDK',
    }),
});

/**
 * What is asked of a drive BEFORE the writer opens.
 *
 * "Discovering it afterwards costs the take." A drive that turns out to be too
 * slow four seconds into a ProRes take has not produced a shorter take — it has
 * produced a corrupt one, and the moment is gone.
 *
 * FOUR OF THE FIVE ARE THE OS'S OWN ANSWERS, probed out of
 * AVExternalStorageDevice.h (ios 17.0). `isNotRecommendedForCaptureUse` in
 * particular IS the speed-and-format verdict this task asks for: hand-rolling a
 * write benchmark would be slower, less accurate than the system's own answer,
 * and wear on a drive somebody paid for. The fifth is the one the OS cannot
 * know — whether there is room for THIS take — and is computed here.
 */
const DRIVE_CHECKS = Object.freeze({
    supported: Object.freeze({
        label: 'this phone can record to external storage',
        asks: 'whether the discovery session is supported on this hardware at all',
        symbol: 'AVExternalStorageDeviceDiscoverySession',
        refusal: 'This phone cannot record to external storage. The formats that need a drive '
            + 'are unavailable on it.',
    }),
    permitted: Object.freeze({
        label: 'permission to use it',
        /*
         * The trap the microphone already had: without permission the session
         * lists nothing, which is indistinguishable from nothing being plugged
         * in — and the director is sent to check a cable that is fine.
         */
        asks: 'the authorisation status, and asks for access once if nobody has been asked',
        symbol: 'authorizationStatus',
        refusal: 'Film Engine has not been allowed to use external storage, so no drive can be '
            + 'seen. Settings → Film Engine.',
    }),
    connected: Object.freeze({
        label: 'a drive is attached',
        asks: 'whether the discovered drive is still connected',
        symbol: 'isConnected',
        refusal: 'No external drive is attached. Plug in a USB-C drive to record this format.',
    }),
    suitable: Object.freeze({
        label: 'it is fast enough and formatted for capture',
        asks: "the system's own verdict on whether this drive should be recorded to",
        symbol: 'isNotRecommendedForCaptureUse',
        refusal: 'This drive is not fast enough to record to, or is not formatted for it. A '
            + 'USB-3 drive formatted exFAT is what these formats need.',
    }),
    room: Object.freeze({
        label: 'there is room for the take',
        /*
         * The one the OS cannot answer, because it depends on what is about to
         * be shot. A drive with a megabyte free is connected, suitable and
         * useless.
         */
        asks: 'the free space it reports, against what a second of the chosen format costs',
        symbol: 'freeSize',
        refusal: 'There is not enough room on the drive for a usable take in this format.',
    }),
});

/**
 * WHICH CEILINGS BIND THIS ROUTE.
 *
 * A route is four facts: how the bytes travel, how they are encoded, where
 * they are going, and what medium they are. A ceiling binds only when the
 * route matches EVERY dimension that ceiling names — a ceiling that names
 * nothing would bind everything, which is the blind minimum this replaced.
 *
 * An unstated dimension is the route's default, never a wildcard: the caller
 * has to be able to say "footage, over the upload, raw" and get one answer.
 */
function applicableCeilings(route) {
    const r = route || {};
    const transport = r.transport || 'upload';
    const destination = r.destination || 'footage';
    const encoding = r.encoding || 'raw';
    const kind = r.kind || null;

    if (!TRANSPORTS[transport]) throw new Error(`unknown transport ${transport}`);
    if (!DESTINATIONS[destination]) throw new Error(`unknown destination ${destination}`);

    return Object.entries(CEILINGS)
        .filter(([, c]) => {
            const a = c.applies_to || {};
            if (a.transports && !a.transports.includes(transport)) return false;
            if (a.destinations && !a.destinations.includes(destination)) return false;
            if (a.encodings && !a.encodings.includes(encoding)) return false;
            /*
             * A medium the caller did not state does NOT excuse a
             * medium-scoped ceiling. "How long may a take be" is asked without
             * saying "video", and answering it as though Marble's video cap
             * did not apply would be the old defect pointed the other way.
             */
            if (a.kinds && kind && !a.kinds.includes(kind)) return false;
            return true;
        })
        .map(([id, c]) => ({ id, ...c }));
}

/**
 * The ceiling that actually binds this route, and where its number came from.
 *
 * The smallest of the ones that APPLY — which is a different sentence from the
 * smallest there is, and the difference is a third of every take.
 *
 * A device-reported transport has no static number at all and says so rather
 * than inheriting one: a drive's ceiling is the free space the drive reports,
 * which is four orders of magnitude away from any body limit here. With no
 * drive attached the answer is zero, which is the truth — nothing fits on a
 * disk that is not there.
 */
function bindingCeilingFor(route) {
    const r = route || {};
    const transport = r.transport || 'upload';
    const t = TRANSPORTS[transport];
    if (!t) throw new Error(`unknown transport ${transport}`);

    if (t.device_reported) {
        return {
            id: transport,
            bytes: Number(r.free_bytes) > 0 ? Number(r.free_bytes) : 0,
            device_reported: true,
            label: t.ceiling_is,
            source: t.ceiling_is,
        };
    }

    const applicable = applicableCeilings(r);
    if (!applicable.length) {
        throw new Error(`no ceiling declares that it binds ${transport}; a route with no ceiling `
            + 'would be unbounded, which is never the honest answer');
    }
    return applicable.reduce((a, b) => (b.bytes < a.bytes ? b : a));
}

/** The binding ceiling in bytes. See `bindingCeilingFor` for which one, and why. */
function bindingBytesFor(route) {
    return bindingCeilingFor(route).bytes;
}

/**
 * The route a mode travels by default: its own first declared transport, into
 * the film. A capture MODE is always video, so a medium-scoped ceiling is
 * weighed rather than skipped.
 */
function routeFor(mode, opts) {
    const o = opts || {};
    return {
        transport: o.transport || (mode.transports || [])[0] || 'upload',
        destination: o.destination || 'footage',
        encoding: o.encoding || 'raw',
        kind: 'video',
        free_bytes: o.free_bytes,
    };
}

/**
 * How many seconds of this mode fit under the ceiling that binds IT.
 *
 * Not under the smallest ceiling anywhere. The two answers differ by a third
 * on every HEVC mode, and the smaller one belongs to a service most takes
 * never reach.
 */
function maxSecondsFor(mode, opts) {
    const m = MODES[mode];
    if (!m) throw new Error(`unknown capture mode ${mode}`);
    return Math.floor(bindingBytesFor(routeFor(m, opts)) / m.bytes_per_second);
}

/**
 * What to actually shoot.
 *
 * The longest usable clip, not the highest resolution: a world is
 * reconstructed from COVERAGE of a room, so fifteen seconds of 4K is worth less
 * than two minutes of 1080p. Chosen rather than hardcoded, so a change to any
 * ceiling moves the advice — and each mode is now weighed against the ceiling
 * that binds ITS route, so a format that travels by drive is not ranked against
 * a body limit it never meets.
 */
function recommended(opts) {
    const best = Object.keys(MODES)
        .map((mode) => ({ mode, max_seconds: maxSecondsFor(mode, opts) }))
        .sort((a, b) => b.max_seconds - a.max_seconds)[0];
    const ceiling = bindingCeilingFor(routeFor(MODES[best.mode], opts));
    return {
        ...best,
        ceiling: ceiling.id,
        why: `${MODES[best.mode].label} fits ${best.max_seconds}s under ${ceiling.label}, which is `
            + `${Math.floor(ceiling.bytes / 1048576)}MB. A world is reconstructed from coverage of `
            + 'a room, so a longer clip at this resolution is worth more than a short one at a '
            + 'higher resolution — 4K60 allows only ' + maxSecondsFor('4k60', opts) + 's.',
    };
}

/**
 * May this capture be sent to Marble?
 *
 * A still is bound by the TRANSPORT and a clip by MARBLE. Holding a panorama to
 * the video cap would refuse a perfectly good 120MB pano, and holding a clip to
 * the transport cap would accept one Marble then rejects — which is a paid
 * round trip to learn something knowable here. Both fall out of the route now
 * rather than being branched by hand: the destination is `world`, and the
 * medium decides whether Marble's cap is among the ceilings that apply.
 *
 * THE ENCODING DEFAULTS TO THE INFLATING ONE. A caller that does not say has
 * bytes of unknown provenance, and this function REFUSES — so the conservative
 * ceiling is the right default, and a caller who knows the bytes travelled raw
 * says so and gets the larger one.
 */
function checkCapture(input) {
    const { kind, bytes } = input || {};
    const route = {
        transport: 'upload',
        destination: 'world',
        encoding: (input && input.encoding) || 'base64',
        kind: kind === 'video' ? 'video' : 'image',
    };
    const ceiling = bindingCeilingFor(route);
    if (!(bytes > ceiling.bytes)) return { ok: true, ceiling };
    const mb = (n) => `${Math.floor(n / 1048576)}MB`;
    return {
        ok: false,
        ceiling,
        why: ceiling.id === 'marble_video'
            /*
             * The advice has to be about the SAME route as the refusal. Quoting
             * the footage figures here would tell a director that 1080p30 fits
             * 200 seconds in the very sentence refusing their 101MB clip — the
             * defect this task exists to remove, reappearing in its own error
             * message.
             */
            ? `That clip is ${mb(bytes)}. Marble accepts ${mb(ceiling.bytes)} of video — `
                + `${recommended({ destination: 'world' }).why}`
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
function formatChoices(extra = [], device = null) {
    /*
     * `device` is what the PHONE reports right now: which transports actually
     * exist, and for a drive how much room it has. Null means the static answer
     * — nothing plugged in — which is what every server-side caller sees and
     * what the app shows before a drive is attached.
     */
    const present = device && device.transports
        ? device.transports
        : Object.entries(TRANSPORTS).filter(([, t]) => t.available).map(([id]) => id);

    const entries = [
        ...Object.entries(MODES).map(([id, m]) => ({ id, ...m })),
        ...extra,
    ];
    return entries.map((m) => {
        const perSecond = m.bytes_per_second;
        const declared = m.transports || [];

        /*
         * The first DECLARED transport that is actually available. Order is the
         * format's own preference; availability is the world's answer.
         */
        const usable = declared.find((t) => TRANSPORTS[t] && present.includes(t));

        /*
         * THE CEILING IS THE TRANSPORT'S, and on a drive that is a different
         * number by four orders of magnitude: ProRes 422 HQ at 4K30 fits zero
         * seconds under the 100MB upload cap and about ninety on a terabyte.
         * Pricing an external format against the upload ceiling would offer
         * five formats that all read "0s max" — which looks broken rather than
         * available, and is the half of this task that is easy to miss.
         */
        /*
         * THE CEILING IS THE TRANSPORT'S, and on a drive that is a different
         * number by four orders of magnitude: ProRes 422 HQ at 4K30 fits about
         * a second under the upload ceiling and about ninety on a terabyte.
         *
         * A format with NO usable transport is priced at zero, not against the
         * upload it cannot take. Quoting the upload's figure there put a
         * plausible "5s max" beside a refusal saying the format needs a drive —
         * two answers to one question, and the smaller one is the one that
         * binds: nothing fits on a disk that is not there.
         */
        const ceiling = usable
            ? bindingCeilingFor({
                transport: usable,
                destination: 'footage',
                kind: 'video',
                free_bytes: device ? device.external_free_bytes : 0,
            })
            : { id: 'none', bytes: 0, label: 'no transport this format can take' };
        const maxSeconds = Math.floor(ceiling.bytes / perSecond);
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
                + `one second under the ${Math.floor(ceiling.bytes / 1048576)}MB ceiling of `
                + `${TRANSPORTS[usable].label}. It needs a larger transport before it can be `
                + 'recorded at all.';
        }
        return choice;
    });
}

module.exports = {
    CEILINGS, DESTINATIONS, MODES, CODECS, CAPABILITIES, TRANSPORTS, DRIVE_CHECKS,
    applicableCeilings, bindingCeilingFor, bindingBytesFor, routeFor,
    maxSecondsFor, recommended, checkCapture, formatChoices,
};
