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

/*
 * 'wav' IS A THING THE ENGINE ASKS FOR AND THIS NEVER UNDERSTOOD.
 *
 * `lib/music-prompt.js` has always built its payloads with
 * `output_format: 'wav'` and a `sample_rate`. This accepted only strings
 * already in ElevenLabs' own vocabulary — `mp3_*` or `pcm_*` — so 'wav' matched
 * neither and fell through to the DEFAULT.
 *
 * The default is `mp3_44100_128`. So every score, every ambient bed and every
 * effect this engine has ever generated came back as **128 kbps MP3 at
 * 44.1 kHz** — the lowest tier ElevenLabs offers — while the code that asked
 * for it said WAV. Nothing failed and nothing warned; the request was simply
 * not in a language this function spoke.
 *
 * Two things wrong with that for a spot. It is LOSSY AT THE SOURCE, before the
 * mix, the loudness pass and the delivery encode, so the generation loss
 * compounds through every stage. And 44.1 kHz is the CD rate: video and
 * broadcast run at 48 kHz, so every cue needs a sample-rate conversion on the
 * way into the timeline that nobody asked for.
 *
 * Now translated: 'wav'/'pcm' plus the requested sample rate becomes the
 * matching `pcm_*` tier, snapped to a rate the API documents.
 */
const PCM_RATES = [8000, 16000, 22050, 24000, 44100, 48000];

function normalizeOutputFormat(payload) {
    const requested = String(payload.output_format || '');
    if (requested.startsWith('mp3_') || requested.startsWith('pcm_')) return requested;

    if (/^(wav|pcm|lossless)$/i.test(requested)) {
        const asked = Number(payload.sample_rate) || 48000;
        // The nearest documented rate at or ABOVE the ask, so a request for 48k
        // is never quietly served at 44.1k — the whole point of asking.
        const rate = PCM_RATES.find(r => r >= asked) || PCM_RATES[PCM_RATES.length - 1];
        return `pcm_${rate}`;
    }
    return DEFAULT_OUTPUT_FORMAT;
}

/**
 * ElevenLabs' `pcm_*` returns RAW SAMPLES WITH NO HEADER.
 *
 * Saving those bytes as `.wav` produces a file no player will open, which is
 * the trap that makes "just ask for PCM" a bug rather than a fix. Nothing in
 * this codebase writes a RIFF header — `media-imports` only ever READS one.
 *
 * Channels are INFERRED from the byte count rather than assumed: TTS returns
 * mono and /music returns stereo, and guessing wrong halves or doubles the
 * playback speed, which is the single most embarrassing way to get this wrong.
 * bytes = rate x channels x 2 x seconds, so the count and the duration we asked
 * for give the answer. Anything that does not land on 1 or 2 means an
 * assumption here is wrong, and the caller is told rather than handed a file
 * that plays at the wrong pitch.
 */
function wrapPcmAsWav(pcm, sampleRate, seconds, declaredChannels) {
    if (!Buffer.isBuffer(pcm) || !pcm.length) return null;
    const rate = Number(sampleRate) || 48000;
    const secs = Number(seconds) || 0;

    /*
     * A DECLARED channel count wins, and text-to-speech is the reason.
     *
     * The inference below needs the duration we asked for, and
     * `buildVoiceRequest` has none to carry — TTS length is whatever the line
     * turns out to be. So voice fell to the default, and the default was 2:
     * every line of dialogue would have been headed as stereo while ElevenLabs
     * returns mono, which plays at DOUBLE SPEED and the wrong pitch.
     *
     * Measured before this line existed: a mono 48k response came back with
     * `channels: 2` and a byte rate of 192000 where mono 48k is 96000.
     *
     * Voice is the only caller with no duration, and it is the one endpoint
     * whose channel count the provider documents — so it states the fact
     * rather than leaving it to be guessed from bytes it cannot predict.
     */
    let channels = Number(declaredChannels) === 1 || Number(declaredChannels) === 2
        ? Number(declaredChannels)
        : 2;
    if (secs > 0) {
        const inferred = Math.round(pcm.length / (rate * 2 * secs));
        if (inferred === 1 || inferred === 2) channels = inferred;
        else return null;             // our model of the response is wrong: say so
    }
    const bitsPerSample = 16;
    const byteRate = rate * channels * bitsPerSample / 8;
    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + pcm.length, 4);
    head.write('WAVE', 8);
    head.write('fmt ', 12);
    head.writeUInt32LE(16, 16);                       // PCM chunk size
    head.writeUInt16LE(1, 20);                        // format: PCM
    head.writeUInt16LE(channels, 22);
    head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(byteRate, 28);
    head.writeUInt16LE(channels * bitsPerSample / 8, 32);
    head.writeUInt16LE(bitsPerSample, 34);
    head.write('data', 36);
    head.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([head, pcm]);
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
        // Documented mono, and unlike the other three this request cannot carry
        // a duration for the byte-count inference to work from.
        channels: 1,
        mimeType: outputFormat.startsWith('pcm_') ? 'audio/wav' : 'audio/mpeg',
        format: outputFormat.startsWith('pcm_') ? 'wav' : 'mp3',
    };
}

/*
 * `/sound-generation` takes an `output_format` too, and this never sent one.
 *
 * Item 32 fixed the format for /music and /text-to-speech. It did not reach
 * here, because ambient and SFX do not go to /music at all — and these two
 * builders did not fall back to MP3, they DECLARED it: `mimeType: 'audio/mpeg',
 * format: 'mp3'`, hardcoded, with no output_format on the request. So the beds
 * and effects stayed 128 kbps 44.1 kHz even after the music path was fixed.
 *
 * A fix that covers one of three endpoints is the kind that looks done and is
 * not, which is why this is worth its own note rather than a silent edit.
 */
function soundGenerationUrl(outputFormat) {
    const base = `${(process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')}/sound-generation`;
    return outputFormat ? `${base}?output_format=${encodeURIComponent(outputFormat)}` : base;
}

function clampSfxDuration(payload, fallback) {
    const requested = Number(payload.duration_s || payload.duration_seconds || payload.duration || fallback);
    return Math.max(SFX_MIN_SECONDS, Math.min(SFX_MAX_SECONDS, requested));
}

function buildSfxRequest(payload) {
    const outputFormat = normalizeOutputFormat(payload);
    const seconds = clampSfxDuration(payload, 3);
    return {
        url: soundGenerationUrl(outputFormat),
        body: {
            text: payload.text || payload.prompt || payload.description || '',
            duration_seconds: seconds,
            prompt_influence: typeof payload.prompt_influence === 'number' ? payload.prompt_influence : 0.3,
        },
        model: 'elevenlabs-sound-effects',
        outputFormat,
        durationSeconds: seconds,
        mimeType: outputFormat.startsWith('pcm_') ? 'audio/wav' : 'audio/mpeg',
        format: outputFormat.startsWith('pcm_') ? 'wav' : 'mp3',
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
    const outputFormat = normalizeOutputFormat(payload);
    const seconds = clampSfxDuration(payload, SFX_MAX_SECONDS);
    return {
        url: soundGenerationUrl(outputFormat),
        body: {
            text: payload.text || payload.prompt || payload.description || '',
            duration_seconds: seconds,
            prompt_influence: typeof payload.prompt_influence === 'number' ? payload.prompt_influence : 0.3,
            loop: true,
            model_id: LOOPABLE_SFX_MODEL,
        },
        model: LOOPABLE_SFX_MODEL,
        outputFormat,
        // Carried for the same reason /music carries it: a raw-PCM response has
        // its channel count inferred from the byte count, and that needs the
        // duration we asked for.
        durationSeconds: seconds,
        mimeType: outputFormat.startsWith('pcm_') ? 'audio/wav' : 'audio/mpeg',
        format: outputFormat.startsWith('pcm_') ? 'wav' : 'mp3',
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

    /*
     * A cue that changes over its own length.
     *
     * `composition_plan` is named parts, each with its own direction and its own
     * duration, and the API honours those durations. SIX rules govern it, and
     * every one of them is otherwise a paid request that fails. All six were
     * PROBED against the live API with deliberately invalid bodies, which
     * validation rejects for free — two of them are not in the documentation at
     * all and only running it found them:
     *
     *   1. "You must provide exactly one of `prompt` or `composition_plan`."
     *   2. "You must not provide `music_length_ms` when passing `composition_plan`."
     *   3. a part's duration_ms must be 3000..120000
     *   4. `lines` is REQUIRED on a v1 section, even for an instrumental cue
     *   5. "`force_instrumental` can only be used with `prompt`."   (undocumented)
     *   6. THE SHAPE IS PER MODEL:                                  (undocumented)
     *        music_v1 -> MusicPrompt   { positive_global_styles, sections[] }
     *        music_v2 -> CompositionPlan { chunks[] }
     *      sending v1's shape to v2 is
     *      "Invalid type of `composition_plan` used for model music_v2".
     *
     * (6) is why the plan arrives here in a neutral shape and is converted at
     * the adapter: which body a model wants is a provider fact, like
     * promptLimit and referenceMode, and belongs beside the model ids.
     */
    const MODEL_PLAN_SHAPE = { music_v1: 'sections', music_v2: 'chunks' };

    const plan = payload.composition_plan;
    const hasPlan = plan && Array.isArray(plan.sections) && plan.sections.length > 0;

    /*
     * (5): a plan cannot carry force_instrumental, and silently dropping it
     * would lose the protection it exists for — sung vocals over dialogue ruin
     * a scene, and instrumental is this engine's default. The plan has its own
     * way to say it: no `lines`, and `vocals` among the negatives. Expressed
     * rather than abandoned.
     */
    const planNegatives = (() => {
        const declared = (plan && Array.isArray(plan.negative_global_styles))
            ? plan.negative_global_styles.slice() : [];
        if (wantsVocals || declared.some(n => /vocal|sung|lyric|voice/i.test(String(n)))) return declared;
        return [...declared, 'vocals'];
    })();

    function planBodyFor(shape) {
        if (shape === 'chunks') {
            // v2 has no globals of its own, so the cue's overall style travels
            // with every chunk. That is the shape, not a workaround.
            return {
                chunks: plan.sections.map(s => ({
                    text: s.direction || s.section_name,
                    duration_ms: s.duration_ms,
                    positive_styles: [...(plan.positive_global_styles || []), ...(s.positive_local_styles || [])],
                    negative_styles: [...planNegatives, ...(s.negative_local_styles || [])],
                })),
            };
        }
        return {
            positive_global_styles: plan.positive_global_styles || [],
            negative_global_styles: planNegatives,
            sections: plan.sections.map(s => ({
                section_name: s.section_name,
                positive_local_styles: s.positive_local_styles || [],
                negative_local_styles: s.negative_local_styles || [],
                duration_ms: s.duration_ms,
                lines: [],
            })),
        };
    }

    const body = hasPlan
        ? { composition_plan: planBodyFor(MODEL_PLAN_SHAPE[modelId] || 'chunks'), model_id: modelId }
        : { prompt, model_id: modelId, music_length_ms: lengthMs, force_instrumental: !wantsVocals };
    if (Number.isInteger(payload.seed)) body.seed = payload.seed;

    return {
        url: `${baseUrl}/music?output_format=${encodeURIComponent(outputFormat)}`,
        body,
        model: modelId,
        outputFormat,
        // Carried so a raw-PCM response can have its channel count INFERRED
        // from the byte count rather than assumed. /music returns stereo and
        // /text-to-speech returns mono, and a wrong guess plays at half or
        // double speed.
        durationMs: lengthMs,
        mimeType: outputFormat.startsWith('pcm_') ? 'audio/wav' : 'audio/mpeg',
        format: outputFormat.startsWith('pcm_') ? 'wav' : 'mp3',
    };
}

/**
 * An upstream 5xx is the PROVIDER failing, and a failed generation bills
 * nothing — so it is worth one more attempt.
 *
 * Reported as: two consecutive `elevenlabs 500: Internal Server error` on a
 * four-section composition plan, then success on the next call with the plan
 * removed. The natural conclusion was that sections do not work, and the
 * workaround was to stop using them — which is the expensive kind of wrong,
 * because sections are what give a cue a real 4/4/4/3 build instead of one
 * prompt hoping for an arc. (The exact body this adapter builds for that plan
 * was later sent to the live API and generated fine, so the 500 is not
 * reproducible and is most likely transient — which is precisely the case a
 * retry exists for.)
 *
 * 5xx AND 429 ONLY. A 4xx is our own request and replaying it buys the same
 * refusal twice — the rule `lib/image-fallback.js` already states for image
 * providers, and the reason a 422 must never be retried.
 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 1200;

async function callElevenLabs(request, apiKey, opts) {
    const first = await callElevenLabsOnce(request, apiKey, opts);
    if (first.ok || !RETRY_STATUS.has(first.status)) return first;

    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    const second = await callElevenLabsOnce(request, apiKey, opts);
    if (second.ok) return second;
    // Named, so a genuine outage does not read as one flaky call.
    return { ...second, error: `${second.error} (retried once after ${first.status})` };
}

/**
 * STEM SEPARATION (MUS-011): the one ElevenLabs music endpoint that takes a
 * FILE rather than words. Verified against the live API with a deliberately
 * incomplete body (a 422 costs nothing): `POST /v1/music/stem-separation`,
 * multipart, `file` required, `stem_variation_id` one of `two_stems_v1` /
 * `six_stems_v1`, `output_format` in the query. It answers synchronously with
 * a ZIP of stems, which is why `lib/music-separation.js` treats the bytes as
 * untrusted and unpacks them itself.
 *
 * The output format is held to `mp3_*`: a `pcm_*` entry inside a ZIP may be
 * headerless samples, and a stem the sniffer cannot identify is a stem the
 * import refuses — the shape of that answer is unverified, so it is refused
 * rather than guessed.
 */
const STEM_VARIATION_IDS = Object.freeze(['two_stems_v1', 'six_stems_v1']);
const STEM_DEFAULT_OUTPUT = 'mp3_44100_128';

function buildStemSeparationRequest(payload) {
    const p = payload || {};
    const baseUrl = (process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const variation = String(p.stem_variation_id || '');
    if (!STEM_VARIATION_IDS.includes(variation)) {
        throw new Error(`elevenlabs: stem_variation_id must be one of ${STEM_VARIATION_IDS.join(', ')} (got '${variation}')`);
    }
    const file = p.file || {};
    if (!file.bytes || !file.bytes.length) throw new Error('elevenlabs: stem separation needs the recording\'s bytes');
    const outputFormat = /^mp3_\d+_\d+$/.test(String(p.output_format || '')) ? p.output_format : STEM_DEFAULT_OUTPUT;
    const form = new FormData();
    form.append('file', new Blob([file.bytes], { type: file.mime || 'application/octet-stream' }), file.name || 'source.wav');
    form.append('stem_variation_id', variation);
    return {
        url: `${baseUrl}/music/stem-separation?output_format=${encodeURIComponent(outputFormat)}`,
        multipart: true, form, model: variation, outputFormat, mimeType: 'application/zip', format: 'zip',
    };
}

/** The multipart call, with the same retry-once rule as every other ElevenLabs request: 5xx and 429 only. */
async function callElevenLabsMultipart(request, apiKey, opts) {
    const o = opts || {};
    const delay = o.retryDelayMs === undefined ? RETRY_DELAY_MS : o.retryDelayMs;
    const first = await callMultipartOnce(request, apiKey, o);
    if (first.ok || !RETRY_STATUS.has(first.status)) return first;
    await new Promise(r => setTimeout(r, delay));
    const second = await callMultipartOnce(request, apiKey, o);
    if (second.ok) return second;
    return { ...second, error: `${second.error} (retried once after ${first.status})` };
}

async function callMultipartOnce(request, apiKey, opts) {
    const controller = new AbortController();
    const timeout = (opts && opts.timeout) || 600000;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        // No Content-Type: fetch writes the multipart boundary itself, and a
        // hand-set header without it is a body the server cannot split.
        const response = await fetch(request.url, {
            method: 'POST',
            headers: { 'Accept': 'application/zip', 'xi-api-key': apiKey },
            body: request.form,
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) {
            const body = await parseErrorResponse(response);
            return { ok: false, status: response.status, error: normalizeError('elevenlabs', response.status, body) };
        }
        const data = Buffer.from(await response.arrayBuffer());
        return {
            ok: true, status: response.status, data,
            mimeType: 'application/zip', contentType: 'application/zip',
            provider: 'elevenlabs', provider_model: request.model,
            provider_job_id: response.headers.get('request-id') || response.headers.get('x-request-id') || '',
            meta: { output_format: request.outputFormat, format: 'zip', stem_variation_id: request.model },
        };
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') return { ok: false, status: 504, error: `elevenlabs: stem separation timed out after ${timeout}ms` };
        return { ok: false, status: 500, error: `elevenlabs: ${err.message}` };
    }
}

async function callElevenLabsOnce(request, apiKey, opts) {
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

        let data = Buffer.from(await response.arrayBuffer());

        /*
         * A `pcm_*` response is raw samples with no container. Saved straight to
         * `.wav` it is a file nothing will open, so the header goes on here —
         * at the one point the bytes, the requested rate and the requested
         * duration are all in hand.
         *
         * If the wrapper cannot make sense of the byte count it returns null
         * rather than a guess, and we keep the raw bytes and say so in `meta`.
         * A file that plays at the wrong pitch is worse than one labelled
         * honestly as raw.
         */
        let pcmWrapped = false;
        let storedFormat = request.format;
        let storedMime = request.mimeType;
        if (String(request.outputFormat || '').startsWith('pcm_')) {
            const rate = Number(String(request.outputFormat).split('_')[1]) || 48000;
            const seconds = Number(request.durationSeconds)
                || (Number(request.durationMs) > 0 ? Number(request.durationMs) / 1000 : 0);
            const wrapped = wrapPcmAsWav(data, rate, seconds, request.channels);
            if (wrapped) { data = wrapped; pcmWrapped = true; }
            else {
                /*
                 * THE REFUSAL MUST REACH THE FILENAME, not just `meta`.
                 *
                 * When the byte count fits neither mono nor stereo the wrapper
                 * declines to guess, which is right — a file that plays at the
                 * wrong pitch is worse than one labelled honestly. But the
                 * request still SAID `format: 'wav'`, and the route names the
                 * file from that, so the bytes landed as `.wav` while being a
                 * bare stream: exactly the lie this whole change exists to stop,
                 * surviving in the one branch nobody looks at.
                 *
                 * `.pcm` is honest and unambiguous — the rate is in
                 * `meta.output_format` for anything that needs to decode it.
                 */
                storedFormat = 'pcm';
                storedMime = 'application/octet-stream';
            }
        }

        return {
            ok: true,
            status: response.status,
            data,
            contentType: storedMime || response.headers.get('content-type') || 'audio/mpeg',
            provider: 'elevenlabs',
            provider_model: request.model,
            provider_job_id: response.headers.get('request-id') || response.headers.get('x-request-id') || '',
            meta: {
                voice_id: request.voiceId || '',
                output_format: request.outputFormat || '',
                format: storedFormat,
                // Said out loud: a pcm request whose header could not be
                // written is raw samples on disk, and the reader has to know.
                ...(String(request.outputFormat || '').startsWith('pcm_')
                    ? { pcm_wrapped_as_wav: pcmWrapped } : {}),
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
    /** Synchronous: the call returns when the work is done, with nothing to report on the way. */
    reportsProgress: 'none',
    kind: 'generator',
    label: 'ElevenLabs',
    requiresKey: true,
    capabilities: ['voice', 'sfx', 'ambient', 'music'],
    /*
     * THE MUSIC WORKFLOWS (MUS-009), declared rather than assumed. /music
     * composes a whole cue from a prompt or a composition plan; it returns ONE
     * mixed file, takes no reference audio, no picture and no range, so those
     * are unsupported with the reason. Separation is PLANNED: the epic's next
     * task wires it, and declaring it available before it is would put a
     * button on the page that fails at the provider.
     */
    music: {
        music_compose: { status: 'available', models: ['music_v1', 'music_v2'], default_model: DEFAULT_MUSIC_MODEL,
            limits: { min_ms: MUSIC_MIN_MS, max_ms: MUSIC_MAX_MS, models: ['music_v1', 'music_v2'], section_min_ms: 3000, section_max_ms: 120000 },
            source: 'https://elevenlabs.io/docs/api-reference/music/compose' },
        music_parts: { status: 'unsupported', reason: 'ElevenLabs Music returns one mixed cue; it has no native multi-part output' },
        /*
         * Separation (MUS-011). `max_input_ms` is null because ElevenLabs
         * publishes no input-length ceiling for this endpoint; null is the
         * stated absence, not an invented number. The input formats are the
         * ones the stem importer sniffs, since the recording is always one of
         * those by the time it is on a track.
         */
        music_separate: { status: 'available', models: ['two_stems_v1', 'six_stems_v1'], default_model: 'six_stems_v1',
            limits: { stem_counts: [2, 6], max_input_ms: null, input_formats: ['wav', 'aiff', 'flac', 'mp3', 'm4a'] },
            source: 'https://elevenlabs.io/docs/api-reference/music/separate-stems' },
        music_reference: { status: 'unsupported', reason: '/music takes a prompt or a composition plan and no reference audio or melody' },
        music_video: { status: 'unsupported', reason: '/music takes no picture; a cue is conditioned on words and a length only' },
        music_inpaint: { status: 'unsupported', reason: '/music regenerates a whole cue; it cannot regenerate a range of an existing one in context' },
    },
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

        if (capability === 'music' && payload && payload.workflow === 'music_separate') {
            let sepRequest;
            try { sepRequest = buildStemSeparationRequest(payload); }
            catch (e) { return { ok: false, status: 400, error: e.message }; }
            return callElevenLabsMultipart(sepRequest, apiKey, opts);
        }

        let request;
        if (capability === 'voice') request = buildVoiceRequest(payload || {});
        else if (capability === 'sfx') request = buildSfxRequest(payload || {});
        else if (capability === 'ambient') request = buildAmbientRequest(payload || {});
        else request = buildMusicRequest(payload || {});

        /*
         * /music carries the description in `prompt`; the other two use `text`.
         * A composition plan carries it in the SECTIONS and must not also send
         * a prompt — the API refuses both together — so a planned cue is
         * complete with neither field, and this guard rejected every one of
         * them before the request was ever made.
         */
        if (!request.body.text && !request.body.prompt && !request.body.composition_plan) {
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

module.exports = {    wrapPcmAsWav, normalizeOutputFormat,
    adapter,
    listVoices,
    recordVoiceRefusal,
    buildVoiceRequest,
    buildSfxRequest,
    buildMusicRequest,
    buildAmbientRequest,
    buildStemSeparationRequest,
    callElevenLabsMultipart,};
