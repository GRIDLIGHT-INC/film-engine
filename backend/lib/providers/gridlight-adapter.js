/**
 * Gridlight provider adapter.
 *
 * Wraps the existing gridlight-client (callGridlight / relayGridlightSSE) as a
 * GeneratorAdapter. This is the DEFAULT provider, so routing a call through it
 * is behavior-identical to calling gridlight-client directly — the whole point
 * of Phase 1 is that nothing changes until a project opts into another provider.
 */

const { callGridlight, relayGridlightSSE, checkEndpointHealth } = require('../gridlight-client');

// capability -> Gridlight endpoint path (mirrors the per-domain *_ENDPOINT constants).
const ENDPOINTS = {
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

const gridlightAdapter = {
    id: 'gridlight',
    kind: 'generator',
    label: 'Gridlight',
    requiresKey: false, // uses GRIDLIGHT_API_KEY from env; no per-provider key entry
    capabilities: Object.keys(ENDPOINTS),

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
        return relayGridlightSSE(endpoint, payload, res, callbacks);
    },

    async health(capability) {
        const endpoint = endpointFor(capability || 'image') || '/image';
        return checkEndpointHealth(endpoint);
    },
};

module.exports = { adapter: gridlightAdapter, gridlightAdapter, endpointFor, ENDPOINTS };
