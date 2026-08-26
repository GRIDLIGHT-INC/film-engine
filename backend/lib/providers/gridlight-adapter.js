/**
 * Gridlight provider adapter.
 *
 * Wraps the existing gridlight-client (callGridlight / relayGridlightSSE) as a
 * GeneratorAdapter. This is the DEFAULT provider, so routing a call through it
 * is behavior-identical to calling gridlight-client directly — the whole point
 * of Phase 1 is that nothing changes until a project opts into another provider.
 */

const { callGridlight, relayGridlightSSE, checkEndpointHealth, GRIDLIGHT_URL, GRIDLIGHT_API_KEY } = require('../gridlight-client');

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

const gridlightAdapter = {
    meter: meterGridlight,
    id: 'gridlight',
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
    maxImagePixels: 1536 * 1536,
    promptLimit: 1000,
    // The gateway receives the payload verbatim, so a negative and a seed both
    // reach it natively — whether the local service acts on them is its own
    // business, but this adapter does not discard them.
    supportsNegativePrompt: 'native',
    supportsSeed: true,
    capabilities: Object.keys(ENDPOINTS),
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
    maxKeyframes: 1,
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
        return callGridlight(endpoint, payload, opts);
    },

    /** Streaming generation → identical to relayGridlightSSE(endpoint, payload, res, callbacks). */
    async generateStream(capability, payload, res, callbacks) {
        const endpoint = endpointFor(capability);
        if (!endpoint) return { ok: false, error: `gridlight: unsupported capability '${capability}'` };
        if (capability === 'llm') return streamGridlightLLM(endpoint, payload, res, callbacks);
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
function describeVideoRequest(payload) {
    const p = payload || {};
    const notes = ['This is the local Gridlight service, which forwards the request as supplied. '
        + 'Which model actually runs is decided by that service, not here.'];
    if (!p.init_image && !p.image_url) {
        notes.push('No image is attached, so this generates from words alone.');
    }
    return {
        provider: 'gridlight',
        mode: (p.init_image || p.image_url) ? 'image_to_video' : 'text_to_video',
        model: p.model || DEFAULT_VIDEO_MODEL,
        model_is_requested_not_resolved: true,
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
