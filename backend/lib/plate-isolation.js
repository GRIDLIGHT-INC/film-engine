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
    'isolated on a plain seamless studio backdrop, the subject alone in an empty frame, '
    + 'no location, no room, no set, no scenery, nothing else visible';

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

module.exports = { ISOLATED_KINDS, ISOLATION_CLAUSE, ISOLATION_NEGATIVE, isolationNegativeFor };
