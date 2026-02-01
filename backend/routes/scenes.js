/**
 * Scene endpoints
 * GET /film/projects/:id/scenes — list scenes for a project
 * GET /film/scenes/:id — get single scene with shots
 */
const { db } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleScenes(req, res, urlParts, query) {
    // /film/projects/:id/scenes — parts: ['film', 'projects', id, 'scenes']
    if (urlParts[1] === 'projects' && urlParts[3] === 'scenes') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project ID' }));
            return;
        }
        if (req.method === 'GET') return listScenes(req, res, projectId);
    }

    // /film/scenes/:id — parts: ['film', 'scenes', id]
    if (urlParts[1] === 'scenes' && urlParts[2]) {
        const sceneId = urlParts[2];
        if (!UUID_RE.test(sceneId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid scene ID' }));
            return;
        }
        if (req.method === 'GET') return getScene(req, res, sceneId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function listScenes(req, res, projectId) {
    const rows = db.prepare(
        'SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number'
    ).all(projectId);

    // Attach shot counts per scene
    const countStmt = db.prepare('SELECT COUNT(*) AS count FROM film_shots WHERE scene_id = ?');
    for (const scene of rows) {
        scene.shot_count = countStmt.get(scene.id).count;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scenes: rows }));
}

function getScene(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);

    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Scene not found' }));
        return;
    }

    // Include shots
    const shots = db.prepare(
        'SELECT * FROM film_shots WHERE scene_id = ? ORDER BY shot_code'
    ).all(sceneId);

    scene.shots = shots;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scene));
}

module.exports = { handleScenes };
