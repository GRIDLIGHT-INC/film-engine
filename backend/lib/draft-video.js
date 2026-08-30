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
 *   Seedance 2.5                 has a real 480p RATE at $0.17/s against $0.85
 *                                at 1080p — and it is on the MuAPI path, not
 *                                the Runway one this engine uses, which
 *                                documents 1280:720 as its smallest for that
 *                                model too.
 *
 * So there is currently NO 480p anywhere in this pipeline, and this module says
 * so rather than sending a size that would be refused. Draft asks for the
 * smallest raster THE RESOLVED MODEL DOCUMENTS and reports which it got:
 * telling a director they are drafting at 480p while sending 720p gives them a
 * number to budget on that is wrong by a factor of five.
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
     * Seedance 2.5 has a real 480p RATE — $0.17/s against $0.85 at 1080p — and
     * it is not reachable from here. That price is for Seedance reached through
     * MuAPI; the Runway adapter this engine actually uses documents only
     * 1280:720, 720:1280, 1920:1080 and 1080:1920 for it, so a 480p request
     * would be refused. The cheaper tier is a reason to wire MuAPI one day, not
     * a size to send today.
     */
    seedance2_5:   { width: 1280, height: 720, why: 'through Runway, Seedance 2.5 documents 1280:720 as its smallest — its 480p tier exists only on the MuAPI path, which is not wired here' },
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
function draftFrameFor(model, deliveryFrame) {
    const floor = floorFor(model);
    const f = deliveryFrame || {};
    const w = Number(f.width) > 0 ? Number(f.width) : 1920;
    const h = Number(f.height) > 0 ? Number(f.height) : 1080;
    const ratio = w / h;

    // The floor is expressed landscape; the SHORT edge is what "480p" or "720p"
    // names, so it is preserved and the other edge follows the shape.
    const shortEdge = Math.min(floor.width, floor.height);
    const even = n => Math.max(2, Math.round(n / 2) * 2);
    const frame = ratio < 1
        ? { width: even(shortEdge), height: even(shortEdge / ratio) }
        : { width: even(shortEdge * ratio), height: even(shortEdge) };

    const got = Math.min(frame.width, frame.height);
    return {
        ...frame,
        model: model || null,
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

module.exports = { DRAFT_FLOORS, DEFAULT_FLOOR, floorFor, draftFrameFor, upscaleTargetFor };
