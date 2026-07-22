/**
 * Tests for the Artlist MCP adapter + the OAuth (PKCE/discovery) helpers.
 * Uses in-process mock MCP and OAuth servers — no real network calls.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { db } = require('../db/database');
const oauth = require('../lib/providers/oauth');
const { adapter, pickTool, normalizeToolResult } = require('../lib/providers/artlist-mcp');

describe('providers/oauth helpers', () => {
    it('makePkce produces a valid S256 verifier/challenge/state', () => {
        const { verifier, challenge, state } = oauth.makePkce();
        assert.ok(verifier && challenge && state);
        const expected = oauth.base64url(crypto.createHash('sha256').update(verifier).digest());
        assert.equal(challenge, expected);
    });

    it('buildAuthorizeUrl includes PKCE + client + redirect params', () => {
        const url = oauth.buildAuthorizeUrl(
            { authorization_endpoint: 'https://auth.example/authorize' },
            { clientId: 'c1', redirectUri: 'http://localhost:3100/cb', challenge: 'ch', state: 'st', scope: 'a b' }
        );
        const u = new URL(url);
        assert.equal(u.searchParams.get('response_type'), 'code');
        assert.equal(u.searchParams.get('client_id'), 'c1');
        assert.equal(u.searchParams.get('code_challenge'), 'ch');
        assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(u.searchParams.get('state'), 'st');
    });

    describe('discover + exchangeCode (mock OAuth server)', () => {
        let server, origin;
        before(async () => {
            server = http.createServer((req, res) => {
                if (req.url.startsWith('/.well-known/oauth-protected-resource')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ authorization_servers: [origin] }));
                }
                if (req.url.startsWith('/.well-known/oauth-authorization-server')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        authorization_endpoint: `${origin}/authorize`,
                        token_endpoint: `${origin}/token`,
                        registration_endpoint: `${origin}/register`,
                    }));
                }
                if (req.url === '/token') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ access_token: 'tok-123', token_type: 'Bearer', expires_in: 3600 }));
                }
                res.writeHead(404); res.end();
            });
            await new Promise(r => server.listen(0, '127.0.0.1', r));
            origin = `http://127.0.0.1:${server.address().port}`;
        });
        after(() => server.close());

        it('discovers authorization-server metadata from a server URL', async () => {
            const meta = await oauth.discover(`${origin}/mcp`);
            assert.equal(meta.authorization_endpoint, `${origin}/authorize`);
            assert.equal(meta.token_endpoint, `${origin}/token`);
        });

        it('exchanges an auth code for tokens', async () => {
            const tokens = await oauth.exchangeCode(
                { token_endpoint: `${origin}/token` },
                { code: 'abc', clientId: 'c1', redirectUri: `${origin}/cb`, verifier: 'v' }
            );
            assert.equal(tokens.access_token, 'tok-123');
        });
    });
});

describe('providers/artlist-mcp adapter', () => {
    it('declares an OAuth connection spec and image+video+voice capabilities', () => {
        assert.equal(adapter.id, 'artlist-mcp');
        assert.equal(adapter.kind, 'mcp');
        assert.equal(adapter.requiresKey, false);
        assert.ok(adapter.connection && adapter.connection.oauth);
        assert.equal(adapter.connection.oauth.connectPath, '/providers/artlist-mcp/connect');
        assert.equal(adapter.supports('image'), true);
        assert.equal(adapter.supports('video'), true);
        assert.equal(adapter.supports('voice'), true);
        assert.equal(adapter.supports('music'), false);
    });

    it('pickTool selects by capability heuristics', () => {
        const meta = { tools: [{ name: 'nano_banana_image' }, { name: 'kling_video' }, { name: 'voiceover_tts' }] };
        assert.match(pickTool('image', meta), /image/);
        assert.match(pickTool('video', meta), /video/);
        assert.match(pickTool('voice', meta), /tts/);
        assert.equal(pickTool('image', { image_tool: 'my_img' }), 'my_img');
        assert.equal(pickTool('voice', { voice_tool: 'my_voice' }), 'my_voice');
        assert.equal(pickTool('voice', { tools: [{ name: 'generate_image' }] }), null);
    });

    it('normalizeToolResult decodes an inline image block', async () => {
        const b64 = Buffer.from('IMG').toString('base64');
        const norm = await normalizeToolResult({ content: [{ type: 'image', data: b64, mimeType: 'image/png' }] });
        assert.ok(Buffer.isBuffer(norm.data));
        assert.equal(norm.data.toString(), 'IMG');
    });

    it('normalizeToolResult decodes inline audio blocks', async () => {
        const b64 = Buffer.from('WAV').toString('base64');
        const norm = await normalizeToolResult({ content: [{ type: 'audio', data: b64, mimeType: 'audio/wav' }] });
        assert.ok(Buffer.isBuffer(norm.data));
        assert.equal(norm.data.toString(), 'WAV');
        assert.equal(norm.contentType, 'audio/wav');
        assert.equal(norm.meta.format, 'wav');
    });

    it('normalizeToolResult preserves audio URLs from text blocks', async () => {
        const norm = await normalizeToolResult({ content: [{ type: 'text', text: 'done: https://cdn.example/dialogue.mp3?sig=1' }] });
        assert.deepEqual(norm.data, { audio_url: 'https://cdn.example/dialogue.mp3?sig=1' });
        assert.equal(norm.meta.format, 'mp3');
    });

    it('returns 401 when not connected', async () => {
        db.prepare('DELETE FROM film_provider_credentials WHERE provider = ?').run('artlist-mcp');
        const r = await adapter.generate('image', { prompt: 'x' });
        assert.equal(r.ok, false);
        assert.equal(r.status, 401);
    });

    it('returns a clear error when voice is selected without a discovered voice tool', async () => {
        db.prepare(
            "INSERT INTO film_provider_credentials (provider, api_key, meta, updated_at) VALUES ('artlist-mcp','',?,datetime('now')) ON CONFLICT(provider) DO UPDATE SET meta=excluded.meta"
        ).run(JSON.stringify({ access_token: 'tok', tools: [{ name: 'generate_image' }] }));
        const r = await adapter.generate('voice', { text: 'Hello' });
        assert.equal(r.ok, false);
        assert.equal(r.status, 400);
        assert.match(r.error, /no voiceover\/TTS tool/i);
        db.prepare('DELETE FROM film_provider_credentials WHERE provider = ?').run('artlist-mcp');
    });

    describe('generate via mock MCP server', () => {
        let server, url, lastCall;
        before(async () => {
            server = http.createServer((req, res) => {
                let raw = ''; req.on('data', c => raw += c);
                req.on('end', () => {
                    const msg = JSON.parse(raw || '{}');
                    if (msg.method === 'tools/call') {
                        lastCall = msg.params;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        const isVoice = msg.params && msg.params.name === 'voiceover_tts';
                        const content = isVoice
                            ? [{ type: 'audio', data: Buffer.from('MCP-WAV').toString('base64'), mimeType: 'audio/wav' }]
                            : [{ type: 'image', data: Buffer.from('MCP-PNG').toString('base64'), mimeType: 'image/png' }];
                        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content } }));
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
                });
            });
            await new Promise(r => server.listen(0, '127.0.0.1', r));
            url = `http://127.0.0.1:${server.address().port}/mcp`;
            process.env.ARTLIST_MCP_URL = url;
            db.prepare(
                "INSERT INTO film_provider_credentials (provider, api_key, meta, updated_at) VALUES ('artlist-mcp','',?,datetime('now')) ON CONFLICT(provider) DO UPDATE SET meta=excluded.meta"
            ).run(JSON.stringify({ access_token: 'tok', image_tool: 'generate_image', voice_tool: 'voiceover_tts' }));
        });
        after(() => {
            server.close();
            delete process.env.ARTLIST_MCP_URL;
            db.prepare('DELETE FROM film_provider_credentials WHERE provider = ?').run('artlist-mcp');
        });

        it('generates an image via tools/call and returns bytes + provenance', async () => {
            lastCall = null;
            const r = await adapter.generate('image', {
                prompt: 'a neon alley',
                reference_images: [{ file_path: 'https://cdn.example/ref.png', role: 'canonical', weight: 0.8, subject_name: 'Mara' }],
                input_refs: ['asset-1'],
            });
            assert.equal(r.ok, true);
            assert.ok(Buffer.isBuffer(r.data));
            assert.equal(r.data.toString(), 'MCP-PNG');
            assert.equal(r.provider, 'artlist-mcp');
            assert.equal(r.provider_model, 'generate_image');
            assert.equal(r.meta.license_source, 'generated');
            assert.deepEqual(lastCall.arguments.reference_images, [{ url: 'https://cdn.example/ref.png', role: 'canonical', weight: 0.8, subject: 'Mara' }]);
            assert.deepEqual(lastCall.arguments.input_refs, ['asset-1']);
        });

        it('generates voice via tools/call using dialogue text without image dimensions', async () => {
            lastCall = null;
            const r = await adapter.generate('voice', {
                text: 'The city hums below us.',
                prompt: 'ignore me',
                width: 1024,
                height: 1024,
                voice_id: 'narrator',
            });
            assert.equal(r.ok, true);
            assert.ok(Buffer.isBuffer(r.data));
            assert.equal(r.data.toString(), 'MCP-WAV');
            assert.equal(r.contentType, 'audio/wav');
            assert.equal(r.meta.format, 'wav');
            assert.equal(lastCall.name, 'voiceover_tts');
            assert.equal(lastCall.arguments.text, 'The city hums below us.');
            assert.equal(lastCall.arguments.prompt, 'The city hums below us.');
            assert.equal(lastCall.arguments.voice_id, 'narrator');
            assert.equal('width' in lastCall.arguments, false);
            assert.equal('height' in lastCall.arguments, false);
        });
    });
});
