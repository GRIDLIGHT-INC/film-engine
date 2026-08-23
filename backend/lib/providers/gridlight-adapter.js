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

module.exports = { adapter: gridlightAdapter, gridlightAdapter, endpointFor, ENDPOINTS };
