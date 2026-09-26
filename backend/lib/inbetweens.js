/**
 * ── IN-BETWEENS: the shot as a strip, not a still ────────────────────────────
 *
 * "Generate a frame every second of film based on the camera direction and the
 * directions in the shot, like doing the in-betweens in animation."
 *
 * lib/video-sequence.js already travels between pictures a director approved:
 * N shots become N-1 segments, each pinned to a first and a last frame. But the
 * unit was always the SHOT. A five second push-in went to the provider as ONE
 * picture and a sentence, so seconds two, three and four were the model's
 * opinion — and the model's opinion is what drifts.
 *
 * This densifies the list rather than replacing it. A shot becomes several
 * STATIONS in the same { shot_code, description, duration_ms, keyframe } shape
 * planSequence already consumes, so nothing downstream changes: buildSegment
 * still pairs neighbours, the segment loop still generates, sequence_stitch
 * still joins. A shot with no move that reads still yields one station, which
 * is exactly today's behaviour — this is a denser input, not a second pipeline.
 *
 * THE POSES ARE NOT INVENTED. lib/shot-motion.js already samples the camera
 * across the shot from the film's own optics, and transformAt(track, t) is the
 * pose at any moment in it. Sampling that at each station is what makes an
 * in-between a fact about the blocking rather than a guess about the action,
 * and it is why nothing here generates: this plans, the caller buys.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: decide how many stations a director can
 * afford. The ceiling is the provider's, the same rule keyframeCeiling follows
 * — Seedance 2.5 declares 30 images where Hailuo3 declares 9 — so the cap
 * arrives as an argument and a plan that had to be thinned says so.
 */

const { transformAt } = require('./shot-motion');

/** One station per second of film, the cadence a director asked for. */
const DEFAULT_CADENCE_S = 1;

/**
 * The most stations one shot may claim, before the provider's own cap applies.
 *
 * A ten second shot at one per second is ten pictures for one shot, which on a
 * thirty image contract is a third of the budget spent before the second shot
 * is reached. This is a REPORTING bound, not a refusal: a plan held here says
 * it was held and what it was held from.
 */
const MAX_STATIONS_PER_SHOT = 12;

/*
 * Below this the strip is not worth buying.
 *
 * shot-motion already answers "will this move read" as `perceptible`, computed
 * against half a pixel per frame at 24fps. A move it calls imperceptible is a
 * move whose in-betweens would each be a near-copy of the last, so the strip
 * costs images and buys nothing. Trust that answer rather than recomputing a
 * second opinion here, which is how two thresholds drift apart.
 */
function movementReads(motion) {
    if (!motion) return false;
    if (motion.perceptible === false) return false;
    return Number(motion.reach) > 0;
}

/**
 * How many stations this shot earns.
 *
 * Duration sets the ask, the move decides whether it is worth it, and the cap
 * has the last word. A shot whose move is too big for one still to carry —
 * shot-motion's `carried: false` — is the case that earns the MOST stations,
 * not the fewest: that flag means the animatic cannot show the move honestly,
 * which is precisely the argument for generating real frames through it.
 */
function stationCount(durationMs, motion, opts) {
    const o = opts || {};
    const cadence = Number(o.cadenceSeconds) > 0 ? Number(o.cadenceSeconds) : DEFAULT_CADENCE_S;
    const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
    const cap = Math.max(1, Math.min(
        Number(o.maxStations) || MAX_STATIONS_PER_SHOT, MAX_STATIONS_PER_SHOT));

    if (!movementReads(motion)) return { count: 1, reason: 'no move that reads at this framing' };

    // Seconds of film, plus the station that closes the last interval.
    let wanted = Math.floor(seconds / cadence) + 1;
    // A move a still cannot carry is worth resolving finer than the clock.
    if (motion && motion.carried === false) wanted += 1;
    wanted = Math.max(2, wanted);

    const count = Math.min(wanted, cap);
    return {
        count,
        ...(count < wanted ? {
            thinned: true,
            wanted,
            reason: `${wanted} stations at ${cadence}s would exceed the ${cap} this provider allows`,
        } : {}),
    };
}

/** Round to a readable percentage of the frame. */
const pct = v => Math.round(Number(v || 0) * 1000) / 10;

/**
 * What changed between two poses, in words a refine can act on.
 *
 * `scale` is unambiguous: greater than one means the subject is larger, which
 * is a push in. `x` and `y` are shot-motion's PICTURE-SPACE translation — the
 * same numbers cssTransform feeds to the page — so they are described as the
 * framing travelling across the scene rather than as a camera direction. The
 * convention is pinned by test against screenAt rather than restated here,
 * because a second statement of it is a second thing to get wrong.
 *
 * One sentence, because storyboard_refine takes ONE change: everything else
 * about the picture is carried by the picture itself.
 */
function deltaInstruction(from, to) {
    const dScale = (Number(to.scale) || 1) / (Number(from.scale) || 1);
    const dx = (Number(to.x) || 0) - (Number(from.x) || 0);
    const dy = (Number(to.y) || 0) - (Number(from.y) || 0);
    const dRot = (Number(to.rotate) || 0) - (Number(from.rotate) || 0);

    const parts = [];
    if (Math.abs(dScale - 1) >= 0.01) {
        parts.push(dScale > 1
            ? `the camera has moved ${pct(dScale - 1)}% closer, so everything is that much larger in frame`
            : `the camera has drawn back ${pct(1 - dScale)}%, so everything is that much smaller in frame`);
    }
    if (Math.abs(dx) >= 0.005) {
        parts.push(`the framing has travelled ${Math.abs(pct(dx))}% of the frame width to the `
            + `${dx > 0 ? 'right' : 'left'}`);
    }
    if (Math.abs(dy) >= 0.005) {
        parts.push(`the framing has travelled ${Math.abs(pct(dy))}% of the frame height `
            + `${dy > 0 ? 'up' : 'down'}`);
    }
    if (Math.abs(dRot) >= 0.5) {
        parts.push(`the horizon has rolled ${Math.abs(Math.round(dRot * 10) / 10)} degrees `
            + `${dRot > 0 ? 'clockwise' : 'anticlockwise'}`);
    }

    if (!parts.length) return null;
    return `Same place, same light, same subjects — only the camera has moved: ${parts.join(', ')}.`;
}

/**
 * Turn one shot into its strip.
 *
 * Station 0 IS the shot's approved keyframe and carries no instruction: it is
 * the picture the strip is made from, and a frame generated from itself could
 * only reproduce itself — the rule shot-anchor already states. Every later
 * station names the frame it is refined FROM, so the caller can walk the chain
 * without deciding the order itself.
 */
function planStations(shot, motion, opts) {
    const o = opts || {};
    const durationMs = Number(shot && shot.duration_ms) || 5000;
    const decided = stationCount(durationMs, motion, o);
    const track = motion && motion.track ? motion.track : motion;

    const stations = [];
    for (let i = 0; i < decided.count; i += 1) {
        const t = decided.count === 1 ? 0 : i / (decided.count - 1);
        const at = transformAt(track, t);
        const previous = i === 0 ? null : stations[i - 1];
        stations.push({
            index: i,
            t: Math.round(t * 10000) / 10000,
            at_ms: Math.round(t * durationMs),
            transform: {
                scale: Math.round(at.scale * 100000) / 100000,
                x: Math.round(at.x * 100000) / 100000,
                y: Math.round(at.y * 100000) / 100000,
                rotate: Math.round(at.rotate * 10000) / 10000,
            },
            // Station 0 is the approved frame; the rest are bought.
            source: i === 0 ? 'keyframe' : 'refine',
            refined_from: previous ? previous.index : null,
            instruction: previous ? deltaInstruction(previous.transform, at) : null,
        });
    }

    /*
     * A station whose delta rounds to nothing is dropped, not generated.
     *
     * An eased move spends its first and last beats almost stationary, so a
     * strip through one buys two pictures that differ by less than the model's
     * own noise — and a near-copy in the middle of a chain is worse than no
     * station, because the refine that follows inherits its drift for nothing.
     */
    const kept = stations.filter((s, i) => i === 0 || s.instruction);
    const dropped = stations.length - kept.length;
    kept.forEach((s, i) => {
        s.index = i;
        s.refined_from = i === 0 ? null : i - 1;
    });

    return {
        shot_id: shot && shot.id,
        shot_code: shot && shot.shot_code,
        duration_ms: durationMs,
        cadence_s: Number(o.cadenceSeconds) > 0 ? Number(o.cadenceSeconds) : DEFAULT_CADENCE_S,
        count: kept.length,
        stations: kept,
        generations: Math.max(0, kept.length - 1),
        ...(decided.thinned ? { thinned: true, wanted: decided.wanted } : {}),
        ...(dropped ? { dropped_still: dropped } : {}),
        reason: decided.reason || null,
    };
}

/**
 * Flatten several shots' strips into the ordered list planSequence consumes.
 *
 * Every station becomes a station-shaped shot: same keys, so video-sequence.js
 * needs no knowledge that in-betweens exist. `keyframe` is null on a station
 * that has not been generated yet, which planSequence already refuses on by
 * name — that refusal is the feature, not a gap, because a sequence joined
 * through a moment nobody has seen looks like a success.
 */
function expandShots(shots, motionFor, opts) {
    const list = Array.isArray(shots) ? shots.filter(Boolean) : [];
    const strips = list.map(shot => planStations(shot, motionFor(shot), opts));
    const stations = [];
    strips.forEach((strip, si) => {
        const shot = list[si];
        strip.stations.forEach(station => {
            stations.push({
                id: `${shot.id}#${station.index}`,
                shot_id: shot.id,
                shot_code: strip.count > 1
                    ? `${shot.shot_code}.${station.index}` : shot.shot_code,
                description: station.index === 0
                    ? shot.description
                    : (station.instruction || shot.description),
                duration_ms: Math.round(strip.duration_ms / Math.max(1, strip.generations || 1)),
                keyframe: station.index === 0 ? shot.keyframe : (station.keyframe || null),
                station,
            });
        });
    });
    return {
        strips,
        stations,
        images_needed: strips.reduce((n, s) => n + s.generations, 0),
        segments: Math.max(0, stations.length - 1),
    };
}

module.exports = {    DEFAULT_CADENCE_S, MAX_STATIONS_PER_SHOT,
    stationCount, deltaInstruction, planStations, expandShots,};
