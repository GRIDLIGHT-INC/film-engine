/**
 * How likely is this shot to come back wrong?
 *
 * Spec §49. A generative model's adherence falls off with the number of
 * independent things it is being asked to hold true at once, and the cheapest
 * intervention in this whole pipeline is to say so BEFORE the money is spent —
 * the same reasoning that puts the compliance gate and the budget refusal in
 * the free run plan rather than after a run.
 *
 * "Reduce generative entropy before increasing prompt detail." A score that
 * says a shot is carrying four independent actions is worth more than any
 * amount of prompt engineering applied to the shot as written, because the
 * remedy is to SPLIT IT, and no wording achieves that.
 *
 * Pure: seven numbers in, a grade out. No database, no provider, no model.
 *
 * EVERY INPUT MUST BE ABLE TO MOVE THE GRADE. An input declared to matter that
 * changes nothing is a score nobody should act on, and it is the failure this
 * codebase has already paid for under other names — `NEVER_WRITES` consumed by
 * nothing, `scope` read by nobody, a `describeResolution` with no callers. Each
 * entry below therefore carries a `worst` that reaches the MEDIUM threshold on
 * its own, and the test drives each one to prove it.
 */

const LOW = 'LOW', MEDIUM = 'MEDIUM', HIGH = 'HIGH';

/** Where the grades change. */
const MEDIUM_AT = 3;
const HIGH_AT = 6;

/**
 * The seven inputs §49 names.
 *
 * `points` is deliberately a curve rather than a multiplier: the second subject
 * in a shot costs far more adherence than the fifth, because the first
 * interaction is where a model starts having to decide who is doing what.
 */
const INPUTS = Object.freeze([
    {
        id: 'subjects', label: 'subjects in shot', worst: 6,
        why: 'each additional figure is another identity the model has to hold',
        points: (n) => (n <= 1 ? 0 : n === 2 ? 1 : n === 3 ? 2 : 3),
    },
    {
        id: 'moving_subjects', label: 'subjects that move', worst: 4,
        why: 'a moving figure is a second thing to get right about the same person',
        points: (n) => (n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3),
    },
    {
        id: 'camera_movement', label: 'camera movement legs', worst: 3,
        why: 'a compound move asks the model to be right about the frame at every moment of it',
        points: (n) => (n <= 0 ? 0 : n === 1 ? 1 : 3),
    },
    {
        id: 'environment_interactions', label: 'interactions with the set', worst: 4,
        why: 'a hand on a door is contact between two things that were generated separately',
        points: (n) => (n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3),
    },
    {
        id: 'occlusion', label: 'occlusion', worst: 1,
        why: 'a subject passing behind another is where identity most often swaps',
        points: (v) => (v <= 0 ? 0 : v < 0.34 ? 1 : v < 0.67 ? 2 : 3),
    },
    {
        id: 'duration_s', label: 'duration', worst: 12,
        why: 'adherence decays over a clip; the far end of a long take is the least controlled part of it',
        points: (s) => (s <= 4 ? 0 : s <= 6 ? 1 : s <= 9 ? 2 : 3),
    },
    {
        id: 'distinct_actions', label: 'distinct actions', worst: 4,
        why: 'the strongest single predictor — independent actions are what a model averages',
        points: (n) => (n <= 1 ? 0 : n === 2 ? 1 : n === 3 ? 2 : 3),
    },
]);

function clampNum(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Score a shot.
 *
 * Returns the grade, the total, and the contribution of every input — because
 * a grade with no breakdown cannot be argued with, and the line a director
 * needs to see is the one they did not expect.
 */
function scoreShot(input) {
    const given = input || {};
    const lines = [];
    let total = 0;

    for (const spec of INPUTS) {
        const value = clampNum(given[spec.id]);
        const points = spec.points(value);
        total += points;
        lines.push({ id: spec.id, label: spec.label, value, points, why: spec.why });
    }

    const grade = total >= HIGH_AT ? HIGH : total >= MEDIUM_AT ? MEDIUM : LOW;

    // What is actually driving it, worst first — the actionable half.
    const drivers = lines.filter(l => l.points > 0).sort((a, b) => b.points - a.points);

    return {
        grade,
        score: total,
        thresholds: { medium_at: MEDIUM_AT, high_at: HIGH_AT },
        inputs: lines,
        drivers,
        // A suggestion only on HIGH. Telling a director to split a LOW shot is
        // how the warning gets switched off, and the real one goes with it.
        suggestion: grade === HIGH ? splitSuggestion(total, drivers) : null,
    };
}

/**
 * What to do about a HIGH.
 *
 * Names the shots to split into AND the drivers to split ON, because "consider
 * splitting this" with no cut points sends the director back to re-read their
 * own scene card.
 */
function splitSuggestion(total, drivers) {
    const shots = total >= HIGH_AT + 4 ? 3 : 2;
    const top = drivers.slice(0, 2).map(d => d.label);
    return {
        split_into: shots,
        text: `High generation risk. Consider splitting this into ${shots} shots`
            + (top.length ? `, cutting on ${top.join(' and ')}.` : '.'),
        cut_on: top,
    };
}

/** The three grades, so a caller never types one. */
const GRADES = Object.freeze([LOW, MEDIUM, HIGH]);

module.exports = { INPUTS, GRADES, LOW, MEDIUM, HIGH, MEDIUM_AT, HIGH_AT, scoreShot, splitSuggestion };
