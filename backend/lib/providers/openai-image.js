/**
 * OpenAI image provider adapter (gpt-image-1).
 *
 * Capability:
 *   image — text-to-image generation via the OpenAI Images API.
 *
 * Credentials are read server-side through providers/credentials.js
 * (OPENAI_API_KEY env, or a key saved in Provider Settings).
 * Base URL is overridable via OPENAI_BASE_URL (Azure/proxy/mock).
 */

const { getCredential } = require('./credentials');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-image-1';
const VALID_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
const VALID_QUALITY = ['low', 'medium', 'high', 'auto'];

function supports(capability) {
    return capability === 'image';
}

function missingKey() {
    return {
        ok: false,
        status: 401,
        error: 'openai: missing API key. Set OPENAI_API_KEY or save a credential in Provider Settings.',
    };
}

function normalizeError(status, body) {
    if (body && typeof body === 'object') {
        if (body.error && body.error.message) return `openai ${status}: ${body.error.message}`;
        if (body.message) return `openai ${status}: ${body.message}`;
    }
    return `openai ${status}: ${String(body || 'request failed')}`;
}

async function parseErrorResponse(response) {
    const text = await response.text();
    try { return JSON.parse(text); } catch (_) { return text; }
}

/** Map a canonical image payload (gridlight-shaped) to an OpenAI Images request. */
function buildImageRequest(payload) {
    const baseUrl = (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const p = payload || {};

    let prompt = String(p.prompt || '').trim();
    // OpenAI has no negative_prompt; fold it into the prompt so intent survives.
    if (p.negative_prompt) prompt = `${prompt}\n\nAvoid: ${p.negative_prompt}`;

    // Map width/height → a supported size; honor an explicit size if valid.
    let size = 'auto';
    if (p.size && VALID_SIZES.includes(p.size)) {
        size = p.size;
    } else if (p.width && p.height) {
        if (p.width > p.height) size = '1536x1024';
        else if (p.height > p.width) size = '1024x1536';
        else size = '1024x1024';
    } else {
        size = '1024x1024';
    }

    const quality = VALID_QUALITY.includes(p.quality) ? p.quality : 'high';
    const model = p.openai_model || (String(p.model || '').startsWith('gpt-image') ? p.model : DEFAULT_MODEL);

    return {
        url: `${baseUrl}/images/generations`,
        body: { model, prompt, size, quality, n: 1 },
        model,
        size,
    };
}

async function callOpenAI(request, apiKey, opts) {
    const controller = new AbortController();
    const timeout = (opts && opts.timeout) || 300000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(request.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(request.body),
            signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
            const body = await parseErrorResponse(response);
            return { ok: false, status: response.status, error: normalizeError(response.status, body) };
        }

        const json = await response.json();
        const item = json && json.data && json.data[0];
        if (!item || (!item.b64_json && !item.url)) {
            return { ok: false, status: 502, error: 'openai: response contained no image data' };
        }

        // gpt-image-1 returns b64_json; decode to bytes so downstream saveFile works.
        let data = null;
        if (item.b64_json) {
            data = Buffer.from(item.b64_json, 'base64');
        }

        return {
            ok: true,
            status: response.status,
            data: data || { image_url: item.url },
            contentType: 'image/png',
            provider: 'openai',
            provider_model: request.model,
            provider_job_id: (json && json.id) || '',
            meta: { size: request.size, format: 'png', revised_prompt: item.revised_prompt || '' },
        };
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            return { ok: false, status: 504, error: `openai: request timed out after ${timeout}ms` };
        }
        return { ok: false, status: 500, error: `openai: ${err.message}` };
    }
}

const adapter = {
    id: 'openai',
    kind: 'generator',
    label: 'OpenAI (gpt-image)',
    requiresKey: true,
    capabilities: ['image'],

    supports,

    async generate(capability, payload, opts) {
        if (!supports(capability)) {
            return { ok: false, status: 400, error: `openai: unsupported capability '${capability}'` };
        }
        const { apiKey } = getCredential('openai');
        if (!apiKey) return missingKey();

        const request = buildImageRequest(payload || {});
        if (!request.body.prompt) return { ok: false, status: 400, error: 'openai: prompt is required' };
        return callOpenAI(request, apiKey, opts);
    },
};

module.exports = { adapter, buildImageRequest };
