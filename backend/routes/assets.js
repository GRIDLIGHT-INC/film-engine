/**
 * Asset registry & music cues
 * POST/GET /film/projects/:id/assets
 * GET/DELETE /film/assets/:id
 * POST/GET /film/projects/:id/music-cues
 * POST/GET /film/projects/:id/color-presets
 */
const { db, generateId } = require('../db/database');
const { buildProjectManifest, buildAssetManifest, writeProjectSidecar, DISCLOSURE_TEXT } = require('../lib/provenance');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ASSET_TYPES = [
    'keyframe', 'storyboard', 'video_raw', 'video_synced',
    'video_final', 'audio_dialogue', 'audio_music', 'audio_sfx',
    'audio_ambient', 'audio_mix', 'thumbnail', 'reference_image',
    'character_sheet', 'lora_weights', 'voice_sample',
    'subtitle', 'export_package', 'fcpxml', 'edl', 'premiere_xml',
    'lut', 'other'
];

const VALID_CUE_TYPES = ['score', 'source', 'sfx', 'ambient', 'transition'];
const RIGHT_ORIGINS = require('../lib/music-rights').ORIGINS;
const VALID_PRESET_TYPES = ['lut', 'film_grain', 'color_grade', 'look', 'composite'];

function handleAssets(req, res, urlParts, query) {
    // /film/projects/:id/assets
    if (urlParts[1] === 'projects' && urlParts[3] === 'assets') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listAssets(req, res, projectId, query);
        if (req.method === 'POST') return registerAsset(req, res, projectId);
    }

    // /film/assets/:id
    if (urlParts[1] === 'assets' && urlParts[2] && !urlParts[3]) {
        const assetId = urlParts[2];
        if (!UUID_RE.test(assetId)) return badReq(res, 'Invalid asset ID');
        if (req.method === 'GET') return getAsset(req, res, assetId);
        if (req.method === 'DELETE') return deleteAsset(req, res, assetId);
    }

    // /film/projects/:id/music-cues
    if (urlParts[1] === 'projects' && urlParts[3] === 'music-cues') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listMusicCues(req, res, projectId, query);
        if (req.method === 'POST') return createMusicCue(req, res, projectId);
    }

    // /film/projects/:id/music-rights
    if (urlParts[1] === 'projects' && urlParts[3] === 'music-rights' && req.method === 'GET') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        return getMusicRightsSummary(req, res, projectId);
    }

    // /film/projects/:id/rights
    if (urlParts[1] === 'projects' && urlParts[3] === 'rights') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listRights(req, res, projectId, query);
        if (req.method === 'POST') return createRight(req, res, projectId);
    }

    // /film/rights/:id
    if (urlParts[1] === 'rights' && urlParts[2]) {
        const rightId = urlParts[2];
        if (!UUID_RE.test(rightId)) return badReq(res, 'Invalid rights ID');
        if (req.method === 'PUT') return updateRight(req, res, rightId);
        if (req.method === 'DELETE') return deleteRight(req, res, rightId);
    }

    // /film/projects/:id/provenance[/export]
    if (urlParts[1] === 'projects' && urlParts[3] === 'provenance') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (!urlParts[4] && req.method === 'GET') return getProjectProvenance(req, res, projectId);
        if (urlParts[4] === 'export' && req.method === 'POST') return exportProjectProvenance(req, res, projectId);
    }

    // /film/assets/:id/provenance
    if (urlParts[1] === 'assets' && urlParts[2] && urlParts[3] === 'provenance' && req.method === 'GET') {
        const assetId = urlParts[2];
        if (!UUID_RE.test(assetId)) return badReq(res, 'Invalid asset ID');
        return getAssetProvenance(req, res, assetId);
    }

    /*
     * /film/music-cues/:id — change or remove a cue.
     *
     * Only POST and GET existed, so a cue's DIRECTION could be written once
     * and never revised — and an agent could generate music while being unable
     * to write the brief for it, which is the wrong way round when the
     * connected model is the writer.
     */
    if (urlParts[1] === 'music-cues' && urlParts[2] && !urlParts[3]) {
        if (req.method === 'PUT') return updateMusicCue(req, res, urlParts[2]);
        if (req.method === 'DELETE') return deleteMusicCue(res, urlParts[2]);
    }

    // /film/music-cues/:id/rights — update license fields
    if (urlParts[1] === 'music-cues' && urlParts[2] && urlParts[3] === 'rights' && req.method === 'PUT') {
        const cueId = urlParts[2];
        if (!UUID_RE.test(cueId)) return badReq(res, 'Invalid cue ID');
        return updateMusicRights(req, res, cueId);
    }

    // /film/projects/:id/color-presets
    if (urlParts[1] === 'projects' && urlParts[3] === 'color-presets') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listColorPresets(req, res, projectId);
        if (req.method === 'POST') return createColorPreset(req, res, projectId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function requireProject(res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        json(res, 404, { error: 'Project not found' });
        return null;
    }
    return project;
}

// --- Assets ---

function listAssets(req, res, projectId, query) {
    let sql = 'SELECT * FROM film_assets WHERE project_id = ?';
    const params = [projectId];

    if (query.type && VALID_ASSET_TYPES.includes(query.type)) {
        sql += ' AND asset_type = ?';
        params.push(query.type);
    }
    if (query.shot_id && UUID_RE.test(query.shot_id)) {
        sql += ' AND shot_id = ?';
        params.push(query.shot_id);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = db.prepare(sql).all(...params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ assets: rows, count: rows.length }));
}

function getAsset(req, res, assetId) {
    const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId);
    if (!asset) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(asset));
}

function registerAsset(req, res, projectId) {
    const body = req.body;
    if (!body.asset_type || !VALID_ASSET_TYPES.includes(body.asset_type)) {
        return badReq(res, `asset_type is required. Valid: ${VALID_ASSET_TYPES.join(', ')}`);
    }
    if (!body.file_path) return badReq(res, 'file_path is required');

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_assets (id, project_id, shot_id, character_id, location_id,
            asset_type, file_path, file_name, format, mime_type,
            size_bytes, duration_ms, width, height, metadata, version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.shot_id && UUID_RE.test(body.shot_id) ? body.shot_id : null,
        body.character_id && UUID_RE.test(body.character_id) ? body.character_id : null,
        body.location_id && UUID_RE.test(body.location_id) ? body.location_id : null,
        body.asset_type,
        body.file_path,
        (body.file_name || '').slice(0, 500),
        (body.format || '').slice(0, 50),
        (body.mime_type || '').slice(0, 100),
        body.size_bytes || 0,
        body.duration_ms || 0,
        body.width || 0,
        body.height || 0,
        JSON.stringify(body.metadata || {}),
        body.version || 1,
        now
    );

    const row = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function deleteAsset(req, res, assetId) {
    const result = db.prepare('DELETE FROM film_assets WHERE id = ?').run(assetId);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

// --- Music Cues ---

function listMusicCues(req, res, projectId, query) {
    let sql = 'SELECT * FROM film_music_cues WHERE project_id = ?';
    const params = [projectId];

    if (query.scene_id && UUID_RE.test(query.scene_id)) {
        sql += ' AND scene_id = ?';
        params.push(query.scene_id);
    }
    if (query.cue_type && VALID_CUE_TYPES.includes(query.cue_type)) {
        sql += ' AND cue_type = ?';
        params.push(query.cue_type);
    }

    sql += ' ORDER BY start_ms';

    const rows = db.prepare(sql).all(...params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ music_cues: rows, count: rows.length }));
}

/**
 * Sections as the generator will accept them, or a refusal.
 *
 * The provider's limits are hard — 3s to 120s a section, and the whole cue
 * capped — and each one is otherwise a paid request that fails. Checked at the
 * write, where it is free and where the director is looking at what they typed,
 * rather than at generation time in front of a failed job.
 */
function normalizeCueSections(input) {
    if (input === undefined || input === null || input === '') return [];
    const { validateSections } = require('../lib/music-sections');
    const checked = validateSections(Array.isArray(input) ? input : []);
    if (!checked.valid) {
        const err = new Error('These sections cannot be generated as written');
        err.errors = checked.errors;
        throw err;
    }
    return checked.sections;
}

function createMusicCue(req, res, projectId) {
    const body = req.body;
    const cueType = VALID_CUE_TYPES.includes(body.cue_type) ? body.cue_type : 'score';
    try { normalizeCueSections(body.sections); }
    catch (err) { return json(res, 400, { error: err.message, errors: err.errors || [] }); }

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_music_cues (id, project_id, scene_id, shot_id, cue_type,
            title, description, mood, genre, tempo_bpm, key_signature,
            instruments, reference_track, start_ms, duration_ms,
            volume_db, fade_in_ms, fade_out_ms, notes, negative_prompt, sections_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.scene_id && UUID_RE.test(body.scene_id) ? body.scene_id : null,
        body.shot_id && UUID_RE.test(body.shot_id) ? body.shot_id : null,
        cueType,
        (body.title || '').slice(0, 200),
        (body.description || '').slice(0, 2000),
        (body.mood || '').slice(0, 100),
        (body.genre || '').slice(0, 100),
        body.tempo_bpm || 0,
        (body.key_signature || '').slice(0, 20),
        JSON.stringify(body.instruments || []),
        (body.reference_track || '').slice(0, 500),
        body.start_ms || 0,
        body.duration_ms || 0,
        body.volume_db || 0.0,
        body.fade_in_ms || 0,
        body.fade_out_ms || 0,
        (body.notes || '').slice(0, 2000),
        (body.negative_prompt || '').slice(0, 1000),
        JSON.stringify(normalizeCueSections(body.sections)),
        now
    );

    const row = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

// --- Music Rights ---

const VALID_LICENSE_STATUSES = ['unknown', 'pending', 'licensed', 'expired', 'rejected', 'public_domain', 'original'];
const VALID_LICENSE_TYPES = ['sync', 'master', 'blanket', 'creative_commons', 'public_domain', 'original', 'work_for_hire'];

function getMusicRightsSummary(req, res, projectId) {
    const cues = db.prepare(
        'SELECT * FROM film_music_cues WHERE project_id = ? ORDER BY title'
    ).all(projectId);

    const byStatus = {};
    let totalCost = 0;
    for (const cue of cues) {
        const status = cue.license_status || 'unknown';
        byStatus[status] = (byStatus[status] || 0) + 1;
        totalCost += cue.license_cost || 0;
    }

    const needsAttention = cues.filter(c =>
        !c.license_status || c.license_status === 'unknown' || c.license_status === 'pending'
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        total_cues: cues.length,
        by_status: byStatus,
        total_license_cost: totalCost,
        needs_attention: needsAttention,
        cues,
        /*
         * The validator's OWN vocabulary, served rather than left for a page to
         * retype — the rule `GET /film/card-vocabulary` already sets. An editor
         * built from a typed-out list works exactly once: until somebody adds a
         * status, at which point the page offers values the route refuses and
         * the refusal reads as a bug in saving.
         */
        vocabulary: { license_status: VALID_LICENSE_STATUSES, license_type: VALID_LICENSE_TYPES },
    }));
}

function updateMusicRights(req, res, cueId) {
    const body = req.body;
    const fields = [];
    const values = [];

    if (body.license_status !== undefined) {
        if (!VALID_LICENSE_STATUSES.includes(body.license_status)) {
            return badReq(res, `Invalid license_status. Valid: ${VALID_LICENSE_STATUSES.join(', ')}`);
        }
        fields.push('license_status = ?');
        values.push(body.license_status);
    }
    if (body.license_type !== undefined) {
        if (body.license_type && !VALID_LICENSE_TYPES.includes(body.license_type)) {
            return badReq(res, `Invalid license_type. Valid: ${VALID_LICENSE_TYPES.join(', ')}`);
        }
        fields.push('license_type = ?');
        values.push(body.license_type);
    }
    if (body.license_holder !== undefined) {
        fields.push('license_holder = ?');
        values.push((body.license_holder || '').slice(0, 500));
    }
    if (body.license_cost !== undefined) {
        fields.push('license_cost = ?');
        values.push(Number(body.license_cost) || 0);
    }
    if (body.license_expiry !== undefined) {
        fields.push('license_expiry = ?');
        values.push((body.license_expiry || '').slice(0, 50));
    }
    if (body.license_territory !== undefined) {
        fields.push('license_territory = ?');
        values.push((body.license_territory || '').slice(0, 200));
    }

    if (fields.length === 0) {
        return badReq(res, 'No valid license fields to update');
    }

    values.push(cueId);
    const result = db.prepare(
        `UPDATE film_music_cues SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Music cue not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(cueId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

// --- General Rights Register ---

const VALID_RIGHT_ENTITY_TYPES = ['character', 'voice', 'model', 'source', 'music', 'asset', 'output', 'dataset', 'other'];
const VALID_RIGHT_TYPES = ['commercial_use', 'likeness', 'voice_clone', 'model_license', 'music_license', 'dataset_license', 'release', 'other'];
const VALID_RIGHT_STATUSES = ['unknown', 'cleared', 'restricted', 'expired', 'blocked'];

function listRights(req, res, projectId, query) {
    if (!requireProject(res, projectId)) return;
    const params = [projectId];
    let sql = 'SELECT * FROM film_rights WHERE project_id = ?';
    if (query.entity_type && VALID_RIGHT_ENTITY_TYPES.includes(query.entity_type)) {
        sql += ' AND entity_type = ?';
        params.push(query.entity_type);
    }
    if (query.status && VALID_RIGHT_STATUSES.includes(query.status)) {
        sql += ' AND status = ?';
        params.push(query.status);
    }
    sql += ' ORDER BY CASE status WHEN \'blocked\' THEN 0 WHEN \'restricted\' THEN 1 WHEN \'expired\' THEN 2 WHEN \'unknown\' THEN 3 ELSE 4 END, updated_at DESC';

    const rights = db.prepare(sql).all(...params);
    const by_status = {};
    for (const row of rights) by_status[row.status] = (by_status[row.status] || 0) + 1;
    json(res, 200, {
        project_id: projectId,
        total: rights.length,
        by_status,
        needs_attention: rights.filter(row => row.status !== 'cleared'),
        /*
         * The validator's own vocabulary, served rather than retyped — the same
         * rule the card vocabulary and the licence statuses follow. createRight
         * silently COERCES an unknown value to a default rather than refusing,
         * so a page holding its own copy stores something the author did not
         * choose and says nothing about it.
         */
        vocabulary: {
            rights_type: VALID_RIGHT_TYPES,
            status: VALID_RIGHT_STATUSES,
            entity_type: VALID_RIGHT_ENTITY_TYPES,
            origin: RIGHT_ORIGINS,
        },
        rights,
    });
}

function createRight(req, res, projectId) {
    if (!requireProject(res, projectId)) return;
    const body = req.body || {};
    if (!body.subject || !String(body.subject).trim()) return badReq(res, 'subject is required');

    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO film_rights (
            id, project_id, entity_type, entity_id, subject, rights_type, status,
            owner, source, license_url, consent_reference, territory, expires_on,
            restrictions, notes, created_at, updated_at, origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        projectId,
        VALID_RIGHT_ENTITY_TYPES.includes(body.entity_type) ? body.entity_type : 'asset',
        body.entity_id ? String(body.entity_id).slice(0, 100) : '',
        String(body.subject).trim().slice(0, 500),
        VALID_RIGHT_TYPES.includes(body.rights_type) ? body.rights_type : 'commercial_use',
        VALID_RIGHT_STATUSES.includes(body.status) ? body.status : 'unknown',
        (body.owner || '').slice(0, 500),
        (body.source || '').slice(0, 500),
        (body.license_url || '').slice(0, 1000),
        (body.consent_reference || '').slice(0, 1000),
        (body.territory || 'worldwide').slice(0, 200),
        (body.expires_on || '').slice(0, 50),
        (body.restrictions || '').slice(0, 2000),
        (body.notes || '').slice(0, 2000),
        now,
        now,
        RIGHT_ORIGINS.includes(body.origin) ? body.origin : 'unknown'
    );

    const row = db.prepare('SELECT * FROM film_rights WHERE id = ?').get(id);
    json(res, 201, row);
}

function updateRight(req, res, rightId) {
    const body = req.body || {};
    const fields = [];
    const values = [];
    const add = (column, value) => { fields.push(`${column} = ?`); values.push(value); };

    if (body.entity_type !== undefined) {
        if (!VALID_RIGHT_ENTITY_TYPES.includes(body.entity_type)) return badReq(res, 'Invalid entity_type');
        add('entity_type', body.entity_type);
    }
    if (body.entity_id !== undefined) add('entity_id', body.entity_id ? String(body.entity_id).slice(0, 100) : '');
    if (body.subject !== undefined) add('subject', String(body.subject).trim().slice(0, 500));
    if (body.rights_type !== undefined) {
        if (!VALID_RIGHT_TYPES.includes(body.rights_type)) return badReq(res, 'Invalid rights_type');
        add('rights_type', body.rights_type);
    }
    if (body.status !== undefined) {
        if (!VALID_RIGHT_STATUSES.includes(body.status)) return badReq(res, 'Invalid status');
        add('status', body.status);
    }
    if (body.owner !== undefined) add('owner', (body.owner || '').slice(0, 500));
    if (body.source !== undefined) add('source', (body.source || '').slice(0, 500));
    if (body.license_url !== undefined) add('license_url', (body.license_url || '').slice(0, 1000));
    if (body.consent_reference !== undefined) add('consent_reference', (body.consent_reference || '').slice(0, 1000));
    if (body.territory !== undefined) add('territory', (body.territory || 'worldwide').slice(0, 200));
    if (body.expires_on !== undefined) add('expires_on', (body.expires_on || '').slice(0, 50));
    if (body.restrictions !== undefined) add('restrictions', (body.restrictions || '').slice(0, 2000));
    if (body.notes !== undefined) add('notes', (body.notes || '').slice(0, 2000));
    // What the material IS, as a person declares it (MUS-022). 'derived' is the engine's own and never set by hand.
    if (body.origin !== undefined) {
        if (!RIGHT_ORIGINS.includes(body.origin)) return badReq(res, `Invalid origin: one of ${RIGHT_ORIGINS.join(', ')}`);
        add('origin', body.origin);
    }
    if (!fields.length) return badReq(res, 'No valid fields to update');

    add('updated_at', new Date().toISOString());
    values.push(rightId);
    const result = db.prepare(`UPDATE film_rights SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) return json(res, 404, { error: 'Rights record not found' });
    json(res, 200, db.prepare('SELECT * FROM film_rights WHERE id = ?').get(rightId));
}

function deleteRight(req, res, rightId) {
    const result = db.prepare('DELETE FROM film_rights WHERE id = ?').run(rightId);
    if (result.changes === 0) return json(res, 404, { error: 'Rights record not found' });
    json(res, 200, { deleted: true });
}

// --- AI Provenance / Disclosure ---

function getProjectProvenance(req, res, projectId) {
    if (!requireProject(res, projectId)) return;
    const manifest = buildProjectManifest(db, projectId);
    json(res, 200, {
        project_id: projectId,
        disclosure: DISCLOSURE_TEXT,
        c2pa_status: 'sidecar_only_not_signed',
        manifest,
    });
}

function getAssetProvenance(req, res, assetId) {
    const manifest = buildAssetManifest(db, assetId);
    if (!manifest) return json(res, 404, { error: 'Asset not found' });
    json(res, 200, {
        asset_id: assetId,
        disclosure: DISCLOSURE_TEXT,
        c2pa_status: 'sidecar_only_not_signed',
        manifest,
    });
}

function exportProjectProvenance(req, res, projectId) {
    if (!requireProject(res, projectId)) return;
    const written = writeProjectSidecar(db, projectId);
    if (!written) return json(res, 404, { error: 'Project not found' });

    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO film_provenance_manifests (
            id, project_id, manifest_type, disclosure, c2pa_status,
            manifest_json, sidecar_path, created_at, updated_at
        ) VALUES (?, ?, 'project', ?, 'sidecar_only', ?, ?, ?, ?)
    `).run(
        id,
        projectId,
        DISCLOSURE_TEXT,
        JSON.stringify(written.manifest),
        written.relative_path,
        now,
        now
    );

    json(res, 201, {
        id,
        project_id: projectId,
        sidecar_path: written.relative_path,
        c2pa_status: 'sidecar_only_not_signed',
        manifest: written.manifest,
    });
}

// --- Color Presets ---

function listColorPresets(req, res, projectId) {
    const rows = db.prepare('SELECT * FROM film_color_presets WHERE project_id = ? ORDER BY name').all(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ color_presets: rows }));
}

function createColorPreset(req, res, projectId) {
    const body = req.body;
    if (!body.name || !body.name.trim()) return badReq(res, 'Preset name is required');

    const presetType = VALID_PRESET_TYPES.includes(body.preset_type) ? body.preset_type : 'color_grade';
    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_color_presets (id, project_id, name, description, preset_type,
            lut_path, grain_intensity, grain_size, temperature, tint, contrast,
            saturation, highlights, shadows, blacks, whites, is_default, params, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.name.trim().slice(0, 200),
        (body.description || '').slice(0, 1000),
        presetType,
        (body.lut_path || ''),
        body.grain_intensity || 0.0,
        body.grain_size || 1.0,
        body.temperature || 0.0,
        body.tint || 0.0,
        body.contrast || 0.0,
        body.saturation || 0.0,
        body.highlights || 0.0,
        body.shadows || 0.0,
        body.blacks || 0.0,
        body.whites || 0.0,
        body.is_default ? 1 : 0,
        JSON.stringify(body.params || {}),
        now
    );

    const row = db.prepare('SELECT * FROM film_color_presets WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}


/**
 * Change a cue. MERGED, never replaced.
 *
 * A cue is a whole brief — mood, instruments, the reference, the description —
 * and refining one sentence of direction must not clear the rest. The scene
 * card and the provider config both learned this; a swap here would drop the
 * instruments every time somebody rewrote a note.
 */
function updateMusicCue(req, res, cueId) {
    const existing = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(cueId);
    if (!existing) return json(res, 404, { error: 'Music cue not found' });

    const body = req.body || {};
    const fields = [];
    const values = [];

    const TEXT = { title: 200, description: 2000, mood: 100, genre: 100,
        key_signature: 20, reference_track: 500, notes: 2000 };
    for (const [field, max] of Object.entries(TEXT)) {
        if (body[field] === undefined) continue;
        fields.push(`${field} = ?`);
        values.push(String(body[field]).slice(0, max));
    }
    for (const field of ['tempo_bpm', 'start_ms', 'duration_ms', 'fade_in_ms', 'fade_out_ms']) {
        if (body[field] === undefined) continue;
        const n = Number(body[field]);
        if (!Number.isFinite(n) || n < 0) return json(res, 400, { error: `${field} must be a positive number` });
        fields.push(`${field} = ?`);
        values.push(n);
    }
    if (body.cue_type !== undefined) {
        if (!VALID_CUE_TYPES.includes(body.cue_type)) {
            return json(res, 400, { error: `cue_type must be one of: ${VALID_CUE_TYPES.join(', ')}` });
        }
        fields.push('cue_type = ?');
        values.push(body.cue_type);
    }
    if (body.negative_prompt !== undefined) {
        fields.push('negative_prompt = ?');
        values.push(String(body.negative_prompt).slice(0, 1000));
    }
    if (body.sections !== undefined) {
        let sections;
        try { sections = normalizeCueSections(body.sections); }
        catch (err) { return json(res, 400, { error: err.message, errors: err.errors || [] }); }
        fields.push('sections_json = ?');
        values.push(JSON.stringify(sections));
    }
    if (body.instruments !== undefined) {
        // Stored as JSON, and accepted either as a list or as the comma string
        // a person types — a raw string stored whole becomes one instrument
        // called "solo cello, brushed kit".
        const list = Array.isArray(body.instruments)
            ? body.instruments
            : String(body.instruments).split(',').map(x => x.trim()).filter(Boolean);
        fields.push('instruments = ?');
        values.push(JSON.stringify(list));
    }

    if (!fields.length) return json(res, 400, { error: 'Nothing to change' });

    db.prepare(`UPDATE film_music_cues SET ${fields.join(', ')} WHERE id = ?`).run(...values, cueId);
    // The bare row, matching what createMusicCue returns — two shapes for one
    // entity is a needless thing for a caller to have to know.
    const cue = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(cueId);
    return json(res, 200, cue);
}

/** Remove a cue. The generated audio is an asset and is left alone. */
function deleteMusicCue(res, cueId) {
    const cue = db.prepare('SELECT id FROM film_music_cues WHERE id = ?').get(cueId);
    if (!cue) return json(res, 404, { error: 'Music cue not found' });
    /*
     * The cue goes; the AUDIO stays. A generated track cost money and lives in
     * film_assets on its own scene — deleting a brief must not delete the
     * music written from it, the same rule that keeps a sequence's clips when
     * the sequence is deleted.
     */
    db.prepare('DELETE FROM film_music_cues WHERE id = ?').run(cueId);
    return json(res, 200, { deleted: cueId, note: 'The cue is removed. Any audio generated from it '
        + 'is kept — it is an asset on the scene and cost money to make.' });
}

module.exports = { handleAssets };
