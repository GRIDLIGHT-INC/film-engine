/**
 * Unit/integration tests for the OpenAI image adapter (lib/providers/openai-image.js).
 * Uses an in-process mock OpenAI server via OPENAI_BASE_URL — no real API calls.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Point at a throwaway database BEFORE requiring db/database, which resolves its
// path at import time. Without this the suite opened whatever database happened
// to live at the default location and failed with "no such table:
// film_provider_credentials" on any machine where the server had never been run
// — a test depending on ambient state rather than on the code under test.
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-openai-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
const { ensureSchema } = require('../db/schema');

// Apply the real migrations rather than hand-rolling the table: a local CREATE
// TABLE silently drifts from 044_provider_layer.sql (which has updated_at NOT
// NULL), so the suite would keep passing against a schema production does not have.
ensureSchema();

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

    it('uses the image edit endpoint when local consistency references are available', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-ref-'));
        const refPath = path.join(dir, 'ref.png');
        fs.writeFileSync(refPath, Buffer.from('PNG'));
        const r = buildImageRequest({
            prompt: 'same character',
            reference_images: [{ file_path: refPath }],
        });
        assert.match(r.url, /\/images\/edits$/);
        assert.ok(r.form);
        assert.equal(r.referenceCount, 1);
    });

    it('preserves sorted multi-reference order for image edits', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-refs-'));
        const canonical = path.join(dir, 'canonical.png');
        const front = path.join(dir, 'front.png');
        const side = path.join(dir, 'side.png');
        fs.writeFileSync(canonical, Buffer.from('PNG'));
        fs.writeFileSync(front, Buffer.from('PNG'));
        fs.writeFileSync(side, Buffer.from('PNG'));
        const r = buildImageRequest({
            prompt: 'same character',
            reference_images: [
                { file_path: canonical, role: 'canonical' },
                { file_path: front, role: 'front' },
                { file_path: side, role: 'side' },
            ],
        });
        assert.deepEqual(r.referencePaths, [canonical, front, side]);
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
                if (req.url === '/v1/responses') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ id: 'resp-123', output_text: 'INT. ROOM - DAY\n\nA scene begins.' }));
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
        try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
    });

    beforeEach(() => { mode = 'ok'; });

    it('advertises the image capability and needs a key', () => {
        assert.equal(adapter.id, 'openai');
        assert.equal(adapter.kind, 'generator');
        assert.equal(adapter.requiresKey, true);
        assert.equal(adapter.supports('image'), true);
        assert.equal(adapter.supports('llm'), true);
        assert.equal(adapter.supports('video'), false);
    });

    it('generates LLM text through the Responses API', async () => {
        const r = await adapter.generate('llm', {
            question: 'Write a scene.',
            conversation_history: [{ question: 'Genre?', answer: 'Noir.' }],
        });
        assert.equal(r.ok, true);
        assert.equal(r.data.answer, 'INT. ROOM - DAY\n\nA scene begins.');
        assert.equal(r.provider, 'openai');
        assert.equal(r.provider_model, 'gpt-4.1');
        assert.equal(r.provider_job_id, 'resp-123');
        assert.equal(lastRequestBody.model, 'gpt-4.1');
        assert.equal(lastRequestBody.input.at(-1).content, 'Write a scene.');
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

    it('generates with local consistency references via multipart edit request', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-ref-gen-'));
        const refPath = path.join(dir, 'ref.png');
        fs.writeFileSync(refPath, Buffer.from('PNG'));
        const r = await adapter.generate('image', {
            prompt: 'a locked character',
            reference_images: [{ file_path: refPath }],
        });
        assert.equal(r.ok, true);
        assert.ok(Buffer.isBuffer(r.data));
        assert.equal(r.meta.reference_count, 1);
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
        const saved = db.prepare('SELECT * FROM film_provider_credentials WHERE provider = ?').get('openai');
        db.prepare('DELETE FROM film_provider_credentials WHERE provider = ?').run('openai');
        delete process.env.OPENAI_API_KEY;
        try {
            const r = await adapter.generate('image', { prompt: 'x' });
            assert.equal(r.ok, false);
            assert.equal(r.status, 401);
        } finally {
            process.env.OPENAI_API_KEY = 'sk-test-key';
            if (saved) {
                db.prepare(
                    `INSERT INTO film_provider_credentials (provider, api_key, meta, updated_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(provider) DO UPDATE SET api_key=excluded.api_key, meta=excluded.meta, updated_at=excluded.updated_at`
                ).run(saved.provider, saved.api_key || '', saved.meta || '{}', saved.updated_at || new Date().toISOString());
            }
        }
    });
});
