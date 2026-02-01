/**
 * Asset registry & music cues
 * POST/GET /film/projects/:id/assets
 * GET/DELETE /film/assets/:id
 * POST/GET /film/projects/:id/music-cues
 * POST/GET /film/projects/:id/color-presets
 */
const { db, generateId } = require('../db/database');

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
    if (urlParts[1] === 'assets' && urlParts[2]) {
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

function createMusicCue(req, res, projectId) {
    const body = req.body;
    const cueType = VALID_CUE_TYPES.includes(body.cue_type) ? body.cue_type : 'score';

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_music_cues (id, project_id, scene_id, shot_id, cue_type,
            title, description, mood, genre, tempo_bpm, key_signature,
            instruments, reference_track, start_ms, duration_ms,
            volume_db, fade_in_ms, fade_out_ms, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now
    );

    const row = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
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

module.exports = { handleAssets };
