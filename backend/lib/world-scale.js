/**
 * World scale — turning a reconstruction's own units into metres.
 *
 * Marble promises no unit. The spike reported a street as 39.6 x 9.0 x 47.9 and
 * deliberately called that UNCALIBRATED rather than metres, because a size
 * stated confidently in the wrong unit is worse than one that says it does not
 * know. Every focal length, framing distance and depth-of-field figure in this
 * engine is metric, so until somebody measures a known thing inside the world,
 * those numbers describe nothing.
 *
 * THE RULE THIS MODULE EXISTS TO HOLD: a NULL factor is not 1.0.
 *
 * "Nobody has measured this" and "this measures 1:1" are different claims.
 * Spelling them the same is how a wrong distance reaches a lens calculation
 * looking deliberate — so `toMetres` returns null rather than the input, and
 * every surface that shows a distance has to decide what to do about that
 * rather than being handed a plausible number.
 *
 * Pure: no database, no I/O. The factor is stored on the version and applied
 * on READ, once, in lib/worlds.js — never baked into the stored mesh, because a
 * mesh scaled twice is indistinguishable from one scaled once.
 */

/**
 * What a director can measure against.
 *
 * All five reduce to the same arithmetic — a known real size over the number of
 * world units it spans. They are named separately because the SOURCE is the
 * audit trail: "1.68 m because that is Maya's height" can be argued with, and a
 * bare 0.8227 cannot.
 */
const CALIBRATION_SOURCES = Object.freeze([
    'character_height',
    'door_height',
    'car_length',
    'distance',
    'custom',
]);

function positive(value, label) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number`);
    if (n <= 0) throw new Error(`${label} must be positive`);
    return n;
}

/**
 * Compute a scale factor from one known measurement.
 *
 * Refuses rather than clamps. A measured span of zero is a division by zero
 * that becomes Infinity metres, and every distance on the screen then reads as
 * nonsense with no indication of where it went wrong — so a degenerate input is
 * rejected at the point somebody typed it, where it is cheap and unambiguous.
 *
 * @param {{source:string, knownMeters:number, measuredUnits:number}} input
 * @returns {{factor:number, source:string, knownMeters:number, measuredUnits:number}}
 */
function calibrate(input) {
    const opts = input || {};
    const source = String(opts.source || '');
    if (!CALIBRATION_SOURCES.includes(source)) {
        throw new Error(`Unknown calibration source '${source}'. Known: ${CALIBRATION_SOURCES.join(', ')}`);
    }
    const knownMeters = positive(opts.knownMeters, 'known size in metres');
    const measuredUnits = positive(opts.measuredUnits, 'measured span in world units');
    return { factor: knownMeters / measuredUnits, source, knownMeters, measuredUnits };
}

/**
 * Convert a world-unit value to metres, or answer that it cannot be.
 *
 * Returns null on an uncalibrated world. Never `value`, never `value * 1`.
 */
function toMetres(value, factor) {
    const f = Number(factor);
    if (!Number.isFinite(f) || f <= 0) return null;
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    return v * f;
}

/** The two words a surface may show about a world's scale. */
function describeScale(version) {
    const f = version && Number(version.scale_factor);
    return Number.isFinite(f) && f > 0 ? 'SCALE CALIBRATED' : 'APPROXIMATE SCALE';
}

/** Scale a bounds/size triple, or hand back null when there is no factor. */
function scaleTriple(triple, factor) {
    if (!Array.isArray(triple)) return triple;
    const f = Number(factor);
    if (!Number.isFinite(f) || f <= 0) return triple.slice();
    return triple.map(n => n * f);
}

module.exports = { CALIBRATION_SOURCES, calibrate, toMetres, describeScale, scaleTriple };
