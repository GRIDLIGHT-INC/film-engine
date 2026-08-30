'use strict';

/**
 * -- Draft while working, finish at the end ---------------------------------
 *
 * The intent: generate cheap footage while the cut is being found, then upscale
 * once at the end. It is the right shape — most generated clips are thrown away
 * — and the specific number asked for is not available everywhere, which is
 * worth stating rather than quietly rounding.
 *
 *   Runway gen4.5 / gen4_turbo   smallest documented raster is 1280x720. There
 *                                is no 480p: `image_to_video` takes a RATIO
 *                                string, so the size IS the ratio, and a
 *                                request for 854x480 is a request to be
 *                                refused or silently snapped.
 *   Seedance 2.5 (via MuAPI)     480p is real and reachable: $0.17/s against
 *                                $0.85 at 1080p, and `lib/providers/seedance.js`
 *                                takes `resolution` as an explicit keyword. The
 *                                model is in the URL there, so the keyword must
 *                                be one that adapter documents — an unknown one
 *                                is a 404, not a parameter quietly ignored.
 *
 * So 480p is a PROVIDER choice, not a setting: on Runway the floor is 720p and
 * the saving is the model, and on Seedance the floor is 480p and the saving is
 * five-fold. Draft asks for the smallest raster THE RESOLVED MODEL DOCUMENTS
 * and reports which it got — telling a director they are drafting at 480p while
 * sending 720p gives them a number to budget on that is wrong by a factor of
 * five.
 *
 * On Runway the saving is the MODEL rather than the raster — gen4_turbo at 5
 * credits a second — which is what `VIDEO_TIERS.draft` already says.
 *
 * Pure: no database, no I/O.
 */

/**
 * The smallest raster each model will actually accept, with its source.
 *
 * A model absent from this table falls back to 720p, which every video adapter
 * here documents — the same asymmetry that governs promptLimit and
 * maxReferenceImages: over-asking is a rejection that costs a generation,
 * under-asking is a smaller picture generated where the choice can be reported.
 */
const DRAFT_FLOORS = {
    'gen4.5':      { width: 1280, height: 720, why: 'Runway documents 1280:720 as its smallest gen4.5 ratio; there is no 480p' },
    gen4_turbo:    { width: 1280, height: 720, why: 'Runway documents 1280:720 as its smallest ratio; the saving here is the model, at 5 credits/second' },
    veo3_1:        { width: 1280, height: 720, why: 'Veo documents 1280:720 and 720:1280 only' },
    'veo3.1':      { width: 1280, height: 720, why: 'Veo documents 1280:720 and 720:1280 only' },
    'veo3.1_fast': { width: 1280, height: 720, why: 'Veo documents 1280:720 and 720:1280 only' },
    seedance2:     { width: 1280, height: 720, why: 'Seedance 2.0 documents 1280:720 as its smallest' },
    /*
     * Seedance through MuAPI. `resolution` is the keyword its adapter reads,
     * and the model is built into the URL there — so it is carried as a keyword
     * rather than as a raster, and it must be one that adapter documents.
     *
     * Note the two paths to the same model: reached through RUNWAY, Seedance
     * documents 1280:720 as its smallest and there is no 480p. Reached through
     * MuAPI it is $0.17/s. Which one you get is a provider choice.
     */
    'seedance-2.5': { width: 854, height: 480, resolution: '480p',
        why: 'Seedance via MuAPI documents a 480p tier at $0.17/s against $0.85 at 1080p' },
    seedance2_5:    { width: 1280, height: 720,
        why: 'reached through RUNWAY, Seedance documents 1280:720 as its smallest — the 480p tier is on the MuAPI adapter, which is a different provider choice' },
    hailuo3:       { width: 1280, height: 720, why: 'Hailuo 3 documents 720P as its smallest' },
};

const DEFAULT_FLOOR = { width: 1280, height: 720, why: 'no floor is declared for this model, so the '
    + 'conservative one every adapter here documents is used — over-asking is a rejection that costs '
    + 'a generation' };

function floorFor(model) {
    return DRAFT_FLOORS[String(model || '')] || DEFAULT_FLOOR;
}

/**
 * The frame a DRAFT of this shot should be generated at.
 *
 * Keeps the SHAPE it will be finished in. A vertical shot drafted landscape is
 * not a cheap version of the shot, it is a different shot — the framing cannot
 * be recovered by cropping afterwards, which is the whole reason a per-shot
 * ratio exists.
 */
function draftFrameFor(model, deliveryFrame, ratioHint) {
    const floor = floorFor(model);
    const f = deliveryFrame || {};
    const w = Number(f.width) > 0 ? Number(f.width) : 1920;
    const h = Number(f.height) > 0 ? Number(f.height) : 1080;

    /*
     * The RATIO, preferring the one the project states over the one the
     * delivery raster implies.
     *
     * A fitted raster has already been rounded to even at its own scale, so a
     * 4K and an HD project set to the same 2.39:1 arrive here as 3840x1606 and
     * 1920x804 — ratios that differ in the fourth decimal and produce draft
     * frames 2px apart. Two projects with the same stated shape must draft to
     * the same frame, or the board and the footage disagree for no reason
     * anybody chose.
     */
    const ratio = Number(ratioHint) > 0 ? Number(ratioHint) : w / h;

    // The floor is expressed landscape; the SHORT edge is what "480p" or "720p"
    // names, so it is preserved and the other edge follows the shape.
    const shortEdge = Math.min(floor.width, floor.height);
    const even = n => Math.max(2, Math.round(n / 2) * 2);
    const frame = ratio < 1
        ? { width: even(shortEdge), height: even(shortEdge / ratio) }
        : { width: even(shortEdge * ratio), height: even(shortEdge) };

    /*
     * A DRAFT IS NEVER LARGER THAN WHAT IT DRAFTS FOR.
     *
     * A 9:16 shot in a project whose delivery raster is landscape fits to
     * 608x1080 — a narrow vertical strip — and the 720p floor applied to that
     * shape gives 720x1280, which is BIGGER. Drafting would then cost more than
     * delivering, which is the opposite of the point and would be invisible
     * except on the bill.
     */
    if (frame.width >= w && frame.height >= h) {
        return {
            width: w, height: h, model: model || null, resolution: null,
            requested_480p: false, no_saving: true,
            note: `No draft: this shot already delivers at ${w}x${h}, which is at or below the `
                + `smallest raster this model documents (${floor.width}x${floor.height}). `
                + 'Drafting would generate a LARGER frame than the delivery.',
            why: floor.why,
        };
    }

    const got = Math.min(frame.width, frame.height);
    return {
        ...frame,
        model: model || null,
        /*
         * The keyword, only where the adapter takes one. Sending `resolution`
         * to a provider that does not read it is a field travelling to an API
         * that never asked for it — the class of thing that produces a 400 for
         * a reason nobody can see.
         */
        resolution: floor.resolution || null,
        requested_480p: got <= 480,
        note: got <= 480
            ? `Drafting at ${got}p. ${floor.why}.`
            : `Drafting at ${got}p — this model has no 480p. ${floor.why}.`,
        why: floor.why,
    };
}

/**
 * What a finishing pass should upscale TO.
 *
 * The delivery size, never a constant. "Upscale to 4K" is the intent, and a
 * hardcoded 4K would take a 1080p deliverable past its own spec and quadruple
 * the post bill for nothing. A project with no delivery size gets NULL rather
 * than a guess: inventing one silently changes what is delivered.
 */
function upscaleTargetFor(project) {
    const m = String((project || {}).target_resolution || '').match(/^\s*(\d+)\s*x\s*(\d+)\s*$/i);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * Supported upscale factors, from what Real-ESRGAN actually offers.
 *
 * Integers only. A model asked for 2.25x either refuses or silently rounds, and
 * a silent round is how a 480p draft finishes at 960x540 and looks like a
 * successful post pass.
 */
const UPSCALE_FACTORS = [2, 3, 4];

/**
 * How far a finished clip has to be scaled to reach delivery.
 *
 * Rounded UP to a factor the model offers. Rounding down would deliver under
 * spec quietly, which is the failure the whole delivery-size effort exists to
 * end; overshooting costs a little more and can be cropped, and the result is
 * reported either way so nobody has to infer it.
 */
function upscaleFactorFor(source, target) {
    const s = source || {};
    const t = target || {};
    const sw = Number(s.width) > 0 ? Number(s.width) : 0;
    const sh = Number(s.height) > 0 ? Number(s.height) : 0;
    const tw = Number(t.width) > 0 ? Number(t.width) : 0;
    const th = Number(t.height) > 0 ? Number(t.height) : 0;

    if (!sw || !sh) {
        return { needed: false, factor: 1,
            why: 'the clip\'s own size is not recorded, so the factor cannot be worked out — '
                + 'guessing one either overshoots into a bigger bill or lands under the delivery spec' };
    }
    if (!tw || !th) {
        return { needed: false, factor: 1,
            why: 'this project states no delivery size, so there is nothing to scale TO' };
    }
    if (sw >= tw && sh >= th) {
        return { needed: false, factor: 1,
            why: `already ${sw}x${sh}, at or above the ${tw}x${th} delivery — a pass here spends money to change nothing` };
    }
    const exact = Math.max(tw / sw, th / sh);
    const factor = UPSCALE_FACTORS.find(f => f >= exact) || UPSCALE_FACTORS[UPSCALE_FACTORS.length - 1];
    const reaches = { width: sw * factor, height: sh * factor };

    /*
     * One pass is not always enough, and saying so is the point.
     *
     * A 480p draft cannot reach 4K in a single Real-ESRGAN pass: 480x4 is 1920
     * against 2160, and the model takes whole factors. Reporting a 4x pass as
     * "finished" would deliver 1920p against a 4K spec and look successful —
     * the exact failure the delivery-size work exists to end.
     *
     * The remedy is named rather than performed: a second pass, or drafting at
     * 720p, which reaches 2160 in one 3x pass. Which of those a director wants
     * depends on how much footage they are throwing away, and that is their
     * call rather than something to decide silently here.
     */
    const short = reaches.width < tw || reaches.height < th;
    return {
        needed: true, factor, exact: Number(exact.toFixed(2)), reaches,
        short_of_target: short,
        why: `${sw}x${sh} needs ${exact.toFixed(2)}x to reach ${tw}x${th}; the model takes whole `
            + `factors, so ${factor}x lands at ${reaches.width}x${reaches.height}`
            + (short
                ? `. That is SHORT of the delivery size: one pass cannot get there. Run a second `
                  + `pass, or draft at 720p, which reaches ${th} in a single 3x pass.`
                : '.'),
    };
}

module.exports = { DRAFT_FLOORS, DEFAULT_FLOOR, UPSCALE_FACTORS, floorFor, draftFrameFor,
    upscaleTargetFor, upscaleFactorFor };
