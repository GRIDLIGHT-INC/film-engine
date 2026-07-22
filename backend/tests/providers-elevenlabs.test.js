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
                res.end(Buffer.from('mock-tts-audio'));
                return;
            }

            if (req.url === '/v1/sound-generation') {
                res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'request-id': 'sfx-req-1' });
                res.end(Buffer.from('mock-sfx-audio'));
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

    it('registers through provider autoload and advertises voice+sfx', () => {
        assert.equal(adapter.id, 'elevenlabs');
        assert.equal(adapter.kind, 'generator');
        assert.equal(adapter.requiresKey, true);
        assert.equal(adapter.supports('voice'), true);
        assert.equal(adapter.supports('sfx'), true);
        assert.equal(adapter.supports('image'), false);
        assert.equal(providers.get('elevenlabs').id, 'elevenlabs');
        assert.equal(providers.resolve('voice', { voice: 'elevenlabs' }).id, 'elevenlabs');
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
        assert.equal(request.url, `${baseUrl}/sound-generation`);
        assert.equal(request.body.text, 'metal door slam');
        assert.equal(request.body.duration_seconds, 30);
        assert.equal(request.model, 'elevenlabs-sound-effects');
    });

    it('normalizes output format to a provider-supported audio type', () => {
        assert.equal(normalizeOutputFormat({ output_format: 'mp3_44100_128' }), 'mp3_44100_128');
        assert.equal(normalizeOutputFormat({ output_format: 'wav' }), 'mp3_44100_128');
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
        assert.match(generated.data.audio_files[0].audio_url, /\.mp3$/);

        const status = await appRequest(`/film/shots/${shotId}/voice`);
        assert.equal(status.status, 200);
        const asset = status.data.audio_files[0];
        assert.match(asset.file_name, /\.mp3$/);
        assert.equal(asset.provider, 'elevenlabs');
        assert.equal(asset.provider_model, 'eleven_multilingual_v2');
        assert.equal(asset.license_source, 'generated');
        assert.equal(asset.license_status, 'generated');
        assert.ok(asset.prompt_hash);

        const served = await appRequest(asset.audio_url);
        assert.equal(served.status, 200);
        assert.match(served.headers['content-type'], /audio\/mpeg/);
        assert.equal(served.raw, 'mock-tts-audio');
    });
});
