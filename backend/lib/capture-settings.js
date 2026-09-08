/**
 * What a plate was shot at, recorded so a bad one can be diagnosed.
 *
 * A plate conditions every generated frame of its subject, so when one comes
 * back wrong the question is always which lens, how bright, what colour. Until
 * this existed the only answer was to shoot it again and watch.
 *
 * TWO RULES, AND BOTH ARE ABOUT NOT LOSING A PHOTOGRAPH.
 *
 * A BAD FIELD IS DROPPED, NEVER THE UPLOAD. These are a diagnostic aid.
 * Refusing a plate because the ISO arrived as a string would lose a photograph
 * the director has just taken and often cannot retake — the light has moved,
 * the subject has gone. It is the rule a refused clip coverage already follows:
 * report it, keep the file.
 *
 * ABSENT MEANS ABSENT. A plate shot before this existed, or uploaded from the
 * photo library, has no settings and must not acquire invented ones — the same
 * "NULL means outside the workflow" rule the fingerprint work established. An
 * invented but plausible ISO is worse than a gap, because it gets believed.
 */

/**
 * The settings worth recording, each with the range that makes it usable.
 *
 * `good` and `bad` are PROBES the test drives this module with, kept beside the
 * rule rather than in the test: a range and a separate list of examples is two
 * statements of one thing, and the examples are what goes stale.
 */
const CAPTURE_FIELDS = Object.freeze({
    lens: Object.freeze({
        type: 'string', max: 40,
        why: 'which lens, as the camera labelled it — "24mm", or a name where the angle is unknown',
        good: ['24mm', '13mm', 'Ultra Wide'],
        bad: ['', '   ', 42, null, 'x'.repeat(200)],
    }),
    iso: Object.freeze({
        type: 'number', min: 1, max: 1000000,
        why: 'sensor sensitivity: a noisy plate is usually a high one, and it is invisible afterwards',
        good: [34, 400, 3072],
        bad: [0, -100, 2000000, 'four hundred', NaN, Infinity],
    }),
    shutter_s: Object.freeze({
        type: 'number', min: 0.000001, max: 60,
        why: 'exposure duration in seconds; a soft plate is often a long one rather than bad focus',
        good: [1 / 8000, 1 / 60, 0.5],
        bad: [0, -1, 3600, '1/60', NaN],
    }),
    white_balance_k: Object.freeze({
        type: 'number', min: 1000, max: 20000,
        why: 'the colour of the light in kelvin, so a plate that disagrees with its siblings can be '
            + 'compared against them',
        good: [2700, 5600, 10000],
        bad: [0, 500, 50000, 'warm', NaN],
    }),
});

/**
 * A clean settings object, or null.
 *
 * Null rather than `{}` for anything with nothing usable in it: an empty
 * `capture` key on an asset claims "we recorded the settings and there were
 * none", which is a different and false statement from "not recorded".
 *
 * An allow-list, never a copy of the input. The body is unauthenticated and
 * this reaches a metadata column that is read back and rendered.
 */
function captureSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

    const out = {};
    for (const [name, f] of Object.entries(CAPTURE_FIELDS)) {
        const raw = input[name];
        if (raw === undefined || raw === null) continue;

        if (f.type === 'string') {
            if (typeof raw !== 'string') continue;
            const v = raw.trim();
            // REFUSED rather than truncated: a trimmed label is a value the
            // camera never reported, and it would be read as one it did.
            if (!v || v.length > f.max) continue;
            out[name] = v;
            continue;
        }

        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        if (raw < f.min || raw > f.max) continue;
        out[name] = raw;
    }
    return Object.keys(out).length ? out : null;
}

module.exports = { CAPTURE_FIELDS, captureSettings };
