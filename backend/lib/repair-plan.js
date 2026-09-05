/**
 * MARKS IN, PLAN OUT — AND NOTHING SPENT.
 *
 * A director marks an in-point and an out-point on a clip and wants the section
 * between them regenerated. This says what that would do and what it would
 * cost, and it is the thing they are shown BEFORE any money moves.
 *
 * SO IT IS SYNCHRONOUS, DELIBERATELY. Every paid path in this codebase awaits a
 * provider, so a planner that cannot be awaited cannot have called one. That is
 * a guarantee in the signature rather than a promise in a comment, and it is
 * the reason `lib/video-sequence.js` splits planning from execution — a plan
 * that spends cannot be raised speculatively, and one that cannot be raised
 * speculatively does not get raised at all.
 *
 * WHAT IT DOES NOT DECIDE. Under the four-second floor there are two honest
 * answers — widen the marks, or generate four seconds and trim back — and they
 * trade different things: widening changes what the director marked, trimming
 * pays for footage nobody sees. That is the epic's open question 3, it belongs
 * to a person, and this names both with their prices rather than choosing.
 */

const { planSplice, SPLICE_REFUSALS, inspectMedia } = require('./ffmpeg');
const { RESOLUTIONS, MIN_DURATION, MAX_DURATION } = require('./providers/seedance');

/**
 * What a plan reports, and why each line is there.
 *
 * Declared so a field that is promised and never filled is visible — the
 * failure this codebase has shipped as `NEVER_WRITES` and `describeResolution`,
 * where a constant is exported and consumed by nothing.
 */
const REPAIR_PLAN_FIELDS = Object.freeze([
    { id: 'extract', why: 'which frames come out of the source, and at which timestamps — the two '
        + 'pictures the generation travels between' },
    { id: 'generate', why: 'what is asked for: the workflow, how long, and at what raster' },
    { id: 'splice', why: 'how the result goes back in — which pieces of the original survive' },
    { id: 'cost', why: 'what it will be billed, before it is billed, from the provider\'s own table' },
    { id: 'source', why: 'what the clip actually is, read from the file rather than the row, so the '
        + 'director can see the plan was built against the real footage' },
]);

/**
 * Everything a repair can be refused for.
 *
 * DERIVED as a superset of the splice's own registry rather than retyped: the
 * planner wraps `planSplice`, so a rule added there must not be silently
 * un-enforced one level up. Two hand-maintained lists is exactly how the one
 * that matters goes missing.
 */
const REPAIR_REFUSALS = Object.freeze([
    ...SPLICE_REFUSALS,
    { code: 'range_below_floor',
      why: `the model will not generate under ${MIN_DURATION}s, and a fault is very often shorter — `
        + 'this is the commonest thing a director will mark, and it is invisible today until a paid '
        + 'request comes back refused' },
    { code: 'range_above_ceiling',
      why: `the model will not generate over ${MAX_DURATION}s in one pass` },
]);

const refuse = (code, reason, extra) => ({ refused: true, code, reason, ...(extra || {}) });

/** The tier whose long edge is nearest the footage, so a repair matches what surrounds it. */
function tierFor(longEdge) {
    if (!(longEdge > 0)) return '480p';
    let best = null;
    for (const [id, r] of Object.entries(RESOLUTIONS)) {
        const d = Math.abs(r.longEdge - longEdge);
        if (!best || d < best.d) best = { id, d };
    }
    return best.id;
}

const usd = (seconds, tier) => Math.round(seconds * RESOLUTIONS[tier].usdPerSecond * 1e6) / 1e6;

/**
 * What repairing this range would do. Free, and never throws.
 */
function planRepair(input) {
    const o = input || {};
    const sourcePath = typeof o.sourcePath === 'string' ? o.sourcePath : '';
    if (!sourcePath) return refuse('no_source', 'no clip was given to repair');

    // Read from the FILE. The row carries no width, no height and no model on
    // any existing asset, and imported footage never had them at all.
    const seen = inspectMedia(sourcePath);
    if (!seen.ok) return refuse('no_source', seen.reason);

    const sourceDuration = Number(o.sourceDuration) > 0 ? Number(o.sourceDuration) : seen.durationSeconds;
    const startSec = Number(o.startSec);
    const endSec = Number(o.endSec);
    const fps = Number(o.fps) > 0 ? Number(o.fps) : (seen.fps > 0 ? seen.fps : 24);

    /*
     * The geometry is checked by the splice, which already owns every rule
     * about a range against a clip. Asking it first means the planner cannot
     * accept something the executor would refuse — the two disagreeing is what
     * makes a plan worse than no plan.
     */
    const geometry = planSplice({
        sourcePath, sourceDuration, startSec, endSec, fps,
        replacementPath: o.replacementPath || sourcePath,
        replacementDuration: Number(o.replacementDuration) > 0 ? Number(o.replacementDuration) : undefined,
    });
    if (!geometry.ok) return refuse(geometry.code, geometry.reason);

    const seconds = endSec - startSec;
    const tier = RESOLUTIONS[o.resolution] ? o.resolution : tierFor(Math.max(seen.width || 0, seen.height || 0));

    if (seconds < MIN_DURATION) {
        /*
         * BOTH REMEDIES, BOTH PRICED. "Widen it" with no number is advice, not
         * a choice — the director cannot weigh changing what they marked
         * against what the change costs unless the cost is on the page.
         */
        const widened = MIN_DURATION;
        return refuse('range_below_floor',
            `The marked range is ${seconds.toFixed(2)}s and this model will not generate under `
            + `${MIN_DURATION}s. Either widen the marks to ${MIN_DURATION}s — which changes what you `
            + `marked, and costs $${usd(widened, tier).toFixed(2)} at ${tier} — or generate `
            + `${MIN_DURATION}s and trim back to the range, which pays $${usd(widened, tier).toFixed(2)} `
            + 'for footage nobody sees. Neither is chosen for you.',
            {
                marked_seconds: seconds,
                floor_seconds: MIN_DURATION,
                widen: { to_seconds: widened, cost_usd: usd(widened, tier), changes: 'what you marked' },
                trim_back: { generate_seconds: widened, cost_usd: usd(widened, tier),
                             changes: 'nothing, but pays for discarded footage' },
            });
    }
    if (seconds > MAX_DURATION) {
        return refuse('range_above_ceiling',
            `The marked range is ${seconds.toFixed(2)}s and this model generates at most `
            + `${MAX_DURATION}s in one pass. Mark a shorter range, or repair it in more than one.`);
    }

    const r = RESOLUTIONS[tier];
    // The raster keeps the SOURCE's shape at the tier's long edge; a repair at
    // another aspect is letterboxed or stretched against the footage around it.
    const wide = (seen.width || 0) >= (seen.height || 0);
    const ratio = seen.width && seen.height ? seen.width / seen.height : 16 / 9;
    const width = wide ? r.longEdge : Math.round((r.longEdge * ratio) / 2) * 2;
    const height = wide ? Math.round((r.longEdge / ratio) / 2) * 2 : r.longEdge;

    return {
        refused: false,
        /*
         * ORDERED, and the order is the meaning: [0] is the frame the clip
         * starts on and [1] the frame it ends on. Reversed, the move runs
         * backwards and reads as a model fault rather than a field-order one.
         */
        extract: [
            { role: 'first', atSeconds: startSec, why: 'the frame the repair starts on' },
            { role: 'last', atSeconds: endSec, why: 'the frame the repair must arrive at' },
        ],
        generate: {
            workflow: 'first-last-frame',
            durationSeconds: seconds,
            resolution: tier,
            width, height,
        },
        splice: { shape: geometry.shape, segments: geometry.segments, fps: geometry.fps },
        cost: {
            usd: usd(seconds, tier),
            usd_per_second: r.usdPerSecond,
            seconds,
            resolution: tier,
            // Named so a total nobody can check is never the only number shown.
            basis: `${seconds.toFixed(2)}s x $${r.usdPerSecond}/s at ${tier}`,
        },
        source: {
            path: sourcePath,
            durationSeconds: sourceDuration,
            width: seen.width, height: seen.height, fps: seen.fps,
            codec: seen.codec, hasAudio: seen.hasAudio,
        },
    };
}

module.exports = { planRepair, REPAIR_REFUSALS, REPAIR_PLAN_FIELDS, tierFor };
