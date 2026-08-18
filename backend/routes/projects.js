/**
 * FILM-001: Film project CRUD endpoints
 * POST/GET/PUT/DELETE /film/projects
 */
const { db, generateId } = require('../db/database');
const { defaultProviderConfig } = require('../lib/providers');
const { validateProjectSettings, resolveDeliveryPreset } = require('../lib/project-presets');

// UUID v4 format check
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES = [
    'concept', 'script', 'pre-production', 'storyboard',
    'production', 'post-production', 'review', 'export', 'complete'
];

const SETTINGS_COLUMNS = [
    'target_resolution', 'target_fps', 'aspect_ratio', 'aspect_ratio_custom',
    'color_space', 'delivery_format', 'timecode_start',
];

function handleProjects(req, res, urlParts, query) {
    // /film/projects/:id  — parts: ['film', 'projects', id?]
    const id = urlParts[2] || null;

    if (req.method === 'GET' && !id) return listProjects(req, res, query);
    if (req.method === 'GET' && id) return getProject(req, res, id);
    if (req.method === 'POST' && !id) return createProject(req, res);
    if (req.method === 'PUT' && id) return updateProject(req, res, id);
    if (req.method === 'DELETE' && !id) return deleteAllProjects(req, res);
    if (req.method === 'DELETE' && id) return deleteProject(req, res, id);

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function listProjects(req, res, query) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    const offset = (page - 1) * limit;
    const status = query.status && VALID_STATUSES.includes(query.status) ? query.status : null;

    let sql = 'SELECT * FROM film_projects';
    const params = [];

    if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params);

    // Get total count
    let countSql = 'SELECT COUNT(*) AS count FROM film_projects';
    const countParams = [];
    if (status) {
        countSql += ' WHERE status = ?';
        countParams.push(status);
    }
    const countRow = db.prepare(countSql).get(...countParams);
    const total = countRow.count;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projects: rows, total, page, limit }));
}

function getProject(req, res, id) {
    if (!UUID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);

    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const sceneCount = db.prepare('SELECT COUNT(*) AS count FROM film_scenes WHERE project_id = ?').get(id);
    const shotCount = db.prepare(`
        SELECT COUNT(*) AS count FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ?
    `).get(id);
    const scriptCount = db.prepare(
        'SELECT COUNT(*) AS count, MAX(version) AS latest_version FROM film_scripts WHERE project_id = ?'
    ).get(id);

    project.scene_count = sceneCount.count;
    project.shot_count = shotCount.count;
    project.script_count = scriptCount.count;
    project.latest_script_version = scriptCount.latest_version || 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(project));
}

// Titles that indicate automated/accidental creation
const BLOCKED_TITLES = ['undefined', 'null', 'untitled', 'new project', 'test', ''];

function createProject(req, res) {
    const body = req.body;

    if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title is required' }));
        return;
    }

    const trimmedTitle = body.title.trim();
    if (trimmedTitle.length < 3) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title must be at least 3 characters' }));
        return;
    }

    if (BLOCKED_TITLES.includes(trimmedTitle.toLowerCase())) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Please provide a meaningful project title' }));
        return;
    }

    // Validate project settings if any provided
    const settingsFields = {};
    for (const key of SETTINGS_COLUMNS) {
        if (body[key] !== undefined) settingsFields[key] = body[key];
    }
    if (Object.keys(settingsFields).length > 0) {
        const validation = validateProjectSettings(settingsFields);
        if (!validation.valid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project settings', details: validation.errors }));
            return;
        }
    }

    const id = generateId();
    const title = body.title.trim().slice(0, 500);
    const logline = (body.logline || '').trim().slice(0, 2000);
    const genre = (body.genre || '').trim().slice(0, 100);
    // 2000, not 100. style_preset stopped being an enum key the moment the
    // prompt builder began passing unknown values through verbatim: a director
    // describing their own look ("Guillermo del Toro gothic: teal/amber, wet
    // streets, anamorphic...") was silently cut mid-word and the fragment baked
    // into every frame. The column is TEXT; the cap was never a storage limit.
    const style_preset = (body.style_preset || '').trim().slice(0, 2000);
    const status = VALID_STATUSES.includes(body.status) ? body.status : 'concept';
    const target_resolution = settingsFields.target_resolution || '1920x1080';
    const target_fps = settingsFields.target_fps !== undefined ? Number(settingsFields.target_fps) : 24;
    const aspect_ratio = settingsFields.aspect_ratio || '16:9';
    const aspect_ratio_custom = settingsFields.aspect_ratio_custom || '';
    const color_space = settingsFields.color_space || 'Rec.709';
    const delivery_format = settingsFields.delivery_format || '';
    const timecode_start = settingsFields.timecode_start || '01:00:00:00';
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_projects (id, title, logline, genre, style_preset, status,
            target_resolution, target_fps, aspect_ratio, aspect_ratio_custom,
            color_space, delivery_format, timecode_start, provider_config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, logline, genre, style_preset, status,
        target_resolution, target_fps, aspect_ratio, aspect_ratio_custom,
        color_space, delivery_format, timecode_start,
        // Written at creation rather than left empty. Resolve-time
        // preference already makes a blank config work, but a blank column
        // shows the user nothing in Provider Settings while generation
        // quietly uses something else.
        JSON.stringify(defaultProviderConfig()),
        now, now);

    const row = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateProject(req, res, id) {
    if (!UUID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    const body = req.body;
    const fields = [];
    const values = [];

    if (body.title !== undefined) {
        fields.push('title = ?');
        values.push(String(body.title).trim().slice(0, 500));
    }
    if (body.logline !== undefined) {
        fields.push('logline = ?');
        values.push(String(body.logline).trim().slice(0, 2000));
    }
    if (body.genre !== undefined) {
        fields.push('genre = ?');
        values.push(String(body.genre).trim().slice(0, 100));
    }
    if (body.style_preset !== undefined) {
        fields.push('style_preset = ?');
        values.push(String(body.style_preset).trim().slice(0, 2000));
    }
    if (body.status !== undefined && VALID_STATUSES.includes(body.status)) {
        fields.push('status = ?');
        values.push(body.status);
    }

    // Project settings columns
    const settingsToValidate = {};
    for (const key of SETTINGS_COLUMNS) {
        if (body[key] !== undefined) settingsToValidate[key] = body[key];
    }
    if (Object.keys(settingsToValidate).length > 0) {
        const validation = validateProjectSettings(settingsToValidate);
        if (!validation.valid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project settings', details: validation.errors }));
            return;
        }
        for (const key of SETTINGS_COLUMNS) {
            if (body[key] !== undefined) {
                fields.push(`${key} = ?`);
                values.push(key === 'target_fps' ? Number(body[key]) : String(body[key]));
            }
        }
    }

    if (fields.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid fields to update' }));
        return;
    }

    fields.push("updated_at = datetime('now')");
    values.push(id);

    const result = db.prepare(
        `UPDATE film_projects SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function deleteProject(req, res, id) {
    if (!UUID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    const result = db.prepare('DELETE FROM film_projects WHERE id = ?').run(id);

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

function deleteAllProjects(req, res) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM film_projects').get().count;
    if (count === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: 0, message: 'No projects to delete' }));
        return;
    }

    db.prepare('DELETE FROM film_projects').run();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: count }));
}

/**
 * POST /film/projects/:id/settings/preset — apply a delivery preset
 */
function handleProjectSettingsPreset(req, res, parts) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    const id = parts[2];
    if (!UUID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    const body = req.body;
    const presetId = body.preset;
    if (!presetId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'preset field is required' }));
        return;
    }

    const preset = resolveDeliveryPreset(presetId);
    if (!preset) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown preset: ${presetId}` }));
        return;
    }

    const result = db.prepare(`
        UPDATE film_projects SET
            target_resolution = ?, target_fps = ?, aspect_ratio = ?,
            color_space = ?, delivery_format = ?, updated_at = datetime('now')
        WHERE id = ?
    `).run(
        preset.target_resolution, preset.target_fps, preset.aspect_ratio,
        preset.color_space, preset.id, id
    );

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ project: row, applied_preset: preset }));
}

module.exports = { handleProjects, handleProjectSettingsPreset };
