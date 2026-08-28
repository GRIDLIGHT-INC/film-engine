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

// Documented for image_to_video: promptImage may carry a first and a last frame.
const MAX_KEYFRAMES = 2;

/*
 * The ceiling for a video promptText.
 *
 * Runway documents 1000 characters for text_to_image, which is where the
 * adapter's promptLimit comes from. The VIDEO endpoints' own limit is not
 * documented in anything this adapter was written against, and the previous
 * code applied the same 1000 with no source stated at all.
 *
 * So it mirrors the image limit deliberately and says so, rather than being an
 * independently verified number. If Runway publishes a different figure it is a
 * one-line change here — and holding it at the image limit is the conservative
 * direction, since over-sending is a rejection at the provider that costs a
 * generation while under-sending costs some description.
 */
const VIDEO_PROMPT_LIMIT = 1000;
const DEFAULT_VIDEO_MODEL = process.env.RUNWAY_VIDEO_MODEL || 'gen4.5';
const DEFAULT_IMAGE_MODEL = process.env.RUNWAY_IMAGE_MODEL || 'gen4_image';

/**
 * Model names this adapter will forward.
 *
 * capability-payloads builds ONE payload per capability for every provider, and
 * its image default was a Gridlight-era checkpoint name that means nothing here.
 * Forwarding it unchecked made Runway reject every storyboard with
 * "model: Invalid", because `p.model || DEFAULT` lets a foreign name win over
 * the adapter's own default.
 *
 * An adapter should never hand its API a model it does not recognise. Anything
 * outside these sets falls back to the configured default instead, so a generic
 * payload works and an explicit Runway model is still honoured.
 */
const RUNWAY_VIDEO_SOURCE = 'https://docs.dev.runwayml.com/api/';
/*
 * Every model states what it costs in FULL: the output rate, what a reference
 * costs, and any minimum charge. Partial metadata is worse than none — a model
 * missing `imageReferenceCredits` is priced as though references were free,
 * which is exactly the direction that under-estimates a reference-heavy shot.
 *
 * Runway bills credits at $0.01. Rates below are from the published pricing
 * page; a rate with no source cannot be re-checked and decays into a confident
 * lie, so `source` is required on every entry.
 *
 * Seedance 2.0 and 2.5 are SEPARATE models on Runway with different rates, and
 * `seedance2` here has always been 2.0. It is not renamed: renaming it would
 * silently reprice every estimate already made against it.
 */
const RUNWAY_VIDEO_MODELS = Object.freeze({
    'gen4.5': { endpoint: 'image_to_video', duration: { min: 2, max: 10 }, ratios: ['1280:720', '1584:672', '1104:832', '720:1280', '832:1104', '672:1584', '960:960'], creditsPerSecond: 12, imageReferenceCredits: 0, videoReferenceCreditsPerSecond: 0, audioReferenceCredits: 0, minimumCredits: 0, status: 'active', source: RUNWAY_VIDEO_SOURCE },
    gen4_turbo: { endpoint: 'image_to_video', duration: { min: 5, max: 10, allowed: [5, 10] }, ratios: ['1280:720', '1584:672', '1104:832', '720:1280', '832:1104', '960:960'], creditsPerSecond: 5, imageReferenceCredits: 0, videoReferenceCreditsPerSecond: 0, audioReferenceCredits: 0, minimumCredits: 0, status: 'active', source: RUNWAY_VIDEO_SOURCE },
    'veo3.1': { endpoint: 'image_to_video', duration: { min: 5, max: 8, allowed: [5, 8] }, ratios: ['1280:720', '720:1280'], creditsPerSecond: 40, imageReferenceCredits: 0, videoReferenceCreditsPerSecond: 0, audioReferenceCredits: 0, minimumCredits: 0, status: 'active-audio', source: RUNWAY_VIDEO_SOURCE },
    'veo3.1_fast': { endpoint: 'image_to_video', duration: { min: 5, max: 8, allowed: [5, 8] }, ratios: ['1280:720', '720:1280'], creditsPerSecond: 15, imageReferenceCredits: 0, videoReferenceCreditsPerSecond: 0, audioReferenceCredits: 0, minimumCredits: 0, status: 'active-audio', source: RUNWAY_VIDEO_SOURCE },
    happyhorse_1_0: { endpoint: 'image_to_video', duration: { min: 5, max: 10 }, ratios: ['1280:720', '720:1280', '1920:1080', '1080:1920'], creditsPerSecond: 15, imageReferenceCredits: 0, videoReferenceCreditsPerSecond: 0, audioReferenceCredits: 0, minimumCredits: 0, status: 'active-720p-rate', source: RUNWAY_VIDEO_SOURCE },

    /*
     * MiniMax H3. The reference economics are the reason it is the production
     * tier: 2 credits per reference IMAGE means a nine-picture role package
     * costs 18 credits, so a 10s 768P shot with the full package is 118
     * credits — two credits CHEAPER than Gen-4.5 with no references at all.
     */
    hailuo3: {
        endpoint: 'image_to_video', duration: { min: 5, max: 10 },
        ratios: ['1280:720', '720:1280', '1920:1080', '1080:1920'],
        creditsPerSecond: 10,
        resolutions: { '768P': { creditsPerSecond: 10 }, '2K': { creditsPerSecond: 15 } },
        defaultResolution: '768P',
        imageReferenceCredits: 2, videoReferenceCreditsPerSecond: 10, audioReferenceCredits: 0,
        minimumCredits: 0, status: 'active', source: RUNWAY_VIDEO_SOURCE,
    },

    /*
     * Seedance 2.5 — the precision model, and the expensive one for the reason
     * that is easy to miss: reference VIDEO is billed at half the output rate
     * PER SECOND, so three 5s reference clips on a 10s shot adds 225 credits.
     * Reference images and audio are free. The 80-credit minimum means a short
     * clip bills as a longer one.
     */
    seedance2_5: {
        endpoint: 'image_to_video', duration: { min: 4, max: 30 },
        ratios: ['1280:720', '720:1280', '1920:1080', '1080:1920'],
        creditsPerSecond: 30,
        resolutions: {
            '480p': { creditsPerSecond: 20, videoReferenceCreditsPerSecond: 10 },
            '720p': { creditsPerSecond: 30, videoReferenceCreditsPerSecond: 15 },
            '1080p': { creditsPerSecond: 68, videoReferenceCreditsPerSecond: 34 },
        },
        defaultResolution: '720p',
        imageReferenceCredits: 0, videoReferenceCreditsPerSecond: 15, audioReferenceCredits: 0,
        minimumCredits: 80, status: 'active', source: RUNWAY_VIDEO_SOURCE,
    },

    seedance2: { endpoint: 'image_to_video', duration: { min: 4, max: 30 }, ratios: ['1280:720', '720:1280'], creditsPerSecond: 36, imageReferenceCredits: 0, videoReferenceCreditsPerSecond: 0, audioReferenceCredits: 0, minimumCredits: 0, status: 'active-720p-rate', source: RUNWAY_VIDEO_SOURCE },
    seedance2_fast: { endpoint: 'image_to_video', duration: { min: 4, max: 30 }, ratios: ['1280:720', '720:1280'], creditsPerSecond: 29, imageReferenceCredits: 0, videoReferenceCreditsPerSecond: 0, audioReferenceCredits: 0, minimumCredits: 0, status: 'active-720p-rate', source: RUNWAY_VIDEO_SOURCE },
    seedance2_mini: { endpoint: 'image_to_video', duration: { min: 4, max: 30 }, ratios: ['1280:720', '720:1280'], creditsPerSecond: 16, imageReferenceCredits: 0, videoReferenceCreditsPerSecond: 0, audioReferenceCredits: 0, minimumCredits: 64, status: 'active-720p-rate', source: RUNWAY_VIDEO_SOURCE },
    gemini_omni_flash: { endpoint: 'image_to_video', duration: { min: 5, max: 10 }, ratios: ['1280:720', '720:1280'], creditsPerSecond: 10, firstFrameCredits: 1, imageReferenceCredits: 1, videoReferenceCreditsPerSecond: 0, audioReferenceCredits: 0, minimumCredits: 0, status: 'active', source: RUNWAY_VIDEO_SOURCE },
});
const KNOWN_VIDEO_MODELS = new Set(Object.keys(RUNWAY_VIDEO_MODELS));
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
function pickRatio(width, height, mode, model) {
    const policy = RUNWAY_VIDEO_MODELS[model];
    const allowed = mode === 'text_to_video'
        ? VIDEO_RATIOS.text_to_video
        : ((policy && policy.ratios) || VIDEO_RATIOS.image_to_video);
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

function durationForModel(durationS, model) {
    const policy = RUNWAY_VIDEO_MODELS[model] || RUNWAY_VIDEO_MODELS['gen4.5'];
    const raw = Number(durationS);
    const wanted = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DURATION_DEFAULT;
    if (Array.isArray(policy.duration.allowed)) {
        return policy.duration.allowed.reduce((best, n) => Math.abs(n - wanted) < Math.abs(best - wanted) ? n : best);
    }
    return Math.min(policy.duration.max, Math.max(policy.duration.min, wanted));
}

/**
 * The motion instruction, assembled whole and cut only if it must be.
 *
 * The pieces used to arrive pre-trimmed — subject at 500, environment at 300 —
 * and this then applied the real 1000 ceiling on top, so a real shot sent 503
 * characters against a 1000 limit with half the director's motion description
 * thrown away for nothing.
 *
 * Assembled in full first. If it overruns, things are dropped in ORDER OF WHAT
 * MATTERS LEAST: the atmosphere note, then the framing boilerplate, and the
 * SUBJECT LAST — it is the primary instruction, and cutting what the shot is
 * about to keep a note about rain is the wrong trade every time. The camera
 * move survives with it: it is short, and without it the clip has no move.
 */
function buildRunwayMotionPrompt(payload) {
    const p = payload || {};
    const motion = p.motion || {};
    const parts = ['Continuous seamless shot.'];
    if (motion.subject) parts.push(String(motion.subject).trim().replace(/[.\s]+$/, '') + '.');
    if (motion.environment) parts.push(String(motion.environment).trim().replace(/[.\s]+$/, '') + '.');
    const control = p.camera_control || {};
    let camera = '';
    if (Array.isArray(control.path) && control.path.length > 1) {
        try { camera = require('../previs-blocking').analyzePath(control.path).description; } catch (_) { camera = ''; }
    }
    if (!camera && control.type && control.type !== 'static') camera = String(control.type).replace(/-/g, ' ');
    if (camera) parts.push(`Over ${durationForModel(p.duration_s || p.duration, p.model || DEFAULT_VIDEO_MODEL)} seconds, the camera performs ${camera}.`);
    if (p.motion_prompt && !motion.subject && !motion.environment) parts.push(String(p.motion_prompt));

    const ceiling = Number(p.prompt_limit) || VIDEO_PROMPT_LIMIT;
    const whole = parts.join(' ').trim();
    if (whole.length <= ceiling) return whole;

    /*
     * Over the ceiling, so something goes. Rebuilt keeping the load-bearing
     * pieces — the subject and the camera move — and dropping the rest before
     * the subject is touched at all.
     */
    const cameraPart = parts.find(x => /camera performs/i.test(x));
    const subjectPart = motion.subject
        ? String(motion.subject).trim().replace(/[.\s]+$/, '') + '.' : '';
    const keep = ['Continuous seamless shot.', subjectPart, cameraPart].filter(Boolean);
    const kept = keep.join(' ').trim();
    if (kept.length <= ceiling) return kept;

    // Only now is the subject itself cut, and at a clause boundary rather than
    // mid-word so the last thing the model reads is a complete instruction.
    const room = ceiling - (kept.length - subjectPart.length) - 1;
    const cut = subjectPart.slice(0, Math.max(0, room));
    const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '));
    const trimmedSubject = (at > room * 0.5 ? cut.slice(0, at + 1) : cut).trim();
    return ['Continuous seamless shot.', trimmedSubject, cameraPart]
        .filter(Boolean).join(' ').trim().slice(0, ceiling);
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

    /*
     * A START and a DESTINATION, not just a start.
     *
     * image_to_video takes promptImage as a string OR as an array of
     * { uri, position } with position "first" or "last" — the documented
     * keyframe feature. Collapsing everything to one image, which this did,
     * meant the only thing a director could say about motion was whatever fitted
     * in one still plus a movement word: where the shot is GOING, and what it
     * looks like when it gets there, was unsayable.
     *
     * Two is the ceiling and it is the endpoint's, not a number chosen here.
     * Anything beyond it is REPORTED rather than dropped quietly, because a
     * director who selected four frames and silently got two would read it as
     * the feature not working.
     */
    const keyframes = normalizeKeyframes(p.keyframes);
    const dropped = keyframes.length > MAX_KEYFRAMES ? keyframes.slice(MAX_KEYFRAMES) : [];
    const kept = keyframes.slice(0, MAX_KEYFRAMES);

    const singleImage = p.promptImage || p.init_image || p.image_url || (refs ? refs[0].uri : '');
    const promptImage = kept.length > 1 ? kept
        : kept.length === 1 ? kept[0].uri
            : singleImage;
    const mode = (Array.isArray(promptImage) ? promptImage.length : promptImage)
        ? 'image_to_video' : 'text_to_video';

    const model = pickModel(p.model, KNOWN_VIDEO_MODELS, DEFAULT_VIDEO_MODEL);
    const body = {
        model,
        promptText: p.motion_prompt
            || ((p.motion || p.camera_control) ? buildRunwayMotionPrompt(p) : (p.promptText || p.prompt || '')),
        ratio: pickRatio(p.width, p.height, mode, model),
        duration: durationForModel(p.duration_s !== undefined ? p.duration_s : p.duration, model),
    };
    if (promptImage) body.promptImage = promptImage;

    const seed = normalizeSeed(p.seed);
    if (seed !== undefined) body.seed = seed;

    return {
        url: `${baseUrl()}/${mode}`, headers: jsonHeaders(), body, mode,
        // Named so a caller can tell the director what could not be sent.
        ...(dropped.length ? { dropped: dropped.map(k => k.uri) } : {}),
    };
}

function sanitizedPromptImage(value) {
    if (!value) return undefined;
    const list = Array.isArray(value) ? value : [{ uri: value, position: 'first' }];
    return { kind: 'image', count: list.length, positions: list.map((x, i) => x.position || (i ? 'last' : 'first')) };
}

function estimateVideoCredits(body) {
    const policy = RUNWAY_VIDEO_MODELS[body.model] || RUNWAY_VIDEO_MODELS['gen4.5'];
    const raw = body.duration * policy.creditsPerSecond + (body.promptImage ? (policy.firstFrameCredits || 0) : 0);
    return Math.max(policy.minimumCredits || 0, raw);
}

/**
 * Keyframes as the endpoint wants them: ordered, positioned, first then last.
 *
 * A caller may hand us bare strings or half-filled records. Deriving the
 * position from the ORDER rather than trusting a field means a sequence planner
 * cannot accidentally send two "first" frames, which the endpoint accepts and
 * which produces a shot that goes nowhere.
 */
function normalizeKeyframes(input) {
    if (!Array.isArray(input) || !input.length) return [];
    return input
        .map(k => (typeof k === 'string' ? { uri: k } : k))
        .filter(k => k && k.uri)
        .map((k, i, all) => ({ uri: k.uri, position: i === 0 ? 'first' : (i === all.length - 1 ? 'last' : 'last') }));
}

/**
 * What this adapter would ACTUALLY send, without sending it.
 *
 * The preview reported the payload's own fields and called them fact, so a
 * shot whose payload carried a local Gridlight checkpoint name — hardcoded in
 * lib/video-prompt.js, and something Runway has never heard of — was previewed
 * as generating on it while pickModel silently substituted the default. The one
 * dialog a director is asked to trust before spending named a model that would
 * never be sent.
 *
 * Derived from buildVideoRequest rather than reimplemented: a description that
 * is a second implementation of the request is a description that will drift
 * from it, which is the same fault one level up.
 *
 * Pure — no network, no credential. A preview that needs either is not free.
 */
function describeVideoRequest(payload) {
    const p = payload || {};
    const built = buildVideoRequest(p);
    const notes = [];

    const asked = String(p.model || '').trim();
    if (asked && asked !== built.body.model) {
        notes.push(`Model: you asked for "${asked}", which this provider does not offer — `
            + `it will generate on ${built.body.model}.`);
    }
    const askedDuration = Number(p.duration_s !== undefined ? p.duration_s : p.duration);
    if (Number.isFinite(askedDuration) && askedDuration !== built.body.duration) {
        notes.push(`Length: ${askedDuration}s is outside what this provider accepts — `
            + `it will generate ${built.body.duration}s.`);
    }
    if (built.mode === 'text_to_video') {
        notes.push('No image is attached, so this generates from words alone.');
    }
    if (built.dropped && built.dropped.length) {
        notes.push(`${built.dropped.length} keyframe(s) beyond the first and last will not be sent.`);
    }

    const estimatedCredits = estimateVideoCredits(built.body);
    if (p.camera_control && Array.isArray(p.camera_control.path) && p.camera_control.path.length > 1) {
        notes.push('The approved 3D camera path is translated into prompt text; Runway does not receive Film Engine coordinates.');
    }
    return {
        provider: 'runway',
        mode: built.mode,
        model: built.body.model,
        duration_s: built.body.duration,
        ratio: built.body.ratio,
        prompt: built.body.promptText,
        has_image: !!built.body.promptImage,
        seed: built.body.seed === undefined ? null : built.body.seed,
        outbound: { ...built.body, ...(built.body.promptImage ? { promptImage: sanitizedPromptImage(built.body.promptImage) } : {}) },
        estimated_credits: estimatedCredits,
        estimated_usd: estimatedCredits / 100,
        notes,
    };
}

function buildMultiShotRequest(payload) {
    const p = payload || {};
    const mode = p.mode === 'auto' ? 'auto' : 'custom';
    const shots = Array.isArray(p.shots) ? p.shots.slice(0, 5).map(s => ({
        prompt: String(s.prompt || '').slice(0, 1000), duration: Math.max(1, Math.round(Number(s.duration) || 1)),
    })) : [];
    if (mode === 'custom' && (shots.length < 3 || shots.length > 5)) throw new Error('Runway multi-shot custom mode requires 3–5 shots');
    const duration = mode === 'custom' ? shots.reduce((n, s) => n + s.duration, 0)
        : Math.min(15, Math.max(5, Math.round(Number(p.duration) || 10)));
    if (duration < 5 || duration > 15) throw new Error('Runway multi-shot duration must be 5–15 seconds');
    const body = { version: '2026-06', mode, duration, ratio: p.ratio === '1920:1080' ? '1920:1080' : '1280:720' };
    if (mode === 'custom') body.shots = shots;
    else body.prompt = String(p.prompt || '').slice(0, 2500);
    if (p.promptImage) body.promptImage = p.promptImage;
    return { url: `${baseUrl()}/recipes/multi_shot_video`, headers: jsonHeaders(), body,
        estimatedCredits: duration * (body.ratio === '1920:1080' ? 17 : 13), mode: 'multi_shot_video' };
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
        if (p.runway_recipe === 'multi_shot_video') {
            const built = buildMultiShotRequest(p);
            return { unit: 'second', quantity: built.body.duration,
                model: built.body.ratio === '1920:1080' ? 'multi_shot_video_1080p' : 'multi_shot_video_720p' };
        }
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
    // The largest image this provider will actually produce. Asking for more
    // is a rejection that costs a generation, so the request is clamped here
    // and the clamp is reported rather than silently applied.
    // gen4_image's largest documented ratio is 1920:1080; 2112:912 is wider but
    // no taller, so this is the pixel ceiling either way.
    // How a requested width/height is treated. Declared, never inferred \u2014 the
    // same rule promptLimit and maxReferenceImages follow, and for the same reason:
    // a size that reaches nothing produced a confident 2048x1152 arriving as 1376x768.
    sizeControl: 'snapped',
    sizeControlReason: 'gen4_image takes a `ratio` from a documented list of pixel pairs, so a request is answered at one of those sizes rather than the one asked for \u2014 a 1920x1080 ask generates at the nearest listed ratio and is scaled afterwards.',
    maxImagePixels: 1920 * 1080,
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
    /*
     * What attaching a reference MEANS here.
     *
     * 'condition' — the reference informs a newly generated image.
     * 'edit'      — the reference IS the image, and the result is a modified
     *               copy of it. An edit cannot move the camera.
     *
     * gen4_image takes references and GENERATES a new image conditioned on them,
     * with @tags naming each. A reference here informs the result; it is not
     * the thing being altered.
     *
     * The plate code assumed 'condition' for every provider, which is correct
     * on one adapter and structurally incapable on the others.
     */
    referenceMode: 'condition',
    // How many stills one generation can be pinned to. Runway's
    // image_to_video documents promptImage as a first and a last frame;
    // an adapter that declares nothing falls back to 1, because sending
    // two to an endpoint that takes one loses the destination silently.
    // On the ADAPTER OBJECT, not merely exported from the module:
    // resolve() hands back this object, so a describer that lives only in
    // module.exports is invisible to every caller and the preview falls
    // back to reporting the payload as fact.
    /*
     * The image models this adapter accepts, declared so a pinned model can be
     * CHECKED rather than silently replaced by pickModel's fallback. Derived
     * from KNOWN_IMAGE_MODELS so the two cannot disagree.
     */
    models: Object.freeze(Object.fromEntries([...KNOWN_IMAGE_MODELS].map(id => [id, {}]))),
    describeVideoRequest,
    maxKeyframes: MAX_KEYFRAMES,
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

        const request = capability === 'video'
            ? ((payload && payload.runway_recipe === 'multi_shot_video') ? buildMultiShotRequest(payload) : buildVideoRequest(payload))
            : buildImageRequest(payload);
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
                provider_model: request.body.model || request.mode,
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
    buildVideoRequest,
    describeVideoRequest,
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
    RUNWAY_VIDEO_MODELS,
    buildRunwayMotionPrompt,
    buildMultiShotRequest,
    durationForModel,
    estimateVideoCredits,
};
