/**
 * FILM-084: Production dashboard, status board, and milestones
 * GET /film/projects/:id/dashboard — aggregate production stats
 * GET /film/projects/:id/status-board — per-scene/shot status breakdown
 * GET/POST/PUT /film/projects/:id/milestones — production timeline
 */
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MILESTONE_PHASES = [
    'concept', 'script', 'pre-production', 'storyboard',
    'production', 'post-production', 'review', 'export', 'complete'
];

function handleDashboard(req, res, urlParts, query) {
    if (urlParts[1] !== 'projects' || !urlParts[2]) {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    const projectId = urlParts[2];
    if (!UUID_RE.test(projectId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    const sub = urlParts[3];

    // GET /film/projects/:id/home — the six blocks the home page renders.
    if (sub === 'home' && req.method === 'GET') {
        const { buildHome } = require('../lib/home');
        const home = buildHome(db, projectId);
        if (!home) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Project not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(home));
    }

    if (sub === 'dashboard' && req.method === 'GET') return getDashboard(req, res, projectId);
    if (sub === 'status-board' && req.method === 'GET') return getStatusBoard(req, res, projectId);
    if (sub === 'milestones') {
        if (req.method === 'GET') return listMilestones(req, res, projectId);
        if (req.method === 'POST') return createMilestone(req, res, projectId);
    }
    // /film/projects/:id/milestones/:mid
    if (sub === 'milestones' && urlParts[4] && UUID_RE.test(urlParts[4])) {
        if (req.method === 'PUT') return updateMilestone(req, res, urlParts[4]);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function getDashboard(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    // Scene stats
    const totalScenes = db.prepare('SELECT COUNT(*) AS count FROM film_scenes WHERE project_id = ?').get(projectId).count;
    const scenesByStatus = db.prepare('SELECT status, COUNT(*) AS count FROM film_scenes WHERE project_id = ? GROUP BY status').all(projectId);

    // Shot stats
    const totalShots = db.prepare(`
        SELECT COUNT(*) AS count FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id WHERE sc.project_id = ?
    `).get(projectId).count;
    const shotsByStatus = db.prepare(`
        SELECT s.status, COUNT(*) AS count FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id WHERE sc.project_id = ?
        GROUP BY s.status
    `).all(projectId);

    // Script stats
    const scripts = db.prepare('SELECT COUNT(*) AS count, MAX(version) AS latest FROM film_scripts WHERE project_id = ?').get(projectId);

    // Character stats
    const characters = db.prepare('SELECT COUNT(*) AS count FROM film_characters WHERE project_id = ?').get(projectId).count;

    // Location stats
    const locations = db.prepare('SELECT COUNT(*) AS count FROM film_locations WHERE project_id = ?').get(projectId).count;

    // Asset stats
    const totalAssets = db.prepare('SELECT COUNT(*) AS count FROM film_assets WHERE project_id = ?').get(projectId).count;
    const assetsByType = db.prepare('SELECT asset_type, COUNT(*) AS count FROM film_assets WHERE project_id = ? GROUP BY asset_type').all(projectId);

    // Note stats
    const unresolvedNotes = db.prepare(`
        SELECT COUNT(*) AS count FROM film_shot_notes n
        JOIN film_shots s ON n.shot_id = s.id
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ? AND n.resolved = 0
    `).get(projectId).count;

    // Duration estimate
    const totalDuration = db.prepare(`
        SELECT COALESCE(SUM(s.duration_ms), 0) AS total FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id WHERE sc.project_id = ?
    `).get(projectId).total;

    // Milestone progress
    const milestones = db.prepare('SELECT * FROM film_milestones WHERE project_id = ? ORDER BY sort_order').all(projectId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        project,
        stats: {
            scenes: { total: totalScenes, by_status: scenesByStatus },
            shots: { total: totalShots, by_status: shotsByStatus },
            scripts: { total: scripts.count, latest_version: scripts.latest || 0 },
            characters,
            locations,
            assets: { total: totalAssets, by_type: assetsByType },
            unresolved_notes: unresolvedNotes,
            // How much of the film has been blocked in 3D. The dashboard's
            // progress strip reports a Block stage, and without this it would
            // report "not started" forever however much was staged — a wrong
            // answer stated confidently.
            previs_blocked: db.prepare(
                `SELECT COUNT(*) AS n FROM film_previs_blocking b
                   JOIN film_shots sh ON sh.id = b.shot_id
                   JOIN film_scenes sc ON sc.id = sh.scene_id
                  WHERE sc.project_id = ?`).get(projectId).n,
            estimated_duration_ms: totalDuration,
            estimated_duration_formatted: formatDuration(totalDuration)
        },
        milestones
    }));
}

function getStatusBoard(req, res, projectId) {
    const scenes = db.prepare(
        'SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number'
    ).all(projectId);

    const shotStmt = db.prepare('SELECT * FROM film_shots WHERE scene_id = ? ORDER BY shot_code');
    const noteCountStmt = db.prepare(`
        SELECT COUNT(*) AS count FROM film_shot_notes WHERE shot_id = ? AND resolved = 0
    `);

    for (const scene of scenes) {
        scene.shots = shotStmt.all(scene.id);
        for (const shot of scene.shots) {
            shot.unresolved_notes = noteCountStmt.get(shot.id).count;
        }
        scene.shot_count = scene.shots.length;
        scene.completed_shots = scene.shots.filter(s => s.status === 'complete' || s.status === 'approved').length;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scenes }));
}

function listMilestones(req, res, projectId) {
    let milestones = db.prepare('SELECT * FROM film_milestones WHERE project_id = ? ORDER BY sort_order').all(projectId);

    // Auto-generate default milestones if none exist
    if (milestones.length === 0) {
        const insertMilestone = db.prepare(`
            INSERT INTO film_milestones (id, project_id, title, phase, sort_order, auto_generated, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
        `);

        const defaultMilestones = [
            { title: 'Concept & Story', phase: 'concept' },
            { title: 'Script Complete', phase: 'script' },
            { title: 'Pre-Production Ready', phase: 'pre-production' },
            { title: 'Storyboard Complete', phase: 'storyboard' },
            { title: 'Production Complete', phase: 'production' },
            { title: 'Post-Production Complete', phase: 'post-production' },
            { title: 'Review & Approval', phase: 'review' },
            { title: 'Export Ready', phase: 'export' },
            { title: 'Project Complete', phase: 'complete' }
        ];

        for (let i = 0; i < defaultMilestones.length; i++) {
            const m = defaultMilestones[i];
            insertMilestone.run(generateId(), projectId, m.title, m.phase, i);
        }

        milestones = db.prepare('SELECT * FROM film_milestones WHERE project_id = ? ORDER BY sort_order').all(projectId);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ milestones }));
}

function createMilestone(req, res, projectId) {
    const body = req.body;
    if (!body.title || !body.title.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Milestone title is required' }));
        return;
    }

    const phase = MILESTONE_PHASES.includes(body.phase) ? body.phase : 'concept';
    const id = generateId();
    const now = new Date().toISOString();

    // Get next sort order
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM film_milestones WHERE project_id = ?').get(projectId).next;

    db.prepare(`
        INSERT INTO film_milestones (id, project_id, title, description, phase, sort_order,
            target_date, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, projectId, body.title.trim().slice(0, 300), (body.description || '').slice(0, 2000), phase, body.sort_order || maxOrder, body.target_date || null, now, now);

    const row = db.prepare('SELECT * FROM film_milestones WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateMilestone(req, res, milestoneId) {
    const body = req.body;
    const fields = [];
    const values = [];

    if (body.title !== undefined) { fields.push('title = ?'); values.push(String(body.title).slice(0, 300)); }
    if (body.description !== undefined) { fields.push('description = ?'); values.push(String(body.description).slice(0, 2000)); }
    if (body.phase !== undefined && MILESTONE_PHASES.includes(body.phase)) { fields.push('phase = ?'); values.push(body.phase); }
    if (body.target_date !== undefined) { fields.push('target_date = ?'); values.push(body.target_date); }
    if (body.actual_date !== undefined) { fields.push('actual_date = ?'); values.push(body.actual_date); }
    if (body.status !== undefined && ['pending', 'in_progress', 'completed', 'skipped'].includes(body.status)) {
        fields.push('status = ?'); values.push(body.status);
    }
    if (body.completion_pct !== undefined) { fields.push('completion_pct = ?'); values.push(Math.min(100, Math.max(0, parseInt(body.completion_pct) || 0))); }
    if (body.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(parseInt(body.sort_order) || 0); }

    if (fields.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid fields to update' }));
        return;
    }

    fields.push("updated_at = datetime('now')");
    values.push(milestoneId);

    const result = db.prepare(`UPDATE film_milestones SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Milestone not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_milestones WHERE id = ?').get(milestoneId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function formatDuration(ms) {
    if (!ms) return '0:00';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    if (hr > 0) return `${hr}:${String(remMin).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${remMin}:${String(sec).padStart(2, '0')}`;
}

module.exports = { handleDashboard };
