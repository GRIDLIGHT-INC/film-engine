/**
 * Unit/integration tests for the OpenAI image adapter (lib/providers/openai-image.js).
 * Uses an in-process mock OpenAI server via OPENAI_BASE_URL — no real API calls.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { adapter, buildImageRequest } = require('../lib/providers/openai-image');

describe('openai-image: buildImageRequest (pure)', () => {
    it('maps landscape/portrait/square to supported sizes', () => {
        assert.equal(buildImageRequest({ prompt: 'x', width: 1536, height: 1024 }).size, '1536x1024');
        assert.equal(buildImageRequest({ prompt: 'x', width: 1024, height: 1536 }).size, '1024x1536');
        assert.equal(buildImageRequest({ prompt: 'x', width: 1024, height: 1024 }).size, '1024x1024');
    });
    it('honors an explicit valid size and defaults quality to high', () => {
        const r = buildImageRequest({ prompt: 'x', size: '1024x1536' });
        assert.equal(r.size, '1024x1536');
        assert.equal(r.body.quality, 'high');
        assert.equal(r.body.model, 'gpt-image-1');
    });
    it('folds negative_prompt into the prompt', () => {
        const r = buildImageRequest({ prompt: 'a castle', negative_prompt: 'blurry' });
        assert.match(r.body.prompt, /a castle/);
        assert.match(r.body.prompt, /Avoid: blurry/);
    });
});

describe('openai-image adapter (mock server)', () => {
    let server, baseUrl, lastRequestBody;
    const PNG_B64 = Buffer.from('FAKE-PNG-BYTES').toString('base64');
    let mode = 'ok'; // 'ok' | 'error'

    before(async () => {
        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => {
                try { lastRequestBody = JSON.parse(raw || '{}'); } catch { lastRequestBody = null; }
                if (mode === 'error') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: { message: 'bad prompt' } }));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: 'img-123', data: [{ b64_json: PNG_B64, revised_prompt: 'refined' }] }));
            });
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
        process.env.OPENAI_BASE_URL = baseUrl;
        process.env.OPENAI_API_KEY = 'sk-test-key';
    });

    after(() => {
        server.close();
        delete process.env.OPENAI_BASE_URL;
        delete process.env.OPENAI_API_KEY;
    });

    beforeEach(() => { mode = 'ok'; });

    it('advertises the image capability and needs a key', () => {
        assert.equal(adapter.id, 'openai');
        assert.equal(adapter.kind, 'generator');
        assert.equal(adapter.requiresKey, true);
        assert.equal(adapter.supports('image'), true);
        assert.equal(adapter.supports('video'), false);
    });

    it('generates an image and returns decoded bytes + provenance', async () => {
        const r = await adapter.generate('image', { prompt: 'a neon city', width: 1024, height: 1024 });
        assert.equal(r.ok, true);
        assert.ok(Buffer.isBuffer(r.data));
        assert.equal(r.data.toString(), 'FAKE-PNG-BYTES');
        assert.equal(r.contentType, 'image/png');
        assert.equal(r.provider, 'openai');
        assert.equal(r.provider_model, 'gpt-image-1');
        assert.equal(r.provider_job_id, 'img-123');
        assert.equal(r.meta.format, 'png');
        // request mapping reached the server
        assert.equal(lastRequestBody.model, 'gpt-image-1');
        assert.equal(lastRequestBody.size, '1024x1024');
        assert.match(lastRequestBody.prompt, /neon city/);
    });

    it('rejects an unsupported capability', async () => {
        const r = await adapter.generate('video', { prompt: 'x' });
        assert.equal(r.ok, false);
        assert.equal(r.status, 400);
    });

    it('requires a prompt', async () => {
        const r = await adapter.generate('image', {});
        assert.equal(r.ok, false);
        assert.equal(r.status, 400);
    });

    it('surfaces upstream errors as {ok:false}', async () => {
        mode = 'error';
        const r = await adapter.generate('image', { prompt: 'x' });
        assert.equal(r.ok, false);
        assert.equal(r.status, 400);
        assert.match(r.error, /bad prompt/);
    });

    it('returns 401 when no key is configured', async () => {
        delete process.env.OPENAI_API_KEY;
        const r = await adapter.generate('image', { prompt: 'x' });
        assert.equal(r.ok, false);
        assert.equal(r.status, 401);
        process.env.OPENAI_API_KEY = 'sk-test-key';
    });
});
