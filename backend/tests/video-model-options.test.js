/**
 * Every video model's own options, on the dialog that spends, and in the request.
 *
 * "Seedance 2.5 takes a first and last frame and I can change the video length
 * to up to 30 seconds, resolution quality, screen ratio and HDR — those options
 * should appear in the modal."
 *
 * Set-based over every (provider, model) the dialog offers for video, read from
 * generationOptions('video'), so a model added later arrives with its options or
 * fails here:
 *   - each option a model offers REACHES that provider's request: set it, and
 *     the field it names changes in the body the adapter would send;
 *   - what is offered is the provider's own schema (the dated snapshot), and a
 *     value outside it is refused by name, never sent;
 *   - an automatic Runway ratio is one Runway's schema accepts (a Gen-4.5 ratio
 *     it refuses, and pixel ratios sent to Hailuo 3, were both live);
 *   - through the routes: the free preview carries the model's options and the
 *     request as it would go, and the paid call sends what was chosen, or
 *     refuses before sending anything;
 *   - the page draws a control for every option and sends them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-vmo-' + crypto.randomUUID().slice(0, 8));
for (const k of Object.keys(process.env)) if (/_API_KEY$|_API_SECRET$|^RUNWAYML_/.test(k)) delete process.env[k];
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const mo = require('../lib/model-options');
const runway = require('../lib/providers/runway');
const seedance = require('../lib/providers/seedance');
const { generationOptions } = require('../lib/generation-override');
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

const FRAME_A = 'data:image/png;base64,QUFB';
const FRAME_B = 'data:image/png;base64,QkJC';

/** The body field each option lands in, per adapter. */
const BODY_FIELD = {
    runway: { duration: 'duration', ratio: 'ratio', resolution: 'resolution', audio: 'audio', last_frame: 'promptImage',
        output_format: 'outputFormat', negative_prompt: 'negativePrompt', seed: 'seed' },
    seedance: { duration: 'duration', ratio: 'aspect_ratio', last_frame: 'images_list', seed: 'seed', draft: 'draft' },
};
const BUILD = { runway: p => runway.buildVideoRequest(p).body, seedance: p => seedance.buildVideoRequest(p).body };

/** A value for each control that is NOT what an unset request would send. */
function pick(c, base, field) {
    if (c.type === 'choice') {
        const ids = c.choices.map(x => x.id);
        return ids.slice().reverse().find(x => String(x) !== String(base[field])) ?? ids[0];
    }
    if (c.type === 'range') return c.max !== base[field] ? c.max : c.min;
    if (c.type === 'toggle') return base[field] === true ? false : (c.default === true ? false : true);
    if (c.type === 'number') return 12345;
    if (c.type === 'text') return 'no birds in the sky';
    if (c.type === 'frame') return 'LAST';
    return null;
}

const OFFERED = [];
for (const p of generationOptions('video').providers) {
    for (const m of (p.models || [])) if (m.options && m.options.length) OFFERED.push({ provider: p.id, model: m.id, controls: m.options });
}

test('the dialog offers options for the video models, and Seedance 2.5 carries the ones asked for', () => {
    assert.ok(OFFERED.length >= 10, `only ${OFFERED.length} models carry options`);
    const keysOf = (prov, model) => OFFERED.find(o => o.provider === prov && o.model === model).controls.map(c => c.key);
    for (const k of ['duration', 'ratio', 'audio', 'last_frame', 'seed']) {
        assert.ok(keysOf('runway', 'seedance2_5').includes(k), `Runway Seedance 2.5 does not offer ${k}`);
    }
    for (const k of ['duration', 'ratio', 'last_frame', 'seed']) {
        assert.ok(keysOf('seedance', 'seedance-2.5-1080p').includes(k), `MuAPI Seedance 2.5 does not offer ${k}`);
    }
    const len = OFFERED.find(o => o.provider === 'runway' && o.model === 'seedance2_5').controls.find(c => c.key === 'duration');
    assert.equal(len.max, 30, 'Seedance 2.5 runs to 30 seconds on Runway');
    // HDR is an output format of Gen-4.5 on Runway, and nowhere a switch on Seedance.
    const gen45 = OFFERED.find(o => o.provider === 'runway' && o.model === 'gen4.5').controls.find(c => c.key === 'output_format');
    assert.ok(gen45 && gen45.choices.some(c => c.id === 'hdr10'), 'Gen-4.5 HDR output is not offered');
    const notes = mo.optionsFor('seedance', 'seedance-2.5-1080p').notes.join(' ');
    assert.match(notes, /No HDR/, 'MuAPI Seedance does not say it has no HDR');
    assert.match(notes, /no sound switch/, 'MuAPI Seedance does not say it takes no sound switch');
});

test('every option every model offers reaches that provider\'s request', () => {
    const bad = [];
    for (const o of OFFERED) {
        const base = { model: o.model, prompt: 'The dragon turns.', init_image: FRAME_A, width: 1920, height: 1080,
            target_resolution: '1920x1080', duration_s: 5, fps: 24 };
        const before = BUILD[o.provider]({ ...base });
        for (const c of o.controls) {
            const field = BODY_FIELD[o.provider][c.key];
            if (!field) { bad.push(`${o.provider}/${o.model}: ${c.key} names no request field`); continue; }
            const value = pick(c, before, field);
            const { values, refused } = mo.readOptions(o.provider, o.model, { [c.key]: value === 'LAST' ? 'x' : value });
            if (c.type !== 'frame' && refused.length) { bad.push(`${o.provider}/${o.model}: ${c.key}=${value} refused: ${refused}`); continue; }
            const payload = mo.applyVideoOptions({ ...base }, c.type === 'frame' ? {} : values,
                c.type === 'frame' ? { lastFrameUri: FRAME_B } : {});
            const after = BUILD[o.provider](payload);
            if (JSON.stringify(after[field]) === JSON.stringify(before[field])) {
                bad.push(`${o.provider}/${o.model}: ${c.key}=${value} did not change ${field} (${JSON.stringify(before[field])})`);
            }
            if (c.type === 'frame' && !JSON.stringify(after[field]).includes(FRAME_B)) {
                bad.push(`${o.provider}/${o.model}: the ending frame is not in ${field}`);
            }
        }
    }
    assert.deepEqual(bad, []);
});

test('Runway\'s options are Runway\'s own schema, and its automatic frame is one the schema accepts', () => {
    const spec = mo.FIELDS.runway.models;
    const bad = [];
    for (const [model, policy] of Object.entries(runway.RUNWAY_VIDEO_MODELS)) {
        if (policy.endpoint !== 'image_to_video') continue;
        const s = spec[model];
        if (!s) { bad.push(`${model} is registered and absent from Runway's schema`); continue; }
        const ratio = mo.optionsFor('runway', model).controls.find(c => c.key === 'ratio');
        if (s.ratio && ratio) assert.deepEqual(ratio.choices.map(c => c.id), s.ratio.enum, `${model} ratios`);
        for (const [w, h] of [[1280, 720], [1920, 1080], [3840, 2160], [1080, 1920], [1024, 1024]]) {
            const body = runway.buildVideoRequest({ model, prompt: 'x', init_image: FRAME_A, width: w, height: h }).body;
            if (s.ratio && !s.ratio.enum.includes(body.ratio)) bad.push(`${model} at ${w}x${h} sends ratio ${body.ratio}, which Runway refuses`);
            const d = s.duration || {};
            const ok = Array.isArray(d.enum) ? d.enum.includes(body.duration)
                : (body.duration >= d.minimum && body.duration <= d.maximum);
            if (!ok) bad.push(`${model} sends a ${body.duration}s length its schema refuses`);
        }
    }
    assert.deepEqual(bad, []);
});

test('a value the model does not take is refused by name and never sent', () => {
    const r = mo.readOptions('runway', 'seedance2_5', { duration: 45, ratio: '1234:567', output_format: 'hdr10', audio: false });
    assert.deepEqual(r.values, { audio: false });
    assert.equal(r.refused.length, 3);
    assert.match(r.refused.join(' '), /duration: 45 is outside 4–30s/);
    assert.match(r.refused.join(' '), /ratio: 1234:567 is not one of/);
    assert.match(r.refused.join(' '), /output_format: seedance2_5 does not take this/);
    // An adapter never sends a value its schema refuses, even if one arrives.
    const body = runway.buildVideoRequest({ model: 'seedance2_5', prompt: 'x', init_image: FRAME_A, ratio: '1234:567',
        output_format: 'hdr10', resolution: '4k' }).body;
    assert.notEqual(body.ratio, '1234:567');
    assert.equal(body.outputFormat, undefined);
    assert.equal(body.resolution, undefined);
});

test('no options chosen builds exactly the request it always did', () => {
    for (const o of OFFERED) {
        const base = { model: o.model, prompt: 'x', init_image: FRAME_A, width: 1920, height: 1080, duration_s: 5, fps: 24 };
        const a = BUILD[o.provider]({ ...base });
        const b = BUILD[o.provider](mo.applyVideoOptions({ ...base }, {}, {}));
        assert.deepEqual(b, a, `${o.provider}/${o.model}`);
    }
});

/* ── through the routes ─────────────────────────────────────────────────── */

function seedShot() {
    const { getFilePath } = require('../lib/file-storage');
    const projectId = generateId(), sceneId = generateId(), a = generateId(), b = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps, target_resolution, provider_config) VALUES (?, ?, 24, ?, ?)')
        .run(projectId, 'Options', '1920x1080', JSON.stringify({ video: 'runway', video_model: 'seedance2_5' }));
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, ?)').run(sceneId, projectId, 'STREET');
    for (const [id, code] of [[a, '1A'], [b, '1B']]) {
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, scene_card_yaml, sort_order) VALUES (?, ?, ?, 5000, ?, ?)')
            .run(id, sceneId, code, JSON.stringify({ shot_code: code, description: 'The dragon turns.', camera: { shot_type: 'wide' } }), code === '1A' ? 0 : 1);
        const file = `${code}.png`;
        const p = getFilePath(projectId, 'storyboards', file);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.from(code === '1A' ? 'AAA' : 'BBB'));
        db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path) VALUES (?, ?, ?, 'storyboard', ?, ?)")
            .run(generateId(), projectId, id, file, p);
    }
    return { projectId, a, b };
}

function call(method, url, parts, body, query) {
    const { handleVideoGen } = require('../routes/video-gen');
    return new Promise(resolve => {
        const res = { statusCode: 200, writeHead(s) { this.statusCode = s; return this; }, setHeader() {},
            end(p) { let j = null; try { j = JSON.parse(p || '{}'); } catch (_) {} resolve({ code: this.statusCode, json: j }); } };
        handleVideoGen({ method, url, body: body || {}, headers: {} }, res, parts, query || {});
    });
}

test('the free preview carries the model\'s options and the request as it would go', async () => {
    process.env.RUNWAY_API_KEY = 'test-runway-key-0000';
    const { a, b } = seedShot();
    const r = await call('GET', `/film/shots/${a}/video/preview`, ['film', 'shots', a, 'video', 'preview'], {},
        { options: JSON.stringify({ duration: 22, ratio: '1920:1080', audio: false, last_frame: b }) });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    const o = r.json.options;
    assert.equal(o.provider, 'runway');
    assert.ok(o.controls.some(c => c.key === 'last_frame'), 'no ending-frame control');
    assert.deepEqual(o.values, { duration: 22, ratio: '1920:1080', audio: false });
    assert.equal(o.last_frame.shot_code, '1B');
    assert.ok(o.frames.some(f => f.label === '1B'), 'the ending-frame picker does not list 1B');
    assert.equal(r.json.outbound.duration, 22);
    assert.equal(r.json.outbound.ratio, '1920:1080');
    assert.equal(r.json.outbound.audio, false);
    // The preview names the pictures without their bytes: a count and their positions.
    assert.deepEqual(r.json.outbound.promptImage.positions, ['first', 'last'], 'the ending frame is not in the request');
    assert.equal(r.json.estimate && r.json.estimate.lines && r.json.duration_s, 22, 'the preview is not priced at the chosen length');

    const bad = await call('GET', `/film/shots/${a}/video/preview`, ['film', 'shots', a, 'video', 'preview'], {},
        { options: JSON.stringify({ duration: 99 }) });
    assert.ok(bad.json.warnings.some(w => /Option not sent — duration: 99/.test(w)), 'a refused option is not said');
});

test('the paid call sends what was chosen, and refuses before sending anything', async () => {
    process.env.RUNWAY_API_KEY = 'test-runway-key-0000';
    const { a, b } = seedShot();
    const sent = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
        sent.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
        return new Response(JSON.stringify({ error: 'stubbed: nothing is bought in a test' }), { status: 400 });
    };
    try {
        const refused = await call('POST', `/film/shots/${a}/video/generate`, ['film', 'shots', a, 'video', 'generate'],
            { options: { duration: 99 } });
        assert.equal(refused.code, 400);
        assert.match(refused.json.error, /duration: 99/);
        assert.equal(sent.length, 0, 'a refused option still reached the provider');

        await call('POST', `/film/shots/${a}/video/generate`, ['film', 'shots', a, 'video', 'generate'],
            { options: { duration: 12, ratio: '854:480', audio: false, seed: 42, last_frame: b } });
        const post = sent.find(s => /image_to_video/.test(s.url));
        assert.ok(post, `nothing reached image_to_video: ${JSON.stringify(sent.map(s => s.url))}`);
        assert.equal(post.body.model, 'seedance2_5');
        assert.equal(post.body.duration, 12);
        assert.equal(post.body.ratio, '854:480');
        assert.equal(post.body.audio, false);
        assert.equal(post.body.seed, 42);
        assert.equal(post.body.promptImage[1].position, 'last');
    } finally { global.fetch = realFetch; }
});

/* ── the page ──────────────────────────────────────────────────────────── */

function fn(name) {
    let at = SPA.indexOf(`    function ${name}(`);
    if (at < 0) at = SPA.indexOf(`    async function ${name}(`);
    assert.ok(at >= 0, `${name} is missing`);
    return SPA.slice(at, SPA.indexOf('\n    }\n', at) + 6);
}

test('the dialog draws a control for every option a model takes, and sends them', () => {
    const esc = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    // eslint-disable-next-line no-new-func
    const draw = new Function('esc', 'CONFIRM_GEN_VIDEO_OPTIONS', fn('videoOptionsHtml') + '\nreturn videoOptionsHtml;')(esc, {});
    for (const o of OFFERED) {
        const html = draw({ provider: o.provider, model: o.model, controls: o.controls, notes: [], frames: [{ id: 'x', label: '1B' }] });
        for (const c of o.controls) {
            assert.ok(html.includes(`data-vopt="${c.key}"`), `${o.provider}/${o.model}: no control for ${c.key}`);
        }
    }
    const confirm = fn('confirmPaidImage');
    assert.match(confirm, /options: \{ \.\.\.CONFIRM_GEN_VIDEO_OPTIONS \}/, 'the chosen options are not sent');
    assert.match(confirm, /videoOptionsHtml\(d\.options\)/, 'the confirmation does not draw the options');
    assert.match(fn('videoPreviewUrl'), /q\.set\('options', JSON\.stringify\(CONFIRM_GEN_VIDEO_OPTIONS\)\)/,
        'changing an option does not re-price the clip');
    assert.match(fn('pickGenModel'), /repreviewVideo\(\)/, 'a different model does not redraw its options');
});
