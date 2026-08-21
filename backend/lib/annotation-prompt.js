/**
 * PAR-026: markup that feeds the next generation.
 *
 * Storyboard markup shipped as NOTATION — arrows, shapes and notes stored
 * against the shot, drawn on the frame, and read by nothing in generation. An
 * arrow drawn to mean "dolly in" changed no prompt and no payload. Whether it
 * SHOULD was Open Question 3 of the parity epic, deliberately left unanswered
 * because the answer is not obviously yes.
 *
 * The answer is yes, opt-in. Two facts decide the shape of it:
 *
 * 1. **Geometry says where, never what.** An arrow at (0.2,0.3)→(0.7,0.6) is a
 *    place and a direction, and a model asked to act on it has nothing to act
 *    on. So a mark becomes a direction ONLY when it carries a note. A shape
 *    with no words is still notation, still stored, still drawn — it simply
 *    does not reach the prompt, and it is REPORTED as not reaching it rather
 *    than silently dropped. Silence is what makes a director believe their
 *    three arrows changed the frame when nothing did.
 *
 * 2. **Normalised coordinates are already the frame's own vocabulary.** 0..1
 *    means the same thing at 1024px and at 4K, so a point converts to "the
 *    bottom right" honestly — where a pixel coordinate could not. This is the
 *    payoff of a decision made for a different reason: markup was normalised so
 *    it survived a regeneration at another resolution, and that is exactly what
 *    makes it sayable in words.
 *
 * Pure: no database, no I/O, no trimming. The caller owns the ceiling, because
 * the caller is the only thing that knows which provider is about to run and
 * how much of the prompt is already spoken for.
 */

/**
 * A third of the frame, in each axis.
 *
 * Three bands rather than five: "the upper-left-of-centre" is a precision this
 * data does not have, and a model reads it as noise. A director drawing an
 * arrow means a region, not a coordinate.
 */
function band(v, names) {
    const n = Number(v);
    if (!Number.isFinite(n)) return names[1];
    if (n < 1 / 3) return names[0];
    if (n < 2 / 3) return names[1];
    return names[2];
}

const X_NAMES = ['left', 'centre', 'right'];
const Y_NAMES = ['top', 'middle', 'bottom'];

/** Where a normalised point sits, said the way a frame is described. */
function regionOf(point) {
    const p = Array.isArray(point) ? point : [0.5, 0.5];
    const x = band(p[0], X_NAMES);
    const y = band(p[1], Y_NAMES);
    if (x === 'centre' && y === 'middle') return 'centre of frame';
    if (y === 'middle') return `${x} of frame`;
    if (x === 'centre') return `${y} centre`;
    return `${y} ${x}`;
}

/** The centre of whatever was drawn. */
function centroid(points) {
    const pts = (points || []).filter(p => Array.isArray(p) && p.length === 2);
    if (!pts.length) return [0.5, 0.5];
    return [
        pts.reduce((s, p) => s + Number(p[0] || 0), 0) / pts.length,
        pts.reduce((s, p) => s + Number(p[1] || 0), 0) / pts.length,
    ];
}

/** How wide the mark is, as a share of the frame, to the nearest 5%. */
function widthPercent(points) {
    const pts = (points || []).filter(p => Array.isArray(p) && p.length === 2);
    if (pts.length < 2) return null;
    const xs = pts.map(p => Number(p[0] || 0));
    const span = Math.max(...xs) - Math.min(...xs);
    if (!Number.isFinite(span) || span <= 0) return null;
    return Math.max(5, Math.round(span * 100 / 5) * 5);
}

/**
 * Where each kind of mark is, in words.
 *
 * An arrow and a line both have two ends and mean different things by them: an
 * arrow points, so its ends are ordered and the phrase keeps the order; a line
 * divides, so its ends are interchangeable and the phrase does not imply a
 * direction. Collapsing the two would turn "split the frame here" into "move
 * this there", which is a different instruction.
 */
function placePhrase(kind, points) {
    const pts = (points || []).filter(p => Array.isArray(p) && p.length === 2);
    const here = regionOf(centroid(pts));

    if (kind === 'arrow' && pts.length >= 2) {
        const from = regionOf(pts[0]);
        const to = regionOf(pts[pts.length - 1]);
        return from === to ? `at the ${from}` : `from the ${from} toward the ${to}`;
    }
    if (kind === 'line' && pts.length >= 2) {
        const a = regionOf(pts[0]);
        const b = regionOf(pts[pts.length - 1]);
        return a === b ? `at the ${a}` : `along a line from the ${a} to the ${b}`;
    }
    if (kind === 'rect' || kind === 'ellipse') {
        const w = widthPercent(pts);
        const shape = kind === 'rect' ? 'in the area at the' : 'around the';
        return w ? `${shape} ${here}, about ${w}% of the frame wide` : `${shape} ${here}`;
    }
    if (kind === 'freehand') return `around the ${here}`;
    return `at the ${here}`;
}

/**
 * Every mark, with whether it reaches the prompt and why.
 *
 * Returns ALL of them, used and unused. A caller that only wanted the used ones
 * could filter, but every caller here wants both: the report surfaces are the
 * point of the feature being trustworthy, and "2 marks had no note" is the one
 * sentence that stops a director re-drawing arrows that were never going to do
 * anything.
 */
function annotationDirectives(annotations) {
    return (annotations || []).map(a => {
        const kind = String((a && a.kind) || '').trim();
        const text = String((a && a.text) || '').trim();
        const points = Array.isArray(a && a.points) ? a.points : [];
        const place = placePhrase(kind, points);

        if (!text) {
            const noun = kind || 'mark';
            return {
                id: a && a.id, kind, text: '', place, feeds: false,
                reason: `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun} with no note says where `
                    + 'but not what — add a note and it becomes a direction',
                phrase: null,
            };
        }
        return {
            id: a && a.id, kind, text, place, feeds: true, reason: null,
            phrase: `${text} (${place})`,
        };
    });
}

/**
 * The marks, as one clause of a prompt.
 *
 * Joined with '; ' and labelled, the same shape the scale notes use, because a
 * run of unlabelled imperatives in the middle of a scene description reads as
 * part of the scene: "remove the sprinkler" becomes something to draw.
 *
 * Order is the order they were drawn. A director's second thought comes after
 * their first, and re-sorting by position or by kind would silently reorder
 * their reasoning.
 */
function directionClause(annotations) {
    const items = annotationDirectives(annotations);
    const used = items.filter(d => d.feeds);
    return {
        text: used.length ? `Direction: ${used.map(d => d.phrase).join('; ')}` : '',
        directives: items,
        used: used.length,
        skipped: items.length - used.length,
    };
}

/**
 * The marks, as an instruction for refining a frame you already have.
 *
 * Refine attaches the picture, so a transformational note — "move the car to
 * the kerb" — means exactly what it says: the thing being moved is visible and
 * the place is on screen. That is not true of a regeneration from the card,
 * where there is no previous frame and "move" has nothing to move from. Same
 * marks, two honest readings, so two builders rather than one that pretends the
 * difference away.
 */
function refineInstruction(annotations) {
    const items = annotationDirectives(annotations);
    const used = items.filter(d => d.feeds);
    return {
        text: used.map(d => `${d.text} (${d.place})`).join('. '),
        directives: items,
        used: used.length,
        skipped: items.length - used.length,
    };
}

module.exports = {
    regionOf,
    placePhrase,
    annotationDirectives,
    directionClause,
    refineInstruction,
};
