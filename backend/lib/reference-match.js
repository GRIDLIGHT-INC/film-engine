/**
 * Match Reference Composition — V1, manual assist.
 *
 * A director has a frame they want: a Framed Ink panel, a storyboard, a movie
 * still. This turns the marks they draw on it into a camera configuration.
 *
 * THIS MODULE NEVER RECEIVES AN IMAGE, AND THAT IS THE POINT.
 *
 * Spec §30 puts automatic horizon finding, subject detection, segmentation and
 * vanishing-point detection in V2, and solving the transform against the
 * reference in V3. V1 is the marks a person makes. Taking only marks — never
 * pixels — is what makes "no automatic detection" a property of the signature
 * rather than a promise in a comment: there is nothing here to detect from.
 *
 * The failure this guards against is precise: a confidence number attached to
 * a computation that never ran. So every estimate declares what it NEEDS, an
 * estimate whose inputs were not marked is `null` WITH ITS REASON, and the
 * confidence is a function of what was actually marked rather than a constant
 * that makes an approximation look like a measurement.
 *
 * Pure. No database, no provider, and deliberately no model — the same
 * division the cinematography brief keeps: the engine computes geometry, and
 * everything that needs judgement stays with whoever is directing.
 */

const DEG = 180 / Math.PI;

/**
 * What a director can mark, and what each one buys.
 *
 * Ordered by how much they are worth: the horizon alone gives roll, and roll
 * is the one estimate here that is exact rather than approximate.
 */
const MARKS = Object.freeze([
    {
        id: 'horizon',
        what: 'two points on the horizon, or on any line that is level in the world',
        buys: ['roll', 'tilt', 'camera_height'],
    },
    {
        id: 'subject_box',
        what: 'a box around the subject, in fractions of the frame',
        buys: ['subject_occupancy', 'camera_height', 'composition_center'],
    },
    {
        id: 'subject_height_m',
        what: 'how tall that subject really is, in metres',
        buys: ['camera_height'],
    },
    {
        id: 'vanishing_lines',
        what: 'two or more lines that are parallel in the world',
        buys: ['lens_mm', 'perspective', 'vertical_convergence', 'vanishing_point'],
    },
    {
        id: 'focal_mm',
        what: 'the lens, when the director already knows it',
        buys: ['tilt'],
    },
]);

/**
 * The nine things §29 says the system estimates.
 *
 * Each declares the marks it needs. A registry rather than nine ad-hoc
 * branches, because the failure mode is partial: computing six and silently
 * omitting three reads as a complete solve.
 */
const ESTIMATES = Object.freeze([
    { id: 'roll', unit: 'deg', needs: ['horizon'],
      why: 'the angle of a line that is level in the world IS the camera roll' },
    { id: 'tilt', unit: 'deg', needs: ['horizon', 'focal_mm'],
      why: 'how far the horizon sits from the middle of the frame, read through the lens angle' },
    { id: 'camera_height', unit: 'm', needs: ['horizon', 'subject_box', 'subject_height_m'],
      why: 'the horizon crosses a standing subject at the camera\'s own height' },
    { id: 'subject_occupancy', unit: 'fraction', needs: ['subject_box'],
      why: 'the marked box against the frame — a measurement, not an estimate' },
    { id: 'composition_center', unit: 'xy', needs: ['subject_box'],
      why: 'where the subject sits in frame, which is what a framing note is about' },
    { id: 'lens_mm', unit: 'mm', needs: ['vanishing_lines'],
      why: 'how hard the parallels converge is the field of view' },
    { id: 'perspective', unit: 'class', needs: ['vanishing_lines'],
      why: 'FLAT / NORMAL / STRONG / EXTREME, from the same convergence' },
    { id: 'vertical_convergence', unit: 'deg', needs: ['vanishing_lines'],
      why: 'how far verticals lean, which is what says the camera is tilted rather than shifted' },
    { id: 'vanishing_point', unit: 'xy', needs: ['vanishing_lines'],
      why: 'where the parallels meet, in frame coordinates' },
]);

/** The sensor the estimates are read against when the caller names none. */
const DEFAULT_SENSOR = Object.freeze({ widthMm: 24.89, heightMm: 18.66 });   // Super 35

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pt = (p) => (Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null
    ? [Number(p[0]), Number(p[1])] : null);

/** Which marks are actually present and usable. */
function marksPresent(input) {
    const m = input || {};
    const present = new Set();
    const h = m.horizon;
    if (h && pt(h.a) && pt(h.b) && (pt(h.a)[0] !== pt(h.b)[0] || pt(h.a)[1] !== pt(h.b)[1])) {
        present.add('horizon');
    }
    const b = m.subject_box;
    if (b && num(b.x) !== null && num(b.y) !== null && num(b.w) > 0 && num(b.h) > 0) {
        present.add('subject_box');
    }
    if (num(m.subject_height_m) > 0) present.add('subject_height_m');
    if (Array.isArray(m.vanishing_lines) && m.vanishing_lines.length >= 2
        && m.vanishing_lines.every(l => l && pt(l.a) && pt(l.b))) {
        present.add('vanishing_lines');
    }
    if (num(m.focal_mm) > 0) present.add('focal_mm');
    return present;
}

/** Where two lines meet, in frame coordinates, or null if they are parallel. */
function intersect(l1, l2) {
    const [x1, y1] = l1.a, [x2, y2] = l1.b;
    const [x3, y3] = l2.a, [x4, y4] = l2.b;
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(d) < 1e-9) return null;                 // parallel in frame too
    return [
        ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / d,
        ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / d,
    ];
}

/**
 * Solve a camera configuration from marks.
 *
 * Every estimate comes back as { value, unit, why } or { value: null, blocked_by }
 * naming the marks that were not made. Nothing is guessed to fill a field.
 */
function solveMatch(input, opts) {
    const m = input || {};
    const o = opts || {};
    const sensor = o.sensor || DEFAULT_SENSOR;
    const present = marksPresent(m);
    const out = {};

    // ── roll · exact ────────────────────────────────────────────────────────
    let rollDeg = null;
    if (present.has('horizon')) {
        const a = pt(m.horizon.a), b = pt(m.horizon.b);
        // Frame coordinates run DOWN, so a horizon rising to the right has a
        // negative dy; the camera is rolled the other way.
        rollDeg = -Math.atan2(b[1] - a[1], b[0] - a[0]) * DEG;
        // A horizon marked right-to-left describes the same line, not a camera
        // rolled 180 degrees.
        if (rollDeg > 90) rollDeg -= 180;
        if (rollDeg < -90) rollDeg += 180;
    }

    // Where the horizon crosses the middle of the frame, which is the height
    // every other reading is taken from.
    let horizonY = null;
    if (present.has('horizon')) {
        const a = pt(m.horizon.a), b = pt(m.horizon.b);
        horizonY = Math.abs(b[0] - a[0]) < 1e-9
            ? (a[1] + b[1]) / 2
            : a[1] + (0.5 - a[0]) * (b[1] - a[1]) / (b[0] - a[0]);
    }

    // ── tilt · needs a lens to read the frame offset through ────────────────
    let tiltDeg = null;
    if (present.has('horizon') && present.has('focal_mm')) {
        const vFov = 2 * Math.atan((sensor.heightMm || DEFAULT_SENSOR.heightMm) / (2 * num(m.focal_mm)));
        // The horizon is the direction the camera would look if it were level.
        // Above the middle of frame means the camera is pointed DOWN.
        const t = (0.5 - horizonY) * 2 * Math.tan(vFov / 2);
        tiltDeg = -Math.atan(t) * DEG;
    }

    // ── camera height · the one that needs no lens at all ───────────────────
    let heightM = null;
    if (present.has('horizon') && present.has('subject_box') && present.has('subject_height_m')) {
        const b = m.subject_box;
        const top = num(b.y), bottom = num(b.y) + num(b.h);
        // The fraction of the subject BELOW the horizon is the fraction of its
        // real height that the camera stands at. Clamped, because a horizon
        // marked off the subject entirely is a legitimate mark — a camera below
        // their feet or above their head — and the answer is the bound, not NaN.
        const below = Math.min(1, Math.max(0, (horizonY - top) / (bottom - top)));
        heightM = below * num(m.subject_height_m);
    }

    // ── occupancy and centre · measurements of the box ──────────────────────
    let occupancy = null, centre = null;
    if (present.has('subject_box')) {
        const b = m.subject_box;
        occupancy = Math.min(1, Math.max(0, num(b.h)));
        centre = [num(b.x) + num(b.w) / 2, num(b.y) + num(b.h) / 2];
    }

    // ── the vanishing-line family ───────────────────────────────────────────
    let vp = null, lensMm = null, perspective = null, convergenceDeg = null;
    if (present.has('vanishing_lines')) {
        const lines = m.vanishing_lines.map(l => ({ a: pt(l.a), b: pt(l.b) }));
        const points = [];
        for (let i = 0; i < lines.length; i++) {
            for (let j = i + 1; j < lines.length; j++) {
                const p = intersect(lines[i], lines[j]);
                if (p) points.push(p);
            }
        }
        if (points.length) {
            vp = [
                points.reduce((s, p) => s + p[0], 0) / points.length,
                points.reduce((s, p) => s + p[1], 0) / points.length,
            ];
            /*
             * How far the vanishing point sits from the centre of frame is the
             * half-angle of view along that axis: a wide lens throws it close,
             * a long one throws it far outside the frame. This is an
             * APPROXIMATION and the module says so — a single vanishing point
             * fixes one angle, not a calibrated camera, which is what V3 is for.
             */
            const dx = Math.abs(vp[0] - 0.5);
            const dy = Math.abs(vp[1] - 0.5);
            const d = Math.max(1e-4, Math.hypot(dx, dy));
            const halfAngle = Math.atan(1 / (2 * d));
            lensMm = (sensor.widthMm || DEFAULT_SENSOR.widthMm) / (2 * Math.tan(halfAngle));
            perspective = d < 0.35 ? 'EXTREME' : d < 0.75 ? 'STRONG' : d < 2 ? 'NORMAL' : 'FLAT';
            // Verticals lean when the camera is tilted; how far is the angle
            // between the marked lines themselves.
            const angles = lines.map(l => Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]) * DEG);
            convergenceDeg = Math.abs(Math.max(...angles) - Math.min(...angles));
        }
    }

    const values = {
        roll: rollDeg,
        tilt: tiltDeg,
        camera_height: heightM,
        subject_occupancy: occupancy,
        composition_center: centre,
        lens_mm: lensMm,
        perspective,
        vertical_convergence: convergenceDeg,
        vanishing_point: vp,
    };

    for (const est of ESTIMATES) {
        const missing = est.needs.filter(n => !present.has(n));
        out[est.id] = missing.length
            // NAMED, never null-and-silent: "we could not read the lens" and
            // "the lens is zero" are different answers.
            ? { value: null, unit: est.unit, blocked_by: missing, why: est.why }
            : { value: values[est.id], unit: est.unit, why: est.why };
    }

    return {
        marks_used: [...present].sort(),
        marks_available: MARKS.map(x => x.id),
        estimates: out,
        confidence: confidenceFor(present),
        method: 'manual-assist',
        /*
         * Said in the payload, not only in a doc. §29: "This is an
         * approximation, not a promise of physical reconstruction."
         */
        note: 'An approximation from the marks you made — not a reconstruction of the '
            + 'original camera. Nothing here was detected automatically.',
    };
}

/**
 * Confidence, derived from the evidence rather than asserted.
 *
 * Weighted by what each mark actually determines: the horizon carries roll
 * exactly and is worth the most; a declared subject height is worth more than
 * the box alone, because without it the box measures occupancy and nothing
 * else. A solve with no marks is 0 — never a floor that makes an empty solve
 * look plausible.
 */
const MARK_WEIGHT = Object.freeze({
    horizon: 0.35, subject_box: 0.2, subject_height_m: 0.2,
    vanishing_lines: 0.15, focal_mm: 0.1,
});

function confidenceFor(present) {
    let sum = 0;
    for (const [id, w] of Object.entries(MARK_WEIGHT)) if (present.has(id)) sum += w;
    return Math.round(sum * 100) / 100;
}

/**
 * The camera fields a match may write, and nothing else.
 *
 * Spec §32's rule, and this is the feature most likely to break it: a match is
 * about the CAMERA, and a solve that also moved subjects or swapped the world
 * would restage a scene as a side effect of copying a composition. Declared,
 * because a constant nobody consults is how `NEVER_WRITES` sat inert.
 */
const APPLIES = Object.freeze(['focalMm', 'cameraHeightM', 'tiltDeg', 'rollDeg',
                               'framingMode', 'pinnedOccupancy']);

const NEVER_APPLIES = Object.freeze(['subjects', 'blocking', 'world', 'world_version_id',
                                     'position', 'target', 'style_preset']);

/**
 * Turn a solve into a camera proposal.
 *
 * Returns the SAME shape `cinematography.applyProposal` takes, so a match goes
 * through the validator every other camera goes through — a composition copied
 * from a still can still put the camera inside a wall, and a second apply path
 * is how one of them comes to skip the checks.
 */
function proposalFrom(solved, opts) {
    const o = opts || {};
    const e = (solved && solved.estimates) || {};
    const val = (id) => (e[id] && e[id].value !== undefined ? e[id].value : null);
    const changes = {};

    if (val('lens_mm') !== null) changes.focalLengthMm = Math.round(val('lens_mm'));
    if (val('camera_height') !== null) changes.cameraHeightM = val('camera_height');
    if (val('tilt') !== null) changes.tiltDeg = val('tilt');
    if (val('roll') !== null) changes.rollDeg = val('roll');
    if (o.pinOccupancy && val('subject_occupancy') !== null) {
        changes.targetOccupancy = val('subject_occupancy');
    }

    return {
        // A rationale is required by validateProposal, and here it can be
        // TRUE rather than boilerplate: it names the marks and the confidence.
        rationale: `Matched from a marked reference (${(solved.marks_used || []).join(', ') || 'no marks'}) `
            + `at ${Math.round((solved.confidence || 0) * 100)}% confidence. Approximation, not a reconstruction.`,
        changes,
        // Carried so a caller can show what it is about to do before doing it.
        confidence: solved.confidence,
        applies: APPLIES.slice(),
    };
}

module.exports = {    MARKS, ESTIMATES, APPLIES, NEVER_APPLIES, DEFAULT_SENSOR,
    solveMatch, proposalFrom,};
