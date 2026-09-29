/**
 * THE HOUSE IMAGE STANDARD — the default model, and the project's own size.
 *
 * A DEFAULT, NOT A LOCK. "Any image prompt should be able to be sent to flux 2
 * dev or any of our other providers." A provider or model somebody chose (the
 * project's pin, or a per-generation choice) runs; this standard is what runs
 * when nobody chose. lib/providers/index.js, lib/capability-payloads.js and
 * lib/image-fallback.js each say so where they decide. What follows is the
 * history of why the default is what it is.
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
 * ── The size is the PROJECT's, set once in its technical settings ───────
 *
 * "For each image, let's follow the standard of the project (Resolution in the
 *  technical settings). So if I select 4K then the picture is 4K… it shouldn't
 *  be hardwired." The first version of this file WAS hardwired — boards at a
 * 3840x2160 box and plates at a 2048 long edge whatever the project said — so
 * a 1080p project paid 4K rates for every frame and a director who chose 8K
 * could not get it.
 *
 * Every picture now takes the long edge of `film_projects.target_resolution`,
 * in its own shape: a 16:9 board on a 4K UHD project is 3840x2160, on a 2K
 * project 2048x1152; a 9:16 shot turns it (2160x3840). Long edge rather than
 * fitted-inside-the-raster, because "2K" means a 2048 edge to the person who
 * picked it — fitting 16:9 inside 2048x1080 would hand back 1920x1080 and call
 * it 2K. A project with no readable resolution is 2K (DEFAULT_RESOLUTION), the
 * default a new project is created with.
 *
 * The provider's own ceiling still clamps and says so; MuAPI serves Nano Banana
 * Pro in 1k/2k/4k tiers, so anything above 4K is asked at 4K and reported.
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

/** The resolution a project without a readable one generates at: 2K. */
const DEFAULT_RESOLUTION = '2048x1080';

/**
 * What a size ANSWERS to. Kept as the default's long edge so a caller that asks
 * "what is the plate floor" without a project gets the 2K it always got.
 */
const SIZES = Object.freeze({
    storyboard: Object.freeze({ label: 'project resolution', longEdge: 2048 }),
    plate: Object.freeze({ label: 'project resolution', longEdge: 2048 }),
});

/**
 * The long edge a project's pictures are made at, read from its technical
 * settings. "3840x2160" → 3840; a vertical raster answers with its height.
 */
function longEdgeFor(targetResolution) {
    const m = String(targetResolution || '').match(/^\s*(\d{3,5})\s*x\s*(\d{3,5})\s*$/i);
    const d = m ? [Number(m[1]), Number(m[2])] : DEFAULT_RESOLUTION.split('x').map(Number);
    return Math.max(d[0], d[1]);
}

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
 * A board frame: the shot's shape at the project's long edge, on the ratio's
 * own pixel grid, so the raster a provider answers on is the raster conformed
 * to. An unreadable aspect is 16:9.
 */
function storyboardSize(aspect, targetResolution) {
    const { gridUnitFor } = require('./capability-payloads');
    const long = longEdgeFor(targetResolution);
    const ab = parseAspect(aspect) || [16, 9];
    const unit = gridUnitFor(ab[0], ab[1]);
    // A vertical shot turns the class, not the edge: 9:16 in 4K is 2160x3840.
    const k = Math.max(1, Math.floor(long / Math.max(unit.w, unit.h)));
    return { width: unit.w * k, height: unit.h * k };
}

/**
 * A plate: the long edge exactly the project's, the short edge derived from
 * the ratio and kept even. Exact rather than scaled-and-rounded, which overshoots by a
 * few pixels and then trips a provider's ceiling.
 */
function plateSize(aspect, targetResolution) {
    const long = longEdgeFor(targetResolution);
    const ab = parseAspect(aspect) || [16, 9];
    const ratio = ab[0] / ab[1];
    const even = n => Math.max(256, Math.round(n / 2) * 2);
    return ratio >= 1
        ? { width: long, height: even(long / ratio) }
        : { width: even(long * ratio), height: long };
}

/**
 * The resolution a project's pictures are made at, from the project row if the
 * caller has it, else read by id. The database is consulted only if something
 * in this process already opened it, so a unit test asking for a size cannot
 * open the real database — the rule file-storage.dirFor follows.
 */
function projectResolution(projectOrId) {
    if (projectOrId && typeof projectOrId === 'object' && projectOrId.target_resolution) {
        return projectOrId.target_resolution;
    }
    const id = projectOrId && typeof projectOrId === 'object' ? projectOrId.id : projectOrId;
    if (!id) return null;
    let dbPath;
    try { dbPath = require.resolve('../db/database'); } catch (_) { return null; }
    const loaded = require.cache[dbPath];
    if (!loaded || !loaded.exports || !loaded.exports.db) return null;
    try {
        const row = loaded.exports.db.prepare('SELECT target_resolution FROM film_projects WHERE id = ?').get(id);
        return (row && row.target_resolution) || null;
    } catch (_) { return null; }
}

/** One line a report or a confirmation can print. */

module.exports = {    HOUSE, STANDARD_MODELS, STANDARD_PROVIDERS, SIZES, PLATE_KINDS,
    standardModelFor, isStandardProvider, storyboardSize, plateSize,
    DEFAULT_RESOLUTION, longEdgeFor, projectResolution,};
