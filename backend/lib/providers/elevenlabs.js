/**
 * ElevenLabs provider adapter.
 *
 * Capabilities:
 *   voice   — text-to-speech dialogue clips      POST /text-to-speech/:voiceId
 *   sfx     — one-shot sound effects             POST /sound-generation
 *   ambient — seamless looping beds              POST /sound-generation (loop)
 *   music   — scored cues                        POST /music
 *
 * All three answer with raw audio bytes rather than a URL, so results come back
 * as a Buffer and persistProviderMedia writes them straight to disk.
 *
 * Credentials are read server-side through providers/credentials.js.
 */

const { getCredential } = require('./credentials');

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';
const DEFAULT_MUSIC_MODEL = 'music_v2';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

// Documented bounds for POST /music.
const MUSIC_MIN_MS = 3000;
const MUSIC_MAX_MS = 600000;
const MUSIC_DEFAULT_MS = 30000;

// Documented bounds for POST /sound-generation. `loop` requires the v2 model.
const SFX_MIN_SECONDS = 0.5;
const SFX_MAX_SECONDS = 30;
const LOOPABLE_SFX_MODEL = 'eleven_text_to_sound_v2';

function supports(capability) {
    return capability === 'voice' || capability === 'sfx'
        || capability === 'music' || capability === 'ambient';
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

    /*
     * The expressiveness dial, and the line's place in the scene.
     *
     * `style` is ElevenLabs' own 0-1 exaggeration control and was never sent,
     * so a payload could carry the writer's direction and change nothing about
     * the delivery. `previous_text` / `next_text` are used for prosody and are
     * NOT spoken: they let a line be delivered in the flow of the exchange
     * rather than read in isolation, which on a sixty-eight line scene is the
     * difference between a conversation and a list.
     *
     * All three are sent only when asked for, so a project that sets no
     * delivery produces byte-identical requests to the ones it always did.
     */
    if (typeof payload.style === 'number') body.voice_settings.style = payload.style;
    if (payload.use_speaker_boost !== undefined) {
        body.voice_settings.use_speaker_boost = !!payload.use_speaker_boost;
    }
    if (payload.previous_text) body.previous_text = String(payload.previous_text);
    if (payload.next_text) body.next_text = String(payload.next_text);

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

function soundGenerationUrl() {
    return `${(process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')}/sound-generation`;
}

function clampSfxDuration(payload, fallback) {
    const requested = Number(payload.duration_s || payload.duration_seconds || payload.duration || fallback);
    return Math.max(SFX_MIN_SECONDS, Math.min(SFX_MAX_SECONDS, requested));
}

function buildSfxRequest(payload) {
    return {
        url: soundGenerationUrl(),
        body: {
            text: payload.text || payload.prompt || payload.description || '',
            duration_seconds: clampSfxDuration(payload, 3),
            prompt_influence: typeof payload.prompt_influence === 'number' ? payload.prompt_influence : 0.3,
        },
        model: 'elevenlabs-sound-effects',
        mimeType: 'audio/mpeg',
        format: 'mp3',
    };
}

/**
 * Build an ambient bed request.
 *
 * Ambient goes to the sound-effects endpoint rather than /music on purpose:
 * room tone, rain and traffic are sound effects, and a music model renders them
 * as composed drones that sit wrong under dialogue.
 *
 * The endpoint caps at 30s, which is shorter than most scenes — so the bed is
 * generated as a seamless loop and tiled to length at mix time. `loop` is only
 * honoured on eleven_text_to_sound_v2, so the model is named explicitly rather
 * than left to the endpoint default.
 */
function buildAmbientRequest(payload) {
    return {
        url: soundGenerationUrl(),
        body: {
            text: payload.text || payload.prompt || payload.description || '',
            duration_seconds: clampSfxDuration(payload, SFX_MAX_SECONDS),
            prompt_influence: typeof payload.prompt_influence === 'number' ? payload.prompt_influence : 0.3,
            loop: true,
            model_id: LOOPABLE_SFX_MODEL,
        },
        model: LOOPABLE_SFX_MODEL,
        mimeType: 'audio/mpeg',
        format: 'mp3',
    };
}

/**
 * Build a POST /music request from a canonical music payload.
 *
 * Two mismatches with the rest of the pipeline are worth naming:
 *
 * Length is milliseconds here, while the scene card and the sfx endpoint both
 * speak seconds — passing `duration_seconds` through would be silently ignored
 * and every cue would come back at whatever length the model felt like.
 *
 * `model` arrives defaulted to Gridlight's `musicgen-large` from
 * buildMusicPrompt, which is not an ElevenLabs model id. Forwarding it would
 * fail the request, so only a real `music_*` id is honoured.
 */
function buildMusicRequest(payload) {
    const baseUrl = (process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const prompt = payload.prompt || payload.text || payload.description || '';
    const outputFormat = normalizeOutputFormat(payload);

    const requestedS = Number(payload.duration_s || payload.duration_seconds || payload.duration || 0);
    const lengthMs = requestedS > 0
        ? Math.max(MUSIC_MIN_MS, Math.min(MUSIC_MAX_MS, Math.round(requestedS * 1000)))
        : MUSIC_DEFAULT_MS;

    const modelId = String(payload.model || '').startsWith('music_') ? payload.model : DEFAULT_MUSIC_MODEL;

    // Film cues are underscore: sung vocals over dialogue ruin a scene, so
    // instrumental is the default and has to be opted out of explicitly.
    const wantsVocals = payload.vocals === true || payload.force_instrumental === false;

    const body = {
        prompt,
        model_id: modelId,
        music_length_ms: lengthMs,
        force_instrumental: !wantsVocals,
    };
    if (Number.isInteger(payload.seed)) body.seed = payload.seed;

    return {
        url: `${baseUrl}/music?output_format=${encodeURIComponent(outputFormat)}`,
        body,
        model: modelId,
        outputFormat,
        mimeType: outputFormat.startsWith('pcm_') ? 'audio/wav' : 'audio/mpeg',
        format: outputFormat.startsWith('pcm_') ? 'wav' : 'mp3',
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

/**
 * ElevenLabs bills speech per CHARACTER and generated sound per SECOND, which
 * is why one adapter reports two different units.
 *
 * The seconds metered are the ones the request clamped to, not the shot length
 * the caller had in mind. Ambient is the case that matters: a bed is capped at
 * 30 seconds and tiled by the mixer across a shot of any length, so billing the
 * shot's duration would over-report a two-minute scene by four times.
 */
function meterElevenLabs(capability, payload, result) {
    const p = payload || {};
    const model = (result && result.provider_model) || p.model || '';

    if (capability === 'voice') {
        const text = String(p.text || p.prompt || '');
        if (!text) return null;
        const ttsModel = String(model).startsWith('eleven') ? model : DEFAULT_TTS_MODEL;
        return { unit: 'character', quantity: text.length, model: ttsModel };
    }

    if (capability === 'sfx' || capability === 'ambient') {
        const seconds = clampSfxDuration(p, capability === 'ambient' ? SFX_MAX_SECONDS : 3);
        if (!(seconds > 0)) return null;
        return { unit: 'second', quantity: seconds, model: model || LOOPABLE_SFX_MODEL };
    }

    if (capability === 'music') {
        const ms = Number(p.duration_ms) || (Number(p.duration_s || p.duration_seconds || p.duration) || 0) * 1000;
        const seconds = ms > 0 ? ms / 1000 : 0;
        if (!(seconds > 0)) return null;
        return { unit: 'second', quantity: Math.round(seconds * 100) / 100,
                 model: String(model).startsWith('music_') ? model : DEFAULT_MUSIC_MODEL };
    }
    return null;
}

const adapter = {
    meter: meterElevenLabs,
    id: 'elevenlabs',
    kind: 'generator',
    label: 'ElevenLabs',
    requiresKey: true,
    capabilities: ['voice', 'sfx', 'ambient', 'music'],
    connection: {
        instructions: 'ElevenLabs has no OAuth for API access — paste an API key. Click "Get your key" to open your ElevenLabs API keys page.',
        helpUrl: 'https://elevenlabs.io/app/settings/api-keys',
    },

    supports,

    async generate(capability, payload, opts) {
        if (!supports(capability)) {
            return { ok: false, status: 400, error: `elevenlabs: unsupported capability '${capability}'` };
        }
        const { apiKey } = getCredential('elevenlabs');
        if (!apiKey) return missingKey();

        let request;
        if (capability === 'voice') request = buildVoiceRequest(payload || {});
        else if (capability === 'sfx') request = buildSfxRequest(payload || {});
        else if (capability === 'ambient') request = buildAmbientRequest(payload || {});
        else request = buildMusicRequest(payload || {});

        // /music carries the description in `prompt`; the other two use `text`.
        if (!request.body.text && !request.body.prompt) {
            return { ok: false, status: 400, error: `elevenlabs: ${capability === 'music' ? 'prompt' : 'text'} is required` };
        }
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

/**
 * Voices this account has been REFUSED, learned from the refusal.
 *
 * ElevenLabs returns `category: "premade"` for every voice in the list,
 * including ones a free plan cannot use through the API — Laura generates and
 * Chris comes back "Free users cannot use library voices via the API", and both
 * are marked premade. The only fields that differ are the description, the
 * fine-tuning state and where the preview is hosted, and none of those is a
 * permission signal.
 *
 * So it is not guessed. The first refusal is recorded against the voice, and
 * the catalogue marks it from then on — evidence rather than a field that does
 * not predict the thing. Stored in the provider credential's own `meta`, which
 * is where per-provider facts belong and needs no migration.
 */
function refusedVoices() {
    try {
        const cred = getCredential('elevenlabs') || {};
        const meta = cred.meta || {};
        return (meta.refused_voices && typeof meta.refused_voices === 'object')
            ? meta.refused_voices : {};
    } catch (_) { return {}; }
}

function recordVoiceRefusal(voiceId, reason) {
    if (!voiceId) return;
    try {
        const { db } = require('../../db/database');
        const row = db.prepare("SELECT meta FROM film_provider_credentials WHERE provider = 'elevenlabs'").get();
        let meta = {};
        try { meta = JSON.parse((row && row.meta) || '{}') || {}; } catch (_) { meta = {}; }
        meta.refused_voices = meta.refused_voices || {};
        meta.refused_voices[voiceId] = String(reason || 'refused').slice(0, 200);
        db.prepare("UPDATE film_provider_credentials SET meta = ? WHERE provider = 'elevenlabs'")
            .run(JSON.stringify(meta));
    } catch (_) {
        // Never fail a generation over bookkeeping: by the time this runs the
        // request has already been made and the outcome is already known.
    }
}

/**
 * What voices this account can use.
 *
 * A GET, not a generation: it costs nothing and returns the catalogue a
 * director actually casts from — name, gender, age, accent, and a preview the
 * provider hosts. Without it, casting means pasting an opaque id copied from
 * another website, which is not casting.
 *
 * Never throws for a missing key: a page asking "what can I choose from" should
 * say "no credential" rather than surfacing a stack trace, and the answer is
 * needed before anything is configured.
 */
async function listVoices(opts) {
    const cred = getCredential('elevenlabs') || {};
    const apiKey = (opts && opts.apiKey) || cred.apiKey || (typeof cred === 'string' ? cred : null);
    if (!apiKey) return { ok: false, error: 'No ElevenLabs credential is set.', voices: [] };

    const baseUrl = (process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (opts && opts.timeout) || 20000);
    try {
        const res = await fetch(`${baseUrl}/voices`, {
            headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            return { ok: false, error: `elevenlabs ${res.status}`, voices: [] };
        }
        const body = await res.json();
        const refused = refusedVoices();
        const voices = (Array.isArray(body.voices) ? body.voices : []).map(v => ({
            ...v,
            // Marked, never hidden: a voice this plan cannot use is still worth
            // seeing, because upgrading is a real option and a silently missing
            // voice reads as the catalogue being wrong.
            usable: !refused[v.voice_id],
            unusable_reason: refused[v.voice_id] || null,
        }));
        return { ok: true, voices };
    } catch (err) {
        clearTimeout(timer);
        return { ok: false, error: err.message, voices: [] };
    }
}

module.exports = {
    adapter,
    listVoices,
    refusedVoices,
    recordVoiceRefusal,
    buildVoiceRequest,
    buildSfxRequest,
    buildMusicRequest,
    buildAmbientRequest,
    normalizeOutputFormat,
};
