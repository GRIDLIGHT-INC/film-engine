/**
 * Gap 3: in-app playback timeline.
 *
 * Pure functions that assemble an ordered, playable timeline from shots and
 * their media assets. No DB access, no I/O — routes/timeline.js supplies rows.
 *
 * The core job is deciding, for each shot, which of several possible video
 * files is the one the user should actually watch, and laying the shots end to
 * end so a player can seek to an absolute position on the assembled film.
 */

// Which video an audience should see, best first. A shot that has been through
// post supersedes one that has only been lip-synced, which supersedes raw
// generation. Keyframes are the fallback so a shot with no video at all still
// occupies its slot on the timeline as a still rather than vanishing.
const MEDIA_PREFERENCE = ['video_final', 'video_synced', 'video_raw'];
const STILL_PREFERENCE = ['storyboard', 'keyframe', 'thumbnail'];

// Audio that plays under a shot, best first. A finished mix beats stems.
const AUDIO_PREFERENCE = ['audio_mix', 'audio_dialogue'];

const DEFAULT_FPS = 24;
const DEFAULT_SHOT_MS = 4000;

/**
 * Pick the highest-priority asset for a shot from a preference list.
 * Assets are expected to be plain rows with asset_type and file_path.
 */
function pickAsset(assets, preference) {
    for (const type of preference) {
        const match = assets.find(a => a.asset_type === type && a.file_path);
        if (match) return match;
    }
    return null;
}

/**
 * Resolve what is playable for one shot.
 * Returns { kind, video, still, audio, missing } where kind is
 * 'video' | 'still' | 'empty'.
 */
function resolveShotMedia(assets = []) {
    const video = pickAsset(assets, MEDIA_PREFERENCE);
    const still = pickAsset(assets, STILL_PREFERENCE);
    const audio = pickAsset(assets, AUDIO_PREFERENCE);

    let kind = 'empty';
    if (video) kind = 'video';
    else if (still) kind = 'still';

    return {
        kind,
        video: video ? { type: video.asset_type, path: video.file_path } : null,
        still: still ? { type: still.asset_type, path: still.file_path } : null,
        audio: audio ? { type: audio.asset_type, path: audio.file_path } : null,
        // A shot with nothing at all is a hole in the cut. Surfacing it is the
        // point — a player that silently skips empties hides unfinished work.
        missing: kind === 'empty',
    };
}

/**
 * Order shots for playback.
 *
 * Scene number dominates, then per-shot sort_order, then shot_code as a stable
 * tiebreak. This deliberately differs from the shot LIST query in routes/shots.js,
 * which sorts by sort_order first — that ordering is for a board grouped by
 * status, where global sort_order is the user's manual arrangement. On a
 * timeline, scene order is the film's actual structure and must win, otherwise
 * a shot dragged on the board would silently reorder the cut.
 */
function orderShots(shots = []) {
    return [...shots].sort((a, b) => {
        const sceneA = Number(a.scene_number) || 0;
        const sceneB = Number(b.scene_number) || 0;
        if (sceneA !== sceneB) return sceneA - sceneB;
        const orderA = Number(a.sort_order) || 0;
        const orderB = Number(b.sort_order) || 0;
        if (orderA !== orderB) return orderA - orderB;
        return String(a.shot_code || '').localeCompare(String(b.shot_code || ''));
    });
}

/**
 * Duration for a shot in ms. Falls back to a nominal length so a shot with no
 * measured duration still occupies a sane slot rather than collapsing to zero
 * and making the timeline unusable.
 */
function shotDuration(shot) {
    const ms = Number(shot && shot.duration_ms);
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
    return DEFAULT_SHOT_MS;
}

/**
 * Build the full playable timeline.
 *
 * @param {Array} shots       shot rows joined with scene_number
 * @param {Object} assetsByShot  map shot_id -> array of asset rows
 * @param {Object} opts       { fps }
 * @returns {Object} { entries, total_duration_ms, fps, shot_count, missing_count }
 */
function buildTimeline(shots = [], assetsByShot = {}, opts = {}) {
    const fps = Number(opts.fps) > 0 ? Number(opts.fps) : DEFAULT_FPS;
    const ordered = orderShots(shots);

    let cursor = 0;
    const entries = ordered.map((shot, index) => {
        const media = resolveShotMedia(assetsByShot[shot.id] || []);
        const duration = shotDuration(shot);
        const entry = {
            index,
            shot_id: shot.id,
            shot_code: shot.shot_code || '',
            scene_id: shot.scene_id || null,
            scene_number: Number(shot.scene_number) || 0,
            status: shot.status || 'pending',
            // Absolute position on the assembled film — what a player seeks to.
            start_ms: cursor,
            end_ms: cursor + duration,
            duration_ms: duration,
            start_timecode: msToTimecode(cursor, fps),
            ...media,
        };
        cursor += duration;
        return entry;
    });

    return {
        entries,
        fps,
        shot_count: entries.length,
        total_duration_ms: cursor,
        total_timecode: msToTimecode(cursor, fps),
        // How much of the cut has no picture. The honest headline for a
        // playback page: "you can watch 12 of 18 shots".
        missing_count: entries.filter(e => e.missing).length,
        playable_count: entries.filter(e => !e.missing).length,
    };
}

/**
 * Map an absolute timeline position to the shot playing at that moment.
 * Returns null when the position is past the end.
 */
function entryAtMs(timeline, ms) {
    if (!timeline || !Array.isArray(timeline.entries)) return null;
    const t = Number(ms);
    if (!Number.isFinite(t) || t < 0) return null;
    return timeline.entries.find(e => t >= e.start_ms && t < e.end_ms) || null;
}

/**
 * Convert an absolute timeline position to a shot-relative offset, which is what
 * a timecoded note stores. Returns null if the position isn't over a shot.
 */
function toShotRelative(timeline, absoluteMs) {
    const entry = entryAtMs(timeline, absoluteMs);
    if (!entry) return null;
    return { shot_id: entry.shot_id, timecode_ms: absoluteMs - entry.start_ms, entry };
}

/** SMPTE-style HH:MM:SS:FF. Non-drop; the NLE exporter owns drop-frame. */
function msToTimecode(ms, fps = DEFAULT_FPS) {
    const total = Math.max(0, Math.round(Number(ms) || 0));
    const rate = Number(fps) > 0 ? Number(fps) : DEFAULT_FPS;

    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    // Round frames down so a timecode never displays a frame that hasn't started.
    const frames = Math.floor(((total % 1000) / 1000) * rate);

    const pad = n => String(n).padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/** Inverse of msToTimecode. Returns null on anything unparseable. */
function timecodeToMs(tc, fps = DEFAULT_FPS) {
    if (typeof tc !== 'string') return null;
    const m = tc.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{1,2})$/);
    if (!m) return null;
    const rate = Number(fps) > 0 ? Number(fps) : DEFAULT_FPS;
    const [, h, min, s, f] = m;
    if (Number(min) > 59 || Number(s) > 59 || Number(f) >= rate) return null;
    return (
        Number(h) * 3600000 +
        Number(min) * 60000 +
        Number(s) * 1000 +
        Math.round((Number(f) / rate) * 1000)
    );
}

module.exports = {
    buildTimeline,
    resolveShotMedia,
    orderShots,
    shotDuration,
    entryAtMs,
    toShotRelative,
    msToTimecode,
    timecodeToMs,
    MEDIA_PREFERENCE,
    STILL_PREFERENCE,
    AUDIO_PREFERENCE,
    DEFAULT_FPS,
    DEFAULT_SHOT_MS,
};
