/**
 * The style book: a director's own shots, applied to a film's.
 *
 * An entry is a name, a description, some camera facets and a few reference
 * visuals. The value is not the notes — it is that applying one FILLS IN THE
 * SCENE CARD, and the card is already what `buildStoryboardPrompt` and
 * `buildVideoPrompt` read. So a favourite angle reaches a generation with no
 * new plumbing at all, which is the whole reason the entry stores the card's
 * own camera shape rather than a shape of its own.
 *
 * PURE. No database, no shot id, no I/O — the caller reads and writes. That is
 * the pipeline-engine / routes/pipeline split, and here it earns itself twice:
 * the merge has three callers (the page, the MCP tool, previs) and it is the
 * only interesting logic in the feature, so it is worth testing without a
 * database.
 */

const { validateSceneCard } = require('./scene-card-schema');

/**
 * A stage pose is NOT carried between shots.
 *
 * `position` and `rotation` are six degrees of freedom in one previs stage's
 * coordinate space. The same numbers put the camera somewhere else entirely in
 * another scene — a different set, a different origin, a different subject to
 * be relative to. Carrying them would produce an entry that appears to work
 * and silently frames nothing.
 *
 * Named rather than omitted, and reported in `skipped`, because an omission
 * that is stated is a decision and one that is silent is a bug.
 */
const POSE_FACETS = Object.freeze(['position', 'rotation']);

const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const TAGS_MAX = 500;

/**
 * The facets an entry may carry.
 *
 * DERIVED from the scene-card schema's own source rather than listed here, so
 * a facet added to the card later is carried with nothing to remember. A hand
 * list is exactly as complete as the afternoon it was written — and this
 * codebase has paid for that with `MAY_END_PAGE`, with `defaultProviderConfig`
 * and with the prop categories.
 *
 * @returns {string[]}
 */
function mergeableFacets() {
    const src = require('fs').readFileSync(require.resolve('./scene-card-schema'), 'utf8');
    const all = [...new Set([...src.matchAll(/card\.camera\.([a-z_]+)/g)].map(m => m[1]))];
    return all.filter(f => !POSE_FACETS.includes(f));
}

/**
 * Is this a usable entry?
 *
 * The camera object is validated by DELEGATING to the scene-card validator,
 * never by a private copy of the vocabulary. A style book that accepts a shot
 * type the card refuses produces an entry that cannot be applied, and the
 * failure surfaces much later, on a shot the director cares about, as a
 * validation error about something they did not just do.
 *
 * @param {object} entry  { name, description?, tags?, camera? }
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEntry(entry) {
    const errors = [];
    if (!entry || typeof entry !== 'object') return { valid: false, errors: ['entry must be an object'] };

    if (!entry.name || typeof entry.name !== 'string' || !entry.name.trim()) {
        errors.push('name is required — an entry you cannot find again is one you will not use');
    } else if (entry.name.length > NAME_MAX) {
        errors.push(`name must be ${NAME_MAX} characters or fewer`);
    }

    for (const [field, max] of [['description', DESCRIPTION_MAX], ['tags', TAGS_MAX]]) {
        if (entry[field] === undefined || entry[field] === null) continue;
        if (typeof entry[field] !== 'string') errors.push(`${field} must be a string`);
        else if (entry[field].length > max) errors.push(`${field} must be ${max} characters or fewer`);
    }

    if (entry.camera !== undefined && entry.camera !== null) {
        if (typeof entry.camera !== 'object' || Array.isArray(entry.camera)) {
            errors.push('camera must be an object of scene-card camera facets');
        } else {
            // Validated as a card, so what the book accepts a card accepts.
            const probe = validateSceneCard({ shot_code: '_probe', camera: entry.camera });
            for (const err of probe.errors || []) {
                if (/shot_code/.test(err)) continue;   // the probe's own placeholder
                errors.push(err);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Apply an entry to a scene card.
 *
 * MERGES, never replaces. A card carries a description, dialogue, characters
 * and props that an entry knows nothing about; `PUT /shots/:id` merges for
 * exactly this reason, and an apply that replaced would drop the writing every
 * time somebody reached for a favourite angle.
 *
 * Merged PER FACET, not as a camera block: an entry that says nothing about
 * the lens must leave the lens alone rather than clearing it. Swapping the
 * camera object wholesale is the bug `previsFacets` already shipped once,
 * where blocking a shot made its keyframe VAGUER than leaving it alone.
 *
 * Reports `applied` and `skipped` because "I applied my low-angle" and "it
 * carried no height and changed nothing" are indistinguishable from the
 * outside otherwise.
 *
 * Does not mutate its arguments — callers read the original afterwards.
 *
 * @param {object} entry  a style-book entry
 * @param {object} card   the shot's scene card
 * @returns {{ card: object, applied: string[], skipped: string[] }}
 */
function applyEntryToShot(entry, card) {
    const source = (entry && entry.camera) || {};
    const next = { ...(card || {}) };
    next.camera = { ...((card && card.camera) || {}) };

    const applied = [];
    const skipped = [];
    const carried = mergeableFacets();

    for (const [facet, value] of Object.entries(source)) {
        if (value === undefined || value === null || value === '') continue;
        if (POSE_FACETS.includes(facet)) { skipped.push(facet); continue; }
        /*
         * Refused EXPLICITLY rather than left to fall through the carried
         * list. These are excluded today only because mergeableFacets() is
         * derived from the scene card's own camera facets and none of these
         * is one — an accident that ends the day a delivery spec is added to
         * the card, at which point the constant named to prevent this would
         * be doing nothing at all. Declared-and-never-consumed is the failure
         * this codebase keeps paying for; this is the consumer.
         */
        if (NEVER_WRITES.includes(facet)) { skipped.push(facet); continue; }
        if (!carried.includes(facet)) { skipped.push(facet); continue; }
        next.camera[facet] = value;
        applied.push(facet);
    }

    return { card: next, applied, skipped };
}

/**
 * What an entry must never touch.
 *
 * `aspect_ratio`, `resolution`, `frame_rate` and `color_space` are the mood
 * board's DELIVERY decisions about a whole film. A per-shot template writing
 * them would be two systems fighting over the frame size — and the board's
 * specs already reach the project settings, so the loser would be whichever
 * wrote last.
 */
const NEVER_WRITES = Object.freeze(['aspect_ratio', 'resolution', 'frame_rate', 'color_space']);

module.exports = {
    validateEntry, applyEntryToShot, mergeableFacets,
    POSE_FACETS, NEVER_WRITES, NAME_MAX, DESCRIPTION_MAX, TAGS_MAX,
};
