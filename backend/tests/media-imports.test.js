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
    // The subject rows a plate import links to. A target that is subject-scoped
    // resolves its own project from the subject, so the harness has to supply
    // one for every kind the registry declares.
    const characterId = generateId(), locationId = generateId(), propId = generateId();
    db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)').run(characterId, projectId, 'MAYA');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)').run(locationId, projectId, 'STREET');
    db.prepare('INSERT INTO film_props (id, project_id, name) VALUES (?, ?, ?)').run(propId, projectId, 'SEDAN');
    /*
     * The two surfaces whose whole content is a picture and which could only be
     * pointed at by server path: a continuity reference (a photograph of what
     * was actually shot) and a marketing asset (a poster made in a design tool).
     */
    const continuityId = generateId(), marketingId = generateId();
    db.prepare('INSERT INTO film_continuity_refs (id, project_id, ref_type, title) VALUES (?, ?, ?, ?)')
        .run(continuityId, projectId, 'visual', 'Wet street, night');
    db.prepare('INSERT INTO film_marketing_assets (id, project_id, type, title) VALUES (?, ?, ?, ?)')
        .run(marketingId, projectId, 'poster', 'Teaser one-sheet');
    return { projectId, shotId, sceneId, characterId, locationId, propId, continuityId, marketingId };
}

/** A minimal but genuinely valid file of each media kind. */
const MEDIA_BYTES = {
    video: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(24)]),
    audio: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(24)]),
};
const MEDIA_MIME = { video: 'video/mp4', audio: 'audio/wav' };

/** What each target needs to know about who it belongs to. */
function ownerArgsFor(spec, owner) {
    if (spec.sceneScoped) return { sceneId: owner.sceneId };
    if (spec.subjectKind) {
        return { subjectId: { character: owner.characterId, location: owner.locationId, prop: owner.propId }[spec.subjectKind] };
    }
    return {};
}

/** The bytes and mime a target will accept. */
function payloadFor(spec) {
    if (spec.kind === 'model') return { bytes: GLB, mime: 'model/gltf-binary' };
    if (spec.kind === 'video' || spec.kind === 'audio') {
        return { bytes: MEDIA_BYTES[spec.kind], mime: MEDIA_MIME[spec.kind] };
    }
    return { bytes: PNG, mime: 'image/png' };
}

/** Which seeded row each target links to, derived from the registry's own subjectKind. */
function subjectFor(spec, owner) {
    if (!spec.subjectKind) return {};
    return { subjectId: { character: owner.characterId, location: owner.locationId, prop: owner.propId }[spec.subjectKind] };
}

test('every registered director import persists, registers, serves and has a UI control', () => {
    const entries = Object.entries(MEDIA_IMPORTS);
    /*
     * Every target, not a snapshot of the three that existed first. The four
     * reference-plate imports were added because a director works outside Film
     * Engine as well as inside it; pinning this list is what makes the next one
     * arrive with a UI control and a route rather than only a registry entry.
     */
    /*
     * Every target, derived rather than snapshotted where it can be: the seven
     * `*-media` entries come from MEDIA_KINDS, so a ninth capability appears
     * here automatically and fails the route matrix below until it is wired.
     */
    const { MEDIA_KINDS } = require('../lib/media-kinds');
    const expected = [
        'character-plate', 'location-plate', 'mood-board-image', 'previs-image',
        'prop-plate', 'orientation-plan', 'storyboard-image', 'three-d-model',
        // The two surfaces whose entire content is a picture and which could
        // previously only be pointed at by a path on the server's own disk.
        'continuity-ref', 'marketing-asset',
        ...Object.values(MEDIA_KINDS).filter(k => k.media !== 'image').map(k => `${k.capability}-media`),
    ].sort();
    assert.deepStrictEqual(entries.map(([id]) => id).sort(), expected);

    for (const [id, spec] of entries) {
        const owner = seed();
        const { bytes, mime } = payloadFor(spec);
        const result = importMedia(id, {
            ...owner, ...ownerArgsFor(spec, owner),
            name: `external-${id}`,
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
        if (spec.sceneScoped) {
            // A scene-wide bed attached to one shot reads as working and is not.
            assert.strictEqual(asset.scene_id, owner.sceneId, `${id}: wrong scene linkage`);
            assert.strictEqual(asset.shot_id, null, `${id}: a scene-scoped bed was pinned to one shot`);
        }
        if (spec.assetType) {
            assert.strictEqual(asset.asset_type, spec.assetType,
                `${id}: stored as ${asset.asset_type}, so the timeline and the export will not find it`);
        }
        if (spec.subjectKind) {
            const column = { character: 'character_id', location: 'location_id', prop: 'prop_id' }[spec.subjectKind];
            assert.strictEqual(asset[column], subjectFor(spec, owner).subjectId,
                `${id}: not linked to its subject, so no shot will ever gather it`);
        }
        /*
         * Reachable from the page, checked two ways because the controls are
         * built two ways.
         *
         * Three of these are literal <input data-import-target="..."> in the
         * markup. The four plate imports are produced by uploadControl(), so
         * the literal attribute appears NOWHERE in the source — a grep alone
         * reports a working page as broken, which is the trap the blocking
         * panels already documented.
         */
        const literal = new RegExp(`data-import-target=["']${id}["']`).test(UI);
        const built = new RegExp(`uploadControl\\(\\s*['"]${id}['"]`).test(UI);
        // The media controls are addressed by CAPABILITY rather than by target
        // id — `mediaUploadControl('video', …)` emits data-import-target
        // "video-media" — because the capability is what the endpoint is named
        // after and carrying both names to the call site would invite them to
        // disagree.
        const byCapability = !!spec.capability
            && new RegExp(`mediaUploadControl\\(\\s*['"]${spec.capability}['"]`).test(UI);
        /*
         * Exempt BY NAME with a reason, never by pattern.
         *
         * The Continuity page was removed from the app; its route, its table
         * and its MCP reach were not, so `continuity-ref` is a live import
         * target with no page to import from. That is a real gap and it is
         * written down here rather than dropped from the denominator, because
         * a gap named is work and a gap silently excluded is one nobody finds
         * again. If Continuity comes back, so does its control, and this entry
         * goes; if the route is deleted too, the target leaves MEDIA_IMPORTS
         * and this entry goes with it. A stale exemption fails below.
         */
        const NO_UI = { 'continuity-ref': 'the Continuity page was removed; the route and MCP path remain' };
        if (NO_UI[id]) {
            assert.ok(MEDIA_IMPORTS[id], `stale exemption: '${id}' is no longer a registered import`);
            continue;
        }
        assert.ok(literal || built || byCapability, `${id}: no UI file control`);
    }
});

test('every registered import rejects invalid media before writing an asset', () => {
    for (const [id] of Object.entries(MEDIA_IMPORTS)) {
        const owner = seed();
        const before = db.prepare('SELECT COUNT(*) AS n FROM film_assets WHERE project_id = ?').get(owner.projectId).n;
        assert.throws(() => importMedia(id, {
            ...owner, ...ownerArgsFor(MEDIA_IMPORTS[id], owner),
            name: '../escape.bin', data: 'data:application/octet-stream;base64,bm90LXRoZS1mb3JtYXQ=',
        }), /invalid|unsupported|not a PNG|not a video|not an audio|signature/i, `${id}: invalid bytes accepted`);
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
        // A picture made outside Film Engine, for each thing that can be a
        // reference. These sit beside their generate routes deliberately.
        'character-plate': {
            handler: require('../routes/characters').handleCharacters,
            url: o => `/film/characters/${o.characterId}/refsheet/import`, mime: 'image/png', bytes: PNG, name: 'maya.png',
        },
        'location-plate': {
            handler: require('../routes/locations').handleLocations,
            url: o => `/film/locations/${o.locationId}/plate/import`, mime: 'image/png', bytes: PNG, name: 'street.png',
        },
        'prop-plate': {
            handler: require('../routes/locations').handleLocations,
            url: o => `/film/props/${o.propId}/plate/import`, mime: 'image/png', bytes: PNG, name: 'sedan.png',
        },
        'orientation-plan': {
            handler: require('../routes/locations').handleLocations,
            url: o => `/film/locations/${o.locationId}/orientation-plan/import`, mime: 'image/png', bytes: PNG, name: 'floor-plan.png',
        },
        'mood-board-image': {
            handler: require('../routes/mood-board').handleMoodBoard,
            url: o => `/film/projects/${o.projectId}/mood-board/import`, mime: 'image/png', bytes: PNG, name: 'still.png',
        },
        'continuity-ref': {
            handler: require('../routes/continuity').handleContinuity,
            url: o => `/film/continuity/${o.continuityId}/import`, mime: 'image/png', bytes: PNG, name: 'wet-street.png',
        },
        'marketing-asset': {
            handler: require('../routes/marketing').handleMarketing,
            url: o => `/film/marketing/${o.marketingId}/import`, mime: 'image/png', bytes: PNG, name: 'one-sheet.png',
        },
        /*
         * The seven media capabilities share ONE route, so they are generated
         * here rather than listed — a per-capability endpoint in each domain
         * file is how four of them get the format sniffing and the fifth
         * silently accepts anything.
         */
        ...Object.fromEntries(Object.values(require('../lib/media-kinds').MEDIA_KINDS)
            .filter(k => k.media !== 'image')
            .map(k => [`${k.capability}-media`, {
                handler: require('../routes/media-import').handleMediaImport,
                url: o => (k.scope === 'scene'
                    ? `/film/scenes/${o.sceneId}/media/${k.capability}/import`
                    : `/film/shots/${o.shotId}/media/${k.capability}/import`),
                mime: MEDIA_MIME[k.media], bytes: MEDIA_BYTES[k.media],
                name: `external.${k.media === 'video' ? 'mp4' : 'wav'}`,
            }])),
    };
    assert.deepStrictEqual(Object.keys(routes).sort(), Object.keys(MEDIA_IMPORTS).sort(), 'route matrix drifted from import registry');
    for (const [id, route] of Object.entries(routes)) {
        const owner = seed();
        const response = await callHandler(route.handler, 'POST', route.url(owner), {
            name: route.name, data: `data:${route.mime};base64,${route.bytes.toString('base64')}`,
        });
        assert.strictEqual(response.status, 201, `${id}: ${JSON.stringify(response.body)}`);
        assert.strictEqual(response.body.target, id);

        /*
         * The serving URL must actually serve.
         *
         * A URL built from the wrong directory is a perfectly good string and a
         * 404 — the upload succeeds and the clip will not play, which surfaces
         * as "the import is broken" much later. This was live on the media
         * imports for exactly one commit: `serveDir` is the gateway's own
         * directory ('videos') while the HTTP route is /film/video/, singular.
         * Asserting the URL is non-null would have passed.
         */
        if (response.body.url) {
            const [, , subdir, projectId, fileName] = response.body.url.split('/');
            const onDisk = path.join(process.env.FILM_DATA_DIR, subdir, projectId, fileName);
            assert.ok(fs.existsSync(onDisk),
                `${id}: url ${response.body.url} points at ${onDisk}, which does not exist — `
                + 'the file was stored somewhere the serving route will not find it');
        }
    }
});

test('every imported media slot is returned by the project surface that renders it', async () => {
    const { MEDIA_KINDS } = require('../lib/media-kinds');
    const owner = seed();
    for (const spec of Object.values(MEDIA_KINDS).filter(k => k.media !== 'image')) {
        const bytes = MEDIA_BYTES[spec.media];
        const mime = MEDIA_MIME[spec.media];
        importMedia(`${spec.capability}-media`, {
            ...owner,
            name: `outside-${spec.capability}.${spec.media === 'video' ? 'mp4' : 'wav'}`,
            data: `data:${mime};base64,${bytes.toString('base64')}`,
        });
    }

    const video = await callHandler(require('../routes/video-gen').handleVideoGen,
        'GET', `/film/projects/${owner.projectId}/video`, {});
    const music = await callHandler(require('../routes/music-gen').handleMusicGen,
        'GET', `/film/projects/${owner.projectId}/music/jobs`, {});
    assert.strictEqual(video.status, 200);
    assert.strictEqual(music.status, 200);

    const returned = new Set([...(video.body.assets || []), ...(music.body.assets || [])]
        .map(a => a.asset_type));
    const expected = Object.values(MEDIA_KINDS).filter(k => k.media !== 'image').map(k => k.assetType);
    assert.deepStrictEqual([...returned].sort(), [...new Set(expected)].sort(),
        'an upload can succeed but remain invisible because the page lists generation jobs instead of assets');

    const videoUi = UI.slice(UI.indexOf('async function loadVideoShots()'), UI.indexOf('async function generateVideoFor'));
    const musicUi = UI.slice(UI.indexOf('async function loadMusic()'), UI.indexOf('function generateScoreFor'));
    assert.match(videoUi, /videoData\.assets/, 'Video Shots ignores imported asset rows');
    assert.match(musicUi, /jobData\.assets/, 'Music & Sound ignores imported asset rows');
});

test('an uploaded MKV keeps an MKV filename instead of being mislabeled WebM', () => {
    const owner = seed();
    const ebml = Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.alloc(32)]);
    const result = importMedia('video-media', {
        ...owner, name: 'outside.mkv',
        data: `data:video/x-matroska;base64,${ebml.toString('base64')}`,
    });
    assert.match(result.file_name, /\.mkv$/,
        'MKV bytes were stored under .webm, so browsers and editors may choose the wrong demuxer');
});
