/**
 * FILM-029-035: Video Generation Pipeline
 *
 * POST /film/shots/:id/video/generate          - Generate video from storyboard keyframe
 * POST /film/shots/:id/video/generate/stream    - SSE streaming
 * POST /film/projects/:id/video/batch           - Batch all shots
 * POST /film/projects/:id/video/batch/stream    - SSE batch
 * GET  /film/shots/:id/video                    - Get video job status
 * GET  /film/projects/:id/video                 - List all video jobs
 * GET  /film/video/:projectId/:filename         - Serve video files
 */

const fs = require('fs');
const { db, generateId } = require('../db/database');
const { callGridlight, serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, getFilePath, ensureDir, serveFile } = require('../lib/file-storage');
const { buildVideoPayload } = require('../lib/video-prompt');
const { needsStitching, planClips, buildStitchPayload, calculateTransitions } = require('../lib/video-stitcher');
const { resolve } = require('../lib/providers');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIDEO_ENDPOINT = '/video';
const STITCH_ENDPOINT = '/video/stitch';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function parseProjectConfig(projectId) {
    const row = db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return {};
    try { return JSON.parse(row.provider_config || '{}'); } catch (_) { return {}; }
}

function resultModel(result, payload) {
    return (result && result.provider_model) || (payload && payload.model) || '';
}

function resultJobId(result) {
    return (result && result.provider_job_id) || '';
}

// -- Route Handler -------------------------------------------------------

function handleVideoGen(req, res, urlParts, query) {
    // /film/video/:projectId/:filename
    if (urlParts[1] === 'video' && urlParts[2] && urlParts[3] && !['shots', 'projects'].includes(urlParts[1])) {
        return serveFile(res, urlParts[2], 'video', urlParts[3]);
    }

    // /film/shots/:id/video[/generate[/stream]]
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'video') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        const sub = urlParts[4];
        if (sub === 'generate' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return generateVideoStream(req, res, shotId);
            return generateVideo(req, res, shotId);
        }
        if (sub === 'stitch' && req.method === 'POST') return stitchVideo(req, res, shotId);
        if (!sub && req.method === 'GET') return getVideoStatus(req, res, shotId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/video[/batch[/stream]]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'video') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        const sub = urlParts[4];
        if (sub === 'batch' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return batchVideoStream(req, res, projectId);
            return batchVideo(req, res, projectId);
        }
        if (!sub && req.method === 'GET') return listVideoJobs(req, res, projectId, query);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Helpers -------------------------------------------------------------

function loadShotContext(shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return null;

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return null;

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}

    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(scene.project_id);
    const location = scene.location_id
        ? db.prepare('SELECT * FROM film_locations WHERE id = ?').get(scene.location_id)
        : null;
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);

    // Find storyboard keyframe asset for init_image
    const keyframeAsset = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type IN ('keyframe', 'storyboard') ORDER BY created_at DESC LIMIT 1"
    ).get(shotId);

    let initImage = null;
    if (keyframeAsset && keyframeAsset.file_name) {
        const imgPath = getFilePath(scene.project_id, 'storyboards', keyframeAsset.file_name);
        if (fs.existsSync(imgPath)) {
            initImage = fs.readFileSync(imgPath).toString('base64');
        }
    }

    return { shot, scene, sceneCard, characters, location, project, keyframeAsset, initImage };
}

// -- Generate Video for a Shot -------------------------------------------

async function generateVideo(req, res, shotId) {
    const ctx = loadShotContext(shotId);
    if (!ctx) return json(res, 404, { error: 'Shot not found' });

    const { shot, scene, sceneCard, characters, location, project, initImage } = ctx;
    const videoProvider = resolve('video', parseProjectConfig(scene.project_id));

    const stylePreset = project ? project.style_preset : null;
    const payload = buildVideoPayload(sceneCard, characters, location, stylePreset, {
        init_image: initImage,
        seed: req.body && req.body.seed ? req.body.seed : null,
        model: req.body && req.body.model ? req.body.model : undefined,
    });

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_video_jobs (id, project_id, shot_id, keyframe_asset_id, status, prompt, negative_prompt, model, seed, num_frames, fps, width, height, camera_control)
         VALUES (?, ?, ?, ?, 'generating', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, scene.project_id, shotId, ctx.keyframeAsset ? ctx.keyframeAsset.id : null,
        payload.prompt, payload.negative_prompt, payload.model, payload.seed,
        payload.num_frames, payload.fps, payload.width, payload.height,
        JSON.stringify(payload.camera_control));

    try {
        const result = await videoProvider.generate('video', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (videoProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(VIDEO_ENDPOINT, 'video'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = `${shot.shot_code}.mp4`;
        ensureDir(scene.project_id, 'video');
        let filePath = '';

        if (Buffer.isBuffer(result.data)) {
            filePath = saveFile(scene.project_id, 'video', filename, result.data);
        } else if (result.data && result.data.video_url) {
            filePath = result.data.video_url;
        }

        const durationMs = payload.duration_s * 1000;

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, shot_id, asset_type, file_path, file_name,
                format, mime_type, duration_ms, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', ?, 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, shotId, filePath, filename, durationMs,
            videoProvider.id, resultModel(result, payload), resultJobId(result)
        );

        db.prepare(
            `INSERT INTO render_ledger (id, shot_id, version, step, model_id, prompt, seed, sampler, steps, guidance, mode)
             VALUES (?, ?, 1, 'video', ?, ?, ?, 'euler_a', ?, ?, 'creative')`
        ).run(generateId(), shotId, payload.model, payload.prompt, payload.seed, payload.steps, payload.guidance_scale);

        db.prepare('UPDATE film_video_jobs SET status = ?, output_path = ?, duration_ms = ? WHERE id = ?')
            .run('complete', filePath, durationMs, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            video_url: getFileUrl('video', scene.project_id, filename), duration_ms: durationMs,
        });
    } catch (err) {
        db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (videoProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(VIDEO_ENDPOINT, 'video'));
        json(res, 500, { error: err.message });
    }
}

// -- SSE Streaming Video Generation --------------------------------------

async function generateVideoStream(req, res, shotId) {
    const ctx = loadShotContext(shotId);
    if (!ctx) return json(res, 404, { error: 'Shot not found' });

    const { shot, scene, sceneCard, characters, location, project, initImage } = ctx;
    const videoProvider = resolve('video', parseProjectConfig(scene.project_id));
    const stylePreset = project ? project.style_preset : null;
    const payload = buildVideoPayload(sceneCard, characters, location, stylePreset, { init_image: initImage });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };
    sendEvent({ type: 'status', phase: 'starting', shot_id: shotId, shot_code: shot.shot_code });

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_video_jobs (id, project_id, shot_id, status, prompt, model) VALUES (?, ?, ?, 'generating', ?, ?)`
    ).run(jobId, scene.project_id, shotId, payload.prompt, payload.model);

    try {
        const { ok, finalData, error } = await videoProvider.generateStream('video', payload, res, {
            onComplete: (data) => {
                const filename = `${shot.shot_code}.mp4`;
                ensureDir(scene.project_id, 'video');

                const assetId = generateId();
                db.prepare(
                    `INSERT INTO film_assets (
                        id, project_id, shot_id, asset_type, file_name, format, mime_type, version,
                        provider, provider_model, provider_job_id, license_source, license_status
                     )
                     VALUES (?, ?, ?, 'video_raw', ?, 'mp4', 'video/mp4', 1, ?, ?, ?, 'generated', 'generated')`
                ).run(
                    assetId, scene.project_id, shotId, filename,
                    videoProvider.id, resultModel(data, payload), resultJobId(data)
                );

                db.prepare('UPDATE film_video_jobs SET status = ?, output_path = ? WHERE id = ?')
                    .run('complete', data.video_url || filename, jobId);
            },
            onError: (data) => {
                db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', data.error || 'Unknown error', jobId);
            },
        });

        if (!ok) {
            sendEvent({ type: 'error', error: error || 'Video generation failed' });
            db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', error, jobId);
        }
    } catch (err) {
        sendEvent({ type: 'error', error: err.message });
        db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
    }

    sendEvent({ type: 'done' });
    res.end();
}

// -- Batch Video Generation ----------------------------------------------

async function batchVideoStream(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const videoProvider = resolve('video', parseProjectConfig(projectId));

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    sendEvent({ type: 'status', phase: 'starting', total_shots: shots.length, project_id: projectId });
    let completed = 0, failed = 0;

    for (const shot of shots) {
        if (clientGone || res.writableEnded) break; // client disconnected — stop firing video jobs
        const ctx = loadShotContext(shot.shot_id);
        if (!ctx) { failed++; continue; }

        sendEvent({ type: 'shot_start', shot_id: shot.shot_id, shot_code: shot.shot_code });

        const payload = buildVideoPayload(ctx.sceneCard, ctx.characters, ctx.location, project.style_preset, {
            init_image: ctx.initImage,
        });

        try {
            const result = await videoProvider.generate('video', payload, { timeout: 300000 });
            if (!result.ok) throw new Error(result.error);

            const filename = `${shot.shot_code}.mp4`;
            ensureDir(projectId, 'video');
            let filePath = filename;
            if (Buffer.isBuffer(result.data)) filePath = saveFile(projectId, 'video', filename, result.data);

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, shot_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', 1, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, projectId, shot.shot_id, filePath, filename,
                videoProvider.id, resultModel(result, payload), resultJobId(result)
            );

            sendEvent({ type: 'shot_complete', shot_code: shot.shot_code, video_url: getFileUrl('video', projectId, filename) });
            completed++;
        } catch (err) {
            sendEvent({ type: 'shot_failed', shot_code: shot.shot_code, error: err.message });
            failed++;
        }
    }

    sendEvent({ type: 'result', project_id: projectId, shots_completed: completed, shots_failed: failed });
    sendEvent({ type: 'done' });
    res.end();
}

async function batchVideo(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_card_yaml FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    json(res, 200, {
        project_id: projectId, total_shots: shots.length,
        shots: shots.map(s => ({ shot_id: s.shot_id, shot_code: s.shot_code })),
        hint: 'Use POST /film/projects/:id/video/batch/stream for actual generation with progress',
    });
}

// -- Status & Listing ----------------------------------------------------

function getVideoStatus(req, res, shotId) {
    const jobs = db.prepare('SELECT * FROM film_video_jobs WHERE shot_id = ? ORDER BY created_at DESC').all(shotId);
    const assets = db.prepare("SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'video_raw' ORDER BY created_at DESC").all(shotId);

    json(res, 200, {
        shot_id: shotId, jobs,
        videos: assets.map(a => ({
            asset_id: a.id, file_name: a.file_name,
            video_url: a.file_name ? getFileUrl('video', a.project_id, a.file_name) : null,
            duration_ms: a.duration_ms,
            provider: a.provider, provider_model: a.provider_model, provider_job_id: a.provider_job_id,
            license_source: a.license_source, license_status: a.license_status,
        })),
    });
}

function listVideoJobs(req, res, projectId, query) {
    const status = query.status || null;
    let jobs;
    if (status) {
        jobs = db.prepare('SELECT * FROM film_video_jobs WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(projectId, status);
    } else {
        jobs = db.prepare('SELECT * FROM film_video_jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
    }
    json(res, 200, { project_id: projectId, total: jobs.length, jobs });
}

// -- FILM-033: Multi-Clip Stitching for Long Shots -----------------------

async function stitchVideo(req, res, shotId) {
    const ctx = loadShotContext(shotId);
    if (!ctx) return json(res, 404, { error: 'Shot not found' });

    const { shot, scene, sceneCard, characters, location, project, initImage } = ctx;
    const durationMs = sceneCard.duration_ms || shot.duration_ms || 4000;

    if (!needsStitching(durationMs)) {
        return json(res, 200, {
            shot_id: shotId, message: 'Shot duration does not require stitching',
            duration_ms: durationMs, needs_stitching: false,
        });
    }

    const clips = planClips(durationMs, req.body);
    const transitions = calculateTransitions(clips);

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_stitch_jobs (id, project_id, shot_id, status, clip_count, transition_type, total_duration_ms, params)
         VALUES (?, ?, ?, 'processing', ?, ?, ?, ?)`
    ).run(jobId, scene.project_id, shotId, clips.length,
        (req.body && req.body.transition) || 'cross-dissolve', durationMs,
        JSON.stringify({ clips, transitions }));

    // Generate each clip
    const stylePreset = project ? project.style_preset : null;
    ensureDir(scene.project_id, 'video');
    const clipResults = [];

    for (const clip of clips) {
        const clipCard = { ...sceneCard, duration_ms: clip.duration_ms };
        const payload = buildVideoPayload(clipCard, characters, location, stylePreset, {
            init_image: initImage,
            seed: req.body && req.body.seed ? req.body.seed + clip.index : null,
        });

        try {
            const result = await callGridlight(VIDEO_ENDPOINT, payload);
            if (!result.ok) {
                clipResults.push({ index: clip.index, status: 'failed', error: result.error });
                continue;
            }

            const filename = `${shot.shot_code}_clip_${clip.index}.mp4`;
            if (Buffer.isBuffer(result.data)) {
                saveFile(scene.project_id, 'video', filename, result.data);
            }
            clip.clip_url = getFileUrl('video', scene.project_id, filename);
            clipResults.push({ index: clip.index, status: 'complete', clip_url: clip.clip_url });
        } catch (err) {
            if (err.message.includes('ECONNREFUSED')) {
                db.prepare('UPDATE film_stitch_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', 'Service unavailable', jobId);
                return json(res, 503, serviceUnavailableError(VIDEO_ENDPOINT, 'video'));
            }
            clipResults.push({ index: clip.index, status: 'failed', error: err.message });
        }
    }

    // Stitch clips together
    const successClips = clipResults.filter(c => c.status === 'complete');
    if (successClips.length < clips.length) {
        db.prepare('UPDATE film_stitch_jobs SET status = ?, error_message = ? WHERE id = ?')
            .run('completed_with_errors', `${clips.length - successClips.length} clips failed`, jobId);

        return json(res, 200, {
            shot_id: shotId, job_id: jobId, status: 'completed_with_errors',
            clips: clipResults, transitions,
        });
    }

    // Call stitch endpoint to join clips
    const stitchPayload = buildStitchPayload(clips, scene.project_id, shot.shot_code, req.body);

    try {
        const stitchResult = await callGridlight(STITCH_ENDPOINT, stitchPayload);

        const filename = `${shot.shot_code}_stitched.mp4`;
        let filePath = '';
        if (stitchResult.ok && Buffer.isBuffer(stitchResult.data)) {
            filePath = saveFile(scene.project_id, 'video', filename, stitchResult.data);
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, duration_ms, version)
             VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', ?, 1)`
        ).run(assetId, scene.project_id, shotId, filePath, filename, durationMs);

        db.prepare('UPDATE film_stitch_jobs SET status = ?, output_path = ? WHERE id = ?')
            .run('complete', filePath, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            video_url: getFileUrl('video', scene.project_id, filename),
            clip_count: clips.length, duration_ms: durationMs, transitions,
        });
    } catch (err) {
        db.prepare('UPDATE film_stitch_jobs SET status = ?, error_message = ? WHERE id = ?')
            .run('failed', err.message, jobId);
        json(res, 500, { error: err.message });
    }
}

module.exports = { handleVideoGen };
