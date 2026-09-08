/**
 * Whether a subject's views were shot at the same settings.
 *
 * PCC-002 and PCC-003 hold exposure and colour across a turnaround; PCC-006
 * records what each plate was actually shot at. This is where that recording
 * earns its place: four views that disagree produce a character who changes
 * brightness or colour between the frames they condition, and the only previous
 * way to notice was to open all four and look.
 */

const { CAPTURE_FIELDS } = require('./capture-settings');

/**
 * Tolerances, each with the unit it is measured in and why it is where it is.
 *
 * A bare number cannot be argued with later. These can.
 */
const TOLERANCES = Object.freeze({
    exposure: Object.freeze({
        value: 1 / 3, unit: 'stops',
        why: 'a third of a stop is the smallest step photographers work in and is at the edge of '
            + 'visibility; flagging less than that makes the report noise, and noise is what stops '
            + 'a report being read',
    }),
    white_balance: Object.freeze({
        value: 5, unit: 'mired',
        why: 'about the just-noticeable difference side by side. Mired rather than kelvin because '
            + 'the scale is reciprocal: 200K at tungsten is a visible shift and the same 200K at '
            + '8000K is not, so no single kelvin tolerance can serve both',
    }),
});

/**
 * What is compared, and from which recorded fields.
 *
 * EXPOSURE IS ISO x SHUTTER, NOT ISO AND SHUTTER. 1/60 at ISO 400 and 1/120 at
 * ISO 800 are the same exposure; comparing the fields separately flags an
 * identical pair of plates and sends a director to re-shoot a turnaround that
 * was correct.
 */
const COMPARED = Object.freeze({
    exposure: Object.freeze({
        from: ['iso', 'shutter_s'],
        why: 'brightness, as the product of the two settings that determine it',
    }),
    white_balance: Object.freeze({
        from: ['white_balance_k'],
        why: 'the colour of the light, in mired',
    }),
    lens: Object.freeze({
        from: ['lens'],
        why: 'categorical rather than a tolerance: a different lens is different perspective '
            + 'distortion, and two plates of one face on 13mm and 24mm do not match at any margin',
    }),
});

/** Recorded and deliberately not compared. Stated, so an omission is a decision. */
const NOT_COMPARED = Object.freeze({});

/** Micro reciprocal degrees — the perceptually even scale for colour temperature. */
const mired = (kelvin) => 1e6 / kelvin;

const usable = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Compare a subject's views.
 *
 * `agree` is deliberately three-valued. NULL means nothing could be compared —
 * every plate shot before PCC-006 is in that state, and reporting "these agree"
 * over an empty set is the most misleading answer available, because it is the
 * reassuring one.
 */
function compareViews(views) {
    const all = Array.isArray(views) ? views : [];

    // A view is comparable when it carries at least one thing worth comparing.
    const comparable = [], uncomparable = [];
    for (const v of all) {
        const c = v && v.capture;
        const has = c && typeof c === 'object' && Object.keys(CAPTURE_FIELDS).some(f => c[f] != null);
        (has ? comparable : uncomparable).push(v);
    }

    /*
     * Settings that are PRESENT and unusable — a zero ISO, a negative shutter,
     * a colour temperature of 0. These arrive from an unauthenticated upload,
     * and the first version of this silently dropped them: the view stopped
     * participating and the report said nothing, so a plate with a junk record
     * read exactly like one that agreed. Found by mutation, because loosening
     * the guard changed no answer — the check was defending nothing observable.
     *
     * Named per view and field, on PCC-006's own rule: absent is absent, and
     * saying so is the difference between a gap and a false reassurance.
     */
    const unusable = [];
    for (const v of comparable) {
        const c = v.capture;
        const junk = [];
        if (c.iso != null && !usable(c.iso)) junk.push('iso');
        if (c.shutter_s != null && !usable(c.shutter_s)) junk.push('shutter_s');
        if (c.white_balance_k != null && !usable(c.white_balance_k)) junk.push('white_balance_k');
        if (junk.length) unusable.push({ view: v.view, fields: junk });
    }

    const result = {
        agree: null,
        disagreements: [],
        compared: comparable.map(v => v.view),
        uncomparable: uncomparable.map(v => v.view),
        unusable,
        tolerances: TOLERANCES,
    };
    // One view is not a disagreement; there is nothing to compare it against.
    if (comparable.length < 2) return result;

    const worst = (key, valueOf, tolerance, describe) => {
        const points = comparable
            .map(v => ({ view: v.view, value: valueOf(v.capture) }))
            .filter(p => p.value != null);
        if (points.length < 2) return null;

        let lo = points[0], hi = points[0];
        for (const p of points) {
            if (p.value < lo.value) lo = p;
            if (p.value > hi.value) hi = p;
        }
        const amount = hi.value - lo.value;
        if (!Number.isFinite(amount) || amount <= tolerance.value) return null;
        return {
            field: key,
            views: [lo.view, hi.view],
            amount,
            unit: tolerance.unit,
            detail: describe(lo, hi, amount),
        };
    };

    // Exposure, in stops of the ISO x shutter product. Nonsense values are
    // dropped rather than compared: a zero shutter makes the ratio infinite and
    // would be reported as a disagreement of Infinity stops.
    const ev = (c) => (usable(c.iso) && usable(c.shutter_s)
        ? Math.log2(c.iso * c.shutter_s) : null);
    const exposure = worst('exposure', ev, TOLERANCES.exposure,
        (lo, hi, n) => `${hi.view} is ${n.toFixed(1)} stops brighter than ${lo.view}`);
    if (exposure) result.disagreements.push(exposure);

    const wb = (c) => (usable(c.white_balance_k) ? mired(c.white_balance_k) : null);
    const colour = worst('white_balance', wb, TOLERANCES.white_balance,
        (lo, hi, n) => `${hi.view} and ${lo.view} are ${n.toFixed(1)} mired apart `
            + `(${Math.round(1e6 / hi.value)}K against ${Math.round(1e6 / lo.value)}K)`);
    if (colour) result.disagreements.push(colour);

    // The lens is categorical: any difference at all.
    const lenses = comparable
        .filter(v => typeof v.capture.lens === 'string' && v.capture.lens)
        .map(v => ({ view: v.view, lens: v.capture.lens }));
    const distinct = [...new Set(lenses.map(l => l.lens))];
    if (distinct.length > 1) {
        result.disagreements.push({
            field: 'lens',
            views: lenses.map(l => l.view),
            amount: distinct.length,
            unit: 'lenses',
            detail: `shot on ${distinct.join(' and ')} — `
                + lenses.map(l => `${l.view} on ${l.lens}`).join(', '),
        });
    }

    result.agree = result.disagreements.length === 0;
    return result;
}

module.exports = { compareViews, TOLERANCES, COMPARED, NOT_COMPARED };
