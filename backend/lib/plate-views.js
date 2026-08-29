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
    /*
     * Walk-around order: front, three-quarter, profile, back three-quarter,
     * back. The back three-quarter was missing, and it is the angle a camera
     * moving behind a character actually lands on — the guide lists five views
     * for exactly that reason.
     *
     * Front stays 0 because it is the IDENTITY view: with one reference slot
     * this is the one that attaches, and ranking it anywhere else is how a
     * turnaround once put the back of a head on every frame.
     */
    front: 0,
    'three-quarter': 1,
    // A lone `side` cannot say which way the character is facing, so two shots
    // from opposite sides resolved to the same plate. side-left and side-right
    // are the real profiles; `side` is kept ranked between them because real
    // projects hold plates under it, and dropping the name would leave those
    // pictures on disk and unreachable.
    'side-left': 2,
    side: 2.5,
    'side-right': 3,
    'back-three-quarter': 4,
    back: 5,
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


/**
 * WHICH PLATE IS THIS SUBJECT'S — one rule, for every caller.
 *
 * A compass sweep writes the master, then east, then south, then west. The
 * list route picked the NEWEST row, so after a sweep a location's headline
 * plate became whichever side finished last — south, or west had it completed.
 * The master on disk was untouched; only the pointer moved. Meanwhile
 * `gatherShotReferences` fell back to the view-less default, so the two paths
 * answered "which plate is this location's" differently and only one of them
 * was right.
 *
 * A compass side is an ADDITIONAL VIEW, not a replacement. The default plate —
 * the one with no view, which the sides are turns from — stays the headline
 * until somebody asks for a side by name.
 *
 * Order of preference:
 *   1. the view asked for, if it exists
 *   2. the default, view-less plate
 *   3. anything at all — a location whose master was deleted should not lose
 *      its plate entirely, and a silent gap replaces a wrong reference with NO
 *      reference, which is worse
 *
 * @param {Array<{metadata?: string}>} rows  asset rows, any order
 * @param {{view?: string}} [opts]
 * @returns {object|null}
 */
function headlinePlate(rows, opts) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;

    const viewOf = row => {
        try { return String((JSON.parse(row.metadata || '{}').view) || '').trim(); }
        catch (_) { return ''; }
    };

    const wanted = String((opts && opts.view) || '').trim();
    if (wanted) {
        const exact = list.find(r => viewOf(r).toLowerCase() === wanted.toLowerCase());
        if (exact) return exact;
    }
    return list.find(r => !viewOf(r)) || list[0] || null;
}

module.exports = {
    headlinePlate, VIEW_RANK, UNRANKED, orderByViewSql, viewRank };
