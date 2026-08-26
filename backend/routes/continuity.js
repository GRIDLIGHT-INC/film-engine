/**
 * Continuity Reference Board Routes
 *
 * GET/POST /film/projects/:id/continuity
 * GET /film/projects/:id/continuity/board
 * GET/PUT/DELETE /film/continuity/:id
 */
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_REF_TYPES = ['visual', 'wardrobe', 'prop', 'lighting', 'color', 'framing'];

/**
 * A continuity reference made outside Film Engine.
 *
 * `image_path` could only be set by POSTing a STRING — a path on the server's
 * own disk — which from a browser is unusable, so in practice this board could
 * not hold a picture at all. And a continuity reference is a photograph of what
 * was actually shot: the upload is the normal case here, not the escape hatch.
 */
function importContinuityImage(req, res, refId) {
    // This module answers by writing the head itself rather than through a
    // json() helper; matching that is what keeps the handler's failure path
    // real instead of a ReferenceError swallowed into a 400.
    const reply = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    };

    const ref = db.prepare('SELECT * FROM film_continuity_refs WHERE id = ?').get(refId);
    if (!ref) return reply(404, { error: 'Continuity reference not found' });
    const body = req.body || {};
    if (!body.data) return reply(400, { error: 'no image supplied' });
    try {
        const { importMedia } = require('../lib/media-imports');
        const imported = importMedia('continuity-ref', {
            projectId: ref.project_id, data: body.data, name: body.name || ref.title,
        });
        db.prepare('UPDATE film_continuity_refs SET image_path = ?, asset_id = ? WHERE id = ?')
            .run(imported.file_path, imported.asset_id, refId);
        return reply(201, {
            ref: db.prepare('SELECT * FROM film_continuity_refs WHERE id = ?').get(refId),
            ...imported,
        });
    } catch (err) {
        return reply(/not found/i.test(err.message) ? 404 : 400, { error: err.message });
    }
}

function handleContinuity(req, res, urlParts, query) {
    if (urlParts[1] === 'continuity' && urlParts[2] && urlParts[3] === 'import' && req.method === 'POST') {
        return importContinuityImage(req, res, urlParts[2]);
    }
    // /film/projects/:id/continuity[/board]
    if (urlParts[1] === 'projects' && urlParts[3] === 'continuity') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project ID' }));
            return;
        }

        if (urlParts[4] === 'board' && req.method === 'GET') {
            return getContinuityBoard(req, res, projectId);
        }

        if (req.method === 'GET') return listContinuityRefs(req, res, projectId, query);
        if (req.method === 'POST') return createContinuityRef(req, res, projectId);
    }

    // /film/continuity/:id
    if (urlParts[1] === 'continuity' && urlParts[2]) {
        const id = urlParts[2];
        if (!UUID_RE.test(id)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid continuity ref ID' }));
            return;
        }

        if (req.method === 'GET') return getContinuityRef(req, res, id);
        if (req.method === 'PUT') return updateContinuityRef(req, res, id);
        if (req.method === 'DELETE') return deleteContinuityRef(req, res, id);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function listContinuityRefs(req, res, projectId, query) {
    let sql = 'SELECT * FROM film_continuity_refs WHERE project_id = ?';
    const params = [projectId];

    if (query.ref_type) {
        sql += ' AND ref_type = ?';
        params.push(query.ref_type);
    }
    if (query.scene_id) {
        sql += ' AND scene_id = ?';
        params.push(query.scene_id);
    }
    if (query.character_id) {
        sql += ' AND character_id = ?';
        params.push(query.character_id);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = db.prepare(sql).all(...params);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ refs: rows }));
}

function createContinuityRef(req, res, projectId) {
    const body = req.body;

    if (!body.title || !body.ref_type) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title and ref_type are required' }));
        return;
    }

    if (!VALID_REF_TYPES.includes(body.ref_type)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid ref_type. Must be one of: ' + VALID_REF_TYPES.join(', ') }));
        return;
    }

    const id = generateId();
    const tags = body.tags ? JSON.stringify(body.tags) : null;

    db.prepare(`
        INSERT INTO film_continuity_refs
        (id, project_id, ref_type, title, description, scene_id, character_id, shot_id, asset_id, image_path, tags, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.ref_type,
        (body.title || '').slice(0, 200),
        (body.description || '').slice(0, 2000),
        body.scene_id || null,
        body.character_id || null,
        body.shot_id || null,
        body.asset_id || null,
        body.image_path || null,
        tags,
        (body.notes || '').slice(0, 2000),
    );

    const row = db.prepare('SELECT * FROM film_continuity_refs WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function getContinuityRef(req, res, id) {
    const row = db.prepare('SELECT * FROM film_continuity_refs WHERE id = ?').get(id);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Continuity ref not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateContinuityRef(req, res, id) {
    const existing = db.prepare('SELECT * FROM film_continuity_refs WHERE id = ?').get(id);
    if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Continuity ref not found' }));
        return;
    }

    const body = req.body;

    if (body.ref_type && !VALID_REF_TYPES.includes(body.ref_type)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid ref_type. Must be one of: ' + VALID_REF_TYPES.join(', ') }));
        return;
    }

    const tags = body.tags !== undefined ? JSON.stringify(body.tags) : existing.tags;

    db.prepare(`
        UPDATE film_continuity_refs
        SET ref_type = ?, title = ?, description = ?, scene_id = ?, character_id = ?, shot_id = ?, asset_id = ?, image_path = ?, tags = ?, notes = ?
        WHERE id = ?
    `).run(
        body.ref_type || existing.ref_type,
        body.title !== undefined ? (body.title || '').slice(0, 200) : existing.title,
        body.description !== undefined ? (body.description || '').slice(0, 2000) : existing.description,
        body.scene_id !== undefined ? body.scene_id : existing.scene_id,
        body.character_id !== undefined ? body.character_id : existing.character_id,
        body.shot_id !== undefined ? body.shot_id : existing.shot_id,
        body.asset_id !== undefined ? body.asset_id : existing.asset_id,
        body.image_path !== undefined ? body.image_path : existing.image_path,
        tags,
        body.notes !== undefined ? (body.notes || '').slice(0, 2000) : existing.notes,
        id,
    );

    const row = db.prepare('SELECT * FROM film_continuity_refs WHERE id = ?').get(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function deleteContinuityRef(req, res, id) {
    const result = db.prepare('DELETE FROM film_continuity_refs WHERE id = ?').run(id);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Continuity ref not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

function getContinuityBoard(req, res, projectId) {
    const rows = db.prepare(
        'SELECT * FROM film_continuity_refs WHERE project_id = ? ORDER BY ref_type, created_at DESC'
    ).all(projectId);

    const board = {};
    for (const type of VALID_REF_TYPES) {
        board[type] = [];
    }
    for (const row of rows) {
        if (board[row.ref_type]) {
            board[row.ref_type].push(row);
        }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ project_id: projectId, board, ref_types: VALID_REF_TYPES }));
}

module.exports = { handleContinuity };
