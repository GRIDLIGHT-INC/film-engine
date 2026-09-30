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
/**
 * Model -> the two endpoints it is served on, and what each will accept.
 *
 * TWO SLUGS, NOT ONE, and this is the defect that mattered. MuAPI serves
 * text-to-image and editing as SEPARATE endpoints -- `nano-banana-2` and
 * `nano-banana-2-edit` -- and only the second takes pictures. This adapter
 * posted everything to the first and attached references as `image_urls`, a
 * field neither endpoint has; FastAPI ignores an unknown field rather than
 * refusing it, so every character plate, location plate and shot anchor was
 * serialised, sent, and silently dropped. The frame came back plausible and
 * conditioned on nothing, which is indistinguishable from conditioning being
 * weak -- and this is the provider the whole production is moving to.
 *
 * `resolution` is declared per model rather than assumed, for the same reason:
 * `nano-banana` and `nano-banana-2-lite` accept no resolution field at all, and
 * sending one is a setting the director watches reach nothing.
 *
 * Every field here was read from MuAPI's own refusals, not from documentation --
 * see tests/refresh-muapi-contract.js. The slug IS the path segment, which is
 * the pattern seedance already follows, and stays overridable by env because a
 * slug is the one thing that can change without warning.
 */
const MODELS = Object.freeze({
    'nano-banana-pro': {
        slug: process.env.MUAPI_SLUG_NANO_BANANA_PRO || 'nano-banana-pro',
        editSlug: process.env.MUAPI_SLUG_NANO_BANANA_PRO_EDIT || 'nano-banana-pro-edit',
        label: 'Nano Banana Pro (Gemini 3 Pro Image)',
        resolution: true,
        sizes: ['1k', '2k', '4k'],
    },
    'nano-banana-2': {
        slug: process.env.MUAPI_SLUG_NANO_BANANA_2 || 'nano-banana-2',
        editSlug: process.env.MUAPI_SLUG_NANO_BANANA_2_EDIT || 'nano-banana-2-edit',
        label: 'Nano Banana 2',
        resolution: true,
        sizes: ['1k', '2k', '4k'],
    },
    /*
     * The cheap one, at half the price of Nano Banana 2 -- worth having on the
     * menu precisely because a board is generated many times over, and the
     * draft-then-finish argument the video side already makes applies here too.
     */
    'nano-banana-2-lite': {
        slug: process.env.MUAPI_SLUG_NANO_BANANA_2_LITE || 'nano-banana-2-lite',
        editSlug: process.env.MUAPI_SLUG_NANO_BANANA_2_LITE_EDIT || 'nano-banana-2-lite-edit',
        label: 'Nano Banana 2 Lite',
        resolution: false,
        sizes: ['1k'],
    },
    'nano-banana': {
        slug: process.env.MUAPI_SLUG_NANO_BANANA || 'nano-banana',
        editSlug: process.env.MUAPI_SLUG_NANO_BANANA_EDIT || 'nano-banana-edit',
        label: 'Nano Banana',
        resolution: false,
        sizes: ['1k'],
    },
});

const DEFAULT_MODEL = process.env.MUAPI_IMAGE_MODEL || 'nano-banana-pro';
const PROMPT_LIMIT = 16000;
const MAX_REFERENCES = 8;
/*
 * THE POLL BUDGET IS THE HOST'S, NOT THE MODEL'S.
 *
 * A tool call through the MCP host is abandoned at 60 seconds. A generation
 * still polling at that moment is not slow — it is LOST: the handler is torn
 * down mid-await, nothing is written, and the caller is told the device did not
 * respond, which reads like a connection fault rather than a generation that
 * very nearly finished. That failure is invisible and it cost a full run to
 * find, because the real error never survived to be reported.
 *
 * So the budget is set BELOW the host's, and the adapter answers inside it
 * either way — a frame, or a timeout that says so. Polled fast because these
 * models are fast: MuAPI documents Nano Banana 2 Lite at about four seconds.
 */
const POLL_MS = Number(process.env.MUAPI_POLL_MS || 1500);
const POLL_TRIES = 32;

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

/*
 * The tier to ask for, and it is LOWERCASE.
 *
 * MuAPI validates this field against the literals '1k', '2k', '4k' and rejects
 * '1K' outright — a strict validator, which is a kindness: the wrong tier name
 * fails at the request rather than silently returning the wrong size.
 *
 * SMALLEST TIER THAT COVERS THE REQUEST, never the nearest. This engine asks
 * for the delivery raster (1672x944 against an uploaded plate, 1920x1080
 * against project settings), and rounding 1672 DOWN to a 1024px tier delivers a
 * frame smaller than the board it has to sit beside. Rounding up costs a few
 * cents; rounding down costs a re-shoot.
 */
const TIER_PX = { '1k': 1024, '2k': 2048, '4k': 4096 };

function imageSizeFor(width, height, model) {
    const allowed = (MODELS[model] || MODELS[DEFAULT_MODEL]).sizes;
    const longest = Math.max(Number(width) || 0, Number(height) || 0);
    const covering = allowed.find(t => TIER_PX[t] >= longest);
    return covering || allowed[allowed.length - 1];
}

/**
 * The ratios every Nano Banana endpoint here accepts, text and edit alike
 * (read from the fields MuAPI's endpoints report, tests/fixtures/
 * muapi-contract.json). A ratio a director chose from this set is sent as
 * chosen; anything else is derived from the width and height, as before.
 */
const ACCEPTED_RATIOS = Object.freeze(['1:1', '3:4', '4:3', '9:16', '16:9', '3:2', '2:3', '5:4', '4:5', '21:9']);

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

    /*
     * THE PICTURES DECIDE THE ENDPOINT.
     *
     * A reference is only honoured on the `-edit` endpoint, so attaching one and
     * posting to text-to-image is not a degraded request, it is a DIFFERENT
     * request that happens to succeed. Derived from what is attached rather than
     * declared by the caller, on the rule seedance.js already states for its own
     * workflows: a payload with pictures IS an edit.
     */
    const editing = images.length > 0;
    const slug = editing ? spec.editSlug : spec.slug;

    const body = {
        prompt,
        aspect_ratio: ACCEPTED_RATIOS.includes(p.aspect_ratio) ? p.aspect_ratio : aspectFor(p.width, p.height),
    };
    /*
     * Only where the endpoint has the field. `nano-banana` and the Lite model
     * accept no resolution at all, and a size that reaches nothing is worse than
     * no size -- it reads on the dialog as a choice that was applied.
     */
    if (spec.resolution) body.resolution = imageSizeFor(p.width, p.height, model);
    /*
     * `images_list`, which is what MuAPI calls it. This was `image_urls`, a name
     * no nano endpoint has -- so it validated, generated, billed, and ignored
     * every plate.
     */
    if (editing) body.images_list = images;

    /*
     * NO SEED. MuAPI accepts none on any nano endpoint, so sending one was a
     * reproducibility claim that was never true. Named here rather than dropped
     * silently, because `supportsSeed` is what a caller reads to decide whether
     * a re-roll can be pinned.
     */

    return { url: `${BASE_URL}/${slug}`, body, model, slug, editing };
}

function describeImageRequest(p) {
    const req = buildImageRequest(p);
    return { url: req.url, body: req.body };
}

/** Poll until the frame is finished, on seedance.js's contract. */
async function pollResult(requestId, apiKey, budgetMs, onPoll) {
    const url = `${BASE_URL}/predictions/${encodeURIComponent(requestId)}/result`;
    // Bounded by TIME rather than by a try count: the caller's budget is in
    // milliseconds, and a fixed number of tries cannot honour it.
    const deadline = Date.now() + (Number(budgetMs) || (POLL_MS * POLL_TRIES));
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_MS));
        let res;
        try {
            res = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
        } catch (err) {
            return { ok: false, status: 502, error: `muapi: polling failed — ${err.message}` };
        }
        const data = await res.json().catch(() => ({}));
        const status = String(data.status || '').toLowerCase();
        if (onPoll && !['completed', 'succeeded', 'failed', 'error', 'cancelled'].includes(status)) {
            try { onPoll(data, status); } catch (_) { /* never ends the poll */ }
        }
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
    return { ok: false, status: 504, error: `muapi: no image after ${Math.round((Number(budgetMs) || POLL_MS * POLL_TRIES) / 1000)}s — the request may still be running at MuAPI; the tool call is abandoned at 60s so a slower model needs a shorter prompt or a smaller tier` };
}

async function generate(capability, payload, opts) {
    if (capability !== 'image') {
        return { ok: false, status: 400, error: `muapi: ${capability} is not served here` };
    }
    const { apiKey } = muapiCredential();
    if (!apiKey) return { ok: false, status: 401, error: 'muapi: no API key configured' };

    const req = buildImageRequest(payload || {});
    if (!req.body.prompt) return { ok: false, status: 400, error: 'muapi: nothing to generate from' };
    /*
     * Same rule as the video adapter: MuAPI takes URLs, not bytes. Uploaded
     * here rather than in buildImageRequest so the builder stays pure and the
     * dry run keeps printing the request without opening a socket.
     */
    if (Array.isArray(req.body.images_list) && req.body.images_list.length) {
        const { hostImages } = require('./muapi-upload');
        const hosted = await hostImages(req.body.images_list, apiKey);
        if (!hosted.ok) return { ok: false, status: 422, error: `muapi: ${hosted.error}` };
        req.body.images_list = hosted.urls;
    }


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

    if (opts && typeof opts.onHandle === 'function') {
        try { opts.onHandle(requestId, { capability }); } catch (_) { /* never blocks a paid call */ }
    }
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || (POLL_MS * POLL_TRIES));
    const { emit, pollPercent } = require('../generation-progress');
    emit(opts, { phase: 'queued' });
    const out = await pollResult(requestId, apiKey, budget, (body, status) =>
        emit(opts, { percent: pollPercent(body), phase: status || 'generating' }));
    if (!out.ok && out.status === 504 && opts && opts.onTimeout) return opts.onTimeout(requestId, budget);
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
    /*
     * The model IS the rate, with no size suffix.
     *
     * This used to append `-2k`/`-4k` and price against those, and MuAPI serves
     * no such endpoints: resolution is a FIELD on one endpoint, not a product.
     * Those rate-book rows could never be hit, and the suffix condition compared
     * a lowercase tier against uppercase literals, so it never fired either --
     * two mistakes cancelling into roughly the right number for the wrong reason.
     */
    const asked = (result && result.provider_model) || p.model;
    const model = MODELS[asked] ? asked : DEFAULT_MODEL;
    return { unit: 'image', quantity: Math.max(1, Number(p.n) || 1), model };
}


/**
 * Finish a job from its handle.
 *
 * The other half of `onHandle`: the id was written down before polling, and
 * this is what turns it back into bytes when the call that started it was
 * abandoned. Same poll function the live path uses, so a collected result
 * cannot differ from one that arrived normally.
 */
async function collect(requestId, opts) {
    const { apiKey } = muapiCredential();
    if (!apiKey) return { ok: false, status: 401, error: 'muapi: no API key configured' };
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || (POLL_MS * POLL_TRIES));
    return pollResult(String(requestId), apiKey, budget);
}

const muapiImageAdapter = {
    supports: capability => (muapiImageAdapter.capabilities || []).includes(capability),
    meter: meterMuapi,
    id: 'muapi',
    kind: 'generator',
    label: 'MuAPI (Nano Banana images)',
    // One MuAPI account: this adapter runs on the key stored for Seedance when it
    // has none of its own, so Setup shows ONE key for the account.
    account: 'MuAPI',
    sharesKeyWith: 'seedance',
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
    /*
     * Asynchronous: the provider accepts the job and returns an id, and the
     * result is polled for. Declared so the handle machinery can find it -- a
     * tool call abandoned mid-poll loses a generation that was already billed
     * unless the id was written down first.
     */
    asyncGeneration: true,
    /** No cancel this adapter can perform: "stop waiting" leaves the job collectable (PGN-012). */
    cancel: 'stop_waiting',
    /** MuAPI's poll says queued/processing; a percentage only if it sends one. */
    reportsProgress: 'phase',

    sizeControl: 'snapped',
    sizeControlReason: 'MuAPI takes an aspect ratio and a 1K/2K/4K tier; the exact pixel '
        + 'dimensions are the tier\u2019s, not the ones asked for.',
    promptLimit: PROMPT_LIMIT,
    supportsNegativePrompt: 'folded',
    // MuAPI accepts no seed field on any nano endpoint -- see buildImageRequest.
    supportsSeed: false,
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
    sizes: ['1k', '2k', '4k'],
    buildImageRequest,
    describeImageRequest,
    generate,
    collect,

    connection: {
        instructions: 'MuAPI serves the Nano Banana family. One key covers images and Seedance video — if you already pasted it for Seedance, this adapter reuses it.',
        helpUrl: 'https://muapi.ai/',
    },
};

module.exports = { adapter: muapiImageAdapter, muapiImageAdapter, buildImageRequest,
                   describeImageRequest, MODELS, ACCEPTED_RATIOS, generate, collect, imageSizeFor, aspectFor };
