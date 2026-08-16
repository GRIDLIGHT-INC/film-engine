/**
 * Previs optics — phase 0.
 *
 * Pure functions over a lens, a sensor and a distance. No database, no DOM, no
 * provider: the maths that decides where a camera stands is the same whether it
 * is driven by a viewer, a route or a test, and keeping it free of I/O is what
 * lets phase 0's exit criterion be checked against published lens charts rather
 * than against our own output.
 *
 * The governing idea is that a focal length means nothing on its own. A 50 is
 * "normal" on Super 35, long on Micro Four Thirds and wide on IMAX 65, because
 * angle of view is a relationship between the lens and the physical gate. So
 * every function here takes a sensor, and there is no default — a caller that
 * has not decided which camera it is has not asked an answerable question.
 *
 * Units, chosen to match the discipline they come from: focal lengths and
 * sensor dimensions in millimetres, because that is what is engraved on a lens;
 * distances in metres, because that is what a tape measure on set reads.
 *
 * Its documented twin is docs/plans/previs-camera-taxonomy.json, and
 * tests/previs-plan.test.js asserts the two agree in both directions — a
 * registry that quietly disagrees with the design it implements would produce a
 * viewer that offers sensors the plan never costed.
 */

// ── Registries ──────────────────────────────────────────────────────────────

/**
 * Circle of confusion is stored per sensor rather than as one constant: it is
 * the largest blur circle still read as a point at final viewing size, so it
 * scales with the gate. Using the 35mm-still 0.03mm everywhere would report a
 * Super 16 frame as far sharper than it is.
 */
const SENSORS = {
    super35: { id: 'super35', label: 'Super 35 (3-perf)', widthMm: 24.89, heightMm: 18.66, circleOfConfusionMm: 0.025 },
    fullframe: { id: 'fullframe', label: 'Full Frame / VistaVision', widthMm: 36.0, heightMm: 24.0, circleOfConfusionMm: 0.03 },
    s16: { id: 's16', label: 'Super 16', widthMm: 12.52, heightMm: 7.41, circleOfConfusionMm: 0.015 },
    m43: { id: 'm43', label: 'Micro Four Thirds', widthMm: 17.3, heightMm: 13.0, circleOfConfusionMm: 0.015 },
    imax65: { id: 'imax65', label: 'IMAX 65mm 15-perf', widthMm: 70.41, heightMm: 52.63, circleOfConfusionMm: 0.045 },
    phone: { id: 'phone', label: 'Phone (1/1.7")', widthMm: 7.6, heightMm: 5.7, circleOfConfusionMm: 0.008 },
};

const DEFAULT_SENSOR = 'super35';

/** A standard cine prime set. Zooms are expressed as a focal at a moment in time. */
const LENS_KIT = [12, 14, 16, 18, 21, 25, 27, 32, 35, 40, 50, 65, 75, 85, 100, 135, 150, 200];

const APERTURES = [1.3, 1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0, 22.0];

// ── Guards ──────────────────────────────────────────────────────────────────
//
// These throw rather than clamping. A focal length of zero is not a wide lens,
// it is a caller bug, and returning 180 degrees for it would put a camera
// somewhere plausible-looking and wrong — the exact failure previs exists to
// prevent.

function requirePositive(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`previs: ${name} must be a positive number, got ${value}`);
    }
    return value;
}

function requireSensor(sensor) {
    if (!sensor || typeof sensor !== 'object' || !(sensor.widthMm > 0) || !(sensor.heightMm > 0)) {
        throw new Error('previs: a sensor with widthMm and heightMm is required');
    }
    return sensor;
}

/** Look a sensor up by id. Unknown ids throw: silently defaulting hides a typo. */
function sensorFor(id) {
    const sensor = SENSORS[id];
    if (!sensor) {
        throw new Error(`previs: unknown sensor '${id}' (known: ${Object.keys(SENSORS).join(', ')})`);
    }
    return sensor;
}

// ── Angle of view ───────────────────────────────────────────────────────────

const toDeg = rad => rad * 180 / Math.PI;

/**
 * Angle of view for a lens on a gate.
 *
 *   angle = 2 * atan( gate / (2 * focal) )
 *
 * Applied separately to width and height because a cinema frame is not square
 * and the vertical angle is what governs whether a head fits.
 */
function fieldOfView(focalMm, sensor) {
    requirePositive(focalMm, 'focal length');
    requireSensor(sensor);

    const diagonalMm = Math.hypot(sensor.widthMm, sensor.heightMm);
    return {
        hDeg: toDeg(2 * Math.atan(sensor.widthMm / (2 * focalMm))),
        vDeg: toDeg(2 * Math.atan(sensor.heightMm / (2 * focalMm))),
        diagonalDeg: toDeg(2 * Math.atan(diagonalMm / (2 * focalMm))),
    };
}

/**
 * What the frame covers at a given distance — the inverse of framingDistance.
 *
 * Similar triangles: the gate is to the focal length as the covered area is to
 * the distance. Note this is the thin-lens approximation, exact enough at any
 * distance a previs stage cares about and wrong only in macro.
 */
function frameCoverage(distanceM, focalMm, sensor) {
    requirePositive(distanceM, 'distance');
    requirePositive(focalMm, 'focal length');
    requireSensor(sensor);

    return {
        widthM: distanceM * sensor.widthMm / focalMm,
        heightM: distanceM * sensor.heightMm / focalMm,
    };
}

/**
 * Where to stand so a subject of a given height exactly fills the frame.
 *
 * This is the function the whole feature is for. "Close-up on a 50" stops being
 * two tokens and becomes 1.21 m from the subject; on an 85 it is 2.05 m. If the
 * room is three metres deep, that is now a fact rather than a discovery made on
 * the day.
 */
function framingDistance(subjectHeightM, focalMm, sensor) {
    requirePositive(subjectHeightM, 'subject height');
    requirePositive(focalMm, 'focal length');
    requireSensor(sensor);

    return focalMm * subjectHeightM / sensor.heightMm;
}

/** Where to stand so a subject of a given WIDTH fills the frame — two-shots. */
function framingDistanceForWidth(subjectWidthM, focalMm, sensor) {
    requirePositive(subjectWidthM, 'subject width');
    requirePositive(focalMm, 'focal length');
    requireSensor(sensor);

    return focalMm * subjectWidthM / sensor.widthMm;
}

/** The focal length giving the same view on full frame. Crew shorthand. */
function equivalentFocalLength(focalMm, sensor) {
    requirePositive(focalMm, 'focal length');
    requireSensor(sensor);
    return focalMm * (SENSORS.fullframe.widthMm / sensor.widthMm);
}

// ── Depth of field ──────────────────────────────────────────────────────────

/**
 * H = f^2 / (N * c) + f
 *
 * Focus here and everything from H/2 to infinity is acceptably sharp. The
 * trailing `+ f` is small but kept: dropping it is the usual approximation, and
 * it is exactly the term that makes the H/2 identity come out clean.
 */
function hyperfocalDistance(focalMm, fStop, sensor) {
    requirePositive(focalMm, 'focal length');
    requirePositive(fStop, 'aperture f-number');
    requireSensor(sensor);

    const c = requirePositive(sensor.circleOfConfusionMm, 'circle of confusion');
    return (focalMm * focalMm / (fStop * c) + focalMm) / 1000;
}

/**
 * Near and far limits of acceptable sharpness at a focus distance.
 *
 *   near = d*f^2 / ( f^2 + N*c*(d - f) )
 *   far  = d*f^2 / ( f^2 - N*c*(d - f) )
 *
 * The far denominator reaches zero at the hyperfocal distance and goes negative
 * beyond it. Both cases mean the same thing physically — sharp to infinity — so
 * they return Infinity rather than a negative distance, which is how a naive
 * transcription of the formula reports a landscape.
 *
 * The infinity test is made against the hyperfocal distance, NOT against the
 * sign of that denominator. Algebraically the two are the same test; in floating
 * point they are not. At d = H the denominator is a cancellation that lands on
 * a residue near 1e-13 rather than on zero, and its sign is then arbitrary — so
 * the sign test reports a far limit of some 1e13 metres for perhaps a third of
 * lens and stop combinations. Finite, absurd, and indistinguishable from a real
 * number to everything downstream. Comparing distances instead compares two
 * quantities of the same magnitude, where the epsilon is meaningful.
 *
 * Reported as a range, not as a blur: the useful previs output is "T2.8 on the
 * 85 at 2 m gives you 1.94 to 2.06", which tells a director the actor cannot
 * lean forward.
 */
function depthOfField(focalMm, fStop, focusDistanceM, sensor) {
    requirePositive(focalMm, 'focal length');
    requirePositive(fStop, 'aperture f-number');
    requirePositive(focusDistanceM, 'focus distance');
    requireSensor(sensor);

    const c = sensor.circleOfConfusionMm;
    const f = focalMm;
    const d = focusDistanceM * 1000;          // work in millimetres throughout
    const spread = fStop * c * (d - f);

    const nearM = ((d * f * f) / (f * f + spread)) / 1000;

    const hyperfocalM = hyperfocalDistance(focalMm, fStop, sensor);
    const atOrBeyondHyperfocal = focusDistanceM >= hyperfocalM * (1 - 1e-9);
    const farM = atOrBeyondHyperfocal ? Infinity : ((d * f * f) / (f * f - spread)) / 1000;

    return {
        nearM,
        farM,
        hyperfocalM,
        totalM: Number.isFinite(farM) ? farM - nearM : Infinity,
        inFrontM: focusDistanceM - nearM,
        behindM: Number.isFinite(farM) ? farM - focusDistanceM : Infinity,
    };
}

module.exports = {
    SENSORS, LENS_KIT, APERTURES, DEFAULT_SENSOR,
    sensorFor, fieldOfView, frameCoverage,
    framingDistance, framingDistanceForWidth, equivalentFocalLength,
    hyperfocalDistance, depthOfField,
};
