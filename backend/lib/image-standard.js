/**
 * THE HOUSE IMAGE STANDARD — one model, two sizes, and no setting overrides it.
 *
 * "First default that we'll never waiver from. When we create image storyboard
 *  shots, let's create them in 4K. Plates (location, characters, props) in 2K.
 *  All images use nano banana pro."
 *
 * Before this, three separate things decided what a picture was: the quality
 * tier (Draft/Standard/Precision, each naming a different model), the project's
 * delivery resolution (so a 1080p project boarded at 1080p), and a per-kind
 * rule for plates (locations had a 2K floor, characters and props followed the
 * project, character turnarounds were a literal 1024x1024). Eight real projects
 * held five different combinations of those, which is five different answers to
 * "what does a board frame look like here".
 *
 * So the answer is stated ONCE, here, and read at the four places a picture is
 * decided — provider resolution, the fallback chain, the model pick, and the
 * raster — rather than threaded through the tier table as a fourth tier. A tier
 * is a choice; this is not.
 *
 * ── The model is Nano Banana Pro, bought through MuAPI ───────────────────
 *
 * MuAPI is the house provider. Google (`gemini-3-pro-image`) and Meshy
 * (`nano-banana-pro`) sell the SAME model, so they stay in the chain as the
 * fallback when MuAPI refuses or holds no key — a refusal walked to another
 * vendor of the identical model is still Nano Banana Pro. Every other image
 * provider is taken OUT of the chain: walking past a refusal onto FLUX or GPT
 * Image would produce a frame on a model nobody chose, which is exactly what
 * "never waiver" rules out.
 *
 * ── The sizes are the class, fitted to the shot's own shape ──────────────
 *
 * 4K is 3840x2160 and 2K is a 2048 long edge. A 2.39:1 board is fitted INSIDE
 * the 4K box (3824x1600), never area-matched to it: an area match puts the long
 * edge past 4096, beyond the largest tier MuAPI serves, and the frame would come
 * back smaller than asked and be scaled up. The project's delivery resolution
 * no longer sizes an image; it still sizes the footage and the exports.
 */

const HOUSE = Object.freeze({
    provider: 'muapi',
    model: 'nano-banana-pro',
    label: 'Nano Banana Pro',
});

/**
 * Who may generate an image, in order, and the model name each uses for Nano
 * Banana Pro. Same model, three vendors; the order is the house's.
 */
const STANDARD_MODELS = Object.freeze({
    muapi: 'nano-banana-pro',
    google: 'gemini-3-pro-image',
    meshy: 'nano-banana-pro',
});
const STANDARD_PROVIDERS = Object.freeze(Object.keys(STANDARD_MODELS));

/** The box each kind of picture is fitted inside. */
const SIZES = Object.freeze({
    storyboard: Object.freeze({ label: '4K', width: 3840, height: 2160 }),
    plate: Object.freeze({ label: '2K', longEdge: 2048 }),
});

const PLATE_KINDS = Object.freeze(['character', 'location', 'prop']);

function standardModelFor(providerId) {
    return STANDARD_MODELS[providerId] || null;
}

function isStandardProvider(providerId) {
    return Object.prototype.hasOwnProperty.call(STANDARD_MODELS, providerId);
}

function parseAspect(aspect) {
    const m = String(aspect || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2]);
    return a > 0 && b > 0 ? [a, b] : null;
}

/**
 * A board frame: the shot's shape, fitted inside 3840x2160 on the ratio's own
 * pixel grid, so the raster a provider answers on is the raster conformed to.
 * A vertical shot fills the box turned on its side. An unreadable aspect is
 * the full 16:9 frame.
 */
function storyboardSize(aspect) {
    const { gridUnitFor } = require('./capability-payloads');
    const box = SIZES.storyboard;
    const ab = parseAspect(aspect) || [16, 9];
    const unit = gridUnitFor(ab[0], ab[1]);
    // A vertical shot turns the box, not the class: 9:16 in 4K is 2160x3840.
    const [bw, bh] = ab[0] >= ab[1] ? [box.width, box.height] : [box.height, box.width];
    const k = Math.max(1, Math.floor(Math.min(bw / unit.w, bh / unit.h)));
    return { width: unit.w * k, height: unit.h * k };
}

/**
 * A plate: the long edge exactly 2048, the short edge derived from the ratio
 * and kept even. Exact rather than scaled-and-rounded, which overshoots by a
 * few pixels and then trips a provider's ceiling.
 */
function plateSize(aspect) {
    const long = SIZES.plate.longEdge;
    const ab = parseAspect(aspect) || [16, 9];
    const ratio = ab[0] / ab[1];
    const even = n => Math.max(256, Math.round(n / 2) * 2);
    return ratio >= 1
        ? { width: long, height: even(long / ratio) }
        : { width: even(long * ratio), height: long };
}

/** One line a report or a confirmation can print. */
function describeStandard() {
    return `${HOUSE.label} via MuAPI — storyboard frames ${SIZES.storyboard.label} `
        + `(${SIZES.storyboard.width}x${SIZES.storyboard.height}), plates ${SIZES.plate.label} `
        + `(${SIZES.plate.longEdge}px long edge)`;
}

module.exports = {
    HOUSE, STANDARD_MODELS, STANDARD_PROVIDERS, SIZES, PLATE_KINDS,
    standardModelFor, isStandardProvider, storyboardSize, plateSize, describeStandard,
};
