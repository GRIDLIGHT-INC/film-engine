/**
 * The project's delivery settings drive quality, and the engine checks it.
 *
 * "We need to force this to generators and if they can't provide it, downgrade
 * to best quality — this is on us to check and put the safeguards to get the
 * appropriate resolution."
 *
 * Four guarantees, each over a set read from the code:
 *
 *   1. Every VIDEO adapter in the registry answers `deliverableFrame`: asked
 *      for a size, it says the frame it will really deliver, which is the
 *      largest it offers at or below the ask, or its best when the ask is
 *      above everything it offers. A downgrade is flagged and says why.
 *      Iterated over every video adapter and every model it lists.
 *   2. Drafting is opt-in. A project that never chose it is asked at its
 *      delivery size, and the video payload carries the delivery decision.
 *   3. Every delivery preset's codec and audio channels are saved on the
 *      project and reach the film master's encoder.
 *   4. The delivery check measures each shot's SELECTED clip against the
 *      project's size, and the export preflight warns on a shortfall.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-dq-' + crypto.randomUUID().slice(0, 8));
for (const k of Object.keys(process.env)) if (/_API_KEY$|_API_SECRET$|^RUNWAYML_/.test(k)) delete process.env[k];
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const providers = require('../lib/providers');
const runway = require('../lib/providers/runway');
const seedance = require('../lib/providers/seedance');

const long = f => Math.max(f.width, f.height);
const ASKS = [[1024, 576], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [7680, 4320]];

/** Every model each video adapter lists, read from the adapter's own tables. */
function modelsOf(adapter) {
    if (adapter.id === 'runway') {
        return Object.entries(runway.RUNWAY_VIDEO_MODELS).filter(([, m]) => m.endpoint === 'image_to_video').map(([id]) => id);
    }
    if (adapter.id === 'seedance') return [undefined, ...Object.keys(seedance.VIDEO_MODELS)];
    return [undefined];
}

test('every video adapter says what frame it will deliver: the largest it offers at or below the ask, its best above that', () => {
    const video = providers.list().filter(a => (a.capabilities || []).includes('video'));
    assert.deepEqual(video.map(a => a.id).sort(), ['gridlight', 'runway', 'seedance'], 'the video adapter set changed');
    const bad = [];
    for (const adapter of video) {
        assert.equal(typeof adapter.deliverableFrame, 'function', `${adapter.id} does not say what it will deliver`);
        for (const model of modelsOf(adapter)) {
            let prev = 0;
            const best = adapter.deliverableFrame({ model, width: 7680, height: 4320, target_resolution: '7680x4320' });
            for (const [w, h] of ASKS) {
                const d = adapter.deliverableFrame({ model, width: w, height: h, target_resolution: `${w}x${h}` });
                const tag = `${adapter.id}/${model || 'default'} asked ${w}x${h}`;
                if (!(d.width > 0 && d.height > 0)) { bad.push(`${tag}: no frame`); continue; }
                if (long(d) < prev) bad.push(`${tag}: a larger ask got a smaller frame (${long(d)} < ${prev})`);
                prev = long(d);
                if (long(d) > long(best)) bad.push(`${tag}: delivers more than its best`);
                const down = long(d) < w;
                if (!!d.downgraded !== down) bad.push(`${tag}: downgraded=${d.downgraded} but delivers ${d.width}x${d.height}`);
                if (down && !String(d.why || '').trim()) bad.push(`${tag}: a downgrade with no reason`);
            }
        }
    }
    assert.deepEqual(bad, []);
});

test('Runway uses a model\'s 1080p ratio when the project asks for 1080p, and its best when asked for more', () => {
    const at = (model, w, h) => runway.buildVideoRequest({ model, width: w, height: h, prompt: 'x', init_image: 'https://example.com/k.png' }).body.ratio;
    // The 1080-capable models: every one whose ratio list carries 1920:1080.
    const capable = Object.entries(runway.RUNWAY_VIDEO_MODELS).filter(([, m]) => (m.ratios || []).includes('1920:1080')).map(([id]) => id);
    assert.ok(capable.length >= 3, `only ${capable}`);
    for (const m of capable) {
        assert.equal(at(m, 1920, 1080), '1920:1080', `${m} asked 1080p was sent a smaller ratio`);
        assert.equal(at(m, 3840, 2160), '1920:1080', `${m} asked 4K did not get its best`);
        assert.equal(at(m, 1280, 720), '1280:720', `${m} asked 720p was sent more than asked`);
        assert.equal(at(m, 1080, 1920), '1080:1920', `${m} vertical 1080p lost its size`);
    }
    assert.equal(at('gen4.5', 1920, 1080), '1280:720', 'gen4.5 has no 1080p ratio');
});

// ── drafting is opt-in, and the payload says what will be delivered ──────
const P = generateId(), SC = generateId(), SH = generateId();
db.prepare("INSERT INTO film_projects (id, title, target_resolution, aspect_ratio, target_fps, provider_config) VALUES (?, 'DQ', '3840x2160', '16:9', 24, ?)")
    .run(P, JSON.stringify({ video: 'runway' }));
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'DINER')").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', ?)")
    .run(SH, SC, JSON.stringify({ description: 'She waits.', camera: { shot_type: 'medium' } }));

test('a project that never chose drafting is not drafted, and every project in the database is off', () => {
    const on = db.prepare('SELECT COUNT(*) AS n FROM film_projects WHERE draft_video = 1').get().n;
    assert.equal(on, 0, 'the migration left drafting on');
    const { buildCapabilityPayload } = require('../lib/capability-payloads');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(P);
    const ctx = { project, scene: { id: SC, project_id: P }, shot: { id: SH, shot_code: '1A' }, sceneCard: { description: 'She waits.' },
        characters: [], location: null, voiceProfiles: [], initImage: 'https://example.com/k.png' };
    const plain = buildCapabilityPayload('video', ctx).payload;
    assert.ok(!plain.draft, 'a project that never chose drafting was drafted');
    assert.equal(`${plain.width}x${plain.height}`, '3840x2160', 'not asked at the delivery size');
    assert.ok(plain.delivery, 'the payload does not say what will be delivered');
    assert.equal(plain.delivery.asked, '3840x2160');
    assert.equal(plain.delivery.downgraded, true, 'Runway cannot deliver 4K and the payload does not say so');
    assert.match(plain.delivery.why, /\S/);
    const drafted = buildCapabilityPayload('video', { ...ctx, project: { ...project, draft_video: 1 } }).payload;
    assert.ok(drafted.draft && drafted.draft.active, 'a project that chose drafting was not drafted');
});

test('a new project is created with drafting off', async () => {
    const { handleProjects } = require('../routes/projects');
    let done; const fin = new Promise(r => { done = r; });
    const res = { statusCode: 0, body: '', writeHead(c) { this.statusCode = c; }, setHeader() {}, end(b) { this.body = b; done(); } };
    await handleProjects({ method: 'POST', body: { title: 'Fresh' }, headers: {} }, res, ['film', 'projects'], {});
    await fin;
    const id = (JSON.parse(res.body).project || JSON.parse(res.body)).id;
    assert.equal(db.prepare('SELECT draft_video FROM film_projects WHERE id = ?').get(id).draft_video, 0);
});

// ── presets: codec and audio channels reach the master ────────────────────
test('every delivery preset\'s codec and audio channels are saved, and reach the master\'s encoder', async () => {
    const { DELIVERY_PRESETS } = require('../lib/project-presets');
    const dq = require('../lib/delivery-quality');
    const { handleProjectSettingsPreset } = require('../routes/projects');
    assert.ok(DELIVERY_PRESETS.length >= 6);
    for (const preset of DELIVERY_PRESETS) {
        let done; const fin = new Promise(r => { done = r; });
        const res = { statusCode: 0, body: '', writeHead(c) { this.statusCode = c; }, setHeader() {}, end(b) { this.body = b; done(); } };
        await handleProjectSettingsPreset({ method: 'POST', body: { preset: preset.id }, headers: {} }, res, ['film', 'projects', P, 'settings', 'preset']);
        await fin;
        assert.equal(res.statusCode, 200, `${preset.id}: ${res.body}`);
        const row = db.prepare('SELECT delivery_codec, delivery_audio_channels FROM film_projects WHERE id = ?').get(P);
        assert.equal(row.delivery_codec, preset.codec, `${preset.id}: codec not saved`);
        assert.equal(row.delivery_audio_channels, dq.channelCount(preset.audio_channels), `${preset.id}: audio channels not saved`);
        const enc = dq.encoderFor(row.delivery_codec, { available: null });
        assert.ok(dq.CODECS[preset.codec], `${preset.id}: codec ${preset.codec} has no encoder rule`);
        assert.ok(enc.video.includes(dq.CODECS[preset.codec].encoder), `${preset.id}: the master is not encoded as ${preset.codec}`);
    }
    const d = dq.deliveryEncodeArgs('/in.mp4', '/out.mov', 'prores_422_hq', 6, { available: null });
    assert.ok(d.args.includes('prores_ks') && d.args.join(' ').includes('-ac 6'), 'the delivery encode ignores the codec or the channels');
    assert.equal(d.args[0], '-nostdin');
});

// ── the delivery check: measured, per selected clip ──────────────────────
test('the delivery check measures each shot\'s selected clip against the project size, and the preflight warns', () => {
    const { resolveFfmpeg } = require('../lib/ffmpeg');
    const ff = resolveFfmpeg();
    if (!ff.available) return;
    const dir = path.join(process.env.FILM_DATA_DIR, 'clips'); fs.mkdirSync(dir, { recursive: true });
    const make = (name, size) => {
        const f = path.join(dir, name);
        execFileSync(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=${size}:d=1`, '-pix_fmt', 'yuv420p', f], { stdio: ['ignore', 'ignore', 'ignore'] });
        return f;
    };
    const P2 = generateId(), S2 = generateId(), A = generateId(), B = generateId(), C = generateId();
    db.prepare("INSERT INTO film_projects (id, title, target_resolution) VALUES (?, 'Check', '1920x1080')").run(P2);
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)").run(S2, P2);
    const shot = (code, sel) => { const id = generateId(); db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, selected_video_asset_id) VALUES (?, ?, ?, ?)').run(id, S2, code, sel); return id; };
    const reg = (id, shotId, file) => db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name) VALUES (?, ?, ?, 'video_raw', ?, ?)").run(id, P2, shotId, file, path.basename(file));
    const s1 = shot('1A', null), s2 = shot('1B', null), s3 = shot('1C', null);
    reg(A, s1, make('small.mp4', '640x360'));
    reg(B, s2, make('full.mp4', '1920x1080'));
    // 1C has two clips; the SELECTED one is small, and that is what is measured.
    const C2 = generateId();
    reg(C, s3, make('c-full.mp4', '1920x1080'));
    reg(C2, s3, make('c-small.mp4', '1280x720'));
    db.prepare('UPDATE film_shots SET selected_video_asset_id = ? WHERE id = ?').run(C2, s3);
    const dq = require('../lib/delivery-quality');
    const out = dq.deliveryCheck(db, P2);
    const by = Object.fromEntries(out.shots.map(s => [s.shot_code, s]));
    assert.equal(out.asked, '1920x1080');
    assert.equal(by['1A'].status, 'below'); assert.equal(by['1A'].measured, '640x360');
    assert.equal(by['1B'].status, 'ok');
    assert.equal(by['1C'].status, 'below', 'the selected clip was not the one measured');
    assert.equal(by['1C'].asset_id, C2);
    assert.match(by['1A'].fix, /upscale/i);
    const { preflightExport } = require('../lib/export-package');
    const shots = db.prepare('SELECT s.*, sc.scene_number FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE sc.project_id = ?').all(P2).map(s => ({ ...s, duration_ms: 1000 }));
    const assets = db.prepare('SELECT * FROM film_assets WHERE project_id = ?').all(P2);
    const pf = preflightExport({ id: P2, title: 'Check', target_resolution: '1920x1080' }, shots, assets, { settings: { target_resolution: '1920x1080', target_fps: 24 }, deliveryCheck: out });
    const w = (pf.warnings || []).find(x => x.code === 'SHOTS_BELOW_DELIVERY');
    assert.ok(w, 'the preflight does not warn about clips below the delivery size');
    assert.match(w.message, /1A/); assert.match(w.message, /1C/); assert.doesNotMatch(w.message, /1B/);
    // The delivery master: a real encode in the preset's codec and layout, and nothing to do for H.264 stereo.
    return (async () => {
        const skip = await dq.encodeDeliveryMaster(path.join(dir, 'full.mp4'), { delivery_codec: 'h264', delivery_audio_channels: 2 });
        assert.equal(skip.skipped, true);
        const enc = await dq.encodeDeliveryMaster(path.join(dir, 'full.mp4'), { delivery_codec: 'prores_422_hq', delivery_audio_channels: 6 });
        assert.equal(enc.ok, true, enc.error);
        assert.match(String(enc.measured_codec), /prores/i, 'the delivery master is not ProRes');
        assert.equal(enc.channels, 6);
        assert.ok(fs.existsSync(enc.path) && enc.path.endsWith('_delivery.mov'));
    })();
});

/*
 * The page half. The codec and audio layout are set where they are shown, a
 * preset is applied by the SERVER (so its codec and channels are saved), the
 * video confirmation carries the delivery line, and the Export page measures.
 */
function pageFn(src, name) {
    const at = src.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is on the page');
    let i = src.indexOf(')', at);                  // skip the parameter list
    i = src.indexOf('{', i);
    let depth = 0, j = i;
    for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
    return src.slice(at, j + 1);
}

test('the page sets the codec, audio and drafting, applies presets through the server, and shows the delivery decision', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
    const { CODECS } = require('../lib/delivery-quality');
    const { DELIVERY_PRESETS } = require('../lib/project-presets');

    const codecSel = /<select id="settingsDeliveryCodec">([\s\S]*?)<\/select>/.exec(src);
    assert.ok(codecSel, 'a delivery codec control');
    for (const id of Object.keys(CODECS)) assert.ok(codecSel[1].includes(`value="${id}"`), `codec ${id} is offered`);
    const presetSel = /<select id="settingsDeliveryPreset"[^>]*>([\s\S]*?)<\/select>/.exec(src);
    const presetIds = Array.isArray(DELIVERY_PRESETS) ? DELIVERY_PRESETS.map(p => p.id) : Object.keys(DELIVERY_PRESETS);
    for (const id of presetIds) assert.ok(presetSel[1].includes(`value="${id}"`), `preset ${id} is offered`);

    const save = pageFn(src, 'saveTechnicalSettings');
    for (const f of ['delivery_codec', 'delivery_audio_channels', 'video_draft']) assert.ok(save.includes(f), `${f} is saved`);
    const load = pageFn(src, 'loadTechnicalSettings');
    for (const f of ['delivery_codec', 'delivery_audio_channels', 'draft_video']) assert.ok(load.includes(f), `${f} is shown`);
    assert.match(pageFn(src, 'applyDeliveryPreset'), /settings\/preset/, 'a preset goes through the server route');

    // The delivery line, executed.
    const esc = s => String(s);
    // eslint-disable-next-line no-new-func
    const line = new Function('esc', pageFn(src, 'deliveryLineHtml') + '; return deliveryLineHtml;')(esc);
    assert.equal(line(null), '');
    const down = line({ asked: '3840x2160', delivered: '1280x720', downgraded: true, why: 'its best' });
    assert.match(down, /below delivery/); assert.match(down, /1280x720/);
    assert.match(line({ asked: '1920x1080', delivered: '1920x1080', downgraded: false }), /full size/);
    assert.match(pageFn(src, 'confirmPaidImage'), /deliveryLineHtml\(d\.delivery\)/, 'the confirmation renders it');

    assert.match(pageFn(src, 'loadDeliveryCheck'), /\/delivery-check/);
    assert.match(pageFn(src, 'loadExportPage'), /loadDeliveryCheck\(\)/);
    assert.ok(src.includes('id="exportDeliveryCheck"'));

    const route = fs.readFileSync(path.join(__dirname, '../routes/video-gen.js'), 'utf8');
    assert.match(route, /\n\s+delivery,\n/, 'the free video preview returns the delivery decision');
});
