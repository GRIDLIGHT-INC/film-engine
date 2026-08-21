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
 * **The anchor is the starting point, not a swatch.** It carries the WORLD:
 * the location as it was actually rendered, the set dressing, the props and
 * the subjects in the positions they ended up in. The new shot re-shoots that
 * world from a different camera — a longer lens, a lower angle, the dragon's
 * shadow now overhead — and says so. Continuity comes from the picture;
 * everything the new shot adds or changes comes from its own card.
 *
 * This was first built the other way round — attached for grade only, with a
 * negative refusing to reuse its composition — on the reasoning that a scene of
 * eight copies of the establishing shot is a worse failure than the drift.
 * That is a real failure and it is not the one worth designing against here: a
 * director who wants 1B to keep 1A's street with the car exactly where it was
 * cannot get there from a colour swatch, and telling the model to ignore the
 * placement throws away the only thing the frame was attached for.
 *
 * The camera change is what stops it being a duplicate, and the camera change
 * is stated in the prompt from the shot's own card. If two shots genuinely
 * name the same framing, two similar frames is the correct output.
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
    return t ? `matching the light, palette and colour grade of ${ref(t)}` : '';
}

/** How to address the attached frame: by tag where the provider reads one. */
function ref(tag) {
    const t = String(tag || '').trim();
    return t ? `@${t}` : 'the first reference image';
}

/**
 * The instruction that makes the anchor a starting point.
 *
 * Leads the prompt, and that placement is the decision. "Whatever leads a
 * prompt is what the image is of" is the rule this codebase learned the
 * expensive way — and here the leading statement is TRUE: the image genuinely
 * is of that location, with those things in those places. What follows is the
 * shot being taken of it.
 *
 * It names re-shooting explicitly. Without that the model reads "same scene as
 * this picture" as "reproduce this picture", and the camera facets further down
 * arrive as decoration on a copy.
 */
function anchorLeadPhrase(tag) {
    return `The same scene as ${ref(tag)}: the same location, the same set dressing `
        + `and the same subjects standing where they stand in it. Re-shot from a new camera `
        + `position — keep every element continuous with it and change only the framing `
        + `and what the shot below describes`;
}

/**
 * What breaks continuity, refused by name.
 *
 * The inverse of what this negative used to say. Refusing to reuse the
 * reference's composition made the anchor a colour swatch; what actually has to
 * be refused is the scene quietly becoming a different one — a rebuilt street,
 * props that moved, an hour that changed — which is exactly what a model does
 * when it treats a reference as inspiration rather than as the set.
 */
const ANCHOR_NEGATIVE = 'different location, rebuilt set, rearranged props, '
    + 'inconsistent set dressing, different time of day, discontinuous lighting';

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

/**
 * The subjects the anchor frame already shows.
 *
 * A plate exists to tell the model what a subject looks like. When the anchor
 * frame contains that subject, it has already been told — in situ, at the right
 * scale, lit the way the scene is lit — so spending one of three reference
 * slots on the plate buys nothing and costs the slot a subject that is NOT in
 * the anchor could have used.
 *
 * Read from the anchor shot's own card rather than from the picture, because
 * nothing here can look at a picture. That is a deliberate under-claim: a card
 * lists what the shot is about, so a subject the card omits keeps its plate
 * even if it happens to be visible. Erring the other way would drop the plate
 * for a subject the frame does not actually show.
 *
 * The DESCRIPTION is never dropped, only the plate. A redundant description
 * costs room; a missing one costs the shot, which is the lesson the contract
 * shortening was reverted for.
 */
function subjectsCoveredBy(db, anchor) {
    const covered = new Set();
    if (!anchor || !anchor.shot || !anchor.shot.id) return covered;
    try {
        const row = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(anchor.shot.id);
        const card = JSON.parse((row && row.scene_card_yaml) || '{}');
        for (const key of ['characters', 'props']) {
            for (const raw of (Array.isArray(card[key]) ? card[key] : [])) {
                const name = typeof raw === 'string' ? raw : (raw && raw.name);
                if (name) covered.add(String(name).trim().toUpperCase());
            }
        }
    } catch (_) { /* an unreadable card covers nothing, which keeps every plate */ }
    return covered;
}

module.exports = {
    pickAnchor, anchorPhrase, anchorLeadPhrase, ref, ANCHOR_NEGATIVE,
    sceneAnchorFor, anchorCandidate, subjectsCoveredBy,
};
