/**
 * OpenAI provider adapter.
 *
 * Capabilities:
 *   llm   — text generation via the OpenAI Responses API.
 *   image — text-to-image generation via the OpenAI Images API.
 *
 * Credentials are read server-side through providers/credentials.js
 * (OPENAI_API_KEY env, or a key saved in Provider Settings).
 * Base URL is overridable via OPENAI_BASE_URL (Azure/proxy/mock).
 */

const { getCredential } = require('./credentials');
const fs = require('fs');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_IMAGE_MODEL = 'gpt-image-1';
const DEFAULT_LLM_MODEL = process.env.OPENAI_LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1';
const VALID_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
const VALID_QUALITY = ['low', 'medium', 'high', 'auto'];

function supports(capability) {
    return capability === 'image' || capability === 'llm';
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
    const model = p.openai_model || (String(p.model || '').startsWith('gpt-image') ? p.model : DEFAULT_IMAGE_MODEL);

    const refs = Array.isArray(p.reference_images) ? p.reference_images : [];
    const localRefs = refs
        .map(ref => ref && ref.file_path)
        .filter(filePath => filePath && fs.existsSync(filePath))
        .slice(0, 8);

    if (localRefs.length > 0) {
        const form = new FormData();
        form.append('model', model);
        form.append('prompt', prompt);
        form.append('size', size);
        form.append('quality', quality);
        form.append('n', '1');
        for (const filePath of localRefs) {
            const bytes = fs.readFileSync(filePath);
            const mime = filePath.toLowerCase().endsWith('.webp') ? 'image/webp'
                : filePath.toLowerCase().endsWith('.jpg') || filePath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg'
                    : 'image/png';
            form.append('image[]', new Blob([bytes], { type: mime }), filePath.split(/[\\/]/).pop() || 'reference.png');
        }
        return {
            url: `${baseUrl}/images/edits`,
            form,
            model,
            size,
            referenceCount: localRefs.length,
            referencePaths: localRefs,
        };
    }

    return {
        url: `${baseUrl}/images/generations`,
        body: { model, prompt, size, quality, n: 1 },
        model,
        size,
        referenceCount: 0,
    };
}

function normalizeHistory(history) {
    const messages = [];
    if (!Array.isArray(history)) return messages;
    for (const item of history) {
        if (!item || typeof item !== 'object') continue;
        if (item.role && item.content) {
            const role = item.role === 'assistant' ? 'assistant' : 'user';
            messages.push({ role, content: String(item.content) });
            continue;
        }
        if (item.question) messages.push({ role: 'user', content: String(item.question) });
        if (item.answer) messages.push({ role: 'assistant', content: String(item.answer) });
    }
    return messages;
}

function buildLLMRequest(payload) {
    const baseUrl = (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const p = payload || {};
    const question = String(p.question || p.prompt || '').trim();
    const systemPrompt = String(p.system_prompt || '').trim();
    const input = [];
    if (systemPrompt) input.push({ role: 'system', content: systemPrompt });
    input.push(...normalizeHistory(p.conversation_history));
    if (question) input.push({ role: 'user', content: question });

    return {
        url: `${baseUrl}/responses`,
        body: {
            model: p.openai_model || p.model || DEFAULT_LLM_MODEL,
            input,
            stream: !!p.stream,
        },
    };
}

function extractResponseText(json) {
    if (!json || typeof json !== 'object') return '';
    if (typeof json.output_text === 'string') return json.output_text;
    const out = Array.isArray(json.output) ? json.output : [];
    const parts = [];
    for (const item of out) {
        const content = Array.isArray(item && item.content) ? item.content : [];
        for (const block of content) {
            if (!block) continue;
            if (typeof block.text === 'string') parts.push(block.text);
            else if (typeof block.output_text === 'string') parts.push(block.output_text);
        }
    }
    return parts.join('');
}

async function callOpenAILLM(request, apiKey, opts) {
    const controller = new AbortController();
    const timeout = (opts && opts.timeout) || 300000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(request.url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
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
        const answer = extractResponseText(json);
        return {
            ok: true,
            status: response.status,
            data: { answer, response: answer, message: answer, raw: json },
            contentType: 'application/json',
            provider: 'openai',
            provider_model: request.body.model,
            provider_job_id: json.id || '',
        };
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            return { ok: false, status: 504, error: `openai: request timed out after ${timeout}ms` };
        }
        return { ok: false, status: 500, error: `openai: ${err.message}` };
    }
}

async function streamOpenAILLM(request, apiKey, res, callbacks) {
    const cb = callbacks || {};
    const controller = new AbortController();
    const onClose = () => controller.abort();
    if (res && typeof res.on === 'function') res.on('close', onClose);

    try {
        const response = await fetch(request.url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ...request.body, stream: true }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const body = await parseErrorResponse(response);
            const error = normalizeError(response.status, body);
            if (cb.onError) cb.onError({ error });
            return { ok: false, error };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let currentEvent = '';
        let finalData = null;

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

                const type = data.type || currentEvent;
                if (type === 'response.output_text.delta' && data.delta) {
                    accumulated += data.delta;
                    if (cb.onToken) cb.onToken(data.delta);
                } else if (type === 'response.completed' && data.response) {
                    finalData = data.response;
                } else if (type === 'response.failed') {
                    const error = data.response && data.response.error && data.response.error.message
                        ? data.response.error.message
                        : 'openai: response failed';
                    if (cb.onError) cb.onError({ error });
                    return { ok: false, error };
                }
                currentEvent = '';
            }
        }

        if (!accumulated && finalData) accumulated = extractResponseText(finalData);
        if (cb.onComplete) cb.onComplete({ answer: accumulated, raw: finalData });
        return { ok: true, finalData: { answer: accumulated, raw: finalData } };
    } catch (err) {
        if (err.name === 'AbortError') return { ok: false, finalData: null, error: 'client_disconnected', aborted: true };
        const error = `openai: ${err.message}`;
        if (cb.onError) cb.onError({ error });
        return { ok: false, finalData: null, error };
    } finally {
        if (res && typeof res.removeListener === 'function') res.removeListener('close', onClose);
    }
}

async function callOpenAI(request, apiKey, opts) {
    const controller = new AbortController();
    const timeout = (opts && opts.timeout) || 300000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(request.url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                ...(request.form ? {} : { 'Content-Type': 'application/json' }),
            },
            body: request.form || JSON.stringify(request.body),
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
            meta: { size: request.size, format: 'png', revised_prompt: item.revised_prompt || '', reference_count: request.referenceCount || 0 },
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
    label: 'OpenAI',
    requiresKey: true,

        // The Images API documents a 4000-character prompt for gpt-image-1.
    promptLimit: 4000,
    capabilities: ['llm', 'image'],
    // The image builder reads p.reference_images and forwards them as edit
    // inputs, so a tag has a picture behind it.
    supportsReferenceImages: true,
    // Forwarded as edit inputs; there is no tag syntax to address them with.
    supportsReferenceTags: false,

    connection: {
        instructions: 'OpenAI has no OAuth for API access — paste an API key. Click "Get your key" to open the OpenAI keys page, create a key, and paste it here.',
        helpUrl: 'https://platform.openai.com/api-keys',
    },

    supports,

    async generate(capability, payload, opts) {
        if (!supports(capability)) {
            return { ok: false, status: 400, error: `openai: unsupported capability '${capability}'` };
        }
        const { apiKey } = getCredential('openai');
        if (!apiKey) return missingKey();

        if (capability === 'llm') {
            const request = buildLLMRequest(payload || {});
            if (!request.body.input.some(m => m.role === 'user' && m.content)) {
                return { ok: false, status: 400, error: 'openai: question is required' };
            }
            return callOpenAILLM(request, apiKey, opts);
        }

        const request = buildImageRequest(payload || {});
        const promptText = request.form ? request.form.get('prompt') : (request.body && request.body.prompt);
        if (!promptText) return { ok: false, status: 400, error: 'openai: prompt is required' };
        return callOpenAI(request, apiKey, opts);
    },

    async generateStream(capability, payload, res, callbacks) {
        if (capability !== 'llm') {
            return { ok: false, error: `openai: unsupported streaming capability '${capability}'` };
        }
        const { apiKey } = getCredential('openai');
        if (!apiKey) {
            const err = missingKey();
            if (callbacks && callbacks.onError) callbacks.onError({ error: err.error });
            return { ok: false, error: err.error };
        }
        const request = buildLLMRequest({ ...(payload || {}), stream: true });
        return streamOpenAILLM(request, apiKey, res, callbacks);
    },
};

module.exports = { adapter, buildImageRequest, buildLLMRequest, extractResponseText };
