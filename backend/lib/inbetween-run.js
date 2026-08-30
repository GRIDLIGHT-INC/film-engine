'use strict';

/**
 * -- Walking a strip --------------------------------------------------------
 *
 * `lib/inbetweens.js` decides WHAT the stations of a shot are: how many, at
 * what moment, and the one sentence that separates each from the one before it.
 * This walks that list and turns it into pictures.
 *
 * THE CHAIN IS THE FEATURE. Each station is generated from the station BEFORE
 * it, not independently from the shot's keyframe: N independent rolls of the
 * dice off one picture reinvents exactly the drift a strip exists to remove.
 * That makes the walk serial by construction, which is a cost and the right
 * one, because the alternative is a strip whose second half does not belong to
 * its first.
 *
 * Pure of HTTP and of the database on purpose: `refine` arrives as a function,
 * so the chain is testable without generating anything, and the route stays the
 * only thing that knows about `film_assets`. The same split `planStations`
 * already makes with `motionFor`.
 */

const crypto = require('crypto');

/**
 * Generate a strip, in order, stopping at the first refusal.
 *
 * @param {object} strip  from planStations
 * @param {object} opts
 *   - refine({ instruction, reference, station }) -> { asset_id, image_path }
 *   - keyframePath   the approved frame station 0 already is
 *   - existing       { [index]: { asset_id, image_path } } already generated
 *   - fromIndex      re-run from here on (W3): a chain re-inherits from the
 *                    frame that changed, so everything after it must follow
 */
async function runStrip(strip, opts) {
    const o = opts || {};
    const stations = (strip && strip.stations) || [];
    const existing = o.existing || {};
    const from = Number.isFinite(o.fromIndex) ? Number(o.fromIndex) : 1;

    const generated = [];
    const skipped = [];
    let previous = o.keyframePath || null;
    let stopped_at = null;
    let error = null;
    let notAttempted = [];

    for (let i = 0; i < stations.length; i++) {
        const station = stations[i];

        /*
         * Station 0 is never generated. It is the frame that was approved, and
         * a frame generated from itself could only reproduce itself, which is
         * the rule lib/shot-anchor.js already states about anchoring a shot on
         * its own picture.
         */
        if (station.index === 0) { previous = o.keyframePath || previous; continue; }

        // Before the edit point: untouched, and it carries the chain forward.
        if (station.index < from) {
            const have = existing[station.index];
            if (have) { previous = have.image_path; skipped.push(station.index); }
            continue;
        }

        /*
         * Already generated: skipped rather than bought again, and the chain
         * continues FROM it. Re-running a half-finished strip must not fork the
         * second half off a different picture than the first half used.
         */
        if (existing[station.index] && !Number.isFinite(o.fromIndex)) {
            previous = existing[station.index].image_path;
            skipped.push(station.index);
            continue;
        }

        try {
            const made = await o.refine({
                instruction: station.instruction,
                reference: previous,
                station,
            });
            generated.push({ index: station.index, at_ms: station.at_ms, ...made });
            previous = made.image_path;
        } catch (err) {
            /*
             * Stop, and name what was not attempted.
             *
             * generateSequence already sets this rule: a provider that has
             * started refusing will refuse the next one too, and buying the
             * same failure N times is worse than stopping. A partial strip
             * reported as a success is how a sequence gets joined through
             * moments nobody has seen.
             */
            stopped_at = station.index;
            error = err.message;
            notAttempted = stations.slice(i + 1).map(st => st.index);
            break;
        }
    }

    return { generated, skipped, stopped_at, error, not_attempted: notAttempted };
}

/**
 * What this strip IS, as one value.
 *
 * Over the ordered station asset ids AND their instructions, because both
 * change what was signed off: replacing a station changes the picture, and
 * rewording one changes what the next station was asked to do. Ordered, because
 * a strip is a sequence and not a set: two stations swapped is a different move.
 *
 * The same contract `previs_approve` carries. A director can only trust that
 * the strip they signed off is the strip that shot if changing it is
 * detectable.
 */
function stripFingerprint(stations) {
    const list = Array.isArray(stations) ? stations : [];
    const material = list.map((st, i) => [
        i,
        st && st.index,
        (st && st.asset_id) || '',
        (st && st.instruction) || '',
    ].join(' ')).join('');
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Whether the strip in front of you is the one that was approved.
 *
 * A sequence with no approval is NOT stale, it is unapproved, which is what
 * every sequence that exists today is. Treating an absent fingerprint as stale
 * would refuse every existing sequence the day this ships, which is both wrong
 * and the fastest route to the gate being switched off.
 */
function approvalState(approvedFingerprint, stations) {
    const current = stripFingerprint(stations);
    if (!approvedFingerprint) return { approved: false, stale: false, current };
    return {
        approved: true,
        stale: current !== approvedFingerprint,
        current,
        approved_fingerprint: approvedFingerprint,
    };
}

module.exports = { runStrip, stripFingerprint, approvalState };
