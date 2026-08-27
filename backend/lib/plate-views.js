/**
 * Which view of a subject is the one that carries identity.
 *
 * A character reference sheet is a THREE-VIEW TURNAROUND — front, side, back —
 * and both places that pick "the plate" ordered by `created_at DESC LIMIT 1`.
 * The generator writes them in order, so the newest is always the BACK, and
 * the picture attached to every frame a character appears in was the back of
 * their head. Generating a turnaround cost three times as much as one plate
 * and made the result worse than not bothering.
 *
 * That is exactly the failure that is invisible from the outside: the frames
 * come back with a plausible person in them who is not the character, and it
 * reads as conditioning being weak rather than as the wrong picture being
 * sent.
 *
 * FRONT LEADS because a face is what identity is carried by, and every
 * downstream use — a plate on a keyframe, a card thumbnail, a locked
 * consistency profile — wants the face. Side and back are kept, ranked below,
 * so a subject that only ever had a back plate still gets one rather than
 * getting nothing.
 *
 * `LIMIT 1` is deliberate and unchanged: the reference budget is small (three
 * on Runway, five on Meshy) and shared with the location, the props and the
 * anchor. A second view of the same person costs a slot that a subject with no
 * picture at all would otherwise get, and a viewer notices a missing character
 * long before they notice a character shown only from the front.
 */

/** Lower sorts first. Anything unlisted ranks last but is still usable. */
const VIEW_RANK = Object.freeze({
    front: 0,
    'three-quarter': 1,
    side: 2,
    back: 3,
});

const UNRANKED = 9;

/**
 * A SQL fragment ordering plates by view, then by recency within a view.
 *
 * Expressed as SQL rather than sorted in JavaScript so the existing `LIMIT 1`
 * queries keep their shape — a query that fetches every plate and picks in JS
 * is a different performance question on a feature-length production, and the
 * two call sites would have to agree about it separately.
 *
 * `metadata` is JSON; json_extract is used rather than LIKE because a LIKE on
 * `%"view":"front"%` also matches a subject whose description happens to
 * contain that text.
 */
function orderByViewSql(alias = '') {
    const col = alias ? `${alias}.metadata` : 'metadata';
    const cases = Object.entries(VIEW_RANK)
        .map(([view, rank]) => `WHEN '${view}' THEN ${rank}`)
        .join(' ');
    return `CASE json_extract(${col}, '$.view') ${cases} ELSE ${UNRANKED} END`;
}

/** Rank one view name. Used where rows are already in hand. */
function viewRank(view) {
    const key = String(view || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(VIEW_RANK, key) ? VIEW_RANK[key] : UNRANKED;
}

module.exports = { VIEW_RANK, UNRANKED, orderByViewSql, viewRank };
