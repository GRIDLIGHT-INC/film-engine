/**
 * Google's image models — "Nano Banana 2" and "Nano Banana Pro".
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   header: x-goog-api-key
 *
 * Two things make these worth wiring ahead of the others.
 *
 * They are built for MULTI-REFERENCE CONSISTENCY, which is the whole problem
 * this engine has been solving by hand: a keyframe that must reconcile a
 * character plate, a location plate, a prop and the previous frame is exactly
 * the request that has been coming back with the wrong street. And they are the
 * first provider here that documents 4K output, so the clamp that holds every
 * other adapter to one or two megapixels is not a fact about image generation —
 * it is a fact about the providers we had.
 *
 * Reference images ride as inline base64 in the same `input` array as the text,
 * so there is no tag syntax: roles are POSITIONAL, exactly as they are for
 * Meshy and OpenAI, and the prompt must name them by position.
 */

const { getCredential } = require('./credentials');

const BASE_URL = process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

/*
 * The two models the director named, plus the lite variant.
 *
 * Held as a table rather than a free string so a typo becomes a refusal here
 * rather than a paid request that comes back as something else — the fault
 * Runway's silent model substitution already demonstrated.
 */
const MODELS = Object.freeze({
    'gemini-3.1-flash-image': { label: 'Nano Banana 2', sizes: ['512px', '1K', '2K', '4K'] },
    'gemini-3-pro-image': { label: 'Nano Banana Pro', sizes: ['1K', '2K', '4K'] },
    'gemini-3.1-flash-lite-image': { label: 'Nano Banana 2 Lite', sizes: ['1K'] },
});
const DEFAULT_MODEL = process.env.GOOGLE_IMAGE_MODEL || 'gemini-3.1-flash-image';

/** 4K is what the model documents; the payload asks for the nearest size below it. */
function imageSizeFor(width, height, model) {
    const allowed = (MODELS[model] || MODELS[DEFAULT_MODEL]).sizes;
    const longest = Math.max(Number(width) || 0, Number(height) || 0);
    const wanted = longest >= 3000 ? '4K' : longest >= 1700 ? '2K' : longest >= 700 ? '1K' : '512px';
    // Never ask for a size this model does not offer: an unsupported value is a
    // rejection that costs a request and returns nothing.
    if (allowed.includes(wanted)) return wanted;
    const order = ['4K', '2K', '1K', '512px'];
    return order.slice(order.indexOf(wanted)).find(s => allowed.includes(s)) || allowed[allowed.length - 1];
}

/** The ratios this adapter snaps to, stated once so the dialog offers the same set. */
const ASPECTS = Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);

/** The aspect ratio as Google states it, or nothing rather than a guess. */
function aspectFor(payload) {
    const declared = String(payload.aspect_ratio || '').trim();
    if (/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(declared)) return declared;
    const w = Number(payload.width), h = Number(payload.height);
    if (!w || !h) return undefined;
    const r = w / h;
    // Snapped to the ratios the API names, because an arbitrary ratio is a 400.
    const known = ASPECTS.map(a => { const [x, y] = a.split(':').map(Number); return [a, x / y]; });
    return known.reduce((best, k) =>
        Math.abs(k[1] - r) < Math.abs(best[1] - r) ? k : best, known[0])[0];
}

function buildImageRequest(payload) {
    const p = payload || {};
    const model = MODELS[p.model] ? p.model : DEFAULT_MODEL;

    const input = [];
    /*
     * There is no negative field on this API, so a refusal has to be FOLDED
     * into the prompt. The adapter declares supportsNegativePrompt: 'folded'
     * and the payload builder reserves room for exactly this text — declaring
     * it and then dropping the negative would spend that reserved room on
     * nothing, and the shot-specific negatives are the ones written to stop
     * failures that already happened.
     */
    let prompt = String(p.prompt || '').trim();
    const negative = String(p.negative_prompt || '').trim();
    if (negative) prompt = prompt ? `${prompt}\n\nAvoid: ${negative}` : `Avoid: ${negative}`;
    // Folding happens AFTER the payload was budgeted, so a prompt built to
    // exactly the ceiling plus a negative exceeds it. The builder is the last
    // thing before the wire, so the clamp belongs here — a caller reaching the
    // adapter directly has no other guard.
    if (prompt.length > PROMPT_LIMIT) prompt = prompt.slice(0, PROMPT_LIMIT);
    if (prompt) input.push({ type: 'text', text: prompt });

    /*
     * References after the text, in the order they were ranked. Positional and
     * unnamed, so the prompt refers to them as "the first reference image" —
     * the same contract Meshy and OpenAI impose, and the reason the shot anchor
     * ranks 0 rather than relying on a tag.
     */
    for (const ref of (p.reference_images || []).slice(0, MAX_REFERENCES)) {
        const uri = typeof ref === 'string' ? ref : (ref && (ref.uri || ref.url || ref.image_url));
        if (!uri) continue;
        const m = /^data:([^;,]+);base64,(.+)$/i.exec(String(uri));
        if (!m) continue;                      // a bare URL cannot be inlined
        input.push({ type: 'image', mime_type: m[1], data: m[2] });
    }

    const body = {
        model,
        input,
        response_format: {
            type: 'image',
            mime_type: 'image/jpeg',
            image_size: imageSizeFor(p.width, p.height, model),
        },
    };
    const aspect = aspectFor(p);
    if (aspect) body.response_format.aspect_ratio = aspect;

    return { url: `${BASE_URL}/interactions`, body, model };
}

const MAX_REFERENCES = 8;
const PROMPT_LIMIT = 16000;

async function generate(capability, payload, opts) {
    if (capability !== 'image') {
        return { ok: false, status: 400, error: `google: ${capability} is not served here` };
    }
    const { apiKey } = getCredential('google');
    if (!apiKey) {
        return { ok: false, status: 401, error: 'google: no API key configured' };
    }

    const req = buildImageRequest(payload);
    if (!req.body.input.length) {
        return { ok: false, status: 400, error: 'google: nothing to generate from' };
    }

    let res;
    try {
        res = await fetch(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(req.body),
            signal: opts && opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
        });
    } catch (err) {
        return { ok: false, status: 502, error: `google: ${err.message}` };
    }

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    if (!res.ok) {
        const detail = (data && data.error && data.error.message) || text.slice(0, 300);
        return { ok: false, status: res.status, error: `google: ${detail}` };
    }

    // The image comes back as base64 on the interaction.
    const b64 = data && (
        (data.output_image && data.output_image.data)
        || (data.interaction && data.interaction.output_image && data.interaction.output_image.data)
        || (Array.isArray(data.output) && data.output.find(o => o && o.data) || {}).data);
    if (!b64) {
        // A refusal is an answer, not a crash: the image-fallback chain walks
        // past a provider that declines, and it needs to be told plainly.
        return { ok: false, status: 502, error: 'google: no image returned (possibly refused)' };
    }
    return {
        ok: true,
        data: Buffer.from(b64, 'base64'),
        provider: 'google',
        provider_model: req.model,
        usage: data && data.usage ? data.usage : undefined,
    };
}

/**
 * What the call consumed. Per image — and the output SIZE is folded into the
 * model id, because Pro at 4K is a different price from Pro at 1K and a blended
 * figure would be wrong in whichever direction the board leaned.
 */
function meterGoogle(capability, payload, result) {
    if (capability !== 'image') return null;
    const p = payload || {};
    const base = (result && result.provider_model) || p.model || DEFAULT_MODEL;
    const size = imageSizeFor(p.width, p.height, MODELS[base] ? base : DEFAULT_MODEL);
    // Only sizes the rate book prices separately get a suffix; the rest fall
    // back to the parent rate rather than to zero.
    const model = (size === '4K' || size === '2K') ? `${base}-${size.toLowerCase()}` : base;
    return { unit: 'image', quantity: Math.max(1, Number(p.n) || 1), model };
}

const googleImageAdapter = {
    // Asked directly by the readiness checks as well as by resolve(): an
    // adapter that cannot answer "do you serve this?" is treated as not
    // serving it, and is quietly skipped as a preference.
    supports: capability => (googleImageAdapter.capabilities || []).includes(capability),
    meter: meterGoogle,
    id: 'google',
    /** Synchronous: the call returns when the work is done, with nothing to report on the way. */
    reportsProgress: 'none',
    kind: 'generator',
    label: 'Google (Nano Banana)',
    requiresKey: true,
    capabilities: ['image'],

    // Documented at 4K for both named models — the first provider here that
    // makes the frame size a real choice rather than something to clamp.
    // How a requested width/height is treated. Declared, never inferred \u2014 the
    // same rule promptLimit and maxReferenceImages follow, and for the same reason:
    // a size that reaches nothing produced a confident 2048x1152 arriving as 1376x768.
    /**
     * The largest size tier a given model offers.
     *
     * Per MODEL, not per provider: `gemini-3.1-flash-lite-image` — which the
     * DRAFT tier routes to — is 1K only, while the other two reach 4K. A
     * caller that asks the adapter "can you do 2K" and gets a yes would be
     * told the truth about the provider and a lie about the model it is
     * actually going to run.
     */
    maxSizeForModel(model) {
        const sizes = (MODELS[model] || MODELS[DEFAULT_MODEL]).sizes;
        return sizes[sizes.length - 1];
    },
    sizeControl: 'snapped',
    sizeControlReason: 'The request carries image_size as a TIER \u2014 512px, 1K, 2K or 4K \u2014 '
        + 'not a pixel pair, so a requested width and height selects the nearest tier at the '
        + 'requested aspect rather than being reproduced exactly. 2K is reachable, which is what '
        + 'a location plate needs.',
    maxImagePixels: 3840 * 2160,
    // Gemini takes a very long prompt; held at the largest figure any adapter
    // here uses rather than assumed unbounded.
    promptLimit: PROMPT_LIMIT,
    // No dedicated negative field: a refusal has to be folded into the prompt,
    // the same as Meshy.
    supportsNegativePrompt: 'folded',
    supportsSeed: false,
    referenceMode: 'condition',
    maxReferenceImages: MAX_REFERENCES,
    supportsReferenceImages: true,
    supportsReferenceTags: false,

    models: MODELS,
    buildImageRequest,
    generate,

    connection: {
        instructions: 'Create a key in Google AI Studio and paste it here. The same key serves both '
            + 'Nano Banana 2 (gemini-3.1-flash-image) and Nano Banana Pro (gemini-3-pro-image).',
        helpUrl: 'https://aistudio.google.com/apikey',
    },
};

module.exports = { adapter: googleImageAdapter, googleImageAdapter, buildImageRequest, MODELS, ASPECTS, generate };
