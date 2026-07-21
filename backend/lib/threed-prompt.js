/**
 * 3D Prompt / Payload Builder
 *
 * Pure functions for building Gridlight /3d generation payloads from
 * character / prop / scene subjects. Deterministic, no DB, no network —
 * mirrors the video-prompt.js ↔ video-gen.js split so the route file stays
 * thin orchestration and all payload logic is unit-testable.
 */

// ── Defaults ────────────────────────────────────────────────────────────
const DEFAULT_FORMAT = 'glb';
const DEFAULT_MODEL = 'hunyuan3d';
const DEFAULT_QUALITY = 'standard';
const DEFAULT_SEED = -1;
const DEFAULT_POLYCOUNT = 30000;
const DEFAULT_TEXTURE_RES = 1024;

const VALID_FORMATS = ['glb', 'gltf', 'fbx', 'obj', 'usdz'];
const VALID_QUALITY = ['draft', 'standard', 'high'];

const NEGATIVE_PROMPT_3D =
    'low quality, distorted geometry, holes, non-manifold, floating parts, ' +
    'flat, disconnected mesh, artifacts';

/**
 * Normalize a raw character/prop DB row into a subject descriptor.
 * @param {object} row - film_characters or film_props row
 * @param {'character'|'prop'|'set'|'shot'} kind
 * @returns {{name:string, prompt:string, category:string}}
 */
function normalizeSubject(row, kind) {
    const r = row || {};
    if (kind === 'prop') {
        return {
            name: r.name || 'prop',
            prompt: [r.visual_prompt, r.description].filter(Boolean).join(', ') || (r.name || 'prop'),
            category: r.category || 'prop',
        };
    }
    // character (default)
    const parts = [
        r.appearance_prompt,
        r.build,
        r.hair,
        r.distinguishing,
        r.ethnicity,
    ].filter(Boolean);
    return {
        name: r.name || 'character',
        prompt: parts.join(', ') || (r.description || r.name || 'character'),
        category: kind || 'character',
    };
}

function clampFormat(fmt) {
    return VALID_FORMATS.includes(String(fmt || '').toLowerCase())
        ? String(fmt).toLowerCase()
        : DEFAULT_FORMAT;
}

function clampQuality(q) {
    return VALID_QUALITY.includes(String(q || '').toLowerCase())
        ? String(q).toLowerCase()
        : DEFAULT_QUALITY;
}

/**
 * Build a /3d/generate payload (text -> mesh).
 * @param {{name:string, prompt:string, category:string}} subject
 * @param {object} [opts] - { format, quality, seed, model, target_polycount, texture_resolution, symmetry }
 * @returns {object} payload
 */
function build3DPayload(subject, opts) {
    const o = opts || {};
    const s = subject || {};
    const promptBase = (s.prompt || s.name || '').trim();
    const prompt = promptBase
        ? `${promptBase}, full 3D model, clean topology, game-ready, neutral pose`
        : 'a detailed 3D model, clean topology, game-ready';

    return {
        prompt,
        negative_prompt: o.negative_prompt || NEGATIVE_PROMPT_3D,
        format: clampFormat(o.format),
        quality: clampQuality(o.quality),
        model: o.model || DEFAULT_MODEL,
        seed: Number.isInteger(o.seed) ? o.seed : DEFAULT_SEED,
        target_polycount: Number.isInteger(o.target_polycount) ? o.target_polycount : DEFAULT_POLYCOUNT,
        texture_resolution: Number.isInteger(o.texture_resolution) ? o.texture_resolution : DEFAULT_TEXTURE_RES,
        symmetry: o.symmetry === undefined ? (s.category === 'character') : !!o.symmetry,
        pbr: o.pbr === undefined ? true : !!o.pbr,
    };
}

/**
 * Build a /3d/from-image payload (single reference image -> mesh).
 * @param {string} imageRef - base64 data or an image URL/reference
 * @param {object} [opts] - { format, quality, seed, model, remove_background }
 * @returns {object} payload
 */
function buildFromImagePayload(imageRef, opts) {
    const o = opts || {};
    return {
        init_image: imageRef || null,
        format: clampFormat(o.format),
        quality: clampQuality(o.quality),
        model: o.model || DEFAULT_MODEL,
        seed: Number.isInteger(o.seed) ? o.seed : DEFAULT_SEED,
        remove_background: o.remove_background === undefined ? true : !!o.remove_background,
        texture_resolution: Number.isInteger(o.texture_resolution) ? o.texture_resolution : DEFAULT_TEXTURE_RES,
    };
}

/**
 * Build a /3d/rig payload (auto-rig an existing mesh).
 * @param {string} assetRef - upstream asset id or model url the service can resolve
 * @param {object} [opts] - { skeleton, model }
 * @returns {object} payload
 */
function buildRigPayload(assetRef, opts) {
    const o = opts || {};
    return {
        asset: assetRef || null,
        skeleton: o.skeleton || 'humanoid',
        model: o.model || DEFAULT_MODEL,
    };
}

/**
 * Build a /3d/retexture payload (regenerate textures for an existing mesh).
 * @param {string} assetRef
 * @param {object} [opts] - { prompt, texture_resolution, model }
 * @returns {object} payload
 */
function buildRetexturePayload(assetRef, opts) {
    const o = opts || {};
    return {
        asset: assetRef || null,
        prompt: (o.prompt || '').trim(),
        texture_resolution: Number.isInteger(o.texture_resolution) ? o.texture_resolution : DEFAULT_TEXTURE_RES,
        model: o.model || DEFAULT_MODEL,
    };
}

/**
 * Build a /3d/animate payload (apply an animation clip to a rigged mesh).
 * @param {string} assetRef
 * @param {string} clipName - e.g. 'walk', 'idle', 'run'
 * @param {object} [opts] - { loop, fps, model }
 * @returns {object} payload
 */
function buildAnimatePayload(assetRef, clipName, opts) {
    const o = opts || {};
    return {
        asset: assetRef || null,
        animation: clipName || 'idle',
        loop: o.loop === undefined ? true : !!o.loop,
        fps: Number.isInteger(o.fps) ? o.fps : 30,
        model: o.model || DEFAULT_MODEL,
    };
}

module.exports = {
    normalizeSubject,
    build3DPayload,
    buildFromImagePayload,
    buildRigPayload,
    buildRetexturePayload,
    buildAnimatePayload,
    // exported for tests / reuse
    VALID_FORMATS,
    VALID_QUALITY,
    DEFAULT_FORMAT,
    DEFAULT_MODEL,
    NEGATIVE_PROMPT_3D,
};
