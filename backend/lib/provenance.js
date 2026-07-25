const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./file-storage');

const DISCLOSURE_TEXT = 'This project contains AI-generated synthetic image, audio, video, and/or text assets. Film Engine records provider, model, prompt, seed, render ledger, asset, and rights metadata in this sidecar manifest. This manifest is not a C2PA-signed Content Credential and does not provide trust-list signing or certificate-backed authenticity.';

function parseJSON(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function hashObject(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function projectExists(db, projectId) {
    return db.prepare('SELECT id, title, genre, status, created_at, updated_at FROM film_projects WHERE id = ?').get(projectId);
}

function listRows(db, table, filter, projectId) {
    try {
        return db.prepare(`SELECT * FROM ${table} WHERE ${filter}`).all(projectId);
    } catch (_) {
        return [];
    }
}

function buildProjectManifest(db, projectId) {
    const project = projectExists(db, projectId);
    if (!project) return null;

    const assets = listRows(db, 'film_assets', 'project_id = ?', projectId).map(asset => ({
        ...asset,
        metadata: parseJSON(asset.metadata, {}),
        input_refs: parseJSON(asset.input_refs, []),
    }));
    const renderLedger = listRows(
        db,
        'render_ledger',
        'shot_id IN (SELECT id FROM film_shots WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?))',
        projectId
    ).map(row => ({
        ...row,
        lora_ids: parseJSON(row.lora_ids, []),
        controlnets: parseJSON(row.controlnets, []),
        camera_params: parseJSON(row.camera_params, {}),
        lighting_params: parseJSON(row.lighting_params, {}),
        extra_params: parseJSON(row.extra_params, {}),
    }));
    const rights = listRows(db, 'film_rights', 'project_id = ?', projectId);

    const manifest = {
        format: 'film-engine-ai-provenance-sidecar',
        version: 1,
        generated_at: new Date().toISOString(),
        disclosure: DISCLOSURE_TEXT,
        c2pa: {
            status: 'not_signed',
            note: 'Sidecar disclosure only; no C2PA certificate signing or trust-list conformance is performed.',
        },
        project,
        counts: {
            assets: assets.length,
            render_ledger_entries: renderLedger.length,
            rights_records: rights.length,
        },
        assets,
        render_ledger: renderLedger,
        rights,
    };
    manifest.sha256 = hashObject({ ...manifest, sha256: undefined });
    return manifest;
}

function buildAssetManifest(db, assetId) {
    const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId);
    if (!asset) return null;
    const project = projectExists(db, asset.project_id);
    const ledgerRows = asset.shot_id
        ? db.prepare('SELECT * FROM render_ledger WHERE shot_id = ? ORDER BY created_at DESC').all(asset.shot_id)
        : [];
    let rights = [];
    try {
        rights = db.prepare(
            'SELECT * FROM film_rights WHERE project_id = ? AND (entity_id = ? OR entity_id = ? OR entity_id = \'\')'
        ).all(asset.project_id, asset.id, asset.shot_id || '');
    } catch (_) {
        rights = [];
    }

    const manifest = {
        format: 'film-engine-ai-provenance-sidecar',
        version: 1,
        generated_at: new Date().toISOString(),
        disclosure: DISCLOSURE_TEXT,
        c2pa: {
            status: 'not_signed',
            note: 'Sidecar disclosure only; no C2PA certificate signing or trust-list conformance is performed.',
        },
        project,
        asset: {
            ...asset,
            metadata: parseJSON(asset.metadata, {}),
            input_refs: parseJSON(asset.input_refs, []),
        },
        render_ledger: ledgerRows,
        rights,
    };
    manifest.sha256 = hashObject({ ...manifest, sha256: undefined });
    return manifest;
}

function writeProjectSidecar(db, projectId) {
    const manifest = buildProjectManifest(db, projectId);
    if (!manifest) return null;

    const dir = path.join(DATA_DIR, 'provenance', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `project-provenance-${Date.now()}.json`;
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, JSON.stringify(manifest, null, 2));

    return {
        manifest,
        sidecar_path: fullPath,
        relative_path: path.join('provenance', projectId, filename),
    };
}

module.exports = {
    DISCLOSURE_TEXT,
    buildProjectManifest,
    buildAssetManifest,
    writeProjectSidecar,
};
