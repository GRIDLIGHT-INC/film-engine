/**
 * How big a thing is, said in a way an image model can act on.
 *
 * A diffusion model has no metric understanding — nothing in it knows a lawn
 * sprinkler is thirty centimetres. Worse, a reference plate actively fights
 * scale: a plate is a close-up filling its own frame, and conditioning
 * transfers appearance rather than size, so the model reproduces what it was
 * shown. The sprinkler plate produced a sprinkler the size of the car beside
 * it. The plate was doing its job; nothing was telling the model how big the
 * thing is.
 *
 * Three levers work, in descending order of strength:
 *
 *  1. FRAME FRACTION — "occupies about a twentieth of the frame width". The
 *     strongest, because it is a statement about composition rather than about
 *     the world. Only available when the shot has a lens and a distance, which
 *     is what previs supplies.
 *  2. ANCHOR — "knee-high beside the kerb", "spans three house widths". Works
 *     on any shot, and needs something of known size in frame to measure
 *     against.
 *  3. PLAIN MEASURE — "about 0.3m across". Weakest, and still worth saying when
 *     nothing else is available.
 *
 * Nothing here invents a size. An undeclared subject contributes no scale
 * language at all, because a guessed default is indistinguishable from a
 * deliberate one and would be wrong silently — which is the failure this exists
 * to end.
 */

/** Anchors a model reliably knows the size of, with their real dimensions. */
const ANCHORS = [
    { name: 'a kerbstone', m: 0.15 },
    { name: 'a car tyre', m: 0.65 },
    { name: 'a front door', m: 2.0 },
    { name: 'a parked car', m: 4.5 },
    { name: 'a single-storey house front', m: 8.0 },
    { name: 'a two-storey house', m: 9.0 },
];

/** The largest declared dimension, which is what reads as "how big it is". */
function sizeOf(kind, row) {
    if (!row) return null;
    const nums = (kind === 'character'
        ? [row.height_m]
        : [row.height_m, row.width_m, row.length_m])
        .map(Number)
        .filter(n => Number.isFinite(n) && n > 0);
    return nums.length ? Math.max(...nums) : null;
}

/** Every declared dimension, for the plain-measure phrasing. */
function dimensionsOf(kind, row) {
    if (kind === 'character') {
        const h = Number(row && row.height_m);
        return Number.isFinite(h) && h > 0 ? { height_m: h } : {};
    }
    const out = {};
    for (const key of ['height_m', 'width_m', 'length_m']) {
        const v = Number(row && row[key]);
        if (Number.isFinite(v) && v > 0) out[key] = v;
    }
    return out;
}

/**
 * A fraction expressed the way a person reads a frame.
 *
 * "0.04 of frame width" is a number nobody composes with. "About a twenty-fifth
 * of the frame width" is an instruction.
 */
function fractionPhrase(fraction) {
    if (!Number.isFinite(fraction) || fraction <= 0) return null;
    if (fraction >= 0.9) return 'filling the frame';
    if (fraction >= 0.6) return 'filling most of the frame width';
    const denominator = Math.round(1 / fraction);
    if (denominator <= 1) return 'filling the frame';
    if (denominator === 2) return 'about half the frame width';
    if (denominator === 3) return 'about a third of the frame width';
    if (denominator === 4) return 'about a quarter of the frame width';
    // Rounded to something sayable. A model does not distinguish a
    // twenty-third from a twenty-fifth, and pretending it does is false
    // precision in a sentence meant to be read.
    const step = denominator <= 10 ? 1 : denominator <= 30 ? 5 : 10;
    const rounded = Math.max(2, Math.round(denominator / step) * step);
    return `about one ${rounded}th of the frame width`;
}

/** The closest anchor, and how this subject compares to it. */
function anchorPhrase(sizeM) {
    if (!Number.isFinite(sizeM) || sizeM <= 0) return null;
    let best = null;
    for (const a of ANCHORS) {
        const ratio = sizeM / a.m;
        const distance = Math.abs(Math.log(ratio));
        if (!best || distance < best.distance) best = { ...a, ratio, distance };
    }
    if (!best) return null;
    if (best.ratio >= 0.85 && best.ratio <= 1.18) return `about the size of ${best.name}`;
    if (best.ratio > 1.18) return `roughly ${Math.round(best.ratio * 10) / 10} times the size of ${best.name}`;
    return `roughly ${Math.round((1 / best.ratio) * 10) / 10} times smaller than ${best.name}`;
}

function measurePhrase(kind, dims) {
    const parts = [];
    if (dims.height_m) parts.push(`${round(dims.height_m)}m tall`);
    if (dims.length_m) parts.push(`${round(dims.length_m)}m long`);
    if (dims.width_m) parts.push(`${round(dims.width_m)}m wide`);
    return parts.length ? parts.join(', ') : null;
}

function round(n) {
    return Math.round(Number(n) * 100) / 100;
}

/**
 * The scale sentence for one subject in one shot.
 *
 * `coverageWidthM` is what the lens actually covers at the camera's distance —
 * from previs, when the shot has been blocked. Without it the frame fraction
 * cannot be computed and the phrasing falls back to an anchor, which works on
 * any shot.
 */
function scalePhrase(name, kind, row, coverageWidthM) {
    // coverageWidthM belongs to the FRAMING subject only.
    //
    // A frame fraction is computed from what the lens covers at one distance —
    // the camera's distance to the thing it is framing. Everything else in the
    // shot is somewhere else: a car in the mid-ground of an establishing shot
    // is much further away than the subject, and pricing it at the subject's
    // coverage said a five-metre car fills most of a 7.5m frame, which is how
    // you get a car in your face instead of parked down the street. Callers
    // pass coverage for the framed subject and omit it for everything else,
    // which falls back to an anchor — correct at any distance.

    const size = sizeOf(kind, row);
    if (size === null) return null;             // undeclared: say nothing

    const dims = dimensionsOf(kind, row);
    const parts = [];

    const fraction = Number(coverageWidthM) > 0 ? size / Number(coverageWidthM) : null;
    const framed = fraction === null ? null : fractionPhrase(fraction);
    if (framed) parts.push(framed);

    // A person is the anchor everything else is measured against, so anchoring
    // one to a door reads as odd and adds nothing. Say the height and stop.
    const humanScale = kind === 'character' && size >= 1.4 && size <= 2.1;
    const anchored = humanScale ? null : anchorPhrase(size);
    if (anchored) parts.push(anchored);

    const measured = measurePhrase(kind, dims);
    if (measured) parts.push(measured);

    if (!parts.length) return null;
    return `${name} is ${parts.join(', ')}`;
}

/**
 * A negative built from the size, because the failure is one-directional.
 *
 * Things come out too big, not too small: a plate fills its own frame and the
 * model matches what it was shown. Naming the specific wrong outcome is worth
 * more than a general plea for accuracy.
 */
function scaleNegative(name, kind, row) {
    const size = sizeOf(kind, row);
    if (size === null || size >= 3) return null;   // only small things get inflated
    // The tightest anchor that is meaningfully bigger. Naming something far
    // larger ("larger than a front door" for a sprinkler) states a bound so
    // loose the model can satisfy it and still be wrong.
    const bigger = ANCHORS.find(a => a.m > size * 1.5);
    return bigger ? `${name} larger than ${bigger.name}` : null;
}

/**
 * Which subjects in a production have no size, and where it costs.
 *
 * "Set sizes" as advice is ignorable; "the DRAGON has no size and appears in 4
 * shots" is a job. Ordered by shot count, because an undeclared subject in one
 * insert is a shrug and an undeclared subject in half the film is the reason
 * the film does not hold together.
 *
 * A subject with a PLATE is called out harder: a plate is a close-up filling
 * its own frame, so conditioning on it without a declared size is the exact
 * combination that produced a sprinkler the size of a car.
 */
function missingSizes(db, projectId) {
    const rows = [];
    const shotsByName = countShotAppearances(db, projectId);

    const add = (kind, table, column) => {
        let list = [];
        try { list = db.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(projectId); }
        catch (_) { return; }
        for (const r of list) {
            if (sizeOf(kind, r) !== null) continue;
            let plated = false;
            try {
                plated = !!db.prepare(
                    `SELECT 1 FROM film_assets WHERE ${column} = ? LIMIT 1`).get(r.id);
            } catch (_) { plated = false; }
            rows.push({
                kind, id: r.id, name: r.name,
                shots: shotsByName[String(r.name || '').toLowerCase()] || 0,
                plated,
                field: kind === 'character' ? 'height_m' : 'height_m, width_m or length_m',
                why: plated
                    ? 'it has a plate, and a plate is a close-up filling its own frame — conditioning on it '
                      + 'without a size is what produces an object far larger than it should be'
                    : 'nothing tells the model how big it is, so it will be whatever the composition suggests',
            });
        }
    };

    add('character', 'film_characters', 'character_id');
    add('prop', 'film_props', 'prop_id');
    rows.sort((a, b) => b.shots - a.shots || String(a.name).localeCompare(String(b.name)));
    return rows;
}

/** How many shot cards name each subject, by lowercased name. */
function countShotAppearances(db, projectId) {
    const out = {};
    let shots = [];
    try {
        shots = db.prepare(
            `SELECT s.scene_card_yaml FROM film_shots s
               JOIN film_scenes sc ON sc.id = s.scene_id
              WHERE sc.project_id = ?`).all(projectId);
    } catch (_) { return out; }
    for (const row of shots) {
        let card = {};
        try { card = JSON.parse(row.scene_card_yaml || '{}'); } catch (_) { continue; }
        for (const name of [...(card.characters || []), ...(card.props || [])]) {
            const key = String(name || '').trim().toLowerCase();
            if (key) out[key] = (out[key] || 0) + 1;
        }
    }
    return out;
}

module.exports = {
    ANCHORS, sizeOf, dimensionsOf, fractionPhrase, anchorPhrase,
    measurePhrase, scalePhrase, scaleNegative, missingSizes,
};
