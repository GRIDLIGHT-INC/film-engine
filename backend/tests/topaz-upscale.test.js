/**
 * Topaz Labs video finishing: Starlight Precise 2.6, Starlight Fast 3, Astra 2
 * and Proteus, on Topaz's own API.
 *
 * Set-based over MODELS, held to the contract recorded free on 2026-09-30
 * (tests/fixtures/topaz-contract.json: GET /video/status and the Video API
 * OpenAPI):
 *   - every model is one Topaz says it accepts today;
 *   - every model builds a create body with every field Topaz requires, the
 *     clip's own sound copied through, and only the filter fields documented
 *     for that model (out-of-range values clamped);
 *   - the output frame reaches the delivery size in the clip's own shape, never
 *     past what the model makes, and the credits come from Topaz's own table;
 *   - every model is priced and metered;
 * and through the real route with fetch stubbed:
 *   - the preview is free and prices every Topaz model for THIS clip;
 *   - the upscale runs create → accept → PUT → complete-upload → status →
 *     download, and the result is a new version that becomes the selected clip;
 *   - a cancel is a real DELETE.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-tz-' + crypto.randomUUID().slice(0, 8));
for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
process.env.TOPAZ_API_KEY = 'test-topaz-key-000000';
process.env.TOPAZ_POLL_INTERVAL_MS = '1';
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const topaz = require('../lib/providers/topaz');
const providers = require('../lib/providers');
const pricing = require('../lib/provider-pricing');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
const CONTRACT = require('./fixtures/topaz-contract.json');

const IDS = Object.keys(topaz.MODELS);
const measured = { source_video: '/x/clip.mp4', source_bytes: 1000000, source_width: 1280, source_height: 720,
    source_seconds: 10, source_fps: 30, target_resolution: '3840x2160' };

test('the adapter is registered for post, and every model is one Topaz accepts today', () => {
    assert.ok(IDS.length >= 4, 'the scan found the models');
    const a = providers.get('topaz');
    assert.ok(a && a.capabilities.includes('post'));
    assert.deepEqual(providers.modelIdsFor(a, 'post').sort(), IDS.slice().sort(), 'every model is offered as a post model');
    const missing = IDS.filter(id => !CONTRACT.supportedModels.includes(id));
    assert.deepEqual(missing, [], 'Topaz does not list these');
    assert.deepEqual(Object.keys(CONTRACT.model_params).sort(), IDS.slice().sort(), 'the fixture names every model\'s documented params');
});

test('every model builds a create body with every required field, the sound copied, and only its own filter fields', () => {
    for (const id of IDS) {
        const r = topaz.buildVideoRequest({ ...measured, model: id, sharpness: 9, creativity: 3, realism: -1, sharp: 0.2, prompt: 'crisp neon' });
        assert.match(r.url, /\/video\/$/);
        for (const k of CONTRACT.create.required) assert.ok(k in r.body, `${id}: missing ${k}`);
        for (const k of CONTRACT.create.source_required) assert.ok(r.body.source[k] !== undefined, `${id}: source.${k} missing`);
        for (const k of CONTRACT.create.output_required) assert.ok(r.body.output[k] !== undefined, `${id}: output.${k} missing`);
        assert.ok(CONTRACT.create.source_containers.includes(r.body.source.container), `${id}: a container Topaz reads`);
        assert.equal(r.body.output.audioTransfer, 'Copy', `${id}: the clip keeps its sound`);
        assert.ok(CONTRACT.create.videoEncoder.includes(r.body.output.videoEncoder));
        assert.equal(r.body.source.frameCount, 300, `${id}: the frame count is the measured length times its rate`);
        const f = r.body.filters[0];
        assert.equal(f.model, id);
        const extra = Object.keys(f).filter(k => k !== 'model' && !CONTRACT.model_params[id].includes(k));
        assert.deepEqual(extra, [], `${id}: sends fields Topaz does not document for it`);
        if (id === 'slp-2.6') assert.equal(f.sharpness, 5, 'sharpness is clamped to its 1..5 range');
        if (id === 'ast-2') { assert.equal(f.creativity, 1); assert.equal(f.realism, 0); assert.equal(f.prompt, 'crisp neon'); }
    }
});

test('the output reaches the delivery in the clip\'s own shape, and credits follow Topaz\'s table', () => {
    for (const id of IDS) {
        const f = topaz.outputFrame({ width: 1280, height: 720 }, '3840x2160', id);
        assert.deepEqual([f.width, f.height], [3840, 2160], `${id}: 720p to 4K UHD`);
        assert.ok(f.width % 4 === 0 && f.height % 4 === 0, 'multiples of 4, as Topaz rounds');
        const hd = topaz.outputFrame({ width: 1280, height: 720 }, '1920x1080', id);
        assert.deepEqual([hd.width, hd.height], [1920, 1080], `${id}: no larger than the delivery`);
    }
    // A scope clip is fitted by its short edge and capped at the model's long edge, and says so.
    const scope = topaz.outputFrame({ width: 1920, height: 804 }, '3840x2160', 'slp-2.6');
    assert.ok(scope.width <= 3840 && scope.capped && /at most 3840/.test(scope.note));
    // Never shrinks a clip that is already larger than the delivery.
    const big = topaz.outputFrame({ width: 3840, height: 2160 }, '1920x1080', 'prob-4');
    assert.deepEqual([big.width, big.height], [3840, 2160]);
    // 10s at 1080p30 on Starlight Precise: 300 frames / 26.04 per credit = 12 credits.
    assert.equal(topaz.creditsFor('slp-2.6', 300, { width: 1920, height: 1080 }), 12);
    // The same clip at 4K uses the 4K rate: 300 / 11.92 = 26.
    assert.equal(topaz.creditsFor('slp-2.6', 300, { width: 3840, height: 2160 }), 26);
    assert.equal(topaz.creditsFor('ast-2', 300, { width: 1920, height: 1080 }), 30);
    // An unmeasured clip is not priced by guesswork.
    const blind = topaz.buildVideoRequest({ model: 'slp-2.6', target_resolution: '3840x2160' });
    assert.equal(blind.estimated_usd, null);
    assert.ok(blind.estimate_unknown_why);
});

test('every model is priced in the rate book and metered, and a real amount comes out', () => {
    for (const id of IDS) {
        const rate = pricing.rateFor('topaz', 'post', id);
        assert.ok(rate && rate.native_unit === 'credit' && rate.usd_per_native > 0, `${id} has a credit rate`);
        const u = topaz.adapter.meter('post', { ...measured, model: id }, { ok: true, provider_model: id });
        assert.equal(u.unit, 'second');
        const priced = pricing.priceUsage({ provider: 'topaz', capability: 'post', model: id, unit: u.unit, quantity: u.quantity });
        assert.ok(priced.priced && priced.amount_usd > 0, `${id}: prices to something`);
        const credits = topaz.creditsFor(id, 300, topaz.outputFrame({ width: 1280, height: 720 }, '3840x2160', id));
        assert.ok(Math.abs(priced.native_quantity - credits) < 0.01, `${id}: the ledger records the credits Topaz charges (${priced.native_quantity} vs ${credits})`);
    }
});

/* ── through the route ─────────────────────────────────────────────────── */

const ff = resolveFfmpeg();
const MEDIA = path.join(process.env.FILM_DATA_DIR, 'm');
fs.mkdirSync(MEDIA, { recursive: true });
function clip(name, size) {
    const f = path.join(MEDIA, name);
    execFileSync(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=${size}:d=1[out0];sine=f=440:d=1[out1]`,
        '-pix_fmt', 'yuv420p', '-shortest', f], { stdio: ['ignore', 'ignore', 'ignore'] });
    return f;
}
const pid = generateId(), sc = generateId(), shotId = generateId();
db.prepare(`INSERT INTO film_projects (id, title, target_resolution) VALUES (?, 'Tz', '3840x2160')`).run(pid);
db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)`).run(sc, pid);
db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms) VALUES (?, ?, '1A', 1000)`).run(shotId, sc);
const srcFile = clip('1A.mp4', '640x360');
const srcId = generateId();
db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name) VALUES (?, ?, ?, 'video_raw', ?, '1A.mp4')`).run(srcId, pid, shotId, srcFile);
db.prepare('UPDATE film_shots SET selected_video_asset_id = ? WHERE id = ?').run(srcId, shotId);

const { handlePostProduction } = require('../routes/post-production');
function call(method, parts, query, body) {
    return new Promise(resolve => {
        const res = { code: 0, writeHead(c) { this.code = c; }, setHeader() {},
            end(b) { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ code: this.code, json: j }); } };
        handlePostProduction({ method, headers: {}, body: body || {} }, res, parts, query || {});
    });
}

test('the preview is free and prices every Topaz model for this clip', async () => {
    const real = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('the preview must not reach the network'); };
    try {
        const r = await call('GET', ['film', 'shots', shotId, 'post', 'upscale', 'preview'], { model: 'slp-2.6' });
        assert.equal(r.code, 200, JSON.stringify(r.json));
        assert.equal(r.json.provider, 'topaz');
        assert.equal(r.json.model, 'slp-2.6');
        assert.equal(r.json.sends.body.filters[0].model, 'slp-2.6');
        assert.deepEqual(r.json.sends.body.output.resolution, { width: 3840, height: 2160 });
        assert.ok(r.json.estimated_usd > 0);
        const rows = r.json.upscalers.filter(u => u.provider === 'topaz');
        assert.deepEqual(rows.map(u => u.id).sort(), IDS.slice().sort(), 'every Topaz model is on the menu');
        for (const u of rows) assert.ok(u.estimated_usd > 0 && u.configured === true, `${u.id}: priced for this clip, and ready`);
        assert.equal(calls, 0);
    } finally { global.fetch = real; }
});

test('the upscale runs Topaz\'s whole flow and keeps the result as the selected version', async () => {
    const real = global.fetch;
    const out = clip('1A_up.mp4', '2560x1440');
    const sent = [];
    const ok = (j, extra) => ({ ok: true, status: 200, json: async () => j, headers: new Map(Object.entries(extra || {})), arrayBuffer: async () => new ArrayBuffer(0) });
    global.fetch = async (url, init) => {
        const u = String(url); const method = (init && init.method) || 'GET';
        sent.push({ method, url: u, key: init && init.headers && init.headers['X-API-Key'],
            body: init && typeof init.body === 'string' ? JSON.parse(init.body) : (init && init.body ? '(bytes)' : null) });
        if (method === 'POST' && u.endsWith('/video/')) return ok({ requestId: 'rq-1', estimates: { cost: [3, 4], time: [60, 90] } });
        if (method === 'PATCH' && u.endsWith('/rq-1/accept')) return ok({ uploadId: 'up-1', urls: ['https://s3.test/part1'] });
        if (method === 'PUT' && u === 'https://s3.test/part1') return ok({}, { etag: '"etag-1"' });
        if (method === 'PATCH' && u.endsWith('/rq-1/complete-upload/')) return ok({ message: 'queued' });
        if (u.endsWith('/rq-1/status')) return ok({ status: 'complete', progress: 100, download: { url: 'https://dl.test/out.mp4' } });
        if (u === 'https://dl.test/out.mp4') {
            const b = fs.readFileSync(out);
            return { ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), json: async () => null };
        }
        throw new Error('unexpected fetch ' + method + ' ' + u);
    };
    try {
        const r = await call('POST', ['film', 'shots', shotId, 'post', 'upscale'], {}, { model: 'slp-2.6' });
        assert.equal(r.code, 200, JSON.stringify(r.json));
        const order = sent.map(s => `${s.method} ${s.url.replace(/^https?:\/\/[^/]+/, '')}`);
        assert.deepEqual(order.slice(0, 5), ['POST /video/', 'PATCH /video/rq-1/accept', 'PUT /part1', 'PATCH /video/rq-1/complete-upload/', 'GET /video/rq-1/status'],
            'create, accept, upload, complete, then status — in that order');
        assert.ok(sent.filter(s => /topazlabs/.test(s.url)).every(s => s.key === 'test-topaz-key-000000'), 'every Topaz call carries the key');
        assert.equal(sent[1 + 2].body.uploadResults[0].eTag, 'etag-1', 'the part\'s ETag is sent back');
        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(r.json.asset_id);
        assert.equal(asset.provider, 'topaz');
        assert.equal(asset.provider_model, 'slp-2.6');
        assert.equal(JSON.parse(asset.metadata).from_asset_id, srcId);
        assert.equal(db.prepare('SELECT selected_video_asset_id AS s FROM film_shots WHERE id = ?').get(shotId).s, asset.id, 'it becomes the selected clip');
        assert.ok(fs.existsSync(srcFile), 'the original is kept');
        assert.equal(inspectMedia(asset.file_path).width, 2560);
    } finally { global.fetch = real; }
});

test('a Topaz cancel is a real DELETE; a failed job says why', async () => {
    const real = global.fetch;
    const seen = [];
    global.fetch = async (url, init) => { seen.push(`${init && init.method} ${url}`); return { ok: true, status: 200, json: async () => ({}) }; };
    try {
        const r = await topaz.adapter.cancelJob('rq-9');
        assert.equal(r.ok, true);
        assert.match(seen[0], /^DELETE .*\/video\/rq-9$/);
        global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', errorCode: 'E42', message: 'bad source' }) });
        const c = await topaz.collect('rq-9', { timeout: 2000 });
        assert.equal(c.ok, false);
        assert.match(c.error, /failed \(E42\) — bad source/);
    } finally { global.fetch = real; }
});

test('a person and an agent can both pick a Topaz model', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
    assert.match(src, /group\('topaz', 'Topaz Labs'\)/, 'the Upscale dialog lists the Topaz group');
    const tools = require('../lib/mcp-tools').listTools();
    const preview = tools.find(t => t.name === 'shot_upscale_preview');
    for (const id of IDS) assert.ok(preview.description.includes(id), `the agent is told about ${id}`);
    const up = tools.find(t => t.name === 'shot_upscale');
    for (const k of ['sharpness', 'creativity', 'realism', 'sharp', 'prompt']) assert.ok(up.inputSchema.properties[k], `shot_upscale takes ${k}`);
});
