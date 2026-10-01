/**
 * The shot size, said one way.
 *
 * "IT SHOULD be a standard, and if I direct or use previz that should take over
 * and nothing else impacts that part." The scene card's `shot_type` mixes three
 * axes (framing, angle, rig) and its framing words were translated loosely: a
 * card saying `wide` reached the model as "wide angle shot", which is a LENS,
 * on a shot whose description said "from the knees up" and whose lens was 50mm.
 *
 * The standard is the crew vocabulary the Previs SHOT panel already uses: eight
 * shot sizes, each with the height of frame it covers on the subject. Each is
 * sent as one phrase that defines itself, so the model is told what the size
 * MEANS rather than handed a word it reads its own way.
 *
 * Precedence, decided once (`shotFraming`):
 *   1. Previs: the size the saved camera actually frames, read from its
 *      coverage at the framing subject's distance;
 *   2. the card's own `camera.framing`, set in the Direct panel;
 *   3. the card's `camera.shot_type`, when it is a size (wide, medium, …);
 *   4. nothing — no size is invented.
 *
 * `cover` is metres of frame height on the subject, the same numbers the Previs
 * page frames with (SHOT_FRAMINGS in src/index.html); tests/framing.test.js holds
 * the two lists equal.
 */
const FRAMINGS = Object.freeze([
    { id: 'ews', short: 'EWS', label: 'Extreme wide', cover: 8.0,
      phrase: 'extreme wide shot (EWS): the subject is small inside a large expanse of the place' },
    { id: 'ws', short: 'WS', label: 'Wide', cover: 3.2,
      phrase: 'wide shot (WS): the whole figure with generous space around and above it' },
    { id: 'fs', short: 'FS', label: 'Full', cover: 2.1,
      phrase: 'full shot (FS): head to toe, the figure filling the height of the frame' },
    { id: 'mws', short: 'MWS', label: 'Medium wide (cowboy)', cover: 1.35,
      phrase: 'medium wide shot (MWS): framed from the knees up' },
    { id: 'ms', short: 'MS', label: 'Medium', cover: 0.95,
      phrase: 'medium shot (MS): framed from the waist up' },
    { id: 'mcu', short: 'MCU', label: 'Medium close-up', cover: 0.62,
      phrase: 'medium close-up (MCU): framed from mid-chest up' },
    { id: 'cu', short: 'CU', label: 'Close-up', cover: 0.40,
      phrase: 'close-up (CU): the face fills most of the frame' },
    { id: 'ecu', short: 'ECU', label: 'Extreme close-up', cover: 0.16,
      phrase: 'extreme close-up (ECU): a single feature or detail fills the frame' },
]);

const BY_ID = new Map(FRAMINGS.map(f => [f.id, f]));

/**
 * The card shot types that ARE a size, and the size they mean. The rest of
 * `VALID_SHOT_TYPES` is an angle or a rig and says nothing about size, so it
 * maps to nothing and keeps its own phrase.
 */
const SHOT_TYPE_FRAMING = Object.freeze({
    'establishing': 'ews',
    'wide': 'ws',
    'medium': 'ms',
    'close-up': 'cu',
    'extreme-close-up': 'ecu',
});

/** The size whose coverage is nearest, compared on a log scale (sizes are ratios). */
function framingForCoverage(heightM) {
    const h = Number(heightM);
    if (!(h > 0)) return null;
    let best = null;
    for (const f of FRAMINGS) {
        const d = Math.abs(Math.log(f.cover / h));
        if (!best || d < best.d) best = { f, d };
    }
    return best ? best.f.id : null;
}

/**
 * The shot size for one shot, and where it came from.
 * @param {object} card     - the scene card
 * @param {object} [facets] - previsFacets() of the applied blocking
 * @returns {{ id: string|null, source: 'previs'|'card'|'shot_type'|null, phrase: string|null }}
 */
function shotFraming(card, facets) {
    const cam = (card && card.camera) || {};
    // Previs: measured coverage first, else a size the blocking states.
    const fromPrevis = facets && (framingForCoverage(facets.coverage_height_m)
        || (BY_ID.has(facets.framing) ? facets.framing : null)
        || SHOT_TYPE_FRAMING[facets.shot_type] || null);
    if (fromPrevis) return withPhrase(fromPrevis, 'previs');
    if (cam.framing && BY_ID.has(cam.framing)) return withPhrase(cam.framing, 'card');
    const mapped = SHOT_TYPE_FRAMING[cam.shot_type];
    if (mapped) return withPhrase(mapped, 'shot_type');
    return { id: null, source: null, phrase: null };
}

function withPhrase(id, source) {
    const f = BY_ID.get(id);
    return { id, source, phrase: f ? f.phrase : null };
}

module.exports = { FRAMINGS, SHOT_TYPE_FRAMING, framingForCoverage, shotFraming };
