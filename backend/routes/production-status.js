/**
 * FILM-082: Production Status State Machine with auto-advance
 * FILM-083: Scene Status Tracking with auto-advance
 *
 * POST /film/projects/:id/advance-status — evaluate and advance project status
 * GET  /film/projects/:id/advance-status — dry-run: show what would change
 *
 * State machines:
 *
 * PROJECT STATUS:
 *   concept → script → pre-production → storyboard → production →
 *   post-production → review → export → complete
 *
 * SCENE STATUS:
 *   written → broken_down → generating → rendered → complete → approved
 *
 * SHOT STATUS:
 *   pending → generating → complete → approved
 *
 * Auto-advance rules evaluate bottom-up: shots → scenes → project.
 */
const { db } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ordered project phases
const PROJECT_PHASES = [
    'concept', 'script', 'pre-production', 'storyboard',
    'production', 'post-production', 'review', 'export', 'complete'
];

// Ordered scene statuses
const SCENE_STATUSES = [
    'written', 'broken_down', 'generating', 'rendered', 'complete', 'approved'
];

// Ordered shot statuses
const SHOT_STATUSES = [
    'pending', 'generating', 'complete', 'approved'
];

function handleProductionStatus(req, res, urlParts, query) {
    const projectId = urlParts[2];
    if (!UUID_RE.test(projectId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    if (req.method === 'GET') return evaluateStatus(req, res, projectId, false);
    if (req.method === 'POST') return evaluateStatus(req, res, projectId, true);

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function evaluateStatus(req, res, projectId, apply) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const changes = [];

    // --- Step 1: Evaluate scene statuses based on shots ---
    const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number').all(projectId);

    for (const scene of scenes) {
        const shots = db.prepare('SELECT id, status FROM film_shots WHERE scene_id = ?').all(scene.id);
        const newSceneStatus = evaluateSceneStatus(scene, shots);

        if (newSceneStatus && newSceneStatus !== scene.status) {
            changes.push({
                type: 'scene',
                id: scene.id,
                scene_number: scene.scene_number,
                from: scene.status,
                to: newSceneStatus,
                reason: getSceneAdvanceReason(scene.status, newSceneStatus, shots)
            });

            if (apply) {
                db.prepare('UPDATE film_scenes SET status = ? WHERE id = ?').run(newSceneStatus, scene.id);
            }
            // Update in-memory for project evaluation
            scene.status = newSceneStatus;
        }
    }

    // --- Step 2: Evaluate project status based on scenes + other conditions ---
    const newProjectStatus = evaluateProjectStatus(project, scenes, projectId);

    if (newProjectStatus && newProjectStatus !== project.status) {
        changes.push({
            type: 'project',
            id: project.id,
            from: project.status,
            to: newProjectStatus,
            reason: getProjectAdvanceReason(project.status, newProjectStatus, scenes, projectId)
        });

        if (apply) {
            db.prepare("UPDATE film_projects SET status = ?, updated_at = datetime('now') WHERE id = ?")
                .run(newProjectStatus, project.id);

            // Auto-update corresponding milestone
            autoAdvanceMilestone(projectId, newProjectStatus);
        }
    }

    // --- Step 3: Return result ---
    const updatedProject = apply
        ? db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId)
        : project;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        applied: apply,
        project_status: updatedProject.status,
        changes,
        summary: buildStatusSummary(projectId)
    }));
}

// --- Scene Status Evaluation ---

function evaluateSceneStatus(scene, shots) {
    const current = scene.status;
    const currentIdx = SCENE_STATUSES.indexOf(current);

    // No shots yet — stay at current
    if (shots.length === 0) return null;

    const statusCounts = {};
    for (const shot of shots) {
        statusCounts[shot.status] = (statusCounts[shot.status] || 0) + 1;
    }

    const total = shots.length;
    const approved = statusCounts['approved'] || 0;
    const complete = statusCounts['complete'] || 0;
    const generating = statusCounts['generating'] || 0;
    const pending = statusCounts['pending'] || 0;

    // All shots approved → scene approved
    if (approved === total && currentIdx < SCENE_STATUSES.indexOf('approved')) {
        return 'approved';
    }

    // All shots complete or approved → scene complete
    if ((complete + approved) === total && currentIdx < SCENE_STATUSES.indexOf('complete')) {
        return 'complete';
    }

    // All shots at least rendered (complete or approved) → scene rendered
    if ((complete + approved) === total && currentIdx < SCENE_STATUSES.indexOf('rendered')) {
        return 'rendered';
    }

    // Any shots generating → scene generating
    if (generating > 0 && currentIdx < SCENE_STATUSES.indexOf('generating')) {
        return 'generating';
    }

    // Scene has shots (broken_down state)
    if (total > 0 && current === 'written') {
        return 'broken_down';
    }

    return null; // No change
}

function getSceneAdvanceReason(from, to, shots) {
    const total = shots.length;
    const statusCounts = {};
    for (const s of shots) statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;

    switch (to) {
        case 'broken_down': return `Scene has ${total} shots`;
        case 'generating': return `${statusCounts['generating'] || 0}/${total} shots generating`;
        case 'rendered': return `All ${total} shots rendered`;
        case 'complete': return `All ${total} shots complete`;
        case 'approved': return `All ${total} shots approved`;
        default: return `Advanced from ${from} to ${to}`;
    }
}

// --- Project Status Evaluation ---

function evaluateProjectStatus(project, scenes, projectId) {
    const current = project.status;
    const currentIdx = PROJECT_PHASES.indexOf(current);
    if (currentIdx === -1 || currentIdx >= PROJECT_PHASES.length - 1) return null;

    // concept → script: has at least one script uploaded
    if (current === 'concept') {
        const scriptCount = db.prepare('SELECT COUNT(*) AS count FROM film_scripts WHERE project_id = ?')
            .get(projectId).count;
        if (scriptCount > 0) return 'script';
    }

    // script → pre-production: has scenes extracted
    if (current === 'script') {
        if (scenes.length > 0) return 'pre-production';
    }

    // pre-production → storyboard: all scenes broken down (have shots)
    if (current === 'pre-production') {
        if (scenes.length > 0) {
            const allBrokenDown = scenes.every(s =>
                SCENE_STATUSES.indexOf(s.status) >= SCENE_STATUSES.indexOf('broken_down')
            );
            if (allBrokenDown) return 'storyboard';
        }
    }

    // storyboard → production: at least one shot generating or complete
    if (current === 'storyboard') {
        const generating = db.prepare(`
            SELECT COUNT(*) AS count FROM film_shots s
            JOIN film_scenes sc ON s.scene_id = sc.id
            WHERE sc.project_id = ? AND s.status IN ('generating', 'complete', 'approved')
        `).get(projectId).count;
        if (generating > 0) return 'production';
    }

    // production → post-production: all shots complete or approved
    if (current === 'production') {
        const totalShots = db.prepare(`
            SELECT COUNT(*) AS count FROM film_shots s
            JOIN film_scenes sc ON s.scene_id = sc.id WHERE sc.project_id = ?
        `).get(projectId).count;

        if (totalShots > 0) {
            const doneShots = db.prepare(`
                SELECT COUNT(*) AS count FROM film_shots s
                JOIN film_scenes sc ON s.scene_id = sc.id
                WHERE sc.project_id = ? AND s.status IN ('complete', 'approved')
            `).get(projectId).count;
            if (doneShots === totalShots) return 'post-production';
        }
    }

    // post-production → review: all scenes complete or approved
    if (current === 'post-production') {
        if (scenes.length > 0) {
            const allComplete = scenes.every(s =>
                SCENE_STATUSES.indexOf(s.status) >= SCENE_STATUSES.indexOf('complete')
            );
            if (allComplete) return 'review';
        }
    }

    // review → export: all scenes approved + no unresolved notes
    if (current === 'review') {
        const allApproved = scenes.length > 0 && scenes.every(s => s.status === 'approved');
        const unresolvedNotes = db.prepare(`
            SELECT COUNT(*) AS count FROM film_shot_notes n
            JOIN film_shots s ON n.shot_id = s.id
            JOIN film_scenes sc ON s.scene_id = sc.id
            WHERE sc.project_id = ? AND n.resolved = 0
        `).get(projectId).count;

        if (allApproved && unresolvedNotes === 0) return 'export';
    }

    // export → complete: manual only (or could check for exported assets)
    // Not auto-advanced — requires explicit user action

    return null;
}

function getProjectAdvanceReason(from, to, scenes, projectId) {
    switch (to) {
        case 'script': return 'Script uploaded';
        case 'pre-production': return `${scenes.length} scenes extracted from screenplay`;
        case 'storyboard': return 'All scenes broken down into shots';
        case 'production': return 'Shot generation has begun';
        case 'post-production': return 'All shots rendered';
        case 'review': return 'All scenes complete, ready for review';
        case 'export': return 'All scenes approved, no unresolved notes';
        case 'complete': return 'Project marked complete';
        default: return `Advanced from ${from} to ${to}`;
    }
}

// --- Milestone auto-advance ---

function autoAdvanceMilestone(projectId, newPhase) {
    // Find milestone matching this phase and mark it in_progress or completed
    const milestone = db.prepare(
        'SELECT * FROM film_milestones WHERE project_id = ? AND phase = ?'
    ).get(projectId, newPhase);

    if (milestone) {
        // Mark previous milestones as completed
        db.prepare(`
            UPDATE film_milestones SET status = 'completed', completion_pct = 100,
                actual_date = date('now'), updated_at = datetime('now')
            WHERE project_id = ? AND sort_order < ? AND status != 'completed' AND status != 'skipped'
        `).run(projectId, milestone.sort_order);

        // Mark current milestone as in_progress
        db.prepare(`
            UPDATE film_milestones SET status = 'in_progress', updated_at = datetime('now')
            WHERE id = ? AND status = 'pending'
        `).run(milestone.id);
    }
}

// --- Status summary ---

function buildStatusSummary(projectId) {
    const sceneCounts = db.prepare(`
        SELECT status, COUNT(*) AS count FROM film_scenes WHERE project_id = ? GROUP BY status
    `).all(projectId);

    const shotCounts = db.prepare(`
        SELECT s.status, COUNT(*) AS count FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ? GROUP BY s.status
    `).all(projectId);

    const totalScenes = sceneCounts.reduce((sum, r) => sum + r.count, 0);
    const totalShots = shotCounts.reduce((sum, r) => sum + r.count, 0);

    const sceneMap = {};
    for (const r of sceneCounts) sceneMap[r.status] = r.count;
    const shotMap = {};
    for (const r of shotCounts) shotMap[r.status] = r.count;

    // Calculate overall completion percentage
    let completionPct = 0;
    if (totalShots > 0) {
        const weightedSum =
            (shotMap['pending'] || 0) * 0 +
            (shotMap['generating'] || 0) * 0.25 +
            (shotMap['complete'] || 0) * 0.75 +
            (shotMap['approved'] || 0) * 1.0;
        completionPct = Math.round((weightedSum / totalShots) * 100);
    }

    return {
        scenes: { total: totalScenes, by_status: sceneMap },
        shots: { total: totalShots, by_status: shotMap },
        completion_pct: completionPct
    };
}

module.exports = { handleProductionStatus, evaluateSceneStatus, evaluateProjectStatus };
