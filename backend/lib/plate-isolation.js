/**
 * A subject plate is the subject and nothing else.
 *
 * A character or prop plate exists to say what a THING looks like, and it
 * conditions every frame that thing appears in. Anything else in the picture
 * travels with it: a kitchen behind a character is pulled into the street he
 * is supposed to be standing in, and the shot's own location has to argue with
 * it in every generation afterwards.
 *
 * Both builders already asked for a "plain seamless backdrop" and both came
 * back with full rooms. The instruction was not missing, it was OUTRANKED:
 *
 *   1. The STYLE PRESET LEADS, deliberately — it is what stops a plate coming
 *      back as clip art, a defect this codebase already paid for. But a real
 *      style is largely a description of a SCENE. The one that produced these
 *      plates reads "hard low-sun key raking through glass", "practical
 *      tungsten warmth blooming in frame", "light visible as shafts in heavy
 *      haze". Those are rooms with windows and lamps in them, stated first and
 *      at length, against three trailing words asking for a backdrop.
 *   2. The negative said "background clutter", which asks for a TIDY room
 *      rather than for no room.
 *
 * So isolation is stated in the same breath as the medium instead of trailing
 * it, and refused outright in the negative. Both together: the positive says
 * what the picture is, and the negative is what actually holds when the style
 * has spent four hundred characters describing a place.
 *
 * LOCATION PLATES ARE EXEMPT and must stay so — a location plate IS an
 * environment. Its own constraint is the opposite one ("no people"), and
 * applying this to it would ask for a picture of a place with no place in it.
 */

/** Kinds whose plate must isolate the subject. Location is deliberately absent. */
const ISOLATED_KINDS = Object.freeze(['character', 'prop']);

/**
 * Said beside the medium, not after the subject.
 *
 * "Whatever leads a prompt is what the image is of" is the rule this codebase
 * learned expensively, and it applies to the negative space too: an isolation
 * clause at the tail is a footnote to a scene the style already established.
 */
const ISOLATION_CLAUSE =
    'the subject alone in an empty frame on a plain seamless studio backdrop, '
    + 'nothing behind it, no location, no room, no set, no scenery, no props, nothing else visible';

/**
 * What must not be in a subject plate.
 *
 * Concrete nouns rather than "background clutter": a model can act on
 * "furniture" and "window", and reads "clutter" as an instruction to tidy.
 */
const ISOLATION_NEGATIVE =
    'background, environment, location, scenery, room, interior, exterior, set, set dressing, '
    + 'furniture, window, wall, door, floor, street, landscape, sky, props in background, '
    + 'other objects, other people, scene';

/** Append the isolation negative for kinds that need it. Location is untouched. */
function isolationNegativeFor(kind, base) {
    if (!ISOLATED_KINDS.includes(kind)) return base;
    return base ? `${base}, ${ISOLATION_NEGATIVE}` : ISOLATION_NEGATIVE;
}

/**
 * The opening of a subject plate: medium, then an empty frame, before anything
 * else is said.
 *
 * Stating isolation AFTER the style was not enough and the measurement is the
 * argument: a real style preset put 276 characters of "hard low-sun key raking
 * through glass … light visible as shafts in heavy haze … practical tungsten
 * warmth blooming in frame" ahead of it. Every one of those phrases is a room
 * with a window in it, asserted first and at length. Whatever leads a prompt is
 * what the image is of.
 *
 * Leading with the medium does NOT reintroduce the clip-art defect this
 * ordering was built to fix. That rule is "an explicit medium must be named,
 * because the absence of one is what a model fills in with clip art" — and
 * "photoreal studio photograph" is a more explicit medium than a colour palette
 * is. What must never lead again is the old `character reference sheet, front
 * view, T-pose` boilerplate, which names a DOCUMENT.
 */
function subjectPlateOpening(medium, framing) {
    /*
     * The MEDIUM carries what kind of picture this is; the framing noun stays
     * neutral so the two cannot contradict each other. Hardcoding "photograph"
     * produced "stylised 3D animation … full-body studio PHOTOGRAPH", which
     * asks for two incompatible things in one clause and lets the model pick.
     *
     * A full stop after the medium, then the framing: the medium is a
     * statement about the whole picture, not another item in a list.
     *
     * No terminal punctuation at the end — the builders comma-join their
     * parts, and a full stop there produced "…nothing else visible., ".
     */
    return `${medium}. ${framing}, ${ISOLATION_CLAUSE}`;
}

/**
 * A SUBJECT PLATE TAKES THE MEDIUM, NOT THE STYLE PRESET.
 *
 * The style preset is written to describe finished FRAMES, so it is mostly a
 * description of a place: light through windows, practicals in shot, negative
 * space, camera movement. On a keyframe that is exactly right. On a plate it
 * asks for the room the plate exists to exclude — measured at 276 characters
 * of "hard low-sun key raking through glass … shafts in heavy haze" ahead of
 * anything else.
 *
 * Scoping it with a "read this as look only" instruction was the first attempt
 * and it is a hedge: it hands the model the rooms and asks it not to build
 * them. The honest answer is that a plate needs exactly ONE thing from the
 * look — the MEDIUM. Photoreal, 3D render, cel animation, stop-motion. That is
 * what has to match across a production, and it is the thing that made a plate
 * come back as a flat vector cutout when it was left unsaid.
 *
 * The mood board already records it: `medium` is the first entry in
 * KIND_ORDER, ahead of palette, precisely because it decides what kind of
 * picture this is. So the board is the source, and the scene description stays
 * where it belongs — on the frames.
 */
const DEFAULT_MEDIUM = 'photoreal, shot on a real camera';

/**
 * The medium a project's plates are rendered in.
 *
 * Read from the mood board's `medium` entries. Falls back to photoreal rather
 * than to nothing: an unstated medium is exactly what a model fills in with
 * clip art, which is the defect the whole style-leads ordering was built
 * against.
 *
 * Never throws — a board that cannot be read must not stop a plate from being
 * generated, the rule stampAsset already documents.
 */
/**
 * Words that name what KIND of picture this is.
 *
 * Deliberately short and concrete, and matched on WHOLE WORDS. The style-check
 * work already paid for the alternative: substring matching turns "grainy" into
 * "rain", and a detector that fires on ordinary description gets switched off
 * within a day and then protects nothing.
 */
const MEDIUM_WORDS = Object.freeze([
    'painted', 'painting', 'paint', 'painterly', 'hand-painted', 'illustration', 'illustrated',
    'concept art', 'matte painting', 'watercolour', 'watercolor', 'gouache', 'oil', 'acrylic',
    'ink', 'inked', 'halftone', 'comic', 'graphic novel', 'woodcut', 'etching', 'linocut',
    'charcoal', 'pastel', 'sketch', 'sketched', 'drawn', 'line art', 'storybook',
    'cel', 'anime', 'animation', 'animated', 'cartoon', 'claymation', 'stop-motion',
    '2d', '3d', 'render', 'rendered', 'cg', 'cgi', 'low-poly', 'voxel', 'pixel art',
    'photoreal', 'photorealistic', 'photograph', 'photographic', 'live-action', 'film still',
]);

/**
 * The medium a style preset declares, in the DIRECTOR'S OWN WORDS.
 *
 * Returns the sentences of the preset that name a medium, and nothing else.
 * Whole sentences rather than matched keywords because the phrasing carries
 * meaning a label would lose — "NOT a photograph, NOT photorealistic" is the
 * instruction, and a tidy summary like "painted" throws away the negation that
 * the model most needs to hear.
 *
 * Only the medium sentences: an isolated plate takes the MEDIUM and never the
 * scene, because a real preset is largely a description of a room and appending
 * it is what once produced plates that WERE rooms.
 */
function mediumFromStyle(style) {
    const text = String(style || '').trim();
    if (!text) return '';
    /*
     * CLAUSES, not sentences.
     *
     * A real style preset is usually one long comma-separated string with no
     * full stops at all — the project that exposed this is a single sentence
     * of forty clauses. Splitting on sentences returned the WHOLE preset as
     * the "medium", which is precisely the scene-description leak that
     * isolating these plates exists to prevent: colour, lighting, lens and
     * period would all have gone into a character plate.
     */
    const clauses = text.split(/(?<=[.!?])\s+|\n+|,/).map(x => x.trim()).filter(Boolean);
    const names = clause => MEDIUM_WORDS.some(w => new RegExp(
        `(^|[^a-z0-9-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9-]|$)`, 'i',
    ).test(clause.toLowerCase()));
    // Join with a comma, except after a clause that already ended a sentence —
    // "ILLUSTRATION., Hand-painted" is text a model reads.
    return clauses.filter(names).reduce((out, clause) => (
        !out ? clause : `${out}${/[.!?]$/.test(out) ? '' : ','} ${clause}`
    ), '').replace(/\s+/g, ' ').trim();
}

function projectMedium(projectId, database) {
    /*
     * Where a character or prop plate's medium comes from, in order:
     *
     *   1. the mood board's `medium` entry — stated deliberately, so it wins;
     *   2. the medium named in the project's STYLE PRESET;
     *   3. the photoreal default, only when neither says anything.
     *
     * Step 2 was missing, and it is the whole bug. A real project's preset
     * opened "A PAINTED DIGITAL ILLUSTRATION. Hand-painted concept art. NOT a
     * photograph, NOT photorealistic" — with no board entry, every character
     * plate was told "photoreal, shot on a real camera" instead. No wording
     * could win, because the preset was never in the prompt: three paid
     * attempts changed only the colour, which is exactly what a reference used
     * as a grade rather than a medium does.
     *
     * Locations were unaffected because they are not isolated and get the whole
     * preset — hence painted places and photographic people in one film.
     */
    if (!projectId) return DEFAULT_MEDIUM;
    try {
        const db = database || require('../db/database').db;
        const rows = db.prepare(
            `SELECT note FROM film_mood_board
              WHERE project_id = ? AND kind = 'medium' AND TRIM(note) <> ''
              ORDER BY sort_order, created_at`).all(projectId);
        const stated = rows.map(r => String(r.note).trim()).filter(Boolean).join(', ');
        if (stated) return stated;

        const project = db.prepare('SELECT style_preset FROM film_projects WHERE id = ?').get(projectId);
        const fromStyle = mediumFromStyle(project && project.style_preset);
        // The default is right when nobody has said otherwise; inventing a
        // medium would silently restyle every project that never named one.
        return fromStyle || DEFAULT_MEDIUM;
    } catch (_) {
        return DEFAULT_MEDIUM;
    }
}

module.exports = {
    ISOLATED_KINDS, ISOLATION_CLAUSE, ISOLATION_NEGATIVE, isolationNegativeFor,
    subjectPlateOpening, projectMedium, mediumFromStyle, MEDIUM_WORDS, DEFAULT_MEDIUM,
};
