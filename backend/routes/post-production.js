/**
 * FILM-052-058: Post-Production Pipeline
 *
 * POST /film/shots/:id/post/upscale       - Upscale video
 * POST /film/shots/:id/post/face-restore   - Face restoration
 * POST /film/shots/:id/post/color-grade    - Color grading
 * POST /film/shots/:id/post/composite      - Run all post steps sequentially
 * POST /film/projects/:id/post/batch       - Batch post-production
 * POST /film/projects/:id/post/batch/stream - SSE batch
 * GET  /film/shots/:id/post               - Get post job status
 * GET  /film/projects/:id/post            - List all post jobs
 */

const { db, generateId } = require('../db/database');
const { serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, ensureDir } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const { resolve, get } = require('../lib/providers');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POST_ENDPOINT = '/postprocess';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function parseProjectConfig(projectId) {
    const row = db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return {};
    try { return JSON.parse(row.provider_config || '{}'); } catch (_) { return {}; }
}

function resolveGenerator(capability, projectConfig) {
    const adapter = resolve(capability, projectConfig);
    if (adapter && typeof adapter.generate === 'function') return adapter;
    return get('gridlight');
}

function resultModel(result, payload) {
    return (result && result.provider_model) || (payload && payload.model) || '';
}

function resultJobId(result) {
    return (result && result.provider_job_id) || '';
}

// -- Route Handler -------------------------------------------------------

function handlePostProduction(req, res, urlParts, query) {
    // /film/shots/:id/post[/upscale|face-restore|color-grade|composite]
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'post') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        const sub = urlParts[4];
        if (req.method === 'POST') {
            if (sub === 'upscale') return runPostStep(req, res, shotId, 'upscale');
            if (sub === 'face-restore') return runPostStep(req, res, shotId, 'face_restore');
            if (sub === 'color-grade') return runPostStep(req, res, shotId, 'color_grade');
            if (sub === 'composite') return runComposite(req, res, shotId);
            if (sub === 'color-match') return colorMatchShot(req, res, shotId);
            if (sub === 'encode') return encodeShot(req, res, shotId);
        }
        if (!sub && req.method === 'GET') return getPostStatus(req, res, shotId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/post[/batch[/stream]|/color-match|/encode]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'post') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        const sub = urlParts[4];
        if (sub === 'color-match' && req.method === 'POST') return colorMatchProject(req, res, projectId);
        if (sub === 'encode' && req.method === 'POST') return encodeProject(req, res, projectId);
        if (sub === 'batch' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return batchPostStream(req, res, projectId);
            return batchPost(req, res, projectId);
        }
        if (!sub && req.method === 'GET') return listPostJobs(req, res, projectId, query);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Helpers -------------------------------------------------------------

function findLatestVideo(shotId) {
    // Prefer synced > raw
    return db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type IN ('video_synced', 'video_raw') ORDER BY CASE asset_type WHEN 'video_synced' THEN 0 ELSE 1 END, created_at DESC LIMIT 1"
    ).get(shotId);
}

function buildPostPayload(jobType, videoAsset, projectId, options) {
    const opts = options || {};
    const base = {
        input_url: videoAsset.file_path || getFileUrl('video', projectId, videoAsset.file_name),
        output_format: 'mp4',
        stream: false,
    };

    if (jobType === 'upscale') {
        return {
            ...base, type: 'upscale',
            model: opts.model || 'realesrgan-video',
            scale_factor: opts.scale_factor || 2,
        };
    }

    if (jobType === 'face_restore') {
        return {
            ...base, type: 'face_restore',
            face_restoration: {
                enabled: true,
                model: opts.face_model || 'codeformer',
                weight: opts.face_weight || 0.7,
            },
        };
    }

    if (jobType === 'color_grade') {
        return {
            ...base, type: 'color_grade',
            color_grade: {
                lut_preset: opts.lut_preset || 'cinematic_warm',
                film_grain: opts.film_grain || 0.15,
            },
        };
    }

    return base;
}

// -- Run a Single Post Step ----------------------------------------------

async function runPostStep(req, res, shotId, jobType) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });
    const postProvider = resolveGenerator('post', parseProjectConfig(scene.project_id));

    const videoAsset = findLatestVideo(shotId);
    if (!videoAsset) return json(res, 400, { error: 'No video asset found. Generate video first.' });

    const payload = buildPostPayload(jobType, videoAsset, scene.project_id, req.body);

    // Find color preset if applicable
    let colorPresetId = null;
    if (jobType === 'color_grade' && req.body && req.body.color_preset_id) {
        colorPresetId = req.body.color_preset_id;
    }

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_post_jobs (id, project_id, shot_id, input_asset_id, job_type, status, color_preset_id, model, params)
         VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?)`
    ).run(jobId, scene.project_id, shotId, videoAsset.id, jobType, colorPresetId, payload.model || '', JSON.stringify(payload));

    try {
        const result = await postProvider.generate('post', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_post_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (postProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(POST_ENDPOINT, 'post-production'));
            return json(res, result.status || 500, { error: result.error });
        }

        const suffix = jobType === 'upscale' ? '_upscaled' : jobType === 'face_restore' ? '_facefix' : '_graded';
        const filename = `${shot.shot_code}${suffix}.mp4`;
        ensureDir(scene.project_id, 'video');
        const filePath = await persistProviderMedia(scene.project_id, 'video', filename, result.data, { serveDir: 'videos' });

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, shot_id, asset_type, file_path, file_name,
                format, mime_type, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'video_final', ?, ?, 'mp4', 'video/mp4', 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, shotId, filePath, filename,
            postProvider.id, resultModel(result, payload), resultJobId(result)
        );

        db.prepare(
            `INSERT INTO render_ledger (id, shot_id, version, step, model_id, prompt, mode)
             VALUES (?, ?, 1, 'post', ?, ?, 'creative')`
        ).run(generateId(), shotId, payload.model || jobType, `${jobType} on ${videoAsset.id}`);

        db.prepare('UPDATE film_post_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, job_type: jobType, status: 'complete',
            video_url: getFileUrl('video', scene.project_id, filename),
        });
    } catch (err) {
        db.prepare('UPDATE film_post_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (postProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(POST_ENDPOINT, 'post-production'));
        json(res, 500, { error: err.message });
    }
}

// -- Run Full Composite (all post steps) ---------------------------------

async function runComposite(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });
    const postProvider = resolveGenerator('post', parseProjectConfig(scene.project_id));

    let videoAsset = findLatestVideo(shotId);
    if (!videoAsset) return json(res, 400, { error: 'No video asset found.' });

    const steps = ['upscale', 'face_restore', 'color_grade'];
    const results = [];

    for (const step of steps) {
        const payload = buildPostPayload(step, videoAsset, scene.project_id, req.body);
        const jobId = generateId();

        db.prepare(
            `INSERT INTO film_post_jobs (id, project_id, shot_id, input_asset_id, job_type, status, model)
             VALUES (?, ?, ?, ?, ?, 'processing', ?)`
        ).run(jobId, scene.project_id, shotId, videoAsset.id, step, payload.model || '');

        try {
            const result = await postProvider.generate('post', payload, { timeout: 300000 });
            if (!result.ok) {
                db.prepare('UPDATE film_post_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
                results.push({ step, status: 'failed', error: result.error });
                continue;
            }

            const filename = `${shot.shot_code}_final.mp4`;
            ensureDir(scene.project_id, 'video');
            const filePath = await persistProviderMedia(scene.project_id, 'video', filename, result.data, { serveDir: 'videos' });

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, shot_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'video_final', ?, ?, 'mp4', 'video/mp4', 1, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, scene.project_id, shotId, filePath, filename,
                postProvider.id, resultModel(result, payload), resultJobId(result)
            );

            db.prepare('UPDATE film_post_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

            // Update videoAsset to chain next step
            videoAsset = { ...videoAsset, id: assetId, file_path: filePath, file_name: filename };
            results.push({ step, status: 'complete', video_url: getFileUrl('video', scene.project_id, filename) });
        } catch (err) {
            db.prepare('UPDATE film_post_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            if (err.message.includes('ECONNREFUSED')) {
                if (postProvider.id === 'gridlight') return json(res, 503, serviceUnavailableError(POST_ENDPOINT, 'post-production'));
            }
            results.push({ step, status: 'failed', error: err.message });
        }
    }

    json(res, 200, { shot_id: shotId, shot_code: shot.shot_code, steps: results });
}

// -- Batch Post-Production -----------------------------------------------

async function batchPostStream(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const postProvider = resolveGenerator('post', parseProjectConfig(projectId));

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
        if (clientGone || res.writableEnded) break; // client disconnected — stop firing post jobs
        const videoAsset = findLatestVideo(shot.shot_id);
        if (!videoAsset) continue;

        sendEvent({ type: 'shot_start', shot_code: shot.shot_code });

        const payload = buildPostPayload('upscale', videoAsset, projectId);

        try {
            const result = await postProvider.generate('post', payload, { timeout: 300000 });
            if (!result.ok) throw new Error(result.error);

            const filename = `${shot.shot_code}_final.mp4`;
            ensureDir(projectId, 'video');
            const filePath = await persistProviderMedia(projectId, 'video', filename, result.data, { serveDir: 'videos' });

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'video_final', ?, ?, 'mp4', 'video/mp4', 1, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, projectId, shot.shot_id, filePath, filename,
                postProvider.id, resultModel(result, payload), resultJobId(result)
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

async function batchPost(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    const eligible = [];
    for (const shot of shots) {
        if (findLatestVideo(shot.shot_id)) {
            eligible.push({ shot_id: shot.shot_id, shot_code: shot.shot_code });
        }
    }

    json(res, 200, { project_id: projectId, eligible_shots: eligible.length, shots: eligible });
}

// -- Status & Listing ----------------------------------------------------

function getPostStatus(req, res, shotId) {
    const jobs = db.prepare('SELECT * FROM film_post_jobs WHERE shot_id = ? ORDER BY created_at DESC').all(shotId);
    const assets = db.prepare("SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'video_final' ORDER BY created_at DESC").all(shotId);

    json(res, 200, {
        shot_id: shotId, jobs,
        final_videos: assets.map(a => ({
            asset_id: a.id, file_name: a.file_name,
            video_url: a.file_name ? getFileUrl('video', a.project_id, a.file_name) : null,
        })),
    });
}

function listPostJobs(req, res, projectId, query) {
    const jobType = query.type || null;
    const status = query.status || null;

    let sql = 'SELECT * FROM film_post_jobs WHERE project_id = ?';
    const params = [projectId];
    if (jobType) { sql += ' AND job_type = ?'; params.push(jobType); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';

    const jobs = db.prepare(sql).all(...params);
    json(res, 200, { project_id: projectId, total: jobs.length, jobs });
}

// -- FILM-057: Shot-to-Shot Color Matching --------------------------------

async function colorMatchShot(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const postProvider = resolveGenerator('post', parseProjectConfig(scene.project_id));
    const videoAsset = findLatestVideo(shotId);
    if (!videoAsset) return json(res, 400, { error: 'No video asset found.' });

    // Find the reference shot (previous shot in same scene, or specified)
    let refShotId = req.body && req.body.reference_shot_id;
    if (!refShotId) {
        const prevShot = db.prepare(
            'SELECT id FROM film_shots WHERE scene_id = ? AND shot_code < ? ORDER BY shot_code DESC LIMIT 1'
        ).get(shot.scene_id, shot.shot_code);
        refShotId = prevShot ? prevShot.id : null;
    }

    if (!refShotId) {
        return json(res, 400, { error: 'No reference shot found for color matching. This may be the first shot in the scene.' });
    }

    const refVideo = findLatestVideo(refShotId);
    if (!refVideo) return json(res, 400, { error: 'Reference shot has no video asset.' });

    const payload = {
        type: 'color_match',
        input_url: videoAsset.file_path || getFileUrl('video', scene.project_id, videoAsset.file_name),
        reference_url: refVideo.file_path || getFileUrl('video', scene.project_id, refVideo.file_name),
        method: (req.body && req.body.method) || 'histogram',
        strength: (req.body && req.body.strength) || 0.8,
        output_format: 'mp4',
    };

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_post_jobs (id, project_id, shot_id, input_asset_id, job_type, status, params)
         VALUES (?, ?, ?, ?, 'color_match', 'processing', ?)`
    ).run(jobId, scene.project_id, shotId, videoAsset.id, JSON.stringify(payload));

    try {
        const result = await postProvider.generate('post', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_post_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (postProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(POST_ENDPOINT, 'post-production'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = `${shot.shot_code}_matched.mp4`;
        ensureDir(scene.project_id, 'video');
        const filePath = await persistProviderMedia(scene.project_id, 'video', filename, result.data, { serveDir: 'videos' });

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, shot_id, asset_type, file_path, file_name,
                format, mime_type, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'video_final', ?, ?, 'mp4', 'video/mp4', 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, shotId, filePath, filename,
            postProvider.id, resultModel(result, payload), resultJobId(result)
        );

        db.prepare('UPDATE film_post_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            video_url: getFileUrl('video', scene.project_id, filename),
            reference_shot_id: refShotId,
        });
    } catch (err) {
        db.prepare('UPDATE film_post_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (postProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(POST_ENDPOINT, 'post-production'));
        json(res, 500, { error: err.message });
    }
}

async function colorMatchProject(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_id FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    // Group by scene for per-scene color matching
    const byScene = {};
    for (const shot of shots) {
        if (!byScene[shot.scene_id]) byScene[shot.scene_id] = [];
        byScene[shot.scene_id].push(shot);
    }

    const eligible = [];
    for (const [sceneId, sceneShots] of Object.entries(byScene)) {
        // Skip first shot in each scene (it's the reference)
        for (let i = 1; i < sceneShots.length; i++) {
            if (findLatestVideo(sceneShots[i].shot_id) && findLatestVideo(sceneShots[i - 1].shot_id)) {
                eligible.push({
                    shot_id: sceneShots[i].shot_id, shot_code: sceneShots[i].shot_code,
                    reference_shot_id: sceneShots[i - 1].shot_id,
                });
            }
        }
    }

    json(res, 200, {
        project_id: projectId, eligible_shots: eligible.length, shots: eligible,
        hint: 'POST to /film/shots/:id/post/color-match for each shot, or use batch endpoint.',
    });
}

// -- FILM-062: ProRes/DNxHR Encoding --------------------------------------

const SUPPORTED_CODECS = {
    'prores-422-lt': { ffmpeg: 'prores_ks', profile: 1, extension: 'mov', mime: 'video/quicktime', label: 'ProRes 422 LT' },
    'prores-422': { ffmpeg: 'prores_ks', profile: 2, extension: 'mov', mime: 'video/quicktime', label: 'ProRes 422' },
    'prores-422-hq': { ffmpeg: 'prores_ks', profile: 3, extension: 'mov', mime: 'video/quicktime', label: 'ProRes 422 HQ' },
    'prores-4444': { ffmpeg: 'prores_ks', profile: 4, extension: 'mov', mime: 'video/quicktime', label: 'ProRes 4444' },
    'dnxhr-lb': { ffmpeg: 'dnxhd', profile: 'dnxhr_lb', extension: 'mxf', mime: 'application/mxf', label: 'DNxHR LB' },
    'dnxhr-sq': { ffmpeg: 'dnxhd', profile: 'dnxhr_sq', extension: 'mxf', mime: 'application/mxf', label: 'DNxHR SQ' },
    'dnxhr-hq': { ffmpeg: 'dnxhd', profile: 'dnxhr_hq', extension: 'mxf', mime: 'application/mxf', label: 'DNxHR HQ' },
    'h264': { ffmpeg: 'libx264', profile: null, extension: 'mp4', mime: 'video/mp4', label: 'H.264' },
    'h265': { ffmpeg: 'libx265', profile: null, extension: 'mp4', mime: 'video/mp4', label: 'H.265/HEVC' },
};

async function encodeShot(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const postProvider = resolveGenerator('post', parseProjectConfig(scene.project_id));
    const videoAsset = findLatestVideo(shotId);
    if (!videoAsset) return json(res, 400, { error: 'No video asset found.' });

    const codec = (req.body && req.body.codec) || 'prores-422-lt';
    const codecInfo = SUPPORTED_CODECS[codec];
    if (!codecInfo) {
        return json(res, 400, {
            error: `Unsupported codec: ${codec}`,
            supported: Object.keys(SUPPORTED_CODECS),
        });
    }

    const payload = {
        type: 'encode',
        input_url: videoAsset.file_path || getFileUrl('video', scene.project_id, videoAsset.file_name),
        codec: codecInfo.ffmpeg,
        codec_profile: codecInfo.profile,
        output_format: codecInfo.extension,
        resolution: (req.body && req.body.resolution) || null,
        frame_rate: (req.body && req.body.frame_rate) || null,
    };

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_post_jobs (id, project_id, shot_id, input_asset_id, job_type, status, model, params)
         VALUES (?, ?, ?, ?, 'encode', 'processing', ?, ?)`
    ).run(jobId, scene.project_id, shotId, videoAsset.id, codec, JSON.stringify(payload));

    try {
        const result = await postProvider.generate('post', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_post_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (postProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(POST_ENDPOINT, 'post-production'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = `${shot.shot_code}_${codec}.${codecInfo.extension}`;
        ensureDir(scene.project_id, 'video');
        const filePath = await persistProviderMedia(scene.project_id, 'video', filename, result.data, { serveDir: 'videos' });

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, shot_id, asset_type, file_path, file_name,
                format, mime_type, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'video_encoded', ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, shotId, filePath, filename, codecInfo.extension, codecInfo.mime,
            postProvider.id, resultModel(result, payload), resultJobId(result)
        );

        db.prepare('UPDATE film_post_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            codec, codec_label: codecInfo.label,
            video_url: getFileUrl('video', scene.project_id, filename),
        });
    } catch (err) {
        db.prepare('UPDATE film_post_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (postProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(POST_ENDPOINT, 'post-production'));
        json(res, 500, { error: err.message });
    }
}

async function encodeProject(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const codec = (req.body && req.body.codec) || 'prores-422-lt';
    if (!SUPPORTED_CODECS[codec]) {
        return json(res, 400, { error: `Unsupported codec: ${codec}`, supported: Object.keys(SUPPORTED_CODECS) });
    }

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    const eligible = shots.filter(s => findLatestVideo(s.shot_id));

    json(res, 200, {
        project_id: projectId, codec, codec_label: SUPPORTED_CODECS[codec].label,
        eligible_shots: eligible.length,
        shots: eligible.map(s => ({ shot_id: s.shot_id, shot_code: s.shot_code })),
        supported_codecs: Object.entries(SUPPORTED_CODECS).map(([k, v]) => ({ id: k, label: v.label })),
    });
}

module.exports = { handlePostProduction };
