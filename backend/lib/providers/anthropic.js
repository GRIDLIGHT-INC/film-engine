/**
 * Anthropic provider adapter.
 *
 * Capabilities:
 *   llm — text reasoning   POST /v1/messages
 *
 * Raw fetch rather than @anthropic-ai/sdk, matching elevenlabs.js and
 * runway.js: the Messages API is one endpoint, and the backend has exactly one
 * dependency (better-sqlite3). Taking an SDK for a single adapter would make it
 * the odd one out and reverse a deliberate stance (ADR-002).
 *
 * Auth is `x-api-key` plus a pinned `anthropic-version` — NOT a Bearer token.
 * Credentials are read server-side through providers/credentials.js.
 *
 * The system prompt travels in its own `system` field rather than being
 * concatenated into the question. Gridlight's /chat/intelligent accepts a
 * `system_prompt` too, so callers that split them get better prompting on both
 * providers; a caller that only sets `question` still works unchanged.
 */

const { getCredential } = require('./credentials');

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_MODEL = 'claude-opus-5';
const API_VERSION = '2023-06-01';

// Non-streaming default. Above roughly this, requests risk an HTTP timeout
// before the response completes, which is why the streaming path allows more.
const DEFAULT_MAX_TOKENS = 16000;
const STREAM_MAX_TOKENS = 32000;

const BASE_URL = () => process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL;
const MODEL = () => process.env.ANTHROPIC_LLM_MODEL || DEFAULT_MODEL;

function supports(capability) {
    return capability === 'llm';
}

function missingKey() {
    return {
        ok: false,
        status: 401,
        error: 'anthropic: missing API key. Set ANTHROPIC_API_KEY or save a credential in Provider Settings.',
    };
}

function normalizeError(status, body) {
    if (body && typeof body === 'object') {
        if (body.error && body.error.message) return `anthropic ${status}: ${body.error.message}`;
        if (body.error) return `anthropic ${status}: ${JSON.stringify(body.error)}`;
        if (body.message) return `anthropic ${status}: ${body.message}`;
    }
    return `anthropic ${status}: ${String(body || 'request failed')}`;
}

/**
 * Our payload -> a Messages API request body.
 *
 * `question` is the user turn. `system` (or `system_prompt`) is lifted out
 * rather than prepended, which is what the field is for.
 */
function buildMessagesRequest(payload, { stream = false } = {}) {
    const p = payload || {};
    const question = typeof p.question === 'string' ? p.question
        : (typeof p.prompt === 'string' ? p.prompt : '');

    const body = {
        model: p.model || MODEL(),
        max_tokens: Number(p.max_tokens) > 0
            ? Number(p.max_tokens)
            : (stream ? STREAM_MAX_TOKENS : DEFAULT_MAX_TOKENS),
        messages: [{ role: 'user', content: question }],
    };

    const system = p.system || p.system_prompt;
    if (system && String(system).trim()) body.system = String(system);
    if (stream) body.stream = true;

    return body;
}

/** Concatenate every text block. Thinking blocks carry no text by default. */
function extractText(data) {
    if (!data || !Array.isArray(data.content)) return '';
    return data.content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('');
}

function headers(apiKey) {
    return {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
    };
}

/**
 * A refusal is an HTTP 200 with an empty or partial `content`, not an error
 * status. Reading content[0] unconditionally would hand the caller silence.
 */
function refusalResult(data) {
    const category = (data.stop_details && data.stop_details.category) || 'unspecified';
    return {
        ok: false,
        status: 200,
        refused: true,
        error: `anthropic: request declined by safety classifiers (${category})`,
        provider: 'anthropic',
        provider_model: data.model || MODEL(),
    };
}

async function callAnthropic(body, apiKey, opts = {}) {
    let response;
    try {
        response = await fetch(`${BASE_URL()}/messages`, {
            method: 'POST',
            headers: headers(apiKey),
            body: JSON.stringify(body),
            signal: opts.signal,
        });
    } catch (err) {
        return { ok: false, status: 502, error: `anthropic request failed: ${err.message}` };
    }

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }

    if (!response.ok) {
        return { ok: false, status: response.status, error: normalizeError(response.status, data) };
    }
    if (data && data.stop_reason === 'refusal') return refusalResult(data);

    const answer = extractText(data);
    return {
        ok: true,
        status: 200,
        // `data.answer` is the shape llm-client's extractAnswer reads.
        data: { answer, raw: data },
        answer,
        provider: 'anthropic',
        provider_model: (data && data.model) || body.model,
        usage: (data && data.usage) || null,
    };
}

/**
 * SSE: accumulate `content_block_delta` -> `text_delta`.
 *
 * Only text deltas are forwarded — thinking blocks stream with empty text
 * under the default display setting, so relaying them would emit nothing and
 * look like a stall.
 */
async function streamAnthropic(body, apiKey, callbacks = {}) {
    const cb = callbacks || {};
    let response;
    try {
        response = await fetch(`${BASE_URL()}/messages`, {
            method: 'POST',
            headers: headers(apiKey),
            body: JSON.stringify(body),
        });
    } catch (err) {
        const error = `anthropic request failed: ${err.message}`;
        if (cb.onError) cb.onError({ error });
        return { ok: false, finalData: null, error };
    }

    if (!response.ok) {
        const text = await response.text();
        let parsed; try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
        const error = normalizeError(response.status, parsed);
        if (cb.onError) cb.onError({ error });
        return { ok: false, finalData: null, error };
    }

    let accumulated = '';
    let refused = false;
    try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (!raw || raw === '[DONE]') continue;

                let evt;
                try { evt = JSON.parse(raw); } catch (_) { continue; }

                if (evt.type === 'content_block_delta'
                    && evt.delta && evt.delta.type === 'text_delta'
                    && typeof evt.delta.text === 'string') {
                    accumulated += evt.delta.text;
                    if (cb.onToken) cb.onToken(evt.delta.text);
                } else if (evt.type === 'message_delta'
                    && evt.delta && evt.delta.stop_reason === 'refusal') {
                    refused = true;
                } else if (evt.type === 'error') {
                    const error = normalizeError(200, evt);
                    if (cb.onError) cb.onError({ error });
                    return { ok: false, finalData: null, error };
                }
            }
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            return { ok: false, finalData: null, error: 'client_disconnected', aborted: true };
        }
        const error = `anthropic stream failed: ${err.message}`;
        if (cb.onError) cb.onError({ error });
        return { ok: false, finalData: null, error };
    }

    if (refused) {
        const error = 'anthropic: request declined by safety classifiers';
        if (cb.onError) cb.onError({ error });
        return { ok: false, finalData: null, error };
    }

    if (cb.onComplete) cb.onComplete({ answer: accumulated });
    return { ok: true, finalData: { answer: accumulated } };
}

const adapter = {
    id: 'anthropic',
    kind: 'generator',
    label: 'Anthropic (Claude)',
    requiresKey: true,
    capabilities: ['llm'],

    // Required whenever requiresKey is true: without it Provider Settings has
    // nothing to render, so the adapter appears in the list with no way to
    // enter the key it needs.
    connection: {
        instructions: 'Anthropic has no OAuth for API access \u2014 paste an API key. Click "Get your key" to open the Anthropic Console.',
        helpUrl: 'https://console.anthropic.com/settings/keys',
    },

    supports,

    async generate(capability, payload, opts = {}) {
        if (!supports(capability)) {
            return { ok: false, status: 400, error: `anthropic: unsupported capability '${capability}'` };
        }
        const { apiKey } = getCredential('anthropic');
        if (!apiKey) return missingKey();

        const body = buildMessagesRequest(payload, { stream: false });
        if (!body.messages[0].content) {
            return { ok: false, status: 400, error: 'anthropic: question is required' };
        }
        return callAnthropic(body, apiKey, opts);
    },

    async generateStream(capability, payload, res, callbacks) {
        if (!supports(capability)) {
            return { ok: false, finalData: null, error: `anthropic: unsupported capability '${capability}'` };
        }
        const { apiKey } = getCredential('anthropic');
        if (!apiKey) {
            const { error } = missingKey();
            if (callbacks && callbacks.onError) callbacks.onError({ error });
            return { ok: false, finalData: null, error };
        }

        const body = buildMessagesRequest(payload, { stream: true });
        if (!body.messages[0].content) {
            const error = 'anthropic: question is required';
            if (callbacks && callbacks.onError) callbacks.onError({ error });
            return { ok: false, finalData: null, error };
        }
        return streamAnthropic(body, apiKey, callbacks);
    },
};

module.exports = {
    adapter,
    buildMessagesRequest,
    extractText,
    API_VERSION,
    DEFAULT_MODEL,
};
