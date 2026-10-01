/**
 * Staging people, furniture and models in Previs, and giving the view room.
 *
 * "Low poly man, woman, children of both genders, and I can move them in the
 * previz… add 3D objects we've generated in the design section into previz…
 * hide the left, right and bottom bar as needed to give more space."
 *
 *   - a staged subject names its model as a library entry OR one of this
 *     project's own 3D models, never both, never a library id that does not
 *     exist, never another project's asset or a file that is not a model;
 *   - moving a subject (PUT …/previs/subjects) keeps the camera, its keys and
 *     the move exactly as they were, so arranging people can never cost a
 *     director the angle they found;
 *   - an agent reaches both through its own tools, through the route;
 *   - the page's footprint maths faces the way the route says (yaw 0 is
 *     north, -Z) and the folds are remembered per browser;
 *   - Blender's physical light units are converted before the Look view
 *     draws them, or every clean set is pure white.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-staging-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();
const { handlePrevis } = require('../routes/previs');
const { callTool, listTools, isFailure } = require('../lib/mcp-tools');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function makeShot() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Staging');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, ?)').run(shotId, sceneId, '1A');
    return { projectId, shotId };
}

function asset(projectId, kind) {
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, metadata)
                VALUES (?, ?, 'other', '/x.glb', 'x.glb', ?)`).run(id, projectId, JSON.stringify({ kind }));
    return id;
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

const person = (o = {}) => Object.assign({ kind: 'human', name: 'Woman', position: [0, 0, -3], rotationDeg: [0, 180, 0],
    sizeM: [0.5, 1.65, 0.3], model: { library: 'woman' } }, o);

test('a staged model is a library entry or one of THIS project\'s 3D models, and nothing else', async () => {
    const { projectId, shotId } = makeShot();
    const other = makeShot();
    const mine = asset(projectId, 'model_3d');
    const theirs = asset(other.projectId, 'model_3d');
    const picture = asset(projectId, 'angle_candidate');
    const put = subjects => call('PUT', `/film/shots/${shotId}/previs/subjects`, { subjects });

    assert.equal((await put([person()])).status, 200);
    assert.equal((await put([person(), { kind: 'mesh', name: 'Creature', position: [1, 0, -4], model: { asset_id: mine } }])).status, 200);
    const refused = {
        'a library id that does not exist': [person({ model: { library: 'unicorn' } })],
        'both a library id and an asset': [person({ model: { library: 'woman', asset_id: mine } })],
        'neither': [person({ model: {} })],
        'a model on a cube': [person({ kind: 'cube' })],
        'another project\'s model': [{ kind: 'mesh', name: 'x', position: [0, 0, 0], model: { asset_id: theirs } }],
        'a file that is not a model': [{ kind: 'mesh', name: 'x', position: [0, 0, 0], model: { asset_id: picture } }],
    };
    for (const [why, subjects] of Object.entries(refused)) {
        const r = await put(subjects);
        assert.equal(r.status, 400, `${why} was accepted`);
        assert.ok(r.data.errors.some(e => /subjects\[\d\]\.model/.test(e)), `${why}: ${JSON.stringify(r.data.errors)}`);
    }
});

test('moving the people keeps the camera, its keys and the move', async () => {
    const { shotId } = makeShot();
    const camera = { position: [0.25, 1.55, -0.7], rotation: [0, -4, 0], focalMm: 24, sensorId: 'super35', fStop: 4, focusDistanceM: 4 };
    const cameraKeys = [{ t: 0, position: [0.25, 1.55, -0.7], rotation: [0, -4, 0], focalMm: 24 }, { t: 1, position: [0.25, 1.55, -1.7], rotation: [0, -4, 0], focalMm: 24 }];
    const first = await call('PUT', `/film/shots/${shotId}/previs`, { camera, cameraKeys, durationMs: 4000, subjects: [person()] });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const before = first.data.blocking;

    const moved = await call('PUT', `/film/shots/${shotId}/previs/subjects`,
        { subjects: [person({ position: [1, 0, -5], rotationDeg: [0, 90, 0] }), person({ name: 'Boy', model: { library: 'boy' } })] });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    const after = moved.data.blocking;
    assert.deepEqual(after.camera.position, before.camera.position);
    assert.deepEqual(after.camera.rotation, before.camera.rotation);
    assert.equal(after.camera.focalMm, 24);
    assert.equal(after.cameraKeys.length, 2, 'the camera keys were lost');
    assert.equal(after.durationMs, before.durationMs);
    assert.deepEqual(after.subjects.map(s => s.name), ['Woman', 'Boy']);
    assert.deepEqual(after.subjects[0].position, [1, 0, -5]);

    assert.equal((await call('POST', `/film/shots/${shotId}/previs/subjects`, {})).status, 405);
    assert.equal((await call('PUT', `/film/shots/${shotId}/previs/subjects`, { subjects: 'x' })).status, 400);
});

test('an agent stages through its own tools, through the route', async () => {
    const names = listTools().map(t => t.name);
    for (const n of ['previs_stage', 'previs_library']) assert.ok(names.includes(n), `${n} is not a tool`);
    const lib = await callTool('previs_library', { category: 'people' });
    const text = JSON.stringify(lib);
    for (const id of ['man', 'woman', 'boy', 'girl']) assert.ok(text.includes(`"${id}"`) || text.includes(`\\"${id}\\"`), `people lack ${id}`);

    const { shotId } = makeShot();
    const r = await callTool('previs_stage', { shot_id: shotId, subjects: [person({ name: 'Girl', model: { library: 'girl' } })] });
    assert.ok(!isFailure(r), JSON.stringify(r));
    const saved = db.prepare('SELECT subjects_json FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    assert.equal(JSON.parse(saved.subjects_json)[0].model.library, 'girl');
    const bad = await callTool('previs_stage', { shot_id: shotId, subjects: [person({ model: { library: 'unicorn' } })] });
    assert.ok(isFailure(bad), 'an unknown library id reached the stage through the tool');
});

/** A page function, lifted out and run. */
function pageFn(name) {
    const start = HTML.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} is not defined`);
    let i = HTML.indexOf(')', start); i = HTML.indexOf('{', i);
    let depth = 0;
    for (let j = i; j < HTML.length; j++) {
        if (HTML[j] === '{') depth++;
        else if (HTML[j] === '}' && --depth === 0) return HTML.slice(start, j + 1);
    }
    throw new Error(`could not read ${name}`);
}

test('the plan footprint faces where the route says: yaw 0 is north, the top of the plan', () => {
    const shape = new Function(`${pageFn('stageYaw')}; ${pageFn('stageSize')}; ${pageFn('stageShape')}; return stageShape;`)();
    const id = v => v;
    const at = yaw => shape({ kind: 'human', position: [0, 0, 0], rotationDeg: [0, yaw, 0], sizeM: [0.5, 1.7, 0.3] }, id, id, 1);
    const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    assert.ok(at(0).nose[1] < 0 && Math.abs(at(0).nose[0]) < 1e-9, 'yaw 0 should face -Z (north)');
    assert.ok(at(90).nose[0] < 0, 'yaw 90 should face west (-X): forward is (-sin t, -cos t)');
    assert.ok(at(180).nose[1] > 0, 'yaw 180 should face the camera side, +Z');
    assert.ok(near(at(0).centre, [0, 0]));
    // Wider than deep: a figure's shoulders run across its facing, not along it.
    const c = at(0).corners;
    assert.ok(Math.abs(c[1][0] - c[0][0]) > Math.abs(c[3][1] - c[0][1]));
});

test('the three folds hide their bar only on Previs, and are remembered per browser', () => {
    const store = {};
    const body = new Set();
    const sandbox = `
        const localStorage = { getItem: k => STORE[k] ?? null, setItem: (k, v) => { STORE[k] = v; } };
        const document = { body: { classList: { toggle: (c, on) => on ? BODY.add(c) : BODY.delete(c) } }, querySelectorAll: () => [] };
        const requestAnimationFrame = () => {}; const window = {}; const state = { currentPage: 'previs' };
        ${HTML.slice(HTML.indexOf('const PV_FOLDS'), HTML.indexOf('];', HTML.indexOf('const PV_FOLDS')) + 2)}
        ${pageFn('pvFolds')} ${pageFn('pvFolded')} ${pageFn('pvApplyFolds')} ${pageFn('pvToggleFold')}
        return { PV_FOLDS, pvToggleFold, pvApplyFolds, pvFolded, state };`;
    const page = new Function('STORE', 'BODY', sandbox)(store, body);
    assert.deepEqual(page.PV_FOLDS.map(f => f.id), ['left', 'right', 'bottom']);
    for (const { id } of page.PV_FOLDS) {
        page.pvToggleFold(id);
        assert.ok(body.has(`pv-hide-${id}`), `${id} did not hide`);
        assert.ok(page.pvFolded(id));
        // Leaving Previs gives every other page its bars back.
        page.pvApplyFolds('storyboard');
        assert.ok(!body.has(`pv-hide-${id}`), `${id} stayed hidden off Previs`);
        page.pvApplyFolds('previs');
        assert.ok(body.has(`pv-hide-${id}`), `${id} was forgotten`);
        page.pvToggleFold(id);
        assert.ok(!body.has(`pv-hide-${id}`));
    }
    assert.ok(JSON.parse(store.pv_folds), 'the folds are not stored');
    for (const { id } of page.PV_FOLDS) assert.ok(HTML.includes(`body.pv-hide-${id}`), `no CSS hides ${id}`);
    assert.ok(/pvApplyFolds\(page\)/.test(pageFn('worldSyncPanelShots')), 'the page change does not apply the folds');
});

test('Blender\'s light units are converted before the Look view draws them', () => {
    const conv = new Function(`${pageFn('meshLookLights')}; return meshLookLights;`)();
    const sun = { isLight: true, isDirectionalLight: true, intensity: 2049 };   // a sun of strength 3, as exported
    const lamp = { isLight: true, isPointLight: true, intensity: 432 };          // 100 W, as Blender exports it
    const root = { traverse: fn => [sun, lamp, { isMesh: true }].forEach(fn) };
    assert.equal(conv(root), true, 'a scene with its own sun should replace the viewer\'s');
    assert.ok(sun.intensity > 0.5 && sun.intensity < 2.5, `the sun reads ${sun.intensity}`);
    assert.ok(lamp.intensity > 0.3 && lamp.intensity < 3, `the lamp reads ${lamp.intensity}`);
    assert.equal(conv({ traverse: fn => [{ isMesh: true }].forEach(fn) }), false);
    assert.ok(/MESHLOOK\.sun\.visible = !meshLookLights\(/.test(HTML), 'the loader does not convert the lights');
});

test('the page offers all three sources, and a staged figure is drawn in Look at its size', () => {
    const add = pageFn('stageOpenAdd');
    for (const tab of ['people', 'furniture', 'models']) assert.ok(add.includes(`'${tab}'`), `no ${tab} tab`);
    assert.ok(/model_/.test(add), 'the project\'s models are not filtered to 3D models');
    const sync = pageFn('stageSyncLook');
    assert.ok(/sizeM/.test(sync), 'Look does not fit a model to its staged size');
    assert.ok(/stageSyncLook\(\)/.test(pageFn('worldMeshSync')), 'Look does not refresh its staged figures');
    assert.ok(/previs\/subjects/.test(pageFn('stageSave')), 'the page does not save through the subjects route');
});

test('saving the move keeps the camera and the people: the timeline has its own partial save', async () => {
    const { shotId } = makeShot();
    const camera = { position: [0.25, 1.55, -0.7], rotation: [0, -4, 0], focalMm: 24 };
    assert.equal((await call('PUT', `/film/shots/${shotId}/previs`, { camera, subjects: [person()] })).status, 200);
    const keys = [{ t: 0, position: [0.25, 1.55, -0.7], rotation: [0, -4, 0], focalMm: 24 },
                  { t: 1, position: [0.25, 1.55, -2], rotation: [10, -4, 0], focalMm: 24 }];
    const r = await call('PUT', `/film/shots/${shotId}/previs/timeline`,
        { moves: [{ movement: 'dolly-in', weight: 1 }], cameraKeys: keys, durationMs: 3000 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const b = r.data.blocking;
    assert.deepEqual(b.camera.position, [0.25, 1.55, -0.7], 'the timeline save moved the camera');
    assert.deepEqual(b.subjects.map(s => s.name), ['Woman'], 'the timeline save wiped the staged people');
    assert.equal(b.cameraKeys.length, 2);
    assert.equal(b.moves[0].movement, 'dolly-in');
    assert.notEqual(b.movement, 'static', 'the single movement is derived again (from the keys, which win over the legs)');
    assert.equal(b.durationMs, 3000);
    // And the reverse: moving people keeps the keys.
    const s2 = await call('PUT', `/film/shots/${shotId}/previs/subjects`, { subjects: [person({ name: 'Boy', model: { library: 'boy' } })] });
    assert.equal(s2.data.blocking.cameraKeys.length, 2, 'staging dropped the camera keys');
    assert.equal((await call('PUT', `/film/shots/${shotId}/previs/timeline`, {})).status, 400);
    assert.equal((await call('POST', `/film/shots/${shotId}/previs/timeline`, { moves: [] })).status, 405);
    const t = await callTool('previs_timeline', { shot_id: shotId, camera_keys: [] });
    assert.ok(!isFailure(t), JSON.stringify(t));
});

test('the page saves the move through the timeline route, loads it back, and keys the camera being looked through', () => {
    const save = pageFn('worldTimelineSave');
    assert.ok(/previs\/timeline/.test(save) && /cameraKeys/.test(save) && /durationMs/.test(save), 'the timeline is not saved through its own route');
    assert.ok(!/camera:\s*WORLD\.camera/.test(save), 'the timeline still sends a camera');
    const add = pageFn('worldAddKey');
    assert.ok(!/WORLD\.camera\b(?!\s*\(|Pose)/.test(add), 'a key still reads WORLD.camera, which nothing sets');
    assert.ok(/worldWalkCamera\(\)/.test(add), 'a key is not the camera being looked through');
    assert.ok(/cameraKeys/.test(pageFn('worldHydrateMove')), 'the saved keys are not loaded back');
    const calls = (HTML.match(/worldHydrateMove\(\)/g) || []).length;
    assert.ok(calls >= 2, 'the move is hydrated on too few loads');
});

test('the mouse moves the camera like a 3D application, and the plan zooms and pans', () => {
    for (const ev of ["'wheel'", "'pointerdown'", "'pointermove'"]) {
        assert.ok(new RegExp(`addEventListener\\(${ev}`).test(HTML), `no ${ev} listener`);
    }
    const ensure = pageFn('worldWalkEnsure');
    assert.ok(/WALK\.on = true/.test(ensure), 'a gesture does not start walking by itself');
    assert.ok(!/worldConsoleRender\(\)/.test(ensure), 'starting a walk mid-gesture re-renders the canvas under the drag');
    const view = pageFn('worldGestureView');
    assert.ok(/'plan'/.test(view) && /'pano'/.test(view), 'the 3D gestures would fight the plan and the 360° view');
    // Zoom about the cursor keeps the floor point under it.
    const zoomSrc = pageFn('planZoomAt');
    const PLANVIEW = { zoom: 1, cx: null, cz: null };
    let s = 50, cx = 0, cz = 0;
    const WORLD = { planXf: null };
    const paint = () => { const zs = 50 * PLANVIEW.zoom; const ccx = PLANVIEW.cx ?? cx, ccz = PLANVIEW.cz ?? cz;
        WORLD.planXf = { s: zs, zoom: PLANVIEW.zoom, w: 800, h: 600, cx: ccx, cz: ccz,
            inv: (px, pz) => [ccx + (px - 400) / zs, ccz + (pz - 300) / zs] }; };
    paint();
    const planZoomAt = new Function('WORLD', 'PLANVIEW', 'worldPaintFrame', `${zoomSrc}; return planZoomAt;`)(WORLD, PLANVIEW, paint);
    const before = WORLD.planXf.inv(600, 150);
    planZoomAt(600, 150, 2);
    const after = WORLD.planXf.inv(600, 150);
    assert.equal(PLANVIEW.zoom, 2);
    assert.ok(Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[1] - after[1]) < 1e-9, 'zoom moved the floor under the cursor');
    void s;
});

test('dolly and truck move along the camera\'s own axes, whichever way it faces', () => {
    const { applyProposal } = require('../lib/cinematography');
    const world = { scale_factor: 1, bounds: { min: [0, 0, 0] } };
    // Facing east (yaw -90 turns right from north): "in" (negative dolly) is +X.
    const east = applyProposal({ position: [0, 1.6, 0], rotation: [-90, 0, 0], focalMm: 35, sensorId: 'super35' },
        { changes: { dollyM: -1 } }, world);
    assert.ok(Math.abs(east.position[0] - 1) < 1e-9 && Math.abs(east.position[2]) < 1e-9, `dolly in facing east went to ${east.position}`);
    // Facing north, a positive truck is to the right: +X.
    const north = applyProposal({ position: [0, 1.6, 0], rotation: [0, 0, 0], focalMm: 35, sensorId: 'super35' },
        { changes: { truckM: 1 } }, world);
    assert.ok(Math.abs(north.position[0] - 1) < 1e-9, 'truck right facing north is not +X');
});

test('Camera Operate: every value is a drag-to-change number, the lens dolly-zooms, the playhead poses the camera', () => {
    const scrubSrc = HTML.slice(HTML.indexOf('const OPERATE_SCRUB'), HTML.indexOf(']);', HTML.indexOf('const OPERATE_SCRUB')));
    for (const id of ['distance', 'height', 'side', 'pan', 'tilt', 'roll', 'lens']) {
        assert.ok(scrubSrc.includes(`id: '${id}'`), `no draggable ${id}`);
    }
    const op = pageFn('worldOperateHtml');
    assert.ok(/data-scrub/.test(op), 'the values are not rendered as draggable numbers');
    assert.ok(/'in', 'out'/.test(op), 'the dolly buttons do not say which way they go');
    assert.ok(/WORLD\.mode === 'maintain'/.test(pageFn('worldOperateLens')), 'maintain-size moves no camera');
    assert.ok(/worldOperateLens/.test(pageFn('worldSetLens')), 'a lens button bypasses the dolly-zoom');
    assert.ok(/worldPoseAtT/.test(pageFn('worldSeekTo')), 'the playhead does not pose the camera');
    const pose = pageFn('worldCameraPose');
    assert.ok(/worldPreviewCamera\(\)/.test(pose), 'the Look and Plan views ignore the playhead');
    assert.ok(/worldPreviewCamera\(\)/.test(pageFn('worldPaintGeometry')), 'the Geometry view ignores the playhead');
});

test('the SHOT panel names framing and angle as a crew does, and both are on the Camera tab', () => {
    const fr = HTML.slice(HTML.indexOf('const SHOT_FRAMINGS'), HTML.indexOf(']);', HTML.indexOf('const SHOT_FRAMINGS')));
    for (const s of ['EWS', 'WS', 'FS', 'MWS', 'MS', 'MCU', 'CU', 'ECU']) assert.ok(fr.includes(`short: '${s}'`), `no ${s}`);
    const covers = [...fr.matchAll(/cover: ([\d.]+)/g)].map(m => Number(m[1]));
    assert.deepEqual([...covers].sort((a, b) => b - a), covers, 'framings are not ordered wide to tight');
    const an = HTML.slice(HTML.indexOf('const SHOT_ANGLES'), HTML.indexOf(']);', HTML.indexOf('const SHOT_ANGLES')));
    for (const a of ['eye', 'shoulder', 'hip', 'knee', 'ground', 'low', 'high', 'overhead']) assert.ok(an.includes(`id: '${a}'`), `no ${a} angle`);
    assert.equal((HTML.match(/\$\{worldShotHtml\(\)\}/g) || []).length, 2, 'the SHOT panel is not on both camera layouts');
    const place = pageFn('worldShotPlace');
    assert.ok(/Math\.tan\(v \/ 2\)/.test(place), 'framing is not solved from the lens');
    assert.ok(/worldWalkKeep\(\)/.test(place), 'a framing is not kept on the shot');
});

test('a camera looking up at a face is not refused because the feet are behind it', () => {
    const { validateCamera } = require('../lib/camera-validate');
    const blocking = { subjects: [{ name: 'Woman', isTarget: true, position: [0, 0, -1], sizeM: [0.5, 1.65, 0.3] }] };
    const cam = { position: [0, 0.7, -0.5], rotation: [0, 60, 0], focalMm: 24, sensorId: 'super35' };
    const out = validateCamera(cam, null, blocking);
    const failures = (out.failures || out.errors || []).map(f => f.check || f);
    assert.ok(!failures.includes('subject_behind_camera'), JSON.stringify(out));
});

test('a console redraw keeps every scrolled panel where it was, and the shot can be on anyone staged', () => {
    const render = pageFn('worldConsoleRender');
    const snap = render.indexOf('worldScrollSnapshot(host)'), set = render.indexOf('host.innerHTML ='), back = render.indexOf('worldScrollRestore(host');
    assert.ok(snap > 0 && set > snap && back > set, 'the console is redrawn without keeping its scroll: a click jumps the panel to the top');
    const on = pageFn('worldShotOnHtml');
    assert.ok(/stageSubjects\(\)/.test(on) && /worldShotOn\(/.test(on), 'the shot cannot be put on another subject');
    assert.ok(/isTarget = true/.test(pageFn('worldShotOn')), 'choosing a subject does not make it the framing subject');
});
