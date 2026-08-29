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

/**
 * The beat between two spoken lines, and the tail after the last one.
 *
 * Two people do not speak over each other, and a scene that cuts on the final
 * syllable feels clipped. Small enough that it does not invent a pause the
 * director did not write, and honest about being a playback convenience rather
 * than a claim about the finished edit.
 */
const LINE_GAP_MS = 350;
const LINE_TAIL_MS = 500;

const DEFAULT_FPS = 24;
const DEFAULT_SHOT_MS = 4000;

/**
 * Pick the highest-priority asset for a shot from a preference list.
 * Assets are expected to be plain rows with asset_type and file_path.
 */
/**
 * The asset a shot is SHOWING, not the first row the table happened to return.
 *
 * This took `.find()` over an unordered, unversioned query, so a shot with
 * twenty-eight attempts played v1 — the very first picture ever generated for
 * it — while the board showed the selected one. "It played the first image we
 * had for each instead of the selected one on the board."
 *
 * The rule is the board's, unchanged: `current_frame_version` when a version
 * has been chosen, otherwise the highest. NULL means "the newest", which is
 * what a freshly generated shot shows and what every shot showed before
 * selection existed — so there is nothing to backfill.
 */
function pickAsset(assets, preference) {
    for (const type of preference) {
        const matches = (assets || []).filter(a => a.asset_type === type && a.file_path);
        if (!matches.length) continue;
        if (matches.length === 1) return matches[0];

        const pointer = Number(matches.find(a => a.current_frame_version != null)
            ? matches[0].current_frame_version : NaN);
        if (Number.isFinite(pointer)) {
            const chosen = matches.find(a => Number(a.version) === pointer);
            if (chosen) return chosen;
        }
        // Highest version, and a row with no version at all sorts last rather
        // than winning by accident.
        return matches.reduce((best, a) =>
            (Number(a.version) || 0) > (Number(best.version) || 0) ? a : best, matches[0]);
    }
    return null;
}

/**
 * The shot's dialogue, one entry per line, in the order it is spoken.
 *
 * The filename carries the line index — `{shot}_{character}_{n}.ext` — which is
 * the only ordering that survives regeneration: created_at records when a line
 * was made, so re-doing line 2 would move it to the end of the scene.
 */
function dialogueLines(assets = []) {
    const seen = new Map();
    for (const a of assets) {
        if (a.asset_type !== 'audio_dialogue' || !a.file_name) continue;
        const prev = seen.get(a.file_name);
        // Newest row for a given file wins: the bytes were overwritten, so the
        // older rows describe a recording that no longer exists.
        if (!prev || String(a.created_at || '') > String(prev.created_at || '')) {
            seen.set(a.file_name, a);
        }
    }
    return [...seen.values()]
        .map(a => {
            const m = /_(\d+)\.[a-z0-9]+$/i.exec(a.file_name);
            return {
                path: a.file_path,
                file_name: a.file_name,
                index: m ? Number(m[1]) : 0,
                duration_ms: Number(a.duration_ms) || 0,
            };
        })
        .sort((a, b) => a.index - b.index);
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
        // duration_ms travels with the clip so the timeline can hold it for its
        // own length rather than the length its card asked for.
        video: video ? {
            type: video.asset_type, path: video.file_path,
            duration_ms: Number(video.duration_ms) || 0,
        } : null,
        still: still ? { type: still.asset_type, path: still.file_path } : null,
        audio: audio ? { type: audio.asset_type, path: audio.file_path } : null,
        /*
         * EVERY line of the shot, in order.
         *
         * `audio` is one asset, which is right for a finished mix and wrong for
         * dialogue: a shot holds one file per line, so attaching one meant
         * playback spoke the first line of a four-line exchange and fell silent
         * — you could watch the scene and never hear it play.
         *
         * Deduplicated by FILE NAME, newest first. Regenerating a shot's
         * dialogue writes over the same per-line filenames and inserts a new
         * row each time, so one four-line shot had seventeen rows pointing at
         * four files; without this it would speak every line four times.
         *
         * Ordered by the line index in the name (`1B_RAY_0.mp3`), because
         * created_at only reflects the order they were generated in, and a
         * regenerated single line would jump to the end of the scene.
         */
        audio_lines: dialogueLines(assets),
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
// The order the film plays in, from the one place that decides it. This was a
// private copy that disagreed with conform's and the exporters' — see
// lib/running-order.js for what that cost.
const { orderShots } = require('./running-order');

/**
 * Duration for a shot in ms. Falls back to a nominal length so a shot with no
 * measured duration still occupies a sane slot rather than collapsing to zero
 * and making the timeline unusable.
 */
function shotDuration(shot, media) {
    /*
     * THE FILM'S OWN LENGTH BEATS THE CARD'S GUESS.
     *
     * This read only shot.duration_ms — what the card ASKS for — and fell back
     * to 4000ms. So a ten-second upload was held for four seconds and playback
     * cut to the next still mid-shot. The card's number is an intention written
     * before anything existed; once there is a clip, its measured length is the
     * fact, and a player that disagrees with the file is simply wrong.
     *
     * A still-only shot keeps the card's duration: there is no measured length
     * to prefer, and a still has no opinion about how long it is held.
     */
    const measured = Number(media && media.video && media.video.duration_ms);
    if (Number.isFinite(measured) && measured > 0) return Math.round(measured);

    /*
     * A still-only shot with DIALOGUE holds for the dialogue.
     *
     * The card's duration was written before the lines were spoken, and it is
     * usually four seconds. Shot 1B of The Glass Harbour is a four-second card
     * carrying a four-line exchange that measures 5.04 seconds — so playback
     * cut away mid-sentence and moved on, which is the same fault an uploaded
     * clip had when it was held for the length its card asked for.
     *
     * The measured audio is the fact; the card is the intention. A small gap
     * between lines because two people do not speak over each other, and the
     * card still wins where it is LONGER — a director who wants to hold on a
     * face after the last line has said so, and shortening the shot to the
     * dialogue would overrule them.
     */
    const lines = (media && media.audio_lines) || [];
    const spoken = lines.reduce((total, l) => total + (Number(l.duration_ms) || 0), 0);
    const withGaps = spoken > 0
        ? spoken + Math.max(0, lines.length - 1) * LINE_GAP_MS + LINE_TAIL_MS
        : 0;

    const ms = Number(shot && shot.duration_ms);
    const card = (Number.isFinite(ms) && ms > 0) ? Math.round(ms) : DEFAULT_SHOT_MS;
    return Math.max(card, Math.round(withGaps));
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
    /*
     * Covered shots do not get a slot: the clip on the shot before them already
     * contains those moments, and holding their storyboard frames afterwards
     * replays what the viewer has just watched. The fold also moves the clip's
     * measured duration onto the lead — see lib/clip-coverage.js.
     */
    const { foldShots } = require('./clip-coverage');
    const ordered = foldShots(orderShots(shots), opts.coverage).shots;

    let cursor = 0;
    const entries = ordered.map((shot, index) => {
        const media = resolveShotMedia(assetsByShot[shot.id] || []);
        const duration = shotDuration(shot, media);
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
            // Which shots this one entry contains, so a viewer can see why 1B
            // and 1C are not in the playlist rather than assuming they are lost.
            ...(shot.covers ? { covers: shot.covers } : {}),
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
