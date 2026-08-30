'use strict';

/**
 * -- A commercial is a fan-out, not a short film ----------------------------
 *
 * A film has ONE shape and this engine was built around that: a project carries
 * one aspect ratio, one resolution, one delivery preset. A commercial resolves
 * to fourteen to twenty-two FILES — a broadcast master, cut-downs, three or
 * four ratios, captions burned and sidecar, a textless version, stems and
 * end-frame stills.
 *
 * The set is decided BEFORE anything is generated, and the ordering is the
 * point rather than a convenience: the deliverable list is what says which
 * shots must be SHOT vertical rather than cropped later. A 9:16 centre crop of
 * a 16:9 frame keeps 32% of its width; 4:5 keeps 45%; 1:1 keeps 56%. Premiere's
 * Auto Reframe follows a subject inside the pixels it has — it cannot invent
 * the two-thirds that were never generated.
 *
 * Pure, on the `conform.js` / `run-plan.js` precedent: planning a deliverable
 * set is algebra over objects and is worth testing without a database. The
 * route persists what this returns; nothing here writes, reads or opens a
 * socket.
 *
 * Premiere RENDERS these. The engine plans them, emits one sequence per row,
 * and carries the target into the handoff — see §1 of the plan for the boundary
 * this module sits on.
 */

const { ASPECT_RATIO_IDS } = require('./project-presets');

/**
 * The delivery matrix as data.
 *
 * `native` is the load-bearing field: true means this ratio must be GENERATED,
 * not cropped from the master. Everything narrower than 16:9 carries it; 1:1 is
 * the deliberate exception, because 56% of the width survives and that is a
 * usable crop of a centred composition.
 */
const DELIVERY_PROFILES = [
    { id: 'bcast_na_30',  label: 'NA broadcast :30',     aspect: '16:9', width: 1920, height: 1080, fps: 29.97, duration_ms: 30000, platform: 'broadcast', loudness: '-24 LKFS', caption_mode: 'none',    native: false },
    { id: 'bcast_na_15',  label: 'NA broadcast :15',     aspect: '16:9', width: 1920, height: 1080, fps: 29.97, duration_ms: 15000, platform: 'broadcast', loudness: '-24 LKFS', caption_mode: 'none',    native: false },
    { id: 'bcast_uk_30',  label: 'UK/AU broadcast :30',  aspect: '16:9', width: 1920, height: 1080, fps: 25,    duration_ms: 30000, platform: 'broadcast', loudness: '-23 LUFS', caption_mode: 'none',    native: false },
    { id: 'ctv_30',       label: 'CTV programmatic :30', aspect: '16:9', width: 1920, height: 1080, fps: 29.97, duration_ms: 30000, platform: 'ctv',       loudness: '-24 LKFS', caption_mode: 'none',    native: false },
    { id: 'yt_30',        label: 'YouTube :30',          aspect: '16:9', width: 1920, height: 1080, fps: 29.97, duration_ms: 30000, platform: 'youtube',   loudness: '-14 LUFS', caption_mode: 'sidecar', native: false },
    { id: 'meta_feed_15', label: 'Meta feed :15',        aspect: '4:5',  width: 1080, height: 1350, fps: 30,    duration_ms: 15000, platform: 'meta',      loudness: '-14 LUFS', caption_mode: 'burned',  native: true  },
    { id: 'reels_15',     label: 'Reels/TikTok :15',     aspect: '9:16', width: 1080, height: 1920, fps: 30,    duration_ms: 15000, platform: 'tiktok',    loudness: '-14 LUFS', caption_mode: 'burned',  native: true  },
    { id: 'reels_06',     label: 'Bumper :06',           aspect: '9:16', width: 1080, height: 1920, fps: 30,    duration_ms:  6000, platform: 'shorts',    loudness: '-14 LUFS', caption_mode: 'burned',  native: true  },
    { id: 'square_15',    label: 'Square :15',           aspect: '1:1',  width: 1080, height: 1080, fps: 30,    duration_ms: 15000, platform: 'meta',      loudness: '-14 LUFS', caption_mode: 'burned',  native: false },
];

/** The three packages, so a small job is not scoped by hand every time. */
const PACKAGES = {
    rapid:     ['yt_30', 'reels_15', 'square_15'],
    campaign:  ['yt_30', 'reels_15', 'reels_06', 'meta_feed_15', 'square_15', 'bcast_na_15'],
    broadcast: ['bcast_na_30', 'bcast_na_15', 'yt_30', 'reels_15', 'reels_06', 'meta_feed_15'],
};

const PLATFORMS = ['', 'broadcast', 'ctv', 'youtube', 'meta', 'tiktok', 'shorts', 'web', 'still'];
const CAPTION_MODES = ['none', 'sidecar', 'burned'];
const STATUSES = ['planned', 'ready', 'delivered', 'dropped'];

/**
 * The rate a frame count is counted at.
 *
 * NTSC rates are nominal everywhere timecode exists: 29.97 is a timebase of 30
 * with an ntsc flag, and drop-frame drops NUMBERS rather than frames. So a :30
 * spot at 29.97 is 900 frames, and multiplying 30.000 by 29.97 gives 899.
 *
 * Duplicated from `nle-export.countingRate` DELIBERATELY, and it is the one
 * duplication in this module: importing it would drag the whole XML generator —
 * and its database-touching neighbours — into a pure module that the tests load
 * without a database. The two are held equal by test instead.
 */
function countingRate(fps) {
    const n = Number(fps);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error('a frame rate is required to count frames');
    }
    // 23.976, 29.97, 59.94 — the NTSC family, within a hair of a whole number.
    const nearest = Math.round(n);
    return Math.abs(n - nearest) > 0.001 && Math.abs(n - nearest) < 0.1 ? nearest : n;
}

/** Exact frames for a runtime at a rate. :30 at 29.97 is 900, not 899. */
function frameCount(durationMs, fps) {
    return Math.round((Number(durationMs) / 1000) * countingRate(fps));
}

/** A sequence name: the runtime and the shape, which is how an editor reads it. */
function keyFor(profile) {
    const seconds = Math.round(profile.duration_ms / 1000);
    return `${String(seconds).padStart(2, '0')}_${profile.aspect.replace(':', 'x')}`;
}

/**
 * profileIds -> deliverable rows, ordered. The route persists them.
 *
 * An unknown package THROWS rather than planning nothing: an empty plan is
 * indistinguishable from a package that has no files, and a project would walk
 * into generation with no deliverables and no warning.
 */
function planDeliverables(packageId, overrides) {
    const ids = PACKAGES[packageId];
    if (!ids) {
        throw new Error(`unknown package "${packageId}" — one of: ${Object.keys(PACKAGES).join(', ')}`);
    }
    /*
     * Overrides are keyed BY PROFILE, not applied to every row: a campaign that
     * runs :20 on social and :30 on air is the normal case, and a flat override
     * would silently retime the broadcast master — the one deliverable whose
     * length is contractual.
     */
    const o = overrides || {};
    return ids.map((profileId, i) => {
        const p = DELIVERY_PROFILES.find(x => x.id === profileId);
        return {
            key: keyFor(p),
            label: p.label,
            profile_id: p.id,
            aspect_ratio: p.aspect,
            width: p.width,
            height: p.height,
            fps: p.fps,
            duration_ms: p.duration_ms,
            platform: p.platform,
            loudness_target: p.loudness,
            caption_mode: p.caption_mode,
            native: p.native ? 1 : 0,
            sort_order: i,
            status: 'planned',
            notes: '',
            ...(o[p.id] || {}),
        };
    });
}

/**
 * Which ratios must be GENERATED rather than cropped.
 *
 * The whole reason this module exists, and the answer the shot board uses to
 * decide which shots are shot twice. Deduplicated, because two vertical
 * deliverables are one extra shoot rather than two.
 */
function nativeRatiosFor(deliverables) {
    const out = [];
    for (const d of deliverables || []) {
        const isNative = d.native === 1 || d.native === true;
        if (!isNative) continue;
        const ratio = d.aspect_ratio || d.aspect;
        if (ratio && !out.includes(ratio)) out.push(ratio);
    }
    return out;
}

/**
 * { valid, errors } — the shape `validateProjectSettings` already uses.
 *
 * Every rule here mirrors a CHECK constraint in migration 098. Caught here the
 * caller gets a sentence naming the field; caught there it is a 500 on a save,
 * which reads as the app being broken rather than the value being wrong.
 */
function validateDeliverable(row) {
    const errors = [];
    const r = row || {};

    if (!r.key || typeof r.key !== 'string') errors.push('key is required — it is the sequence name in the NLE');
    if (r.aspect_ratio !== undefined && !ASPECT_RATIO_IDS.includes(r.aspect_ratio)) {
        errors.push(`Invalid aspect_ratio "${r.aspect_ratio}". One of: ${ASPECT_RATIO_IDS.join(', ')}`);
    }
    if (!(Number(r.width) > 0)) errors.push('width must be a positive number of pixels');
    if (!(Number(r.height) > 0)) errors.push('height must be a positive number of pixels');
    if (Number(r.width) % 2 !== 0 || Number(r.height) % 2 !== 0) {
        errors.push('width and height must be even — h.264 refuses an odd dimension');
    }
    if (!(Number(r.fps) > 0)) errors.push('fps must be a positive frame rate');
    if (!(Number(r.duration_ms) > 0)) errors.push('duration_ms must be a positive runtime');
    if (r.platform !== undefined && !PLATFORMS.includes(r.platform)) {
        errors.push(`Invalid platform "${r.platform}". One of: ${PLATFORMS.filter(Boolean).join(', ')}`);
    }
    if (r.caption_mode !== undefined && !CAPTION_MODES.includes(r.caption_mode)) {
        errors.push(`Invalid caption_mode "${r.caption_mode}". One of: ${CAPTION_MODES.join(', ')}`);
    }
    if (r.status !== undefined && !STATUSES.includes(r.status)) {
        errors.push(`Invalid status "${r.status}". One of: ${STATUSES.join(', ')}`);
    }
    return { valid: errors.length === 0, errors };
}

module.exports = {
    DELIVERY_PROFILES, PACKAGES, PLATFORMS, CAPTION_MODES, STATUSES,
    planDeliverables, nativeRatiosFor, frameCount, keyFor, validateDeliverable,
};
