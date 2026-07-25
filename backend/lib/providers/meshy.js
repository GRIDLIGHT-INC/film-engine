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
const DEFAULT_TEXT_MODEL = 'meshy-5';

// Polling. Mesh generation is slow — minutes, not seconds — so the ceiling is
// generous, but bounded: a task that never terminates must fail rather than
// hold a request open forever.
const POLL_INTERVAL_MS = 5000;
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
    animate: { path: '/openapi/v1/animation', phase: null },
};

function supports(capability) {
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
async function pollTask(path, taskId, apiKey, onProgress) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let lastProgress = -1;

    while (Date.now() < deadline) {
        const res = await call('GET', `${path}/${taskId}`, apiKey);
        if (!res.ok) return res;

        const task = res.data || {};
        const progress = Number(task.progress) || 0;
        if (onProgress && progress !== lastProgress) {
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
async function run(payload, onProgress) {
    const apiKey = getCredential('meshy', 'MESHY_API_KEY');
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

    let task = await pollTask(request.path, taskId, apiKey, p => report(p, request.operation));
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

async function generate(capability, payload) {
    if (!supports(capability)) {
        return { ok: false, status: 400, error: `meshy: unsupported capability "${capability}"` };
    }
    return run(payload);
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
    const result = await run(payload, onProgress);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, finalData: result.data, meta: result.meta, provider_job_id: result.provider_job_id };
}

async function health() {
    const apiKey = getCredential('meshy', 'MESHY_API_KEY');
    if (!apiKey) return { ok: false, error: 'no API key' };
    const started = Date.now();
    // Listing tasks is the cheapest authenticated read; a 401 tells us the key
    // is wrong, which is the failure worth surfacing in Provider Settings.
    const res = await call('GET', '/openapi/v2/text-to-3d?page_size=1', apiKey);
    return res.ok
        ? { ok: true, latencyMs: Date.now() - started }
        : { ok: false, error: res.error };
}

const adapter = {
    id: 'meshy',
    kind: 'generator',
    label: 'Meshy (3D)',
    requiresKey: true,
    capabilities: ['model3d'],

    connection: {
        instructions: 'Meshy uses API keys, not OAuth. Create a key in your Meshy account settings and paste it here.',
        helpUrl: 'https://docs.meshy.ai/en/api/quick-start',
    },

    supports,
    generate,
    generateStream,
    health,

    // Exported for tests.
    _internal: { buildRequest, pickModelUrl, pollTask, OPERATIONS, MODEL_FORMAT_PREFERENCE },
};

// Named `adapter` because providers/index.js autoloads on `mod.adapter` —
// exporting the object directly would register nothing, silently.
module.exports = { adapter, buildRequest, pickModelUrl };
