/**
 * ElevenLabs provider adapter.
 *
 * Capabilities:
 *   voice — text-to-speech dialogue clips
 *   sfx   — text-to-sound-effects clips
 *
 * Credentials are read server-side through providers/credentials.js.
 */

const { getCredential } = require('./credentials');

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

function supports(capability) {
    return capability === 'voice' || capability === 'sfx';
}

function missingKey() {
    return {
        ok: false,
        status: 401,
        error: 'elevenlabs: missing API key. Set ELEVENLABS_API_KEY or save a credential in Provider Settings.',
    };
}

function normalizeError(prefix, status, body) {
    if (body && typeof body === 'object') {
        if (body.detail && typeof body.detail === 'object' && body.detail.message) return `${prefix} ${status}: ${body.detail.message}`;
        if (body.detail) return `${prefix} ${status}: ${body.detail}`;
        if (body.message) return `${prefix} ${status}: ${body.message}`;
        if (body.error) return `${prefix} ${status}: ${body.error}`;
    }
    return `${prefix} ${status}: ${String(body || 'request failed')}`;
}

async function parseErrorResponse(response) {
    const text = await response.text();
    try { return JSON.parse(text); } catch (_) { return text; }
}

function normalizeOutputFormat(payload) {
    const requested = payload.output_format || '';
    if (String(requested).startsWith('mp3_') || String(requested).startsWith('pcm_')) return requested;
    return DEFAULT_OUTPUT_FORMAT;
}

function buildVoiceRequest(payload) {
    const baseUrl = (process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const text = payload.text || payload.prompt || '';
    const voiceId = payload.voice_id || payload.elevenlabs_voice_id || DEFAULT_VOICE_ID;
    const modelId = payload.model && String(payload.model).startsWith('eleven')
        ? payload.model
        : DEFAULT_TTS_MODEL;
    const outputFormat = normalizeOutputFormat(payload);

    const body = {
        text,
        model_id: modelId,
        voice_settings: {
            stability: typeof payload.stability === 'number' ? payload.stability : 0.5,
            similarity_boost: typeof payload.similarity_boost === 'number' ? payload.similarity_boost : 0.75,
        },
    };

    if (payload.speed && payload.speed !== 1) body.voice_settings.speed = payload.speed;
    if (payload.language && payload.language !== 'en') body.language_code = payload.language;

    return {
        url: `${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
        body,
        model: modelId,
        voiceId,
        outputFormat,
        mimeType: outputFormat.startsWith('pcm_') ? 'audio/wav' : 'audio/mpeg',
        format: outputFormat.startsWith('pcm_') ? 'wav' : 'mp3',
    };
}

function buildSfxRequest(payload) {
    const baseUrl = (process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const text = payload.text || payload.prompt || payload.description || '';
    const durationSeconds = Number(payload.duration_s || payload.duration_seconds || payload.duration || 3);
    const safeDuration = Math.max(0.5, Math.min(30, durationSeconds));
    return {
        url: `${baseUrl}/sound-generation`,
        body: {
            text,
            duration_seconds: safeDuration,
            prompt_influence: typeof payload.prompt_influence === 'number' ? payload.prompt_influence : 0.3,
        },
        model: 'elevenlabs-sound-effects',
        mimeType: 'audio/mpeg',
        format: 'mp3',
    };
}

async function callElevenLabs(request, apiKey, opts) {
    const controller = new AbortController();
    const timeout = (opts && opts.timeout) || 300000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(request.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': request.mimeType || 'audio/mpeg',
                'xi-api-key': apiKey,
            },
            body: JSON.stringify(request.body),
            signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
            const body = await parseErrorResponse(response);
            return { ok: false, status: response.status, error: normalizeError('elevenlabs', response.status, body) };
        }

        const data = Buffer.from(await response.arrayBuffer());
        return {
            ok: true,
            status: response.status,
            data,
            contentType: response.headers.get('content-type') || request.mimeType || 'audio/mpeg',
            provider: 'elevenlabs',
            provider_model: request.model,
            provider_job_id: response.headers.get('request-id') || response.headers.get('x-request-id') || '',
            meta: {
                voice_id: request.voiceId || '',
                output_format: request.outputFormat || '',
                format: request.format,
            },
        };
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            return { ok: false, status: 504, error: `elevenlabs: request timed out after ${timeout}ms` };
        }
        return { ok: false, status: 500, error: `elevenlabs: ${err.message}` };
    }
}

const adapter = {
    id: 'elevenlabs',
    kind: 'generator',
    label: 'ElevenLabs',
    requiresKey: true,
    capabilities: ['voice', 'sfx'],

    supports,

    async generate(capability, payload, opts) {
        if (!supports(capability)) {
            return { ok: false, status: 400, error: `elevenlabs: unsupported capability '${capability}'` };
        }
        const { apiKey } = getCredential('elevenlabs');
        if (!apiKey) return missingKey();

        const request = capability === 'voice' ? buildVoiceRequest(payload || {}) : buildSfxRequest(payload || {});
        if (!request.body.text) return { ok: false, status: 400, error: 'elevenlabs: text is required' };
        return callElevenLabs(request, apiKey, opts);
    },

    async generateStream(capability, payload, res, callbacks) {
        // ElevenLabs streams audio bytes, but Film Engine's current voice SSE
        // route emits progress events per dialogue line. Generate the audio and
        // let the route relay normalized progress/status events.
        const result = await this.generate(capability, payload, {});
        if (!result.ok && callbacks && callbacks.onError) callbacks.onError({ error: result.error });
        if (result.ok && callbacks && callbacks.onComplete) callbacks.onComplete(result);
        return result.ok
            ? { ok: true, finalData: result }
            : { ok: false, error: result.error };
    },
};

module.exports = {
    adapter,
    buildVoiceRequest,
    buildSfxRequest,
    normalizeOutputFormat,
};
