/**
 * Gap 3: in-app playback timeline.
 *
 * GET /film/projects/:id/timeline          — assembled playable timeline
 * GET /film/projects/:id/timeline/notes    — every timecoded note, positioned
 *                                            absolutely on the assembled film
 *
 * The engine could generate a film but never show it to you; the only way to
 * watch the cut was to export to an NLE. This assembles shots in scene order,
 * resolves the best available media per shot, and lays them end to end so a
 * player can seek across the whole film.
 */
const { db } = require('../db/database');
const { buildTimeline, msToTimecode } = require('../lib/timeline');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleTimeline(req, res, urlParts, query) {
    // /film/projects/:id/timeline[/notes]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'timeline') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');

        if (req.method === 'GET' && !urlParts[4]) return getTimeline(req, res, projectId, query);
        if (req.method === 'GET' && urlParts[4] === 'notes') return getTimelineNotes(req, res, projectId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

function notFound(res, msg) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

/**
 * Load shots + assets and assemble. A project with no shots returns a valid
 * empty timeline (200), not a 404 — 404 is reserved for a project that does not
 * exist. Agreed convention with codex so empty states behave identically
 * across every endpoint added in this pass.
 */
function loadTimeline(projectId) {
    // target_fps, not fps — project settings (migration 029) named it that.
    const project = db.prepare('SELECT id, target_fps FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return null;

    const shots = db.prepare(`
        SELECT s.id, s.shot_code, s.scene_id, s.status, s.duration_ms, s.sort_order,
               -- The card carries the dialogue TEXT, which is what decides how
               -- long to hold after each line: who speaks next, whether the
               -- writer marked a beat, whether the line trails off or is cut
               -- into. Without it every pause falls back to the plain turn gap.
               s.scene_card_yaml,
               sc.scene_number
        FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ?
    `).all(projectId);

    // One query for every asset in the project, grouped in memory. The
    // alternative — a query per shot — is an N+1 that gets slow exactly when a
    // project gets interesting.
    const assets = db.prepare(`
        SELECT a.shot_id, a.asset_type, a.file_path, a.duration_ms, a.version,
               -- file_name and created_at carry the dialogue: the line index is
               -- in the name, and the newest row for a name is the recording
               -- that actually exists on disk after a regeneration.
               a.file_name, a.created_at,
               sh.current_frame_version
        FROM film_assets a
        JOIN film_shots sh ON sh.id = a.shot_id
        WHERE a.project_id = ? AND a.shot_id IS NOT NULL
    `).all(projectId);

    const assetsByShot = {};
    for (const asset of assets) {
        (assetsByShot[asset.shot_id] = assetsByShot[asset.shot_id] || []).push(asset);
    }

    /*
     * Which shots are inside another shot's clip. Without this the timeline
     * still gives them their own slot and shows their storyboard frames after
     * the viewer has just watched them in the clip.
     */
    /*
     * The scene-scoped score and ambient.
     *
     * The asset query above reads `WHERE a.shot_id IS NOT NULL`, which is right
     * for a shot's picture and its dialogue and excludes a scene's beds
     * entirely — so a generated score was invisible to the assembled film and
     * looked like it had not generated at all.
     */
    const sceneRows = db.prepare(`
        SELECT a.scene_id, a.asset_type, a.file_path, a.duration_ms, a.created_at
        FROM film_assets a
        WHERE a.project_id = ? AND a.scene_id IS NOT NULL AND a.shot_id IS NULL
          AND a.asset_type IN ('audio_music', 'audio_ambient', 'audio_sfx')
        ORDER BY a.created_at DESC
    `).all(projectId);
    const sceneAssets = {};
    for (const row of sceneRows) {
        // Newest first, so a regenerated bed wins over the one it replaced —
        // the same rule the dialogue lines follow.
        (sceneAssets[row.scene_id] ||= {})[row.asset_type] ||= row;
    }

    // The cue's own level, fades and offset. Declared since migration 016 and
    // read only by the offline mixer; a player that ignores them is playing a
    // different mix from the one being delivered.
    /*
     * EVERY cue, with the audio IT produced — not one per kind.
     *
     * This mapped all five cue types down to two and kept the first of each, so
     * a scene with three sound effects contributed one bed, and `source`,
     * `transition` and `sfx` could never be heard however they were generated.
     *
     * The link each cue already carries is what makes several of a kind
     * possible: `generated_asset_id` points at the audio THAT cue produced, so
     * two scores in one scene are two files rather than one row winning a
     * tie-break. A cue with no link falls back to the scene's newest asset of
     * its type, so beds made before the link existed still play rather than
     * vanishing the day this shipped.
     */
    const cueAssets = {};
    for (const row of db.prepare(`
        SELECT id, file_path, duration_ms, asset_type FROM film_assets
        WHERE project_id = ? AND asset_type IN ('audio_music', 'audio_ambient', 'audio_sfx')
    `).all(projectId)) cueAssets[row.id] = row;

    const { ASSET_TYPE_FOR } = require('../lib/timeline');
    const cues = {};
    for (const row of db.prepare(`
        SELECT c.* FROM film_music_cues c
        WHERE c.project_id = ? AND c.scene_id IS NOT NULL
        ORDER BY c.start_ms, c.created_at, c.id
    `).all(projectId)) {
        const linked = row.generated_asset_id ? cueAssets[row.generated_asset_id] : null;
        const fallback = (sceneAssets[row.scene_id] || {})[ASSET_TYPE_FOR[row.cue_type] || 'audio_music'];
        const asset = linked || fallback || null;
        if (!asset || !asset.file_path) continue;
        (cues[row.scene_id] ||= []).push({ ...row, asset });
    }

    const { coverageFor } = require('../lib/clip-coverage');
    const timeline = buildTimeline(shots, assetsByShot, {
        fps: project.target_fps,
        coverage: coverageFor(db, projectId),
        sceneAssets,
        cues,
    });

    /*
     * The move each held frame plays.
     *
     * A storyboard still occupied its slot dead centre and dead still, so a
     * shot written as a slow push over the cul-de-sac and a shot written as
     * locked off played identically — and the only way to find out whether the
     * move worked was to buy the clip. The track is computed HERE, from
     * film_previs_blocking and the card, so playback and anything else that
     * reads the timeline cannot come to different answers about the same move.
     */
    require('../lib/shot-motion').attachTracks(db, projectId, timeline);
    return timeline;
}

function getTimeline(req, res, projectId) {
    const timeline = loadTimeline(projectId);
    if (!timeline) return notFound(res, 'Project not found');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(timeline));
}

/**
 * Timecoded notes positioned on the assembled film.
 *
 * Notes store a shot-relative offset so they survive reordering; the player
 * needs absolute positions to draw markers on a scrub bar. This does that
 * translation server-side so the client isn't re-deriving timeline maths.
 */
function getTimelineNotes(req, res, projectId) {
    const timeline = loadTimeline(projectId);
    if (!timeline) return notFound(res, 'Project not found');

    const byShot = new Map(timeline.entries.map(e => [e.shot_id, e]));
    if (byShot.size === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ notes: [], count: 0, total_duration_ms: 0 }));
        return;
    }

    const placeholders = [...byShot.keys()].map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT id, shot_id, author, note_type, content, priority, resolved, timecode_ms, created_at
        FROM film_shot_notes
        WHERE shot_id IN (${placeholders}) AND timecode_ms IS NOT NULL
        ORDER BY shot_id, timecode_ms
    `).all(...byShot.keys());

    const notes = rows.map(row => {
        const entry = byShot.get(row.shot_id);
        // Clamp into the shot: a note can outlive a re-render that shortened
        // the shot, and a marker drawn past the end of its own clip is worse
        // than one pinned to the last frame.
        const offset = Math.min(Math.max(0, row.timecode_ms), Math.max(0, entry.duration_ms - 1));
        const absolute = entry.start_ms + offset;
        return {
            ...row,
            shot_code: entry.shot_code,
            scene_number: entry.scene_number,
            absolute_ms: absolute,
            absolute_timecode: msToTimecode(absolute, timeline.fps),
            clamped: offset !== row.timecode_ms,
        };
    }).sort((a, b) => a.absolute_ms - b.absolute_ms);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        notes,
        count: notes.length,
        total_duration_ms: timeline.total_duration_ms,
        fps: timeline.fps,
    }));
}

module.exports = { handleTimeline, loadTimeline };
