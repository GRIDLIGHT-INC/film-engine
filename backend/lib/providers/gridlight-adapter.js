/**
 * Gridlight provider adapter.
 *
 * Wraps the existing gridlight-client (callGridlight / relayGridlightSSE) as a
 * GeneratorAdapter. This is the DEFAULT provider, so routing a call through it
 * is behavior-identical to calling gridlight-client directly — the whole point
 * of Phase 1 is that nothing changes until a project opts into another provider.
 */

const { callGridlight, relayGridlightSSE, checkEndpointHealth, GRIDLIGHT_URL, GRIDLIGHT_API_KEY } = require('../gridlight-client');
// Video speaks the gateway's own contract — capabilities, references, SSE,
// the shot list, every documented error — in one module (lib/gridlight-video.js).
const gridlightVideo = require('../gridlight-video');

// capability -> Gridlight endpoint path (mirrors the per-domain *_ENDPOINT constants).
/*
 * The local gateway's video model, named HERE because a model name is a fact
 * about a provider. It used to be hardcoded in lib/video-prompt.js, a builder
 * shared by every provider, so Runway was asked for a model it has never heard
 * of on every single generation.
 *
 * Gridlight is a swappable local agent and the service decides what actually
 * runs — which is what `model_is_requested_not_resolved` says — so this is the
 * request, not a promise.
 */
/*
 * The one place a checkpoint name is still correct: this is the model the LOCAL
 * gateway actually runs, so naming it here is a fact rather than a default
 * leaking into everyone else's request. It reaches no hosted provider — the
 * shared builders name no model at all now — and an operator running something
 * else sets GRIDLIGHT_VIDEO_MODEL.
 */
const DEFAULT_VIDEO_MODEL = process.env.GRIDLIGHT_VIDEO_MODEL || 'animatediff-sdxl';

const ENDPOINTS = {
    llm: '/chat/intelligent',
    image: '/image',
    video: '/video',
    music: '/music',
    voice: '/voice',
    sfx: '/music',
    ambient: '/music',
    lipsync: '/lipsync',
    post: '/postprocess',
    model3d: '/3d/generate',
};

function endpointFor(capability) {
    return ENDPOINTS[capability] || null;
}

async function streamGridlightLLM(endpoint, payload, res, callbacks) {
    const cb = callbacks || {};
    const headers = { 'Content-Type': 'application/json' };
    if (GRIDLIGHT_API_KEY) headers['Authorization'] = `Bearer ${GRIDLIGHT_API_KEY}`;

    const controller = new AbortController();
    const onClose = () => controller.abort();
    if (res && typeof res.on === 'function') res.on('close', onClose);

    try {
        const response = await fetch(`${GRIDLIGHT_URL}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...(payload || {}), stream: true }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            const error = `${endpoint} error ${response.status}: ${errText}`;
            if (cb.onError) cb.onError({ error });
            return { ok: false, finalData: null, error };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const data = await response.json();
            const answer = data.answer || data.response || data.message || '';
            if (cb.onToken && answer) cb.onToken(answer);
            if (cb.onComplete) cb.onComplete({ answer, raw: data });
            return { ok: true, finalData: { answer, raw: data } };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let accumulated = '';

        while (true) {
            if (res && res.writableEnded) break;
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                    continue;
                }
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6).trim();
                if (!dataStr || dataStr === '[DONE]') continue;
                let data;
                try { data = JSON.parse(dataStr); } catch (_) { currentEvent = ''; continue; }

                const delta = data.delta || data.token || '';
                if ((currentEvent === 'token' || data.event === 'token') && delta) {
                    accumulated += delta;
                    if (cb.onToken) cb.onToken(delta);
                } else if ((currentEvent === 'final' || data.event === 'final') && data.answer) {
                    accumulated = data.answer;
                } else if (data.answer && !delta) {
                    accumulated = data.answer;
                }
                currentEvent = '';
            }
        }

        if (cb.onComplete) cb.onComplete({ answer: accumulated });
        return { ok: true, finalData: { answer: accumulated } };
    } catch (err) {
        if (err.name === 'AbortError') return { ok: false, finalData: null, error: 'client_disconnected', aborted: true };
        const error = `${endpoint} stream failed: ${err.message}`;
        if (cb.onError) cb.onError({ error });
        return { ok: false, finalData: null, error };
    } finally {
        if (res && typeof res.removeListener === 'function') res.removeListener('close', onClose);
    }
}

/**
 * Gridlight is the self-hosted gateway: no per-call charge, so every capability
 * meters as one call and the rate book prices it at zero.
 *
 * It is metered anyway rather than skipped, because "the local gateway made 40
 * keyframes" is a real answer and an unmetered provider cannot give it. The
 * rate book carries the zero explicitly and says why, so a $0.00 row reads as
 * self-hosted rather than as a capability somebody forgot to price — which is
 * the confusion this whole subsystem was built to end.
 */
function meterGridlight(capability, payload, result) {
    return { unit: 'call', quantity: 1, model: (result && result.provider_model) || (payload && payload.model) || '' };
}

/** What the gateway's video models will render: inside 3840x2160, at multiples of 32. */
function deliverableFrame(payload) {
    const p = payload || {};
    const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(String(p.target_resolution || ''));
    const w = Number(p.width) || (m ? Number(m[1]) : 1280);
    const h = Number(p.height) || (m ? Number(m[2]) : 720);
    const s = require('../gridlight-video').snapSize(w, h);
    const downgraded = Math.max(s.width, s.height) < Math.max(w, h);
    return { width: s.width, height: s.height, downgraded, why: downgraded ? (s.note || `the gateway renders ${s.width}x${s.height}`) : null };
}

const gridlightAdapter = {
    deliverableFrame,
    meter: meterGridlight,
    id: 'gridlight',
    /*
     * The gateway's IMAGE models are the model catalog's (lib/model-catalog.js,
     * authored in gridlight): every catalog model whose capabilities include
     * image — FLUX.2 [dev] today. Read on every call rather than frozen, so a
     * catalog that gains a model offers it with nothing to edit here. Listed so
     * the confirmation dialog can offer it; whether the gateway has a worker up
     * to run it is the gateway's answer at generation time. Every other
     * capability is stated as null, "no list, passed through", as before.
     */
    get modelsByCapability() {
        let cat = null;
        try { cat = require('../model-catalog').current(); } catch (_) { /* no catalog: no list */ }
        const image = {};
        for (const m of (cat && cat.models) || []) {
            if (Array.isArray(m.capabilities) && m.capabilities.includes('image')) image[m.id] = { label: m.name || m.id };
        }
        const out = {};
        for (const c of Object.keys(ENDPOINTS)) out[c] = null;
        out.image = Object.keys(image).length ? image : null;
        return out;
    },
    /** Video streams step/total from the gateway; other endpoints return when done. */
    reportsProgress: 'percent',
    kind: 'generator',
    label: 'Gridlight',
    requiresKey: false, // uses GRIDLIGHT_API_KEY from env; no per-provider key entry
    // A local gateway whose image agent is swappable, so its real ceiling
    // depends on whatever model is loaded. Held at the strict default rather
    // than guessed upward: over-guessing produces a rejected request at the
    // provider, which is worse than trimming here where it can be reported.
    // The largest image this provider will actually produce. Asking for more
    // is a rejection that costs a generation, so the request is clamped here
    // and the clamp is reported rather than silently applied.
    // A swappable local agent whose real ceiling is unknowable from here. Held
    // conservative, on the same reasoning as its prompt and reference limits.
    // How a requested width/height is treated. Declared, never inferred \u2014 the
    // same rule promptLimit and maxReferenceImages follow, and for the same reason:
    // a size that reaches nothing produced a confident 2048x1152 arriving as 1376x768.
    sizeControl: 'ratio-only',
    sizeControlReason: 'A swappable local agent whose endpoint is unknowable from here. It is sent a ratio and no dimensions, so it chooses the pixels. Held at the strict reading rather than guessed upward: over-claiming reports a size the file does not have.',
    maxImagePixels: 1536 * 1536,
    promptLimit: 1000,
    // The gateway receives the payload verbatim, so a negative and a seed both
    // reach it natively — whether the local service acts on them is its own
    // business, but this adapter does not discard them.
    supportsNegativePrompt: 'native',
    supportsSeed: true,
    capabilities: Object.keys(ENDPOINTS),
    // The music workflows (MUS-009). A swappable local agent: only whole-cue
    // composition reaches an endpoint here, and nothing about the agent behind
    // it can be assumed, so the rest are unsupported until an endpoint exists.
    music: {
        music_compose: { status: 'available', models: [], limits: { min_ms: 1000, max_ms: 600000, models: [] }, source: 'https://github.com/gridlight/film-engine#providers' },
        music_parts: { status: 'unsupported', reason: 'the local gateway exposes /music for a whole cue and no endpoint for native parts' },
        music_separate: { status: 'unsupported', reason: 'the local gateway has no separation endpoint' },
        music_reference: { status: 'unsupported', reason: 'the local gateway\'s /music takes no reference audio or melody' },
        music_video: { status: 'unsupported', reason: 'the local gateway\'s /music takes no picture' },
        music_inpaint: { status: 'unsupported', reason: 'the local gateway has no in-context regeneration endpoint' },
    },

    /*
     * Named so the draft path can find a floor for it.
     *
     * A swappable local agent: what it actually runs is unknowable from here,
     * so it is held at the conservative floor rather than assumed to reach a
     * tier it may not have -- over-asking is a rejection that costs a
     * generation, the same asymmetry promptLimit and maxReferenceImages follow.
     */
    defaultModel: 'gridlight-video',
    // Gridlight receives the capability payload verbatim, including
    // reference_images and ip_adapter_image, so references survive the hop.
    /*
     * A swappable local agent: held at the strict default rather than guessed
     * upward, the same call its promptLimit makes. Over-guessing produces a
     * request the provider rejects, which is worse than sending fewer plates.
     */
    /*
     * What attaching a reference MEANS here.
     *
     * 'condition' — the reference informs a newly generated image.
     * 'edit'      — the reference IS the image, and the result is a modified
     *               copy of it. An edit cannot move the camera.
     *
     * A swappable local agent: reference_images / ip_adapter_image may condition or
     * may edit, and we cannot know which is wired up. Held at the conservative
     * answer, because over-trusting is what produced four copies of one street.
     *
     * The plate code assumed 'condition' for every provider, which is correct
     * on one adapter and structurally incapable on the others.
     */
    referenceMode: 'edit',
    // A swappable local agent: whether its /video endpoint accepts a last
    // frame is unknowable from here. Held at one, because over-claiming
    // sends a destination the service ignores and the director is told
    // nothing — the failure that maxReferenceImages already documents.
    // On the ADAPTER OBJECT, not merely exported from the module:
    // resolve() hands back this object, so a describer that lives only in
    // module.exports is invisible to every caller and the preview falls
    // back to reporting the payload as fact.
    describeVideoRequest,
    /*
     * A start and an end frame. No longer a guess: the gateway publishes what
     * each model takes (GET /media/capabilities), and a model that takes no
     * end keyframe has it dropped AND REPORTED before the request is sent —
     * the silent-destination failure this used to guard against cannot happen.
     */
    maxKeyframes: 2,
    /*
     * The package offered to the video builder: the gateway's documented
     * ceiling (8 keyframes, a 6-panel sheet). The chosen model's inputs[] cut
     * it down at generation time, every cut named. See lib/gridlight-video.js.
     */
    referenceContract: gridlightVideo.REFERENCE_CONTRACT,
    maxReferenceImages: 3,
    supportsReferenceImages: true,
    // reference_images / ip_adapter_image condition the result; no tag syntax.
    supportsReferenceTags: false,

    supports(capability) {
        return capability in ENDPOINTS;
    },

    /** Non-streaming generation → identical to callGridlight(endpoint, payload). */
    async generate(capability, payload, opts) {
        const endpoint = endpointFor(capability);
        if (!endpoint) return { ok: false, status: 400, error: `gridlight: unsupported capability '${capability}'` };
        if (capability === 'video') {
            /*
             * The gateway streams its own events; they reach the job row as
             * { percent, phase } — step over total when it sends both.
             */
            const o = Object.assign({}, opts || {});
            const theirs = o.onEvent;
            o.onEvent = evt => {
                const e = evt || {};
                const pct = Number(e.total) > 0 && Number(e.step) >= 0 ? (Number(e.step) / Number(e.total)) * 100 : undefined;
                require('../generation-progress').emit(o, { percent: pct, phase: e.phase || e.event });
                if (typeof theirs === 'function') return theirs(evt);
            };
            return (payload && payload.gridlight_production)
                ? gridlightVideo.generateProduction(payload, o)
                : gridlightVideo.generateVideo(payload, o);
        }
        return callGridlight(endpoint, payload, opts);
    },

    /** Streaming generation → identical to relayGridlightSSE(endpoint, payload, res, callbacks). */
    async generateStream(capability, payload, res, callbacks) {
        const endpoint = endpointFor(capability);
        if (!endpoint) return { ok: false, error: `gridlight: unsupported capability '${capability}'` };
        if (capability === 'llm') return streamGridlightLLM(endpoint, payload, res, callbacks);
        if (capability === 'video') return streamGridlightVideo(payload, res, callbacks);
        return relayGridlightSSE(endpoint, payload, res, callbacks);
    },

    async health(capability) {
        const endpoint = endpointFor(capability || 'image') || '/image';
        return checkEndpointHealth(endpoint);
    },
};

/**
 * What this adapter would send.
 *
 * Gridlight forwards the payload to a local service essentially verbatim — it
 * does not map models or clamp durations the way a hosted API must — so the
 * description is the payload, and saying so is the point: "this provider does
 * not transform your request" is a fact a director can act on, and it is
 * different from "we did not check".
 *
 * The model is reported as what will be ASKED FOR rather than what will run,
 * because a swappable local agent decides that for itself and this process
 * cannot know. Named as an unknown rather than guessed.
 */
/**
 * The stream road for video: the same client as generate(), with the
 * gateway's progress events relayed to the page as they arrive, and the MP4
 * handed to onComplete as bytes — so the route persists exactly what the
 * non-streaming road would.
 */
async function streamGridlightVideo(payload, res, callbacks) {
    const cb = callbacks || {};
    const send = obj => {
        if (res && !res.writableEnded && typeof res.write === 'function') {
            try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) { /* the page left */ }
        }
    };
    const controller = new AbortController();
    const onClose = () => controller.abort();
    if (res && typeof res.on === 'function') res.on('close', onClose);
    try {
        const result = await gridlightVideo.generateVideo(payload, {
            signal: controller.signal,
            onEvent: evt => {
                const { event, phase, step, total, total_steps, num_frames, resolution, retry_after } = evt;
                send({ type: 'progress', event, phase, step, total: total || total_steps, num_frames, resolution, retry_after });
                if (cb.onProgress) cb.onProgress(evt);
            },
        });
        if (!result.ok) {
            if (cb.onError) cb.onError({ error: result.error, status: result.status, code: result.code });
            return { ok: false, finalData: null, error: result.error, status: result.status, code: result.code };
        }
        if (cb.onComplete) cb.onComplete(result.data);
        return { ok: true, finalData: result.data, result };
    } finally {
        if (res && typeof res.removeListener === 'function') res.removeListener('close', onClose);
    }
}

function describeVideoRequest(payload) {
    const p = payload || {};
    const notes = ['This is the local Gridlight service, which forwards the request as supplied. '
        + 'Which model actually runs is decided by that service, not here.'];
    if (!p.init_image && !p.image_url) {
        notes.push('No image is attached, so this generates from words alone.');
    }
    // What the gateway's own manifest says this request becomes, when it has
    // been read: which references travel, which are dropped and why.
    const gateway = gridlightVideo.describe(p);
    if (gateway.known && gateway.model) notes.push(`The gateway will run ${gateway.model}.`);
    if (gateway.references_dropped && gateway.references_dropped.length) {
        notes.push(`${gateway.references_dropped.length} reference(s) will not be sent: `
            + gateway.references_dropped.map(d => `${d.kind} — ${d.reason}`).join('; '));
    }
    if (!gateway.known) notes.push(gateway.note);
    return {
        provider: 'gridlight',
        gateway,
        mode: gateway.mode || ((p.init_image || p.image_url) ? 'image_to_video' : 'text_to_video'),
        model: gateway.model || p.model || DEFAULT_VIDEO_MODEL,
        model_is_requested_not_resolved: !gateway.model,
        duration_s: Number(p.duration_s !== undefined ? p.duration_s : p.duration) || null,
        ratio: (p.width && p.height) ? `${p.width}:${p.height}` : null,
        prompt: p.prompt || '',
        has_image: !!(p.init_image || p.image_url),
        seed: p.seed === undefined ? null : p.seed,
        notes,
    };
}

module.exports = {
    describeVideoRequest, adapter: gridlightAdapter, gridlightAdapter, endpointFor, ENDPOINTS };
