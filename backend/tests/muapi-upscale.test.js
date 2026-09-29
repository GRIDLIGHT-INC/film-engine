/**
 * MuAPI video upscale, and an Upscale action on the production canvas.
 *
 * "Set up the appropriate upscale for MuAPI and a node to be able to upscale
 * on the production canvas."
 *
 * Set-based over UPSCALERS (the four MuAPI video upscalers, fields probed free
 * on 2026-09-29):
 *   - each builds its own endpoint, carries the clip, and picks the factor or
 *     tier that REACHES the delivery size from the clip's measured frame;
 *   - each is priced (and marked inferred: MuAPI lists no unit) and metered
 *     from the source seconds;
 * and through the real route with fetch stubbed:
 *   - the SELECTED clip (not the newest) is measured, uploaded to MuAPI first,
 *     and its hosted URL is what the upscaler receives;
 *   - the result is a new version, keeps its sound, and becomes the selected clip;
 *   - the preview is free; the canvas offers Upscale on a shot and a shot's clip,
 *     and an agent has both tools.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-up-' + crypto.randomUUID().slice(0, 8));
process.env.SEEDANCE_POLL_INTERVAL_MS = '1';
for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
process.env.SEEDANCE_API_KEY = 'test-muapi-key-000000';
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const seedance = require('../lib/providers/seedance');
const { UPSCALERS } = seedance;
const pricing = require('../lib/provider-pricing');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');

test('every MuAPI upscaler builds its own endpoint and reaches the delivery size where it can', () => {
    assert.ok(Object.keys(UPSCALERS).length >= 4, 'the scan found the upscalers');
    for (const [id, spec] of Object.entries(UPSCALERS)) {
        const r = seedance.buildPostRequest({ type: 'upscale', model: id, source_video: 'https://x.test/a.mp4',
            source_width: 1280, source_height: 720, target_resolution: '3840x2160', source_seconds: 5 });
        assert.match(r.url, new RegExp(`/${id}$`), `${id}: its own endpoint`);
        assert.equal(r.body.video_url, 'https://x.test/a.mp4', `${id}: carries the clip`);
        assert.ok(r.reaches >= 3840, `${id}: 720p reaches 4K (got ${r.reaches})`);
        if (spec.control === 'factor') assert.ok(spec.factors.includes(r.body.upscale_factor), `${id}: a factor it offers`);
        else assert.equal(r.body.resolution, '4k', `${id}: the 4K tier`);
        assert.equal(r.estimated_usd, Number((spec.usdPerSecond * 5).toFixed(2)), `${id}: priced from the source seconds`);
        // A 1080p delivery from a 720p clip asks for the SMALLEST step that reaches it.
        const small = seedance.buildPostRequest({ type: 'upscale', model: id, source_video: 'https://x.test/a.mp4',
            source_width: 1280, source_height: 720, target_resolution: '1920x1080' });
        assert.ok(small.reaches >= 1920 && small.reaches <= r.reaches, `${id}: not larger than the delivery needs`);
        // No clip is refused, never sent.
        assert.throws(() => seedance.buildPostRequest({ type: 'upscale', model: id }), /clip/);
    }
});

test('every upscaler is priced, marked inferred, and metered from the source', () => {
    for (const id of Object.keys(UPSCALERS)) {
        const rate = pricing.rateFor('seedance', 'post', id);
        assert.ok(rate && rate.usd_per_native === UPSCALERS[id].usdPerSecond, `${id} is in the rate book at its price`);
        assert.equal(rate.inferred, true, `${id}: MuAPI lists no unit, so it is marked inferred`);
        const m = seedance.adapter.meter('post', { type: 'upscale', model: id, source_video: 'https://x.test/a.mp4', source_seconds: 7 }, { ok: true });
        assert.deepEqual([m.unit, m.quantity, m.model], ['second', 7, id]);
    }
    assert.ok(seedance.adapter.modelsByCapability.post['topaz-video-upscale'], 'offered as a post model');
    // The Seedance video-edit finish is still the default when no upscaler is named.
    assert.match(seedance.buildPostRequest({ type: 'upscale', source_video: 'https://x.test/a.mp4' }).url, /video-edit-4k$/);
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
db.prepare(`INSERT INTO film_projects (id, title, target_resolution) VALUES (?, 'Up', '3840x2160')`).run(pid);
db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)`).run(sc, pid);
db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms) VALUES (?, ?, '1A', 1000)`).run(shotId, sc);
const selectedFile = clip('1A_a.mp4', '640x360');
const newerFile = clip('1A_b.mp4', '320x180');
const selId = generateId();
db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, created_at) VALUES (?, ?, ?, 'video_raw', ?, '1A_a.mp4', '2026-01-01')`).run(selId, pid, shotId, selectedFile);
db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, created_at) VALUES (?, ?, ?, 'video_raw', ?, '1A_b.mp4', '2026-02-01')`).run(generateId(), pid, shotId, newerFile);
db.prepare('UPDATE film_shots SET selected_video_asset_id = ? WHERE id = ?').run(selId, shotId);

const { handlePostProduction } = require('../routes/post-production');
function call(method, parts, query, body) {
    return new Promise(resolve => {
        const res = { code: 0, writeHead(c) { this.code = c; }, setHeader() {},
            end(b) { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ code: this.code, json: j }); } };
        handlePostProduction({ method, headers: {}, body: body || {} }, res, parts, query || {});
    });
}

test('the preview is free, measures the SELECTED clip and sizes the upscale to the delivery', async () => {
    const real = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('the preview must not reach the network'); };
    try {
        const r = await call('GET', ['film', 'shots', shotId, 'post', 'upscale', 'preview'], { model: 'topaz-video-upscale' });
        assert.equal(r.code, 200, JSON.stringify(r.json));
        assert.equal(r.json.spends, false);
        assert.equal(r.json.source.asset_id, selId, 'the selected clip, not the newest');
        assert.equal(r.json.source.measured, '640x360');
        assert.equal(r.json.sends.body.upscale_factor, 4, '640 needs 4x to pass 3840... and 4x is the most, so it is named');
        assert.ok(r.json.warnings.some(w => /short of 3840/.test(w)), 'a shortfall is said');
        assert.ok(r.json.upscalers.length === Object.keys(UPSCALERS).length);
        assert.equal(calls, 0);
    } finally { global.fetch = real; }
});

test('the upscale uploads the clip to MuAPI first, sends the hosted URL, and keeps the result as the selected version', async () => {
    const real = global.fetch;
    const out = clip('upscaled.mp4', '2560x1440');
    const sent = [];
    global.fetch = async (url, init) => {
        const u = String(url);
        sent.push({ url: u, method: (init && init.method) || 'GET', body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null });
        const ok = (j) => ({ ok: true, status: 200, json: async () => j, arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() });
        if (u.endsWith('/upload_file')) return ok({ url: 'https://cdn.muapi.ai/up/1A_a.mp4' });
        if (u.endsWith('/topaz-video-upscale')) return ok({ request_id: 'req-1' });
        if (u.includes('/predictions/req-1/result')) return ok({ status: 'completed', outputs: ['https://cdn.muapi.ai/out/up.mp4'] });
        if (u === 'https://cdn.muapi.ai/out/up.mp4') {
            const b = fs.readFileSync(out);
            return { ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), json: async () => null };
        }
        throw new Error('unexpected fetch ' + u);
    };
    try {
        const r = await call('POST', ['film', 'shots', shotId, 'post', 'upscale'], {}, { model: 'topaz-video-upscale' });
        assert.equal(r.code, 200, JSON.stringify(r.json));
        const upload = sent.findIndex(s => s.url.endsWith('/upload_file'));
        const job = sent.findIndex(s => s.url.endsWith('/topaz-video-upscale'));
        assert.ok(upload >= 0 && job > upload, 'the clip goes up BEFORE the upscale is asked for');
        assert.equal(sent[job].body.video_url, 'https://cdn.muapi.ai/up/1A_a.mp4', 'the upscaler gets the hosted clip, never a local path');
        assert.equal(sent[job].body.upscale_factor, 4);

        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(r.json.asset_id);
        assert.equal(asset.asset_type, 'video_final');
        assert.equal(JSON.parse(asset.metadata).from_asset_id, selId);
        assert.equal(db.prepare('SELECT selected_video_asset_id AS s FROM film_shots WHERE id = ?').get(shotId).s, asset.id, 'it becomes the selected clip');
        assert.ok(fs.existsSync(selectedFile), 'the original is kept');
        const m = inspectMedia(asset.file_path);
        assert.equal(m.width, 2560);
        assert.ok(m.hasAudio !== false, 'the clip keeps its sound');
    } finally { global.fetch = real; }
});

test('a person on the canvas and an agent can both upscale', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
    const fn = name => { const at = src.indexOf(`function ${name}(`); return src.slice(at, src.indexOf('\n}\n', at)); };
    assert.match(fn('pgOpenMenu'), /pgUpscaleWhyNot\(n\)/, 'the node menu offers Upscale');
    assert.match(fn('pgMenuDo'), /what === 'upscale'/);
    // eslint-disable-next-line no-new-func
    const why = new Function('pgNode', fn('pgUpscaleWhyNot') + '\n}; return pgUpscaleWhyNot;')(k => ({ 'shot:1': { type: 'shot' }, 'seq:1': { type: 'sequence' } }[k]));
    assert.equal(why({ type: 'shot', videos: [{}] }), '', 'a shot with a clip');
    assert.ok(why({ type: 'shot', videos: [] }), 'a shot with no clip is disabled with why');
    assert.equal(why({ type: 'video', parent: 'shot:1' }), '', "a shot's clip version");
    assert.ok(why({ type: 'video', parent: 'seq:1' }), 'a sequence clip says where to do it');
    assert.equal(why({ type: 'sound' }), undefined, 'not offered on a sound');
    assert.match(src, /previewUrl: `\/shots\/\$\{shotId\}\/post\/upscale\/preview/, 'through the one confirmation, with its free preview');
    const names = new Set(require('../lib/mcp-tools').listTools().map(t => t.name));
    assert.ok(names.has('shot_upscale_preview') && names.has('shot_upscale'));
});
