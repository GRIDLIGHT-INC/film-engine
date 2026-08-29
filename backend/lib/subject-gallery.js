/**
 * A subject needs a sketchbook, not just a plate.
 *
 * Every stored image of a character, location or prop is currently a candidate
 * reference: `gatherShotReferences` selects on asset type and `headlinePlate`
 * picks one. There is nowhere to put an image that INFORMS the work without
 * BEING the work — the film still you are chasing, a photograph of the real
 * street, four versions of a face you are choosing between. So an artist has
 * one slot per view, and every exploration overwrites the approved plate.
 *
 * Three roles, in order of commitment:
 *
 *   reference   — approved, and the only thing that conditions a frame. One per
 *                 (subject, view), which is what headlinePlate already assumes.
 *   concept     — an exploration. Kept, comparable, promotable, and reaching no
 *                 prompt until somebody promotes it.
 *   inspiration — gathered rather than made.
 *
 * The inspiration case is not a ranking, it is a different act. A gathered
 * image is usually somebody else's frame; looking at it and sending it to a
 * provider as conditioning input are not the same thing, so it is excluded from
 * generation outright and promoting one has to be stated.
 *
 * THE invariant this module exists to hold: adding a gallery must not silently
 * start conditioning shots on sketches. Every row that exists today IS a plate,
 * so an unlabelled image reads as `reference`; every new exploration is born a
 * `concept` and is inert until promoted.
 */

const ROLES = Object.freeze([
    {
        id: 'reference',
        title: 'Reference',
        what: 'The approved plate. This is the picture every frame of this subject is generated from.',
        reaches_generation: true,
        why: 'It is the subject, decided. One per view, because two would make "the plate" whichever row came back first.',
    },
    {
        id: 'concept',
        title: 'Concept',
        what: 'An exploration — a look you are trying, kept so it can be compared and chosen between.',
        reaches_generation: false,
        why: 'Nothing should be conditioned on a sketch until somebody says it is the one. Promote it and it becomes the reference.',
    },
    {
        id: 'inspiration',
        title: 'Inspiration',
        what: 'Gathered rather than made: a film still, a photograph, a painting, the real location.',
        reaches_generation: false,
        why: 'Usually somebody else’s image. Looking at it and sending it to a provider as conditioning are different acts, so this one is excluded rather than merely ranked low.',
    },
]);

const ROLE_IDS = ROLES.map(r => r.id);
const DEFAULT_ROLE = 'reference';

/** The three kinds of subject a shot can reference, and where each lives. */
const SUBJECT_KINDS = Object.freeze(['character', 'location', 'prop']);

const SUBJECT_SPEC = Object.freeze({
    character: { table: 'film_characters', column: 'character_id', plateKind: 'character' },
    location: { table: 'film_locations', column: 'location_id', plateKind: 'location' },
    prop: { table: 'film_props', column: 'prop_id', plateKind: 'prop' },
});

/** Asset types that are pictures OF a subject. Mirrors the gatherer's list. */
const PLATE_TYPES = Object.freeze(['reference_image', 'character_sheet']);

function parseMeta(row) {
    const m = row && row.metadata;
    if (!m) return {};
    if (typeof m === 'object') return m;
    try { return JSON.parse(m) || {}; } catch (_) { return {}; }
}

/**
 * What role this image plays.
 *
 * An absent or unrecognised value reads as `reference`, and that direction is
 * deliberate and load-bearing: every row that exists when this ships IS the
 * subject's plate. Reading NULL as "unknown" would take the reference off every
 * subject in every project on the day of the migration — the opposite of the
 * `input_fingerprint` rule, where NULL means "outside the workflow", because
 * here the existing rows are very much inside it.
 *
 * An unrecognised string is not silently trusted INTO the send list either; it
 * lands on the same default, which is the only value a pre-existing row can
 * legitimately have.
 */
function roleOf(row) {
    const role = parseMeta(row).plate_role;
    if (role === undefined || role === null || role === '') return DEFAULT_ROLE;
    // A DECLARED but unrecognised role is returned verbatim rather than folded
    // into the default. Absent means "written before roles existed", which is a
    // plate; declared-but-unknown means somebody wrote an intent this version
    // does not understand, and quietly reading that as "approved for sending"
    // is the wrong direction — `isSendable` refuses it.
    return String(role);
}

/** May this image be sent to a provider as conditioning? */
function isSendable(row) {
    const role = ROLES.find(r => r.id === roleOf(row));
    return !!(role && role.reaches_generation);
}


function viewOf(row) {
    return String(parseMeta(row).view || '');
}

/**
 * What promoting this image means for the rest of the gallery.
 *
 * Returns the plan rather than performing it, on the precedent `planConform`
 * and `run-plan` set: the caller can show what will change before it changes,
 * and the same rules are testable without a database.
 */
function planPromotion(rows, assetId, opts) {
    const all = rows || [];
    const target = all.find(r => String(r.id) === String(assetId));
    if (!target) {
        const err = new Error(`Image ${assetId} is not in this subject's gallery`);
        err.code = 'NOT_IN_GALLERY';
        throw err;
    }

    const role = roleOf(target);
    if (role === 'inspiration' && !(opts && opts.allow_inspiration)) {
        const err = new Error(
            'This is an inspiration — a gathered image, usually somebody else’s frame. '
            + 'Promoting it makes it conditioning input sent to a provider on every shot this '
            + 'subject appears in, which is a different act from looking at it. '
            + 'Pass allow_inspiration to do it anyway.');
        err.code = 'INSPIRATION_NOT_REFERENCE';
        throw err;
    }

    const view = viewOf(target);
    // Only the SAME view is demoted. Each view keeps its own reference, or
    // promoting a side plate would strip the front one.
    const demote = all
        .filter(r => String(r.id) !== String(assetId)
            && roleOf(r) === 'reference'
            && viewOf(r) === view)
        .map(r => r.id);

    return {
        promote: assetId,
        view,
        demote,
        // An unchanged promotion writes nothing: "did that apply?" has to be a
        // free question, and a no-op that reports success teaches people to
        // press the button twice.
        changed: role !== 'reference' || demote.length > 0,
        was: role,
    };
}

/**
 * Where an exploration is written.
 *
 * NEVER the plate's filename. A plate is stored at a per-view name and
 * overwrites, so an exploration sharing it would replace the approved picture
 * on disk the moment it was generated — the image every frame of that subject
 * is conditioned on, gone, with nothing said. The token keeps explorations from
 * overwriting each other too, or "try three looks" keeps one.
 */
function explorationFileName(kind, subjectName, view, token) {
    const safe = String(subjectName || kind).replace(/[^a-zA-Z0-9_-]/g, '_');
    const v = String(view || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32).replace(/_+$/, '');
    const t = String(token || Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    return `${kind}_${safe}__explore${v ? '_' + v : ''}_${t}.png`;
}

/** The metadata a fresh exploration carries. Born a concept, always. */
function explorationMetadata(fields) {
    return {
        ...(fields || {}),
        plate_role: 'concept',
        kind: `${(fields && fields.kind) || 'subject'}_exploration`,
    };
}

/** The metadata a gathered image carries. */
function inspirationMetadata(fields) {
    return { ...(fields || {}), plate_role: 'inspiration' };
}

/**
 * Every picture of one subject, newest first, with its role resolved.
 *
 * One query rather than three: the subject column is the only thing that
 * differs between a character, a location and a prop, and three near-identical
 * queries is how one of them acquires a fix the others do not.
 */
function loadGallery(db, kind, subjectId) {
    const spec = SUBJECT_SPEC[kind];
    if (!spec) throw new Error(`Unknown subject kind '${kind}'`);
    const types = PLATE_TYPES.map(t => `'${t}'`).join(', ');
    const rows = db.prepare(
        `SELECT * FROM film_assets
          WHERE ${spec.column} = ? AND asset_type IN (${types})
          ORDER BY created_at DESC`
    ).all(subjectId);

    return rows.map(r => {
        const meta = parseMeta(r);
        return {
            ...r,
            metadata: meta,
            role: roleOf(r),
            sendable: isSendable(r),
            view: viewOf(r) || null,
        };
    });
}

/**
 * The same rule as `roleOf`, expressed in SQL.
 *
 * Two implementations of one rule is what this codebase keeps paying for, so
 * `tests/subject-gallery.test.js` runs the two against the same rows and
 * requires them to agree — including on the rows that make them disagree:
 * absent metadata, metadata that is not JSON, and a role nobody declared.
 *
 * `json_valid` first, and that guard is load-bearing: `json_extract` THROWS on
 * malformed JSON, and a throw here would take down the query that decides which
 * plate a paid generation is conditioned on. Anything unparseable falls to
 * `reference`, exactly as roleOf does, because a pre-existing row is a plate.
 */
function sendableSql(alias = '') {
    const m = alias ? `${alias}.metadata` : 'metadata';
    return `(${m} IS NULL OR NOT json_valid(${m})`
        + ` OR json_extract(${m}, '$.plate_role') IS NULL`
        + ` OR json_extract(${m}, '$.plate_role') = 'reference')`;
}

/** Keep only what may be sent to a provider. */
function sendableOnly(rows) {
    return (rows || []).filter(isSendable);
}

/** Group a gallery by role, in the declared order, for a surface to render. */
function byRole(gallery) {
    const out = {};
    for (const role of ROLES) out[role.id] = [];
    for (const item of gallery || []) (out[item.role] = out[item.role] || []).push(item);
    return out;
}

module.exports = {
    ROLES, ROLE_IDS, DEFAULT_ROLE, SUBJECT_KINDS, SUBJECT_SPEC, PLATE_TYPES,
    roleOf, isSendable, sendableSql, sendableOnly, viewOf, planPromotion,
    explorationFileName, explorationMetadata, inspirationMetadata,
    loadGallery, byRole,
};
