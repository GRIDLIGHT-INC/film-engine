/**
 * The frame you are currently shooting from.
 *
 * Board generation never looked at another frame. A keyframe was conditioned on
 * character plates, a location plate and a mood-board image — every one a
 * picture of something in the abstract — so 1B rebuilt the street from scratch
 * and put the well, the cart and the light somewhere else than 1A had.
 *
 * **The anchor is the set, not a swatch.** Point at the frame that has the
 * scene right and the next shot is generated FROM it: same location, same set
 * dressing, same subjects standing where they stand in it, re-shot on whatever
 * lens and angle that shot's own card asks for. 1A establishes the square; 1B
 * is that square from a 24mm at a low angle with the dragon's shadow across it.
 *
 * An earlier version attached the frame for GRADE only, with a negative
 * refusing to reuse its composition, on the reasoning that a scene of eight
 * copies of the establishing shot is worse than the drift. That failure is real
 * and it is not the one worth designing against: a director who wants 1B to
 * keep 1A's street with the cart exactly where it was cannot get there from a
 * colour swatch. The camera change is what stops it being a duplicate, and the
 * camera change is stated in the prompt from the shot's own card.
 *
 * **One at a time, held deliberately.** The first version also made this a
 * standing property of every SCENE and derived one automatically — the first
 * shot in the scene that had a frame — so anchoring 1A lit up an anchor on 2A
 * as well, because scene 2 had quietly appointed its own. Anchoring is not a
 * property a scene has. It is something a director picks up while working on 1B
 * and 1C and puts down afterwards to go back to plates. So there is exactly ONE
 * active anchor per project: set explicitly, replaced by setting another,
 * cleared in a click. Nothing is an anchor by default and nothing becomes one
 * on its own.
 *
 * Setting it IS turning it on. There is no separate switch, because a pinned
 * frame that reached nothing while a checkbox elsewhere sat clear is exactly
 * the state nobody can hold in their head.
 */

/**
 * The active anchor, from the point of view of the shot about to be generated.
 *
 * Always returns a reason, including when it returns nothing: "no anchor set"
 * and "no anchor because you are standing on it" need different actions from a
 * director, and a bare null makes them look identical.
 *
 * @param {string|null} activeShotId - film_projects.anchor_shot_id
 * @param {string} targetShotId - the shot being generated
 */
function pickAnchor(activeShotId, targetShotId) {
    if (!activeShotId) {
        return { shot: null, reason: 'no anchor is set — this shot generates from its plates' };
    }
    if (activeShotId === targetShotId) {
        // Generating the anchor from itself is a loop: it could only reproduce
        // itself, so the one frame a director most wants to revise would be the
        // one they cannot. It generates from its own card instead.
        return { shot: null, reason: 'this shot IS the anchor, so it generates from its own card' };
    }
    return { shot: { id: activeShotId }, reason: null };
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

/** Continuity of grade, restated beside the look, which can otherwise overwrite it. */
function anchorPhrase(tag) {
    const t = String(tag || '').trim();
    return `matching the light, palette and colour grade of ${ref(t)}`;
}

/**
 * What breaks continuity, refused by name.
 *
 * The inverse of what this used to say. Refusing to reuse the reference's
 * composition made the anchor a colour swatch; what actually has to be refused
 * is the scene quietly becoming a different one — a rebuilt street, props that
 * moved, an hour that changed — which is what a model does when it treats a
 * reference as inspiration rather than as the set.
 */
const ANCHOR_NEGATIVE = 'different location, rebuilt set, rearranged props, '
    + 'inconsistent set dressing, different time of day, discontinuous lighting';

/**
 * Resolve the project's active anchor for one shot, with its frame.
 *
 * `has a frame` is a storyboard asset that exists, not a shot marked complete:
 * a status is somebody's claim and a row in film_assets is the picture itself.
 */
function activeAnchorFor(db, shotId) {
    const shot = db.prepare('SELECT s.id, s.shot_code, s.scene_id, sc.project_id, sc.scene_number '
        + 'FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?').get(shotId);
    if (!shot) return { shot: null, asset: null, reason: 'no such shot' };

    const project = db.prepare('SELECT anchor_shot_id FROM film_projects WHERE id = ?').get(shot.project_id);
    const picked = pickAnchor(project && project.anchor_shot_id, shotId);
    if (!picked.shot) return { ...picked, asset: null };

    const anchorShot = db.prepare('SELECT s.id, s.shot_code, s.scene_id, sc.scene_number '
        + 'FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?').get(picked.shot.id);
    if (!anchorShot) {
        return { shot: null, asset: null, reason: 'the anchored shot no longer exists' };
    }

    const asset = db.prepare(
        `SELECT file_path, file_name FROM film_assets
          WHERE shot_id = ? AND asset_type IN ('storyboard', 'keyframe')
          ORDER BY version DESC, created_at DESC LIMIT 1`).get(anchorShot.id);
    if (!asset || !asset.file_path) {
        return { shot: null, asset: null,
            reason: `the anchor ${anchorShot.shot_code} has no generated frame yet` };
    }

    return {
        shot: anchorShot,
        asset,
        reason: null,
        // Allowed, and worth saying. Two scenes in one location is a real
        // reason to anchor across them; two scenes in different locations is
        // how a director gets the wrong street back and cannot see why. Said
        // rather than refused, because only they know which case it is.
        cross_scene: anchorShot.scene_id !== shot.scene_id
            ? `the anchor ${anchorShot.shot_code} is in scene ${anchorShot.scene_number}, `
                + `this shot is in scene ${shot.scene_number} — continuity is only meaningful `
                + 'if they share a location'
            : null,
    };
}

/**
 * The anchor as a reference candidate.
 *
 * Named after the shot it is, so the tag reads as what it points at — `@1a`
 * rather than `@anchor`.
 */
function anchorCandidate(anchor) {
    if (!anchor || !anchor.shot || !anchor.asset) return null;
    return { name: anchor.shot.shot_code, kind: 'anchor', file_path: anchor.asset.file_path };
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
/**
 * Framings where the anchor cannot stand in for a subject's plate.
 *
 * An anchor covers where a subject STANDS. It covers who they ARE only if it
 * shows them — and a wide with someone's back to camera carries their position,
 * their wardrobe colour and the light, and not one pixel of a face.
 *
 * A close-up is nothing BUT the face, so it keeps its character plates whatever
 * the anchor claims to cover. Left to be remembered, the next close-up fails
 * the same way: on a real board, three attempts at a reaction shot each came
 * back as a different woman.
 *
 * Deliberately narrow. A wide or an establishing genuinely is covered, and
 * forcing plates there spends reference slots on subjects the anchor shows
 * perfectly well.
 */
const IDENTITY_FRAMINGS = new Set(['close-up', 'extreme-close-up', 'over-the-shoulder', 'insert']);

/**
 * Plates this shot must keep, derived from its own framing.
 *
 * Props are included for `insert`, which is a close-up of an object and has the
 * same problem for the same reason.
 */
function platesForcedBy(card) {
    const forced = new Set();
    const c = card || {};
    const framing = String((c.camera && c.camera.shot_type) || '').toLowerCase();
    if (!IDENTITY_FRAMINGS.has(framing)) return forced;
    const keys = framing === 'insert' ? ['props', 'characters'] : ['characters'];
    for (const key of keys) {
        for (const raw of (Array.isArray(c[key]) ? c[key] : [])) {
            const name = typeof raw === 'string' ? raw : (raw && raw.name);
            if (name) forced.add(String(name).trim().toUpperCase());
        }
    }
    return forced;
}

/**
 * @param {string[]} [keep] - subjects whose plate must travel even though the
 *   anchor names them. The director's override, and what `platesForcedBy`
 *   feeds in automatically for a close-up.
 */
function subjectsCoveredBy(db, anchor, keep) {
    const covered = new Set();
    if (!anchor || !anchor.shot || !anchor.shot.id) return covered;
    // Case- and space-insensitive: a card says "Maya" and a director types MAYA.
    const forced = new Set((Array.isArray(keep) ? keep : [])
        .map(n => String(n || '').trim().toUpperCase()).filter(Boolean));
    try {
        const row = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(anchor.shot.id);
        const card = JSON.parse((row && row.scene_card_yaml) || '{}');
        for (const key of ['characters', 'props']) {
            for (const raw of (Array.isArray(card[key]) ? card[key] : [])) {
                const name = typeof raw === 'string' ? raw : (raw && raw.name);
                const key = name && String(name).trim().toUpperCase();
                if (key && !forced.has(key)) covered.add(key);
            }
        }

        // The place, which the anchor covers most completely of all — it is a
        // photograph of that location rather than a description of it. Its
        // plate already stands down for an anchor; leaving its paragraph in was
        // an inconsistency that cost 856 characters on a real shot.
        //
        // Only when the anchor is in the SAME scene. Anchoring across scenes is
        // allowed, and there the anchor is a picture of a different place —
        // dropping this location's description would leave the one thing the
        // frame does not show travelling as a bare name.
        if (!anchor.cross_scene) {
            const loc = db.prepare(
                'SELECT sc.location FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?')
                .get(anchor.shot.id);
            const locKey = loc && loc.location && String(loc.location).trim().toUpperCase();
            if (locKey && !forced.has(locKey)) covered.add(locKey);
        }
    } catch (_) { /* an unreadable card covers nothing, which keeps every plate */ }
    return covered;
}

module.exports = {    pickAnchor, ref, anchorLeadPhrase, anchorPhrase, ANCHOR_NEGATIVE,
    activeAnchorFor, anchorCandidate, subjectsCoveredBy, platesForcedBy,};
