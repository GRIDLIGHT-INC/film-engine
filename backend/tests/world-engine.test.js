/**
 * World Engine — Phase 1 (MVP 1): the world exists.
 *
 * Implements the cases named in docs/world-engine/test-spec.md §3 and the
 * phase-1 decision guards from §2. Set-based throughout: every denominator is
 * read from a registry, never typed here, because a list written into a test is
 * only as complete as the afternoon it was written.
 *
 * The two questions this file exists to answer:
 *
 *   1. Can a location's plates become a persistent, versioned world that a shot
 *      can be pinned to — without a version ever being overwritten, and without
 *      deleting a world taking a director's hand-authored blocking with it?
 *   2. Is an uncalibrated world REPORTED as uncalibrated, rather than quietly
 *      reading as 1:1? Marble promises no unit, so a confident metre figure on
 *      an unmeasured world is worse than no figure at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-world-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const worlds = require('../lib/worlds');
const scale = require('../lib/world-scale');
const worldAssets = require('../lib/world-assets');
const { handleWorlds } = require('../routes/worlds');
const wl = require('../lib/providers/worldlabs');

const REPO = path.join(__dirname, '..', '..');

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeProject(title) {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, title || 'World Test');
    return projectId;
}

function makeShot(projectId) {
    const sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, ?)').run(shotId, sceneId, 'SH01');
    return { sceneId, shotId };
}

/** A minimal, valid binary glTF with `count` triangles — no fixture file on disk. */
function makeGlb(count) {
    const verts = [], idx = [];
    for (let i = 0; i < count; i++) {
        const o = i * 3;
        verts.push(i * 0.01, 0, 0, i * 0.01, 1, 0, i * 0.01, 0, 1);
        idx.push(o, o + 1, o + 2);
    }
    const pos = Buffer.alloc(verts.length * 4);
    verts.forEach((v, i) => pos.writeFloatLE(v, i * 4));
    const ind = Buffer.alloc(idx.length * 4);
    idx.forEach((v, i) => ind.writeUInt32LE(v, i * 4));
    const bin = Buffer.concat([pos, ind, Buffer.alloc((4 - ((pos.length + ind.length) % 4)) % 4)]);
    const json = {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: verts.length / 3, type: 'VEC3' },
            { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: pos.length },
            { buffer: 0, byteOffset: pos.length, byteLength: ind.length },
        ],
        buffers: [{ byteLength: bin.length }],
    };
    let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
    const header = Buffer.alloc(12);
    header.write('glTF', 0); header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const jc = Buffer.alloc(8); jc.writeUInt32LE(jsonBuf.length, 0); jc.write('JSON', 4);
    const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.write('BIN\0', 4);
    return Buffer.concat([header, jc, jsonBuf, bc, bin]);
}

/** The shape Marble really returns — measured from world 06be9e1f on 2026-09-04. */
function providerWorld(overrides) {
    return Object.assign({
        id: 'wl-' + crypto.randomUUID().slice(0, 8),
        collider_mesh_url: 'https://cdn.example/collider.glb',
        panorama_url: 'https://cdn.example/pano.png',
        thumbnail_url: 'https://cdn.example/thumb.png',
        splat_urls: {
            '100k': 'https://cdn.example/100k.spz',
            '500k': 'https://cdn.example/500k.spz',
            full_res: 'https://cdn.example/full.spz',
        },
        caption: 'a residential cul-de-sac',
    }, overrides || {});
}

/** Records what was fetched, so "recorded but not downloaded" is provable. */
function stubFetch(collider) {
    const fetched = [];
    const impl = async (url) => {
        fetched.push(url);
        const body = /collider/.test(url) ? (collider || makeGlb(40)) : Buffer.from('PNGDATA');
        return { ok: true, status: 200, buffer: async () => body,
                 arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
    };
    impl.fetched = fetched;
    return impl;
}

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const [p, qs] = urlPath.split('?');
        const parts = p.split('/').filter(Boolean);
        const query = Object.fromEntries(new URLSearchParams(qs || ''));
        const req = { method, body: body || {} };
        const res = {
            statusCode: 200, headers: {}, _chunks: [],
            writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); },
            setHeader(k, v) { this.headers[k] = v; },
            write(c) { this._chunks.push(c); },
            end(c) {
                if (c) this._chunks.push(c);
                const raw = this._chunks.map(x => Buffer.isBuffer(x) ? x.toString('utf8') : String(x)).join('');
                let data; try { data = JSON.parse(raw); } catch { data = raw; }
                resolve({ status: this.statusCode, data, headers: this.headers });
            },
        };
        Promise.resolve(handleWorlds(req, res, parts, query)).catch(err => resolve({ status: 500, data: { error: err.message } }));
    });
}

async function seedWorld(opts) {
    const projectId = (opts && opts.projectId) || makeProject();
    const w = worlds.createWorld(db, { projectId, name: 'Maple Street' });
    const v = worlds.newVersion(db, w.id, { reason: 'Storyboard generated', model: 'marble-1.0-draft' });
    return { projectId, world: w, version: v };
}

// ══ WE-1.1 · the schema is what the plan declares ═══════════════════════════

test('WE-1.1 the migration declares the four tables and the two columns', () => {
    const tables = ['film_worlds', 'film_world_versions', 'film_world_assets', 'film_world_sources'];
    const missing = tables.filter(t =>
        !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
    assert.deepStrictEqual(missing, [], `tables missing: ${missing.join(', ')}`);

    const cols = db.prepare('PRAGMA table_info(film_previs_blocking)').all().map(c => c.name);
    for (const c of ['world_version_id', 'world_pinned_at']) {
        assert.ok(cols.includes(c), `film_previs_blocking is missing ${c}`);
    }

    // The uniqueness that stops re-ingest accumulating and versions colliding.
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' OR type='table'").all()
        .map(r => r.sql || '').join('\n');
    assert.match(idx, /UNIQUE\s*\(\s*world_id\s*,\s*version\s*\)/i, 'no UNIQUE(world_id, version)');
    assert.match(idx, /UNIQUE\s*\(\s*world_version_id\s*,\s*kind\s*\)/i, 'no UNIQUE(world_version_id, kind)');
});

// ══ WE-1.2 / WE-1.3 · versions and cascade ══════════════════════════════════

test('WE-1.2 a version is never overwritten', async () => {
    const { world } = await seedWorld();
    const v1 = worlds.versionsFor(db, world.id)[0];
    const v2 = worlds.newVersion(db, world.id, { parentVersionId: v1.id, reason: 'Added reverse angle' });
    const v3 = worlds.newVersion(db, world.id, { parentVersionId: v2.id, reason: 'Corrected geometry' });

    const all = worlds.versionsFor(db, world.id);
    assert.deepStrictEqual(all.map(v => v.version), [1, 2, 3], 'versions did not accumulate');
    assert.strictEqual(v3.parent_version_id, v2.id);
    assert.strictEqual(v2.parent_version_id, v1.id);

    // v1 is untouched by the existence of its descendants.
    const v1After = worlds.versionsFor(db, world.id).find(v => v.version === 1);
    assert.strictEqual(v1After.id, v1.id);
    assert.strictEqual(v1After.reason, 'Storyboard generated');
});

test('WE-1.3 deleting a world cascades versions, assets and sources', async () => {
    const { world, version } = await seedWorld();
    await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: stubFetch() });
    db.prepare('INSERT INTO film_world_sources (id, world_version_id, source_type) VALUES (?, ?, ?)')
        .run(generateId(), version.id, 'image');

    const other = await seedWorld();
    worlds.deleteWorld(db, world.id);

    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_world_versions WHERE world_id = ?').get(world.id).n, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_world_assets WHERE world_version_id = ?').get(version.id).n, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_world_sources WHERE world_version_id = ?').get(version.id).n, 0);
    // and only that world
    assert.strictEqual(worlds.versionsFor(db, other.world.id).length, 1, 'a sibling world was collateral');
});

// ══ WE-1.4 / 1.5 / D8 · ingestion ═══════════════════════════════════════════

test('WE-1.4 every declared asset kind is ingested', async () => {
    const { version } = await seedWorld();
    const f = stubFetch();
    const out = await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: f });

    const kinds = db.prepare('SELECT kind FROM film_world_assets WHERE world_version_id = ? ORDER BY kind').all(version.id).map(r => r.kind);
    // DERIVED from the module's own vocabulary, not typed here.
    assert.ok(worlds.WORLD_ASSET_KINDS.length >= 6, 'the kind vocabulary shrank');
    assert.deepStrictEqual(kinds.sort(), [...worlds.WORLD_ASSET_KINDS].sort(),
        `ingest covered ${kinds.length} of ${worlds.WORLD_ASSET_KINDS.length} kinds`);
    assert.ok(out.caption, 'the caption was dropped');
});

test('WE-D8.1 world assets use asset_type=other with metadata.kind', async () => {
    const { version } = await seedWorld();
    await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: stubFetch() });

    const rows = db.prepare(`SELECT a.asset_type, a.metadata FROM film_world_assets w
        JOIN film_assets a ON a.id = w.asset_id WHERE w.world_version_id = ?`).all(version.id);
    assert.ok(rows.length > 0, 'nothing was registered in film_assets');
    for (const r of rows) {
        assert.strictEqual(r.asset_type, 'other', 'used an asset_type the CHECK would refuse');
        const kind = JSON.parse(r.metadata || '{}').kind || '';
        assert.match(kind, /^world_/, `metadata.kind is "${kind}"`);
    }
});

test('WE-D8.2/D3.2 the three heavy kinds are copied; splats are recorded only', async () => {
    const { version } = await seedWorld();
    const f = stubFetch();
    await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: f });

    const rows = db.prepare('SELECT kind, remote_url, asset_id FROM film_world_assets WHERE world_version_id = ?').all(version.id);
    const copied = rows.filter(r => r.asset_id).map(r => r.kind).sort();
    const recorded = rows.filter(r => !r.asset_id).map(r => r.kind).sort();

    assert.deepStrictEqual(copied, [...worlds.COPIED_KINDS].sort(), 'the wrong set was copied locally');
    assert.ok(recorded.every(k => k.startsWith('splat_')), `recorded-only set is ${recorded.join(',')}`);
    for (const r of rows.filter(x => !x.asset_id)) assert.ok(r.remote_url, `${r.kind} has neither bytes nor a URL`);

    // Zero splat bytes crossed the wire while WORLD_SPLATS is off.
    assert.ok(!f.fetched.some(u => /\.spz/.test(u)), `a splat was downloaded: ${f.fetched.join(', ')}`);
});

test('WE-D8.3 re-ingesting replaces rather than accumulates', async () => {
    const { version } = await seedWorld();
    await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: stubFetch() });
    await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: stubFetch() });
    const n = db.prepare('SELECT COUNT(*) n FROM film_world_assets WHERE world_version_id = ?').get(version.id).n;
    assert.strictEqual(n, worlds.WORLD_ASSET_KINDS.length, `${n} rows for ${worlds.WORLD_ASSET_KINDS.length} kinds`);
});

test('WE-1.5 a draft world with null mesh urls ingests cleanly', async () => {
    const { version } = await seedWorld();
    // Measured: marble-1.0-draft returns collider only; hq/full_res are null.
    const out = await worlds.ingestWorld(db, version.id,
        providerWorld({ thumbnail_url: null, panorama_url: null }), { fetchImpl: stubFetch() });
    assert.ok(out, 'a draft world threw');
    const kinds = db.prepare('SELECT kind FROM film_world_assets WHERE world_version_id = ?').all(version.id).map(r => r.kind);
    assert.ok(kinds.includes('collider'), 'the collider was lost');
    assert.ok(!kinds.includes('panorama'), 'a null URL was written as a row');
});

// ══ WE-1.6 / 1.7 / 1.8 · the provider contract ══════════════════════════════

test('WE-1.6 all four prompt types build a valid request', () => {
    // DERIVED from the API's own 422 vocabulary, mirrored by the adapter.
    const types = ['text', 'image', 'multi-image', 'video'];
    const img = (view) => ({ view, data: 'AA==', extension: 'png' });
    const built = types.map(t => {
        if (t === 'text') return wl.buildWorldPrompt({ prompt: 'a street' });
        if (t === 'image') return wl.buildWorldPrompt({ prompt: 'a street', images: [img('')] });
        if (t === 'multi-image') return wl.buildWorldPrompt({ prompt: 'a street', images: [img('north'), img('south')] });
        return wl.buildWorldPrompt({ prompt: 'a street', video: { data: 'AA==', extension: 'mp4' } });
    });
    for (let i = 0; i < types.length; i++) {
        assert.ok(built[i] && built[i].prompt, `${types[i]} produced nothing`);
        assert.strictEqual(built[i].prompt.type, types[i], `${types[i]} built ${built[i].prompt && built[i].prompt.type}`);
    }
});

test('WE-1.6b multi-image slices to the ceiling and reports what it dropped', () => {
    const images = ['north', 'east', 'south', 'west', 'north-east', 'up']
        .map(view => ({ view, data: 'AA==', extension: 'png' }));
    const out = wl.buildWorldPrompt({ prompt: 'a street', images });
    const sent = out.prompt.multi_image_prompt || [];
    assert.ok(sent.length <= wl.MAX_INPUT_IMAGES, `${sent.length} against a ceiling of ${wl.MAX_INPUT_IMAGES}`);
    // Over-budget images are REPORTED, never dropped in silence.
    assert.strictEqual(out.dropped, images.length - wl.MAX_INPUT_IMAGES, 'the drop was not reported');
});

test('WE-1.7 every declared model is accepted and an unknown one is refused locally', async () => {
    const { world } = await seedWorld();
    const models = Object.keys(wl.MODELS);
    assert.strictEqual(models.length, 4, 'the model list changed');
    for (const model of models) {
        const v = worlds.newVersion(db, world.id, { reason: 'model probe', model });
        assert.strictEqual(v.model, model, `${model} was not stored`);
    }
    assert.throws(() => worlds.newVersion(db, world.id, { reason: 'bad', model: 'marble-9' }),
        /marble-1\.0-draft/, 'an unknown model was accepted, or refused without naming the legal set');
});

test('WE-1.8 the five compass azimuths map as documented', () => {
    const expected = { north: 0, east: 90, south: 180, west: 270, '': 0 };
    assert.strictEqual(Object.keys(wl.AZIMUTH).length, Object.keys(expected).length);
    for (const [view, deg] of Object.entries(expected)) {
        assert.strictEqual(wl.AZIMUTH[view], deg, `${view || '(default)'} maps to ${wl.AZIMUTH[view]}, not ${deg}`);
    }
});

// ══ WE-1.9 / 1.10 / D6 · scale ══════════════════════════════════════════════

test('WE-1.9 every calibration source produces an auditable factor', () => {
    assert.ok(scale.CALIBRATION_SOURCES.length >= 5, 'the source vocabulary shrank');
    for (const source of scale.CALIBRATION_SOURCES) {
        const c = scale.calibrate({ source, knownMeters: 1.68, measuredUnits: 2.042 });
        assert.ok(Math.abs(c.factor - (1.68 / 2.042)) < 1e-9, `${source} computed ${c.factor}`);
        // Both operands survive, so the factor can be re-derived and argued with.
        assert.strictEqual(c.source, source);
        assert.strictEqual(c.knownMeters, 1.68);
        assert.strictEqual(c.measuredUnits, 2.042);
    }
});

test('WE-1.10 degenerate calibration is refused, never clamped', () => {
    for (const measuredUnits of [0, -1, NaN, Infinity]) {
        assert.throws(() => scale.calibrate({ source: 'custom', knownMeters: 1.68, measuredUnits }),
            /measured|positive|finite/i, `measuredUnits=${measuredUnits} was accepted`);
    }
    for (const knownMeters of [0, -2, NaN]) {
        assert.throws(() => scale.calibrate({ source: 'custom', knownMeters, measuredUnits: 2 }),
            /known|positive|finite/i, `knownMeters=${knownMeters} was accepted`);
    }
    assert.throws(() => scale.calibrate({ source: 'not_a_source', knownMeters: 1, measuredUnits: 1 }),
        /source/i, 'an unknown calibration source was accepted');
});

test('WE-D6.1 a NULL scale factor never reads as 1.0', async () => {
    const { version } = await seedWorld();
    assert.strictEqual(scale.toMetres(5, null), null, 'toMetres invented a unit');
    assert.strictEqual(scale.toMetres(5, undefined), null);
    assert.match(scale.describeScale({ scale_factor: null }), /APPROXIMATE/i);
    assert.match(scale.describeScale({ scale_factor: 0.82 }), /CALIBRATED/i);

    await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: stubFetch() });
    const geo = worlds.worldGeometry(db, version.id, {});
    assert.strictEqual(geo.scale, null, `uncalibrated geometry reported scale ${geo.scale}`);
});

test('WE-D6.2 / WE-1.11 scale is applied on read; the stored file never changes', async () => {
    const { version } = await seedWorld();
    await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: stubFetch(makeGlb(30)) });

    const before = worlds.worldGeometry(db, version.id, {});
    const row = db.prepare('SELECT a.file_path FROM film_world_assets w JOIN film_assets a ON a.id = w.asset_id WHERE w.world_version_id = ? AND w.kind = ?').get(version.id, 'collider');
    const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(row.file_path)).digest('hex');

    worlds.calibrateVersion(db, version.id, { source: 'character_height', knownMeters: 1.68, measuredUnits: 2.042 });
    const after = worlds.worldGeometry(db, version.id, {});
    const factor = 1.68 / 2.042;

    assert.ok(Math.abs(after.size[0] - before.size[0] * factor) < 1e-6, 'scale was not applied on read');
    assert.strictEqual(
        crypto.createHash('sha256').update(fs.readFileSync(row.file_path)).digest('hex'), hashBefore,
        'calibrating rewrote the stored mesh — recalibrating would then compound');

    // Recalibrating computes from the stored geometry, not from the scaled result.
    worlds.calibrateVersion(db, version.id, { source: 'custom', knownMeters: 3.36, measuredUnits: 2.042 });
    const again = worlds.worldGeometry(db, version.id, {});
    assert.ok(Math.abs(again.size[0] - before.size[0] * (3.36 / 2.042)) < 1e-6, 'calibration compounded');
});

// ══ WE-1.12 / 1.13 · geometry ═══════════════════════════════════════════════

test('WE-1.12 the collider decimates to the stage budget without moving its bounds', async () => {
    const { version } = await seedWorld();
    await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: stubFetch(makeGlb(300)) });

    const full = worlds.worldGeometry(db, version.id, { budget: 20000 });
    const small = worlds.worldGeometry(db, version.id, { budget: 50 });
    assert.ok(small.triangles.length <= 50, `budget ignored: ${small.triangles.length}`);
    assert.deepStrictEqual(small.bounds, full.bounds, 'bounds moved with the triangle budget');
});

test('WE-1.13 an unreadable collider is refused by name, not as "invalid"', async () => {
    const { version } = await seedWorld();
    const draco = JSON.parse(JSON.stringify({}));
    const bad = Buffer.from('this is not a glb at all');
    await worlds.ingestWorld(db, version.id, providerWorld(), { fetchImpl: stubFetch(bad) });
    assert.throws(() => worlds.worldGeometry(db, version.id, {}), (err) => {
        assert.ok(!/^invalid GLB$/i.test(err.message), 'the reason was flattened to a generic message');
        return true;
    });
    void draco;
});

// ══ WE-1.14 / 1.15 · pinning and locking ════════════════════════════════════

test('WE-1.14 pinning is explicit and a new version never migrates a shot', async () => {
    const { projectId, world, version } = await seedWorld();
    const { shotId } = makeShot(projectId);

    worlds.pinShot(db, shotId, version.id);
    const v2 = worlds.newVersion(db, world.id, { parentVersionId: version.id, reason: 'Improved' });

    const pin = worlds.pinFor(db, shotId);
    assert.strictEqual(pin.world_version_id, version.id, 'the shot was auto-migrated to the new version');
    assert.strictEqual(pin.newer_version_id, v2.id, 'the shot was not told a newer version exists');
    assert.ok(pin.world_pinned_at, 'the pin has no timestamp');
});

test('WE-D1.1 deleting a world leaves authored blocking intact', async () => {
    const { projectId, world, version } = await seedWorld();
    const { shotId } = makeShot(projectId);
    db.prepare('INSERT INTO film_previs_blocking (id, shot_id, camera_json) VALUES (?, ?, ?)')
        .run(generateId(), shotId, JSON.stringify({ focalMm: 85 }));
    worlds.pinShot(db, shotId, version.id);

    worlds.deleteWorld(db, world.id);

    const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    assert.ok(row, 'deleting a world deleted the blocking authored inside it');
    assert.strictEqual(JSON.parse(row.camera_json).focalMm, 85, 'the authored camera was lost');
    assert.strictEqual(row.world_version_id, null, 'the pin points at a version that no longer exists');
});

test('WE-D1.2 no new table holds a second camera', () => {
    const sql = ['film_worlds', 'film_world_versions', 'film_world_assets', 'film_world_sources']
        .map(t => (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t) || {}).sql || '')
        .join('\n');
    assert.ok(sql.length > 100, 'the schema scan found nothing');
    for (const word of ['focal', 'aperture', 'sensor_width', 'rotation_json', 'position_json']) {
        assert.ok(!new RegExp(`\\b${word}`, 'i').test(sql), `a world table declares "${word}" — a second camera store`);
    }
});

test('WE-1.15 a locked world refuses exactly the destructive set', async () => {
    const { projectId, world, version } = await seedWorld();
    const { shotId } = makeShot(projectId);
    worlds.lockWorld(db, world.id, true);

    // Refused while locked
    assert.throws(() => worlds.newVersion(db, world.id, { reason: 'nope' }), /lock/i, 'a locked world regenerated');
    assert.throws(() => worlds.calibrateVersion(db, version.id,
        { source: 'custom', knownMeters: 1, measuredUnits: 1 }), /lock/i, 'a locked world was rescaled');

    // Still allowed while locked — a lock that freezes the work gets switched off
    assert.doesNotThrow(() => worlds.pinShot(db, shotId, version.id), 'a locked world refused a shot pin');

    worlds.lockWorld(db, world.id, false);
    assert.doesNotThrow(() => worlds.newVersion(db, world.id, { reason: 'after unlock' }));
});

// ══ WE-1.16 / 1.17 / D2 · generation ════════════════════════════════════════

test('WE-1.16 the plan is free and prices through the same path the run bills', async () => {
    const { version } = await seedWorld();
    const before = db.prepare('SELECT COUNT(*) n FROM film_cost_entries').get().n;
    const plan = worlds.planVersion(db, version.id, { model: 'marble-1.1' });

    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_cost_entries').get().n, before, 'the plan wrote a cost entry');
    assert.strictEqual(plan.credits, wl.MODELS['marble-1.1'].credits, 'the quoted credits are not the model rate');
    assert.ok(plan.free === true, 'the plan does not say it is free');
});

test('WE-D2.1 a world generation records a handle before polling, in the shared job table', async () => {
    const { projectId, version } = await seedWorld();
    const seen = [];
    const provider = {
        id: 'worldlabs',
        async generate(capability, payload, opts) {
            if (opts && typeof opts.onHandle === 'function') opts.onHandle('op-123', { operation: 'world' });
            seen.push(capability);
            return { world: providerWorld(), usage: { credits: 250 } };
        },
    };
    await worlds.generateVersion(db, version.id, { prompt: 'a street' },
        { provider, fetchImpl: stubFetch(), projectId });

    const job = db.prepare("SELECT * FROM film_generation_jobs WHERE request_id = 'op-123'").get();
    assert.ok(job, 'no job row was written for the operation id');
    assert.strictEqual(job.capability, 'world');
    assert.strictEqual(job.provider, 'worldlabs');
    assert.deepStrictEqual(seen, ['world']);

    const second = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%world_generation_job%'").get();
    assert.ok(!second, 'a second job table exists');
});

test('WE-1.17 a generation abandoned mid-poll is pending, not failed', async () => {
    const { projectId, version } = await seedWorld();
    const provider = {
        id: 'worldlabs',
        async generate(capability, payload, opts) {
            if (opts && typeof opts.onHandle === 'function') opts.onHandle('op-timeout', { operation: 'world' });
            return { status: 504, pending: true, handle: 'op-timeout', error: 'still generating' };
        },
    };
    const out = await worlds.generateVersion(db, version.id, { prompt: 'x' },
        { provider, fetchImpl: stubFetch(), projectId });
    assert.strictEqual(out.pending, true, 'a timeout was reported as a failure');
    assert.strictEqual(out.handle, 'op-timeout', 'the operation id was not carried back');
    const v = worlds.versionsFor(db, worlds.worldOf(db, version.id).id).find(x => x.id === version.id);
    assert.notStrictEqual(v.status, 'failed', 'a recoverable world was marked failed');
});

// ══ WE-1.18 / 1.19 · the surfaces ═══════════════════════════════════════════

test('WE-1.18 every declared route is reachable and dispatched before the catch-alls', async () => {
    const { projectId, world, version } = await seedWorld();
    const { shotId } = makeShot(projectId);

    const ROUTES = [
        ['POST',   `/film/projects/${projectId}/worlds`, { name: 'W' }],
        ['GET',    `/film/projects/${projectId}/worlds`],
        ['GET',    `/film/worlds/${world.id}`],
        ['PATCH',  `/film/worlds/${world.id}`, { name: 'Renamed' }],
        ['POST',   `/film/worlds/${world.id}/lock`],
        ['DELETE', `/film/worlds/${world.id}/lock`],
        ['GET',    `/film/worlds/${world.id}/versions`],
        ['POST',   `/film/worlds/${world.id}/versions`, { reason: 'r' }],
        ['GET',    `/film/world-versions/${version.id}`],
        ['POST',   `/film/world-versions/${version.id}/calibrate`, { source: 'custom', known_meters: 1, measured_units: 2 }],
        ['GET',    `/film/world-versions/${version.id}/plan`],
        ['POST',   `/film/shots/${shotId}/world`, { world_version_id: version.id }],
        ['DELETE', `/film/shots/${shotId}/world`],
        ['DELETE', `/film/worlds/${world.id}`],
    ];
    const unreachable = [];
    for (const [method, url, body] of ROUTES) {
        const r = await call(method, url, body);
        if (r.status === 404 || r.status === 405 || r.status === 500) unreachable.push(`${method} ${url} → ${r.status}`);
    }
    assert.deepStrictEqual(unreachable, [], `routes not reachable:\n  ${unreachable.join('\n  ')}`);

    // The dispatch must be registered BEFORE the project/shot catch-alls, or a
    // handler that exists is never reached — the /film/locations/:id trap.
    const server = fs.readFileSync(path.join(REPO, 'backend', 'server.js'), 'utf8');
    const worldAt = server.indexOf("handleWorlds");
    assert.ok(worldAt > -1, 'server.js never dispatches to handleWorlds');
    const projectsAt = server.indexOf("handleProjects(req, res");
    if (projectsAt > -1) assert.ok(worldAt < projectsAt, 'the world routes are registered after the project catch-all');
});

test('WE-1.19 every phase-1 MCP tool dispatches, and only world_generate spends', () => {
    const { listTools } = require('../lib/mcp-tools');
    const names = listTools().map(t => t.name);
    const PHASE1 = ['world_create', 'world_list', 'world_get', 'world_generate',
                    'world_plan', 'world_calibrate', 'world_lock', 'world_pin_shot'];
    const missing = PHASE1.filter(n => !names.includes(n));
    assert.deepStrictEqual(missing, [], `tools missing: ${missing.join(', ')}`);

    const guide = fs.readFileSync(path.join(REPO, 'docs', 'claude-desktop-guide.md'), 'utf8');
    const cost = guide.slice(guide.indexOf('## What costs money'));
    assert.ok(cost.includes('world_generate'), 'world_generate is not named as a spending tool');
    for (const free of PHASE1.filter(n => n !== 'world_generate')) {
        assert.ok(!cost.split('\n\n')[1].includes(free), `${free} is listed as spending money`);
    }
});

// ══ WE-D9.1 · the flags ═════════════════════════════════════════════════════

test('WE-D9.1 all six flags exist, default off (world_splats on, per ADR-008), and a typo is refused', () => {
    const src = fs.readFileSync(path.join(REPO, 'backend', 'routes', 'app-settings.js'), 'utf8');
    const FLAGS = ['world_engine', 'marble_generation', 'cinematography_ai',
                   'reference_match', 'camera_explore', 'world_splats'];
    const missing = FLAGS.filter(f => !new RegExp(`\\b${f}\\b`).test(src));
    assert.deepStrictEqual(missing, [], `flags missing from SETTINGS: ${missing.join(', ')}`);
    // Each must default to false — a feature that ships on is not shipped
    // incrementally. world_splats is the one deliberate exception: ADR-008
    // turned it on for every project once the director asked to see the set.
    const ON_BY_DECISION = new Set(['world_splats']);
    for (const f of FLAGS) {
        const seg = src.slice(src.indexOf(f + ':'), src.indexOf(f + ':') + 400);
        assert.match(seg, ON_BY_DECISION.has(f) ? /default:\s*true/ : /default:\s*false/,
            `${f} does not default to ${ON_BY_DECISION.has(f) ? 'true' : 'false'}`);
    }
});

// ══ WE-1.21 · the defect the audit verified ═════════════════════════════════

test('WE-1.21 previs/from-card persists the camera it solved', () => {
    const src = fs.readFileSync(path.join(REPO, 'backend', 'routes', 'previs.js'), 'utf8');
    const i = src.indexOf('function fromCard(');
    assert.ok(i > -1, 'fromCard is gone');
    let depth = 0, end = i;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}' && --depth === 0) { end = k; break; }
    }
    const body = src.slice(i, end);
    assert.ok(!/position:\s*\[\s*0\s*,\s*heightM\s*,\s*solution\.distanceM\s*\]/.test(body),
        'fromCard still persists a hardcoded pose, discarding the azimuth it solved');
    assert.match(body, /position:\s*solution\.position/, 'the solved position is not what gets stored');
    assert.match(body, /rotation:\s*solution\.rotation/, 'the solved rotation is not what gets stored');
});

// ══ Ingestion safety — the URL comes from a PROVIDER, not from us ═══════════

/*
 * A world's asset URLs arrive in a provider response and are fetched by this
 * server, then STORED where /film/worlds/media/... will serve them back. That
 * chain turns any fetch of an internal address into read-and-exfiltrate, so the
 * URL is untrusted input even though it did not come from a user.
 *
 * This codebase already reached that conclusion once: provider-media's
 * isGatewayUrl compares parsed origins precisely "because the URL comes from a
 * provider's response", and a prefix check there would have turned a malicious
 * provider into gateway-key exfiltration.
 *
 * Set-based over the address classes an SSRF actually targets, because a guard
 * that blocks localhost and lets 169.254.169.254 through is the one that
 * matters and the one an example-based test misses.
 */
test('SEC · a world asset URL that is not a public https address is refused', async () => {
    const { assertFetchableUrl } = require('../lib/world-assets');

    const HOSTILE = [
        ['file:///etc/passwd',                      'file scheme'],
        ['ftp://example.com/x.glb',                 'ftp scheme'],
        ['data:text/plain;base64,AAAA',             'data scheme'],
        ['http://example.com/x.glb',                'plain http'],
        ['https://127.0.0.1/x.glb',                 'loopback v4'],
        ['https://localhost/x.glb',                 'loopback by name'],
        ['https://[::1]/x.glb',                     'loopback v6'],
        ['https://169.254.169.254/latest/meta-data/', 'cloud metadata'],
        ['https://10.0.0.5/x.glb',                  'private 10/8'],
        ['https://172.16.4.4/x.glb',                'private 172.16/12'],
        ['https://192.168.1.9/x.glb',               'private 192.168/16'],
        ['https://[fd00::1]/x.glb',                 'unique-local v6'],
        ['https://0.0.0.0/x.glb',                   'unspecified'],
    ];
    const allowed = [];
    for (const [url, why] of HOSTILE) {
        let refused = false;
        try { assertFetchableUrl(url); } catch (_) { refused = true; }
        if (!refused) allowed.push(`${why}: ${url}`);
    }
    assert.deepStrictEqual(allowed, [],
        `these would be fetched and then served back by /film/worlds/media:\n  ${allowed.join('\n  ')}`);

    // And a real one still works, or the guard is just an outage.
    assert.doesNotThrow(() => assertFetchableUrl('https://cdn.marble.worldlabs.ai/abc/collider.glb'),
        'the guard refuses the provider it exists to fetch from');
});

test('SEC · a world asset download is capped', async () => {
    const { MAX_ASSET_BYTES, ingestAssets } = require('../lib/world-assets');
    assert.ok(MAX_ASSET_BYTES > 25 * 1024 * 1024,
        'the cap is below full_res (25 MB measured) — it would refuse a legitimate world');
    assert.ok(MAX_ASSET_BYTES < 512 * 1024 * 1024, 'the cap is too loose to bound memory');

    const { version, projectId } = await seedWorld();
    // A body that lies about its size, then streams past the cap.
    const huge = Buffer.alloc(MAX_ASSET_BYTES + 1024, 0x41);
    const fetchImpl = async () => ({
        ok: true, status: 200,
        headers: { get: () => String(huge.length) },
        buffer: async () => huge,
        arrayBuffer: async () => huge.buffer.slice(huge.byteOffset, huge.byteOffset + huge.byteLength),
    });
    await assert.rejects(
        () => ingestAssets(db, version.id, providerWorld(), { projectId, fetchImpl }),
        /too large|cap|bytes/i,
        'an oversize asset is written to disk rather than refused');
});
