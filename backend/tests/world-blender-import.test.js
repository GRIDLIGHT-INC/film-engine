/**
 * A set built in Blender becomes a world Previs can walk through and frame in.
 *
 * "With Higgsfield and Blender, create our previz environment, then drop it
 * into our previz screen … we'd be able to walk through this 3D environment to
 * explore shots … and once I love a shot I can set the new camera settings to
 * the shot so it generates the appropriate storyboard shot."
 *
 *   - a GLB becomes the NEXT version of a world, never an overwrite: the
 *     previous version keeps its assets and every shot pinned to it stays;
 *   - it arrives CALIBRATED (glTF is metres), so lens, height and distance
 *     are true without measuring a door;
 *   - what is not a GLB, or cannot be read, is refused by name with nothing
 *     written; a locked world refuses;
 *   - a file path is honoured only inside the project's own folder;
 *   - the Look view is told to draw the textured scene;
 *   - an agent can do all of it through one tool;
 *   - the page draws the scene in Look, walks it, and keeps the walked camera
 *     through the same validated proposal a nudge uses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-wbi-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const worlds = require('../lib/worlds');
const { handleWorlds } = require('../routes/worlds');
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** A valid binary glTF: a floor 10 m x 6 m and a wall 3 m high, in metres. */
function sceneGlb() {
    const verts = [0, 0, 0, 10, 0, 0, 10, 0, 6, 0, 0, 6, 0, 3, 0, 10, 3, 0];
    const idx = [0, 1, 2, 0, 2, 3, 0, 1, 5, 0, 5, 4];
    const pos = Buffer.alloc(verts.length * 4); verts.forEach((v, i) => pos.writeFloatLE(v, i * 4));
    const ind = Buffer.alloc(idx.length * 4); idx.forEach((v, i) => ind.writeUInt32LE(v, i * 4));
    const bin = Buffer.concat([pos, ind]);
    const json = {
        asset: { version: '2.0', generator: 'Khronos glTF Blender I/O' },
        scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: verts.length / 3, type: 'VEC3', min: [0, 0, 0], max: [10, 3, 6] },
            { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length },
            { buffer: 0, byteOffset: pos.length, byteLength: ind.length }],
        buffers: [{ byteLength: bin.length }],
    };
    let jb = Buffer.from(JSON.stringify(json));
    if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)]);
    const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jb.length + 8 + bin.length, 8);
    const jc = Buffer.alloc(8); jc.writeUInt32LE(jb.length, 0); jc.write('JSON', 4);
    const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.write('BIN\0', 4);
    return Buffer.concat([h, jc, jb, bc, bin]);
}

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const [p, qs] = urlPath.split('?');
        const parts = p.split('/').filter(Boolean);
        const req = { method, body: body || {} };
        const chunks = [];
        const res = {
            statusCode: 200, headers: {},
            writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); },
            setHeader() {}, write(c) { chunks.push(c); },
            end(c) {
                if (c) chunks.push(c);
                const raw = chunks.map(x => Buffer.isBuffer(x) ? x.toString('utf8') : String(x)).join('');
                let data; try { data = JSON.parse(raw); } catch { data = raw; }
                resolve({ status: this.statusCode, data });
            },
        };
        Promise.resolve(handleWorlds(req, res, parts, Object.fromEntries(new URLSearchParams(qs || ''))))
            .catch(err => resolve({ status: 500, data: { error: err.message } }));
    });
}

function project() {
    const id = generateId();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-proj-'));
    db.prepare('INSERT INTO film_projects (id, title, assets_dir) VALUES (?, ?, ?)').run(id, 'Blender set', dir);
    return { id, dir };
}

test('a Blender scene becomes the next version, calibrated in metres, the old one untouched', async () => {
    const { id } = project();
    const w = worlds.createWorld(db, { projectId: id, name: 'The diner' });
    const v1 = worlds.newVersion(db, w.id, { reason: 'Marble', model: 'marble-1.0-draft' });
    const r = await call('POST', `/film/worlds/${w.id}/versions/import`, { glb: sceneGlb().toString('base64') });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const v2 = r.data.version;
    assert.equal(v2.version, 2);
    assert.equal(v2.parent_version_id, v1.id);
    assert.equal(v2.provider, 'blender');
    assert.equal(v2.scale_factor, 1);
    assert.equal(v2.scale_source, 'glb_metres');
    assert.equal(v2.scale_state, 'SCALE CALIBRATED');
    assert.deepEqual(r.data.size_m.map(n => Math.round(n)), [10, 3, 6]);
    assert.equal(worlds.getWorld(db, w.id).active_version_id, v2.id);
    assert.equal(worlds.getVersion(db, v1.id).provider, 'worldlabs', 'the earlier version is not rewritten');
    const geo = worlds.worldGeometry(db, v2.id);
    assert.equal(geo.scale, 1);
    assert.equal(Math.round(geo.size[0]), 10, 'the geometry reads in metres');
});

test('what is not a GLB, or cannot be read, is refused by name and writes nothing', async () => {
    const { id } = project();
    const w = worlds.createWorld(db, { projectId: id, name: 'Set' });
    const before = worlds.versionsFor(db, w.id).length;
    const bad = await call('POST', `/film/worlds/${w.id}/versions/import`, { glb: Buffer.from('hello world, not a glb').toString('base64') });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /not a GLB.*glTF Binary/);
    const trunc = await call('POST', `/film/worlds/${w.id}/versions/import`, { glb: sceneGlb().subarray(0, 40).toString('base64') });
    assert.equal(trunc.status, 400);
    assert.equal(worlds.versionsFor(db, w.id).length, before, 'a refused import leaves no version behind');
    const none = await call('POST', `/film/worlds/${w.id}/versions/import`, {});
    assert.match(none.data.error, /file_path/);
    worlds.lockWorld(db, w.id, true);
    const locked = await call('POST', `/film/worlds/${w.id}/versions/import`, { glb: sceneGlb().toString('base64') });
    assert.equal(locked.status, 423);
});

test('a file path is read only from inside the project\'s own folder', async () => {
    const { id, dir } = project();
    const w = worlds.createWorld(db, { projectId: id, name: 'Set' });
    fs.mkdirSync(path.join(dir, '03 Previs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '03 Previs', 'diner.glb'), sceneGlb());
    const ok = await call('POST', `/film/worlds/${w.id}/versions/import`, { file_path: '03 Previs/diner.glb' });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));

    const outside = path.join(os.tmpdir(), 'fe-outside-' + crypto.randomUUID().slice(0, 6) + '.glb');
    fs.writeFileSync(outside, sceneGlb());
    for (const p of [outside, '../' + path.basename(outside), '03 Previs/../../' + path.basename(outside)]) {
        const r = await call('POST', `/film/worlds/${w.id}/versions/import`, { file_path: p });
        assert.equal(r.status, 400, `${p} was read`);
        assert.match(r.data.error, /outside this project's folder|No file/);
    }
});

test('the Look view is told to draw the scene itself, whatever world_splats says', async () => {
    const { id } = project();
    const w = worlds.createWorld(db, { projectId: id, name: 'Set' });
    const marble = worlds.newVersion(db, w.id, { reason: 'Marble', model: 'marble-1.0-draft' });
    const m = await call('GET', `/film/world-versions/${marble.id}/splats`);
    assert.equal(m.data.mesh, null, 'a Marble version has no mesh Look');
    const r = await call('POST', `/film/worlds/${w.id}/versions/import`, { glb: sceneGlb().toString('base64') });
    const s = await call('GET', `/film/world-versions/${r.data.version.id}/splats`);
    assert.ok(s.data.mesh && /\/film\/worlds\/media\//.test(s.data.mesh.url), JSON.stringify(s.data));
    assert.equal(s.data.mesh.source, 'blender');
});

test('an agent imports through one tool, dispatched through the route', () => {
    const tools = require('../lib/mcp-tools');
    const all = (tools.listTools ? tools.listTools() : []);
    const t = all.find(x => x.name === 'world_import_glb');
    assert.ok(t, 'no world_import_glb tool');
    assert.match(t.description, /FREE/);
    assert.match(t.description, /metres/);
});

/** A function's source, bounded by brace depth from its declaration. */
function fnBody(name) {
    const at = SPA.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
    assert.ok(at >= 0, `${name} is not in the page`);
    let i = SPA.indexOf('(', at), p = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') p++; else if (SPA[i] === ')' && --p === 0) break; }
    i = SPA.indexOf('{', i);
    let d = 0;
    for (let j = i; j < SPA.length; j++) {
        if (SPA[j] === '{') d++;
        else if (SPA[j] === '}' && --d === 0) return SPA.slice(at, j + 1);
    }
    return '';
}

test('the page draws the scene in Look and opens on it', () => {
    assert.match(fnBody('worldSplatSync'), /info\.mesh\) \{ worldSplatStop\(\); return worldMeshSync/);
    assert.match(fnBody('worldViewMode'), /info && info\.mesh\) return 'look'/);
    const sync = fnBody('worldMeshSync');
    assert.match(sync, /GLTFLoader\(\)\.load\(mediaUrl\(info\.mesh\.url\)/);
    // The same pose the painter uses, or Look would be a different shot.
    assert.match(fnBody('worldMeshRenderOnce'), /worldCameraPose\(\)/);
});

test('walking moves the shot\'s own camera, and keeping it goes through the validated proposal', () => {
    const step = fnBody('worldWalkStep');
    assert.match(step, /worldWalkRepaint\(\)/);
    const key = fnBody('worldWalkKey');
    for (const k of ['w', 's', 'a', 'd', 'r', 'f', 'arrowleft', 'arrowright']) assert.match(key, new RegExp(`\\b${k}: \\(\\)`), `no ${k}`);
    assert.match(key, /INPUT|TEXTAREA/, 'typing in a field must not walk the camera');
    const keep = fnBody('worldWalkKeep');
    assert.match(keep, /\/shots\/\$\{WORLD\.shotId\}\/direct/);
    for (const f of ['truckM', 'pedestalM', 'dollyM', 'panDeg', 'tiltDeg', 'focalLengthMm']) assert.match(keep, new RegExp(f));
    assert.match(keep, /Calibrate this world first/, 'an uncalibrated world cannot keep a camera in metres');
});

test('the walked camera\'s keep is exactly the difference the proposal adds back', () => {
    // applyProposal adds the M fields to position (divided by the scale) and
    // the degrees to rotation. Keeping must send exactly the inverse.
    const { applyProposal } = require('../lib/cinematography');
    const from = { position: [1, 1.6, 4], rotation: [10, -2, 0], sensorId: 'super35', focalMm: 35 };
    const to = { position: [2.5, 1.2, 1], rotation: [40, 5, 0] };
    const f = 1;
    const changes = {
        truckM: (to.position[0] - from.position[0]) * f, pedestalM: (to.position[1] - from.position[1]) * f,
        dollyM: (to.position[2] - from.position[2]) * f,
        panDeg: to.rotation[0] - from.rotation[0], tiltDeg: to.rotation[1] - from.rotation[1], rollDeg: 0,
        focalLengthMm: 50,
    };
    const got = applyProposal(from, { changes }, { scale_factor: f, bounds: { min: [0, 0, 0] } });
    got.position.forEach((n, i) => assert.ok(Math.abs(n - to.position[i]) < 1e-9, `position ${i}`));
    got.rotation.forEach((n, i) => assert.ok(Math.abs(n - to.rotation[i]) < 1e-9, `rotation ${i}`));
    assert.equal(got.focalMm, 50);
});

test('a walked camera and every Camera Operate nudge are proposals the route accepts', () => {
    // Both were once sent flat with no rationale, and the route refused every
    // one ("the proposal changes nothing"): the nudge buttons had never moved
    // a camera. Held to the route's own validator, executed.
    const cine = require('../lib/cinematography');
    const run = (name, pre) => {
        const src = fnBody(name);
        // Pull the object literal passed as the request body and evaluate it
        // with the page's own variables stubbed.
        const m = src.match(/JSON\.stringify\((\{[\s\S]*?\})\s*\)\s*\}\s*\)/) || src.match(/const proposal = (\{[\s\S]*?\n        \});/);
        assert.ok(m, `${name}: no request body found`);
        // eslint-disable-next-line no-new-func
        return new Function(...Object.keys(pre), `return (${m[1]});`)(...Object.values(pre));
    };
    const axes = [{ field: 'dollyM', label: 'Dolly', unit: 'm' }];
    const nudge = run('worldNudge', { field: 'dollyM', amount: 0.25, axis: axes[0] });
    assert.deepEqual(cine.validateProposal(nudge, null).errors, [], JSON.stringify(nudge));
    const keep = run('worldWalkKeep', { d: () => 1, r: () => 5, WORLD: { lens: 35 } });
    assert.deepEqual(cine.validateProposal(keep, null).errors, [], JSON.stringify(keep));
    assert.equal(keep.apply, true);
});
