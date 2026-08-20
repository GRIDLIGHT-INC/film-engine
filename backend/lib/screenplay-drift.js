/**
 * Which work a screenplay revision has left behind.
 *
 * This happens constantly in production: a scene is rewritten, and the shot
 * list, the boards, the blocking and the generated frames for that scene are
 * all now about the previous version of the story. On eight shots a director
 * notices. On a feature nobody does, and the first sign is a cut that does not
 * make sense.
 *
 * The engine already had artefact staleness, which answers a different
 * question: does this generated frame still match its scene card? It cannot see
 * a rewrite at all, because rewriting the screenplay does not touch the card —
 * that is exactly the problem. This is the missing edge, screenplay → card, and
 * it is deliberately a SEPARATE signal rather than folded into the artefact
 * fingerprint: "the frame no longer matches its card" and "the card no longer
 * matches the script" need different work, and telling a director to regenerate
 * a frame whose card is wrong buys them a better picture of the wrong shot.
 *
 * It WARNS and never blocks, on the precedent previs set. A card that has
 * diverged from the screenplay may be a deliberate choice — a director who
 * changed the words and kept the shot — and refusing to generate would overrule
 * them. Nothing here spends money or refuses a request.
 */

const crypto = require('crypto');

function database() {
    return require('../db/database').db;
}

/** Whether this database can answer the question at all. */
function tracking(db) {
    try {
        return db.prepare("SELECT COUNT(*) c FROM pragma_table_info('film_shots') WHERE name = 'scene_fingerprint'")
            .get().c > 0;
    } catch (_) { return false; }
}

function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/**
 * The fingerprint of a scene AS A SOURCE FOR SHOTS.
 *
 * Only the fields a scene card is actually built from. The scene row carries
 * more than that — ids, timestamps, sort order — and hashing the whole row
 * would fire on a reorder, which changes no shot's meaning.
 */
function sceneFingerprint(scene) {
    if (!scene) return null;
    return hash({
        int_ext: scene.int_ext || '',
        location: scene.location || '',
        time_of_day: scene.time_of_day || '',
        description: scene.description || '',
    });
}

/**
 * Record what a scene's text currently is.
 *
 * Called by the reconciler on every scene it writes. Never throws: a
 * fingerprint that cannot be computed must not fail a screenplay save the user
 * has already made.
 */
function stampScene(sceneId) {
    try {
        const db = database();
        const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
        if (!scene) return null;
        const fp = sceneFingerprint(scene);
        if (scene.source_fingerprint === fp) return fp;

        // A FIRST stamp is a baseline, not a change. Setting the timestamp here
        // makes every scene in an existing project claim it was rewritten at the
        // moment tracking was switched on — which is exactly what it looked
        // like: three scenes stamped 14:27, keyframes generated at 11:42, and a
        // report correctly saying nothing was behind. The reader is then left
        // deciding which of the two to believe, and a timestamp that has to be
        // explained is worse than no timestamp.
        const firstEver = !scene.source_fingerprint;
        if (firstEver) {
            db.prepare('UPDATE film_scenes SET source_fingerprint = ? WHERE id = ?').run(fp, sceneId);
        } else {
            db.prepare("UPDATE film_scenes SET source_fingerprint = ?, source_changed_at = datetime('now') WHERE id = ?")
                .run(fp, sceneId);
        }
        return fp;
    } catch (_) { return null; }
}

/** Record which draft of its scene a shot was written from. */
function stampShot(shotId, sceneId) {
    try {
        const db = database();
        const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
        if (!scene) return null;
        const fp = scene.source_fingerprint || sceneFingerprint(scene);
        db.prepare('UPDATE film_shots SET scene_fingerprint = ? WHERE id = ?').run(fp, shotId);
        return fp;
    } catch (_) { return null; }
}

/**
 * Everything a rewrite has left behind, and what to do about each piece.
 *
 * Reported per scene rather than per shot, because the work is per scene: you
 * re-read the new text once and then fix every shot in it. Each shot carries
 * what has been generated FROM it, since "this card is out of date" and "and
 * eight frames and a blocking were built on it" are different sizes of problem.
 */
function drift(projectId) {
    const db = database();

    // A warning system that cannot tell you it is switched off is worse than
    // no warning system. Without these columns every shot reads as "no draft
    // recorded", which the report renders as a confident all-clear — the one
    // answer it must never give when it does not know.
    if (!tracking(db)) {
        const err = new Error('Screenplay drift tracking is not installed on this database (migration 069).');
        err.code = 'NOT_TRACKED';
        throw err;
    }

    const scenes = db.prepare(
        "SELECT * FROM film_scenes WHERE project_id = ? AND status != 'removed' ORDER BY scene_number").all(projectId);

    const out = [];
    for (const scene of scenes) {
        const current = sceneFingerprint(scene);
        const shots = db.prepare('SELECT * FROM film_shots WHERE scene_id = ? ORDER BY sort_order, shot_code')
            .all(scene.id);

        const behind = [];
        let unknown = 0;
        for (const shot of shots) {
            // NULL is "written before any of this existed", which is not the
            // same as out of date and must not be reported as though it were.
            if (!shot.scene_fingerprint) { unknown++; continue; }
            if (shot.scene_fingerprint === current) continue;
            behind.push({
                shot_id: shot.id,
                shot_code: shot.shot_code,
                generated: generatedFrom(db, shot.id),
            });
        }

        if (!behind.length) continue;
        out.push({
            scene_id: scene.id,
            scene_number: String(scene.scene_number),
            heading: [scene.int_ext, scene.location, scene.time_of_day].filter(Boolean).join('. '),
            changed_at: scene.source_changed_at || null,
            shots_behind: behind,
            shots_unknown: unknown,
            // Said as work, not as a status. "3 shots are stale" sends a
            // director to the database; this sends them to the next action.
            next: [
                `Re-read scene ${scene.scene_number} and update the ${behind.length} shot card(s) with shot_update,`
                + ' or delete them with shot_delete and re-derive this one scene with breakdown_run.',
                behind.some(b => b.generated.length)
                    ? 'Then regenerate the frames listed against each shot — they show the previous story.'
                    : 'Nothing has been generated from these shots yet, so fixing the cards costs nothing.',
            ],
        });
    }
    return out;
}

/** What has been built on a shot, so the size of the problem is visible. */
function generatedFrom(db, shotId) {
    const made = [];
    try {
        const assets = db.prepare(
            'SELECT DISTINCT asset_type FROM film_assets WHERE shot_id = ?').all(shotId);
        for (const a of assets) made.push(a.asset_type);
    } catch (_) { /* asset registry unreadable; the shot still reports */ }
    try {
        const blocked = db.prepare('SELECT 1 FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
        if (blocked) made.push('previs blocking');
    } catch (_) { /* previs not migrated */ }
    return made;
}

/**
 * Adopt the current draft as the baseline for work that predates tracking.
 *
 * Every shot written before this existed has no fingerprint, and NULL means
 * "outside the workflow" — so those shots would never warn, and a director who
 * revises scene 3 on an existing project gets silence, which is the exact
 * failure this feature is for. Stamping them says "these cards match the
 * screenplay as it stands right now", which is a claim only the director can
 * make, so it is an explicit action rather than something that happens on read.
 *
 * Only touches shots that have no fingerprint. A shot already known to be
 * behind must not be quietly declared current — that would erase the warning
 * instead of answering it.
 */
function adoptBaseline(projectId) {
    const db = database();
    const rows = db.prepare(
        `SELECT s.id AS shot_id, s.scene_id FROM film_shots s
           JOIN film_scenes sc ON sc.id = s.scene_id
          WHERE sc.project_id = ? AND s.scene_fingerprint IS NULL`).all(projectId);
    const scenes = new Set();
    for (const r of rows) {
        stampScene(r.scene_id);
        scenes.add(r.scene_id);
    }
    let stamped = 0;
    for (const r of rows) if (stampShot(r.shot_id, r.scene_id)) stamped++;
    return { shots_stamped: stamped, scenes_touched: scenes.size };
}

module.exports = { sceneFingerprint, stampScene, stampShot, drift, adoptBaseline, tracking };
