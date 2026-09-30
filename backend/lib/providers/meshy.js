/**
 * Meshy 3D provider adapter.
 *
 * Capability:
 *   model3d — text-to-mesh, image-to-mesh, rig, and animate, for any subject
 *             the app models: characters, props, and locations.
 *
 * Credentials are read server-side through providers/credentials.js
 * (MESHY_API_KEY env, or a key saved in Provider Settings).
 * Base URL is overridable via MESHY_BASE_URL for proxies and tests.
 *
 * TWO THINGS ABOUT MESHY THAT SHAPE THIS ADAPTER
 *
 * 1. Text-to-3D is two-phase. A `preview` task produces untextured geometry;
 *    a separate `refine` task textures it, and refine needs the preview's id.
 *    Film Engine's job model is one call per job, so `generate()` chains both
 *    and reports completion only after refine finishes. Callers that want raw
 *    geometry can pass `{ refine: false }` and get the preview mesh.
 *
 * 2. Everything is asynchronous. Tasks return an id immediately and are polled
 *    to completion. This adapter owns that polling so routes stay synchronous
 *    in shape, matching how the Gridlight adapter behaves.
 */

const { getCredential } = require('./credentials');

const DEFAULT_BASE_URL = 'https://api.meshy.ai';

// Meshy's own naming. Every model here takes 1:1, 16:9 and 9:16; the
// nano-banana family adds 4:3 and 3:4, gpt-image-2 adds 3:2 and 2:3. None
// offers a scope ratio, so a 2.39:1 production gets the widest available and is
// cropped in the NLE rather than being silently delivered square.
//
// gpt-image-2 was listed as 1:1/3:2/2:3 only, which snapped every 16:9 project
// to SQUARE on that model — a widescreen film boarded in a format it does not
// ship in, with nothing said.
const IMAGE_MODELS = ['nano-banana-pro', 'nano-banana-2', 'nano-banana', 'gpt-image-2'];
const DEFAULT_IMAGE_MODEL = process.env.MESHY_IMAGE_MODEL || 'nano-banana-pro';
// image-to-image accepts 1-5; a sixth is a validation failure, not a trim.
const MAX_REFERENCE_IMAGES = 5;
const IMAGE_RATIOS = {
    'gpt-image-2': ['1:1', '16:9', '9:16', '3:2', '2:3'],
    _default: ['1:1', '16:9', '9:16', '4:3', '3:4'],
};

/** Nearest supported ratio by aspect — never silently square. */
function snapMeshyRatio(requested, model) {
    const allowed = IMAGE_RATIOS[model] || IMAGE_RATIOS._default;
    const parse = v => {
        const m = String(v || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/);
        return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
    };
    const want = parse(requested);
    if (want === null) return allowed[0];
    let best = allowed[0], gap = Infinity;
    for (const r of allowed) {
        const d = Math.abs(parse(r) - want);
        if (d < gap) { gap = d; best = r; }
    }
    return best;
}

/**
 * Our image payload -> Meshy's text-to-image body.
 *
 * Two Meshy features map straight onto reference plates: `pose_mode: 't-pose'`
 * is exactly what a character turnaround wants, and `generate_multi_view`
 * produces several angles in one image — the thing the character refsheet route
 * currently spends three separate generations on.
 */
/**
 * Carry a negative into a prompt for a provider with no negative field.
 *
 * Same shape OpenAI's adapter uses. It is not as strong as a native negative
 * and it is infinitely stronger than discarding it, which is what happened
 * here until now.
 */
function foldNegative(prompt, negative, ceiling) {
    const n = String(negative || '').trim();
    if (!n) return prompt;
    const joined = `${prompt}\n\nAvoid: ${n}`;
    // The fold happens AFTER the prompt was budgeted, so a prompt built to
    // exactly the ceiling plus "Avoid: ..." overruns it. The negative is the
    // part that yields: it is a hint rather than the description of the shot.
    if (!ceiling || joined.length <= ceiling) return joined;
    const room = ceiling - prompt.length - 9;
    return room > 12 ? `${prompt}\n\nAvoid: ${n.slice(0, room)}` : prompt;
}

function buildImageRequest(payload) {
    /*
     * Meshy's image endpoint takes a prompt and a model. It documents no
     * negative field, so a negative_prompt handed to this adapter used to be
     * DROPPED — silently, on the provider this production actually runs. Every
     * shot-specific negative ever written was dead code here, including the
     * ones added to stop expensive failures: recompose's "original background,
     * unchanged background" and the anchor's "different location, rebuilt set".
     *
     * Folded into the positive rather than invented as a field, because we have
     * no endpoint evidence that Meshy accepts one. This is what OpenAI's
     * adapter already does for the same reason. If Meshy ever documents a
     * native negative, send it there and delete this.
     */

    const p = payload || {};
    const model = IMAGE_MODELS.includes(p.model) ? p.model : DEFAULT_IMAGE_MODEL;
    const body = {
        ai_model: model,
        prompt: foldNegative(p.prompt || p.promptText || '', p.negative_prompt, adapter.promptLimit),
    };

    const requested = (Number(p.width) > 0 && Number(p.height) > 0)
        ? `${p.width}:${p.height}`
        : (p.aspect_ratio || p.ratio);

    // 1-5 references, as publicly reachable URLs or base64 data URIs. Present
    // means image-to-image; absent means text-to-image. Selecting the endpoint
    // from the payload keeps one entry point for callers.
    const refs = (Array.isArray(p.reference_images) ? p.reference_images : [])
        .map(r => (typeof r === 'string' ? r : (r && (r.uri || r.url || r.image_url))))
        .filter(Boolean)
        .slice(0, MAX_REFERENCE_IMAGES);
    if (refs.length) body.reference_image_urls = refs;

    // aspect_ratio is rejected alongside multi-view, so only one is ever sent.
    if (p.generate_multi_view || p.multi_view) body.generate_multi_view = true;
    else body.aspect_ratio = snapMeshyRatio(requested, model);

    if (p.pose_mode === 't-pose' || p.pose_mode === 'a-pose') body.pose_mode = p.pose_mode;

    return body;
}
const DEFAULT_TEXT_MODEL = 'meshy-5';

// Polling. Mesh generation is slow — minutes, not seconds — so the ceiling is
// generous, but bounded: a task that never terminates must fail rather than
// hold a request open forever.
const POLL_INTERVAL_MS = Number(process.env.MESHY_POLL_INTERVAL_MS || 5000);
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60000;

// Meshy's terminal task states.
const DONE = 'SUCCEEDED';
const FAILED = new Set(['FAILED', 'CANCELED', 'EXPIRED']);

// What each operation maps to on Meshy's side.
const OPERATIONS = {
    text_to_mesh: { path: '/openapi/v2/text-to-3d', phase: 'preview' },
    image_to_mesh: { path: '/openapi/v1/image-to-3d', phase: null },
    rig: { path: '/openapi/v1/rigging', phase: null },
    // Meshy is not 3D-only: it exposes 2D generation too, and fronts the
    // nano-banana family and gpt-image-2 through its own API. This adapter
    // declared `model3d` alone, so a funded Meshy account sat unusable while
    // the image stage was blocked on two exhausted providers.
    text_to_image: { path: '/openapi/v1/text-to-image', phase: null },
    // Reference-conditioned 2D generation: 1-5 images as URLs or base64 data
    // URIs. Unlike Runway's { uri, tag } form these are a plain array with no
    // names, so the prompt must still DESCRIBE the subject — the pictures
    // condition it rather than being addressable from the text.
    image_to_image: { path: '/openapi/v1/image-to-image', phase: null },
    animate: { path: '/openapi/v1/animation', phase: null },
};

function supports(capability) {
    if (capability === 'image') return true;
    return capability === 'model3d';
}

function baseUrl() {
    return (process.env.MESHY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function missingKey() {
    return {
        ok: false,
        status: 401,
        error: 'meshy: missing API key. Set MESHY_API_KEY or save a credential in Provider Settings.',
    };
}

function normalizeError(status, body) {
    if (body && typeof body === 'object') {
        if (body.message) return `meshy ${status}: ${body.message}`;
        if (body.error) return `meshy ${status}: ${body.error.message || body.error}`;
    }
    return `meshy ${status}: ${String(body || 'request failed')}`;
}

async function parseBody(response) {
    const text = await response.text();
    try { return JSON.parse(text); } catch (_) { return text; }
}

/** One authenticated request with a timeout. */
async function call(method, path, apiKey, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl()}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal,
        });
        const parsed = await parseBody(response);
        if (!response.ok) {
            return { ok: false, status: response.status, error: normalizeError(response.status, parsed) };
        }
        return { ok: true, status: response.status, data: parsed };
    } catch (err) {
        if (err.name === 'AbortError') {
            return { ok: false, status: 504, error: `meshy: request timed out after ${REQUEST_TIMEOUT_MS}ms` };
        }
        return { ok: false, status: 500, error: `meshy: ${err.message}` };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Poll a task to a terminal state.
 *
 * onProgress is called with Meshy's 0-100 progress so SSE callers can forward
 * it; without this a mesh generation looks frozen for several minutes.
 */
async function pollTask(path, taskId, apiKey, onProgress, budgetMs) {
    // The budget is the CALLER's: an HTTP request can wait fifteen minutes for
    // a mesh, a tool call through the host has under sixty seconds.
    const deadline = Date.now() + (Number(budgetMs) || POLL_TIMEOUT_MS);
    let lastProgress = -1;

    while (Date.now() < deadline) {
        const res = await call('GET', `${path}/${taskId}`, apiKey);
        if (!res.ok) return res;

        const task = res.data || {};
        // A poll with no progress field is "not said", not "0%": reading it
        // as 0 overwrote a real 50% with nothing on the final poll.
        const said = task.progress !== undefined && task.progress !== null && Number.isFinite(Number(task.progress));
        const progress = said ? Number(task.progress) : lastProgress;
        if (onProgress && said && progress !== lastProgress) {
            lastProgress = progress;
            try { onProgress(progress, task.status); } catch (_) { /* callback must not kill the poll */ }
        }

        if (task.status === DONE) return { ok: true, status: 200, data: task };
        if (FAILED.has(task.status)) {
            return {
                ok: false,
                status: 502,
                error: `meshy: task ${task.status.toLowerCase()}${task.task_error && task.task_error.message ? ' — ' + task.task_error.message : ''}`,
            };
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    return { ok: false, status: 504, error: `meshy: task did not finish within ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes` };
}

/**
 * Pick the model file to persist.
 *
 * Film Engine stores one mesh per asset and serves .glb/.gltf/.fbx/.obj/.usdz,
 * so prefer glb — it is single-file and self-contained, which matters because
 * a .gltf with external textures would arrive as a broken reference.
 */
const MODEL_FORMAT_PREFERENCE = ['glb', 'gltf', 'fbx', 'obj', 'usdz'];

function pickModelUrl(task) {
    const urls = (task && task.model_urls) || {};
    for (const fmt of MODEL_FORMAT_PREFERENCE) {
        if (urls[fmt]) return { url: urls[fmt], format: fmt };
    }
    // Rigging and animation return their result under different keys.
    if (task && task.result && task.result.model_url) return { url: task.result.model_url, format: 'glb' };
    if (task && task.model_url) return { url: task.model_url, format: 'glb' };
    return null;
}

/**
 * Map a canonical Film Engine 3D payload onto a Meshy request.
 *
 * The canonical payload is the one lib/threed-prompt.js already builds for
 * Gridlight, so subjects (character / prop / location) need no special casing
 * here — a location is just another prompt describing a thing to model.
 */
function buildRequest(payload) {
    const p = payload || {};
    const operation = p.operation || (p.image_url || p.image ? 'image_to_mesh' : 'text_to_mesh');
    const op = OPERATIONS[operation];
    if (!op) return { error: `meshy: unsupported operation "${operation}"` };

    if (operation === 'text_to_mesh') {
        const prompt = String(p.prompt || '').trim();
        if (!prompt) return { error: 'meshy: a prompt is required for text-to-mesh' };
        return {
            operation,
            path: op.path,
            body: {
                mode: 'preview',
                prompt: prompt.slice(0, 600),
                art_style: p.art_style || p.style || 'realistic',
                ai_model: p.model || DEFAULT_TEXT_MODEL,
                should_remesh: p.should_remesh !== false,
                ...(p.negative_prompt ? { negative_prompt: String(p.negative_prompt).slice(0, 600) } : {}),
                ...(Number.isFinite(Number(p.seed)) && Number(p.seed) >= 0 ? { seed: Number(p.seed) } : {}),
            },
        };
    }

    if (operation === 'image_to_mesh') {
        const image = p.image_url || p.image;
        if (!image) return { error: 'meshy: an image URL or data URI is required for image-to-mesh' };
        return {
            operation,
            path: op.path,
            body: {
                image_url: image,
                ai_model: p.model || DEFAULT_TEXT_MODEL,
                should_remesh: p.should_remesh !== false,
                should_texture: p.should_texture !== false,
                ...(p.texture_prompt ? { texture_prompt: String(p.texture_prompt).slice(0, 600) } : {}),
            },
        };
    }

    if (operation === 'rig') {
        if (!p.input_task_id && !p.model_url) return { error: 'meshy: rig needs input_task_id or model_url' };
        return {
            operation,
            path: op.path,
            body: {
                ...(p.input_task_id ? { input_task_id: p.input_task_id } : { model_url: p.model_url }),
                ...(p.height_meters ? { height_meters: Number(p.height_meters) } : {}),
            },
        };
    }

    // animate
    if (!p.input_task_id && !p.model_url) return { error: 'meshy: animate needs a rigged input_task_id or model_url' };
    return {
        operation,
        path: op.path,
        body: {
            ...(p.input_task_id ? { input_task_id: p.input_task_id } : { model_url: p.model_url }),
            ...(p.animation_id ? { animation_id: p.animation_id } : {}),
            ...(p.animation_prompt ? { prompt: String(p.animation_prompt).slice(0, 400) } : {}),
        },
    };
}

/**
 * Submit, poll, and (for text-to-mesh) refine.
 * @param {function} [onProgress] (percent, phase) — forwarded to SSE callers.
 */
async function run(payload, onProgress, opts, capability) {
    // getCredential returns { apiKey, meta } — the image path destructures it
    // and these two did not, so the mesh routes sent `Bearer [object Object]`
    // and Meshy answered 401 Invalid API key with a perfectly good key saved.
    const { apiKey } = getCredential('meshy', 'MESHY_API_KEY');
    if (!apiKey) return missingKey();

    const request = buildRequest(payload);
    if (request.error) return { ok: false, status: 400, error: request.error };

    const submitted = await call('POST', request.path, apiKey, request.body);
    if (!submitted.ok) return submitted;

    const taskId = (submitted.data && (submitted.data.result || submitted.data.id)) || submitted.data;
    if (!taskId || typeof taskId !== 'string') {
        return { ok: false, status: 502, error: 'meshy: submit returned no task id' };
    }

    const report = (pct, phase) => onProgress && onProgress(pct, phase);

    if (opts && typeof opts.onHandle === 'function') {
        try { opts.onHandle(taskId, { operation: request.operation, path: request.path }); } catch (_) { /* never blocks a paid call */ }
    }
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    let task = await pollTask(request.path, taskId, apiKey, p => report(p, request.operation), budget);
    if (!task.ok && task.status === 504 && opts && opts.onTimeout) return opts.onTimeout(taskId, budget);
    if (!task.ok) return task;

    let refineTaskId = null;

    // Text-to-3D phase two: texture the preview mesh. Skippable for callers who
    // only want geometry (a blocking prop, a collision proxy).
    if (request.operation === 'text_to_mesh' && (payload || {}).refine !== false) {
        const refine = await call('POST', request.path, apiKey, {
            mode: 'refine',
            preview_task_id: taskId,
            ...(payload.texture_prompt ? { texture_prompt: String(payload.texture_prompt).slice(0, 600) } : {}),
        });
        // A refine failure is not fatal — the untextured preview is still a
        // usable mesh, and losing it because texturing failed would be worse
        // than returning it with a warning.
        if (refine.ok) {
            refineTaskId = (refine.data && (refine.data.result || refine.data.id)) || null;
            if (refineTaskId) {
                const refined = await pollTask(request.path, refineTaskId, apiKey, p => report(p, 'refine'));
                if (refined.ok) task = refined;
            }
        }
    }

    const model = pickModelUrl(task.data);
    if (!model) return { ok: false, status: 502, error: 'meshy: task succeeded but returned no model URL' };

    return {
        ok: true,
        status: 200,
        // Shaped like the Gridlight 3D response so routes/threed.js persists it
        // through the same registerModel() path with no branching.
        data: {
            model_url: model.url,
            format: model.format,
            thumbnail_url: (task.data && task.data.thumbnail_url) || '',
        },
        provider: 'meshy',
        provider_model: request.body.ai_model || DEFAULT_TEXT_MODEL,
        provider_job_id: refineTaskId || taskId,
        meta: {
            operation: request.operation,
            preview_task_id: taskId,
            refine_task_id: refineTaskId,
            textured: Boolean(refineTaskId),
            art_style: request.body.art_style || '',
            format: model.format,
        },
    };
}

/**
 * Generate a 2D image and poll it to completion.
 *
 * Same async shape as the 3D operations — POST returns a task id, the adapter
 * owns the polling so routes still see a finished asset. Kept beside them
 * rather than in a second module for that reason.
 */
/**
 * Meshy's own credit balance.
 *
 * The whole spend report is computed from a rate book — our reading of a
 * published price list. That is an assumption, and an un-checkable number
 * decays into a confident lie. Meshy publishes the balance, so a generation can
 * report what it ACTUALLY cost rather than what we believe it costs.
 *
 * Never throws and never blocks a generation: this is a receipt, and failing to
 * read a receipt must not undo the purchase.
 */
async function readBalance(apiKey) {
    try {
        const res = await fetch(`${baseUrl()}/openapi/v1/balance`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const body = await res.json();
        const n = Number(body && body.balance);
        return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
}

async function runImage(payload) {
    const { apiKey } = getCredential('meshy');
    if (!apiKey) return missingKey();

    const body = buildImageRequest(payload);
    if (!body.prompt) return { ok: false, status: 400, error: 'meshy: prompt is required' };

    const path = body.reference_image_urls
        ? OPERATIONS.image_to_image.path
        : OPERATIONS.text_to_image.path;

    // Read before, so the charge can be measured rather than assumed. A null
    // here simply means the receipt is unavailable; the generation proceeds.
    const openingBalance = await readBalance(apiKey);

    const created = await call('POST', path, apiKey, body);
    if (!created.ok) return created;

    const taskId = (created.data && (created.data.result || created.data.id)) || null;
    if (!taskId) return { ok: false, status: 502, error: 'meshy: no task id returned for text-to-image' };

    const done = await pollTask(path, taskId, apiKey);
    if (!done.ok) return done;

    const task = done.data || {};
    // Meshy reports the finished image under image_url(s); accept either so a
    // response-shape tweak degrades to "no image" rather than a crash.
    const url = task.image_url
        || (Array.isArray(task.image_urls) && task.image_urls[0])
        || (task.result && task.result.image_url)
        || null;
    if (!url) return { ok: false, status: 502, error: 'meshy: task succeeded but returned no image URL' };

    /*
     * What it really cost, read from Meshy rather than inferred.
     *
     * `provider_model` below is what we ASKED for — the response does not echo
     * the model — so on its own it proves the request, not the charge. The
     * balance delta is the one thing that distinguishes "we sent nano-banana"
     * from "we were billed three credits", and those are different claims.
     *
     * Only trusted when it is plausible: a concurrent generation on the same
     * account would land inside this window and inflate the delta, so an
     * implausible figure is discarded rather than recorded as fact.
     */
    let charged = null;
    let closing = null;
    if (openingBalance !== null) {
        closing = await readBalance(apiKey);
        if (closing !== null) {
            const delta = openingBalance - closing;
            if (delta > 0 && delta <= 64) charged = delta;
        }
    }

    return {
        ok: true,
        status: 200,
        data: { image_url: url, raw: task },
        provider: 'meshy',
        provider_model: body.ai_model,
        provider_job_id: taskId,
        native_charged: charged,
        balance_after: closing,
    };
}


async function generate(capability, payload, opts) {
    if (!supports(capability)) {
        return { ok: false, status: 400, error: `meshy: unsupported capability "${capability}"` };
    }
    if (capability === 'image') return runImage(payload);
    const { emit } = require('../generation-progress');
    const onProgress = (pct, phase) => emit(opts, { percent: pct, phase: String(phase || 'generating').toLowerCase().replace(/_/g, ' ') });
    return run(payload, onProgress, opts, capability);
}

/**
 * Streaming variant. Meshy has no push API, so progress comes from the poll
 * loop rather than from the provider — the events are real, just client-side.
 */
async function generateStream(capability, payload, res, callbacks = {}) {
    if (!supports(capability)) {
        return { ok: false, error: `meshy: unsupported capability "${capability}"` };
    }
    const onProgress = (percent, phase) => {
        if (typeof callbacks.onProgress === 'function') {
            callbacks.onProgress({ percent, phase, provider: 'meshy' });
        }
    };
    const result = await run(payload, onProgress, opts, 'model3d');
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, finalData: result.data, meta: result.meta, provider_job_id: result.provider_job_id };
}

async function health() {
    // getCredential returns { apiKey, meta } — the image path destructures it
    // and these two did not, so the mesh routes sent `Bearer [object Object]`
    // and Meshy answered 401 Invalid API key with a perfectly good key saved.
    const { apiKey } = getCredential('meshy', 'MESHY_API_KEY');
    if (!apiKey) return { ok: false, error: 'no API key' };
    const started = Date.now();
    // Listing tasks is the cheapest authenticated read; a 401 tells us the key
    // is wrong, which is the failure worth surfacing in Provider Settings.
    const res = await call('GET', '/openapi/v2/text-to-3d?page_size=1', apiKey);
    return res.ok
        ? { ok: true, latencyMs: Date.now() - started }
        : { ok: false, error: res.error };
}

/**
 * Meshy charges a flat number of credits per call, decided entirely by which
 * model ran — nano-banana is 3, nano-banana-pro is 9, a mesh is 20. Nothing
 * about the request changes it, so the metered unit is the call itself and the
 * model is what the rate book prices.
 */
function meterMeshy(capability, payload, result) {
    const p = payload || {};
    if (capability === 'image') {
        const base = (result && result.provider_model)
            || (IMAGE_MODELS.includes(p.model) ? p.model : DEFAULT_IMAGE_MODEL);
        /*
         * Which ENDPOINT ran, because for gpt-image-2 they are different
         * prices: 9 credits text-to-image, 12 image-to-image. Board generation
         * always attaches references, so the real path is the dearer one and
         * pricing it at 9 under-reports every frame by a quarter.
         */
        const refs = (p.reference_images || []).length || (p.init_image ? 1 : 0);
        const model = (base === 'gpt-image-2' && refs) ? 'gpt-image-2-i2i' : base;
        /*
         * A MEASURED charge beats the rate book.
         *
         * The book is our reading of a published price list, and it was wrong
         * about nano-banana-2 by a factor of two for days. When Meshy's own
         * balance says what a call cost, that is the number — and a
         * disagreement is worth surfacing rather than smoothing over, because
         * it means the book has drifted.
         */
        const measured = result && Number(result.native_charged);
        if (Number.isFinite(measured) && measured > 0) {
            return { unit: 'call', quantity: 1, model, native_charged: measured, provider_confirmed: true };
        }
        return { unit: 'call', quantity: 1, model };
    }
    if (capability === 'model3d') {
        const model = (result && result.provider_model) || p.model || DEFAULT_TEXT_MODEL;
        // Remesh, rigging and animation are free; only generation is charged.
        const op = String(p.operation || p.mode || 'generate');
        if (op === 'rig' || op === 'animate' || op === 'remesh') {
            return { unit: 'call', quantity: 1, model, free_operation: true };
        }
        return { unit: 'call', quantity: 1, model };
    }
    return null;
}


/**
 * Finish a job from its handle.
 *
 * The other half of `onHandle`: the id was written down before polling, and
 * this is what turns it back into bytes when the call that started it was
 * abandoned. Same poll function the live path uses, so a collected result
 * cannot differ from one that arrived normally.
 */
async function collect(taskId, opts) {
    const { apiKey } = getCredential('meshy', 'MESHY_API_KEY');
    if (!apiKey) return missingKey();
    /*
     * The PATH is operation-specific and cannot be derived from the id, so it
     * travels in the job's meta -- recorded by `onHandle` at submit time. A
     * collect with no path cannot know which endpoint to ask.
     */
    const opPath = (opts && opts.path) || (opts && opts.meta && opts.meta.path);
    if (!opPath) return { ok: false, status: 400, error: 'meshy: the job did not record which endpoint it was submitted to' };
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    return pollTask(opPath, String(taskId), apiKey, null, budget);
}

const adapter = {
    meter: meterMeshy,
    /*
     * The image models this provider actually offers, declared so a pinned
     * model can be CHECKED. Without it a typo is stored, sent, and silently
     * falls back to Meshy's own default — nano-banana-pro at 9 credits — while
     * the director believes they pinned the 3-credit one.
     */
    models: Object.freeze(Object.fromEntries(IMAGE_MODELS.map(id => [id, {}]))),

    /*
     * Per capability. The flat list above is Meshy's IMAGE models, and the 3D
     * dialog was being offered them -- so "which model should this mesh use"
     * answered with nano-banana-pro. The mesh models are Meshy's own grades.
     */
    modelsByCapability: Object.freeze({
        image: Object.freeze(Object.fromEntries(IMAGE_MODELS.map(id => [id, {}]))),
        model3d: Object.freeze({
            'meshy-5': { label: 'Meshy 5 (latest)' },
            'meshy-4': { label: 'Meshy 4' },
        }),
    }),
    /*
     * Asynchronous: the provider accepts the job and returns an id, and the
     * result is polled for. Declared so the handle machinery can find it -- a
     * tool call abandoned mid-poll loses a generation that was already billed
     * unless the id was written down first.
     */
    asyncGeneration: true,
    /** No cancel this adapter can perform: "stop waiting" leaves the job collectable (PGN-012). */
    cancel: 'stop_waiting',
    /** Meshy's task poll carries 0..100 progress for a mesh. */
    reportsProgress: 'percent',
    id: 'meshy',
    kind: 'generator',
    label: 'Meshy (3D + image)',
    requiresKey: true,

    /*
     * Meshy's text-to-image documents no prompt limit, and it routes to
     * nano-banana and gpt-image-2 underneath — models that take long prompts.
     * 4000 was our own guess matched to those, with a note to raise it if a
     * longer prompt was ever seen to work.
     *
     * It was seen. Every shot in a real production sat against that ceiling —
     * nine of nine between 3632 and 3992 — and eight of them ended MID-CLAUSE,
     * with a parked car's paint description as the last thing the model read
     * and the closing quality tags cut entirely. Untrimmed those prompts want
     * 4311 to 6955 characters.
     *
     * WHAT IS ACTUALLY MEASURED, and what is not. One request of **11,671
     * characters** was accepted by Meshy and returned an image (Wingfall 2B,
     * v22, 2026-08-23). That is the evidence, and it establishes a FLOOR.
     *
     * 16000 is NOT a verified number and no documented Meshy limit exists to
     * verify it against. It is headroom chosen above what any real shot asks
     * for, so the trimmer stops binding on ordinary work. The builder already
     * emits 12,934 on one shot — above the only length ever proven to work — so
     * lengths between 11,671 and 16,000 are being sent on the strength of a
     * reasonable expectation rather than an observation. Saying so is the
     * point: a comment claiming verification for a figure nobody verified is
     * how the next person inherits a guess believing it is a measurement.
     *
     * If a long prompt is ever refused, that refusal is visible and catchable.
     * The failure this replaces was silent.
     */
    // The largest image this provider will actually produce. Asking for more
    // is a rejection that costs a generation, so the request is clamped here
    // and the clamp is reported rather than silently applied.
    // Meshy publishes no image size limit and proxies models that top out around
    // two megapixels. Held there rather than assumed unlimited: over-asking
    // produces a rejection at the provider, which is worse than a smaller
    // picture generated here where the clamp can be reported.
    // How a requested width/height is treated. Declared, never inferred \u2014 the
    // same rule promptLimit and maxReferenceImages follow, and for the same reason:
    // a size that reaches nothing produced a confident 2048x1152 arriving as 1376x768.
    sizeControl: 'ratio-only',
    sizeControlReason: "Meshy's text-to-image documents ai_model, prompt, aspect_ratio, "
        + 'generate_multi_view, pose_mode and remove_background \u2014 and no width, height, size or '
        + 'quality. A requested size can only become a ratio, and Meshy chooses the pixels: a 16:9 ask '
        + 'comes back about 1376x768. https://docs.meshy.ai/en/api/text-to-image',
    /*
     * MEASURED, not assumed — and the previous value was a guess that was wrong.
     *
     * This said 2048*2048 with the note "no published limit, held at what the
     * models it proxies actually reach". The models do reach 2K; Meshy does
     * not expose it. Every image it has actually returned here is 1376x768 at
     * 16:9 or 1024x1024 at 1:1 — about one megapixel — for nano-banana-2 AND
     * nano-banana-pro alike.
     *
     * There is no way to ask for more: the API documents no width, height,
     * size or quality field, and the changelog through Aug 2026 shows every
     * resolution change was an ASPECT RATIO addition, never a size control.
     * So this is a ceiling of the service rather than of the models behind it.
     *
     * Over-claiming here made the comparison table promise 2K from a provider
     * that returns 1MP, which is the same over-promise that let a "2048x1152"
     * plate arrive as 1376x768.
     */
    maxImagePixels: 1376 * 768,
    promptLimit: 16000,
    // Declared, not assumed. The negative is FOLDED into the positive because
    // Meshy documents no negative field; the seed is not carried at all, so a
    // "same seed" comparison on this provider is not controlled and the render
    // ledger's seed means nothing here.
    supportsNegativePrompt: 'folded',
    supportsSeed: false,
    capabilities: ['model3d', 'image'],
    // image-to-image takes 1-5 reference images as a plain array, so pictures
    // DO condition the result — but they carry no names, so the prompt must
    // keep describing the subject. Emitting "@maya" here replaced 240
    // characters of appearance with a token meaning nothing.
    supportsReferenceImages: true,
    supportsReferenceTags: false,
    /*
     * What attaching a reference MEANS here.
     *
     * 'condition' — the reference informs a newly generated image.
     * 'edit'      — the reference IS the image, and the result is a modified
     *               copy of it. An edit cannot move the camera.
     *
     * Attaching any reference routes to /openapi/v1/image-to-image, which MODIFIES
     * the picture it is given. Three anchored views of one cul-de-sac came back
     * as three regrades of the same photograph, whatever the prompt said.
     *
     * The plate code assumed 'condition' for every provider, which is correct
     * on one adapter and structurally incapable on the others.
     */
    referenceMode: 'edit',
    maxReferenceImages: MAX_REFERENCE_IMAGES,

    connection: {
        instructions: 'Meshy uses API keys, not OAuth. Create a key in your Meshy account settings and paste it here.',
        helpUrl: 'https://docs.meshy.ai/en/api/quick-start',
    },

    supports,
    generate,
    collect,
    generateStream,
    health,

    // Exported for tests.
    _internal: { buildRequest, buildImageRequest, runImage, snapMeshyRatio, pickModelUrl, pollTask, OPERATIONS, MODEL_FORMAT_PREFERENCE, IMAGE_MODELS },
};

// Named `adapter` because providers/index.js autoloads on `mod.adapter` —
// exporting the object directly would register nothing, silently.
module.exports = { adapter, buildRequest, buildImageRequest, snapMeshyRatio, pickModelUrl, IMAGE_MODELS, IMAGE_RATIOS };
