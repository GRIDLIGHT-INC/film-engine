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
function resolveShotMedia(assets = [], shot = {}) {
    /*
     * THE SELECTED CLIP PLAYS. A shot with two generated clips used to play
     * whichever the type ranking and version order preferred, so choosing the
     * first one over the second changed nothing on screen. The pointer wins
     * when it names a clip this shot still has; otherwise the old rule.
     */
    const selectedId = (assets.find(a => a && a.selected_video_asset_id) || {}).selected_video_asset_id;
    const chosen = selectedId
        ? assets.find(a => a.id === selectedId && MEDIA_PREFERENCE.includes(a.asset_type) && a.file_path)
        : null;
    const video = chosen || pickAsset(assets, MEDIA_PREFERENCE);
    const range = video && (Number(video.duration_ms) > 0 || Number(shot.duration_ms) > 0 || require('./nle-media').metadata(video).edit)
        ? require('./nle-media').sourceRange({ ...shot, duration_ms: Number(video.duration_ms) || shot.duration_ms }, video)
        : {duration_ms:0,source_in_ms:0,source_ms:0};
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
            duration_ms: range.duration_ms, source_in_ms: range.source_in_ms, source_out_ms: range.source_in_ms + range.duration_ms, source_duration_ms: range.source_ms,
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
    /*
     * The pauses are per line now, not a flat gap.
     *
     * A beat the writer marked is 1.4s and an interruption is none at all, so
     * a fixed 350ms between every line either rushed the beats or padded the
     * interruptions. The last line's pause is dropped: it would hold silence
     * after the cut, which is the next shot's business.
     */
    const pauses = lines.slice(0, -1)
        .reduce((total, l) => total + (Number(l.pause_after_ms) || LINE_GAP_MS), 0);
    const withGaps = spoken > 0 ? spoken + pauses + LINE_TAIL_MS : 0;

    const ms = Number(shot && shot.duration_ms);
    const card = (Number.isFinite(ms) && ms > 0) ? Math.round(ms) : DEFAULT_SHOT_MS;
    return Math.max(card, Math.round(withGaps));
}

/**
 * Put each line's pause on the audio it follows.
 *
 * Matched by INDEX, because that is what the filename encodes and what both
 * lists are ordered by. A card whose dialogue has been rewritten since the
 * audio was made simply falls back to the plain turn gap rather than pairing a
 * pause with the wrong line.
 */
function attachPauses(shot, media) {
    const lines = (media && media.audio_lines) || [];
    if (!lines.length) return;

    let card = {};
    try { card = JSON.parse((shot && shot.scene_card_yaml) || '{}') || {}; } catch (_) { card = {}; }
    const spoken = Array.isArray(card.dialogue) ? card.dialogue : [];

    const { pauseAfter, PAUSE } = require('./dialogue-delivery');
    for (const line of lines) {
        const here = spoken[line.index];
        const next = spoken[line.index + 1];
        line.pause_after_ms = here ? pauseAfter(here, next) : PAUSE.turn;
    }
}

/**
 * Build the full playable timeline.
 *
 * @param {Array} shots       shot rows joined with scene_number
 * @param {Object} assetsByShot  map shot_id -> array of asset rows
 * @param {Object} opts       { fps }
 * @returns {Object} { entries, total_duration_ms, fps, shot_count, missing_count }
 */
/**
 * ── The beds a scene plays under ────────────────────────────────────────────
 *
 * Music and ambient are SCENE-scoped: their assets carry a scene_id and no
 * shot_id, and the timeline's asset query reads `WHERE a.shot_id IS NOT NULL`.
 * So a generated score was invisible to the assembled film — you could score a
 * scene, watch it back, and hear nothing but the dialogue. It looked like the
 * score had not generated.
 *
 * A bed is not a shot's audio. It spans every shot of its scene, so it is laid
 * out ONCE across that span rather than restarted per entry — restarting it on
 * each cut is the one thing that would make a score sound obviously wrong.
 *
 * The cue's own level and fades come with it. film_music_cues has carried
 * `volume_db`, `fade_in_ms` and `fade_out_ms` since migration 016 and only the
 * offline audio mixer ever read them; a player that ignores them is playing a
 * different mix from the one being delivered.
 */
/**
 * Every sound a scene plays, not one per kind.
 *
 * A scene is a CUE SHEET: several sounds, each with its own offset, level and
 * fades — all of which `film_music_cues` has carried since migration 016. This
 * laid out ONE asset for each of TWO kinds, so a director who wrote three sound
 * effects heard none of them, and `source`, `sfx` and `transition` could never
 * play at all however they were generated.
 *
 * Two shapes are accepted deliberately. An ARRAY is the cue sheet: one entry per
 * cue, each carrying the asset its own `generated_asset_id` points at, so two
 * scores in one scene are two beds rather than one. The older object keyed by
 * kind is still honoured because the timeline's existing contracts — default
 * gain, the offset-into-the-scene reading, the end_ms — are asserted against it,
 * and rewriting those assertions to fit a new shape is how a contract quietly
 * changes meaning.
 */
function sceneSounds(sceneId, sceneAssets = {}, cues = {}) {
    const at = cues[sceneId];
    const assets = sceneAssets[sceneId] || {};

    if (Array.isArray(at)) {
        return at
            .map(cue => ({
                kind: BED_KIND_FOR[cue.cue_type] || 'music',
                type: ASSET_TYPE_FOR[cue.cue_type] || 'audio_music',
                asset: cue.asset || null,
                cue,
            }))
            .filter(b => b.asset && b.asset.file_path);
    }

    const out = [];
    for (const [kind, type] of [['music', 'audio_music'], ['ambient', 'audio_ambient']]) {
        const asset = assets[type];
        if (!asset || !asset.file_path) continue;
        out.push({ kind, type, asset, cue: (at || {})[kind] || null });
    }
    return out;
}

/** Which stem a cue type plays on, and which asset type it is stored as. */
const BED_KIND_FOR = Object.freeze({
    score: 'music', source: 'music', transition: 'music',
    ambient: 'ambient', sfx: 'sfx',
});
const ASSET_TYPE_FOR = Object.freeze({
    score: 'audio_music', source: 'audio_music', transition: 'audio_music',
    ambient: 'audio_ambient', sfx: 'audio_sfx',
});

function sceneBeds(entries, sceneAssets = {}, cues = {}) {
    const spans = new Map();
    for (const entry of entries) {
        if (!entry.scene_id) continue;
        const at = spans.get(entry.scene_id);
        if (!at) spans.set(entry.scene_id, { start_ms: entry.start_ms, end_ms: entry.end_ms });
        else { at.start_ms = Math.min(at.start_ms, entry.start_ms); at.end_ms = Math.max(at.end_ms, entry.end_ms); }
    }

    const beds = [];
    for (const [sceneId, span] of spans) {
        for (const { kind, type, asset, cue } of sceneSounds(sceneId, sceneAssets, cues)) {
            /*
             * start_ms is an offset INTO THE SCENE, not into the film — that is
             * what the mixer has always read it as, and it is the only reading
             * that survives the scene being moved.
             */
            const offset = Math.max(0, Number(cue && cue.start_ms) || 0);
            beds.push({
                kind,
                scene_id: sceneId,
                type,
                path: asset.file_path,
                // Measured, so a bed shorter than its scene is visibly shorter
                // rather than silently looping or silently stopping.
                asset_duration_ms: Number(asset.duration_ms) || 0,
                start_ms: span.start_ms + offset,
                end_ms: span.end_ms,
                // A cue that says nothing about level gets the delivered mix's
                // level. `Number(null)` is 0 and 0 is finite, so guarding only
                // the first read of the cue dereferences a null on the second.
                gain_db: (cue && Number.isFinite(Number(cue.volume_db)) && Number(cue.volume_db) !== 0)
                    ? Number(cue.volume_db) : DEFAULT_BED_GAIN_DB[kind],
                fade_in_ms: Math.max(0, Number(cue && cue.fade_in_ms) || 0),
                fade_out_ms: Math.max(0, Number(cue && cue.fade_out_ms) || 0),
                cue_id: cue ? cue.id : null,
            });
        }
    }
    return beds.sort((a, b) => a.start_ms - b.start_ms);
}

/*
 * Where a bed sits when its cue says nothing, from the mix the project actually
 * delivers (lib/audio-mixer.js). A player at unity would be louder than the
 * finished film and would send everyone reaching for the fader.
 */
const DEFAULT_BED_GAIN_DB = { music: -8, ambient: -12 };

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
        const media = resolveShotMedia(assetsByShot[shot.id] || [], shot);
        /*
         * How long to hold after each line.
         *
         * Generated lines butt against each other, and a scene played that way
         * sounds like a list being read rather than two people talking. The
         * pause comes from the CARD — who speaks next, whether the writer
         * marked a beat, whether the line trails off or is interrupted — so it
         * needs the dialogue text, which the assets do not carry.
         */
        attachPauses(shot, media);
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
            source_in_ms: media.video ? media.video.source_in_ms : 0,
            source_out_ms: media.video ? media.video.source_out_ms : duration,
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
        // The scene-scoped score and ambient, laid across the shots they play
        // under. Empty for every project that has generated none, which is what
        // keeps a player with no beds behaving exactly as it did.
        beds: sceneBeds(entries, opts.sceneAssets, opts.cues),
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

module.exports = {    sceneBeds,
    BED_KIND_FOR,
    ASSET_TYPE_FOR,
    DEFAULT_BED_GAIN_DB,
    buildTimeline,
    resolveShotMedia,
    orderShots,
    shotDuration,
    entryAtMs,
    toShotRelative,
    msToTimecode,
    timecodeToMs,
    DEFAULT_FPS,
    DEFAULT_SHOT_MS,};
