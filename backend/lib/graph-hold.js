/**
 * Hold a node (PGN-016).
 *
 * A held shot, sequence or cue is left alone by every batch run and stays in
 * the film — conform and export never read the hold, so holding something can
 * never quietly remove it from the cut. It is set and released through each
 * node's EXISTING update route and MCP update tool, so the page, an agent and
 * curl cannot come to disagree about what "held" means.
 *
 * HOLDABLE is the one statement of which nodes can be held; the routes, the
 * tools, the graph and the page are all held to it by test.
 */

const HOLDABLE = Object.freeze([
    { node: 'shot', key_prefix: 'shot', table: 'film_shots', tool: 'shot_update',
        route_module: 'shots', handler: 'handleShots', path: id => `/film/shots/${id}` },
    { node: 'sequence', key_prefix: 'seq', table: 'film_sequences', tool: 'sequence_update',
        route_module: 'sequences', handler: 'handleSequences', path: id => `/film/sequences/${id}` },
    { node: 'sound', key_prefix: 'sound', table: 'film_music_cues', tool: 'music_cue_update',
        route_module: 'assets', handler: 'handleAssets', path: id => `/film/music-cues/${id}` },
]);

/**
 * `held` read strictly. true holds, false or null releases; a string "true"
 * or a 1 is refused, because a value read loosely is how "false" comes to hold.
 */
function readHeld(value) {
    if (value === true) return { hold: true };
    if (value === false || value === null) return { hold: false };
    return { error: 'held must be true (hold: batch runs skip it, the film keeps it) or false (release)' };
}

/** The SQL value for held_at: now when holding, NULL when releasing. */
function heldAtSql(hold) { return hold ? "datetime('now')" : 'NULL'; }

/** Said wherever a held node is left out, so every surface uses the same words. */
const HELD_REASON = 'held: batch runs skip it until it is released; it stays in the film';

/**
 * Every batch entry point that honours the hold (PGN-017). Held to the code by
 * tests/hold-in-batches.test.js, which derives the batch-shaped functions from
 * routes/ and fails on one that is neither here nor exempted below.
 */
const BATCH_ENTRY_POINTS = Object.freeze([
    { file: 'backend/routes/storyboard.js', fn: 'generateStoryboard' },
    { file: 'backend/routes/storyboard.js', fn: 'generateStoryboardStream' },
    { file: 'backend/routes/video-gen.js', fn: 'batchVideo' },
    { file: 'backend/routes/video-gen.js', fn: 'batchVideoStream' },
    { file: 'backend/routes/voice.js', fn: 'batchVoice' },
    { file: 'backend/routes/voice.js', fn: 'batchVoiceStream' },
    { file: 'backend/routes/music-gen.js', fn: 'batchMusic' },
    { file: 'backend/routes/music-gen.js', fn: 'batchMusicStream' },
    { file: 'backend/routes/lipsync.js', fn: 'batchLipsync' },
    { file: 'backend/routes/post-production.js', fn: 'batchPost' },
    { file: 'backend/routes/post-production.js', fn: 'batchPostStream' },
    { file: 'backend/routes/pipeline.js', fn: 'executeShots' },
    { file: 'backend/lib/run-plan.js', fn: 'buildRunPlan' },
    { file: 'backend/lib/run-changed.js', fn: 'buildRunChangedPlan' },
    { file: 'backend/lib/run-changed.js', fn: 'planRunChanged' },
    { file: 'backend/lib/run-to-here.js', fn: 'planRunToHere' },
    { file: 'src/index.html', fn: 'pgRunPending' },
]);

/** Batch-shaped functions that cannot meet a hold, each with why. */
const BATCH_EXEMPT = Object.freeze([
    { file: 'backend/routes/threed.js', fn: 'batchModels',
        why: 'makes meshes for characters and props; a hold sits on shots, sequences and cues, none of which it touches' },
    { file: 'backend/routes/threed.js', fn: 'batchModelsStream',
        why: 'makes meshes for characters and props; a hold sits on shots, sequences and cues, none of which it touches' },
]);

/** Where the film is assembled or handed over: a held shot stays in the film, so these never read the hold. */
const NEVER_READS = Object.freeze(['backend/lib/conform.js', 'backend/routes/nle-export.js', 'backend/lib/nle-export.js',
    'backend/lib/export-package.js', 'backend/lib/timeline.js']);

/** The held shots among these rows. Rows carry `shot_id` or `id`, and `shot_code`. */
function splitShots(db, rows) {
    const list = rows || [];
    const idOf = r => r.shot_id || r.id;
    const ids = list.map(idOf).filter(Boolean);
    const held = new Set();
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        for (const r of db.prepare(`SELECT id FROM film_shots WHERE held_at IS NOT NULL AND id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) held.add(r.id);
    }
    return {
        run: list.filter(r => !held.has(idOf(r))),
        held: list.filter(r => held.has(idOf(r))).map(r => ({ kind: 'shot', id: idOf(r), label: r.shot_code || '', reason: HELD_REASON })),
    };
}

/** The scene step a cue kind answers to — music-gen's own map, so the two cannot disagree. */
function cueKindFor(step) {
    try { return require('../routes/music-gen')._internal.CUE_KIND_FOR[step] || null; } catch (_) { return null; }
}

/**
 * Is the cue a scene-level step would act on held? Asks music-gen's own
 * selector (`cueOfKind`), never a second copy of it: a scene can carry several
 * cues of a kind, and only the one the step would generate from matters.
 */
function cueHeldFor(db, sceneId, step) {
    const kind = cueKindFor(step);
    if (!kind || !sceneId) return null;
    let chosen = null;
    try { chosen = require('../routes/music-gen')._internal.cueOfKind(sceneId, kind).chosen; } catch (_) { chosen = null; }
    return chosen && chosen.held_at ? chosen : null;
}

/** Every held cue in a project, as held entries. */
function heldCues(db, projectId) {
    return db.prepare(`SELECT id, cue_type, title, scene_id FROM film_music_cues WHERE project_id = ? AND held_at IS NOT NULL`).all(projectId)
        .map(c => ({ kind: 'sound', id: c.id, label: c.title || c.cue_type, scene_id: c.scene_id, cue_type: c.cue_type, reason: HELD_REASON }));
}

module.exports = { HOLDABLE, readHeld, heldAtSql, HELD_REASON, BATCH_ENTRY_POINTS, BATCH_EXEMPT, NEVER_READS,
    splitShots, cueHeldFor, cueKindFor, heldCues };
