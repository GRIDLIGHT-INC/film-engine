/**
 * Magnific video upscaling: creative, turbo, precision, and Topaz Starlight
 * through Magnific.
 *
 * Set-based over MODELS, held to the documented contract recorded on
 * 2026-09-30 (tests/fixtures/magnific-contract.json):
 *   - every model posts to its own endpoint and sends only fields Magnific
 *     documents for it (ranges clamped, unknown enum values dropped);
 *   - the tier is the smallest that reaches the delivery, 4K when nothing
 *     smaller does, and a shortfall is said;
 *   - every model and tier is priced (marked inferred) and metered;
 * and through the real route with fetch stubbed:
 *   - the clip goes up through Magnific's own upload, and the upscaler is
 *     handed the uploaded URL, never a local path;
 *   - the result is a new version that becomes the selected clip.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-mg-' + crypto.randomUUID().slice(0, 8));
for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
process.env.MAGNIFIC_API_KEY = 'test-magnific-key-0000';
process.env.MAGNIFIC_POLL_INTERVAL_MS = '1';
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const mg = require('../lib/providers/magnific');
const providers = require('../lib/providers');
const pricing = require('../lib/provider-pricing');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
const CONTRACT = require('./fixtures/magnific-contract.json');

const IDS = Object.keys(mg.MODELS);

test('the adapter is registered for post, and every model is a documented endpoint', () => {
    assert.ok(IDS.length >= 4);
    const a = providers.get('magnific');
    assert.ok(a && a.capabilities.includes('post'));
    assert.deepEqual(providers.modelIdsFor(a, 'post').sort(), IDS.slice().sort());
    assert.deepEqual(Object.keys(CONTRACT.endpoints).sort(), IDS.slice().sort(), 'the fixture names every model');
    assert.deepEqual(mg.TIERS.map(t => t.id), CONTRACT.resolutions);
});

test('every model posts to its own endpoint with only the fields Magnific documents for it', () => {
    const everything = { video_url: 'https://asset.test/c.mp4', target_resolution: '3840x2160', source_seconds: 10, source_fps: 24,
        creativity: 150, sharpen: 40, smart_grain: 10, fps_boost: 'true', flavor: 'natural', strength: -5,
        enhancement_model: 'starlight_fast_2', noise: 0.3, target_fps: 90, prompt: 'not a Magnific field' };
    for (const id of IDS) {
        const r = mg.buildVideoRequest({ ...everything, model: id });
        assert.ok(r.url.endsWith(CONTRACT.endpoints[id].path), `${id}: its own endpoint (${r.url})`);
        const extra = Object.keys(r.body).filter(k => !CONTRACT.endpoints[id].params.includes(k));
        assert.deepEqual(extra, [], `${id}: sends undocumented fields`);
        assert.equal(r.body.video, 'https://asset.test/c.mp4');
        assert.equal(r.body.resolution, '4k');
        if ('creativity' in r.body) assert.equal(r.body.creativity, 100, `${id}: creativity clamped to 100`);
        if ('strength' in r.body) assert.equal(r.body.strength, 0, `${id}: strength clamped to 0`);
        if ('target_fps' in r.body) assert.equal(r.body.target_fps, 60, `${id}: target_fps clamped to 60`);
        if ('fps_boost' in r.body) assert.equal(r.body.fps_boost, true);
    }
    const bad = mg.buildVideoRequest({ model: 'magnific-video-upscaler', flavor: 'neon', video_url: 'x', target_resolution: '1920x1080' });
    assert.ok(!('flavor' in bad.body), 'an unknown flavor is dropped, not sent');
    assert.equal(mg.buildVideoRequest({ model: 'magnific-video-upscaler-topaz', video_url: 'x' }).body.enhancement_model, 'starlight_precise_2_5',
        'Starlight Precise is named when nothing else is');
});

test('the tier is the smallest that reaches the delivery, and a shortfall is said', () => {
    assert.equal(mg.tierFor('1280x720').id, '720p');
    assert.equal(mg.tierFor('1920x1080').id, '1k');
    assert.equal(mg.tierFor('2560x1440').id, '2k');
    assert.equal(mg.tierFor('2048x1080').id, '1k', 'a 2K DCI delivery has a 1080 short edge');
    assert.equal(mg.tierFor('3840x2160').id, '4k');
    const over = mg.buildVideoRequest({ model: IDS[0], video_url: 'x', target_resolution: '7680x4320', source_seconds: 5 });
    assert.equal(over.body.resolution, '4k');
    assert.match(over.note, /largest tier is 4K/);
});

test('every model and tier is priced, marked inferred, and metered', () => {
    for (const id of IDS) {
        for (const t of mg.TIERS) {
            const rate = pricing.rateFor('magnific', 'post', `${id}@${t.id}`);
            assert.ok(rate && rate.usd_per_native === mg.USD_PER_FRAME[t.id], `${id}@${t.id} has its per-frame price`);
            assert.equal(rate.inferred, true, 'Magnific publishes no per-frame rate');
        }
        const u = mg.adapter.meter('post', { model: id, source_seconds: 10, source_fps: 24, target_resolution: '3840x2160' }, { ok: true, provider_model: id });
        assert.equal(u.model, `${id}@4k`);
        const priced = pricing.priceUsage({ provider: 'magnific', capability: 'post', model: u.model, unit: u.unit, quantity: u.quantity });
        // 10s at 24fps is 240 frames; at $0.012 a frame at 4K that is $2.88.
        assert.ok(Math.abs(priced.amount_usd - 2.88) < 0.01, `${id}: 240 frames at 4K is $2.88 (got ${priced.amount_usd})`);
        const est = mg.buildVideoRequest({ model: id, video_url: 'x', source_seconds: 10, source_fps: 24, target_resolution: '3840x2160' });
        assert.equal(est.estimated_usd, 2.88, `${id}: the preview quotes what the meter charges`);
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
db.prepare(`INSERT INTO film_projects (id, title, target_resolution) VALUES (?, 'Mg', '3840x2160')`).run(pid);
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

test('the preview is free and lists every Magnific upscaler priced for this clip', async () => {
    const real = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('the preview must not reach the network'); };
    try {
        const r = await call('GET', ['film', 'shots', shotId, 'post', 'upscale', 'preview'], { model: 'magnific-video-upscaler-precision' });
        assert.equal(r.code, 200, JSON.stringify(r.json));
        assert.equal(r.json.provider, 'magnific');
        assert.equal(r.json.sends.body.resolution, '4k');
        const rows = r.json.upscalers.filter(u => u.provider === 'magnific');
        assert.deepEqual(rows.map(u => u.id).sort(), IDS.slice().sort());
        for (const u of rows) assert.ok(u.estimated_usd > 0 && u.configured === true && u.inferred_price === true, `${u.id}: priced and ready`);
        assert.equal(calls, 0);
    } finally { global.fetch = real; }
});

test('the clip goes up through Magnific\'s own upload, and the upscaler gets that URL', async () => {
    const real = global.fetch;
    const out = clip('1A_up.mp4', '2560x1440');
    const sent = [];
    const ok = j => ({ ok: true, status: 200, json: async () => j, headers: new Map() });
    global.fetch = async (url, init) => {
        const u = String(url); const method = (init && init.method) || 'GET';
        const h = (init && init.headers) || {};
        sent.push({ method, url: u, key: h['x-magnific-api-key'], headers: h, body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null });
        if (u.endsWith('/v1/ai/uploads/request-url')) return ok({ files: [{ file_id: 'upl_vid_1', upload_url: 'https://gcs.test/put1',
            headers: { 'Content-Type': 'video/mp4', 'x-goog-content-length-range': '0,1073741824' }, asset_url: 'https://cdn.test/asset1.mp4' }] });
        if (method === 'PUT' && u === 'https://gcs.test/put1') return ok({});
        if (method === 'POST' && u.endsWith('/v1/ai/video-upscaler-precision')) return ok({ data: { task_id: 'tk-1', status: 'CREATED' } });
        if (u.endsWith('/v1/ai/video-upscaler-precision/tk-1')) return ok({ data: { task_id: 'tk-1', status: 'COMPLETED', generated: ['https://cdn.test/out.mp4'] } });
        if (u === 'https://cdn.test/out.mp4') {
            const b = fs.readFileSync(out);
            return { ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), json: async () => null };
        }
        throw new Error('unexpected fetch ' + method + ' ' + u);
    };
    try {
        const r = await call('POST', ['film', 'shots', shotId, 'post', 'upscale'], {}, { model: 'magnific-video-upscaler-precision', strength: 80 });
        assert.equal(r.code, 200, JSON.stringify(r.json));
        const put = sent.find(s => s.method === 'PUT');
        assert.ok(put && !put.key, 'the signed PUT carries no API key');
        assert.equal(put.headers['x-goog-content-length-range'], '0,1073741824', 'the signed headers are echoed');
        const job = sent.find(s => s.method === 'POST' && s.url.endsWith('/video-upscaler-precision'));
        assert.equal(job.body.video, 'https://cdn.test/asset1.mp4', 'the uploaded URL, never a local path');
        assert.equal(job.body.strength, 80);
        assert.equal(job.key, 'test-magnific-key-0000');
        assert.ok(sent.indexOf(put) < sent.indexOf(job), 'uploaded before the upscale is asked for');
        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(r.json.asset_id);
        assert.equal(asset.provider, 'magnific');
        assert.equal(db.prepare('SELECT selected_video_asset_id AS s FROM film_shots WHERE id = ?').get(shotId).s, asset.id);
        assert.ok(fs.existsSync(srcFile), 'the original is kept');
        assert.equal(inspectMedia(asset.file_path).width, 2560);
    } finally { global.fetch = real; }
});

test('a failed task says so, and a person and an agent can both pick a Magnific upscaler', async () => {
    const real = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { status: 'FAILED', error: { message: 'too long' } } }) });
    try {
        const c = await mg.collect('/v1/ai/video-upscaler|tk-2', { timeout: 2000 });
        assert.equal(c.ok, false);
        assert.match(c.error, /failed — too long/);
    } finally { global.fetch = real; }
    const src = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
    assert.match(src, /group\('magnific', 'Magnific'\)/);
    const tools = require('../lib/mcp-tools').listTools();
    const preview = tools.find(t => t.name === 'shot_upscale_preview');
    for (const id of IDS) assert.ok(preview.description.includes(id), `the agent is told about ${id}`);
    const up = tools.find(t => t.name === 'shot_upscale');
    for (const k of ['sharpen', 'smart_grain', 'fps_boost', 'flavor', 'strength', 'enhancement_model']) assert.ok(up.inputSchema.properties[k], `shot_upscale takes ${k}`);
});
