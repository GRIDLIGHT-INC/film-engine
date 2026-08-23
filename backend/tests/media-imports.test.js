/**
 * Persistent director imports.
 *
 * The denominator is the production import registry, not three copied examples:
 * every declared import target must validate its own media, write inside project
 * storage, register an asset, expose a serving URL, and have a UI file control.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), `film-engine-imports-${crypto.randomUUID().slice(0, 8)}`);

const ROOT = path.join(__dirname, '..');
const UI = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const {
    MEDIA_IMPORTS,
    importMedia,
} = require('../lib/media-imports');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function buildTriangleGlb() {
    const positions = Buffer.from(new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]).buffer);
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
        buffers: [{ byteLength: positions.length }],
    };
    const rawJson = Buffer.from(JSON.stringify(json));
    const jsonBytes = rawJson.length % 4 ? Buffer.concat([rawJson, Buffer.alloc(4 - rawJson.length % 4, 0x20)]) : rawJson;
    const total = 12 + 8 + jsonBytes.length + 8 + positions.length;
    const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
    header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
    jsonHeader.writeUInt32LE(jsonBytes.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    binHeader.writeUInt32LE(positions.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, positions]);
}
const GLB = buildTriangleGlb();

function callHandler(handler, method, url, body) {
    return new Promise(resolve => {
        const parts = url.split('/').filter(Boolean);
        const chunks = [];
        const res = new (require('stream').Writable)({ write(c, _e, next) { chunks.push(c); next(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            const raw = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        });
        Promise.resolve(handler({ method, body }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function seed() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Imports');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, 'I1', JSON.stringify({ shot_code: 'I1', description: 'Import probe' }));
    return { projectId, shotId };
}

test('every registered director import persists, registers, serves and has a UI control', () => {
    const entries = Object.entries(MEDIA_IMPORTS);
    assert.deepStrictEqual(entries.map(([id]) => id).sort(), ['previs-image', 'storyboard-image', 'three-d-model']);

    for (const [id, spec] of entries) {
        const owner = seed();
        const bytes = spec.kind === 'model' ? GLB : PNG;
        const mime = spec.kind === 'model' ? 'model/gltf-binary' : 'image/png';
        const result = importMedia(id, {
            ...owner,
            name: spec.kind === 'model' ? 'Meshy hero.glb' : 'director-board.png',
            data: `data:${mime};base64,${bytes.toString('base64')}`,
        });

        assert.ok(result.asset_id, `${id}: no asset id`);
        assert.ok(result.url, `${id}: no serving URL`);
        assert.ok(fs.existsSync(result.file_path), `${id}: file not written`);
        assert.ok(path.resolve(result.file_path).startsWith(path.resolve(process.env.FILM_DATA_DIR) + path.sep),
            `${id}: escaped project storage`);

        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(result.asset_id);
        assert.ok(asset, `${id}: no film_assets row`);
        assert.strictEqual(asset.project_id, owner.projectId, `${id}: wrong project linkage`);
        if (spec.shotScoped) assert.strictEqual(asset.shot_id, owner.shotId, `${id}: wrong shot linkage`);
        assert.match(UI, new RegExp(`data-import-target=["']${id}["']`), `${id}: no UI file control`);
    }
});

test('every registered import rejects invalid media before writing an asset', () => {
    for (const [id] of Object.entries(MEDIA_IMPORTS)) {
        const owner = seed();
        const before = db.prepare('SELECT COUNT(*) AS n FROM film_assets WHERE project_id = ?').get(owner.projectId).n;
        assert.throws(() => importMedia(id, {
            ...owner, name: '../escape.bin', data: 'data:application/octet-stream;base64,bm90LXRoZS1mb3JtYXQ=',
        }), /invalid|unsupported|signature/i, `${id}: invalid bytes accepted`);
        const after = db.prepare('SELECT COUNT(*) AS n FROM film_assets WHERE project_id = ?').get(owner.projectId).n;
        assert.strictEqual(after, before, `${id}: invalid import left an asset row`);
    }
});

test('a GLB must be drawable by Previs, not merely carry a valid header', () => {
    const owner = seed();
    const headerOnly = Buffer.from('676c5446020000000c000000', 'hex');
    assert.throws(() => importMedia('three-d-model', {
        ...owner, name: 'empty.glb', data: `data:model/gltf-binary;base64,${headerOnly.toString('base64')}`,
    }), /glb|drawable|short/i);
});

test('a valid Meshy GLB is accepted even when the browser labels it as generic binary', () => {
    const owner = seed();
    const imported = importMedia('three-d-model', {
        ...owner, name: 'meshy.glb', data: `data:application/octet-stream;base64,${GLB.toString('base64')}`,
    });
    assert.ok(imported.asset_id);
});

test('3D model upload is available directly in Previs as well as the model catalogue', () => {
    assert.match(UI, /data-import-target="three-d-model" data-import-surface="previs"/);
    assert.ok((UI.match(/data-import-target="three-d-model"/g) || []).length >= 2,
        'the 3D catalogue import exists, but Previs has no direct model import');
});

test('storyboard imports become the current version and model imports enter the previs catalogue', () => {
    const boardOwner = seed();
    const board = importMedia('storyboard-image', {
        ...boardOwner, name: 'board.png', data: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    const current = db.prepare("SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard' ORDER BY version DESC LIMIT 1")
        .get(boardOwner.shotId);
    assert.strictEqual(current.id, board.asset_id);

    const modelOwner = seed();
    const model = importMedia('three-d-model', {
        ...modelOwner, name: 'hero.glb', data: `data:model/gltf-binary;base64,${GLB.toString('base64')}`,
    });
    const listed = db.prepare("SELECT * FROM film_assets WHERE project_id = ? AND asset_type = 'other' AND json_extract(metadata, '$.kind') LIKE 'model%'")
        .all(modelOwner.projectId);
    assert.ok(listed.some(row => row.id === model.asset_id), 'imported GLB is absent from the previs model catalogue');
});

test('a second storyboard import archives and repoints the prior restorable version', () => {
    const owner = seed();
    const first = importMedia('storyboard-image', {
        ...owner, name: 'first.png', data: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    importMedia('storyboard-image', {
        ...owner, name: 'second.png', data: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    const prior = db.prepare('SELECT file_path, file_name FROM film_assets WHERE id = ?').get(first.asset_id);
    assert.match(prior.file_name, /_v1\.png$/);
    assert.ok(fs.existsSync(prior.file_path), 'the prior storyboard version was not archived');
});

test('every registered import is reachable through its production route', async () => {
    const routes = {
        'storyboard-image': {
            handler: require('../routes/storyboard').handleStoryboard,
            url: o => `/film/shots/${o.shotId}/storyboard/import`, mime: 'image/png', bytes: PNG, name: 'board.png',
        },
        'previs-image': {
            handler: require('../routes/previs').handlePrevis,
            url: o => `/film/shots/${o.shotId}/previs/image/import`, mime: 'image/png', bytes: PNG, name: 'stage.png',
        },
        'three-d-model': {
            handler: require('../routes/threed').handleThreeD,
            url: o => `/film/projects/${o.projectId}/models/import`, mime: 'model/gltf-binary', bytes: GLB, name: 'hero.glb',
        },
    };
    assert.deepStrictEqual(Object.keys(routes).sort(), Object.keys(MEDIA_IMPORTS).sort(), 'route matrix drifted from import registry');
    for (const [id, route] of Object.entries(routes)) {
        const owner = seed();
        const response = await callHandler(route.handler, 'POST', route.url(owner), {
            name: route.name, data: `data:${route.mime};base64,${route.bytes.toString('base64')}`,
        });
        assert.strictEqual(response.status, 201, `${id}: ${JSON.stringify(response.body)}`);
        assert.strictEqual(response.body.target, id);
    }
});
