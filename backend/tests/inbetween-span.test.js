/**
 * In-betweens between two key shots: 1A at 0 s, 1B at the end of the gap, and
 * the frames a director places and directs between them.
 *
 * Pure rules first (spacing, validation, which directions reach a frame, what a
 * frame and a leg are asked for), then the real route against a temp database
 * with the image and video generators stubbed, so nothing is bought:
 *   - "4 frames every 2 s" over 10 s lands at 2, 4, 6, 8;
 *   - each frame is made FROM the one before it and toward 1B;
 *   - "only this frame" makes one; from a frame on makes it and every later one;
 *   - a new take never deletes the old one, and a picked take is the one used;
 *   - the clip goes from 1A through every frame to 1B, legs joined into one file,
 *     filed on 1A as its selected clip; an approved strip that changed refuses;
 *   - the graph draws the span as a node wired 1A → in-betweens → 1B.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-ib-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const span = require('../lib/inbetween-span');
const { handleInbetweens } = require('../routes/inbetweens');
const { resolveFfmpeg } = require('../lib/ffmpeg');

// ── Pure rules ────────────────────────────────────────────────────────────

test('spacing: 4 over 10 s is 2, 4, 6, 8; one every 2 s is 4 frames', () => {
    assert.deepEqual(span.evenTimes(10000, 4), [2000, 4000, 6000, 8000]);
    assert.equal(span.countForEvery(10000, 2000), 4);
    assert.equal(span.countForEvery(10000, 1000), 9);
    assert.equal(span.countForEvery(10000, 20000), 1, 'at least one frame');
    assert.throws(() => span.countForEvery(10000, 0), /more than zero/);
});

test('frames are refused by name: outside the gap, on top of each other, too many', () => {
    assert.throws(() => span.validateFrames([{ at_ms: 0 }], 10000), /between 0 and 10/);
    assert.throws(() => span.validateFrames([{ at_ms: 10000 }], 10000), /between 0 and 10/);
    assert.throws(() => span.validateFrames([{ at_ms: 4000 }, { at_ms: 4050 }], 10000), /same moment/);
    assert.throws(() => span.validateFrames(span.evenTimes(60000, 29).concat([59990]).map(at_ms => ({ at_ms })), 60000), /at most 29/);
    assert.deepEqual(span.validateFrames([{ at_ms: 6000 }, { at_ms: 2000, direction: ' tears ' }], 10000),
        [{ at_ms: 2000, direction: 'tears' }, { at_ms: 6000, direction: '' }], 'sorted in time, trimmed');
});

test('ranges: on a known lane, forwards, inside the gap, with words', () => {
    assert.throws(() => span.validateRanges([{ lane: 'mood', start_ms: 0, end_ms: 1000, text: 'x' }], 10000), /lane must be one of/);
    assert.throws(() => span.validateRanges([{ lane: 'emotion', start_ms: 4000, end_ms: 2000, text: 'x' }], 10000), /forwards/);
    assert.throws(() => span.validateRanges([{ lane: 'emotion', start_ms: 4000, end_ms: 12000, text: 'x' }], 10000), /inside/);
    assert.throws(() => span.validateRanges([{ lane: 'emotion', start_ms: 4000, end_ms: 6000, text: ' ' }], 10000), /says nothing/);
});

const SPAN = {
    from_code: '1A', to_code: '1B', gap_ms: 10000,
    frames: [{ at_ms: 2000, direction: '' }, { at_ms: 4000, direction: 'eyes well up' }, { at_ms: 6000, direction: '' }, { at_ms: 8000, direction: '' }],
    ranges: [{ lane: 'movement', start_ms: 2000, end_ms: 4000, text: 'head turns fast to the door' },
        { lane: 'emotion', start_ms: 4000, end_ms: 10000, text: 'she starts crying' }],
};

test('a frame is asked for with the directions that cover its second, and its own on top', () => {
    const at2 = span.frameInstruction(SPAN, 0);
    assert.match(at2, /from 1A to 1B: the moment 2\.0 s in/);
    assert.match(at2, /FIRST picture is the moment just before \(1A at 0\.0 s\)/);
    assert.match(at2, /Movement \(2\.0–4\.0 s\): head turns fast/);
    assert.doesNotMatch(at2, /crying/, 'the emotion starts at 4 s, not 2');
    const at4 = span.frameInstruction(SPAN, 1);
    assert.match(at4, /the in-between at 2\.0 s/, 'made from the frame before it');
    assert.match(at4, /Movement \(2\.0–4\.0 s\)/, 'a range end belongs to it');
    assert.match(at4, /Emotion \(4\.0–10\.0 s\): she starts crying/);
    assert.match(at4, /This frame: eyes well up\./);
    assert.match(at4, /about 25% of the way/, '2 s of the 8 s left between 2 s and 10 s');
});

test('a leg is asked for with the directions over its stretch, and the frame it arrives at', () => {
    const leg = span.legPrompt(SPAN, 2000, 4000);
    assert.match(leg, /from 2\.0 s to 4\.0 s/);
    assert.match(leg, /head turns fast/);
    assert.doesNotMatch(leg, /crying/, 'a range that only touches the end does not act on the leg');
    assert.match(leg, /By 4\.0 s: eyes well up/);
    assert.match(span.wholePrompt(SPAN), /picture 2 at 4\.0 s \(eyes well up\)/);
});

test('which frames a regeneration makes: from one on, or only that one', () => {
    assert.deepEqual(span.framesToRun(4, 0, false), [0, 1, 2, 3]);
    assert.deepEqual(span.framesToRun(4, 1, false), [1, 2, 3]);
    assert.deepEqual(span.framesToRun(4, 1, true), [1]);
});

test('the fingerprint moves with a picture, a direction, a moment or a range', () => {
    const base = span.spanFingerprint(SPAN, ['a', 'b', 'c', 'd']);
    assert.notEqual(span.spanFingerprint(SPAN, ['a', 'X', 'c', 'd']), base);
    assert.notEqual(span.spanFingerprint({ ...SPAN, frames: SPAN.frames.map((f, i) => (i === 2 ? { ...f, direction: 'tears' } : f)) }, ['a', 'b', 'c', 'd']), base);
    assert.notEqual(span.spanFingerprint({ ...SPAN, ranges: SPAN.ranges.slice(1) }, ['a', 'b', 'c', 'd']), base);
    assert.equal(span.spanFingerprint(SPAN, ['a', 'b', 'c', 'd']), base);
});

// ── Through the route ─────────────────────────────────────────────────────

function call(method, parts, body, query) {
    return new Promise(resolve => {
        const res = { code: 0, writeHead(c) { this.code = c; }, setHeader() {},
            end(b) { let j = null; try { j = JSON.parse(b || ''); } catch (_) {} resolve({ code: this.code, json: j }); } };
        Promise.resolve(handleInbetweens({ method, headers: {}, body: body || {} }, res, parts, query || {})).catch(e => resolve({ code: 599, json: { error: e.message } }));
    });
}

const ff = resolveFfmpeg();
const MEDIA = path.join(process.env.FILM_DATA_DIR, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const png = (name, colour) => {
    const f = path.join(MEDIA, name);
    execFileSync(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=64x36:d=0.1`, '-frames:v', '1', f], { stdio: ['ignore', 'ignore', 'ignore'] });
    return f;
};
const mp4 = (name, secs) => {
    const f = path.join(MEDIA, name);
    execFileSync(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=64x36:d=${secs}`, '-pix_fmt', 'yuv420p', f], { stdio: ['ignore', 'ignore', 'ignore'] });
    return fs.readFileSync(f);
};

const pid = generateId();
db.prepare(`INSERT INTO film_projects (id, title, target_resolution, target_fps, aspect_ratio) VALUES (?, 'Lodgers', '1920x1080', 24, '16:9')`).run(pid);
const scene = generateId();
db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day) VALUES (?, ?, 1, 'INT', 'OFFICE', 'NIGHT')`).run(scene, pid);
const shotA = generateId(), shotB = generateId(), shotC = generateId();
[[shotA, '1A', 10000, 0], [shotB, '1B', 4000, 1], [shotC, '1C', 4000, 2]].forEach(([id, code, dur, i]) =>
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, sort_order) VALUES (?, ?, ?, ?, ?)`).run(id, scene, code, dur, i));
const board = (shot, file) => db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version)
    VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 1)`).run(generateId(), pid, shot, file, path.basename(file));
board(shotA, png('1A.png', 'blue'));
board(shotB, png('1B.png', 'red'));

// Stub the one image funnel: record what each frame was given, return a picture.
const storyboard = require('../routes/storyboard');
const calls = [];
storyboard.callImageGen = async (prompt, negative, seed, payload) => {
    calls.push({ prompt, refs: payload.reference_images.map(r => path.basename(r.path)) });
    return { buffer: fs.readFileSync(png(`gen${calls.length}.png`, 'green')), provider: 'stub', model: 'stub-1' };
};

let id;

test('create: 1A → 1B, 10 s, one every 2 s, refuses a second span and a foreign shot', async () => {
    const r = await call('POST', ['film', 'projects', pid, 'inbetweens'], { from_shot_id: shotA, to_shot_id: shotB, every_s: 2 });
    assert.equal(r.code, 201, JSON.stringify(r.json));
    id = r.json.id;
    assert.equal(r.json.gap_ms, 10000, 'the gap defaults to 1A\'s length');
    assert.deepEqual(r.json.frames.map(f => f.at_ms), [2000, 4000, 6000, 8000]);
    assert.equal(r.json.from.has_frame, true);
    const again = await call('POST', ['film', 'projects', pid, 'inbetweens'], { from_shot_id: shotA, to_shot_id: shotB });
    assert.equal(again.code, 409);
    const foreign = await call('POST', ['film', 'projects', pid, 'inbetweens'], { from_shot_id: shotA, to_shot_id: generateId() });
    assert.equal(foreign.code, 400);
});

test('directing writes frames and ranges, and bad ones are refused by name', async () => {
    const r = await call('PUT', ['film', 'inbetweens', id], {
        frames: [{ at_ms: 2000 }, { at_ms: 4000, direction: 'eyes well up' }, { at_ms: 6000 }, { at_ms: 8000 }],
        ranges: SPAN.ranges,
    });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    assert.equal(r.json.ranges.length, 2);
    const bad = await call('PUT', ['film', 'inbetweens', id], { ranges: [{ lane: 'emotion', start_ms: 4000, end_ms: 11000, text: 'x' }] });
    assert.equal(bad.code, 400);
    assert.equal(bad.json.field, 'ranges');
});

test('the generate plan is free and names what each frame is made from', async () => {
    const before = calls.length;
    const r = await call('GET', ['film', 'inbetweens', id, 'generate'], null, {});
    assert.equal(r.code, 200);
    assert.equal(r.json.ready, true, JSON.stringify(r.json.blockers));
    assert.equal(r.json.count, 4);
    assert.deepEqual(r.json.frames[1].references, ['in-between at 2.0 s', '1B (board frame)']);
    assert.match(r.json.frames[1].instruction, /eyes well up/);
    assert.equal(calls.length, before, 'the plan bought nothing');
});

test('generate: every frame from the one before it, toward 1B', async () => {
    const r = await call('POST', ['film', 'inbetweens', id, 'generate'], {});
    assert.equal(r.code, 200, JSON.stringify(r.json));
    assert.equal(r.json.generated && r.json.generated.length, 4, JSON.stringify(r.json).slice(0, 400));
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].refs, ['1A.png', '1B.png']);
    for (let i = 1; i < 4; i++) {
        assert.match(calls[i].refs[0], /^1A-1B\.ib0\d\./, `frame ${i + 1} is made from the frame before it`);
        assert.equal(calls[i].refs[1], '1B.png');
    }
    assert.ok(r.json.frames.every(f => f.asset_id && f.url), 'every frame has its picture');
    // Never the board: in-between pictures are not storyboard versions of 1A.
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'`).get(shotA).n, 1);
});

test('only this frame makes one; from a frame on makes it and the later ones; old takes are kept', async () => {
    const n = calls.length;
    const one = await call('POST', ['film', 'inbetweens', id, 'generate'], { from_index: 1, only: true });
    assert.equal(one.code, 200);
    assert.equal(calls.length, n + 1);
    assert.equal(one.json.frames[1].takes.length, 2, 'the old take of 4 s is kept');
    const chain = await call('POST', ['film', 'inbetweens', id, 'generate'], { from_index: 2 });
    assert.equal(chain.json.generated.length, 2, '6 s and 8 s');
    // Picking the older take of 4 s makes it the one used.
    const older = one.json.frames[1].takes[1].asset_id;
    const picked = await call('POST', ['film', 'inbetweens', id, 'frames', '1', 'select'], { asset_id: older });
    assert.equal(picked.json.frames[1].asset_id, older);
});

test('approval: needs every picture, and the clip refuses when the strip changed after it', async () => {
    const ok = await call('POST', ['film', 'inbetweens', id, 'approve'], {});
    assert.equal(ok.code, 200);
    assert.equal(ok.json.approval.approved, true);
    const changed = await call('PUT', ['film', 'inbetweens', id], { ranges: SPAN.ranges.slice(0, 1) });
    assert.equal(changed.json.approval.stale, true);
    const plan = await call('GET', ['film', 'inbetweens', id, 'video'], null, {});
    assert.ok(plan.json.blockers.some(b => /changed after it was approved/.test(b)));
    await call('POST', ['film', 'inbetweens', id, 'approve'], {});
});

test('the clip: legs from 1A through each frame to 1B, joined, filed on 1A as its selected clip', async () => {
    const providers = require('../lib/providers');
    const realResolve = providers.resolve;
    const sent = [];
    providers.resolve = (cap) => (cap === 'video' ? { id: 'stub', maxKeyframes: 2,
        generate: async (c, p) => { sent.push(p); return { ok: true, data: mp4(`leg${sent.length}.mp4`, p.duration_s) }; } } : realResolve(cap));
    try {
        const plan = await call('GET', ['film', 'inbetweens', id, 'video'], null, {});
        assert.equal(plan.code, 200);
        assert.equal(plan.json.shape, 'legs');
        assert.deepEqual(plan.json.calls.map(c => `${c.from}>${c.to}`), ['1A>2.0 s', '2.0 s>4.0 s', '4.0 s>6.0 s', '6.0 s>8.0 s', '8.0 s>1B']);
        assert.equal(sent.length, 0, 'the plan bought nothing');
        const r = await call('POST', ['film', 'inbetweens', id, 'video'], {});
        assert.equal(r.code, 200, JSON.stringify(r.json));
        assert.equal(sent.length, 5);
        assert.ok(sent.every(p => p.keyframes.length === 2 && p.keyframes[0].position === 'first' && p.keyframes[1].position === 'last'));
        assert.match(sent[1].prompt, /head turns fast/);
        const shot = db.prepare('SELECT selected_video_asset_id FROM film_shots WHERE id = ?').get(shotA);
        assert.equal(shot.selected_video_asset_id, r.json.asset_id);
        const clip = db.prepare('SELECT duration_ms, metadata FROM film_assets WHERE id = ?').get(r.json.asset_id);
        assert.ok(Math.abs(clip.duration_ms - 10000) < 300, `one 10 s file (${clip.duration_ms} ms)`);
        assert.equal(JSON.parse(clip.metadata).kind, 'inbetween_clip');
    } finally { providers.resolve = realResolve; }
});

test('the graph draws 1A → in-betweens → 1B', () => {
    const g = require('../lib/production-graph').buildGraph(db, pid);
    const node = g.nodes.find(n => n.type === 'inbetween');
    assert.ok(node, 'an in-betweens node');
    assert.equal(node.frames.length, 6, '1A, four frames, 1B');
    assert.ok(g.edges.some(e => e.from === `shot:${shotA}` && e.to === node.key));
    assert.ok(g.edges.some(e => e.from === node.key && e.to === `shot:${shotB}`));
    assert.ok(Number.isFinite(node.x) && node.w === 360);
    assert.ok(node.impact && node.impact.state, 'drawn with a state');
});

test('the page wires it: node, drawer, menu, shot-to-shot wire, and both dialogs', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    for (const needle of ["if (n.type === 'inbetween') return pgInbetweenNodeHtml", "else if (n.type === 'inbetween') pgDrawerInbetween",
        "pgMenuDo('ib-next')", "to.type === 'shot' && toPort === 'plates'", "if (from.type === 'shot' && to.type === 'shot') return ibOpenSetup(from, to)",
        'id="ibSetupModal"', 'id="ibDirectModal"', "previewUrl: '/inbetweens/' + id + '/generate' + q", "previewUrl: '/inbetweens/' + id + '/video'"]) {
        assert.ok(page.includes(needle), `the page is missing: ${needle}`);
    }
    assert.equal((page.match(/armable: d => !!d\.ready/g) || []).length >= 2, true, 'both paid paths arm only on a ready plan');
});

test('removing the span keeps its pictures', async () => {
    const before = db.prepare(`SELECT COUNT(*) n FROM film_assets WHERE json_extract(metadata, '$.kind') = 'inbetween_frame'`).get().n;
    const r = await call('DELETE', ['film', 'inbetweens', id]);
    assert.equal(r.code, 200);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM film_assets WHERE json_extract(metadata, '$.kind') = 'inbetween_frame'`).get().n, before);
});
