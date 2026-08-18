/**
 * Anthropic adapter, against a mock Messages API.
 *
 * What these pin, in order of how badly each one bites:
 *
 *  - Auth is `x-api-key` + `anthropic-version`. Sending a Bearer token is the
 *    obvious wrong guess (every other adapter here uses one) and fails with a
 *    401 that reads like a bad key rather than a bad header.
 *  - The system prompt goes in `system`, not glued to the front of the question.
 *  - A refusal is an HTTP 200 whose `content` is empty or partial. Reading
 *    content[0].text unconditionally returns silence and calls it success.
 *  - `data.answer` is the shape llm-client's extractAnswer reads; returning the
 *    raw Messages response instead yields an empty answer with ok:true.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-anthropic-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();
const { db } = require('../db/database');

db.prepare(`INSERT INTO film_provider_credentials (provider, api_key, meta, updated_at)
            VALUES ('anthropic', 'test-key', '{}', datetime('now'))
            ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key`).run();

const { adapter, buildMessagesRequest, extractText, API_VERSION, DEFAULT_MODEL } =
    require('../lib/providers/anthropic');

/** Mock server; `handler` receives the parsed body and the request. */
function withServer(handler, run) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                let parsed; try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
                try { handler(parsed, req, res); } catch (err) { reject(err); }
            });
        });
        server.listen(0, async () => {
            const prev = process.env.ANTHROPIC_BASE_URL;
            process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
            try { await run(); resolve(); } catch (err) { reject(err); } finally {
                if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
                else process.env.ANTHROPIC_BASE_URL = prev;
                server.close();
            }
        });
    });
}

function ok(res, payload) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

const MESSAGE = (text) => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_MODEL,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
});

// ── Payload construction (pure) ─────────────────────────────────────────────

test('the system prompt is lifted out, not prepended to the question', () => {
    const body = buildMessagesRequest({ question: 'Break down this scene.', system: 'You are a script supervisor.' });
    assert.strictEqual(body.system, 'You are a script supervisor.');
    assert.strictEqual(body.messages[0].content, 'Break down this scene.',
        'the system prompt leaked into the user turn');
    assert.strictEqual(body.messages[0].role, 'user');
});

test('system_prompt is accepted as an alias, and absent when neither is given', () => {
    assert.strictEqual(buildMessagesRequest({ question: 'q', system_prompt: 'S' }).system, 'S');
    assert.ok(!('system' in buildMessagesRequest({ question: 'q' })),
        'an empty system field would be sent as a blank prompt');
});

test('streaming asks for more output headroom than the blocking path', () => {
    const blocking = buildMessagesRequest({ question: 'q' }, { stream: false });
    const streaming = buildMessagesRequest({ question: 'q' }, { stream: true });
    assert.ok(streaming.max_tokens > blocking.max_tokens);
    assert.strictEqual(streaming.stream, true);
    assert.ok(!('stream' in blocking));
});

test('extractText concatenates every text block and ignores the rest', () => {
    assert.strictEqual(extractText({ content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two' },
    ] }), 'one two');
    assert.strictEqual(extractText({}), '');
    assert.strictEqual(extractText(null), '');
});

// ── The wire ────────────────────────────────────────────────────────────────

test('auth is x-api-key plus a pinned version, never a Bearer token', async () => {
    let seen = null;
    await withServer((body, req, res) => { seen = req.headers; ok(res, MESSAGE('hi')); }, async () => {
        await adapter.generate('llm', { question: 'hi' });
    });
    assert.strictEqual(seen['x-api-key'], 'test-key');
    assert.strictEqual(seen['anthropic-version'], API_VERSION);
    assert.ok(!seen.authorization, 'sent an Authorization header; the Messages API ignores it and 401s');
});

test('a successful call returns the answer where extractAnswer looks for it', async () => {
    let result;
    await withServer((body, req, res) => ok(res, MESSAGE('Scene 1 is exterior.')), async () => {
        result = await adapter.generate('llm', { question: 'break it down' });
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.answer, 'Scene 1 is exterior.',
        'llm-client reads result.data.answer — a raw Messages body yields an empty answer with ok:true');
    assert.strictEqual(result.answer, 'Scene 1 is exterior.');
    assert.strictEqual(result.provider, 'anthropic');
    assert.strictEqual(result.provider_model, DEFAULT_MODEL);
    assert.strictEqual(result.usage.output_tokens, 5);
});

test('a refusal is a failure, not an empty success', async () => {
    // HTTP 200, empty content. The trap this guards is reading content[0].
    let result;
    await withServer((body, req, res) => ok(res, {
        id: 'msg_2', type: 'message', role: 'assistant', model: DEFAULT_MODEL,
        content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' },
    }), async () => {
        result = await adapter.generate('llm', { question: 'something declined' });
    });
    assert.strictEqual(result.ok, false, 'a refusal read as success and returned silence');
    assert.strictEqual(result.refused, true);
    assert.match(result.error, /cyber/);
});

test('an API error is surfaced with its own message', async () => {
    let result;
    await withServer((body, req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }));
    }, async () => {
        result = await adapter.generate('llm', { question: 'hi' });
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.match(result.error, /credit balance is too low/,
        'the provider message was swallowed, leaving an unactionable failure');
});

test('an unsupported capability is refused without calling out', async () => {
    const before = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';   // would ECONNREFUSED if called
    const r = await adapter.generate('image', { question: 'x' });
    if (before === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = before;
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /unsupported capability/);
});

test('a missing question is refused before the request is built', async () => {
    const r = await adapter.generate('llm', {});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /question is required/);
});

// ── Streaming ───────────────────────────────────────────────────────────────

test('SSE text deltas accumulate and arrive as tokens', async () => {
    const tokens = [];
    let result;
    await withServer((body, req, res) => {
        assert.strictEqual(body.stream, true, 'stream flag was not set on the request');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const evt of [
            { type: 'message_start', message: { id: 'msg_3', model: DEFAULT_MODEL } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'INT. ' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'KITCHEN' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
            { type: 'message_stop' },
        ]) res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
        res.end();
    }, async () => {
        result = await adapter.generateStream('llm', { question: 'write a slugline' }, null, {
            onToken: t => tokens.push(t),
        });
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.finalData.answer, 'INT. KITCHEN');
    assert.deepStrictEqual(tokens, ['INT. ', 'KITCHEN'], 'tokens were not relayed as they arrived');
});

test('thinking deltas are not relayed as if they were answer text', async () => {
    // They stream with empty text by default; forwarding them emits nothing and
    // reads as a stalled response.
    const tokens = [];
    let result;
    await withServer((body, req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const evt of [
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
            { type: 'message_stop' },
        ]) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        res.end();
    }, async () => {
        result = await adapter.generateStream('llm', { question: 'q' }, null, { onToken: t => tokens.push(t) });
    });
    assert.deepStrictEqual(tokens, ['done']);
    assert.strictEqual(result.finalData.answer, 'done');
});

test('a mid-stream refusal fails rather than returning the partial', async () => {
    let result;
    await withServer((body, req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const evt of [
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
            { type: 'message_delta', delta: { stop_reason: 'refusal' } },
        ]) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        res.end();
    }, async () => {
        result = await adapter.generateStream('llm', { question: 'q' }, null, {});
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /declined/);
});

// ── Registry integration ────────────────────────────────────────────────────

test('the adapter is registered, keyed, and declares a connection spec', () => {
    const providers = require('../lib/providers');
    const a = providers.get('anthropic');
    assert.ok(a, 'anthropic did not autoload from lib/providers/');
    assert.strictEqual(a.requiresKey, true);
    assert.ok(a.connection && a.connection.helpUrl,
        'a keyed adapter with no connection spec shows in Settings with no way to enter the key');
    assert.deepStrictEqual(a.capabilities, ['llm']);
});
