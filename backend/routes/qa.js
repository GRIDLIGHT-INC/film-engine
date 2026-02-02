/**
 * FILM-073-075: QA & Quality Gates
 *
 * POST /film/projects/:id/qa/run              - Run full project QA
 * POST /film/scenes/:id/qa/run                - Run scene QA
 * POST /film/shots/:id/qa/run                 - Run shot QA
 * GET  /film/projects/:id/qa                  - List QA runs
 * GET  /film/projects/:id/qa/latest           - Latest QA results
 * GET  /film/projects/:id/qa/continuity       - Continuity report
 * GET  /film/projects/:id/qa/rubric           - Acceptance rubric
 */

const { db, generateId } = require('../db/database');
const { runProjectQA, runSceneQA, runShotQA, checkContinuity, ACCEPTANCE_RUBRIC, QA_CHECKS } = require('../lib/qa-checker');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function handleQA(req, res, urlParts, query) {
    // /film/projects/:id/qa[/run|/latest|/continuity|/rubric]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'qa') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        const sub = urlParts[4];
        if (sub === 'run' && req.method === 'POST') return runProjectQAEndpoint(req, res, projectId);
        if (sub === 'latest' && req.method === 'GET') return getLatestQA(req, res, projectId);
        if (sub === 'continuity' && req.method === 'GET') return getContinuity(req, res, projectId);
        if (sub === 'rubric' && req.method === 'GET') return getRubric(req, res);
        if (!sub && req.method === 'GET') return listQARuns(req, res, projectId, query);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/scenes/:id/qa/run
    if (urlParts[1] === 'scenes' && urlParts[2] && urlParts[3] === 'qa') {
        const sceneId = urlParts[2];
        if (!UUID_RE.test(sceneId)) return json(res, 400, { error: 'Invalid scene ID' });

        if (urlParts[4] === 'run' && req.method === 'POST') return runSceneQAEndpoint(req, res, sceneId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/shots/:id/qa/run
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'qa') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        if (urlParts[4] === 'run' && req.method === 'POST') return runShotQAEndpoint(req, res, shotId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Project QA --

function runProjectQAEndpoint(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const result = runProjectQA(projectId, db);

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_qa_runs (id, project_id, scope, status, total_checks, passed, failed, warnings, results)
         VALUES (?, ?, 'project', 'complete', ?, ?, ?, ?, ?)`
    ).run(runId, projectId,
        result.checks.length, result.passed, result.failed, result.warnings,
        JSON.stringify(result));

    json(res, 200, { run_id: runId, ...result });
}

function getLatestQA(req, res, projectId) {
    const run = db.prepare(
        "SELECT * FROM film_qa_runs WHERE project_id = ? AND scope = 'project' ORDER BY created_at DESC LIMIT 1"
    ).get(projectId);

    if (!run) return json(res, 404, { error: 'No QA runs found. Run QA first.' });

    let results = {};
    try { results = JSON.parse(run.results || '{}'); } catch (_) {}

    json(res, 200, { ...run, results });
}

function getContinuity(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const report = checkContinuity(projectId, db);
    json(res, 200, report);
}

function getRubric(req, res) {
    json(res, 200, { rubric: ACCEPTANCE_RUBRIC, checks: QA_CHECKS });
}

function listQARuns(req, res, projectId, query) {
    const scope = query.scope || null;
    let sql = 'SELECT id, project_id, scene_id, shot_id, scope, status, total_checks, passed, failed, warnings, created_at FROM film_qa_runs WHERE project_id = ?';
    const params = [projectId];
    if (scope) { sql += ' AND scope = ?'; params.push(scope); }
    sql += ' ORDER BY created_at DESC';

    const runs = db.prepare(sql).all(...params);
    json(res, 200, { project_id: projectId, total: runs.length, runs });
}

// -- Scene QA --

function runSceneQAEndpoint(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const result = runSceneQA(sceneId, db);

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_qa_runs (id, project_id, scene_id, scope, status, total_checks, passed, failed, warnings, results)
         VALUES (?, ?, ?, 'scene', 'complete', ?, ?, ?, ?, ?)`
    ).run(runId, scene.project_id, sceneId,
        result.checks.length, result.passed, result.failed, result.warnings,
        JSON.stringify(result));

    json(res, 200, { run_id: runId, ...result });
}

// -- Shot QA --

function runShotQAEndpoint(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const result = runShotQA(shotId, db);

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_qa_runs (id, project_id, shot_id, scope, status, total_checks, passed, failed, warnings, results)
         VALUES (?, ?, ?, 'shot', 'complete', ?, ?, ?, ?, ?)`
    ).run(runId, scene.project_id, shotId,
        result.checks.length, result.passed, result.failed, result.warnings,
        JSON.stringify(result));

    json(res, 200, { run_id: runId, ...result });
}

module.exports = { handleQA };
