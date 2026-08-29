/**
 * WHERE A PAGE MAY BREAK.
 *
 * The editor paginated by counting lines and inserting a break the moment the
 * count crossed 55, wherever that happened to land. On a real screenplay that
 * put three of five breaks in places the format forbids:
 *
 *     break after character "JUNE"       -> "You took the good car." alone overleaf
 *     break after character "RAY"        -> "I knew." alone overleaf
 *     break after parenthetical "(beat)" -> "I don't want to." alone overleaf
 *
 * A character cue stranded at the foot of one page with its dialogue at the top
 * of the next reads as ACTION, because there is no cue above it — which is
 * exactly what it looked like: correct margins, wrong meaning. Leaving the page
 * and coming back re-rendered from the saved Fountain and "fixed" it, so the
 * text was never damaged; only the view was.
 *
 * KEEP_WITH_NEXT is the rule every screenplay application implements. It is
 * declared per element type rather than as a list of special cases, so a new
 * element type has to state its answer instead of silently defaulting to
 * breakable.
 */

/** Every element type the editor can produce. The denominator for the rule. */
const ELEMENT_TYPES = [
    'action', 'scene-heading', 'character', 'dialogue', 'parenthetical',
    'transition', 'centered', 'dual-dialogue', 'lyrics', 'note',
];

/**
 * May a page end immediately after this element?
 *
 * `false` means the element belongs with whatever follows it and the break must
 * move up. Each answer carries its reason: a rule with no reason is one the
 * next person relaxes.
 */
const MAY_END_PAGE = Object.freeze({
    action: true,
    dialogue: true,          // a long speech may split; screenplays do this with (MORE)
    transition: true,        // a transition ENDS a beat — a natural page foot
    centered: true,
    lyrics: true,
    note: true,
    // A heading alone at the foot of a page announces a scene that is not there.
    'scene-heading': false,
    // The cue and its dialogue are one unit. Split, the dialogue reads as action.
    character: false,
    // Belongs to the dialogue beneath it, and means nothing on its own.
    parenthetical: false,
    // Two speakers side by side; splitting them loses which is which.
    'dual-dialogue': false,
});

/**
 * One element type, spelled two ways.
 *
 * The EDITOR writes `data-element-type="scene-heading"`; the PARSER and
 * `film_script_elements` store `scene_heading`. Both are in the build and
 * neither is wrong — they simply never met, because pagination runs on the
 * editor's DOM and nothing else measured the stored rows.
 *
 * It stops being harmless the moment anything measures a screenplay from the
 * DATABASE: `elementLines('scene_heading', n)` misses every case and falls to
 * the default, so a heading is billed as a paragraph of action. That is a
 * silent wrong number rather than an error, which is the worst kind.
 *
 * Normalised here, at the module that owns ELEMENT_TYPES, rather than in each
 * consumer — a second mapping is how the two spellings arose in the first place.
 */
function normalizeElementType(type) {
    const t = String(type || '').trim().toLowerCase().replace(/_/g, '-');
    return ELEMENT_TYPES.includes(t) ? t : t;
}

/** Lines each element occupies, at the editor's own estimates. */
const LINES_PER_PAGE = 55;
function elementLines(type, charCount) {
    switch (normalizeElementType(type)) {
        case 'scene-heading': return 2;
        case 'action': return Math.ceil(charCount / 60) + 1;
        case 'character': return 1;
        case 'dialogue': return Math.ceil(charCount / 35);
        case 'parenthetical': return 1;
        case 'transition': return 2;
        case 'centered': return 2;
        case 'dual-dialogue': return 1;
        case 'lyrics': return Math.ceil(charCount / 50) + 1;
        case 'note': return 1;
        default: return Math.ceil(charCount / 60) + 1;
    }
}

/**
 * Which blocks a page break goes AFTER.
 *
 * @param {Array<{type: string, length: number}>} blocks
 * @returns {number[]} indices; a break belongs after each one
 */
function pageBreakPositions(blocks) {
    const out = [];
    let line = 0;
    let page = 1;

    for (let i = 0; i < blocks.length; i++) {
        line += elementLines(blocks[i].type, blocks[i].length || 0);

        if (line >= LINES_PER_PAGE * page && i < blocks.length - 1) {
            /*
             * Walk the break UP past anything that belongs with what follows.
             *
             * Moving it up rather than down is what keeps the unit together:
             * pushing it down would leave the cue on the old page and orphan the
             * dialogue, which is the bug. Walking up sends the whole unit to the
             * next page, which is what a screenplay does.
             */
            let at = i;
            while (at >= 0 && MAY_END_PAGE[blocks[at].type] === false) at--;

            // Everything back to the page start belongs with the next page — a
            // whole page of unbreakable elements is not a thing a screenplay
            // produces, but refusing to loop for ever is cheaper than proving it.
            if (at < 0 || (out.length && at <= out[out.length - 1])) at = i;

            out.push(at);
            page++;
        }
    }
    return out;
}

module.exports = { ELEMENT_TYPES, MAY_END_PAGE, LINES_PER_PAGE, normalizeElementType, elementLines, pageBreakPositions };
