/** Persistent, non-generative media imports used by Storyboard and Previs. */

const fs = require('fs');
const path = require('path');
const { db, generateId } = require('../db/database');
const { saveFile, getFileUrl } = require('./file-storage');
const { parseGlb } = require('./glb-parser');

const MEDIA_IMPORTS = Object.freeze({
    'storyboard-image': Object.freeze({ kind: 'image', shotScoped: true, subdir: 'storyboards', mimes: ['image/png'] }),
    // reference_image is already catalogued and served from refsheets by Previs.
    'previs-image': Object.freeze({ kind: 'image', shotScoped: true, subdir: 'refsheets', mimes: ['image/png'] }),
    // Previs's geometry parser and textured viewer both consume GLB. Advertising
    // formats they cannot stage would turn a successful upload into a broken picker.
    'three-d-model': Object.freeze({ kind: 'model', shotScoped: false, subdir: '3d', mimes: ['model/gltf-binary', 'application/octet-stream'] }),
});

function decodeDataUri(data) {
    const match = String(data || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) throw new Error('invalid import data: expected a base64 data URI');
    return { mime: match[1].toLowerCase(), bytes: Buffer.from(match[2].replace(/\s/g, ''), 'base64') };
}

function validateBytes(spec, mime, bytes) {
    if (!spec.mimes.includes(mime)) throw new Error(`unsupported import type ${mime}`);
    if (!bytes.length) throw new Error('invalid import: empty file');
    if (spec.kind === 'image' && !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        throw new Error('invalid PNG signature');
    }
    if (spec.kind === 'image') {
        let offset = 8, sawIhdr = false, sawIdat = false, sawIend = false;
        while (offset + 12 <= bytes.length) {
            const length = bytes.readUInt32BE(offset);
            const end = offset + 12 + length;
            if (end > bytes.length) throw new Error('invalid PNG chunk length');
            const type = bytes.toString('ascii', offset + 4, offset + 8);
            if (type === 'IHDR') {
                if (sawIhdr || length !== 13) throw new Error('invalid PNG header');
                const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
                if (!width || !height || width * height > 100_000_000) throw new Error('invalid PNG dimensions');
                sawIhdr = true;
            } else if (type === 'IDAT') sawIdat = true;
            else if (type === 'IEND') { sawIend = length === 0; offset = end; break; }
            offset = end;
        }
        if (!sawIhdr || !sawIdat || !sawIend || offset !== bytes.length) throw new Error('invalid or incomplete PNG');
    }
    if (spec.kind === 'model') {
        if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2
            || bytes.readUInt32LE(8) !== bytes.length) throw new Error('invalid GLB signature or length');
        // Validate with the same parser Previs uses. A header-only GLB or a
        // scene without drawable triangles is an upload that succeeds and a
        // stage object that can never render.
        let geometry;
        try { geometry = parseGlb(bytes); }
        catch (err) {
            /*
             * The parser's reason, kept and made actionable.
             *
             * "invalid GLB" alone is why two imports read as a broken importer:
             * the file was refused for a nameable reason (compression, an
             * external .bin, an extension) and the user was told only that it
             * did not work, on a status bar at the bottom of the screen.
             */
            throw new Error(`This GLB could not be read — ${String(err.message).replace(/^glb:\s*/, '')}.`);
        }
        if (!geometry.vertices.length || !geometry.triangles.length) {
            throw new Error('This GLB has no drawable triangle geometry — it may be a points or lines '
                + 'export, or contain only cameras and lights. Re-export it as a triangle mesh.');
        }
    }
}

function ownerFor(target, input) {
    if (MEDIA_IMPORTS[target].shotScoped) {
        const row = db.prepare(`SELECT sh.id AS shot_id, sh.shot_code, sc.project_id
            FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id WHERE sh.id = ?`).get(input.shotId);
        if (!row) throw new Error('Shot not found');
        return { projectId: row.project_id, shotId: row.shot_id, shotCode: row.shot_code };
    }
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(input.projectId);
    if (!project) throw new Error('Project not found');
    return { projectId: project.id, shotId: null, shotCode: null };
}

function archiveCurrentStoryboard(projectId, shotId, shotCode, currentPath) {
    if (!fs.existsSync(currentPath)) return;
    const latest = db.prepare("SELECT id, version FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard' ORDER BY version DESC LIMIT 1")
        .get(shotId);
    if (!latest) return;
    const dir = path.join(path.dirname(currentPath), 'versions');
    fs.mkdirSync(dir, { recursive: true });
    const archived = path.join(dir, `${shotCode}_v${latest.version}.png`);
    fs.copyFileSync(currentPath, archived);
    db.prepare('UPDATE film_assets SET file_path = ?, file_name = ? WHERE id = ?')
        .run(archived, path.basename(archived), latest.id);
}

function safeStem(name) {
    return path.basename(String(name || 'import'), path.extname(String(name || '')))
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'import';
}

function importMedia(target, input) {
    const spec = MEDIA_IMPORTS[target];
    if (!spec) throw new Error(`unsupported import target ${target}`);
    const owner = ownerFor(target, input || {});
    const { mime, bytes } = decodeDataUri(input && input.data);
    validateBytes(spec, mime, bytes);

    let filename;
    if (target === 'storyboard-image') filename = `${owner.shotCode}.png`;
    else filename = `${safeStem(input.name)}_${generateId().slice(0, 8)}.${spec.kind === 'model' ? 'glb' : 'png'}`;

    const prospective = path.join(require('./file-storage').DATA_DIR, spec.subdir, owner.projectId, filename);
    if (target === 'storyboard-image') archiveCurrentStoryboard(owner.projectId, owner.shotId, owner.shotCode, prospective);
    const filePath = saveFile(owner.projectId, spec.subdir, filename, bytes);

    const prior = target === 'storyboard-image'
        ? db.prepare("SELECT MAX(version) AS version FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'").get(owner.shotId)
        : null;
    const version = prior && prior.version ? prior.version + 1 : 1;
    const assetId = generateId();
    const assetType = target === 'storyboard-image' ? 'storyboard'
        : target === 'previs-image' ? 'reference_image' : 'other';
    const metadata = target === 'three-d-model'
        ? { kind: 'model_3d', subject_kind: 'imported', subject_name: safeStem(input.name), imported: true }
        : { kind: target === 'previs-image' ? 'previs_image' : 'storyboard_import', imported: true };
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, size_bytes, version, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(assetId, owner.projectId, owner.shotId, assetType, filePath, filename,
            spec.kind === 'model' ? 'glb' : 'png', mime, bytes.length, version, JSON.stringify(metadata));

    if (target === 'storyboard-image') {
        db.prepare('UPDATE film_shots SET current_frame_version = NULL WHERE id = ?').run(owner.shotId);
    }
    return {
        target, asset_id: assetId, project_id: owner.projectId, shot_id: owner.shotId,
        file_name: filename, file_path: filePath, version,
        url: getFileUrl(spec.subdir, owner.projectId, filename),
    };
}

module.exports = { MEDIA_IMPORTS, importMedia, decodeDataUri, validateBytes };
