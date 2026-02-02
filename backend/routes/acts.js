/**
 * Act CRUD + scene assignment
 * GET/POST /film/projects/:id/acts
 * GET/PUT/DELETE /film/acts/:id
 * POST /film/acts/:id/assign
 */
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleActs(req, res, urlParts, query) {
    // /film/projects/:id/acts — parts: ['film', 'projects', id, 'acts']
    if (urlParts[1] === 'projects' && urlParts[3] === 'acts') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badRequest(res, 'Invalid project ID');

        if (req.method === 'GET') return listActs(req, res, projectId);
        if (req.method === 'POST') return createAct(req, res, projectId);
    }

    // /film/acts/:id[/assign] — parts: ['film', 'acts', id] or ['film', 'acts', id, 'assign']
    if (urlParts[1] === 'acts' && urlParts[2]) {
        const actId = urlParts[2];
        if (!UUID_RE.test(actId)) return badRequest(res, 'Invalid act ID');
        const sub = urlParts[3];

        if (sub === 'assign') {
            if (req.method === 'POST') return assignScenes(req, res, actId);
        }

        if (!sub) {
            if (req.method === 'GET') return getAct(req, res, actId);
            if (req.method === 'PUT') return updateAct(req, res, actId);
            if (req.method === 'DELETE') return deleteAct(req, res, actId);
        }
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badRequest(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

// --- Acts ---

function listActs(req, res, projectId) {
    const rows = db.prepare(
        'SELECT * FROM film_acts WHERE project_id = ? ORDER BY sort_order'
    ).all(projectId);

    // Attach scene count per act
    const sceneCount = db.prepare('SELECT COUNT(*) AS count FROM film_scenes WHERE act_id = ?');
    for (const act of rows) {
        act.scene_count = sceneCount.get(act.id).count;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ acts: rows }));
}

function getAct(req, res, actId) {
    const act = db.prepare('SELECT * FROM film_acts WHERE id = ?').get(actId);
    if (!act) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Act not found' }));
        return;
    }

    // Include scene count
    const count = db.prepare('SELECT COUNT(*) AS count FROM film_scenes WHERE act_id = ?').get(actId);
    act.scene_count = count.count;

    // Include scenes belonging to this act
    act.scenes = db.prepare(
        'SELECT id, scene_number, int_ext, location, time_of_day, status FROM film_scenes WHERE act_id = ? ORDER BY scene_number'
    ).all(actId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(act));
}

function createAct(req, res, projectId) {
    const body = req.body;
    if (body.act_number === undefined || body.act_number === null) {
        return badRequest(res, 'act_number is required');
    }
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return badRequest(res, 'Act name is required');
    }

    const actNumber = Number(body.act_number);
    if (!Number.isInteger(actNumber) || actNumber < 1) {
        return badRequest(res, 'act_number must be a positive integer');
    }

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_acts (id, project_id, act_number, name, description, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        actNumber,
        body.name.trim().slice(0, 200),
        (body.description || '').slice(0, 5000),
        actNumber,
        now
    );

    const row = db.prepare('SELECT * FROM film_acts WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateAct(req, res, actId) {
    const body = req.body;

    const existing = db.prepare('SELECT * FROM film_acts WHERE id = ?').get(actId);
    if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Act not found' }));
        return;
    }

    const fields = [];
    const values = [];

    if (body.act_number !== undefined) {
        const actNumber = Number(body.act_number);
        if (!Number.isInteger(actNumber) || actNumber < 1) {
            return badRequest(res, 'act_number must be a positive integer');
        }
        fields.push('act_number = ?');
        values.push(actNumber);
    }

    if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) {
            return badRequest(res, 'Act name cannot be empty');
        }
        fields.push('name = ?');
        values.push(body.name.trim().slice(0, 200));
    }

    if (body.description !== undefined) {
        fields.push('description = ?');
        values.push(String(body.description).slice(0, 5000));
    }

    if (body.sort_order !== undefined) {
        const sortOrder = Number(body.sort_order);
        if (!Number.isInteger(sortOrder) || sortOrder < 0) {
            return badRequest(res, 'sort_order must be a non-negative integer');
        }
        fields.push('sort_order = ?');
        values.push(sortOrder);
    }

    if (fields.length === 0) return badRequest(res, 'No valid fields to update');

    values.push(actId);
    db.prepare(`UPDATE film_acts SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM film_acts WHERE id = ?').get(actId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function deleteAct(req, res, actId) {
    const existing = db.prepare('SELECT * FROM film_acts WHERE id = ?').get(actId);
    if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Act not found' }));
        return;
    }

    // Unlink scenes by setting act_id to NULL
    db.prepare('UPDATE film_scenes SET act_id = NULL WHERE act_id = ?').run(actId);

    db.prepare('DELETE FROM film_acts WHERE id = ?').run(actId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

function assignScenes(req, res, actId) {
    const body = req.body;

    const act = db.prepare('SELECT * FROM film_acts WHERE id = ?').get(actId);
    if (!act) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Act not found' }));
        return;
    }

    if (!Array.isArray(body.scene_ids) || body.scene_ids.length === 0) {
        return badRequest(res, 'scene_ids must be a non-empty array');
    }

    // Validate all scene IDs
    for (const sceneId of body.scene_ids) {
        if (!UUID_RE.test(sceneId)) {
            return badRequest(res, `Invalid scene ID: ${sceneId}`);
        }
    }

    const updateStmt = db.prepare('UPDATE film_scenes SET act_id = ? WHERE id = ? AND project_id = ?');
    let assigned = 0;

    const assignAll = db.transaction(() => {
        for (const sceneId of body.scene_ids) {
            const result = updateStmt.run(actId, sceneId, act.project_id);
            assigned += result.changes;
        }
    });
    assignAll();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        act_id: actId,
        requested: body.scene_ids.length,
        assigned
    }));
}

module.exports = { handleActs };
