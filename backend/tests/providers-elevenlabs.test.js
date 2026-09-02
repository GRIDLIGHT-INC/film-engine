/**
 * Unit tests for the ElevenLabs provider adapter.
 * Uses a local HTTP mock; no real ElevenLabs API calls.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-elevenlabs-' + crypto.randomUUID().slice(0, 8));
process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';

const { db } = require('../db/database');
db.exec('CREATE TABLE IF NOT EXISTS film_provider_credentials (provider TEXT PRIMARY KEY, api_key TEXT DEFAULT "", meta TEXT DEFAULT "{}")');

const providers = require('../lib/providers');
const {
    adapter,
    buildVoiceRequest,
    buildSfxRequest,
    buildMusicRequest,
    buildAmbientRequest,
    normalizeOutputFormat,
} = require('../lib/providers/elevenlabs');

let server;
let baseUrl;
let lastRequest;
let appProcess;
let appBaseUrl;

function readJson(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); }
        });
    });
}

function appRequest(urlPath, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.stringify(opts.body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request(`${appBaseUrl}${urlPath}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(Buffer.from(c)));
            res.on('end', () => {
                const rawBuffer = Buffer.concat(chunks);
                const raw = rawBuffer.toString();
                let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
                resolve({ status: res.statusCode, data: parsed, raw, rawBuffer, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function waitForApp(maxRetries = 40) {
    for (let i = 0; i < maxRetries; i++) {
        try { const res = await appRequest('/api/health'); if (res.status === 200) return; } catch (_) {}
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Film Engine test server did not start');
}

/*
 * A `pcm_*` response is raw samples, and its LENGTH is what tells the adapter
 * how many channels it is in. A fixed-size stub therefore exercises the
 * refusal path rather than the wrap — so the stub sizes itself the way a real
 * provider would, mono at the rate and duration that were asked for, with the
 * marker at the end so the samples can still be shown to have survived.
 */
function mockAudio(url, seconds, marker) {
    const fmt = (url.split('output_format=')[1] || '').split('&')[0];
    if (!fmt.startsWith('pcm_')) return Buffer.from(marker);
    const rate = Number(fmt.split('_')[1]) || 48000;
    const body = Buffer.alloc(Math.max(0, rate * 2 * seconds - marker.length));
    return Buffer.concat([body, Buffer.from(marker)]);
}

describe('providers/elevenlabs', () => {
    before(async () => {
        server = http.createServer(async (req, res) => {
            const body = await readJson(req);
            lastRequest = { method: req.method, url: req.url, headers: req.headers, body };

            if (req.url.includes('/fail')) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ detail: { message: 'mock failure' } }));
                return;
            }

            if (req.url.startsWith('/v1/text-to-speech/')) {
                res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'request-id': 'tts-req-1' });
                res.end(mockAudio(req.url, 1, 'mock-tts-audio'));
                return;
            }

            if (req.url.split('?')[0] === '/v1/sound-generation') {
                res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'request-id': 'sfx-req-1' });
                res.end(mockAudio(req.url, lastRequest.body.duration_seconds || 3, 'mock-sfx-audio'));
                return;
            }

            if (req.url.startsWith('/v1/music')) {
                res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'request-id': 'music-req-1' });
                res.end(mockAudio(req.url, (lastRequest.body.music_length_ms || 30000) / 1000, 'mock-music-audio'));
                return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: 'not found' }));
        });

        await new Promise(resolve => server.listen(0, resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
        process.env.ELEVENLABS_BASE_URL = baseUrl;
    });

    after(() => {
        if (server) server.close();
        if (appProcess) appProcess.kill('SIGTERM');
        try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
        delete process.env.ELEVENLABS_BASE_URL;
        delete process.env.ELEVENLABS_API_KEY;
    });

    it('registers through provider autoload and advertises its audio capabilities', () => {
        assert.equal(adapter.id, 'elevenlabs');
        assert.equal(adapter.kind, 'generator');
        assert.equal(adapter.requiresKey, true);
        assert.equal(adapter.supports('image'), false);
        assert.equal(providers.get('elevenlabs').id, 'elevenlabs');
        assert.deepEqual([...adapter.capabilities].sort(), ['ambient', 'music', 'sfx', 'voice']);
    });

    it('every declared capability is actually wired end to end', () => {
        // Set-based: declaring a capability without teaching supports() about it,
        // or without a branch in generate(), is the exact half-wiring this catches.
        const broken = [];
        for (const cap of adapter.capabilities) {
            if (adapter.supports(cap) !== true) broken.push(`${cap}: supports() says no`);
            if (providers.resolve(cap, { [cap]: 'elevenlabs' }).id !== 'elevenlabs') broken.push(`${cap}: does not resolve`);
            if (providers.resolveGenerator(cap, { [cap]: 'elevenlabs' }).id !== 'elevenlabs') broken.push(`${cap}: not a generator`);
        }
        assert.deepEqual(broken, []);
    });

    it('music is no longer a single-provider capability', () => {
        const capable = providers.list().filter(a => a.supports && a.supports('music')).map(a => a.id).sort();
        assert.ok(capable.length > 1, `music still has only: ${capable.join(', ')}`);
        assert.ok(capable.includes('elevenlabs'));
    });

    it('maps canonical voice payloads to ElevenLabs TTS requests', () => {
        const request = buildVoiceRequest({
            text: 'Hello there.',
            voice_id: 'voice-123',
            model: 'eleven_multilingual_v2',
            language: 'en',
            output_format: 'mp3_44100_128',
        });

        assert.match(request.url, /\/text-to-speech\/voice-123\?output_format=mp3_44100_128$/);
        assert.equal(request.body.text, 'Hello there.');
        assert.equal(request.body.model_id, 'eleven_multilingual_v2');
        assert.equal(request.mimeType, 'audio/mpeg');
        assert.equal(request.format, 'mp3');
    });

    it('maps sfx prompts to sound-generation requests with bounded duration', () => {
        const request = buildSfxRequest({ prompt: 'metal door slam', duration_s: 60 });
        assert.equal(request.url, `${baseUrl}/sound-generation?output_format=mp3_44100_128`);
        assert.equal(request.body.text, 'metal door slam');
        assert.equal(request.body.duration_seconds, 30);
        assert.equal(request.model, 'elevenlabs-sound-effects');
    });

    it('maps canonical music payloads to the /v1/music contract', () => {
        const request = buildMusicRequest({
            prompt: 'tense orchestral underscore, low strings',
            duration_s: 45,
            seed: 7,
        });
        assert.match(request.url, /\/music\?output_format=mp3_44100_128$/);
        assert.equal(request.body.prompt, 'tense orchestral underscore, low strings');
        assert.equal(request.body.music_length_ms, 45000);
        assert.equal(request.body.seed, 7);
        assert.equal(request.format, 'mp3');
        // duration_seconds is the sfx field; music takes milliseconds.
        assert.equal(request.body.duration_seconds, undefined);
    });

    it('scores default to instrumental unless vocals are asked for', () => {
        // A cue with sung vocals under dialogue is a bug, not a style choice.
        assert.equal(buildMusicRequest({ prompt: 'x' }).body.force_instrumental, true);
        assert.equal(buildMusicRequest({ prompt: 'x', force_instrumental: false }).body.force_instrumental, false);
        assert.equal(buildMusicRequest({ prompt: 'x', vocals: true }).body.force_instrumental, false);
    });

    it('clamps music length to the documented 3s-10min window', () => {
        for (const [durationS, expected] of [[0, 30000], [1, 3000], [45, 45000], [600, 600000], [9999, 600000]]) {
            assert.equal(buildMusicRequest({ prompt: 'x', duration_s: durationS }).body.music_length_ms, expected, `duration_s=${durationS}`);
        }
    });

    it('does not leak another provider model id into model_id', () => {
        // buildMusicPrompt defaults model to Gridlight's 'musicgen-large'.
        const request = buildMusicRequest({ prompt: 'x', model: 'musicgen-large' });
        assert.equal(request.body.model_id, 'music_v2');
        assert.equal(buildMusicRequest({ prompt: 'x', model: 'music_v1' }).body.model_id, 'music_v1');
    });

    it('generates music audio as a Buffer with provider metadata', async () => {
        const result = await adapter.generate('music', { prompt: 'warm ambient pad', duration_s: 20 });

        assert.equal(result.ok, true);
        assert.equal(Buffer.isBuffer(result.data), true);
        assert.equal(result.data.toString(), 'mock-music-audio');
        assert.equal(result.provider_model, 'music_v2');
        assert.equal(result.provider_job_id, 'music-req-1');
        assert.equal(result.meta.format, 'mp3');
        assert.equal(lastRequest.headers['xi-api-key'], 'test-elevenlabs-key');
        assert.equal(lastRequest.body.prompt, 'warm ambient pad');
    });

    it('rejects a music request with no prompt', async () => {
        const missing = await adapter.generate('music', {});
        assert.equal(missing.ok, false);
        assert.equal(missing.status, 400);
    });

    it('generates ambient as a seamless loop from the sound-effects endpoint', () => {
        // Room tone is a sound effect, not music — and loop:true is only
        // honoured on eleven_text_to_sound_v2, so the model must be explicit.
        const request = buildAmbientRequest({ prompt: 'quiet room ambiance, nighttime', duration_s: 30 });
        assert.equal(request.url, `${baseUrl}/sound-generation?output_format=mp3_44100_128`);
        assert.equal(request.body.loop, true);
        assert.equal(request.body.model_id, 'eleven_text_to_sound_v2');
        assert.equal(request.body.duration_seconds, 30);
    });

    it('keeps the ambient loop inside the endpoint ceiling', () => {
        for (const [input, expected] of [[0.1, 0.5], [5, 5], [30, 30], [120, 30]]) {
            assert.equal(buildAmbientRequest({ prompt: 'x', duration_s: input }).body.duration_seconds, expected, `duration_s=${input}`);
        }
    });

    it('does not loop plain sound effects', () => {
        // A looping door slam would be a bug.
        assert.notEqual(buildSfxRequest({ prompt: 'door slam', duration_s: 2 }).body.loop, true);
    });

    it('generates ambient audio as a Buffer', async () => {
        const result = await adapter.generate('ambient', { prompt: 'rain on a tin roof', duration_s: 20 });
        assert.equal(result.ok, true);
        assert.equal(Buffer.isBuffer(result.data), true);
        assert.equal(result.data.toString(), 'mock-sfx-audio');
        assert.equal(lastRequest.body.loop, true);
    });

    it('normalizes output format to a provider-supported audio type', () => {
        assert.equal(normalizeOutputFormat({ output_format: 'mp3_44100_128' }), 'mp3_44100_128');
        assert.equal(normalizeOutputFormat({ output_format: 'wav' }), 'pcm_48000');
        // Never served BELOW the rate asked for: that is the point of asking,
        // and 44.1k is the CD rate where video runs at 48k.
        assert.equal(normalizeOutputFormat({ output_format: 'wav', sample_rate: 44100 }), 'pcm_44100');
        assert.equal(normalizeOutputFormat({}), 'mp3_44100_128');
    });

    it('generates voice audio as a Buffer with provider metadata', async () => {
        const result = await adapter.generate('voice', {
            text: 'A line of dialogue.',
            voice_id: 'voice-abc',
            output_format: 'mp3_44100_128',
        });

        assert.equal(result.ok, true);
        assert.equal(Buffer.isBuffer(result.data), true);
        assert.equal(result.data.toString(), 'mock-tts-audio');
        assert.equal(result.provider_model, 'eleven_multilingual_v2');
        assert.equal(result.provider_job_id, 'tts-req-1');
        assert.equal(result.meta.format, 'mp3');
        assert.equal(lastRequest.headers['xi-api-key'], 'test-elevenlabs-key');
        assert.equal(lastRequest.body.text, 'A line of dialogue.');
    });

    it('generates sfx audio as a Buffer', async () => {
        const result = await adapter.generate('sfx', { prompt: 'soft rain on glass', duration_s: 2 });

        assert.equal(result.ok, true);
        assert.equal(Buffer.isBuffer(result.data), true);
        assert.equal(result.data.toString(), 'mock-sfx-audio');
        assert.equal(result.provider_model, 'elevenlabs-sound-effects');
        assert.equal(result.provider_job_id, 'sfx-req-1');
    });

    it('generateStream delegates to generate and invokes callbacks', async () => {
        let completed = false;
        const result = await adapter.generateStream('voice', { text: 'Stream compatible line.' }, null, {
            onComplete: () => { completed = true; },
        });

        assert.equal(result.ok, true);
        assert.equal(completed, true);
        assert.equal(Buffer.isBuffer(result.finalData.data), true);
    });

    it('returns normalized provider errors', async () => {
        process.env.ELEVENLABS_BASE_URL = `${baseUrl}/fail`;
        const result = await adapter.generate('voice', { text: 'This fails.' });
        process.env.ELEVENLABS_BASE_URL = baseUrl;

        assert.equal(result.ok, false);
        assert.equal(result.status, 500);
        assert.match(result.error, /mock failure/);
    });

    it('rejects unsupported capability and missing text without network calls', async () => {
        const unsupported = await adapter.generate('image', { text: 'x' });
        assert.equal(unsupported.ok, false);
        assert.equal(unsupported.status, 400);

        const missing = await adapter.generate('voice', {});
        assert.equal(missing.ok, false);
        assert.equal(missing.status, 400);
        assert.match(missing.error, /text is required/);
    });

    it('voice route uses the configured ElevenLabs provider and stamps asset provenance', async () => {
        const appPort = 18100 + Math.floor(Math.random() * 700);
        appBaseUrl = `http://127.0.0.1:${appPort}`;
        appProcess = require('child_process').spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(appPort),
                FILM_DATA_DIR: process.env.FILM_DATA_DIR,
                ELEVENLABS_API_KEY: 'test-elevenlabs-key',
                ELEVENLABS_BASE_URL: baseUrl,
                RATE_LIMIT_MAX_GENERATION: '1000',
            },
            stdio: 'pipe',
        });
        appProcess.stderr.on('data', () => {});
        appProcess.stdout.on('data', () => {});
        await waitForApp();

        const proj = await appRequest('/film/projects', { method: 'POST', body: { title: 'ElevenLabs Route Test', logline: 'x' } });
        assert.equal(proj.status, 201);
        const projectId = proj.data.id;

        const providersRes = await appRequest(`/film/projects/${projectId}/providers`, {
            method: 'PUT',
            body: { config: { voice: 'elevenlabs' } },
        });
        assert.equal(providersRes.status, 200);
        assert.equal(providersRes.data.config.voice, 'elevenlabs');

        await appRequest(`/film/projects/${projectId}/script`, {
            method: 'POST',
            body: { content: 'Title: Voice Test\n\nINT. ROOM - DAY\n\nJOHN\nHello from ElevenLabs.\n', format: 'fountain' },
        });
        const scenes = await appRequest(`/film/projects/${projectId}/scenes`);
        const sceneId = scenes.data.scenes[0].id;
        const shots = await appRequest('/film/shots', {
            method: 'POST',
            body: {
                scene_id: sceneId,
                cards: [{
                    shot_code: '1A',
                    camera: { shot_type: 'medium', movement: 'static' },
                    dialogue: [{ character: 'JOHN', line: 'Hello from ElevenLabs.', emotion: 'neutral' }],
                }],
            },
        });
        assert.equal(shots.status, 201);
        const shotId = shots.data.shots[0].id;

        const generated = await appRequest(`/film/shots/${shotId}/voice/generate`, { method: 'POST', body: {} });
        assert.equal(generated.status, 200);
        assert.equal(generated.data.audio_files[0].status, 'complete');
        assert.match(generated.data.audio_files[0].audio_url, /\.wav$/);

        const status = await appRequest(`/film/shots/${shotId}/voice`);
        assert.equal(status.status, 200);
        const asset = status.data.audio_files[0];
        assert.match(asset.file_name, /\.wav$/);
        assert.equal(asset.provider, 'elevenlabs');
        assert.equal(asset.provider_model, 'eleven_multilingual_v2');
        assert.equal(asset.license_source, 'generated');
        assert.equal(asset.license_status, 'generated');
        assert.ok(asset.prompt_hash);

        const served = await appRequest(asset.audio_url);
        assert.equal(served.status, 200);
        assert.match(served.headers['content-type'], /audio\/(wav|x-wav|wave)/);
        assert.ok(served.raw.startsWith('RIFF'), 'the served dialogue is not a WAV');
        assert.ok(served.raw.endsWith('mock-tts-audio'), 'the samples did not survive the wrap');
    });

    it('music route resolves ElevenLabs and stores a WAV with provenance', async () => {
        // Reuses the app server spawned by the voice route test above.
        const proj = await appRequest('/film/projects', { method: 'POST', body: { title: 'ElevenLabs Music Test', logline: 'x' } });
        assert.equal(proj.status, 201);
        const projectId = proj.data.id;

        const cfg = await appRequest(`/film/projects/${projectId}/providers`, {
            method: 'PUT',
            body: { config: { music: 'elevenlabs' } },
        });
        assert.equal(cfg.status, 200);
        assert.equal(cfg.data.config.music, 'elevenlabs');

        await appRequest(`/film/projects/${projectId}/script`, {
            method: 'POST',
            body: { content: 'Title: Music Test\n\nINT. WAREHOUSE - NIGHT\n\nRain on the roof.\n', format: 'fountain' },
        });
        const scenes = await appRequest(`/film/projects/${projectId}/scenes`);
        const sceneId = scenes.data.scenes[0].id;

        const generated = await appRequest(`/film/scenes/${sceneId}/music/generate`, {
            method: 'POST',
            body: { mood: 'tense', genre: 'orchestral', description: 'low strings under rain' },
        });
        assert.equal(generated.status, 200);
        assert.equal(generated.data.status, 'complete');
        // The music payload asks for wav; ElevenLabs answers mp3, and the route
        // must name the file for what it actually got.
        assert.match(generated.data.music_url, /\.wav$/);

        const served = await appRequest(generated.data.music_url);
        assert.equal(served.status, 200);
        assert.ok(served.raw.startsWith('RIFF'), 'the served score is not a WAV');
        assert.ok(served.raw.endsWith('mock-music-audio'), 'the samples did not survive the wrap');

        const jobs = await appRequest(`/film/projects/${projectId}/music/jobs`);
        assert.equal(jobs.status, 200);
        const job = (jobs.data.jobs || []).find(j => j.gen_type === 'score');
        assert.ok(job, 'a score job was recorded');
        assert.equal(job.status, 'complete');
    });

    it('ambient route resolves ElevenLabs and stores a looping bed', async () => {
        const proj = await appRequest('/film/projects', { method: 'POST', body: { title: 'ElevenLabs Ambient Test', logline: 'x' } });
        const projectId = proj.data.id;

        const cfg = await appRequest(`/film/projects/${projectId}/providers`, {
            method: 'PUT',
            body: { config: { ambient: 'elevenlabs' } },
        });
        assert.equal(cfg.data.config.ambient, 'elevenlabs');

        await appRequest(`/film/projects/${projectId}/script`, {
            method: 'POST',
            body: { content: 'Title: Ambient Test\n\nEXT. CITY STREET - NIGHT\n\nTraffic hums.\n', format: 'fountain' },
        });
        const scenes = await appRequest(`/film/projects/${projectId}/scenes`);
        const sceneId = scenes.data.scenes[0].id;

        const generated = await appRequest(`/film/scenes/${sceneId}/ambient/generate`, { method: 'POST', body: {} });
        assert.equal(generated.status, 200);
        assert.match(generated.data.ambient_url || '', /\.wav$/);

        // The bed must be a bounded loop, not a scene-length render.
        assert.ok(lastRequest.body.loop === true, 'ambient asked for a seamless loop');
        assert.ok(lastRequest.body.duration_seconds <= 30, `bed of ${lastRequest.body.duration_seconds}s exceeds the endpoint ceiling`);

        const served = await appRequest(generated.data.ambient_url);
        assert.equal(served.status, 200);
        assert.ok(served.raw.startsWith('RIFF'), 'the served bed is not a WAV');
        assert.ok(served.raw.endsWith('mock-sfx-audio'), 'the samples did not survive the wrap');
    });

    it('the mix payload actually carries the loop instruction', async () => {
        // The whole point of this work is that a short bed gets tiled. Verifying
        // buildMixPayload in isolation would pass even if the route never set
        // loop on the track -- which is exactly how loopable/crossfade_s sat
        // dead for so long. So this reads the payload the route really sent.
        const proj = await appRequest('/film/projects', { method: 'POST', body: { title: 'ElevenLabs Mix Loop Test', logline: 'x' } });
        const projectId = proj.data.id;
        await appRequest(`/film/projects/${projectId}/providers`, { method: 'PUT', body: { config: { ambient: 'elevenlabs' } } });
        await appRequest(`/film/projects/${projectId}/script`, {
            method: 'POST',
            body: { content: 'Title: Mix Test\n\nINT. BAR - NIGHT\n\nQuiet.\n', format: 'fountain' },
        });
        const scenes = await appRequest(`/film/projects/${projectId}/scenes`);
        const sceneId = scenes.data.scenes[0].id;

        // A 90s shot with a bed that is far shorter than it.
        const shots = await appRequest('/film/shots', {
            method: 'POST',
            body: {
                scene_id: sceneId,
                cards: [{ shot_code: '1A', duration_ms: 90000, camera: { shot_type: 'wide', movement: 'static' } }],
            },
        });
        assert.equal(shots.status, 201);
        const shotId = shots.data.shots[0].id;

        await appRequest(`/film/scenes/${sceneId}/ambient/generate`, { method: 'POST', body: {} });

        // The mix service is not running here; the route records the payload it
        // built before dispatching, which is the part under test.
        await appRequest(`/film/shots/${shotId}/audio/mix`, { method: 'POST', body: {} });

        const row = db.prepare(
            'SELECT params FROM film_audio_mix_jobs WHERE shot_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(shotId);
        assert.ok(row, 'a mix job recorded its payload');

        const payload = JSON.parse(row.params);
        const bed = payload.tracks.find(t => t.type === 'ambient');
        assert.ok(bed, 'the ambient bed is in the mix');
        assert.equal(bed.loop, true, 'the bed is marked to loop');
        assert.equal(bed.loop_until_ms, 90000, 'the bed loops for the full shot');
        assert.equal(bed.loop_crossfade_ms, 5000, 'repeats are crossfaded');
        assert.ok(bed.duration_ms < bed.loop_until_ms, 'the bed really is shorter than its slot');
    });
});
