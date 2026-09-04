/**
 * What a generated world ships, and which parts of it we keep.
 *
 * A Marble world exposes six things, measured from the real payload of world
 * 06be9e1f on 2026-09-04:
 *
 *   collider   1.4 MB GLB   the geometry every cinematographic number needs
 *   panorama   3.3 MB PNG   equirectangular 2304x1152, exactly 2:1
 *   thumbnail  small        for a card
 *   splat 100k 1.17 MB      \
 *   splat 500k 5.50 MB       >  the visual skin, in three LOD tiers
 *   splat full 25.00 MB     /
 *
 * THREE ARE COPIED AND THREE ARE RECORDED, and the split is not about size.
 *
 * `GET /marble/v1/worlds` is a 404 — the provider publishes no list endpoint —
 * so a world whose row we lose is unreachable and unfindable, a paid asset with
 * no path back. Anything we depend on to render or measure is therefore pulled
 * onto our own disk. The splats are recorded by URL because nothing can display
 * them until WORLD_SPLATS is switched on, and fetching 25 MB per world for a
 * renderer that does not exist is the definition of waste.
 *
 * The asset_type is 'other' with the real kind in metadata, following the 3D
 * pipeline: film_assets.asset_type carries a CHECK that could not be widened in
 * place, and a value it refuses turns a successful, paid generation into a
 * failed step at the insert.
 */

const path = require('path');
const { saveFile, getFilePath } = require('./file-storage');

const SUBDIR = 'worlds';

/** Every kind a world can ship. The vocabulary the CHECK enforces. */
const WORLD_ASSET_KINDS = Object.freeze([
    'collider', 'panorama', 'thumbnail', 'splat_100k', 'splat_500k', 'splat_full',
]);

/** The kinds pulled onto our own disk, because we render or measure from them. */
const COPIED_KINDS = Object.freeze(['collider', 'panorama', 'thumbnail']);

/** Where each kind's URL lives on the provider's world object. */
const SOURCE_OF = Object.freeze({
    collider:   w => w.collider_mesh_url,
    panorama:   w => w.panorama_url,
    thumbnail:  w => w.thumbnail_url,
    splat_100k: w => (w.splat_urls || {})['100k'],
    splat_500k: w => (w.splat_urls || {})['500k'],
    splat_full: w => (w.splat_urls || {}).full_res,
});

const EXT = Object.freeze({
    collider: '.glb', panorama: '.png', thumbnail: '.png',
    splat_100k: '.spz', splat_500k: '.spz', splat_full: '.spz',
});

const MIME = Object.freeze({
    '.glb': 'model/gltf-binary', '.png': 'image/png', '.spz': 'application/octet-stream',
});

function fileNameFor(versionId, kind) {
    return `${versionId}_${kind}${EXT[kind] || ''}`;
}

function assetPath(projectId, versionId, kind) {
    return getFilePath(projectId, SUBDIR, fileNameFor(versionId, kind));
}

function servedUrlFor(projectId, versionId, kind) {
    return `/film/worlds/media/${projectId}/${fileNameFor(versionId, kind)}`;
}

/** Node's fetch, wrapped so a test can hand in its own without a network. */
async function defaultFetch(url) {
    const res = await fetch(url);
    if (!res || !res.ok) throw new Error(`world asset fetch failed: ${res && res.status} ${url}`);
    return res;
}

async function bodyOf(res) {
    if (typeof res.buffer === 'function') return Buffer.from(await res.buffer());
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Store one world's assets against a version, replacing whatever was there.
 *
 * @param {object} db
 * @param {string} versionId
 * @param {object} world          the provider's world object
 * @param {object} opts           { projectId, fetchImpl, includeSplats }
 * @returns {Promise<Array>}      one record per kind actually present
 */
async function ingestAssets(db, versionId, world, opts) {
    const o = opts || {};
    const projectId = o.projectId;
    const fetchImpl = o.fetchImpl || defaultFetch;
    const includeSplats = o.includeSplats === true;
    const { generateId } = require('../db/database');
    const out = [];

    for (const kind of WORLD_ASSET_KINDS) {
        const url = SOURCE_OF[kind](world || {});
        // A draft world returns collider only; hq and full_res come back null.
        // An absent asset is an absent ROW, never a row pointing at nothing.
        if (!url) continue;

        const copy = COPIED_KINDS.includes(kind) || (includeSplats && kind.startsWith('splat_'));
        let assetId = null, bytes = null;

        if (copy) {
            const buf = await bodyOf(await fetchImpl(url));
            const fileName = fileNameFor(versionId, kind);
            const filePath = saveFile(projectId, SUBDIR, fileName, buf);
            bytes = buf.length;
            assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name,
                                          format, mime_type, size_bytes, version, metadata)
                 VALUES (?, ?, 'other', ?, ?, ?, ?, ?, 1, ?)`
            ).run(assetId, projectId, filePath, fileName,
                (EXT[kind] || '').replace('.', ''), MIME[EXT[kind]] || 'application/octet-stream',
                bytes, JSON.stringify({ kind: `world_${kind}`, world_version_id: versionId }));
        }

        // Replace, never accumulate: the six-rows-for-three-files bug.
        db.prepare('DELETE FROM film_world_assets WHERE world_version_id = ? AND kind = ?').run(versionId, kind);
        const id = generateId();
        db.prepare(
            `INSERT INTO film_world_assets (id, world_version_id, kind, remote_url, asset_id, bytes, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, versionId, kind, url, assetId, bytes, '{}');
        out.push({ id, kind, remote_url: url, asset_id: assetId, bytes });
    }
    return out;
}

/** The bytes of one copied asset, or null when it was recorded by URL only. */
function localBytes(db, versionId, kind) {
    const row = db.prepare(
        `SELECT a.file_path FROM film_world_assets w
         JOIN film_assets a ON a.id = w.asset_id
         WHERE w.world_version_id = ? AND w.kind = ?`).get(versionId, kind);
    if (!row || !row.file_path) return null;
    return require('fs').readFileSync(row.file_path);
}

module.exports = {
    WORLD_ASSET_KINDS, COPIED_KINDS, SOURCE_OF, SUBDIR,
    ingestAssets, localBytes, assetPath, servedUrlFor, fileNameFor,
};
