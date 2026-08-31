/**
 * MuAPI images — the Nano Banana family, bought from the aggregator.
 *
 *   POST https://api.muapi.ai/api/v1/{slug}
 *   header: x-api-key
 *   -> { request_id }, then GET /predictions/{request_id}/result until completed
 *
 * THE SAME ASYNC SHAPE THE VIDEO ADAPTER ALREADY USES. seedance.js reaches
 * MuAPI for footage and this reaches it for frames, so the two share a host, a
 * header, a polling contract and — on most accounts — a single key. Written
 * against that adapter deliberately rather than against google-image.js: the
 * model is Google's, the transport is not.
 *
 * WHY BUY GOOGLE'S MODEL FROM SOMEWHERE ELSE. Two reasons, and only one of
 * them is price. MuAPI lists Nano Banana 2 at $0.06 for a 1K frame against
 * Google's published $0.067, so the aggregator is marginally CHEAPER rather
 * than carrying the reseller markup Meshy does at $0.12. The larger reason is
 * that it removes a second billing relationship from the critical path: a
 * postpay Gemini project that Google's own backend flips into prepay mode
 * returns 429 "prepayment credits are depleted" on every request, cannot be
 * fixed from this side, and takes the whole board down with it. One vendor,
 * one key, one invoice.
 */

const { getCredential } = require('./credentials');

const BASE_URL = process.env.MUAPI_BASE_URL || 'https://api.muapi.ai/api/v1';

/**
 * Model -> endpoint slug and the sizes it will actually return.
 *
 * The slug IS the path segment, which is the pattern seedance already follows
 * (`seedance-2.5-image-to-video-480p`). Overridable per model by env because a
 * slug is the one thing here that can change without warning, and a 404 on a
 * renamed endpoint should be a config fix rather than a code change.
 */
const MODELS = Object.freeze({
    'nano-banana-pro': {
        slug: process.env.MUAPI_SLUG_NANO_BANANA_PRO || 'nano-banana-pro',
        label: 'Nano Banana Pro (Gemini 3 Pro Image)',
        sizes: ['1K', '2K', '4K'],
    },
    'nano-banana-2': {
        slug: process.env.MUAPI_SLUG_NANO_BANANA_2 || 'nano-banana-2',
        label: 'Nano Banana 2',
        sizes: ['1K', '2K', '4K'],
    },
    'nano-banana': {
        slug: process.env.MUAPI_SLUG_NANO_BANANA || 'nano-banana',
        label: 'Nano Banana',
        sizes: ['1K'],
    },
});

const DEFAULT_MODEL = process.env.MUAPI_IMAGE_MODEL || 'nano-banana-pro';
const PROMPT_LIMIT = 16000;
const MAX_REFERENCES = 8;
const POLL_MS = 2500;
const POLL_TRIES = 120;

/**
 * The credential, with a deliberate fallback to `seedance`.
 *
 * MuAPI issues ONE key per account and this engine already stores it under the
 * video adapter's name, because seedance-through-MuAPI was wired first. Asking
 * the operator to paste the same string a second time under a second name is
 * how one of the two silently goes stale. A key saved explicitly as `muapi`
 * still wins, so an account that separates them is unaffected.
 */
function muapiCredential() {
    const own = getCredential('muapi');
    if (own && own.apiKey) return own;
    return getCredential('seedance');
}

/** Nearest size the model actually serves, never larger than asked. */
function imageSizeFor(width, height, model) {
    const allowed = (MODELS[model] || MODELS[DEFAULT_MODEL]).sizes;
    const longest = Math.max(Number(width) || 0, Number(height) || 0);
    const wanted = longest >= 3000 ? '4K' : longest >= 1700 ? '2K' : longest >= 700 ? '1K' : '1K';
    if (allowed.includes(wanted)) return wanted;
    const order = ['4K', '2K', '1K'];
    return order.slice(order.indexOf(wanted)).find(s => allowed.includes(s)) || allowed[allowed.length - 1];
}

/** "16:9" from a width and height, since MuAPI takes a ratio rather than pixels. */
function aspectFor(width, height) {
    const w = Number(width) || 0, h = Number(height) || 0;
    if (!w || !h) return '16:9';
    const r = w / h;
    const known = [['21:9', 2.333], ['16:9', 1.778], ['3:2', 1.5], ['4:3', 1.333],
                   ['1:1', 1], ['3:4', 0.75], ['2:3', 0.667], ['9:16', 0.5625]];
    return known.reduce((best, c) => Math.abs(c[1] - r) < Math.abs(best[1] - r) ? c : best, known[1])[0];
}

/**
 * Build the request. PURE — no key, no socket — so the dry run can print the
 * real outbound body without being able to send it.
 */
function buildImageRequest(p) {
    const model = MODELS[p.model] ? p.model : DEFAULT_MODEL;
    const spec = MODELS[model];

    let prompt = String(p.prompt || '');
    if (p.negative_prompt) prompt += `\n\nAvoid: ${p.negative_prompt}`;
    if (prompt.length > PROMPT_LIMIT) prompt = prompt.slice(0, PROMPT_LIMIT);

    const images = [];
    for (const ref of (p.reference_images || []).slice(0, MAX_REFERENCES)) {
        const uri = typeof ref === 'string' ? ref : (ref && (ref.uri || ref.url || ref.image_url));
        if (uri) images.push(uri);
    }

    const body = {
        prompt,
        aspect_ratio: aspectFor(p.width, p.height),
        resolution: imageSizeFor(p.width, p.height, model),
    };
    if (images.length) body.image_urls = images;
    if (p.seed !== null && p.seed !== undefined) body.seed = p.seed;

    return { url: `${BASE_URL}/${spec.slug}`, body, model };
}

function describeImageRequest(p) {
    const req = buildImageRequest(p);
    return { url: req.url, body: req.body };
}

/** Poll until the frame is finished, on seedance.js's contract. */
async function pollResult(requestId, apiKey) {
    const url = `${BASE_URL}/predictions/${encodeURIComponent(requestId)}/result`;
    for (let i = 0; i < POLL_TRIES; i++) {
        await new Promise(r => setTimeout(r, POLL_MS));
        let res;
        try {
            res = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
        } catch (err) {
            return { ok: false, status: 502, error: `muapi: polling failed — ${err.message}` };
        }
        const data = await res.json().catch(() => ({}));
        const status = String(data.status || '').toLowerCase();
        if (status === 'completed' || status === 'succeeded') {
            const out = data.outputs || data.output || data.result || {};
            const src = (Array.isArray(out) && out[0])
                || out.image_url || out.url || data.image_url || data.url
                || (Array.isArray(out.images) && out.images[0]);
            const href = typeof src === 'string' ? src : (src && (src.url || src.image_url));
            if (!href) return { ok: false, status: 502, error: 'muapi: completed with no image' };
            /*
             * Fetched to BYTES here rather than handed back as a URL. A stored
             * remote URL is the persistence defect this repo has already paid
             * for once: the asset row looks complete, the file is not on disk,
             * and the NLE export writes a pathurl nothing can relink.
             */
            try {
                const img = await fetch(href);
                if (!img.ok) return { ok: false, status: img.status, error: `muapi: could not fetch the finished image (HTTP ${img.status})` };
                return { ok: true, data: Buffer.from(await img.arrayBuffer()) };
            } catch (err) {
                return { ok: false, status: 502, error: `muapi: could not fetch the finished image — ${err.message}` };
            }
        }
        if (status === 'failed' || status === 'error' || status === 'cancelled') {
            return { ok: false, status: 422, error: `muapi: ${data.error || data.detail || status}` };
        }
    }
    return { ok: false, status: 504, error: 'muapi: timed out waiting for the image' };
}

async function generate(capability, payload, opts) {
    if (capability !== 'image') {
        return { ok: false, status: 400, error: `muapi: ${capability} is not served here` };
    }
    const { apiKey } = muapiCredential();
    if (!apiKey) return { ok: false, status: 401, error: 'muapi: no API key configured' };

    const req = buildImageRequest(payload || {});
    if (!req.body.prompt) return { ok: false, status: 400, error: 'muapi: nothing to generate from' };

    let res;
    try {
        res = await fetch(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, accept: 'application/json' },
            body: JSON.stringify(req.body),
        });
    } catch (err) {
        return { ok: false, status: 502, error: `muapi: ${err.message}` };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const detail = (data && (data.error || data.detail || data.message)) || `HTTP ${res.status}`;
        return { ok: false, status: res.status, error: `muapi: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` };
    }

    const requestId = data.request_id || data.id;
    if (!requestId) return { ok: false, status: 502, error: 'muapi: no request id returned' };

    const out = await pollResult(requestId, apiKey);
    if (!out.ok) return out;
    return { ok: true, data: out.data, provider: 'muapi', provider_model: req.model };
}

/**
 * Metered per image, at the tier's own rate.
 *
 * An adapter that generates and cannot be priced reports its spend as zero,
 * which on the image path is the largest line in a storyboard-heavy project.
 * The suffix is applied ONLY for sizes the rate book prices separately, so an
 * unpriced tier falls back to the parent rate rather than to nothing --
 * the rule meterGoogle already follows for the identical tier shape.
 */
function meterMuapi(capability, payload, result) {
    if (capability !== 'image') return null;
    const p = payload || {};
    const base = (result && result.provider_model) || p.model || DEFAULT_MODEL;
    const size = imageSizeFor(p.width, p.height, MODELS[base] ? base : DEFAULT_MODEL);
    const model = (size === '4K' || size === '2K') ? `${base}-${String(size).toLowerCase()}` : base;
    return { unit: 'image', quantity: Math.max(1, Number(p.n) || 1), model };
}

const muapiImageAdapter = {
    supports: capability => (muapiImageAdapter.capabilities || []).includes(capability),
    meter: meterMuapi,
    id: 'muapi',
    kind: 'generator',
    label: 'MuAPI (Nano Banana)',
    requiresKey: true,
    capabilities: ['image'],

    /*
     * MuAPI takes a RATIO and a resolution tier, not a width and a height, so a
     * requested 1672x944 comes back as whatever the tier's 16:9 frame is.
     * Declared rather than inferred, for the reason bfl states: a size that
     * reaches nothing produced a confident 2048x1152 arriving as 1376x768.
     */
    /*
     * SNAPPED, not a fourth value. The contract knows exact / snapped /
     * ratio-only, and a tier is the definition of snapped: "it is told a size
     * and answers at the nearest one it offers". google-image declares the
     * same for its own 512px/1K/2K/4K tier, and inventing `tier` here would
     * make two adapters describe one behaviour two ways.
     */
    sizeControl: 'snapped',
    sizeControlReason: 'MuAPI takes an aspect ratio and a 1K/2K/4K tier; the exact pixel '
        + 'dimensions are the tier\u2019s, not the ones asked for.',
    promptLimit: PROMPT_LIMIT,
    supportsNegativePrompt: 'folded',
    supportsSeed: true,
    referenceMode: 'edit',
    maxReferenceImages: MAX_REFERENCES,
    /*
     * Stated rather than left to be inferred. `maxReferenceImages` alone does
     * not answer whether references WORK -- gridlight declares a number and
     * cannot read tags -- so the two booleans are the contract every other
     * image adapter carries.
     */
    supportsReferenceImages: true,
    supportsReferenceTags: false,

    /*
     * The 4K tier, which is the largest MuAPI offers for these models. Same
     * figure and same reasoning as google-image: MuAPI proxies the Nano Banana
     * (Gemini) models, so the ceiling is theirs. Declared because an adapter
     * that does not say is read as the strictest default -- and over-promising
     * is what produced a confident 2048x1152 arriving as 1376x768.
     */
    maxImagePixels: 3840 * 2160,

    models: MODELS,
    sizes: ['1K', '2K', '4K'],
    buildImageRequest,
    describeImageRequest,
    generate,

    connection: {
        instructions: 'MuAPI serves the Nano Banana family. One key covers images and Seedance video — if you already pasted it for Seedance, this adapter reuses it.',
        helpUrl: 'https://muapi.ai/',
    },
};

module.exports = { adapter: muapiImageAdapter, muapiImageAdapter, buildImageRequest,
                   describeImageRequest, MODELS, generate, imageSizeFor, aspectFor };
