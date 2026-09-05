/**
 * A FAULT THAT LIVES BETWEEN TWO SHOTS.
 *
 * The within-a-clip repair replaces a section of one file. This is a different
 * operation, and it took a real project to see it: on DRIVE-IN the problem is
 * the TRANSITION — the join between two clips reads wrong, and neither clip is
 * individually at fault. An editor marks an out-point in the first and an
 * in-point in the second and asks for the material between them to be made
 * again.
 *
 * SO WHAT COMES BACK IS NOT A REPAIRED CLIP, IT IS A BRIDGE. It replaces the
 * TAIL of the first shot and the HEAD of the second, which makes the
 * deliverable a new piece of footage PLUS two trim instructions — the thing an
 * editor drops on a track and tops-and-tails around. Splicing it into either
 * shot would be a claim about which one was at fault, and the premise is that
 * it belongs to neither.
 *
 * Free and synchronous, for the reason `planRepair` is: a plan that spends
 * cannot be raised speculatively, and one that cannot be raised speculatively
 * does not get raised.
 */

const fs = require('fs');
const { inspectMedia } = require('./ffmpeg');
const { RESOLUTIONS, MIN_DURATION, MAX_DURATION } = require('./providers/seedance');

const BRIDGE_REFUSALS = Object.freeze([
    { code: 'not_two_shots', why: 'a bridge spans exactly one cut; three shots is a re-cut and one is '
        + 'an ordinary within-clip repair, which planRepair already does better' },
    { code: 'no_source', why: 'a plan naming footage that is not there is worthless' },
    { code: 'gap_in_the_middle', why: 'the marks must meet AT the cut — the first span running to the '
        + 'end of its shot and the second from the start of its own. Anything else leaves footage '
        + 'between them that the bridge would silently swallow' },
    { code: 'below_floor', why: `the model will not generate under ${MIN_DURATION}s, and a transition `
        + 'fault is usually short — this is the commonest thing an editor will mark here' },
    { code: 'above_ceiling', why: `the model will not generate over ${MAX_DURATION}s in one pass` },
]);

const refuse = (code, reason, extra) => ({ refused: true, code, reason, ...(extra || {}) });
const usd = (seconds, tier) => Math.round(seconds * RESOLUTIONS[tier].usdPerSecond * 1e6) / 1e6;

function tierFor(longEdge) {
    if (!(longEdge > 0)) return '480p';
    let best = null;
    for (const [id, r] of Object.entries(RESOLUTIONS)) {
        const d = Math.abs(r.longEdge - longEdge);
        if (!best || d < best.d) best = { id, d };
    }
    return best.id;
}

/** What bridging this cut would do. Never throws. */
function planBridge(input) {
    const o = input || {};
    const spans = Array.isArray(o.spans) ? o.spans : [];
    if (spans.length !== 2) {
        return refuse('not_two_shots',
            `a bridge spans exactly one cut, and ${spans.length} shot(s) were marked. `
            + 'For a fault inside one shot use the ordinary repair; for three or more you are re-cutting.');
    }

    const [a, b] = spans;
    for (const s of [a, b]) {
        if (!s || typeof s.sourcePath !== 'string' || !s.sourcePath || !fs.existsSync(s.sourcePath)) {
            return refuse('no_source',
                `there is no footage on disk for ${(s && s.shot_code) || (s && s.shotCode) || 'one of the marked shots'}`);
        }
    }

    const aDur = Number(a.durationSeconds) > 0 ? Number(a.durationSeconds)
        : (inspectMedia(a.sourcePath).durationSeconds || 0);
    const aStart = Number(a.startSec);
    const aEnd = Number(a.endSec);
    const bStart = Number(b.startSec);
    const bEnd = Number(b.endSec);
    if (![aStart, aEnd, bStart, bEnd, aDur].every(Number.isFinite)) {
        return refuse('gap_in_the_middle', 'the marks are not four numbers, so there is no span to bridge');
    }

    const seen = inspectMedia(a.sourcePath);
    const fps = Number(o.fps) > 0 ? Number(o.fps) : (seen.ok && seen.fps > 0 ? seen.fps : 24);
    const frame = 1 / fps;

    /*
     * THE MARKS MUST MEET AT THE CUT. The first span has to run to the end of
     * its shot and the second to start at the beginning of its own — that is
     * what "across the cut" means. Anything else leaves footage in between that
     * the bridge would swallow without saying so, and the film would come back
     * shorter than the editor marked.
     */
    if (Math.abs(aDur - aEnd) > frame || bStart > frame) {
        return refuse('gap_in_the_middle',
            `the marks do not meet at the cut: the first runs to ${aEnd.toFixed(2)}s of a `
            + `${aDur.toFixed(2)}s shot and the second starts at ${bStart.toFixed(2)}s. `
            + 'Mark out at the end of the first shot and in at the start of the second.');
    }

    // Everything the marks remove, from both shots together.
    const seconds = (aDur - aStart) + bEnd;
    const tier = RESOLUTIONS[o.resolution] ? o.resolution
        : tierFor(Math.max(seen.width || 0, seen.height || 0));

    if (seconds < MIN_DURATION) {
        return refuse('below_floor',
            `The marked span is ${seconds.toFixed(2)}s across the cut and this model will not generate `
            + `under ${MIN_DURATION}s. Either widen the marks to ${MIN_DURATION}s — which changes what `
            + `you marked, and costs $${usd(MIN_DURATION, tier).toFixed(2)} at ${tier} — or generate `
            + `${MIN_DURATION}s and trim back, which pays $${usd(MIN_DURATION, tier).toFixed(2)} for `
            + 'footage nobody sees. Neither is chosen for you.',
            { marked_seconds: seconds, floor_seconds: MIN_DURATION,
              widen: { to_seconds: MIN_DURATION, cost_usd: usd(MIN_DURATION, tier) },
              trim_back: { generate_seconds: MIN_DURATION, cost_usd: usd(MIN_DURATION, tier) } });
    }
    if (seconds > MAX_DURATION) {
        return refuse('above_ceiling',
            `The marked span is ${seconds.toFixed(2)}s and this model generates at most ${MAX_DURATION}s `
            + 'in one pass. Mark closer to the cut, or bridge it in more than one pass.');
    }

    const r = RESOLUTIONS[tier];
    const wide = (seen.width || 0) >= (seen.height || 0);
    const ratio = seen.width && seen.height ? seen.width / seen.height : 16 / 9;
    const width = wide ? r.longEdge : Math.round((r.longEdge * ratio) / 2) * 2;
    const height = wide ? Math.round((r.longEdge / ratio) / 2) * 2 : r.longEdge;

    const codeOf = (s) => s.shot_code || s.shotCode || null;
    return {
        refused: false,
        /*
         * ORDERED, and here the two frames come from DIFFERENT FILES — which is
         * the whole difference from a within-clip repair. Each names its shot,
         * because a reversed pair would read as the model running the action
         * backwards rather than as a field-order mistake.
         */
        extract: [
            { role: 'first', shot_id: a.shotId || null, shot_code: codeOf(a),
              sourcePath: a.sourcePath, atSeconds: aStart, why: 'the last frame the first shot keeps' },
            { role: 'last', shot_id: b.shotId || null, shot_code: codeOf(b),
              sourcePath: b.sourcePath, atSeconds: bEnd, why: 'the first frame the second shot keeps' },
        ],
        generate: { workflow: 'first-last-frame', durationSeconds: seconds, resolution: tier, width, height },
        /*
         * A BRIDGE, NOT A SPLICE. The result is its own piece of footage and two
         * trim points — what an editor drops on a track between two shots.
         */
        delivery: {
            kind: 'bridge',
            trim: [
                { shot_code: codeOf(a), shot_id: a.shotId || null, new_out_sec: aStart },
                { shot_code: codeOf(b), shot_id: b.shotId || null, new_in_sec: bEnd },
            ],
            between: [codeOf(a), codeOf(b)],
            note: `Trim ${codeOf(a)} to end at ${aStart.toFixed(2)}s, trim ${codeOf(b)} to start at `
                + `${bEnd.toFixed(2)}s, and lay the bridge between them. Total running time is unchanged.`,
        },
        cost: {
            usd: usd(seconds, tier), usd_per_second: r.usdPerSecond, seconds, resolution: tier,
            basis: `${seconds.toFixed(2)}s x $${r.usdPerSecond}/s at ${tier}`,
        },
        fps,
    };
}

module.exports = { planBridge, BRIDGE_REFUSALS, tierFor };
