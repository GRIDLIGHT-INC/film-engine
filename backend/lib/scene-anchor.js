/**
 * The frame a scene is measured against.
 *
 * Board generation never looked at another frame. Every keyframe was
 * conditioned on pictures of things in the abstract — a character plate, a
 * location plate, a mood-board image — and none of those say what the light did
 * on the day. So two shots of the same street at the same hour came back with
 * different weather, and the only remedy was to regenerate until they agreed.
 *
 * **Why an anchor and not the previous shot.** Chaining 1A→1B→1C→… compounds:
 * each frame conditions on a frame that was itself conditioned on a frame, and
 * by the eighth shot the board is a copy of a copy. The drift per step is too
 * small to notice and the drift across the scene is obvious, which is the worst
 * possible ratio. Chaining also makes a shot's inputs depend on the order
 * somebody pressed the buttons in — regenerate 1C alone and it references
 * whatever 1B is at that moment. An anchor is fixed: every shot in the scene
 * references the same frame, error cannot accumulate, and regenerating one shot
 * changes no other shot's inputs.
 *
 * **What it carries, and what it must not.** An anchor is attached for its
 * light, palette and grade. It is emphatically NOT attached for its
 * composition: a scene where every frame copies the establishing shot's
 * staging is a worse failure than the drift being fixed, and it is the failure
 * an unlabelled reference image invites. The prompt says which of the two it
 * wants and the negative says which it does not.
 *
 * Pure: `pickAnchor` takes rows and returns a choice with its reasoning. The
 * database read is a thin wrapper below it, so the rule that decides which
 * frame establishes a scene is testable without a project.
 */

/**
 * Which frame establishes this scene, for the shot about to be generated.
 *
 * Always returns a reason, including when it returns no anchor. "No anchor" and
 * "no anchor because you are standing on it" need different actions, and a bare
 * null makes them look identical — the same argument that made an unnoted
 * annotation report why it could not be used.
 *
 * @param {Array<{id, shot_code, has_frame}>} shots - the scene's shots, in order
 * @param {string} targetShotId - the shot being generated
 * @param {string|null} pinnedShotId - film_scenes.anchor_shot_id, if set
 */
function pickAnchor(shots, targetShotId, pinnedShotId) {
    const list = (shots || []).filter(s => s && s.id);

    if (pinnedShotId) {
        const pinned = list.find(s => s.id === pinnedShotId);
        if (!pinned) {
            // The pin points outside this scene, or at a shot that is gone. Say
            // so rather than silently falling back — a director who pinned a
            // frame and is getting a different one needs to know which.
            return { shot: null, pinned: true, reason: 'the pinned anchor shot is not in this scene' };
        }
        if (pinned.id === targetShotId) {
            return { shot: null, pinned: true, reason: 'this shot IS the scene anchor' };
        }
        if (!pinned.has_frame) {
            return {
                shot: null, pinned: true,
                reason: `the pinned anchor ${pinned.shot_code} has no frame yet — generate it first`,
            };
        }
        return { shot: pinned, pinned: true, reason: null };
    }

    // Derived: the first shot in the scene that has a frame. First rather than
    // most recent, because an anchor that moves as the board fills in is not an
    // anchor — it would make a shot's inputs depend on when it was generated.
    const framed = list.filter(s => s.has_frame);
    if (!framed.length) {
        return { shot: null, pinned: false, reason: 'no frame in this scene has been generated yet' };
    }
    if (framed[0].id === targetShotId) {
        return { shot: null, pinned: false, reason: 'this shot IS the scene anchor' };
    }
    return { shot: framed[0], pinned: false, reason: null };
}

/**
 * What the prompt says about the attached frame.
 *
 * Names the three things an anchor is for and nothing else. "Matching the
 * reference" would be read as matching its composition, which is the one thing
 * this must not do.
 */
function anchorPhrase(tag) {
    const t = String(tag || '').trim();
    return t ? `matching the light, palette and colour grade of @${t}` : '';
}

/**
 * And what it says it does not want.
 *
 * Stated because it is the specific way this feature fails: an attached frame
 * of the same place pulls the generation toward reproducing that frame, and a
 * scene of eight identical setups reads as a bug in the board rather than a
 * choice.
 */
const ANCHOR_NEGATIVE = 'copying the reference composition, identical framing to the reference, duplicate shot';

/**
 * Read the scene's shots and pick the anchor. Thin on purpose.
 *
 * `has_frame` is a storyboard asset that exists, not a shot marked complete: a
 * status is somebody's claim and a row in film_assets is the picture itself.
 */
function sceneAnchorFor(db, shotId) {
    const shot = db.prepare('SELECT id, scene_id, shot_code FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return { shot: null, pinned: false, reason: 'no such shot', asset: null };

    const scene = db.prepare('SELECT id, anchor_shot_id FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return { shot: null, pinned: false, reason: 'no such scene', asset: null };

    const shots = db.prepare(
        `SELECT s.id, s.shot_code,
                (SELECT COUNT(*) FROM film_assets a
                  WHERE a.shot_id = s.id AND a.asset_type IN ('storyboard', 'keyframe')) AS frames
           FROM film_shots s WHERE s.scene_id = ? ORDER BY s.shot_code`).all(shot.scene_id)
        .map(r => ({ id: r.id, shot_code: r.shot_code, has_frame: r.frames > 0 }));

    const picked = pickAnchor(shots, shotId, scene.anchor_shot_id);
    if (!picked.shot) return { ...picked, asset: null };

    const asset = db.prepare(
        `SELECT file_path, file_name FROM film_assets
          WHERE shot_id = ? AND asset_type IN ('storyboard', 'keyframe')
          ORDER BY version DESC, created_at DESC LIMIT 1`).get(picked.shot.id);
    if (!asset || !asset.file_path) {
        return { shot: null, pinned: picked.pinned, asset: null,
            reason: `the anchor ${picked.shot.shot_code} has no readable frame on disk` };
    }
    return { ...picked, asset };
}

/**
 * The anchor as a reference candidate.
 *
 * Named after the shot it is, so the tag reads as what it points at — `@1a`
 * rather than `@anchor`, which would collide across scenes the moment a second
 * one was attached.
 */
function anchorCandidate(anchor) {
    if (!anchor || !anchor.shot || !anchor.asset) return null;
    return {
        name: anchor.shot.shot_code,
        kind: 'anchor',
        file_path: anchor.asset.file_path,
    };
}

module.exports = { pickAnchor, anchorPhrase, ANCHOR_NEGATIVE, sceneAnchorFor, anchorCandidate };
