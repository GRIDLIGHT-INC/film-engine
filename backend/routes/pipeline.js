/**
 * FILM-070-072: Pipeline Orchestrator
 *
 * POST /film/shots/:id/pipeline/run          - Full pipeline for one shot
 * POST /film/shots/:id/pipeline/run/stream    - SSE streaming pipeline
 * POST /film/scenes/:id/pipeline/run         - Pipeline for all shots in a scene
 * POST /film/projects/:id/pipeline/run       - Pipeline for entire project
 * GET  /film/pipeline/:id                    - Get pipeline run status
 * POST /film/pipeline/:id/pause              - Pause pipeline
 * POST /film/pipeline/:id/resume             - Resume pipeline
 * POST /film/pipeline/:id/cancel             - Cancel pipeline
 * GET  /film/projects/:id/pipeline           - List pipeline runs
 */

const { db, generateId } = require('../db/database');
const { callGridlight, serviceUnavailableError } = require('../lib/gridlight-client');
const { resolveGenerator } = require('../lib/providers');
const { auditShotReadiness, auditProjectReadiness } = require('../lib/consistency-context');
const { ensureDir, saveFile, getFileUrl } = require('../lib/file-storage');
const { PIPELINE_STEPS, buildStepPlan, autoSkipSteps, retryDelay, MAX_RETRIES } = require('../lib/pipeline-engine');
const { buildCapabilityPayload, loadShotContext, providerConfigOf } = require('../lib/capability-payloads');
const { buildSchedule, suggestResidency, MODEL_PROFILES } = require('../lib/scheduling-engine');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In-memory pipeline state for pause/cancel
const activePipelines = new Map();

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// -- Route Handler -------------------------------------------------------

function handlePipeline(req, res, urlParts, query) {
    // /film/pipeline/:id[/pause|resume|cancel]
    if (urlParts[1] === 'pipeline' && urlParts[2] && !['shots', 'scenes', 'projects'].includes(urlParts[2])) {
        const runId = urlParts[2];

        if (!urlParts[3] && req.method === 'GET') return getPipelineStatus(req, res, runId);
        if (urlParts[3] === 'pause' && req.method === 'POST') return pausePipeline(req, res, runId);
        if (urlParts[3] === 'resume' && req.method === 'POST') return resumePipeline(req, res, runId);
        if (urlParts[3] === 'cancel' && req.method === 'POST') return cancelPipeline(req, res, runId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/shots/:id/pipeline/run[/stream]
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'pipeline') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        if (urlParts[4] === 'run' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return runShotPipelineStream(req, res, shotId);
            return runShotPipeline(req, res, shotId);
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/scenes/:id/pipeline/run
    if (urlParts[1] === 'scenes' && urlParts[2] && urlParts[3] === 'pipeline') {
        const sceneId = urlParts[2];
        if (!UUID_RE.test(sceneId)) return json(res, 400, { error: 'Invalid scene ID' });

        if (urlParts[4] === 'run' && req.method === 'POST') {
            return runScenePipeline(req, res, sceneId);
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/pipeline[/run]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'pipeline') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        if (urlParts[4] === 'run' && req.method === 'POST') return runProjectPipeline(req, res, projectId);
        if (urlParts[4] === 'schedule' && req.method === 'POST') return buildProjectSchedule(req, res, projectId);
        if (urlParts[4] === 'schedule' && req.method === 'GET') return getLatestSchedule(req, res, projectId);
        if (!urlParts[4] && req.method === 'GET') return listPipelineRuns(req, res, projectId, query);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Step Execution Dispatch ---------------------------------------------

const STEP_ENDPOINTS = {
    keyframe: '/image',
    video: '/video',
    voice: '/voice',
    lipsync: '/lipsync',
    music: '/music',
    sfx: '/music',
    ambient: '/music',
    post: '/postprocess',
    assembly: null, // handled locally
};

// Pipeline step → generation capability. Each step resolves the project's
// configured provider for that capability (Gridlight by default), so the whole
// orchestrated run is provider-aware end-to-end.
const STEP_CAPABILITY = {
    keyframe: 'image', video: 'video', voice: 'voice', lipsync: 'lipsync',
    music: 'music', sfx: 'sfx', ambient: 'ambient', post: 'post',
};

async function executeStep(stepId, shot, scene, project) {
    // Assembly is handled locally (NLE export), not an external generation call.
    if (stepId === 'assembly') {
        return { ok: true, message: 'Assembly step: use export endpoints to finalize' };
    }

    const capability = STEP_CAPABILITY[stepId];
    if (!capability) {
        return { ok: false, error: `Unknown pipeline step '${stepId}'` };
    }

    const config = providerConfigOf(project);

    // Build the SAME payload the per-domain route would build. This used to be
    // { shot_id, scene_id, project_id, step }, which asked the generator to
    // produce a shot from four ids and no prompt: orchestrated runs silently
    // skipped every prompt builder and all consistency context.
    let built;
    try {
        const ctx = loadShotContext(shot.id);
        if (!ctx) return { ok: false, error: `Shot ${shot.id} could not be loaded for step '${stepId}'` };
        built = buildCapabilityPayload(capability, ctx);
    } catch (err) {
        // A missing upstream artefact is work that is not ready, not a failure
        // to retry: no amount of exponential backoff conjures a rendered video
        // for lip-sync to consume. Report it as a skip so the run continues and
        // the reason is visible, and keep retries for genuine faults.
        if (err.code === 'PRECONDITION') {
            return { ok: true, skipped: true, message: err.message, results: [] };
        }
        return { ok: false, error: `Could not build ${capability} payload: ${err.message}` };
    }

    // voice and sfx are one-context-to-many (per dialogue line / per cue), so a
    // step may be several generation calls. A step with nothing to generate —
    // a silent shot, a scene with no cues — is a success with no work, not a
    // failure and not an empty request sent to a paid endpoint.
    const requests = Array.isArray(built.payload) ? built.payload : [built.payload];
    if (requests.length === 0) {
        return { ok: true, skipped: true, message: `No ${capability} work for this shot`, results: [] };
    }

    try {
        // resolveGenerator guarantees a real generator even if a source provider
        // (a licensed catalog, which only searches and licenses) is configured
        // for this capability.
        const generator = resolveGenerator(capability, config);

        const results = [];
        for (const payload of requests) {
            const result = await generator.generate(capability, payload);
            results.push(result);
            if (!result || !result.ok) {
                return { ok: false, error: (result && result.error) || `${capability} generation failed`, results };
            }
        }

        return requests.length === 1
            ? results[0]
            : { ok: true, count: results.length, results };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// -- Run Shot Pipeline (sync) --------------------------------------------

async function runShotPipeline(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}

    // Consistency readiness gate: warn always; block only when strict is requested.
    let readiness = { ready: true, missing: [], warnings: [] };
    try { readiness = auditShotReadiness(shot, scene, project); } catch (_) {}
    const strict = !!(req.body && req.body.strict);
    if (strict && !readiness.ready) {
        return json(res, 409, { error: 'Consistency check blocked the run (strict mode).', readiness });
    }

    const skipSteps = autoSkipSteps(sceneCard, req.body);
    const plan = buildStepPlan({ skip_steps: skipSteps, ...(req.body || {}) });

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_pipeline_runs (id, project_id, shot_id, run_type, status, total_steps, steps_remaining, progress_pct, params)
         VALUES (?, ?, ?, 'shot', 'running', ?, ?, 0, ?)`
    ).run(runId, scene.project_id, shotId, plan.length, JSON.stringify(plan.map(s => s.id)), JSON.stringify(req.body || {}));

    activePipelines.set(runId, { status: 'running' });

    const completedSteps = [];
    const failedSteps = [];

    for (const step of plan) {
        const pipeState = activePipelines.get(runId);
        if (!pipeState || pipeState.status === 'cancelled') {
            db.prepare('UPDATE film_pipeline_runs SET status = ? WHERE id = ?').run('cancelled', runId);
            break;
        }
        if (pipeState.status === 'paused') {
            db.prepare('UPDATE film_pipeline_runs SET status = ? WHERE id = ?').run('paused', runId);
            break;
        }

        db.prepare('UPDATE film_pipeline_runs SET current_step = ? WHERE id = ?').run(step.id, runId);

        let success = false;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const result = await executeStep(step.id, shot, scene, project);
            if (result.ok) {
                completedSteps.push(step.id);
                success = true;
                break;
            }
            if (attempt < MAX_RETRIES - 1) {
                await new Promise(r => setTimeout(r, retryDelay(attempt)));
            }
        }

        if (!success) failedSteps.push(step.id);

        const pct = Math.round((completedSteps.length / plan.length) * 100);
        db.prepare(
            `UPDATE film_pipeline_runs SET steps_completed = ?, steps_failed = ?, steps_remaining = ?, progress_pct = ? WHERE id = ?`
        ).run(JSON.stringify(completedSteps), JSON.stringify(failedSteps),
            JSON.stringify(plan.filter(s => !completedSteps.includes(s.id) && !failedSteps.includes(s.id)).map(s => s.id)),
            pct, runId);
    }

    const finalStatus = failedSteps.length > 0 ? 'completed_with_errors' : 'complete';
    db.prepare('UPDATE film_pipeline_runs SET status = ?, completed_at = datetime(?) WHERE id = ?')
        .run(finalStatus, new Date().toISOString(), runId);
    activePipelines.delete(runId);

    json(res, 200, {
        run_id: runId, shot_id: shotId, status: finalStatus,
        steps_completed: completedSteps, steps_failed: failedSteps,
        total_steps: plan.length, progress_pct: 100,
        readiness,
    });
}

// -- Run Shot Pipeline (SSE) ---------------------------------------------

async function runShotPipelineStream(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}

    // Consistency readiness gate (strict blocks before the stream even opens).
    let readiness = { ready: true, missing: [], warnings: [] };
    try { readiness = auditShotReadiness(shot, scene, project); } catch (_) {}
    if (!!(req.body && req.body.strict) && !readiness.ready) {
        return json(res, 409, { error: 'Consistency check blocked the run (strict mode).', readiness });
    }

    const skipSteps = autoSkipSteps(sceneCard, req.body);
    const plan = buildStepPlan({ skip_steps: skipSteps, ...(req.body || {}) });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };

    // Surface readiness warnings up front so the UI can show them.
    sendEvent({ type: 'readiness', ready: readiness.ready, missing: readiness.missing || [], warnings: readiness.warnings || [] });

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_pipeline_runs (id, project_id, shot_id, run_type, status, total_steps, progress_pct)
         VALUES (?, ?, ?, 'shot', 'running', ?, 0)`
    ).run(runId, scene.project_id, shotId, plan.length);

    activePipelines.set(runId, { status: 'running' });

    sendEvent({ type: 'status', phase: 'starting', run_id: runId, shot_id: shotId, total_steps: plan.length,
        steps: plan.map(s => ({ id: s.id, name: s.name })) });

    const completedSteps = [];

    for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        const pipeState = activePipelines.get(runId);
        // Treat a client disconnect like a cancellation so we stop firing GPU steps.
        if (clientGone || res.writableEnded || !pipeState || pipeState.status === 'cancelled') {
            if (!clientGone) sendEvent({ type: 'cancelled', run_id: runId });
            db.prepare('UPDATE film_pipeline_runs SET status = ? WHERE id = ?').run('cancelled', runId);
            activePipelines.delete(runId);
            if (!res.writableEnded) { try { res.end(); } catch (_) {} }
            return;
        }

        sendEvent({ type: 'step_start', step_id: step.id, step_name: step.name, step_index: i, total_steps: plan.length });

        let success = false;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const result = await executeStep(step.id, shot, scene, project);
            if (result.ok) {
                completedSteps.push(step.id);
                success = true;
                sendEvent({ type: 'step_complete', step_id: step.id, step_index: i, progress_pct: Math.round(((i + 1) / plan.length) * 100) });
                break;
            }
            if (attempt < MAX_RETRIES - 1) {
                sendEvent({ type: 'step_retry', step_id: step.id, attempt: attempt + 1 });
                await new Promise(r => setTimeout(r, retryDelay(attempt)));
            }
        }

        if (!success) {
            sendEvent({ type: 'step_failed', step_id: step.id, step_index: i });
        }
    }

    db.prepare('UPDATE film_pipeline_runs SET status = ?, completed_at = datetime(?) WHERE id = ?')
        .run('complete', new Date().toISOString(), runId);
    activePipelines.delete(runId);

    sendEvent({ type: 'result', run_id: runId, steps_completed: completedSteps, total_steps: plan.length });
    sendEvent({ type: 'done' });
    res.end();
}

// -- Run Scene Pipeline --------------------------------------------------

async function runScenePipeline(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const shots = db.prepare('SELECT * FROM film_shots WHERE scene_id = ? ORDER BY shot_code').all(sceneId);

    // Consistency readiness across the scene's shots (strict blocks the whole scene).
    const shotReadiness = shots.map(s => {
        try { return { shot_id: s.id, shot_code: s.shot_code, ...auditShotReadiness(s, scene, null) }; }
        catch (_) { return { shot_id: s.id, shot_code: s.shot_code, ready: true, missing: [], warnings: [] }; }
    });
    const sceneReadiness = { ready: shotReadiness.every(r => r.ready), shots: shotReadiness, missing: shotReadiness.flatMap(r => r.missing || []) };
    if (!!(req.body && req.body.strict) && !sceneReadiness.ready) {
        return json(res, 409, { error: 'Consistency check blocked the scene run (strict mode).', readiness: sceneReadiness });
    }

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_pipeline_runs (id, project_id, scene_id, run_type, status, total_steps, progress_pct)
         VALUES (?, ?, ?, 'scene', 'running', ?, 0)`
    ).run(runId, scene.project_id, sceneId, shots.length);

    json(res, 202, {
        run_id: runId, scene_id: sceneId, status: 'running',
        total_shots: shots.length,
        shots: shots.map(s => ({ shot_id: s.id, shot_code: s.shot_code })),
        readiness: sceneReadiness,
        hint: 'Scene pipeline is running. Check status at GET /film/pipeline/' + runId,
    });
}

// -- Run Project Pipeline ------------------------------------------------

async function runProjectPipeline(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number').all(projectId);
    const totalShots = db.prepare(
        'SELECT COUNT(*) as count FROM film_shots s JOIN film_scenes sc ON s.scene_id = sc.id WHERE sc.project_id = ?'
    ).get(projectId).count;

    // Consistency readiness across the whole project (strict blocks the run).
    let readiness = { ready: true, shots: [], missing: [] };
    try { readiness = auditProjectReadiness(projectId); } catch (_) {}
    if (!!(req.body && req.body.strict) && !readiness.ready) {
        return json(res, 409, { error: 'Consistency check blocked the project run (strict mode).', readiness });
    }

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_pipeline_runs (id, project_id, run_type, status, total_steps, progress_pct)
         VALUES (?, ?, 'project', 'running', ?, 0)`
    ).run(runId, projectId, totalShots);

    json(res, 202, {
        run_id: runId, project_id: projectId, status: 'running',
        total_scenes: scenes.length, total_shots: totalShots,
        readiness,
        hint: 'Project pipeline is running. Check status at GET /film/pipeline/' + runId,
    });
}

// -- Pipeline Control ----------------------------------------------------

function getPipelineStatus(req, res, runId) {
    const run = db.prepare('SELECT * FROM film_pipeline_runs WHERE id = ?').get(runId);
    if (!run) return json(res, 404, { error: 'Pipeline run not found' });

    json(res, 200, {
        ...run,
        steps_completed: run.steps_completed ? JSON.parse(run.steps_completed) : [],
        steps_remaining: run.steps_remaining ? JSON.parse(run.steps_remaining) : [],
        steps_failed: run.steps_failed ? JSON.parse(run.steps_failed) : [],
    });
}

function pausePipeline(req, res, runId) {
    const run = db.prepare('SELECT * FROM film_pipeline_runs WHERE id = ?').get(runId);
    if (!run) return json(res, 404, { error: 'Pipeline run not found' });

    if (activePipelines.has(runId)) {
        activePipelines.set(runId, { status: 'paused' });
    }
    db.prepare('UPDATE film_pipeline_runs SET status = ? WHERE id = ?').run('paused', runId);
    json(res, 200, { run_id: runId, status: 'paused' });
}

function resumePipeline(req, res, runId) {
    const run = db.prepare('SELECT * FROM film_pipeline_runs WHERE id = ?').get(runId);
    if (!run) return json(res, 404, { error: 'Pipeline run not found' });

    if (activePipelines.has(runId)) {
        activePipelines.set(runId, { status: 'running' });
    }
    db.prepare('UPDATE film_pipeline_runs SET status = ? WHERE id = ?').run('running', runId);
    json(res, 200, { run_id: runId, status: 'running' });
}

function cancelPipeline(req, res, runId) {
    const run = db.prepare('SELECT * FROM film_pipeline_runs WHERE id = ?').get(runId);
    if (!run) return json(res, 404, { error: 'Pipeline run not found' });

    if (activePipelines.has(runId)) {
        activePipelines.set(runId, { status: 'cancelled' });
    }
    db.prepare('UPDATE film_pipeline_runs SET status = ? WHERE id = ?').run('cancelled', runId);
    json(res, 200, { run_id: runId, status: 'cancelled' });
}

// -- List Pipeline Runs --------------------------------------------------

function listPipelineRuns(req, res, projectId, query) {
    const status = query.status || null;
    let jobs;
    if (status) {
        jobs = db.prepare('SELECT * FROM film_pipeline_runs WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(projectId, status);
    } else {
        jobs = db.prepare('SELECT * FROM film_pipeline_runs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
    }
    json(res, 200, { project_id: projectId, total: jobs.length, runs: jobs });
}

// -- FILM-072: Smart Scheduling & Model Residency -------------------------

function buildProjectSchedule(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_card_yaml FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    // Determine steps per shot
    const shotPlans = shots.map(shot => {
        let sceneCard = {};
        try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}
        const skipSteps = autoSkipSteps(sceneCard, req.body);
        const plan = buildStepPlan({ skip_steps: skipSteps, ...(req.body || {}) });
        return {
            shot_id: shot.shot_id,
            shot_code: shot.shot_code,
            steps: plan.map(s => s.id),
        };
    });

    const schedule = buildSchedule(shotPlans, {
        batch_by_model: !(req.body && req.body.batch_by_model === false),
        vram_budget_gb: (req.body && req.body.vram_budget_gb) || undefined,
        priority_shots: (req.body && req.body.priority_shots) || [],
    });

    const residency = suggestResidency(schedule, (req.body && req.body.vram_budget_gb) || undefined);

    // Save to DB
    const scheduleId = generateId();
    db.prepare(
        `INSERT INTO film_schedule_runs (id, project_id, status, phase_count, estimated_load_time_s, estimated_swaps, schedule_data, residency_data)
         VALUES (?, ?, 'ready', ?, ?, ?, ?, ?)`
    ).run(scheduleId, projectId, schedule.phases.length, schedule.estimated_load_time_s,
        schedule.estimated_swaps, JSON.stringify(schedule), JSON.stringify(residency));

    json(res, 200, {
        schedule_id: scheduleId, project_id: projectId,
        total_shots: shots.length, ...schedule, residency,
        model_profiles: MODEL_PROFILES,
    });
}

function getLatestSchedule(req, res, projectId) {
    const run = db.prepare(
        'SELECT * FROM film_schedule_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(projectId);

    if (!run) return json(res, 404, { error: 'No schedule found. Create one first.' });

    let schedule = {}, residency = {};
    try { schedule = JSON.parse(run.schedule_data || '{}'); } catch (_) {}
    try { residency = JSON.parse(run.residency_data || '{}'); } catch (_) {}

    json(res, 200, { ...run, schedule, residency });
}

module.exports = { handlePipeline };
