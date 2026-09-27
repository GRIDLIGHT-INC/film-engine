/**
 * Gridlight video, held to the gateway's own contract.
 *
 * Set-based over the registries the contract defines — every reference KIND,
 * every documented error STATUS, every SSE EVENT that matters, every LIMIT —
 * against a fake gateway that speaks the brief: `GET /media/capabilities`,
 * `POST /video` and `POST /video/production` as Server-Sent Events, and a
 * gateway-relative `video_url` that only answers to the Bearer token.
 *
 * The failures this exists to catch are all silent: a reference the model does
 * not take sent anyway (a 422 learned the expensive way) or dropped without a
 * word; a stream that stopped read as success; a 429 hammered; two renders at
 * once against an agent that does one.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-test-' + crypto.randomUUID().slice(0, 8));

const gv = require('../lib/gridlight-video');

const TOKEN = 'test-token-gridlight';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), crypto.randomBytes(64)]);
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), crypto.randomBytes(64)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), crypto.randomBytes(64)]);
const png = () => `data:image/png;base64,${Buffer.concat([PNG, crypto.randomBytes(8)]).toString('base64')}`;
const mp4 = () => `data:video/mp4;base64,${Buffer.concat([MP4, crypto.randomBytes(8)]).toString('base64')}`;

/** LTX-2.5 as the brief describes it: all six kinds, from its own manifest. */
const LTX = {
    id: 'ltx-2.5', available: true, has_audio: true,
    inputs: [
        { id: 'keyframe', kind: 'keyframe', field: 'references', accepts: ['image/png', 'image/jpeg', 'image/webp'], max: 8, at: ['start', 'end', 'seconds'], max_body_bytes: 512 * 1048576 },
        { id: 'clip', kind: 'clip', field: 'references', accepts: ['video/mp4'], max: 2, at: ['start', 'end'] },
        { id: 'character', kind: 'character', field: 'references', accepts: ['image/png', 'image/jpeg', 'image/webp'], max: 4 },
        { id: 'location', kind: 'location', field: 'references', accepts: ['image/png', 'image/jpeg', 'image/webp'], max: 2 },
        { id: 'prop', kind: 'prop', field: 'references', accepts: ['image/png', 'image/jpeg', 'image/webp'], max: 4 },
        { id: 'transform', kind: 'transform', field: 'references', accepts: ['video/mp4'], max: 1,
            effects: ['day_to_night', 'colorize', 'deblur', 'clean_plate', 'decompress', 'upscale_x2', 'water_simulation'],
            excludes: ['keyframe', 'clip', 'character', 'location', 'prop'] },
    ],
};
const WAN = { id: 'wan-2.2', available: true, has_audio: false, inputs: [
    { id: 'keyframe', kind: 'keyframe', field: 'init_image', accepts: ['image/png', 'image/jpeg'], max: 1, at: ['start'] },
    { id: 'clip', kind: 'clip', field: 'init_video', accepts: ['video/mp4'], max: 1, at: ['start'], excludes: ['keyframe'] },
] };
const H3 = { id: 'minimax-h3', available: true, has_audio: false, inputs: [] };
const WITHHELD = { id: 'ltx-territory', available: false, withheld_reason: 'not licensed in this territory', inputs: [] };

// -- the fake gateway -----------------------------------------------------------

function fakeGateway() {
    const state = {
        models: [LTX, WAN, H3, WITHHELD],
        posts: [],               // { path, body }
        script: [],              // per-POST responses, consumed in order; default = success stream
        inFlight: 0, maxInFlight: 0,
        downloads: [], capsReads: 0,
    };
    const server = http.createServer((req, res) => {
        const authed = req.headers.authorization === `Bearer ${TOKEN}`;
        if (req.method === 'GET' && req.url === '/media/capabilities') {
            state.capsReads += 1;
            if (!authed) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"bad token"}'); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ media: [{ medium: 'image', models: [] }, { medium: 'video', models: state.models }] }));
        }
        if (req.method === 'GET' && req.url.startsWith('/outputs/')) {
            state.downloads.push({ url: req.url, authed });
            if (!authed) { res.writeHead(401); return res.end('{"error":"bad token"}'); }
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length });
            return res.end(MP4);
        }
        if (req.method === 'POST' && (req.url === '/video' || req.url === '/video/production')) {
            let raw = '';
            req.on('data', c => { raw += c; });
            req.on('end', async () => {
                const body = JSON.parse(raw || '{}');
                state.posts.push({ path: req.url, body, authed });
                const step = state.script.shift() || { stream: 'ok' };
                if (step.status) {
                    res.writeHead(step.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: step.error || `status ${step.status}`, ...(step.extra || {}) }));
                }
                state.inFlight += 1;
                state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
                res.write(': keep-alive\n\n');
                const prod = req.url === '/video/production';
                send({ event: prod ? 'production_started' : 'started' });
                send({ event: 'model_loaded', model: body.model });
                await new Promise(r => setTimeout(r, 25));
                if (prod) {
                    for (let i = 0; i < body.shots.length; i++) { send({ event: 'shot_started', shot: i }); send({ event: 'shot_completed', shot: i }); }
                    send({ event: 'stitching' });
                } else {
                    send({ event: 'generating', step: 1, total_steps: 2, num_frames: 121, resolution: `${body.width}x${body.height}` });
                    send({ event: 'progress', step: 2, total: 2 });
                    send({ event: 'encoding_video' });
                }
                if (step.stream === 'nsfw') send({ event: 'nsfw_flagged' });
                if (step.stream === 'error') send({ event: 'error', error: step.error });
                if (step.stream !== 'truncated' && step.stream !== 'error') {
                    send({ event: 'completed', video_url: '/outputs/take.mp4', model: body.model, seed: 4242,
                        duration_seconds: body.duration_seconds || 5, fps: body.fps || 24,
                        resolution: `${body.width}x${body.height}`, has_audio: true, generation_time_ms: 1234,
                        mode: 'text2video', ...(prod ? { total_shots: body.shots.length } : {}) });
                }
                state.inFlight -= 1;
                res.end();
            });
            return;
        }
        res.writeHead(404); res.end();
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        state.url = `http://127.0.0.1:${server.address().port}`;
        resolve({ server, state });
    }));
}

let GW;
const opts = extra => ({ baseUrl: GW.state.url, token: TOKEN, measure: false, retryAfterMs: 0, force: true, ...(extra || {}) });
const base = extra => ({ prompt: 'She lifts the brass lantern and walks into the rain.', model: 'ltx-2.5',
    width: 960, height: 544, fps: 24, duration_seconds: 5, ...(extra || {}) });

test.before(async () => {
    GW = await fakeGateway();
    process.env.GRIDLIGHT_URL = GW.state.url;
    process.env.GRIDLIGHT_API_KEY = TOKEN;
});
test.after(() => GW.server.close());
test.beforeEach(() => { GW.state.posts = []; GW.state.script = []; GW.state.downloads = []; GW.state.models = [LTX, WAN, H3, WITHHELD]; gv.clearCapabilitiesCache(); });

// -- discovery --------------------------------------------------------------------

test('capabilities: the video medium\'s models, with only available ones offered', async () => {
    const caps = await gv.fetchCapabilities(opts());
    assert.ok(caps.ok, caps.error);
    assert.deepStrictEqual(caps.models.map(m => m.id), ['ltx-2.5', 'wan-2.2', 'minimax-h3', 'ltx-territory']);
    assert.deepStrictEqual(caps.available, ['ltx-2.5', 'wan-2.2', 'minimax-h3']);
    const ltx = caps.models[0];
    assert.strictEqual(ltx.has_audio, true);
    assert.deepStrictEqual(ltx.inputs.map(i => i.kind), Object.keys(gv.KINDS), 'LTX declares exactly the six kinds the contract defines');
    assert.strictEqual(ltx.max_body_bytes, 512 * 1048576);
});

test('capabilities are read with the Bearer token, and a wrong token is a 401 that says so', async () => {
    const bad = await gv.fetchCapabilities(opts({ token: 'wrong' }));
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(bad.code, 'TOKEN');
});

test('a gateway that is off is "the video server is off", not an empty model list', async () => {
    const off = await gv.fetchCapabilities({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, force: true });
    assert.strictEqual(off.ok, false);
    assert.strictEqual(off.code, 'SERVER_OFF');
    assert.match(off.error, /video server is off/);
});

test('the model is always named; a withheld one is refused with its reason, never swapped silently', async () => {
    const { models } = await gv.fetchCapabilities(opts());
    assert.strictEqual(gv.pickModel(models, 'wan-2.2').model.id, 'wan-2.2');
    const withheld = gv.pickModel(models, 'ltx-territory');
    assert.strictEqual(withheld.ok, false);
    assert.match(withheld.error, /not licensed in this territory/);
    const unknown = gv.pickModel(models, 'animatediff-sdxl');
    assert.strictEqual(unknown.model.id, 'ltx-2.5', 'an unknown ask runs the first available model that takes a keyframe');
    assert.strictEqual(unknown.substituted, true, 'and says it substituted');
    const built = gv.buildVideoRequest(base({ model: undefined }), unknown.model);
    assert.strictEqual(built.body.model, 'ltx-2.5', 'model is sent explicitly every time');
});

// -- references, set-based over the kinds ----------------------------------------

/** One Film Engine payload carrying one reference of `kind`. */
function payloadWith(kind, n) {
    const count = n || 1;
    const p = base();
    const many = f => Array.from({ length: count }, (_, i) => f(i));
    if (kind === 'keyframe') { p.init_image = png(); p.video_references = many(i => ({ role: 'inbetween', uri: png(), at: 0.5 + i * 0.5 })).slice(1); }
    if (kind === 'clip') p.clips = many(i => ({ data: mp4(), at: i % 2 ? 'end' : 'start' }));
    if (['character', 'location', 'prop'].includes(kind)) p.video_references = many(i => ({ role: kind, uri: png(), label: `${kind} ${i}` }));
    if (kind === 'transform') p.transform = { data: mp4(), effect: 'day_to_night' };
    return p;
}

for (const kind of Object.keys(gv.KINDS)) {
    test(`${kind}: sent when the model declares it, dropped with a reason when it does not`, () => {
        const sent = gv.buildVideoRequest(payloadWith(kind), LTX);
        assert.ok(sent.ok, sent.error);
        assert.ok(sent.body.references.some(r => r.kind === kind), `${kind} did not reach the request`);
        const r = sent.body.references.find(x => x.kind === kind);
        assert.doesNotMatch(r.data, /^data:/, 'references travel as bare base64');
        assert.ok(Buffer.from(r.data, 'base64').length > 8);

        const h3 = gv.buildVideoRequest(payloadWith(kind), H3);
        assert.ok(h3.ok);
        assert.strictEqual((h3.body.references || []).length, 0, `${kind} was sent to a model that takes nothing`);
        const drop = h3.references_dropped.find(d => d.kind === kind);
        assert.ok(drop, `${kind} vanished without a report`);
        assert.match(drop.reason, /declares no/);
    });

    test(`${kind}: capped at the model's own max, the rest reported`, () => {
        const cap = LTX.inputs.find(i => i.kind === kind).max;
        if (kind === 'transform') {
            const built = gv.buildVideoRequest({ ...payloadWith(kind), references: [{ kind: 'transform', data: MP4.toString('base64'), effect: 'deblur' }] }, LTX);
            assert.strictEqual(built.body.references.filter(r => r.kind === 'transform').length, cap);
            return;
        }
        const built = gv.buildVideoRequest(payloadWith(kind, cap + 2), LTX);
        const sheetRoom = gv.SHEET_PANELS;
        assert.strictEqual(built.body.references.filter(r => r.kind === kind).length, Math.min(cap, kind === 'keyframe' || kind === 'clip' ? cap : sheetRoom));
        assert.ok(built.references_dropped.some(d => d.kind === kind && /at most|panels/.test(d.reason)), `the ${kind} over the cap was not reported`);
    });
}

test('characters, locations and props share one six-panel sheet', () => {
    const p = base({ video_references: [
        ...[0, 1, 2, 3].map(i => ({ role: 'character', uri: png(), label: `c${i}` })),
        ...[0, 1].map(i => ({ role: 'location', uri: png(), label: `l${i}` })),
        { role: 'prop', uri: png(), label: 'lantern' },
    ] });
    const built = gv.buildVideoRequest(p, LTX);
    assert.strictEqual(built.body.references.filter(r => ['character', 'location', 'prop'].includes(r.kind)).length, gv.SHEET_PANELS);
    assert.match(built.references_dropped.find(d => d.label === 'lantern').reason, /6 panels/);
    assert.strictEqual(built.body.references[0].label, 'c0', 'sheet panels carry their label');
});

test('a transform is the only reference: everything else is dropped and said', () => {
    const p = { ...payloadWith('character'), init_image: png(), transform: { data: mp4(), effect: 'colorize' } };
    const built = gv.buildVideoRequest(p, LTX);
    assert.deepStrictEqual(built.body.references.map(r => r.kind), ['transform']);
    assert.strictEqual(built.body.references[0].effect, 'colorize');
    assert.ok(built.references_dropped.length >= 2);
    assert.strictEqual(built.mode, 'transform');
});

test('a transform effect the model does not list is refused locally', () => {
    const built = gv.buildVideoRequest(base({ transform: { data: mp4(), effect: 'make_it_pop' } }), LTX);
    assert.strictEqual((built.body.references || []).length, 0);
    assert.match(built.references_dropped[0].reason, /not one of day_to_night/);
});

test('the file type is read from the bytes and held to `accepts`', () => {
    const p = base({ video_references: [{ role: 'character', uri: `data:image/png;base64,${MP4.toString('base64')}`, label: 'liar' }] });
    const built = gv.buildVideoRequest(p, LTX);
    assert.strictEqual((built.body.references || []).length, 0);
    assert.match(built.references_dropped[0].reason, /video\/mp4 is not one of image/);
    const jpeg = gv.buildVideoRequest(base({ init_image: `data:image/jpeg;base64,${JPEG.toString('base64')}` }), LTX);
    assert.strictEqual(jpeg.references_sent[0].mime, 'image/jpeg');
});

test('a model that reads init_image / init_video gets the field, not a references array', () => {
    const built = gv.buildVideoRequest(base({ model: 'wan-2.2', init_image: png() }), WAN);
    assert.ok(built.body.init_image, 'Wan reads init_image');
    assert.strictEqual(built.body.references, undefined);
    const both = gv.buildVideoRequest(base({ init_image: png(), init_video: mp4() }), WAN);
    assert.ok(both.references_dropped.some(d => /cannot be combined/.test(d.reason)), 'excludes are honoured');
});

test('Film Engine roles map to gateway kinds; style and motion are refused by name', () => {
    const p = base({ init_image: png(), end_image: png(), video_references: [
        { role: 'inbetween', uri: png(), at: 2.5, strength: 0.8 },
        { role: 'creature', uri: png(), label: 'DRAGON' },
        { role: 'style', uri: png() },
        { role: 'motion', uri: mp4() },
    ] });
    const built = gv.buildVideoRequest(p, LTX);
    const kf = built.body.references.filter(r => r.kind === 'keyframe');
    assert.deepStrictEqual(kf.map(r => r.at), ['start', 'end', 2.5]);
    assert.strictEqual(kf[2].strength, 0.8);
    assert.ok(built.body.references.some(r => r.kind === 'character' && r.label === 'DRAGON'));
    for (const role of ['style', 'motion']) {
        assert.match(built.references_dropped.find(d => d.kind === role).reason, /refuses/);
    }
    for (const role of Object.keys(gv.ROLE_TO_KIND)) {
        assert.ok(gv.REFERENCE_CONTRACT.roles.includes(role), `${role} is not offered to the builder`);
    }
});

// -- limits -----------------------------------------------------------------------

test('keyframes closer than 8 frames are dropped; a time past the end is clamped', () => {
    const p = base({ init_image: png(), video_references: [
        { role: 'inbetween', uri: png(), at: 0.1 },   // 2.4 frames after start
        { role: 'inbetween', uri: png(), at: 9 },     // past a 5s video
    ] });
    const built = gv.buildVideoRequest(p, LTX);
    const ats = built.body.references.map(r => r.at);
    assert.deepStrictEqual(ats, ['start', 5]);
    assert.match(built.references_dropped[0].reason, /8 frames apart/);
    assert.ok(built.warnings.some(w => /clamped to 5s/.test(w)));
});

test('prompt, duration and fps are refused before sending; size snaps to 32 inside 3840x2160', () => {
    assert.strictEqual(gv.buildVideoRequest(base({ prompt: '' }), LTX).status, 400);
    assert.strictEqual(gv.buildVideoRequest(base({ prompt: 'x'.repeat(gv.LIMITS.prompt_chars + 1) }), LTX).field, 'prompt');
    assert.ok(gv.buildVideoRequest(base({ prompt: 'x'.repeat(gv.LIMITS.prompt_chars) }), LTX).ok);
    assert.strictEqual(gv.buildVideoRequest(base({ duration_seconds: 61 }), LTX).field, 'duration_seconds');
    assert.strictEqual(gv.buildVideoRequest(base({ fps: 7 }), LTX).field, 'fps');
    assert.strictEqual(gv.buildVideoRequest(base({ fps: 31 }), LTX).field, 'fps');
    const snapped = gv.buildVideoRequest(base({ width: 1000, height: 560 }), LTX);
    assert.deepStrictEqual([snapped.body.width, snapped.body.height], [992, 544]);
    const big = gv.buildVideoRequest(base({ width: 7680, height: 4320 }), LTX);
    assert.ok(big.body.width <= 3840 && big.body.height <= 2160 && big.body.width % 32 === 0);
    assert.ok(big.warnings.length);
});

test('the body budget is checked in encoded bytes and refused locally, with nothing sent', async () => {
    const tight = { ...LTX, id: 'ltx-tight', max_body_bytes: 2000 };
    GW.state.models = [tight];
    const big = `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(4000)]).toString('base64')}`;
    const r = await gv.generateVideo(base({ model: 'ltx-tight', init_image: big }), opts());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.refused_locally, true);
    assert.strictEqual(GW.state.posts.length, 0, 'an oversize request reached the gateway');
    assert.strictEqual(gv.base64Size(3), 4);
});

// -- the stream ---------------------------------------------------------------------

test('a clip: one POST /video with stream, model and references; progress events; the MP4 fetched with the token', async () => {
    const seen = [];
    const r = await gv.generateVideo(base({ init_image: png() }), opts({ onEvent: e => seen.push(e.event) }));
    assert.ok(r.ok, r.error);
    const post = GW.state.posts[0];
    assert.strictEqual(post.path, '/video');
    assert.strictEqual(post.authed, true);
    assert.strictEqual(post.body.stream, true);
    assert.strictEqual(post.body.model, 'ltx-2.5');
    assert.strictEqual(post.body.references[0].kind, 'keyframe');
    for (const e of ['started', 'model_loaded', 'generating', 'progress', 'encoding_video', 'completed']) {
        assert.ok(seen.includes(e), `${e} was not passed on`);
        assert.ok(gv.EVENTS[e], `${e} has no phase`);
    }
    assert.ok(Buffer.isBuffer(r.data) && gv.sniffMime(r.data) === 'video/mp4');
    assert.strictEqual(GW.state.downloads[0].authed, true, 'video_url was fetched without the Bearer token');
    assert.strictEqual(r.seed, 4242, 'the seed is kept to reproduce the take');
    assert.strictEqual(r.data.seed, 4242);
    assert.strictEqual(r.has_audio, true);
    assert.strictEqual(r.mode, 'image_to_video', 'mode is read from what was sent, not completed.mode');
    assert.strictEqual(r.resolution_requested, '960x544');
});

test('a stream that ends without `completed` is a failure', async () => {
    GW.state.script = [{ stream: 'truncated' }];
    const r = await gv.generateVideo(base(), opts());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'STREAM_INCOMPLETE');
    assert.strictEqual(GW.state.downloads.length, 0);
});

test('an error event: 507 is the GPU (retry smaller), a licence message is 424', async () => {
    GW.state.script = [{ stream: 'error', error: '507: CUDA out of memory' }];
    const oom = await gv.generateVideo(base(), opts());
    assert.strictEqual(oom.code, 'GPU_OUT_OF_MEMORY');
    assert.match(oom.error, /retry smaller/);
    GW.state.script = [{ stream: 'error', error: 'the Hugging Face licence for the IC-LoRA adapter has not been accepted' }];
    const lic = await gv.generateVideo(base(), opts());
    assert.strictEqual(lic.status, 424);
    assert.match(lic.error, /not enabled on this video server/);
});

test('nsfw_flagged is reported, not swallowed', async () => {
    GW.state.script = [{ stream: 'nsfw' }];
    const r = await gv.generateVideo(base(), opts());
    assert.ok(r.ok);
    assert.strictEqual(r.nsfw_flagged, true);
});

// -- errors, set-based over the documented statuses ----------------------------------

for (const status of Object.keys(gv.ERRORS).map(Number).filter(s => s !== 507)) {
    test(`HTTP ${status}: ${gv.ERRORS[status].code}, handled as the brief says`, async () => {
        const rule = gv.ERRORS[status];
        GW.state.script = [{ status, error: `gateway says ${status}`, extra: status === 429 ? { retry_after: 60 } : {} }];
        const r = await gv.generateVideo(base(), opts());
        if (rule.retry === 'after' || rule.retry === 'once') {
            assert.ok(r.ok, `${status} was not retried: ${r.error}`);
            assert.strictEqual(GW.state.posts.length, 2);
            return;
        }
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, status);
        assert.strictEqual(r.code, rule.code);
        assert.match(r.error, new RegExp(`gateway says ${status}`), 'the gateway\'s own message is shown');
        assert.strictEqual(GW.state.posts.length, 1, `${status} was replayed — it is our request, and would fail the same way`);
    });
}

test('502 is retried once, then reported', async () => {
    GW.state.script = [{ status: 502, error: 'agent died' }, { status: 502, error: 'agent died again' }];
    const r = await gv.generateVideo(base(), opts());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'AGENT_FAILED');
    assert.strictEqual(GW.state.posts.length, 2);
});

test('429 waits retry_after and says it is queued', async () => {
    GW.state.script = [{ status: 429, error: 'busy', extra: { retry_after: 60 } }];
    const seen = [];
    const r = await gv.generateVideo(base(), opts({ onEvent: e => seen.push(e) }));
    assert.ok(r.ok);
    const q = seen.find(e => e.event === 'queued_locally');
    assert.ok(q, 'the wait was not reported');
    assert.strictEqual(q.retry_after, 60);
});

test('one video at a time: concurrent requests are queued here, not at the gateway', async () => {
    GW.state.maxInFlight = 0;
    const all = await Promise.all([1, 2, 3].map(() => gv.generateVideo(base(), opts())));
    assert.ok(all.every(r => r.ok));
    assert.strictEqual(GW.state.maxInFlight, 1);
});

// -- the shot list ---------------------------------------------------------------------

test('shot list: POST /video/production, per-shot references and transitions, one MP4', async () => {
    const seen = [];
    const r = await gv.generateProduction({
        model: 'ltx-2.5', width: 960, height: 544, fps: 24,
        shots: [
            { label: '1A', prompt: 'Wide: the alley at dusk.', duration_seconds: 4, init_image: png(),
                video_references: [{ role: 'location', uri: png(), label: 'rainy alley' }] },
            { label: '1B', prompt: 'Close: Mia lifts the lantern.', duration_seconds: 3, transition: { type: 'dissolve' },
                video_references: [{ role: 'character', uri: png(), label: 'Mia' }, { role: 'style', uri: png() }] },
        ],
    }, opts({ onEvent: e => seen.push(e.event) }));
    assert.ok(r.ok, r.error);
    const post = GW.state.posts[0];
    assert.strictEqual(post.path, '/video/production');
    assert.strictEqual(post.body.model, 'ltx-2.5');
    assert.strictEqual(post.body.shots.length, 2);
    assert.strictEqual(post.body.shots[0].transition, undefined, 'the first shot has nothing to transition from');
    assert.strictEqual(post.body.shots[1].transition, 'crossfade');
    assert.deepStrictEqual(post.body.shots[0].references.map(x => x.kind), ['keyframe', 'location']);
    assert.strictEqual(r.shots[1].inherits_start, true, 'a shot with no start inherits the previous last frame');
    assert.ok(r.shots[1].references_dropped.some(d => d.kind === 'style'), 'a per-shot drop was not reported');
    for (const e of ['production_started', 'shot_started', 'shot_completed', 'stitching', 'completed']) assert.ok(seen.includes(e), e);
    assert.strictEqual(r.total_shots, 2);
    assert.strictEqual(r.shots_completed, 2);
});

test('shot list: 1–20 shots, refused locally outside it', async () => {
    for (const n of [0, 21]) {
        const r = await gv.generateProduction({ shots: Array.from({ length: n }, () => ({ prompt: 'x', duration_seconds: 1 })) }, opts());
        assert.strictEqual(r.status, 400);
    }
    assert.strictEqual(GW.state.posts.length, 0);
    for (const t of ['cut', 'dissolve', 'fade', 'continuous', 'whip_pan']) assert.ok(gv.TRANSITIONS.includes(gv.transitionFor({ type: t })));
});

test('shot list: a bad shot is named', async () => {
    const r = await gv.generateProduction({ shots: [{ prompt: 'ok', duration_seconds: 2 }, { prompt: '', duration_seconds: 2 }] }, opts());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.shot, 1);
    assert.match(r.error, /^shot 2/);
});

// -- wiring -------------------------------------------------------------------------------

test('the Gridlight adapter generates video through this contract, and previews it', async () => {
    const { gridlightAdapter } = require('../lib/providers/gridlight-adapter');
    assert.strictEqual(gridlightAdapter.referenceContract, gv.REFERENCE_CONTRACT);
    const r = await gridlightAdapter.generate('video', base({ init_image: png(), model: 'animatediff-sdxl' }), { measure: false, retryAfterMs: 0 });
    assert.ok(r.ok, r.error);
    assert.strictEqual(GW.state.posts[0].body.model, 'ltx-2.5');
    assert.deepStrictEqual(r.model_substituted, { asked: 'animatediff-sdxl', ran: 'ltx-2.5' });
    const d = gridlightAdapter.describeVideoRequest(base({ init_image: png(), video_references: [{ role: 'style', uri: png() }] }));
    assert.strictEqual(d.gateway.known, true);
    assert.strictEqual(d.model, 'ltx-2.5');
    assert.ok(d.notes.some(n => /will not be sent/.test(n)));
});

test('the stream road relays progress and hands the MP4 to onComplete as bytes', async () => {
    const { gridlightAdapter } = require('../lib/providers/gridlight-adapter');
    const written = [];
    const res = { writableEnded: false, write: s => written.push(s), on() {}, removeListener() {} };
    let completed = null;
    const out = await gridlightAdapter.generateStream('video', base(), res, { onComplete: d => { completed = d; } });
    assert.ok(out.ok, out.error);
    assert.ok(Buffer.isBuffer(completed));
    assert.ok(written.some(w => /"event":"generating"/.test(w)));
});

test('the capabilities are readable for free, over HTTP and MCP', async () => {
    require('../db/schema').ensureSchema();
    const { handleProviders } = require('../routes/providers');
    const res = { statusCode: 0, body: '', writeHead(s) { this.statusCode = s; }, setHeader() {}, end(b) { this.body = b; } };
    await handleProviders({ method: 'GET' }, res, ['film', 'providers', 'gridlight', 'video-capabilities'], {});
    assert.strictEqual(res.statusCode, 200, res.body);
    const j = JSON.parse(res.body);
    assert.deepStrictEqual(j.available, ['ltx-2.5', 'wan-2.2', 'minimax-h3']);
    assert.ok(j.models[0].inputs.length === 6);
    const tools = require('../lib/mcp-tools');
    assert.ok(tools.hasTool('gridlight_video_capabilities'));
});
