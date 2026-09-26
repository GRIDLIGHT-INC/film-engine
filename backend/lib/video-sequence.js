/**
 * SEVERAL SHOTS, ONE MOVE.
 *
 * "We must be able to send multiple pictures to generate a specific sequence
 * and details... I should be able to select which shots, and then enter details
 * for the scene so it's as accurate as possible."
 *
 * Video generation took exactly one picture — the shot's own keyframe as
 * init_image — so the only thing a director could say about motion was whatever
 * fitted in one still plus a movement word from a list of eighteen. Where the
 * shot is GOING, and what it looks like when it arrives, was unsayable. That is
 * why a move across a street had to be described rather than shown, and why it
 * came back as a different street each time.
 *
 * The ceiling is the PROVIDER's. Runway's image_to_video takes a first and a
 * last frame; a local agent may take one. So N selected shots become N-1
 * segments, each travelling between two frames the director actually approved,
 * and the segments are stitched. This plans that and generates nothing: the
 * planner is pure so the cost, the ordering and the refusals can all be shown
 * before a credit is spent, which is the same split lib/run-plan.js uses.
 */

/**
 * @param {Array} shots - in the order they play. Each needs { id, shot_code, keyframe }.
 * @param {object} opts - { maxKeyframes, description }
 */
function planSequence(shots, opts) {
    const o = opts || {};
    const maxKeyframes = Math.max(1, Number(o.maxKeyframes) || 1);
    const list = Array.isArray(shots) ? shots.filter(Boolean) : [];
    const description = String(o.description || '').trim();

    if (!list.length) {
        return { refused: true, reason: 'No shots selected.', segments: [], needs_stitching: false };
    }

    /*
     * A shot with no frame is refused, never generated around.
     *
     * Skipping it would silently join the shots either side of it — a move the
     * director did not ask for, through a moment they have not seen — and the
     * result looks like a successful sequence. Naming the shot is what makes it
     * one click to fix.
     */
    const missing = list.filter(s => !s.keyframe).map(s => s.shot_code || s.id);
    if (missing.length) {
        return {
            refused: true,
            reason: `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no keyframe. `
                + 'A sequence travels between pictures you have already approved — generate the frame '
                + 'first, or take the shot out of the sequence.',
            missing, segments: [], needs_stitching: false,
        };
    }

    /*
     * ONE keyframe per generation is not an error, it is a weaker shot.
     *
     * An adapter that cannot take a destination still produces something
     * usable — a still per shot with the motion described in words, which is
     * exactly what the engine did before this existed. It is reported as
     * `degraded` so a director knows why the move is vaguer than they asked
     * for, rather than concluding the endpoint ignored them.
     */
    const degraded = maxKeyframes < 2 && list.length > 1;

    const segments = [];
    const cuts = [];
    if (list.length === 1 || degraded) {
        for (const shot of list) {
            segments.push(buildSegment([shot], shot, shot, description, list, o.modelPolicy));
        }
    } else {
        for (let i = 0; i < list.length - 1; i += 1) {
            const join = joinAt(o.joins, i);
            /*
             * A CUT GENERATES NOTHING. The two shots meet on an edit, so there
             * is no moment between them to invent — buying a clip there would
             * be paying for a move the director explicitly did not want.
             */
            if (join.type === 'cut') {
                cuts.push({ index: i, from: list[i].shot_code || list[i].id, to: list[i + 1].shot_code || list[i + 1].id });
                continue;
            }
            const seg = buildSegment([list[i], list[i + 1]], list[i], list[i + 1], description, list, o.modelPolicy);
            if (join.type !== 'continuous' || join.prompt) {
                seg.prompt = `${seg.prompt} ${joinSentence(join, list[i], list[i + 1])}`.trim();
            }
            seg.join = join.type;
            segments.push(seg);
        }
    }

    return {
        refused: false,
        degraded,
        ...(degraded ? {
            degraded_reason: 'This provider takes one still per generation, so each shot is generated '
                + 'from its own frame and the movement is described in words rather than travelled to.',
        } : {}),
        max_keyframes: maxKeyframes,
        segments,
        // Two shots is one segment and needs no stitch; three or more do.
        needs_stitching: segments.length > 1,
        // The joins that were cuts, named: a leg that was not bought must say
        // so, or a four-shot sequence planning two clips looks like a bug.
        cuts,
        shot_codes: list.map(s => s.shot_code || s.id),
    };
}

/**
 * What one segment asks for.
 *
 * The director's description leads and every segment carries it, because it is
 * the thing that is true of the WHOLE sequence — the light, the weather, the
 * lens, the mood. What follows is what makes this segment different from its
 * neighbours: which shot it starts on and which it arrives at. Without that,
 * every segment of a five-shot sequence asks for the same thing and the result
 * is five copies of one move.
 */
/*
 * THE JOIN BETWEEN TWO SHOTS. Absent means continuous — what every sequence did
 * before joins existed, so a sequence nobody has edited plans byte-identically.
 */
const JOIN_TYPES = Object.freeze(['cut', 'continuous', 'dissolve', 'match_cut', 'whip_pan', 'morph']);

const JOIN_WORDS = Object.freeze({
    continuous: '',
    dissolve: 'The first picture dissolves into the second: a slow overlap, both images briefly visible at once.',
    match_cut: 'A match cut: a shape or motion in the first picture carries straight into the same shape or motion in the second.',
    whip_pan: 'A whip pan: the camera swings fast enough to smear into motion blur, and the blur resolves on the second picture.',
    morph: 'A morph: the first picture transforms fluidly and continuously into the second.',
});

function joinAt(joins, i) {
    const j = Array.isArray(joins) ? joins[i] : null;
    const type = j && JOIN_TYPES.includes(j.type) ? j.type : 'continuous';
    return { type, prompt: j && typeof j.prompt === 'string' ? j.prompt.trim() : '' };
}

function joinSentence(join, from, to) {
    const parts = [];
    if (JOIN_WORDS[join.type]) parts.push(JOIN_WORDS[join.type]);
    if (join.prompt) parts.push(`How ${from.shot_code || 'it'} becomes ${to.shot_code || 'the next'}: ${join.prompt}`);
    return parts.join(' ');
}

function buildSegment(shots, from, to, description, all, modelPolicy) {
    const index = all.indexOf(from);
    const single = shots.length === 1;
    const parts = [];

    if (description) parts.push(description);

    if (single) {
        parts.push(`This is ${from.shot_code}${from.description ? `: ${from.description}` : ''}.`);
    } else {
        parts.push(`One continuous move from ${from.shot_code} to ${to.shot_code}: it begins on the `
            + 'first image and ends on the last, and everything between them is the same place, the '
            + 'same light and the same subjects moving.');
        if (from.description) parts.push(`It starts as ${from.shot_code}: ${from.description}`);
        if (to.description) parts.push(`It ends as ${to.shot_code}: ${to.description}`);
    }

    const policy = modelPolicy || { duration: { min: 2, max: 10 }, creditsPerSecond: 0 };
    const wanted = Math.max(1, Math.round((Number(from.duration_ms) || 5000) / 1000));
    const allowed = policy.duration && policy.duration.allowed;
    const duration = Array.isArray(allowed)
        ? allowed.reduce((best, n) => Math.abs(n - wanted) < Math.abs(best - wanted) ? n : best)
        : Math.min((policy.duration && policy.duration.max) || 10, Math.max((policy.duration && policy.duration.min) || 2, wanted));
    return {
        index,
        from: from.shot_code || from.id,
        to: to.shot_code || to.id,
        from_shot_id: from.id,
        to_shot_id: to.id,
        keyframes: single
            ? [{ uri: from.keyframe, position: 'first' }]
            : [{ uri: from.keyframe, position: 'first' }, { uri: to.keyframe, position: 'last' }],
        prompt: parts.join(' '),
        duration_s: duration,
        estimated_credits: Math.max(policy.minimumCredits || 0, duration * (policy.creditsPerSecond || 0)),
    };
}

module.exports = { planSequence, buildSegment, JOIN_TYPES, joinAt };
