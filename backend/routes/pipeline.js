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
const { buildCapabilityPayload, loadShotContext, providerConfigOf, persistCapabilityResult } = require('../lib/capability-payloads');
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


// Where each orchestrated capability's output lands, and under what filename.
// A capability missing from here would generate media that goes nowhere, so
// tests assert this covers STEP_CAPABILITY rather than trusting it.
// capability → extension and → asset_type, from the ONE registry. These were
// two literal tables here and a third in capability-payloads.js; a wrong
// asset_type fails the CHECK at insert and turns a paid-for generation into a
// failed step, so the fact is stated once and read three times.
const { PERSIST_EXT, ASSET_TYPE } = require('../lib/media-kinds');

/**
 * Save what a step generated.
 *
 * The orchestrator used to call a generator and throw the result away. An
 * orchestrated run therefore produced NO assets at all — which is why lipsync
 * and post could never find their inputs mid-run, and skipped. Flow node
 * handlers persisted from the start; this is the legacy path catching up.
 *
 * Returns { ok } rather than throwing: a step that generated but could not save
 * must be reported as failed, because a "complete" pipeline with no output is
 * the worse outcome.
 */
async function persistStepResult(stepId, capability, result, ctx) {
    if (!PERSIST_EXT[capability]) {
        return { ok: false, error: `no storage mapping for capability '${capability}'` };
    }
    if (!result || !result.ok || result.data === undefined || result.data === null) {
        return { ok: false, error: 'nothing to persist' };
    }

    const shot = ctx && ctx.shot;
    const scene = ctx && ctx.scene;
    const code = (shot && shot.shot_code) || (shot && shot.id) || 'shot';
    const filename = `${code}_${stepId}.${PERSIST_EXT[capability]}`;

    try {
        const saved = await persistCapabilityResult(capability, result, ctx, filename);

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_path, file_name, version, license_source, license_status, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'generated', 'generated', ?)`
        ).run(
            assetId,
            (scene && scene.project_id) || null,
            (shot && shot.id) || null,
            (scene && scene.id) || null,
            ASSET_TYPE[capability] || 'other',
            saved.path,
            filename,
            JSON.stringify({ source: 'pipeline', step: stepId })
        );

        // Record what this was generated FROM, so a later edit to the card,
        // a character or the style preset can mark it stale instead of leaving
        // it looking current forever. Capability maps 1:1 onto the artefact
        // kind registry, so no second mapping is introduced here.
        const KIND_FOR_CAPABILITY = {
            image: 'keyframe', video: 'video', voice: 'voice', lipsync: 'lipsync',
            music: 'music', sfx: 'sfx', ambient: 'ambient', post: 'post',
        };
        require('../lib/artefact-fingerprint')
            .stampAsset(assetId, KIND_FOR_CAPABILITY[capability], { shotId: (shot && shot.id) || null });

        return { ok: true, assetId, path: saved.path };
    } catch (err) {
        return { ok: false, error: `could not persist ${capability} output: ${err.message}` };
    }
}

/** Capabilities this function knows how to store. */
persistStepResult.supports = capability => !!PERSIST_EXT[capability];

async function executeStep(stepId, shot, scene, project) {
    // Assembly conforms the shots into one film. It used to return a hardcoded
    // success with a message telling the caller to go and do it themselves, so
    // an orchestrated run reported complete and produced no movie — the single
    // line standing between this product and its own acceptance criterion.
    if (stepId === 'assembly') {
        const { runConform } = require('../lib/conform');
        const projectId = (scene && scene.project_id) || (project && project.id);
        const result = await runConform(projectId);
        if (result.ok) {
            return { ok: true, message: `Conformed ${result.plan.clips.length} shots`, assetId: result.asset_id, output: result.output };
        }
        // A conform that could not run is a FAILED step, not a quiet success.
        // The previous behaviour is exactly what let a run look finished.
        //
        // And it says whether trying again could help. The conform is local
        // and deterministic — the same files give the same answer — so a
        // missing shot retried three times with backoff is forty-five seconds
        // of certainty that the shot is still missing.
        const verdict = CONFORM_STATES[result.state];
        return {
            ok: false, code: result.state, error: result.error, plan: result.plan,
            permanent: verdict ? verdict.permanent : false,
            // The whole executor walk, forwarded rather than flattened to a
            // line: the runners carry it to the event, the response and the
            // run row, so a failed film says what was tried and what was not.
            walk: result.walk || [], walk_stage: result.walk_stage || null,
        };
    }

    const capability = STEP_CAPABILITY[stepId];
    if (!capability) {
        return { ok: false, error: `Unknown pipeline step '${stepId}'` };
    }

    // Refuse to build on a rotten foundation.
    //
    // Generating a clip from a keyframe that no longer matches its character,
    // or a lip-sync from a clip that was regenerated afterwards, spends money
    // to produce something already known to be wrong. This fires ONLY when a
    // dependency was stamped and its inputs have since changed, so a project
    // that predates fingerprinting is never gated and generates exactly as
    // before. Overridable the way the budget gate is — a wrong fingerprint must
    // not make a shot ungeneratable, but you have to say so.
    if (!(project && project.ignore_stale)) {
        const stale = require('../lib/artefact-fingerprint').staleInputs(stepId, { shotId: shot && shot.id });
        if (stale.length) {
            return {
                ok: false,
                code: 'STALE_INPUTS',
                error: `${stepId} would be generated from ${stale.length} input(s) that changed after they were made: `
                    + stale.map(s => s.kind).join(', ')
                    + '. Regenerate those first, or pass ignore_stale.',
                stale,
            };
        }
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

            // Save it. Generating and discarding is what left orchestrated runs
            // with no assets and downstream steps with nothing to consume.
            const saved = await persistStepResult(stepId, capability, result, { shot, scene, project });
            if (!saved.ok) {
                return { ok: false, error: saved.error, results };
            }
            result.assetId = saved.assetId;

            /*
             * RECORD A VIDEO ATTEMPT. The orchestrator generated clips and
             * recorded none, which is one of the three paths that left
             * film_video_attempts empty after real generation. Only `video`:
             * the table is about which model rendered which SHAPE of shot, and
             * a music cue has no shot shape.
             */
            if (capability === 'video') {
                try {
                    let vCard = {};
                    try { vCard = JSON.parse((shot && shot.scene_card_yaml) || '{}'); } catch (_) { vCard = {}; }
                    require('../lib/video-attempt').recordVideoAttempt(db, {
                        shotId: shot && shot.id, projectId: project && project.id,
                        shotVersion: shot && shot.current_frame_version,
                        provider: result.provider || '', model: result.provider_model || '',
                        durationSeconds: vCard.duration_seconds || null,
                        sceneCard: vCard, assetId: saved.assetId,
                    });
                } catch (_) { /* never fail a step that already cost money */ }
            }
        }

        return requests.length === 1
            ? results[0]
            : { ok: true, count: results.length, results };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/*
 * A scene's score is not a property of one shot.
 *
 * Every step in PIPELINE_STEPS declares a `scope`, and this file used to
 * contain no reading of it: the runners walked shots and ran the whole plan on
 * each one, so `music` and `ambient` — both scene-scoped, both built from
 * ctx.scene and byte-identical for every shot in it — were generated once per
 * SHOT. Measured on a real 13-shot, 3-scene project: 13 music payloads and 13
 * ambient payloads where 3 and 3 were the work. Nothing failed. You were billed
 * 4.3x for those two steps and the surplus rows accumulated, because
 * persistStepResult inserts rather than replaces.
 *
 * Derived from the registry rather than naming music and ambient here, so a
 * tenth step declared scene-scoped later is covered with nothing to remember.
 * That is the whole reason this defect existed: the field was declared, was
 * consumed by preflight, media-kinds, the media importer and the MCP layer, and
 * was never read by the thing it was written for.
 */
const SCENE_SCOPED = new Set(PIPELINE_STEPS.filter(s => s.scope === 'scene').map(s => s.id));

/** The key a scene-scoped step is deduplicated on — the scene, not the shot. */
function sceneStepKey(stepId, scene) {
    return stepId + ':' + ((scene && scene.id) || 'no-scene');
}

/**
 * Should this step run, given what a run has already done?
 *
 * Two rules, both from `scope`:
 *
 *  - On a run over several shots, a scene-scoped step executes ONCE per scene.
 *  - On a single-shot run it does not execute at all by default. You asked for
 *    this shot; the scene's score is not this shot's, and running five shots
 *    one at a time would otherwise buy five scores exactly as the old bug did.
 *    `include_scene_steps` opts in for the case where you do want the scene
 *    finished alongside its shot.
 *
 * Skipping is REPORTED rather than silent. A step that quietly does nothing is
 * indistinguishable from one that ran, which is how the original defect went
 * unnoticed: the run said complete either way.
 */
function sceneScopeGate(stepId, scene, done, opts) {
    if (!SCENE_SCOPED.has(stepId)) return { run: true };
    const key = sceneStepKey(stepId, scene);
    if (done.has(key)) {
        return { run: false, reason: (opts && opts.shotRun && !(opts && opts.includeSceneSteps))
            ? 'belongs to the scene, not this shot — pass include_scene_steps to generate it'
            : 'already generated for this scene in this run' };
    }
    done.add(key);
    return { run: true };
}

/*
 * THE FILM IS MADE ONCE, AT THE END.
 *
 * `assembly` conforms the whole film, and the registry declared it shot-scoped,
 * so the runner did what the registry said: a project run conformed the film
 * once PER SHOT. On a fresh run the first N-1 attempts necessarily refused —
 * later shots had no footage yet — each was retried three times with backoff,
 * and the run ended `completed_with_errors` even when the last conform made
 * the film. A single-shot run conformed the whole film too, and refused, so
 * every shot run during production reported errors about a film nobody had
 * asked for yet: the warning you learn to ignore.
 *
 * The rule is the one scene scope already established, one rung up: a step
 * runs by default on runs AT OR ABOVE its scope, once, and is skipped WITH A
 * REASON below it unless the caller opts in (`include_project_steps`, the
 * sibling of `include_scene_steps`). Derived from the registry, so a second
 * whole-film step is covered with nothing to remember.
 */
const PROJECT_SCOPED = new Set(PIPELINE_STEPS.filter(s => s.scope === 'project').map(s => s.id));

/** What runs per shot, and what runs once for the whole film. */
function splitPlan(plan) {
    return {
        perShot: plan.filter(s => !PROJECT_SCOPED.has(s.id)),
        project: plan.filter(s => PROJECT_SCOPED.has(s.id)),
    };
}

/**
 * Every outcome the conform can return, and whether a second attempt could
 * change it. The states are the conform's and the stitcher's own; a state
 * added there and not here is caught by tests/assembly-once.test.js, because
 * an unclassified refusal would be retried by default — the defect this table
 * exists to end. Only the encoder itself can fail transiently.
 */
const CONFORM_STATES = {
    produced:      { permanent: false },   // not a failure; here so the table is complete
    missing_shots: { permanent: true },    // a shot with no footage is still missing on the retry
    no_executor:   { permanent: true },    // no encoder appears in the next five seconds
    no_clips:      { permanent: true },
    missing_clip:  { permanent: true },    // a file that is not on disk
    invalid_clip:  { permanent: true },    // a file that does not decode
    failed:        { permanent: false },   // the encoder crashed or timed out
};

/**
 * What a run is called when it ends. ONE rule, read by every runner: the JSON
 * shot runner, the SSE shot runner and the scene/project runner each decided
 * this inline, which is how the stream once said `complete` while the JSON
 * runner said `completed_with_errors` for the same work.
 *
 * A failed shot step leaves a film with a hole in it: completed_with_errors.
 * A failed whole-film step leaves NO film, and a run whose deliverable does
 * not exist is not completed in any sense — the stance persistStepResult
 * already takes for a step that generated and could not save.
 */
function runStatus({ failed, projectFailed }) {
    if (projectFailed && projectFailed.length) return 'failed';
    return failed && failed.length ? 'completed_with_errors' : 'complete';
}

/** What a failed step is recorded as: the id, the code, the error, the walk. */
function failureOf(step, result) {
    return {
        step: step.id, code: (result && result.code) || null,
        error: (result && result.error) || 'failed',
        walk: (result && result.walk) || [],
    };
}

/**
 * One step, with its retries. The ONLY attempt loop, so the no-retry rule for
 * a permanent refusal holds wherever a step is run — per shot or per film.
 */
async function attemptStep(step, ctx, hooks, i) {
    const h = hooks || {};
    let result;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        result = await executeStep(step.id, ctx.shot, ctx.scene, ctx.project);
        if (result.ok) {
            if (h.onComplete) h.onComplete(step, i, result);
            return { ok: true, result };
        }
        if (result.permanent || attempt === MAX_RETRIES - 1) break;
        if (h.onRetry) h.onRetry(step, attempt);
        await new Promise(r => setTimeout(r, retryDelay(attempt)));
    }
    if (h.onFailed) h.onFailed(step, i, result);
    return { ok: false, result };
}

/**
 * The whole-film steps, after every shot of a run has had its turn.
 *
 * Below their scope they are skipped and SAID to be skipped, with the way in
 * named: a step that quietly does nothing is indistinguishable from one that
 * ran, which is how assembly's placeholder survived for as long as it did.
 */
async function runProjectSteps(steps, { project, opts, hooks, offset }) {
    const h = hooks || {};
    const completed = [], failed = [], skipped = [], failures = [];
    for (let j = 0; j < steps.length; j++) {
        const step = steps[j];
        const i = (offset || 0) + j;

        const stop = h.shouldStop && h.shouldStop();
        if (stop) return { completed, failed, skipped, failures, stopped: stop };

        if (!(opts && opts.runProjectSteps)) {
            const reason = `belongs to the whole film, not this ${(opts && opts.runType) || 'run'} `
                + '— pass include_project_steps to make it here';
            skipped.push({ step_id: step.id, reason });
            if (h.onSkip) h.onSkip(step, reason, i);
            continue;
        }

        if (h.onStart) h.onStart(step, i);
        const out = await attemptStep(step, { shot: null, scene: null, project }, h, i);
        (out.ok ? completed : failed).push(step.id);
        if (!out.ok) failures.push(failureOf(step, out.result));
        if (h.onProgress) h.onProgress(completed, failed, skipped, i, steps.length);
    }
    return { completed, failed, skipped, failures, stopped: null };
}

/**
 * Refuse a run that would make the film on a machine that cannot.
 *
 * The preflight is a CLI a person may not run. The runner itself spent every
 * generation step and found out at the END — at assembly, the last step —
 * that no encoder existed, which is the most expensive possible moment to
 * learn it. So a run that WILL execute a whole-film step asks that step's
 * declared dependency first, through the same checker the preflight uses, and
 * refuses before the run row exists. A run that will not make the film — a
 * shot run that did not ask for it — has nothing to preflight.
 *
 * Overridable with `ignore_preflight`, the way every other gate here is: the
 * generation is still worth having, and the conform can happen later on a
 * machine that has the encoder. The refusal then arrives from the step
 * itself, honestly, at the end.
 */
function preflightProjectSteps(projectSteps, body, willRun) {
    if (!willRun || !projectSteps.length || (body && body.ignore_preflight)) return null;
    const { checkStageDependency } = require('../lib/e2e-preflight');
    for (const step of projectSteps) {
        const verdict = checkStageDependency(step.id);
        if (verdict && verdict.verdict === 'blocked') {
            return {
                error: `${step.id} cannot run on this machine: ${verdict.reasons[0] || 'its dependency is missing'}`,
                code: 'PREFLIGHT_BLOCKED', step: step.id, dependency: verdict.dependency,
                reasons: verdict.reasons, fixes: verdict.fixes,
                hint: 'Fix the dependency, pass ignore_preflight to generate now and conform later, '
                    + `or skip_steps: ["${step.id}"].`,
            };
        }
    }
    return null;
}

/**
 * Run a step plan for ONE shot.
 *
 * Extracted because three runners needed it and two of them had their own copy
 * of the loop while the third had none at all. A gate applied to two loops out
 * of three is worse than no gate: the surface that skipped correctly would make
 * the one that did not look like a data problem.
 *
 * `done` is shared across the shots of a run — that sharing IS the fix for
 * scene scope. `hooks` carries the differences between a JSON response and an
 * SSE stream, so neither runner owns sequencing.
 */
async function runShotPlan(plan, { shot, scene, project, done, opts, hooks }) {
    const h = hooks || {};
    const completed = [], failed = [], skipped = [], failures = [];
    const covered = coveredFor(project);

    for (let i = 0; i < plan.length; i++) {
        const step = plan[i];

        const stop = h.shouldStop && h.shouldStop();
        if (stop) return { completed, failed, skipped, failures, stopped: stop };

        const scored = scoreGate(step.id, scene, covered);
        if (!scored.run) {
            skipped.push({ step_id: step.id, reason: scored.reason });
            if (h.onSkip) h.onSkip(step, scored.reason, i);
            continue;
        }

        const gate = sceneScopeGate(step.id, scene, done, opts);
        if (!gate.run) {
            skipped.push({ step_id: step.id, reason: gate.reason });
            if (h.onSkip) h.onSkip(step, gate.reason, i);
            continue;
        }

        if (h.onStart) h.onStart(step, i);

        const attempt = await attemptStep(step, { shot, scene, project }, h, i);
        const success = attempt.ok;
        if (success) completed.push(step.id);

        if (!success) {
            failed.push(step.id);
            failures.push(failureOf(step, attempt.result));
            /*
             * A scene-scoped step that failed must be releasable, or one bad
             * attempt on the first shot means the scene silently never gets its
             * score: the key would stay claimed for the rest of the run.
             */
            if (SCENE_SCOPED.has(step.id)) done.delete(sceneStepKey(step.id, scene));
        }

        if (h.onProgress) h.onProgress(completed, failed, skipped, i, plan.length);
    }

    return { completed, failed, skipped, failures, stopped: null };
}

/**
 * An approved score is the music of the scenes it covers (MUS-020). The
 * scene music step would generate a second score to be layered under it, so
 * for a covered scene it is skipped, and the skip names the session. Ambience
 * and effects are not music and still run.
 */
const SCORE_REPLACES_STEPS = new Set(['music']);
function scoreGate(stepId, scene, covered) {
    if (!SCORE_REPLACES_STEPS.has(stepId) || !scene || !covered) return { run: true };
    const sc = covered.get(scene.id);
    if (!sc) return { run: true };
    return { run: false, reason: `the approved score "${sc.name}" is this scene's music; no second score is generated under it — unapprove the session to score the scene on its own` };
}
function coveredFor(project) {
    if (!project || !project.id) return new Map();
    try { return require('../lib/music-approval').coveredScenes(db, project.id); } catch (_) { return new Map(); }
}

/**
 * The set a single-shot run starts with: every scene-scoped step already
 * "claimed", so none of them fire. Opting in hands back an empty set, which is
 * the same mechanism a scene run uses — one rule, not two.
 */
function shotRunDoneSet(scene, body) {
    const done = new Set();
    if (!(body && body.include_scene_steps)) {
        for (const stepId of SCENE_SCOPED) done.add(sceneStepKey(stepId, scene));
    }
    return done;
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
    const { perShot, project: projectSteps } = splitPlan(plan);

    const gate = preflightProjectSteps(projectSteps, req.body, !!(req.body && req.body.include_project_steps));
    if (gate) return json(res, 409, gate);

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_pipeline_runs (id, project_id, shot_id, run_type, status, total_steps, steps_remaining, progress_pct, params)
         VALUES (?, ?, ?, 'shot', 'running', ?, ?, 0, ?)`
    ).run(runId, scene.project_id, shotId, plan.length, JSON.stringify(plan.map(s => s.id)), JSON.stringify(req.body || {}));

    activePipelines.set(runId, { status: 'running' });

    const shouldStop = () => {
        const st = activePipelines.get(runId);
        if (!st || st.status === 'cancelled') return 'cancelled';
        if (st.status === 'paused') return 'paused';
        return null;
    };
    const onStart = step => {
        db.prepare('UPDATE film_pipeline_runs SET current_step = ? WHERE id = ?').run(step.id, runId);
    };
    const progress = (completed, failed, skipped) => {
        const pct = Math.round((completed.length / Math.max(plan.length, 1)) * 100);
        const settled = new Set([...completed, ...failed, ...skipped.map(sk => sk.step_id)]);
        db.prepare(
            `UPDATE film_pipeline_runs SET steps_completed = ?, steps_failed = ?, steps_skipped = ?, steps_remaining = ?, progress_pct = ? WHERE id = ?`
        ).run(JSON.stringify(completed), JSON.stringify(failed), JSON.stringify(skipped),
            JSON.stringify(plan.filter(s => !settled.has(s.id)).map(s => s.id)), pct, runId);
    };

    const done = shotRunDoneSet(scene, req.body);
    const outcome = await runShotPlan(perShot, {
        shot, scene, project, done,
        opts: { shotRun: true, includeSceneSteps: !!(req.body && req.body.include_scene_steps) },
        hooks: { shouldStop, onStart, onProgress: progress },
    });

    // The whole-film steps, once, after this shot — and only if asked for on
    // a run this small. A film is not a property of one shot.
    const film = outcome.stopped
        ? { completed: [], failed: [], skipped: [], failures: [], stopped: null }
        : await runProjectSteps(projectSteps, {
            project, offset: perShot.length,
            opts: { runType: 'shot', runProjectSteps: !!(req.body && req.body.include_project_steps) },
            hooks: {
                shouldStop, onStart,
                onProgress: (c, f, sk) => progress(
                    [...outcome.completed, ...c], [...outcome.failed, ...f], [...outcome.skipped, ...sk]),
            },
        });

    const completedSteps = [...outcome.completed, ...film.completed];
    const failedSteps = [...outcome.failed, ...film.failed];
    const skippedSteps = [...outcome.skipped, ...film.skipped];
    const failures = [...outcome.failures, ...film.failures];
    const stopped = outcome.stopped || film.stopped;

    if (stopped) {
        db.prepare('UPDATE film_pipeline_runs SET status = ? WHERE id = ?').run(stopped, runId);
        activePipelines.delete(runId);
        return json(res, 200, {
            run_id: runId, shot_id: shotId, status: stopped,
            steps_completed: completedSteps, steps_failed: failedSteps,
            steps_skipped: skippedSteps, failures, readiness,
        });
    }

    const finalStatus = runStatus({ failed: failedSteps, projectFailed: film.failed });
    progress(completedSteps, failedSteps, skippedSteps);
    recordFailures(runId, failures);
    db.prepare('UPDATE film_pipeline_runs SET status = ?, completed_at = datetime(?) WHERE id = ?')
        .run(finalStatus, new Date().toISOString(), runId);
    activePipelines.delete(runId);

    json(res, 200, {
        run_id: runId, shot_id: shotId, status: finalStatus,
        steps_completed: completedSteps, steps_failed: failedSteps,
        // Named, never silent: a scene-scoped step that did not run here is a
        // decision, and one that looks like nothing happened is the defect.
        steps_skipped: skippedSteps,
        // And a failure says what was tried: the id alone sends the reader to
        // the database, and the walk is what tells them which fix applies.
        failures,
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
    const { perShot, project: projectSteps } = splitPlan(plan);

    // Before the stream opens: a 409 is an answer, a stream that ends in one
    // event is a run that looks like it started.
    const gate = preflightProjectSteps(projectSteps, req.body, !!(req.body && req.body.include_project_steps));
    if (gate) return json(res, 409, gate);

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

    const hooks = {
        // A client hanging up is a cancellation: there is no one left to
        // watch, and the steps cost money.
        shouldStop: () => {
            const st = activePipelines.get(runId);
            if (clientGone || res.writableEnded) return 'cancelled';
            if (!st || st.status === 'cancelled') return 'cancelled';
            if (st.status === 'paused') return 'paused';
            return null;
        },
        onStart: (step, i) => sendEvent({ type: 'step_start', step_id: step.id, step_name: step.name, step_index: i, total_steps: plan.length }),
        onComplete: (step, i) => sendEvent({ type: 'step_complete', step_id: step.id, step_index: i, progress_pct: Math.round(((i + 1) / plan.length) * 100) }),
        onRetry: (step, attempt) => sendEvent({ type: 'step_retry', step_id: step.id, attempt: attempt + 1 }),
        onFailed: (step, i, result) => sendEvent({ type: 'step_failed', step_id: step.id, step_index: i,
            ...failureOf(step, result) }),
        onSkip: (step, reason, i) => sendEvent({ type: 'step_skipped', step_id: step.id, step_index: i, reason }),
    };

    const done = shotRunDoneSet(scene, req.body);
    const outcome = await runShotPlan(perShot, {
        shot, scene, project, done,
        opts: { shotRun: true, includeSceneSteps: !!(req.body && req.body.include_scene_steps) },
        hooks,
    });

    const film = outcome.stopped
        ? { completed: [], failed: [], skipped: [], failures: [], stopped: null }
        : await runProjectSteps(projectSteps, {
            project, offset: perShot.length, hooks,
            opts: { runType: 'shot', runProjectSteps: !!(req.body && req.body.include_project_steps) },
        });

    const completedSteps = [...outcome.completed, ...film.completed];
    const failedSteps = [...outcome.failed, ...film.failed];
    const skippedSteps = [...outcome.skipped, ...film.skipped];
    const failures = [...outcome.failures, ...film.failures];
    const stopped = outcome.stopped || film.stopped;

    if (stopped) {
        if (!clientGone) sendEvent({ type: stopped, run_id: runId });
        db.prepare('UPDATE film_pipeline_runs SET status = ? WHERE id = ?').run(stopped, runId);
        activePipelines.delete(runId);
        if (!res.writableEnded) { try { res.end(); } catch (_) {} }
        return;
    }

    // One rule for what the run is called — the stream once said `complete`
    // while the JSON runner beside it said completed_with_errors for the same
    // work, two surfaces disagreeing about whether the film got made.
    const streamStatus = runStatus({ failed: failedSteps, projectFailed: film.failed });
    db.prepare(
        `UPDATE film_pipeline_runs SET status = ?, steps_completed = ?, steps_failed = ?, steps_skipped = ?, progress_pct = 100, completed_at = datetime(?) WHERE id = ?`)
        .run(streamStatus, JSON.stringify(completedSteps), JSON.stringify(failedSteps), JSON.stringify(skippedSteps),
            new Date().toISOString(), runId);
    recordFailures(runId, failures);
    activePipelines.delete(runId);

    sendEvent({ type: 'result', run_id: runId, status: streamStatus, steps_completed: completedSteps,
        steps_failed: failedSteps, steps_skipped: skippedSteps, failures, total_steps: plan.length });
    sendEvent({ type: 'done' });
    res.end();
}

/*
 * Scene and project runs used to insert a row, answer 202 "running", and
 * execute nothing at all. The row stayed at 'running' for ever; every progress
 * field stayed empty; no asset was produced. It is the same shape as the
 * assembly step that once returned a hardcoded success — a surface that
 * reports work it never did.
 *
 * Both now run here, and both run SEQUENTIALLY. Firing several generations at
 * one provider concurrently is how a queue earns a 429, and the retry costs
 * more than the wait — the same reasoning the compass sweep is built on.
 *
 * The `done` set is shared across every shot of the run, which is what makes a
 * scene-scoped step happen once per scene rather than once per shot.
 */
async function executeShots({ runId, shots, project, body, runType }) {
    const done = new Set();
    const sceneCache = new Map();
    const completedSteps = [], failedSteps = [], skippedSteps = [], failures = [];
    let totalPlanned = 0;

    // The whole-film steps come from the request, not from any shot's card —
    // autoSkipSteps only ever adds voice and lipsync — so they are decided once.
    const projectSteps = splitPlan(buildStepPlan(body || {})).project;

    const shouldStop = () => {
        const st = activePipelines.get(runId);
        if (!st || st.status === 'cancelled') return 'cancelled';
        if (st.status === 'paused') return 'paused';
        return null;
    };
    const record = () => {
        db.prepare(
            `UPDATE film_pipeline_runs SET steps_completed = ?, steps_failed = ?, steps_skipped = ?, total_steps = ?, progress_pct = ? WHERE id = ?`
        ).run(JSON.stringify(completedSteps), JSON.stringify(failedSteps), JSON.stringify(skippedSteps), totalPlanned,
            Math.round((completedSteps.length / Math.max(totalPlanned, 1)) * 100), runId);
    };
    const halt = (stopped) => {
        db.prepare('UPDATE film_pipeline_runs SET status = ? WHERE id = ?').run(stopped, runId);
        activePipelines.delete(runId);
    };

    for (const shot of shots) {
        const stop = shouldStop();
        if (stop) return halt(stop);

        if (!sceneCache.has(shot.scene_id)) {
            sceneCache.set(shot.scene_id, db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id));
        }
        const scene = sceneCache.get(shot.scene_id);
        if (!scene) continue;

        let sceneCard = {};
        try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}
        const plan = splitPlan(buildStepPlan({ skip_steps: autoSkipSteps(sceneCard, body), ...(body || {}) })).perShot;
        totalPlanned += plan.length;

        const outcome = await runShotPlan(plan, {
            shot, scene, project, done,
            // Not a shot run: this IS the scene, so scene-scoped steps belong
            // to it — once, on whichever shot reaches them first.
            opts: { shotRun: false },
            hooks: {
                shouldStop,
                onStart: step => {
                    db.prepare('UPDATE film_pipeline_runs SET current_step = ? WHERE id = ?')
                        .run(shot.shot_code + ':' + step.id, runId);
                },
            },
        });

        completedSteps.push(...outcome.completed.map(id => shot.shot_code + ':' + id));
        failedSteps.push(...outcome.failed.map(id => shot.shot_code + ':' + id));
        skippedSteps.push(...outcome.skipped.map(sk => ({ step_id: shot.shot_code + ':' + sk.step_id, reason: sk.reason })));
        failures.push(...outcome.failures.map(f => ({ ...f, step: shot.shot_code + ':' + f.step })));
        record();
        recordFailures(runId, failures);

        if (outcome.stopped) return halt(outcome.stopped);
    }

    // Then the film, once. A project run is AT the film's scope and makes it;
    // a scene run is below it and says so unless asked.
    totalPlanned += projectSteps.length;
    const film = await runProjectSteps(projectSteps, {
        project, offset: totalPlanned - projectSteps.length,
        opts: { runType, runProjectSteps: runType === 'project' || !!(body && body.include_project_steps) },
        hooks: {
            shouldStop,
            onStart: step => {
                db.prepare('UPDATE film_pipeline_runs SET current_step = ? WHERE id = ?').run('film:' + step.id, runId);
            },
        },
    });
    completedSteps.push(...film.completed.map(id => 'film:' + id));
    failedSteps.push(...film.failed.map(id => 'film:' + id));
    skippedSteps.push(...film.skipped.map(sk => ({ step_id: 'film:' + sk.step_id, reason: sk.reason })));
    failures.push(...film.failures.map(f => ({ ...f, step: 'film:' + f.step })));
    record();
    recordFailures(runId, failures);
    if (film.stopped) return halt(film.stopped);

    const status = runStatus({ failed: failedSteps, projectFailed: film.failed });
    db.prepare('UPDATE film_pipeline_runs SET status = ?, progress_pct = 100, completed_at = datetime(?) WHERE id = ?')
        .run(status, new Date().toISOString(), runId);
    activePipelines.delete(runId);
}

/**
 * Write what failed to the run row: the structured list, and a readable line
 * per failure in `error_message`. A run row that says `failed` and lists
 * `assembly` under steps_failed tells a person nothing about which of the two
 * executors was tried; the walk is what tells them which fix applies.
 */
function recordFailures(runId, failures) {
    if (!failures || !failures.length) return;
    try {
        db.prepare('UPDATE film_pipeline_runs SET failures = ?, error_message = ? WHERE id = ?')
            .run(JSON.stringify(failures), failures.map(f => `${f.step}: ${f.error}`).join('\n'), runId);
    } catch (_) { /* a row that cannot carry its failures still carries its status */ }
}

/**
 * Start a run after the response has gone.
 *
 * A rejection here must not take the process down — the caller has already been
 * answered, so there is nobody left to tell except the run row, and a run that
 * disappears is worse than one marked failed.
 */
function startInBackground(runId, work) {
    activePipelines.set(runId, { status: 'running' });
    setImmediate(() => {
        work().catch(err => {
            try {
                db.prepare('UPDATE film_pipeline_runs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', String((err && err.message) || err), runId);
            } catch (_) { /* the row is the only place left to report */ }
            activePipelines.delete(runId);
        });
    });
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

    const gate = preflightProjectSteps(splitPlan(buildStepPlan(req.body || {})).project, req.body,
        !!(req.body && req.body.include_project_steps));
    if (gate) return json(res, 409, gate);

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_pipeline_runs (id, project_id, scene_id, run_type, status, total_steps, progress_pct)
         VALUES (?, ?, ?, 'scene', 'running', ?, 0)`
    ).run(runId, scene.project_id, sceneId, shots.length);

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);

    json(res, 202, {
        run_id: runId, scene_id: sceneId, status: 'running',
        total_shots: shots.length,
        shots: shots.map(s => ({ shot_id: s.id, shot_code: s.shot_code })),
        readiness: sceneReadiness,
        hint: 'Scene pipeline is running. Check status at GET /film/pipeline/' + runId,
    });

    startInBackground(runId, () => executeShots({ runId, shots, project, body: req.body, runType: 'scene' }));
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

    // A project run makes the film, so its dependency is asked for FIRST —
    // before a single generation step has been paid for.
    const gate = preflightProjectSteps(splitPlan(buildStepPlan(req.body || {})).project, req.body, true);
    if (gate) return json(res, 409, gate);

    const runId = generateId();
    db.prepare(
        `INSERT INTO film_pipeline_runs (id, project_id, run_type, status, total_steps, progress_pct)
         VALUES (?, ?, 'project', 'running', ?, 0)`
    ).run(runId, projectId, totalShots);

    // In the film's own running order, so a paused or failed run has produced
    // the FRONT of the picture rather than an arbitrary scatter of it.
    const shots = db.prepare(
        `SELECT sh.* FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, sh.sort_order, sh.shot_code`
    ).all(projectId);

    json(res, 202, {
        run_id: runId, project_id: projectId, status: 'running',
        total_scenes: scenes.length, total_shots: totalShots,
        readiness,
        hint: 'Project pipeline is running. Check status at GET /film/pipeline/' + runId,
    });

    startInBackground(runId, () => executeShots({ runId, shots, project, body: req.body, runType: 'project' }));
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
        steps_skipped: run.steps_skipped ? JSON.parse(run.steps_skipped) : [],
        failures: run.failures ? JSON.parse(run.failures) : [],
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

module.exports = { handlePipeline, persistStepResult, STEP_CAPABILITY, CONFORM_STATES, runStatus, scoreGate };
