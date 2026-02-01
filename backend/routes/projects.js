/**
 * FILM-001: Film project CRUD endpoints
 * POST/GET/PUT/DELETE /film/projects
 */
const { db, generateId } = require('../db/database');

// UUID v4 format check
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES = [
    'concept', 'script', 'pre-production', 'storyboard',
    'production', 'post-production', 'review', 'export', 'complete'
];

function handleProjects(req, res, urlParts, query) {
    // /film/projects/:id  — parts: ['film', 'projects', id?]
    const id = urlParts[2] || null;

    if (req.method === 'GET' && !id) return listProjects(req, res, query);
    if (req.method === 'GET' && id) return getProject(req, res, id);
    if (req.method === 'POST' && !id) return createProject(req, res);
    if (req.method === 'PUT' && id) return updateProject(req, res, id);
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

function createProject(req, res) {
    const body = req.body;

    if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title is required' }));
        return;
    }

    const id = generateId();
    const title = body.title.trim().slice(0, 500);
    const logline = (body.logline || '').trim().slice(0, 2000);
    const genre = (body.genre || '').trim().slice(0, 100);
    const style_preset = (body.style_preset || '').trim().slice(0, 100);
    const status = VALID_STATUSES.includes(body.status) ? body.status : 'concept';
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_projects (id, title, logline, genre, style_preset, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, logline, genre, style_preset, status, now, now);

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
        values.push(String(body.style_preset).trim().slice(0, 100));
    }
    if (body.status !== undefined && VALID_STATUSES.includes(body.status)) {
        fields.push('status = ?');
        values.push(body.status);
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

module.exports = { handleProjects };
