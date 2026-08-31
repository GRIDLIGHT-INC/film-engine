/**
 * Seedance 2.5 (ByteDance), reached through MuAPI's REST surface.
 *
 *   POST https://api.muapi.ai/api/v1/seedance-2.5-{workflow}-{resolution}
 *   header: x-api-key
 *
 * THE MODEL IS IN THE ROUTE NAME. There is no `model` field to set, which means
 * a workflow chosen wrongly is a different endpoint rather than a parameter the
 * provider quietly ignores — so the choice is made once, here, from what the
 * payload actually carries.
 *
 * Why this sits beside Runway rather than replacing it:
 *
 *   Runway's gen4.5 takes TWO keyframes, first and last. That has been the hard
 *   ceiling on "generate this specific sequence from these pictures" — the
 *   request that keeps coming back is a shot conditioned on a frame, a pose
 *   reference and the established geography at once, and two slots cannot hold
 *   it. Seedance's OMNI REFERENCE workflow takes up to THIRTY images, ten videos
 *   and ten audio clips. That is a different capability, not a cheaper one.
 *
 *   It is also 4K-capable, at $1.70/s — which is real money per second and the
 *   reason the resolution is derived from the project's delivery setting rather
 *   than defaulted upward.
 *
 * Asynchronous: POST returns a request_id, and the finished video is polled from
 * /predictions/{id}/result. The adapter returns the URL rather than the bytes,
 * because a video is large and every consumer here already downloads by URL —
 * unlike BFL, whose result link expires in ten minutes.
 */

const { getCredential } = require('./credentials');

const BASE_URL = process.env.SEEDANCE_BASE_URL || 'https://api.muapi.ai/api/v1';

/* Documented resolutions, and what a second of each costs. */
const RESOLUTIONS = Object.freeze({
    '480p': { suffix: '-480p', longEdge: 854, usdPerSecond: 0.17 },
    '720p': { suffix: '', longEdge: 1280, usdPerSecond: 0.34 },   // the unsuffixed default
    '1080p': { suffix: '-1080p', longEdge: 1920, usdPerSecond: 0.85 },
    '4k': { suffix: '-4k', longEdge: 3840, usdPerSecond: 1.70 },
});

const WORKFLOWS = Object.freeze({
    'text-to-video': { images: 0 },
    'image-to-video': { images: 1 },
    'first-last-frame': { images: 2 },
    'omni-reference': { images: 30 },
    'video-edit': { images: 0 },
    'video-extend': { images: 0 },
});

/** What Seedance accepts; anything else is a rejected request. */
const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'];
const MIN_DURATION = 4, MAX_DURATION = 30;
const MAX_KEYFRAMES = 30;

const POLL_INTERVAL_MS = Number(process.env.SEEDANCE_POLL_INTERVAL_MS || 4000);
const POLL_TIMEOUT_MS = Number(process.env.SEEDANCE_POLL_TIMEOUT_MS || 900000);

/** The delivery resolution the project asked for, snapped to what exists. */
function resolutionFor(payload) {
    const explicit = String(payload.resolution || payload.quality || '').toLowerCase();
    if (RESOLUTIONS[explicit]) return explicit;
    /*
     * A MODEL CHOSEN ON THE DIALOG IS A RESOLUTION CHOSEN.
     *
     * The dialog has always been able to send `model`, and this adapter read
     * only `resolution` -- so picking "Seedance 2.5 - 1080p" changed the label
     * on the confirmation and nothing about the request. Read after the
     * explicit field so a route that genuinely knows the tier still wins.
     */
    const asked = String(payload.model || payload.video_model || '');
    const byModel = VIDEO_MODELS[asked] || POST_MODELS[asked];
    if (byModel) return byModel.resolution;
    const raster = String(payload.target_resolution || '');
    const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(raster);
    const longEdge = m ? Math.max(Number(m[1]), Number(m[2])) : 0;
    if (!longEdge) return '720p';
    // Never round UP: 4K is five times the price of 1080p per second, and a
    // resolution nobody asked for is a bill nobody expected.
    if (longEdge >= 3840) return '4k';
    if (longEdge >= 1920) return '1080p';
    if (longEdge >= 1280) return '720p';
    return '480p';
}

function aspectFor(payload) {
    const declared = String(payload.aspect_ratio || '').trim();
    if (ASPECTS.includes(declared)) return declared;
    const m = /^(\d+)\s*[x:]\s*(\d+)$/.exec(String(payload.target_resolution || ''));
    if (!m) return '16:9';
    const r = Number(m[1]) / Number(m[2]);
    return ASPECTS.reduce((best, a) => {
        const [w, h] = a.split(':').map(Number);
        return Math.abs(w / h - r) < Math.abs(
            Number(best.split(':')[0]) / Number(best.split(':')[1]) - r) ? a : best;
    }, '16:9');
}

/** Every picture the payload carries, in rank order, as URLs or data URIs. */
function collectImages(p) {
    const out = [];
    const push = v => {
        const uri = typeof v === 'string' ? v : (v && (v.uri || v.url || v.image_url || v.src));
        if (uri && !out.includes(uri)) out.push(uri);
    };
    if (p.init_image) push(p.init_image);
    (p.keyframes || []).forEach(k => push(k && (k.image || k.uri || k.url) || k));
    (p.reference_images || []).forEach(push);
    if (p.last_frame) push(p.last_frame);
    return out.slice(0, MAX_KEYFRAMES);
}

/**
 * Choose the workflow from what is actually attached.
 *
 * Derived rather than configured: a payload with four pictures IS an
 * omni-reference request, and letting a caller declare otherwise would send
 * four images to an endpoint that reads one and silently drop the rest — the
 * exact failure the reference-limit work exists to prevent.
 */
function workflowFor(p, images) {
    const asked = String(p.workflow || '').trim();
    if (WORKFLOWS[asked]) return asked;
    if (p.source_video || p.video_url) return p.extend ? 'video-extend' : 'video-edit';
    if (images.length >= 3) return 'omni-reference';
    if (images.length === 2) return 'first-last-frame';
    if (images.length === 1) return 'image-to-video';
    return 'text-to-video';
}

function buildVideoRequest(payload) {
    const p = payload || {};
    const images = collectImages(p);
    const workflow = workflowFor(p, images);
    const resolution = resolutionFor(p);

    let duration = Number(p.duration_s !== undefined ? p.duration_s
        : (p.duration !== undefined ? p.duration : (p.duration_ms || 0) / 1000));
    if (!Number.isFinite(duration) || duration <= 0) duration = 5;
    const clamped = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(duration)));

    const body = {
        prompt: String(p.prompt || p.motion_prompt || '').trim(),
        aspect_ratio: aspectFor(p),
        duration: clamped,
    };
    if (Number.isFinite(Number(p.seed)) && Number(p.seed) >= 0) body.seed = Number(p.seed);

    const allowed = WORKFLOWS[workflow].images;
    const used = images.slice(0, allowed);
    if (workflow === 'image-to-video') {
        body.image_url = used[0];
    } else if (workflow === 'first-last-frame') {
        body.first_frame_image = used[0];
        body.last_frame_image = used[1];
    } else if (workflow === 'omni-reference') {
        body.reference_images = used;
    }
    if (p.source_video || p.video_url) body.video_url = p.source_video || p.video_url;

    return {
        url: `${BASE_URL}/seedance-2.5-${workflow}${RESOLUTIONS[resolution].suffix}`,
        body,
        workflow,
        resolution,
        model: `seedance-2.5-${workflow}${RESOLUTIONS[resolution].suffix}`,
        images: used,
        dropped: images.slice(allowed),
        duration_s: clamped,
        askedDuration: duration,
    };
}

/**
 * What this provider will ACTUALLY do with the request — the free preview that
 * every paid video action shows before spending. Same contract as Runway's.
 */
/**
 * The finishing pass: 480p footage taken back up to delivery size.
 *
 * Footage is generated at the draft tier so exploring a shot is affordable --
 * $0.17/s against $0.85 at 1080p means three attempts cost less than one at
 * delivery size. That plan only works if something can finish the cut, and
 * `post` was served by Gridlight alone, which does not implement
 * /postprocess. So the cheap half worked and the half that produces the
 * deliverable did not exist.
 *
 * This is the `video-edit` workflow at the `4k` tier: the finished clip goes
 * in, a larger one comes out, priced from the SAME rate card the draft floor is
 * read from -- one table, so the saving and the finishing cost cannot disagree
 * about what Seedance offers.
 *
 * ONLY `upscale`. The other three post sub-types are refused BY NAME rather
 * than quietly handled, because Seedance exposes no grade, no face restoration
 * and no compositing -- and an adapter that returns an upscaled file when asked
 * to grade reports success for work it never did.
 */
/**
 * The models a director may pick, per capability.
 *
 * ON SEEDANCE THE MODEL IS THE PRICE TIER, and that is the whole reason this
 * list exists. The WORKFLOW is derived from what is attached -- a payload with
 * four pictures IS an omni-reference request, and letting a caller declare
 * otherwise sends four images to an endpoint that reads one -- so the workflow
 * is not a choice and must not be offered as one. What IS a choice, and costs
 * between $0.17 and $1.70 a second, is the resolution. Offering that as the
 * "model" makes the dialog's cost estimate the number that will be charged.
 *
 * Nothing was offered here at all before this: the adapter declared no models,
 * so the video dialog listed MuAPI with an empty menu -- indistinguishable from
 * MuAPI being unavailable for footage.
 *
 * DERIVED FROM `RESOLUTIONS`, never typed twice, so a tier added there appears
 * on the dialog and in the rate book with nothing to remember. The id matches
 * the rate book's own key exactly, because a model whose name the pricing
 * cannot find reports its generation as free.
 *
 * The `intl` and `spicy` endpoint families MuAPI also serves are deliberately
 * NOT offered: they are separate moderation/region products at their own prices,
 * and putting them on a director's menu beside the standard tiers invites
 * picking one by accident at a rate nobody checked.
 */
const VIDEO_WORKFLOWS = ['text-to-video', 'image-to-video', 'first-last-frame', 'omni-reference'];
const POST_WORKFLOWS = ['video-edit', 'video-extend'];

function tierModels(workflows, prefix) {
    const out = {};
    for (const [tier, spec] of Object.entries(RESOLUTIONS)) {
        const id = `seedance-2.5${prefix}${spec.suffix}`;
        out[id] = {
            label: `Seedance 2.5 ${prefix ? 'video edit ' : ''}\u2014 ${tier} ($${spec.usdPerSecond.toFixed(2)}/s)`,
            resolution: tier,
            suffix: spec.suffix,
            workflows,
            usdPerSecond: spec.usdPerSecond,
        };
    }
    return Object.freeze(out);
}

const VIDEO_MODELS = tierModels(VIDEO_WORKFLOWS, '');
const POST_MODELS = tierModels(POST_WORKFLOWS, '-video-edit');

const POST_SERVED = Object.freeze({
    upscale: true,
    face_restore: false,   // Seedance exposes no face-restoration workflow
    color_grade: false,    // Seedance exposes no grade workflow
    composite: false,      // compositing is an editorial act, not a generation
});

function buildPostRequest(payload) {
    const p = payload || {};
    const type = String(p.type || p.job_type || 'upscale').trim();

    if (!POST_SERVED[type]) {
        throw new Error(`seedance: ${type} is not served here -- Seedance offers a video-edit `
            + 'workflow at a larger tier, which is an upscale; it exposes no grade, no face '
            + 'restoration and no compositing. Do this one in the NLE.');
    }

    const source = p.source_video || p.video_url || p.input_video || p.init_video;
    if (!source) {
        /*
         * Refused, never sent. Without a clip the video-edit workflow has
         * nothing to edit and would generate something NEW from the prompt --
         * a paid request returning a clip that is not the film, presented as
         * the finished shot.
         */
        throw new Error('seedance: an upscale needs the finished clip (source_video) -- with no '
            + 'source video there is nothing to finish, and the workflow would generate a new one');
    }

    /*
     * 4K by default because that is what the finishing pass is FOR, and
     * overridable because a 1080p delivery billed at the 4K rate is money spent
     * on pixels nobody ships. Same precedence the draft path uses: what the
     * caller asked for wins.
     */
    const asked = String(p.resolution || p.quality || '').trim().toLowerCase();
    const resolution = RESOLUTIONS[asked] ? asked : '4k';

    let duration = Number(p.duration_s !== undefined ? p.duration_s : (p.duration_ms || 0) / 1000);
    if (!Number.isFinite(duration) || duration <= 0) duration = 5;
    const clamped = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(duration)));

    const body = {
        prompt: String(p.prompt || '').trim(),
        video_url: source,
        duration: clamped,
    };
    if (p.aspect_ratio || p.target_resolution) body.aspect_ratio = aspectFor(p);

    return {
        url: `${BASE_URL}/seedance-2.5-video-edit${RESOLUTIONS[resolution].suffix}`,
        body,
        images: [],
        workflow: 'video-edit',
        resolution,
        usd_per_second: RESOLUTIONS[resolution].usdPerSecond,
        estimated_usd: Number((RESOLUTIONS[resolution].usdPerSecond * clamped).toFixed(2)),
    };
}

function describeVideoRequest(payload) {
    const p = payload || {};
    const built = buildVideoRequest(p);
    const notes = [];

    if (Math.round(built.askedDuration) !== built.duration_s) {
        notes.push(`Length: ${built.askedDuration}s is outside 4–30s — it will generate ${built.duration_s}s.`);
    }
    if (built.workflow === 'text-to-video') {
        notes.push('No image is attached, so this generates from words alone.');
    }
    if (built.workflow === 'omni-reference') {
        notes.push(`${built.images.length} pictures travel as references — Seedance reconciles them into one sequence.`);
    }
    if (built.dropped.length) {
        notes.push(`${built.dropped.length} picture(s) beyond what this workflow accepts will not be sent.`);
    }
    if (built.resolution === '4k') {
        notes.push('4K is $1.70 per second — five times 1080p. Change the project delivery resolution to lower it.');
    }
    if (p.camera_control && Array.isArray(p.camera_control.path) && p.camera_control.path.length > 1) {
        notes.push('The approved 3D camera path is translated into prompt text; Seedance does not receive Film Engine coordinates.');
    }

    const perSecond = RESOLUTIONS[built.resolution].usdPerSecond;
    return {
        provider: 'seedance',
        mode: built.workflow,
        model: built.model,
        duration_s: built.duration_s,
        aspect_ratio: built.body.aspect_ratio,
        resolution: built.resolution,
        prompt: built.body.prompt,
        prompt_length: built.body.prompt.length,
        reference_count: built.images.length,
        has_image: built.images.length > 0,
        estimated_usd: Number((perSecond * built.duration_s).toFixed(2)),
        notes,
    };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function awaitResult(requestId, apiKey, deadline) {
    const url = `${BASE_URL}/predictions/${encodeURIComponent(requestId)}/result`;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        let res;
        try {
            res = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
        } catch (err) {
            return { ok: false, status: 502, error: `seedance: polling failed — ${err.message}` };
        }
        const data = await res.json().catch(() => null);
        if (!data) continue;
        const status = String(data.status || '').toLowerCase();
        if (status === 'completed' || status === 'succeeded') {
            const out = data.output;
            const url2 = typeof out === 'string' ? out
                : (Array.isArray(out) ? out[0] : (out && (out.video_url || out.url)));
            if (!url2) return { ok: false, status: 502, error: 'seedance: completed with no video' };
            return { ok: true, url: url2 };
        }
        if (status === 'failed' || status === 'error' || status === 'cancelled') {
            return { ok: false, status: 422, error: `seedance: ${data.error || status}` };
        }
    }
    return { ok: false, status: 504, error: 'seedance: timed out waiting for the video' };
}

async function generate(capability, payload, opts) {
    if (capability !== 'video' && capability !== 'post') {
        return { ok: false, status: 400, error: `seedance: ${capability} is not served here` };
    }

    /*
     * The post builder REFUSES three of the four sub-types, and that refusal is
     * the answer -- so it runs before the credential check. Telling someone
     * their key is missing when the real problem is that Seedance cannot grade
     * sends them to look in the wrong place.
     */
    let req;
    if (capability === 'post') {
        try { req = buildPostRequest(payload); }
        catch (err) { return { ok: false, status: 400, error: err.message }; }
    }

    const { apiKey } = getCredential('seedance');
    if (!apiKey) return { ok: false, status: 401, error: 'seedance: no API key configured' };

    if (!req) {
        req = buildVideoRequest(payload);
        if (!req.body.prompt && !req.images.length) {
            return { ok: false, status: 400, error: 'seedance: nothing to generate from' };
        }
    }

    let res;
    try {
        res = await fetch(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, accept: 'application/json' },
            body: JSON.stringify(req.body),
        });
    } catch (err) {
        return { ok: false, status: 502, error: `seedance: ${err.message}` };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
        const detail = (data && (data.error || data.detail || data.message)) || `HTTP ${res.status}`;
        return { ok: false, status: res.status, error: `seedance: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` };
    }
    const requestId = data.request_id || data.id;
    if (!requestId) return { ok: false, status: 502, error: 'seedance: no request id returned' };

    /*
     * The handle, written down BEFORE polling. Everything after this line can
     * be torn down without losing the job.
     */
    if (opts && typeof opts.onHandle === 'function') {
        try { opts.onHandle(requestId, { capability }); } catch (_) { /* never blocks a paid call */ }
    }
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    const out = await awaitResult(requestId, apiKey, Date.now() + budget);
    if (!out.ok && out.status === 504 && opts && opts.onTimeout) return opts.onTimeout(requestId, budget);
    if (!out.ok) return out;
    return {
        ok: true,
        url: out.url,
        provider: 'seedance',
        provider_model: req.model,
        duration_s: req.duration_s,
        // The meter prices in seconds at this resolution's rate.
        usage: { seconds: req.duration_s, resolution: req.resolution },
    };
}

/**
 * What the call consumed. Per second — and the RESOLUTION multiplies it
 * fivefold from 720p to 4K, so it has to reach the model id or a 4K render
 * reports as a 720p one.
 */
function meterSeedance(capability, payload, result) {
    if (capability !== 'video' && capability !== 'post') return null;

    /*
     * An upscale is billed per second at its tier's rate exactly as a
     * generation is -- same table, same unit. Metered through the POST builder
     * though, because the two resolve their tier differently: footage defaults
     * to the draft floor and a finish defaults to 4K, so metering an upscale
     * through the video builder would report a $51 finish as an $8 one.
     */
    if (capability === 'post') {
        let built;
        try { built = buildPostRequest(payload || {}); }
        catch (err) { return null; }   // refused before anything was spent
        const secs = (result && Number(result.duration_s)) || built.body.duration;
        const suffix = built.resolution === '720p' ? '' : `-${built.resolution}`;
        return {
            unit: 'second',
            quantity: Math.max(1, secs),
            model: `seedance-2.5-video-edit${suffix}`,
        };
    }

    const built = buildVideoRequest(payload || {});
    const seconds = (result && Number(result.duration_s)) || built.duration_s;
    const res = (result && result.usage && result.usage.resolution) || built.resolution;
    const model = res === '720p' ? 'seedance-2.5' : `seedance-2.5-${res}`;
    return { unit: 'second', quantity: Math.max(1, seconds), model };
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
    const { apiKey } = getCredential('seedance');
    if (!apiKey) return { ok: false, status: 401, error: 'seedance: no API key configured' };
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    return awaitResult(String(requestId), apiKey, Date.now() + budget);
}

const seedanceAdapter = {
    // Asked directly by the readiness checks as well as by resolve(): an
    // adapter that cannot answer "do you serve this?" is treated as not
    // serving it, and is quietly skipped as a preference.
    supports: capability => (seedanceAdapter.capabilities || []).includes(capability),
    meter: meterSeedance,
    id: 'seedance',
    kind: 'generator',
    // Labelled for the ACCOUNT, not the model: the key pasted here is a MuAPI
    // account key that also reaches the Nano Banana image adapter, and a label
    // naming ByteDance is why it was pasted twice under two names.
    label: 'MuAPI (Seedance 2.5 video)',
    requiresKey: true,
    capabilities: ['video', 'post'],

    /*
     * The model this adapter generates with, named so the DRAFT path can find
     * its floor.
     *
     * `draftFrameFor` is keyed by model, and a video payload carries a model
     * only when a caller passes one -- so without this the lookup received
     * `undefined`, missed the 480p entry and fell to the conservative 720p
     * default. Drafting reported itself active and the clip was billed at twice
     * the draft rate, silently.
     *
     * 2.5 explicitly: `seedance2` (2.0) is a different product at different
     * rates that documents no 480p tier at all.
     */
    defaultModel: 'seedance-2.5',

    /*
     * Asynchronous: the provider accepts the job and returns an id, and the
     * result is polled for. Declared so the handle machinery can find it -- a
     * tool call abandoned mid-poll loses a generation that was already billed
     * unless the id was written down first.
     */
    asyncGeneration: true,

    // Thirty. This is the reason it is here: Runway takes two.
    maxKeyframes: MAX_KEYFRAMES,
    keyframeNote: 'The seedance-2.5-omni-reference endpoint accepts up to 30 reference images '
        + '(plus 10 videos and 10 audio clips). Below three pictures the adapter routes to '
        + 'first-last-frame or image-to-video instead, which take 2 and 1.',
    maxReferenceImages: MAX_KEYFRAMES,
    supportsReferenceImages: true,
    supportsReferenceTags: false,
    referenceMode: 'condition',
    // No documented prompt limit; held at the largest figure used here rather
    // than assumed unbounded, because over-sending is a rejection at the
    // provider and trimming is reportable.
    promptLimit: 16000,
    supportsNegativePrompt: 'folded',
    supportsSeed: true,
    maxImagePixels: 3840 * 2160,

    resolutions: RESOLUTIONS,
    workflows: WORKFLOWS,

    // Per capability: this adapter serves two, and one flat list would offer
    // video tiers to the finishing pass and edit tiers to a clip.
    modelsByCapability: { video: VIDEO_MODELS, post: POST_MODELS },
    buildVideoRequest,
    describeVideoRequest,
    generate,
    collect,

    connection: {
        instructions: 'This is your MuAPI account key \u2014 the same one the Nano Banana image '
            + 'adapter uses. Create it at muapi.ai and paste it once; whichever of the two you '
            + 'save it under, both read it.',
        helpUrl: 'https://muapi.ai/',
    },
};

module.exports = { adapter: seedanceAdapter, seedanceAdapter, buildVideoRequest,
    buildPostRequest, POST_SERVED, describeVideoRequest, RESOLUTIONS, WORKFLOWS,
    VIDEO_MODELS, POST_MODELS, generate, collect };
