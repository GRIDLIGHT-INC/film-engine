/**
 * FILM-008: Shot creation from scene cards
 * FILM-010: Shotlist endpoint
 *
 * POST /film/shots — create shots from scene cards (batch)
 * GET  /film/projects/:id/shotlist — aggregate shot list
 */
const { db, generateId } = require('../db/database');
const { validateSceneCards } = require('../lib/scene-card-schema');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleShots(req, res, urlParts, query) {
    // POST /film/shots — parts: ['film', 'shots']
    if (urlParts[1] === 'shots' && !urlParts[2] && req.method === 'POST') {
        return createShots(req, res);
    }

    // GET /film/projects/:id/shotlist — parts: ['film', 'projects', id, 'shotlist']
    if (urlParts[1] === 'projects' && urlParts[3] === 'shotlist' && req.method === 'GET') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project ID' }));
            return;
        }
        return getShotlist(req, res, projectId, query);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function createShots(req, res) {
    const body = req.body;

    // Validate scene_id
    if (!body.scene_id || !UUID_RE.test(body.scene_id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid scene_id is required' }));
        return;
    }

    // Verify scene exists
    const scene = db.prepare('SELECT id FROM film_scenes WHERE id = ?').get(body.scene_id);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Scene not found' }));
        return;
    }

    // Validate scene cards
    if (!body.cards || !Array.isArray(body.cards)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cards array is required' }));
        return;
    }

    const validation = validateSceneCards(body.cards);
    if (!validation.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid scene cards', details: validation.errors }));
        return;
    }

    // Insert shots
    const insertStmt = db.prepare(`
        INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const selectStmt = db.prepare('SELECT * FROM film_shots WHERE id = ?');

    const inserted = [];
    for (const card of body.cards) {
        const shotId = generateId();
        const cardYaml = JSON.stringify(card, null, 2);
        const now = new Date().toISOString();

        insertStmt.run(shotId, body.scene_id, card.shot_code, cardYaml, card.duration_ms || 0, now);
        inserted.push(selectStmt.get(shotId));
    }

    // Update scene status to broken_down
    db.prepare(`
        UPDATE film_scenes SET status = 'broken_down'
        WHERE id = ? AND status = 'written'
    `).run(body.scene_id);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shots: inserted, count: inserted.length }));
}

function getShotlist(req, res, projectId, query) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 50));
    const offset = (page - 1) * limit;

    const rows = db.prepare(`
        SELECT
            s.id, s.shot_code, s.status, s.duration_ms, s.created_at,
            sc.scene_number, sc.location, sc.time_of_day, sc.id AS scene_id
        FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ?
        ORDER BY sc.scene_number, s.shot_code
        LIMIT ? OFFSET ?
    `).all(projectId, limit, offset);

    const countRow = db.prepare(`
        SELECT COUNT(*) AS count FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ?
    `).get(projectId);

    const total = countRow.count;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shots: rows, total, page, limit }));
}

module.exports = { handleShots };
