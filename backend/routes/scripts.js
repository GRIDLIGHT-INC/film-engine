/**
 * FILM-004: Script upload/versioning endpoint
 * POST /film/projects/:id/script — upload screenplay, auto-extract scenes
 * GET  /film/projects/:id/scripts — list script versions
 * GET  /film/projects/:id/scripts/:version — get specific version
 */
const { db, generateId } = require('../db/database');
const { parseScreenplay } = require('../lib/screenplay-parser');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleScripts(req, res, urlParts, query) {
    const projectId = urlParts[2];
    const sub = urlParts[3]; // 'script' or 'scripts'
    const version = urlParts[4] ? parseInt(urlParts[4]) : null;

    if (!UUID_RE.test(projectId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    // Verify project exists
    const proj = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!proj) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    if (req.method === 'POST' && sub === 'script') return uploadScript(req, res, projectId);
    if (req.method === 'GET' && sub === 'scripts' && !version) return listScripts(req, res, projectId);
    if (req.method === 'GET' && sub === 'scripts' && version) return getScript(req, res, projectId, version);

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function uploadScript(req, res, projectId) {
    const body = req.body;

    if (!body.content || typeof body.content !== 'string' || body.content.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Script content is required' }));
        return;
    }

    const content = body.content;
    const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;

    // Get next version number
    const verRow = db.prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM film_scripts WHERE project_id = ?'
    ).get(projectId);
    const nextVersion = verRow.next_version;

    const scriptId = generateId();
    const now = new Date().toISOString();

    // Insert script
    db.prepare(`
        INSERT INTO film_scripts (id, project_id, version, content, word_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(scriptId, projectId, nextVersion, content, wordCount, now);

    const scriptRow = db.prepare('SELECT * FROM film_scripts WHERE id = ?').get(scriptId);

    // Parse screenplay into scenes
    const parsedScenes = parseScreenplay(content);

    // If this is version 1 or explicit replace, clear old scenes for this project
    if (body.replace_scenes !== false) {
        db.prepare('DELETE FROM film_scenes WHERE project_id = ?').run(projectId);
    }

    // Insert extracted scenes
    const insertedScenes = [];
    const insertScene = db.prepare(`
        INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description, characters_present, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const scene of parsedScenes) {
        const sceneId = generateId();
        const sceneNow = new Date().toISOString();
        insertScene.run(
            sceneId,
            projectId,
            scene.scene_number,
            scene.int_ext,
            scene.location,
            scene.time_of_day,
            scene.description.slice(0, 10000),
            JSON.stringify(scene.characters_present),
            sceneNow
        );
        const row = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
        insertedScenes.push(row);
    }

    // Advance project status to 'script' if still in concept
    db.prepare(`
        UPDATE film_projects SET status = 'script', updated_at = datetime('now')
        WHERE id = ? AND status = 'concept'
    `).run(projectId);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        script: scriptRow,
        scenes_extracted: insertedScenes.length,
        scenes: insertedScenes
    }));
}

function listScripts(req, res, projectId) {
    const rows = db.prepare(
        'SELECT id, project_id, version, word_count, created_at FROM film_scripts WHERE project_id = ? ORDER BY version DESC'
    ).all(projectId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scripts: rows }));
}

function getScript(req, res, projectId, version) {
    const row = db.prepare(
        'SELECT * FROM film_scripts WHERE project_id = ? AND version = ?'
    ).get(projectId, version);

    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Script version not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

module.exports = { handleScripts };
