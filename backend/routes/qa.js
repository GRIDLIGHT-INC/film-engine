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
        if (sub === 'broadcast' && req.method === 'GET') return listBroadcastQC(req, res, projectId);
        if (sub === 'broadcast' && req.method === 'POST') return runBroadcastQC(req, res, projectId);
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
    try { results = JSON.parse(run.results || '{}'); } catch (e) { console.error('[qa] stored results is not valid JSON; using the default:', e.message); }

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

// -- Broadcast QC --

function listBroadcastQC(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const reports = db.prepare('SELECT * FROM film_broadcast_qc_reports WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
        .map(row => ({ ...row, checks: parseJSON(row.checks_json, []) }));
    json(res, 200, { project_id: projectId, total: reports.length, reports });
}

function runBroadcastQC(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const targetSpec = (req.body && req.body.target_spec ? String(req.body.target_spec) : 'streaming_rec709').slice(0, 100);
    const checks = buildBroadcastChecks(projectId, project);
    const status = checks.some(check => check.status === 'fail')
        ? 'fail'
        : checks.some(check => check.status === 'warning')
            ? 'warning'
            : 'pass';
    const summary = `${checks.filter(c => c.status === 'pass').length}/${checks.length} delivery-readiness checks passed`;
    const id = generateId();

    db.prepare(`
        INSERT INTO film_broadcast_qc_reports (id, project_id, status, target_spec, checks_json, summary)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, projectId, status, targetSpec, JSON.stringify(checks), summary);

    json(res, 200, {
        id,
        project_id: projectId,
        status,
        target_spec: targetSpec,
        qc_scope: 'metadata_readiness',
        scope_note: 'Checks delivery readiness records in Film Engine. It does not perform waveform, loudness, gamut, caption-file validation, or bitstream analysis.',
        summary,
        checks,
    });
}

/**
 * The deliverables a broadcast QC certifies, and what each one IS.
 *
 * A deliverable is ONE project-level artefact, never a count of shot pieces.
 * `video_master` used to pass by counting per-shot video rows — green on shot
 * 1 of N — and was corrected; `audio_master` was left counting, so any line
 * of generated dialogue reported an audio deliverable registered. Each entry
 * names its asset type, the finder it shares with the conform, and the
 * verdict for absence: a missing film FAILS, while a missing project mix only
 * WARNS, because finishing happens in the NLE and the master ships with the
 * clips' own audio until a mix exists. Iterated, so a third deliverable is
 * checked the same way with nothing to remember.
 */
const { findProjectMaster, findProjectMix } = require('../lib/conform');
const PROJECT_DELIVERABLES = {
    video_master: {
        key: 'video_master', label: 'Final video master registered',
        asset_type: 'video_final', metadata_kind: 'project_master',
        find: findProjectMaster, missing_status: 'fail',
        present: a => `Conformed film registered (${a.file_name}).`,
        absent: n => `No conformed film. ${n} per-shot video_final asset(s) exist; run the conform to produce the master.`,
    },
    audio_master: {
        key: 'audio_master', label: 'Audio deliverable registered',
        asset_type: 'audio_mix', metadata_kind: null,
        find: findProjectMix, missing_status: 'warning',
        present: a => `Project mix registered (${a.file_name}); run external loudness/waveform QC before broadcast delivery.`,
        absent: n => `No project-level mix. ${n} per-shot audio_mix asset(s) exist, and a mix that belongs to one shot `
            + 'is not the film\'s; the master ships with the clips\' own audio until a project mix is registered.',
    },
};

function buildBroadcastChecks(projectId, project) {
    const subtitleLanguages = db.prepare('SELECT language, COUNT(*) AS count FROM film_subtitles WHERE project_id = ? GROUP BY language').all(projectId);
    const colorPipeline = db.prepare('SELECT * FROM film_color_pipelines WHERE project_id = ?').get(projectId);
    const provenanceRows = db.prepare('SELECT COUNT(*) AS count FROM film_provenance_manifests WHERE project_id = ?').get(projectId).count || 0;
    const blockedRights = db.prepare("SELECT COUNT(*) AS count FROM film_rights WHERE project_id = ? AND status IN ('blocked', 'expired', 'restricted', 'unknown')").get(projectId).count || 0;

    // The PROJECT artefacts, through the registry. A count of per-shot pieces
    // is reported in the detail so the reader knows what was declined, and
    // never counts toward the verdict.
    const deliverables = Object.values(PROJECT_DELIVERABLES).map(spec => {
        const found = spec.find(db, projectId);
        const pieces = db.prepare(
            'SELECT COUNT(*) AS n FROM film_assets WHERE project_id = ? AND asset_type = ? AND shot_id IS NOT NULL')
            .get(projectId, spec.asset_type).n || 0;
        return {
            key: spec.key, label: spec.label,
            status: found ? 'pass' : spec.missing_status,
            detail: found ? spec.present(found) : spec.absent(pieces),
        };
    });

    return [
        ...deliverables,
        {
            key: 'captions',
            label: 'Caption/subtitle language coverage',
            status: subtitleLanguages.length > 0 ? 'pass' : 'warning',
            detail: subtitleLanguages.length ? `${subtitleLanguages.map(r => `${r.language}:${r.count}`).join(', ')}; export files still need platform syntax validation.` : 'No subtitle cues are registered.',
        },
        {
            key: 'color_pipeline',
            label: 'ACES/CDL delivery color pipeline',
            status: colorPipeline ? 'pass' : 'warning',
            detail: colorPipeline ? `${colorPipeline.aces_version} ${colorPipeline.working_space} to ${colorPipeline.target_color_space}` : `No ACES/CDL pipeline is registered; project color space is ${project.color_space || 'unspecified'}.`,
        },
        {
            key: 'provenance_disclosure',
            label: 'AI provenance sidecar generated',
            status: provenanceRows > 0 ? 'pass' : 'fail',
            detail: provenanceRows > 0 ? `${provenanceRows} provenance sidecar record(s)` : 'Generate the project provenance sidecar before delivery.',
        },
        {
            key: 'rights_clearance',
            label: 'Rights register clear for delivery',
            status: blockedRights === 0 ? 'pass' : 'fail',
            detail: blockedRights === 0 ? 'No unresolved rights records.' : `${blockedRights} rights record(s) are blocked, expired, restricted, or unknown.`,
        },
    ];
}

function parseJSON(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
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

module.exports = { handleQA, buildBroadcastChecks, PROJECT_DELIVERABLES };
