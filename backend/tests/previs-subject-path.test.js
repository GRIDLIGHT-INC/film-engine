/**
 * A staged subject that moves, a camera that follows it, the floor the plan
 * is cut on, and the move rendered to a video.
 *
 * "The camera follows a girl running from the top floor down through five
 * levels of the house" — one take, a person who goes somewhere, and a house
 * with storeys.
 *
 *   - a subject's path is timed keys, refused by name when they are not
 *     finite, out of the shot, out of order or too many;
 *   - ONE sampler, held equal in the page and in lib/ over a set of cases
 *     (the page draws the girl where the render puts her);
 *   - a running person faces where she runs unless a key says otherwise;
 *   - a moving subject is stored where she starts, and the prompt says so,
 *     briefly, with which way she runs;
 *   - Follow writes ORDINARY camera keys through the timeline route, behind
 *     the subject on her own path, and leaves the camera and people alone;
 *   - the plan's floors come from the set layout, else from the geometry,
 *     and a single storey keeps the old cut;
 *   - the previz video is rendered in Blender and encoded by ffmpeg, measured
 *     from the file, registered in 03 Previs, and refused by name without a
 *     set or without Blender.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-subjpath-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { handlePrevis } = require('../routes/previs');
const { callTool, listTools, isFailure } = require('../lib/mcp-tools');
const sp = require('../lib/previs-subject-path');
const { stagingFacts } = require('../lib/shot-staging');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function pageFn(name) {
    const start = HTML.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} is not defined in the page`);
    let i = HTML.indexOf(')', start); i = HTML.indexOf('{', i);
    let depth = 0, end = -1;
    for (let j = i; j < HTML.length; j++) {
        if (HTML[j] === '{') depth++;
        else if (HTML[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    // eslint-disable-next-line no-new-func
    return new Function(`${HTML.slice(start, end)}; return ${name};`)();
}

function makeShot(durationMs) {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps, aspect_ratio) VALUES (?, ?, ?, ?)').run(projectId, 'The Lodgers', 4, '16:9');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, duration_ms) VALUES (?, ?, ?, ?)').run(shotId, sceneId, '1A', durationMs || 4000);
    return { projectId, shotId };
}

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const res = {
            statusCode: 200,
            writeHead(s) { this.statusCode = s; },
            end(c) { let d; try { d = JSON.parse(String(c)); } catch { d = c; } resolve({ status: this.statusCode, data: d }); },
            setHeader() {},
        };
        handlePrevis({ method, body: body || {} }, res, urlPath.split('/').filter(Boolean), {});
    });
}

const girl = (o = {}) => Object.assign({ kind: 'human', name: 'Lily', position: [0, 0, 0], rotationDeg: [0, 0, 0],
    sizeM: [0.4, 1.26, 0.25], model: { library: 'girl' } }, o);

// Runs north 4 m in two seconds, turns east, down a stair 3 m over the next two.
const RUN = [
    { t: 0, position: [0, 0, 0] },
    { t: 2000, position: [0, 0, -4] },
    { t: 4000, position: [3, -3, -4] },
];

// ── the sampler ─────────────────────────────────────────────────────────────

const CASES = [
    { su: girl(), t: 1000, why: 'no path: the staged spot and facing' },
    { su: girl({ path: [{ t: 500, position: [2, 0, 2] }] }), t: 3000, why: 'one key: held' },
    { su: girl({ path: RUN }), t: 0, why: 'the first key' },
    { su: girl({ path: RUN }), t: 1000, why: 'halfway up the first leg' },
    { su: girl({ path: RUN }), t: 3000, why: 'on the stair' },
    { su: girl({ path: RUN }), t: 9000, why: 'after the last key: held' },
    { su: girl({ path: RUN }), t: -50, why: 'before the first key: held' },
    { su: girl({ path: [{ t: 0, position: [0, 0, 0], rotationDeg: [0, 170, 0] }, { t: 1000, position: [0, 0, 0], rotationDeg: [0, -170, 0] }] }),
      t: 500, why: 'both keys turned: the short way across the seam' },
    { su: girl({ path: [{ t: 0, position: [0, 0, 0] }, { t: 1000, position: [1, 0, 0] }, { t: 2000, position: [1, 0, 0] }] }),
      t: 1500, why: 'a pause keeps the facing it arrived with' },
    { su: girl({ path: [{ t: 1000, position: [0, 0, 0] }, { t: 0, position: [5, 0, 0] }] }), t: 500, why: 'keys out of order are read in time order' },
];

test('a running person faces where she runs; a turned key is honoured; she holds before and after', () => {
    const at = (t) => sp.subjectPoseAt(girl({ path: RUN }), t);
    assert.deepEqual(at(1000).position.map(n => +n.toFixed(3)), [0, 0, -2]);
    assert.equal(Math.round(at(1000).yawDeg), 0, 'running north faces north (yaw 0)');
    assert.equal(at(1000).moving, true);
    assert.equal(Math.round(at(3000).yawDeg), -90, 'running east faces east (turning right is negative)');
    assert.deepEqual(at(3000).position.map(n => +n.toFixed(3)), [1.5, -1.5, -4], 'the stair carries her down');
    assert.deepEqual(at(9000).position, [3, -3, -4]);
    assert.equal(at(9000).moving, false);
    const seam = sp.subjectPoseAt(CASES[7].su, 500).yawDeg;
    assert.ok(Math.abs(Math.abs(seam) - 180) < 1e-6, `170 to -170 crosses 180, not 0 (got ${seam})`);
    assert.equal(Math.round(sp.subjectPoseAt(CASES[8].su, 1500).yawDeg), -90, 'a pause faces the way she came in');
});

test('the page draws her where lib/ puts her: one sampler, held equal over every case', () => {
    const page = pageFn('subjectPoseAt');
    for (const c of CASES) {
        const a = sp.subjectPoseAt(c.su, c.t), b = page(c.su, c.t);
        a.position.forEach((v, k) => assert.ok(Math.abs(v - b.position[k]) < 1e-9, `${c.why}: position ${k}`));
        assert.ok(Math.abs(a.yawDeg - b.yawDeg) < 1e-9, `${c.why}: facing ${a.yawDeg} vs ${b.yawDeg}`);
        assert.equal(a.moving, b.moving, `${c.why}: moving`);
    }
});

// ── the route ───────────────────────────────────────────────────────────────

test('a path is refused by name: not finite, past the shot, out of order, too many', async () => {
    const { shotId } = makeShot(4000);
    const put = subjects => call('PUT', `/film/shots/${shotId}/previs/subjects`, { subjects });
    const bad = {
        'not an array': { path: 'north' },
        'a key with no time': { path: [{ position: [0, 0, 0] }] },
        'a position that is not three numbers': { path: [{ t: 0, position: [0, 0] }] },
        'a time after the shot': { path: [{ t: 0, position: [0, 0, 0] }, { t: 4500, position: [1, 0, 0] }] },
        'keys out of order': { path: [{ t: 1000, position: [0, 0, 0] }, { t: 500, position: [1, 0, 0] }] },
        'two keys at one moment': { path: [{ t: 500, position: [0, 0, 0] }, { t: 500, position: [1, 0, 0] }] },
        'a turned key that is not three numbers': { path: [{ t: 0, position: [0, 0, 0], rotationDeg: [0, 'x', 0] }] },
        'too many keys': { path: Array.from({ length: sp.MAX_PATH_KEYS + 1 }, (_, i) => ({ t: i, position: [i, 0, 0] })) },
    };
    for (const [why, extra] of Object.entries(bad)) {
        const r = await put([girl(extra)]);
        assert.equal(r.status, 400, `${why} was accepted`);
        assert.ok(r.data.errors.some(e => /subjects\[0\]\.path/.test(e)), `${why}: ${JSON.stringify(r.data.errors)}`);
    }
    const ok = await put([girl({ path: RUN })]);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test('a moving subject is stored where she starts, and saving her moves nothing else', async () => {
    const { shotId } = makeShot(4000);
    const camera = { position: [0, 1.6, 4], rotation: [0, -5, 0], focalMm: 24, sensorId: 'super35' };
    const cameraKeys = [{ t: 0, position: [0, 1.6, 4], rotation: [0, -5, 0], focalMm: 24 }, { t: 1, position: [0, 1.6, 2], rotation: [0, -5, 0], focalMm: 24 }];
    const first = await call('PUT', `/film/shots/${shotId}/previs`, { camera, cameraKeys, durationMs: 4000, subjects: [girl()] });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const r = await call('PUT', `/film/shots/${shotId}/previs/subjects`,
        { subjects: [girl({ position: [9, 9, 9], path: [{ t: 2000, position: [0, 0, -4] }, { t: 0, position: [1, 0, 1] }] })] });
    assert.equal(r.status, 400, 'keys out of order are refused rather than silently sorted');
    const ok = await call('PUT', `/film/shots/${shotId}/previs/subjects`,
        { subjects: [girl({ position: [9, 9, 9], path: [{ t: 0, position: [1, 0, 1] }, { t: 2000, position: [1, 0, -3] }] })] });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const b = ok.data.blocking;
    assert.deepEqual(b.subjects[0].position, [1, 0, 1], 'the stored spot is the start of the path');
    assert.equal(b.subjects[0].path.length, 2);
    assert.deepEqual(b.camera.position, camera.position, 'the camera did not move');
    assert.equal(b.cameraKeys.length, 2, 'the camera keys were kept');
    const cleared = await call('PUT', `/film/shots/${shotId}/previs/subjects`, { subjects: [girl({ path: [] })] });
    assert.equal(cleared.data.blocking.subjects[0].path, undefined, 'an empty path is dropped, not kept as noise');
});

test('the prompt says where she starts and which way she runs, briefly', () => {
    const previs = { camera: { position: [0, 1.6, 4], focalMm: 24, sensorId: 'super35' },
        subjects: [girl({ isTarget: true, path: [{ t: 0, position: [0, 0, 0] }, { t: 1000, position: [-4, 0, 0] }] })] };
    const f = stagingFacts(previs).said[0];
    assert.match(f.phrase, /^Lily .*centre frame, running toward frame left$/);
    const walking = stagingFacts({ ...previs, subjects: [girl({ isTarget: true, path: [{ t: 0, position: [0, 0, 0] }, { t: 4000, position: [0, 0, 3] }] })] }).said[0];
    assert.match(walking.phrase, /walking toward camera$/);
    const box = stagingFacts({ ...previs, subjects: [{ kind: 'cube', name: 'Cart', isTarget: true, position: [0, 0, 0], path: [{ t: 0, position: [0, 0, 0] }, { t: 1000, position: [0, 0, -3] }] }] }).said[0];
    assert.match(box.phrase, /moving away from camera$/);
    const still = stagingFacts({ ...previs, subjects: [girl({ isTarget: true })] }).said[0];
    assert.equal(still.motion, null, 'a subject with no path says nothing about moving');
});

test('Follow writes ordinary camera keys behind her, on her own path, and nothing else', async () => {
    const { shotId } = makeShot(4000);
    const camera = { position: [0, 1.6, 4], rotation: [0, 0, 0], focalMm: 24, sensorId: 'super35' };
    await call('PUT', `/film/shots/${shotId}/previs`, { camera, durationMs: 4000, subjects: [girl({ path: RUN })] });
    const r = await call('PUT', `/film/shots/${shotId}/previs/timeline`, { follow: { subject: 'lily', distance_m: 2, height_m: 1.5 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const b = r.data.blocking;
    assert.ok(b.cameraKeys.length >= 10, `only ${b.cameraKeys.length} keys`);
    assert.deepEqual(b.camera.position, camera.position, 'the saved camera is untouched');
    assert.equal(b.subjects[0].path.length, 3, 'the subject is untouched');
    for (const k of b.cameraKeys) {
        assert.ok(k.t >= 0 && k.t <= 1 && k.rotationUnit === 'degrees', 'an ordinary camera key');
        const s = sp.subjectPoseAt(b.subjects[0], k.t * 4000).position;
        const along = Math.hypot(k.position[0] - s[0], k.position[2] - s[2]);
        // On her path the camera is never further from her than the trailing distance.
        assert.ok(along <= 2 + 0.01, `at t ${k.t} the camera is ${along.toFixed(2)} m from her`);
        const aimYaw = Math.atan2(-(s[0] - k.position[0]), -(s[2] - k.position[2])) * 180 / Math.PI;
        if (along > 0.2) assert.ok(Math.abs(((aimYaw - k.rotation[0] + 540) % 360) - 180) < 1, `at t ${k.t} the camera is not aimed at her`);
    }
    const start = b.cameraKeys[0].position;
    assert.deepEqual(start.map(n => +n.toFixed(2)), [0, 1.5, 2], 'before she sets off the camera stands behind her, along her first leg');
    const mid = b.cameraKeys.find(k => Math.abs(k.t - 0.5) < 0.02).position;
    assert.deepEqual(mid.map(n => +n.toFixed(2)), [0, 1.5, -2], 'two metres behind her on her own route');
    const end = b.cameraKeys[b.cameraKeys.length - 1].position;
    assert.ok(end[1] < 0, 'the camera goes down the stair after her');
    assert.ok(b.path.length >= b.cameraKeys.length, 'the sampled path keeps every key');

    const none = await call('PUT', `/film/shots/${shotId}/previs/timeline`, { follow: { subject: 'Nobody' } });
    assert.equal(none.status, 400);
    await call('PUT', `/film/shots/${shotId}/previs/subjects`, { subjects: [girl()] });
    const still = await call('PUT', `/film/shots/${shotId}/previs/timeline`, { follow: { subject: 0 } });
    assert.equal(still.status, 400);
    assert.match(still.data.error, /no path/);
});

test('an agent records a path and a follow through the tools, through the routes', async () => {
    const names = listTools().map(t => t.name);
    for (const n of ['previs_stage', 'previs_timeline', 'previs_video_render', 'previs_video_list']) assert.ok(names.includes(n), `${n} is not a tool`);
    const { shotId } = makeShot(4000);
    const staged = await callTool('previs_stage', { shot_id: shotId, subjects: [girl({ path: RUN })] });
    assert.ok(!isFailure(staged), JSON.stringify(staged));
    const followed = await callTool('previs_timeline', { shot_id: shotId, follow: { subject: 0, distance_m: 2.5 } });
    assert.ok(!isFailure(followed), JSON.stringify(followed));
    const row = db.prepare('SELECT camera_keys_json FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    assert.ok(JSON.parse(row.camera_keys_json).length >= 10, 'the follow did not reach the shot');
});

// ── the plan's floors (page only: nothing on the server reads them) ────────

test('floors come from the layout, else the geometry; a single storey keeps one level', () => {
    const planLevels = pageFn('planLevels');
    const layout = { slabs: [{ z: 0 }, { z: 2.7 }, { z: 2.75 }, { z: 5.4 }], walls: [{ z0: 0 }, { z0: 2.7 }, { z0: 5.4 }, {}] };
    assert.deepEqual(planLevels({ layout }).map(n => +n.toFixed(2)), [0, 2.75, 5.4], 'slab tops and wall bases, clustered');

    // Geometry: two storeys of a box house — floor, walls up to 2.5, the next floor at 2.7, walls up to 5.2, roof.
    const v = [];
    const ring = (y) => { for (let i = 0; i < 40; i++) v.push([i % 10, y, Math.floor(i / 10)]); };
    ring(0); ring(2.5); ring(2.7); ring(5.2);
    for (let y = 0.3; y < 2.4; y += 0.3) v.push([0, y, 0]);
    for (let y = 3.0; y < 5.1; y += 0.3) v.push([0, y, 0]);
    assert.deepEqual(planLevels({ vertices: v }).map(n => +n.toFixed(1)), [0, 2.7], 'a ceiling with nothing standing on it is not a floor');
    const one = v.filter(p => p[1] < 2.6);
    assert.deepEqual(planLevels({ vertices: one }).map(n => +n.toFixed(1)), [0], 'one storey');
    assert.deepEqual(planLevels({}), [], 'nothing to read');

    // With triangles (what a world's geometry carries): floors by AREA, so a
    // dining table's top is not a storey, and walls are what stand on a floor.
    const V2 = [], T2 = [];
    const quad = (x0, x1, z0, z1, y) => { const b = V2.length; V2.push([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]); T2.push([b, b + 1, b + 2], [b, b + 2, b + 3]); };
    const wall = (x0, x1, y0, y1) => { const b = V2.length; V2.push([x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]); T2.push([b, b + 1, b + 2], [b, b + 2, b + 3]); };
    quad(0, 10, 0, 6, 0); wall(0, 10, 0, 2.5); quad(0, 10, 0, 6, 2.5);       // ground floor, its walls, its ceiling
    quad(0, 10, 0, 6, 2.7); wall(0, 10, 2.7, 5.2); quad(0, 10, 0, 6, 5.2);   // first floor, its walls, the roof
    quad(2, 3, 2, 3, 0.75);                                                   // a table top: 1 m²
    assert.deepEqual(planLevels({ vertices: V2, triangles: T2 }).map(n => +n.toFixed(1)), [0, 2.7]);

    const levelIndex = pageFn('planLevelIndex');
    assert.equal(levelIndex([0, 2.7, 5.4], 1.6), 0, 'a camera at eye height on the ground floor');
    assert.equal(levelIndex([0, 2.7, 5.4], 4.3), 1);
    assert.equal(levelIndex([0, 2.7, 5.4], 2.5), 1, 'feet just below a slab top still stand on it');
    assert.equal(levelIndex([0, 2.7, 5.4], 9), 2);
    assert.equal(levelIndex([], 3), 0);
});

test('the Plan view has a floor picker, path keys and Follow, and draws subjects at the playhead', () => {
    for (const fn of ['stageKeyHere', 'stageDeleteKey', 'stageClearPath', 'stageFollow', 'planSetFloor', 'previzVideoExport',
                      'stageShownSubject', 'stageLookPose']) {
        assert.ok(HTML.includes(`function ${fn}(`), `${fn} is not defined`);
        assert.ok(new RegExp(`${fn}\\(`).test(HTML.replace(new RegExp(`function ${fn}\\(`, 'g'), '')), `${fn} is never called`);
    }
    // Bounded by each function's own braces, never by a character window.
    const body = (name) => {
        const start = HTML.indexOf(`function ${name}(`);
        let i = HTML.indexOf('{', HTML.indexOf(')', start)), depth = 0;
        for (let j = i; j < HTML.length; j++) {
            if (HTML[j] === '{') depth++;
            else if (HTML[j] === '}') { depth--; if (!depth) return HTML.slice(start, j + 1); }
        }
        return '';
    };
    const paint = body('worldPaintPlan');
    assert.match(paint, /stageShownSubject\(/, 'the plan draws subjects at the playhead time');
    assert.match(paint, /planLevelsFor\(/, 'the plan reads its floors');
    assert.match(paint, /planActiveLevel\(/, 'the plan is cut on the floor on show');
    assert.match(body('planLevelsFor'), /set-builds\?world_version_id=/, 'the layout is preferred when there is one');
    assert.match(body('worldSeekTo'), /stageLookPose\(/, 'scrubbing moves the people in Look');
    assert.match(body('stageKeyHere'), /stageSave\(/, 'a key is saved through the subjects-only save');
    assert.match(body('stageSave'), /previs\/subjects/, 'and that save is the subjects-only route');
    assert.match(body('stageFollow'), /previs\/timeline/, 'Follow goes through the timeline route');
    assert.match(body('stageRenderBar'), /stagePathBarHtml\(su\)/, 'the path controls are on the staging bar');
    assert.match(body('worldConsoleV2Html'), /planFloorPickerHtml\(\)/, 'the floor picker is on the Plan view');
    assert.match(body('worldPaintFrame'), /planFloorPickerSync\(\)/, 'the floor picker is synchronized after the plan discovers its floors');
    assert.match(body('worldTimelineHtml'), /Number\(k\.t\).*WORLD\.durationMs/s, 'subject path milliseconds are normalized on the timeline');
    assert.match(body('worldTimelineHtml'), /previzVideoExport\(this\)/, 'Export previz video is on the move timeline');
});

// ── the previz video ────────────────────────────────────────────────────────

function sceneGlb() {
    const verts = [-6, 0, -6, 6, 0, -6, 6, 0, 6, -6, 0, 6, -6, 3, -6, 6, 3, -6];
    const idx = [0, 1, 2, 0, 2, 3, 0, 1, 5, 0, 5, 4];
    const pos = Buffer.alloc(verts.length * 4); verts.forEach((x, i) => pos.writeFloatLE(x, i * 4));
    const ind = Buffer.alloc(idx.length * 4); idx.forEach((x, i) => ind.writeUInt32LE(x, i * 4));
    const bin = Buffer.concat([pos, ind]);
    const json = {
        asset: { version: '2.0' }, scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: verts.length / 3, type: 'VEC3', min: [-6, 0, -6], max: [6, 3, 6] },
            { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: ind.length }],
        buffers: [{ byteLength: bin.length }],
    };
    let jb = Buffer.from(JSON.stringify(json));
    if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)]);
    const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jb.length + 8 + bin.length, 8);
    const jc = Buffer.alloc(8); jc.writeUInt32LE(jb.length, 0); jc.write('JSON', 4);
    const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.write('BIN\0', 4);
    return Buffer.concat([h, jc, jb, bc, bin]);
}

async function shotInASet(durationMs) {
    const { projectId, shotId } = makeShot(durationMs);
    const worlds = require('../lib/worlds');
    const w = worlds.createWorld(db, { projectId, name: 'The house' });
    const v = worlds.importVersion(db, w.id, { glb: sceneGlb() });
    worlds.pinShot(db, shotId, v.id);
    const r = await call('PUT', `/film/shots/${shotId}/previs`, {
        camera: { position: [0, 1.6, 4], rotation: [0, -5, 0], focalMm: 24, sensorId: 'super35' },
        cameraKeys: [{ t: 0, position: [0, 1.6, 4], rotation: [0, -5, 0], focalMm: 24 }, { t: 1, position: [0, 1.6, 1], rotation: [0, -5, 0], focalMm: 24 }],
        durationMs, subjects: [girl({ path: [{ t: 0, position: [0, 0, 0] }, { t: durationMs, position: [0, 0, -3] }] })] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return { projectId, shotId, versionId: v.id };
}

test('the render plan: one frame per frame of the shot, the camera on its path, her on hers', async () => {
    const pv = require('../lib/previs-video');
    const { shotId } = await shotInASet(2000);
    const p = pv.plan(shotId, { width: 320 });
    assert.equal(p.fps, 4, 'the project\'s own frame rate');
    assert.equal(p.frame_count, 8);
    assert.deepEqual([p.width, p.height], [320, 180], 'the project\'s aspect');
    assert.ok(/girl\.glb$/.test(p.subjects[0].glb), 'the girl is drawn from the library model');
    const first = p.frames[0], last = p.frames[p.frames.length - 1];
    // Blender axes: x east, y north, z up — a camera at world z 4 is Blender y -4.
    assert.deepEqual(first.cam.eye.map(n => +n.toFixed(2)), [0, -4, 1.6]);
    assert.deepEqual(last.cam.eye.map(n => +n.toFixed(2)), [0, -1, 1.6]);
    assert.ok(first.cam.target[1] > first.cam.eye[1], 'the camera looks north');
    assert.deepEqual(first.subjects[0].slice(0, 3).map(n => +n.toFixed(2)), [0, 0, 0]);
    assert.deepEqual(last.subjects[0].slice(0, 3).map(n => +n.toFixed(2)), [0, 3, 0], 'she ran three metres north');
    assert.equal(Math.round(last.subjects[0][3]), 0, 'facing north as she runs');
    const { shotId: bare } = makeShot(2000);
    await call('PUT', `/film/shots/${bare}/previs`, { durationMs: 2000 });
    assert.throws(() => pv.plan(bare), /not in a set/);
    const r = await call('POST', `/film/shots/${bare}/previs/render-video`, {});
    assert.equal(r.status, 409);
    assert.match(r.data.error, /not in a set/);
});

const blender = require('../lib/set-build').resolveBlender();
test('the move is rendered in Blender, encoded, measured, and kept in 03 Previs as a new version',
    { skip: blender.available ? false : `Blender is not installed here: ${blender.reason}`, timeout: 300000 }, async () => {
        const { projectId, shotId } = await shotInASet(1000);
        const r = await call('POST', `/film/shots/${shotId}/previs/render-video`, { wait: true, width: 160 });
        assert.equal(r.status, 201, JSON.stringify(r.data));
        const v = r.data.video;
        assert.equal(v.kind, 'previs_video');
        assert.equal(v.version, 1);
        assert.match(v.url, new RegExp(`^/film/previs/media/${projectId}/1A_previz_v1\\.mp4$`));
        const row = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(v.asset_id);
        assert.equal(row.shot_id, shotId);
        assert.equal(row.asset_type, 'other');
        assert.ok(fs.existsSync(row.file_path));
        const info = require('../lib/ffmpeg').inspectMedia(row.file_path);
        assert.equal(info.width, 160, JSON.stringify(info));
        assert.ok(Math.abs(info.durationSeconds - 1) < 0.3, `the file runs ${info.durationSeconds} s`);
        const listed = await call('GET', `/film/shots/${shotId}/previs/videos`);
        assert.equal(listed.data.videos.length, 1);
        assert.equal(listed.data.job.status, 'done');
        const again = await call('POST', `/film/shots/${shotId}/previs/render-video`, { wait: true, width: 160 });
        assert.equal(again.data.video.version, 2, 'a second export is a new version; the first stays');
        assert.ok(fs.existsSync(row.file_path));
    });

test('without Blender the render is refused with the reason, before anything is written', async () => {
    const setBuild = require('../lib/set-build');
    const real = setBuild.resolveBlender;
    setBuild.resolveBlender = () => ({ available: false, reason: 'Blender was not found (looked at nowhere).' });
    try {
        const { shotId } = await shotInASet(1000);
        const r = await call('POST', `/film/shots/${shotId}/previs/render-video`, {});
        assert.equal(r.status, 503);
        assert.match(r.data.error, /Blender was not found/);
        const none = db.prepare(`SELECT COUNT(*) n FROM film_assets WHERE shot_id = ? AND json_extract(metadata, '$.kind') = 'previs_video'`).get(shotId);
        assert.equal(none.n, 0);
    } finally { setBuild.resolveBlender = real; }
});
