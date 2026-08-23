/**
 * Runway provider adapter (generative video + image).
 *
 * Replaces the previous MCP aggregator as the generative image/video provider.
 * Runway is a direct REST API rather than an MCP tool catalog, which is the
 * whole reason for the swap: a documented request contract and real error
 * bodies instead of tool-name discovery and heuristic argument shapes.
 *
 * The important difference from every other generator here is that Runway is
 * ASYNCHRONOUS. POST returns a task id immediately; the media does not exist
 * until GET /v1/tasks/:id reports SUCCEEDED. Adapters are expected to hand back
 * a finished asset, so generate() submits and then polls to completion — the
 * async shape is contained here rather than pushed into every route.
 *
 * Docs: https://docs.dev.runwayml.com (contract captured 2026-07-29)
 *   POST /v1/image_to_video   { model, promptImage, promptText, ratio, duration, seed }
 *   POST /v1/text_to_video    { model, promptText, ratio, duration, seed }
 *   POST /v1/text_to_image    { model, promptText, ratio, referenceImages[] }
 *   GET  /v1/tasks/:id        -> { id, status, output: [url] }
 *
 * Env: RUNWAY_API_KEY (or Runway's own RUNWAYML_API_SECRET), RUNWAY_BASE_URL,
 *      RUNWAY_VIDEO_MODEL, RUNWAY_IMAGE_MODEL.
 */

const { getCredential } = require('./credentials');

const DEFAULT_BASE_URL = 'https://api.dev.runwayml.com/v1';
// Runway pins behaviour to a dated version header; sending it is not optional.
const RUNWAY_VERSION = '2024-11-06';

const DEFAULT_VIDEO_MODEL = process.env.RUNWAY_VIDEO_MODEL || 'gen4.5';
const DEFAULT_IMAGE_MODEL = process.env.RUNWAY_IMAGE_MODEL || 'gen4_image';

/**
 * Model names this adapter will forward.
 *
 * capability-payloads builds ONE payload per capability for every provider, and
 * its image default is `sdxl` -- a Gridlight-era name that means nothing here.
 * Forwarding it unchecked made Runway reject every storyboard with
 * "model: Invalid", because `p.model || DEFAULT` lets a foreign name win over
 * the adapter's own default.
 *
 * An adapter should never hand its API a model it does not recognise. Anything
 * outside these sets falls back to the configured default instead, so a generic
 * payload works and an explicit Runway model is still honoured.
 */
const KNOWN_VIDEO_MODELS = new Set(['gen4.5', 'gen4_turbo', 'gen4', 'gen3a_turbo', 'veo3', 'act_two']);
const KNOWN_IMAGE_MODELS = new Set(['gen4_image', 'gen4_image_turbo', 'gemini_2.5_flash']);

function pickModel(requested, known, fallback) {
    const name = String(requested || '').trim();
    return known.has(name) ? name : fallback;
}

// Ratios each generation mode documents. Sending anything else is a 400, so the
// builder snaps to the nearest documented ratio rather than forwarding whatever
// width/height the scene card happened to carry.
/**
 * Accepted text_to_image ratios.
 *
 * `ratio` is REQUIRED on text_to_image. This adapter used to omit it whenever
 * the caller passed anything other than an explicit width/height pair, so every
 * image generation failed validation before reaching a model -- invisible to
 * the mock-server tests, because a mock cannot know the real API demands a
 * field. The list below is the one Runway's validator returns.
 */
const IMAGE_RATIOS = [
    '1024:1024', '1080:1080', '1168:880', '1360:768', '1440:1080', '1080:1440',
    '1808:768', '1920:1080', '1080:1920', '2112:912', '1280:720', '720:1280',
    '720:720', '960:720', '720:960', '1680:720',
];
const DEFAULT_IMAGE_RATIO = '1920:1080';

/** "1920:1080" and "16:9" both mean 1.777…; callers send either. */
function aspectOf(value) {
    const m = String(value || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i);
    if (!m) return null;
    const w = Number(m[1]), h = Number(m[2]);
    return h > 0 ? w / h : null;
}

/** Nearest accepted ratio by aspect, so a 16:9 request is not simply dropped. */
function snapImageRatio(requested) {
    if (IMAGE_RATIOS.includes(requested)) return requested;
    const want = aspectOf(requested);
    if (want === null) return DEFAULT_IMAGE_RATIO;
    let best = DEFAULT_IMAGE_RATIO, bestGap = Infinity;
    for (const candidate of IMAGE_RATIOS) {
        const gap = Math.abs(aspectOf(candidate) - want);
        if (gap < bestGap) { bestGap = gap; best = candidate; }
    }
    return best;
}

const VIDEO_RATIOS = {
    image_to_video: ['1280:720', '1584:672', '1104:832', '720:1280', '832:1104', '672:1584', '960:960'],
    text_to_video: ['1280:720', '720:1280'],
};

const DURATION_MIN = 2;
const DURATION_MAX = 10;
const DURATION_DEFAULT = 5;
const SEED_MAX = 4294967295;      // 2^32 - 1

// Terminal states are SUCCEEDED / FAILED / CANCELED. THROTTLED means "accepted
// but not enqueued", which the docs say is safe to treat exactly like PENDING.
const TASK_STATUS = {
    PENDING: 'pending',
    THROTTLED: 'pending',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELED: 'failed',
};
const TASK_STATUSES = Object.keys(TASK_STATUS);

// Runway asks clients to back off on these; everything else is a hard failure.
const RETRYABLE = new Set([429, 502, 503]);

const POLL_INTERVAL_MS = Number(process.env.RUNWAY_POLL_INTERVAL_MS) || 3000;
const DEFAULT_TIMEOUT_MS = 300000;

function baseUrl() {
    return (process.env.RUNWAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function supports(capability) {
    return capability === 'video' || capability === 'image';
}

/**
 * Runway's own docs use RUNWAYML_API_SECRET; this app's convention is
 * <PROVIDER>_API_KEY. Accept both so a key copied straight out of the Runway
 * quickstart works without renaming it.
 */
function apiKey() {
    const { apiKey: stored } = getCredential('runway');
    return stored || process.env.RUNWAYML_API_SECRET || '';
}

function authHeader(key) {
    return { Authorization: `Bearer ${key}` };
}

function jsonHeaders() {
    return { 'Content-Type': 'application/json', 'X-Runway-Version': RUNWAY_VERSION };
}

function missingKey() {
    return {
        ok: false,
        status: 401,
        error: 'runway: missing API key. Add it in Provider Settings or set RUNWAY_API_KEY.',
    };
}

/** Parse "1280:720" into a numeric aspect. */
function ratioAspect(ratio) {
    const [w, h] = String(ratio).split(':').map(Number);
    return h ? w / h : 1;
}

/**
 * Snap requested dimensions to the closest documented ratio for the mode.
 * Compared in log space so 16:9 and 9:16 are treated as equally distant from a
 * square target instead of the wider one always winning.
 */
function pickRatio(width, height, mode) {
    const allowed = VIDEO_RATIOS[mode] || VIDEO_RATIOS.text_to_video;
    const w = Number(width);
    const h = Number(height);
    if (!w || !h || w <= 0 || h <= 0) return allowed[0];
    const target = Math.log(w / h);
    let best = allowed[0];
    let bestDelta = Infinity;
    for (const ratio of allowed) {
        const delta = Math.abs(Math.log(ratioAspect(ratio)) - target);
        if (delta < bestDelta) { bestDelta = delta; best = ratio; }
    }
    return best;
}

/** Whole seconds inside the documented window. */
function clampDuration(durationS) {
    const raw = Number(durationS);
    if (!Number.isFinite(raw) || raw <= 0) return DURATION_DEFAULT;
    return Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(raw)));
}

/** Seeds outside Runway's uint32 range are dropped rather than rejected upstream. */
function normalizeSeed(seed) {
    if (seed === undefined || seed === null || seed === '') return undefined;
    const n = Number(seed);
    if (!Number.isInteger(n) || n < 0 || n > SEED_MAX) return undefined;
    return n;
}

/** Accept plain URLs or { uri, tag } entries; Runway wants the object form. */
function normalizeReferenceImages(refs) {
    if (!Array.isArray(refs) || !refs.length) return undefined;
    const out = [];
    for (const ref of refs) {
        if (typeof ref === 'string' && ref) { out.push({ uri: ref }); continue; }
        if (ref && typeof ref === 'object') {
            const uri = ref.uri || ref.url || ref.image_url;
            if (!uri) continue;
            out.push(ref.tag ? { uri, tag: ref.tag } : { uri });
        }
    }
    return out.length ? out : undefined;
}

/**
 * Build the video request. A storyboard keyframe makes this image-to-video,
 * which is the normal path here — the keyframe is what keeps a shot visually
 * consistent with the rest of the scene. Without one it degrades to
 * text-to-video, which supports a narrower set of ratios.
 */
function buildVideoRequest(payload) {
    const p = payload || {};
    // The video endpoints take a single promptImage — referenceImages is a
    // text_to_image field and gen4.5 does not document it. So when the
    // consistency system supplies locked references but no storyboard keyframe,
    // the first reference becomes the first frame. That is what actually keeps a
    // character looking like themselves; dropping it (as an earlier draft did)
    // would silently lose the identity lock on any shot without a keyframe.
    const refs = normalizeReferenceImages(p.reference_images || p.referenceImages);
    const promptImage = p.promptImage || p.init_image || p.image_url || (refs ? refs[0].uri : '');
    const mode = promptImage ? 'image_to_video' : 'text_to_video';

    const body = {
        model: pickModel(p.model, KNOWN_VIDEO_MODELS, DEFAULT_VIDEO_MODEL),
        promptText: p.promptText || p.prompt || '',
        ratio: pickRatio(p.width, p.height, mode),
        duration: clampDuration(p.duration_s !== undefined ? p.duration_s : p.duration),
    };
    if (promptImage) body.promptImage = promptImage;

    const seed = normalizeSeed(p.seed);
    if (seed !== undefined) body.seed = seed;

    return { url: `${baseUrl()}/${mode}`, headers: jsonHeaders(), body, mode };
}

function buildImageRequest(payload) {
    const p = payload || {};
    const body = {
        model: pickModel(p.model, KNOWN_IMAGE_MODELS, DEFAULT_IMAGE_MODEL),
        // text_to_image documents no negative field, so a negative handed here
        // was dropped. Folded into the positive, as OpenAI's adapter does.
        promptText: (() => {
            const base = p.promptText || p.prompt || '';
            const neg = String(p.negative_prompt || '').trim();
            if (!neg) return base;
            const joined = `${base}\n\nAvoid: ${neg}`;
            // The fold happens after budgeting, so it must fit inside the
            // declared ceiling rather than push the request past it.
            const ceiling = adapter.promptLimit;
            if (!ceiling || joined.length <= ceiling) return joined;
            const room = ceiling - base.length - 9;
            return room > 12 ? `${base}\n\nAvoid: ${neg.slice(0, room)}` : base;
        })(),
    };
    // ratio is required, so it is always sent. Precedence: an explicit pixel
    // pair, then whatever ratio/aspect the caller named, then the default.
    const requested = (Number(p.width) > 0 && Number(p.height) > 0)
        ? `${Number(p.width)}:${Number(p.height)}`
        : (p.ratio || p.aspect_ratio || p.aspectRatio || DEFAULT_IMAGE_RATIO);
    body.ratio = snapImageRatio(requested);

    const refs = normalizeReferenceImages(p.reference_images || p.referenceImages);
    if (refs) body.referenceImages = refs;

    return { url: `${baseUrl()}/text_to_image`, headers: jsonHeaders(), body, mode: 'text_to_image' };
}

function mapTaskStatus(status) {
    return TASK_STATUS[String(status || '').toUpperCase()] || 'pending';
}

function isRetryable(httpStatus) {
    return RETRYABLE.has(Number(httpStatus));
}

function extractOutputUrl(task) {
    if (!task || mapTaskStatus(task.status) !== 'succeeded') return null;
    const out = task.output;
    if (Array.isArray(out) && typeof out[0] === 'string' && out[0]) return out[0];
    return null;
}

/**
 * Runway returns { error, docUrl, issues[] } on validation failures. The issues
 * carry the offending field, which is the part worth surfacing — "bad request"
 * alone gives the user nothing to act on.
 */
function formatError(status, body) {
    if (!body || typeof body !== 'object') return `runway: HTTP ${status}`;
    const parts = [];
    if (body.error) parts.push(String(body.error));
    if (Array.isArray(body.issues)) {
        for (const issue of body.issues) {
            const field = Array.isArray(issue.path) ? issue.path.join('.') : issue.path;
            parts.push(field ? `${field}: ${issue.message}` : String(issue.message || ''));
        }
    }
    return parts.length ? `runway ${status}: ${parts.join(' — ')}` : `runway: HTTP ${status}`;
}

/** Shape the result so persistProviderMedia/storyboard find the URL. */
function mediaResult(capability, url) {
    if (capability === 'video') return { video_url: url };
    return { image_url: url, image_urls: [url] };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function readJson(response) {
    try { return await response.json(); } catch (_) { return null; }
}

/** Submit a generation task; returns the task id. */
async function submitTask(request, key) {
    const response = await fetch(request.url, {
        method: 'POST',
        headers: { ...request.headers, ...authHeader(key) },
        body: JSON.stringify(request.body),
    });
    const body = await readJson(response);
    if (!response.ok) {
        return { ok: false, status: response.status, error: formatError(response.status, body), retryable: isRetryable(response.status) };
    }
    const id = body && body.id;
    if (!id) return { ok: false, status: 502, error: 'runway: task response contained no id' };
    return { ok: true, id };
}

/**
 * Poll a task to a terminal state.
 *
 * Transient 429/502/503 responses while polling are not failures — the task is
 * still running on Runway's side — so they are retried until the deadline
 * rather than aborting a generation that will succeed.
 */
async function pollTask(taskId, key, deadline) {
    const url = `${baseUrl()}/tasks/${encodeURIComponent(taskId)}`;
    for (;;) {
        if (Date.now() >= deadline) {
            return { ok: false, status: 504, error: `runway: task ${taskId} did not finish before the timeout` };
        }
        const response = await fetch(url, { headers: { ...jsonHeaders(), ...authHeader(key) } });
        const body = await readJson(response);

        if (!response.ok) {
            if (!isRetryable(response.status)) {
                return { ok: false, status: response.status, error: formatError(response.status, body) };
            }
        } else {
            const state = mapTaskStatus(body && body.status);
            if (state === 'succeeded') {
                const url_ = extractOutputUrl(body);
                if (!url_) return { ok: false, status: 502, error: `runway: task ${taskId} succeeded with no output URL` };
                return { ok: true, task: body, url: url_ };
            }
            if (state === 'failed') {
                const reason = (body && (body.failure || body.failureCode || body.error)) || body && body.status;
                return { ok: false, status: 502, error: `runway: task ${taskId} ${String((body && body.status) || 'FAILED').toLowerCase()}${reason && reason !== (body && body.status) ? ` — ${reason}` : ''}` };
            }
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

/**
 * Runway bills video by the SECOND of output and images per image, both in
 * credits at a cent each.
 *
 * The duration read here is the one that was actually requested — `clampDuration`
 * has already snapped it to a value Runway accepts, and billing the unclamped
 * number the caller asked for would report a cost for a clip nobody generated.
 */
function meterRunway(capability, payload, result) {
    const p = payload || {};
    if (capability === 'video') {
        const model = (result && result.provider_model) || pickModel(p.model, KNOWN_VIDEO_MODELS, DEFAULT_VIDEO_MODEL);
        const seconds = clampDuration(p.duration_s !== undefined ? p.duration_s : p.duration);
        if (!(seconds > 0)) return null;
        return { unit: 'second', quantity: seconds, model };
    }
    if (capability === 'image') {
        const base = (result && result.provider_model) || pickModel(p.model, KNOWN_IMAGE_MODELS, DEFAULT_IMAGE_MODEL);
        // 720p and 1080p are different prices on gen4_image; the taller side of
        // the requested frame decides which.
        const longest = Math.max(Number(p.width) || 0, Number(p.height) || 0);
        const model = (base === 'gen4_image' && longest >= 1080) ? 'gen4_image_1080p' : base;
        return { unit: 'image', quantity: 1, model };
    }
    return null;
}

const adapter = {
    meter: meterRunway,
    id: 'runway',
    kind: 'generator',
    label: 'Runway',
    requiresKey: true,

        // Runway's text_to_image caps the prompt at 1000 characters. This is the
    // number the engine used to impose on everyone.
    promptLimit: 1000,
    // Declared honestly: the negative is folded into the positive because
    // text_to_image has no negative field, and the seed is not carried.
    supportsNegativePrompt: 'folded',
    supportsSeed: false,
    capabilities: ['video', 'image'],
    // gen4_image takes up to three { uri, tag } references and lets the prompt
    // name them, which is what makes @tags meaningful here.
    supportsReferenceImages: true,
    // { uri, tag } — the prompt addresses them as @tag.
    supportsReferenceTags: true,
    maxReferenceImages: 3,

    connection: {
        instructions: 'Create an API key in the Runway developer portal and paste it here. Runway bills API generations from developer-portal credits, which are separate from a Runway app subscription.',
        helpUrl: 'https://dev.runwayml.com/',
    },

    supports,

    async generate(capability, payload, opts) {
        if (!supports(capability)) {
            return { ok: false, status: 400, error: `runway: unsupported capability '${capability}'` };
        }
        const key = apiKey();
        if (!key) return missingKey();

        const request = capability === 'video' ? buildVideoRequest(payload) : buildImageRequest(payload);
        if (!request.body.promptText && !request.body.promptImage) {
            return { ok: false, status: 400, error: 'runway: a prompt or a keyframe image is required' };
        }

        const timeout = (opts && opts.timeout) || DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeout;

        try {
            const submitted = await submitTask(request, key);
            if (!submitted.ok) return { ok: false, status: submitted.status, error: submitted.error };

            const done = await pollTask(submitted.id, key, deadline);
            if (!done.ok) {
                return { ok: false, status: done.status, error: done.error, provider: 'runway', provider_job_id: submitted.id };
            }

            return {
                ok: true,
                status: 200,
                data: mediaResult(capability, done.url),
                provider: 'runway',
                provider_model: request.body.model,
                provider_job_id: submitted.id,
            };
        } catch (err) {
            return { ok: false, status: 502, error: `runway: ${err.message}` };
        }
    },

    async health() {
        const key = apiKey();
        if (!key) return { ok: false, error: 'runway: no API key configured' };
        const started = Date.now();
        try {
            // No public health endpoint; an unknown task id proves reachability
            // and that the credential is accepted (404 = authenticated, no task).
            const response = await fetch(`${baseUrl()}/tasks/health-probe`, { headers: { ...jsonHeaders(), ...authHeader(key) } });
            return { ok: response.status !== 401, status: response.status, latencyMs: Date.now() - started };
        } catch (err) {
            return { ok: false, error: `runway: ${err.message}` };
        }
    },
};

module.exports = {
    KNOWN_VIDEO_MODELS,
    KNOWN_IMAGE_MODELS,
    pickModel,
    IMAGE_RATIOS,
    snapImageRatio,
    adapter,
    buildVideoRequest,
    buildImageRequest,
    pickRatio,
    clampDuration,
    normalizeSeed,
    normalizeReferenceImages,
    mapTaskStatus,
    isRetryable,
    extractOutputUrl,
    formatError,
    mediaResult,
    authHeader,
    supports,
    VIDEO_RATIOS,
    TASK_STATUSES,
    RUNWAY_VERSION,
};
