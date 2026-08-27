/**
 * Black Forest Labs — FLUX.2.
 *
 *   POST https://api.bfl.ai/v1/flux-2-{variant}
 *   header: x-key
 *
 * Two properties earn it a place beside Google rather than behind it.
 *
 * FLUX.2 Pro takes up to EIGHT reference images through the API — more than any
 * other adapter here — which matters because reference slots have been the
 * binding constraint on continuity from the day the anchor was built: a shot
 * naming two characters, a location, a car and a bag was silently dropping
 * plates before the request was even assembled. And Klein is cheap enough that
 * exploring a composition stops being a budget decision, which is the whole
 * argument for a draft tier existing at all.
 *
 * It is ASYNCHRONOUS, and in a way that constrains the code: the response
 * carries a polling URL, and the finished image is a URL that EXPIRES IN TEN
 * MINUTES. So the adapter must fetch the bytes itself before returning — handing
 * a caller a link that dies while it is being written to disk would produce an
 * asset row pointing at nothing, which is the failure mode hardest to notice
 * because the generation reported success.
 */

const { getCredential } = require('./credentials');

const BASE_URL = process.env.BFL_BASE_URL || 'https://api.bfl.ai/v1';

/*
 * The variants, with what each is FOR — because the tier table above chooses
 * between them and a bare model id says nothing about why one was picked.
 */
const MODELS = Object.freeze({
    'flux-2-klein': { label: 'FLUX.2 Klein', maxReferences: 4, note: 'cheap, high volume' },
    'flux-2-flex': { label: 'FLUX.2 Flex', maxReferences: 6, note: 'tunable steps' },
    'flux-2-pro': { label: 'FLUX.2 Pro', maxReferences: 8, note: 'up to 8 references' },
    'flux-2-max': { label: 'FLUX.2 Max', maxReferences: 8, note: 'highest fidelity' },
});
const DEFAULT_MODEL = process.env.BFL_IMAGE_MODEL || 'flux-2-pro';

const MAX_REFERENCES = 8;
const PROMPT_LIMIT = 4000;
const POLL_INTERVAL_MS = Number(process.env.BFL_POLL_INTERVAL_MS || 1500);
const POLL_TIMEOUT_MS = Number(process.env.BFL_POLL_TIMEOUT_MS || 300000);

function buildImageRequest(payload) {
    const p = payload || {};
    const model = MODELS[p.model] ? p.model : DEFAULT_MODEL;

    // No negative field on this endpoint either, so it is folded in — the
    // adapter declares 'folded' and the payload builder reserves the room.
    let prompt = String(p.prompt || '').trim();
    const negative = String(p.negative_prompt || '').trim();
    if (negative) prompt = prompt ? `${prompt}\n\nAvoid: ${negative}` : `Avoid: ${negative}`;
    // Clamped here because folding happens after the payload was budgeted; the
    // builder is the last thing before the wire.
    if (prompt.length > PROMPT_LIMIT) prompt = prompt.slice(0, PROMPT_LIMIT);
    const body = { prompt };

    /*
     * References are numbered fields (input_image, input_image_2, …) rather
     * than an array, so the ORDER is in the field name. That is positional
     * exactly as Google and OpenAI are: the prompt names "the first reference
     * image", and the anchor ranks 0 so that phrase is unambiguous.
     */
    const refs = (p.reference_images || [])
        .map(r => (typeof r === 'string' ? r : (r && (r.uri || r.url || r.image_url))))
        .filter(Boolean)
        .slice(0, MODELS[model].maxReferences);
    refs.forEach((uri, i) => {
        // The API takes a URL or bare base64 — never the data: prefix, which is
        // a browser convention this endpoint does not parse.
        const bare = String(uri).replace(/^data:[^;,]+;base64,/i, '');
        body[i === 0 ? 'input_image' : `input_image_${i + 1}`] = bare;
    });

    if (p.width && p.height) { body.width = Number(p.width); body.height = Number(p.height); }
    if (p.aspect_ratio) body.aspect_ratio = String(p.aspect_ratio);
    if (Number.isFinite(Number(p.seed))) body.seed = Number(p.seed);

    return { url: `${BASE_URL}/${model}`, body, model, referenceCount: refs.length };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Poll until Ready, then FETCH THE BYTES — the result URL expires in 10 minutes. */
async function awaitResult(pollingUrl, apiKey, deadline) {
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        let res;
        try {
            res = await fetch(pollingUrl, { headers: { 'x-key': apiKey, accept: 'application/json' } });
        } catch (err) {
            return { ok: false, status: 502, error: `bfl: polling failed — ${err.message}` };
        }
        const data = await res.json().catch(() => null);
        if (!data) continue;
        const status = String(data.status || '');
        if (status === 'Ready') {
            const sample = data.result && (data.result.sample || data.result.url);
            if (!sample) return { ok: false, status: 502, error: 'bfl: ready with no image' };
            const img = await fetch(sample);
            if (!img.ok) {
                return { ok: false, status: 502, error: `bfl: result URL returned ${img.status} (it expires ten minutes after generation)` };
            }
            return { ok: true, data: Buffer.from(await img.arrayBuffer()) };
        }
        // Content moderation is a REFUSAL, not a crash: the fallback chain walks
        // past a provider that declines, and needs to be told which it was.
        if (/Error|Failed|Moderated|Content/i.test(status)) {
            return { ok: false, status: 422, error: `bfl: ${status}${data.details ? ' — ' + JSON.stringify(data.details).slice(0, 200) : ''}` };
        }
    }
    return { ok: false, status: 504, error: 'bfl: timed out waiting for the image' };
}

async function generate(capability, payload, opts) {
    if (capability !== 'image') {
        return { ok: false, status: 400, error: `bfl: ${capability} is not served here` };
    }
    const { apiKey } = getCredential('bfl');
    if (!apiKey) return { ok: false, status: 401, error: 'bfl: no API key configured' };

    const req = buildImageRequest(payload);
    if (!req.body.prompt) return { ok: false, status: 400, error: 'bfl: nothing to generate from' };

    let res;
    try {
        res = await fetch(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-key': apiKey, accept: 'application/json' },
            body: JSON.stringify(req.body),
        });
    } catch (err) {
        return { ok: false, status: 502, error: `bfl: ${err.message}` };
    }

    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
        const detail = (data && (data.detail || data.error)) || `HTTP ${res.status}`;
        return { ok: false, status: res.status, error: `bfl: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` };
    }
    const pollingUrl = data.polling_url || (data.id ? `${BASE_URL}/get_result?id=${encodeURIComponent(data.id)}` : null);
    if (!pollingUrl) return { ok: false, status: 502, error: 'bfl: no polling URL returned' };

    const timeout = (opts && opts.timeout) || POLL_TIMEOUT_MS;
    const out = await awaitResult(pollingUrl, apiKey, Date.now() + timeout);
    if (!out.ok) return out;
    return { ok: true, data: out.data, provider: 'bfl', provider_model: req.model };
}

/**
 * What the call consumed.
 *
 * Per MEGAPIXEL, because that is how FLUX.2 bills — except Klein, which is a
 * flat price per image. Two units inside one provider is unusual and it is the
 * truth: metering Klein per megapixel would make a cheap draft look like a
 * precision frame at 4MP, which is the opposite of what the draft tier is for.
 */
function meterBFL(capability, payload, result) {
    if (capability !== 'image') return null;
    const p = payload || {};
    const model = (result && result.provider_model) || p.model || DEFAULT_MODEL;
    if (model === 'flux-2-klein') {
        return { unit: 'image', quantity: 1, model };
    }
    const px = (Number(p.width) || 1024) * (Number(p.height) || 1024);
    return { unit: 'megapixel', quantity: Math.max(0.1, px / 1e6), model };
}

const bflImageAdapter = {
    // Asked directly by the readiness checks as well as by resolve(): an
    // adapter that cannot answer "do you serve this?" is treated as not
    // serving it, and is quietly skipped as a preference.
    supports: capability => (bflImageAdapter.capabilities || []).includes(capability),
    meter: meterBFL,
    id: 'bfl',
    kind: 'generator',
    label: 'Black Forest Labs (FLUX.2)',
    requiresKey: true,
    capabilities: ['image'],

    // FLUX.2 is documented up to 4MP; asking beyond it is a rejection.
    // How a requested width/height is treated. Declared, never inferred \u2014 the
    // same rule promptLimit and maxReferenceImages follow, and for the same reason:
    // a size that reaches nothing produced a confident 2048x1152 arriving as 1376x768.
    sizeControl: 'exact',
    sizeControlReason: 'FLUX.2 takes explicit width and height, and bills by the megapixel \u2014 the size asked for is the size generated and the size charged for.',
    maxImagePixels: 4 * 1024 * 1024,
    promptLimit: PROMPT_LIMIT,
    supportsNegativePrompt: 'folded',
    supportsSeed: true,
    referenceMode: 'condition',
    maxReferenceImages: MAX_REFERENCES,
    supportsReferenceImages: true,
    supportsReferenceTags: false,

    models: MODELS,
    buildImageRequest,
    generate,

    connection: {
        instructions: 'Create a key at api.bfl.ai. API usage includes commercial rights to what you generate.',
        helpUrl: 'https://docs.bfl.ai/',
    },
};

module.exports = { adapter: bflImageAdapter, bflImageAdapter, buildImageRequest, MODELS, generate };
