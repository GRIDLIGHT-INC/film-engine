/**
 * FILM-036-040: Lip-Sync & Performance Pipeline
 *
 * POST /film/shots/:id/lipsync/generate          - Lip-sync video + dialogue audio
 * POST /film/shots/:id/lipsync/generate/stream    - SSE streaming
 * POST /film/projects/:id/lipsync/batch           - Batch all shots with dialogue
 * GET  /film/shots/:id/lipsync                    - Get lipsync job status
 * GET  /film/projects/:id/lipsync                 - List all lipsync jobs
 */

const { db, generateId } = require('../db/database');
const { serviceUnavailableError } = require('../lib/gridlight-client');
const { getFileUrl, ensureDir } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const { buildVisemeTrack, mergeVisemesWithAudio } = require('../lib/viseme-builder');
const { resolve, get } = require('../lib/providers');
const { providerConfigFor, spendContext } = require('../lib/provider-config');
const { buildCapabilityPayload } = require('../lib/capability-payloads');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIPSYNC_ENDPOINT = '/lipsync';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// One implementation, in lib/provider-config.js — it also tags the config
// with the project id so spend can be attributed. See that file for why.
const parseProjectConfig = providerConfigFor;

function resolveGenerator(capability, projectConfig) {
    const adapter = resolve(capability, projectConfig);
    if (adapter && typeof adapter.generate === 'function') return adapter;
    return get('gridlight');
}

function resolveStreamGenerator(capability, projectConfig) {
    const adapter = resolveGenerator(capability, projectConfig);
    if (adapter && typeof adapter.generateStream === 'function') return adapter;
    return get('gridlight');
}

function resultModel(result, payload) {
    return (result && result.provider_model) || (payload && payload.model) || '';
}

function resultJobId(result) {
    return (result && result.provider_job_id) || '';
}

// -- Route Handler -------------------------------------------------------

function handleLipsync(req, res, urlParts, query) {
    // /film/shots/:id/lipsync[/generate[/stream]]
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'lipsync') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        const sub = urlParts[4];
        if (sub === 'generate' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return generateLipsyncStream(req, res, shotId);
            return generateLipsync(req, res, shotId);
        }
        if (sub === 'viseme' && req.method === 'POST') return generateVisemeTrack(req, res, shotId);
        if (sub === 'viseme' && req.method === 'GET') return getVisemeTracks(req, res, shotId);
        if (sub === 'viseme-sync' && req.method === 'POST') return visemeGuidedSync(req, res, shotId);
        if (!sub && req.method === 'GET') return getLipsyncStatus(req, res, shotId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/lipsync[/batch]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'lipsync') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        const sub = urlParts[4];
        if (sub === 'batch' && req.method === 'POST') return batchLipsync(req, res, projectId);
        if (!sub && req.method === 'GET') return listLipsyncJobs(req, res, projectId, query);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Helpers -------------------------------------------------------------

function findShotAssets(shotId) {
    const videoAsset = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'video_raw' ORDER BY created_at DESC LIMIT 1"
    ).get(shotId);

    const audioAsset = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'audio_dialogue' ORDER BY created_at DESC LIMIT 1"
    ).get(shotId);

    return { videoAsset, audioAsset };
}

// -- Generate Lipsync for a Shot -----------------------------------------

async function generateLipsync(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });
    const lipsyncProvider = resolveGenerator('lipsync', spendContext({ id: scene.project_id }, shot, scene));

    const { videoAsset, audioAsset } = findShotAssets(shotId);
    if (!videoAsset) return json(res, 400, { error: 'No video asset found for this shot. Generate video first.' });
    if (!audioAsset) return json(res, 400, { error: 'No audio dialogue asset found for this shot. Generate voice first.' });

    // Built by capability-payloads rather than assembled here, so the
    // orchestrator and this route request lip-sync identically. The 400s above
    // stay: a route can explain a missing prerequisite to a user better than a
    // thrown builder error can.
    const { payload } = buildCapabilityPayload('lipsync', {
        scene, shot, videoAsset, audioAsset,
        overrides: {
            model: req.body && req.body.model,
            quality: req.body && req.body.quality,
        },
    });

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_lipsync_jobs (id, project_id, shot_id, video_asset_id, audio_asset_id, status, model, quality)
         VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)`
    ).run(jobId, scene.project_id, shotId, videoAsset.id, audioAsset.id, payload.model, payload.quality);

    try {
        const result = await lipsyncProvider.generate('lipsync', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_lipsync_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (lipsyncProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(LIPSYNC_ENDPOINT, 'lipsync'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = `${shot.shot_code}_synced.mp4`;
        ensureDir(scene.project_id, 'video');
        const filePath = await persistProviderMedia(scene.project_id, 'video', filename, result.data, { serveDir: 'videos' });

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, shot_id, asset_type, file_path, file_name,
                format, mime_type, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'video_synced', ?, ?, 'mp4', 'video/mp4', 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, shotId, filePath, filename,
            lipsyncProvider.id, resultModel(result, payload), resultJobId(result)
        );

        db.prepare(
            `INSERT INTO render_ledger (id, shot_id, version, step, model_id, prompt, mode)
             VALUES (?, ?, 1, 'lipsync', ?, ?, 'creative')`
        ).run(generateId(), shotId, payload.model, `video:${videoAsset.id} + audio:${audioAsset.id}`);

        db.prepare('UPDATE film_lipsync_jobs SET status = ?, output_path = ? WHERE id = ?')
            .run('complete', filePath, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            video_url: getFileUrl('video', scene.project_id, filename),
        });
    } catch (err) {
        db.prepare('UPDATE film_lipsync_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (lipsyncProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(LIPSYNC_ENDPOINT, 'lipsync'));
        json(res, 500, { error: err.message });
    }
}

// -- SSE Streaming Lipsync -----------------------------------------------

async function generateLipsyncStream(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });
    const lipsyncProvider = resolveStreamGenerator('lipsync', parseProjectConfig(scene.project_id));

    const { videoAsset, audioAsset } = findShotAssets(shotId);
    if (!videoAsset || !audioAsset) {
        return json(res, 400, { error: 'Missing video or audio assets. Generate them first.' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };
    sendEvent({ type: 'status', phase: 'starting', shot_id: shotId });

    const payload = {
        video_url: videoAsset.file_path || videoAsset.file_name,
        audio_url: audioAsset.file_path || audioAsset.file_name,
        model: 'wav2lip', quality: 'high', output_format: 'mp4',
    };

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_lipsync_jobs (id, project_id, shot_id, video_asset_id, audio_asset_id, status, model)
         VALUES (?, ?, ?, ?, ?, 'processing', ?)`
    ).run(jobId, scene.project_id, shotId, videoAsset.id, audioAsset.id, payload.model);

    try {
        const { ok, error } = await lipsyncProvider.generateStream('lipsync', payload, res, {
            onComplete: (data) => {
                const filename = `${shot.shot_code}_synced.mp4`;
                ensureDir(scene.project_id, 'video');

                const assetId = generateId();
                db.prepare(
                    `INSERT INTO film_assets (
                        id, project_id, shot_id, asset_type, file_name, format, mime_type, version,
                        provider, provider_model, provider_job_id, license_source, license_status
                     )
                     VALUES (?, ?, ?, 'video_synced', ?, 'mp4', 'video/mp4', 1, ?, ?, ?, 'generated', 'generated')`
                ).run(
                    assetId, scene.project_id, shotId, filename,
                    lipsyncProvider.id, resultModel(data, payload), resultJobId(data)
                );

                db.prepare('UPDATE film_lipsync_jobs SET status = ? WHERE id = ?').run('complete', jobId);
            },
            onError: (data) => {
                db.prepare('UPDATE film_lipsync_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', data.error || 'Unknown', jobId);
            },
        });

        if (!ok) {
            sendEvent({ type: 'error', error: error || 'Lipsync failed' });
        }
    } catch (err) {
        sendEvent({ type: 'error', error: err.message });
        db.prepare('UPDATE film_lipsync_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
    }

    sendEvent({ type: 'done' });
    res.end();
}

// -- Batch Lipsync -------------------------------------------------------

async function batchLipsync(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    const eligible = [];
    for (const shot of shots) {
        const { videoAsset, audioAsset } = findShotAssets(shot.shot_id);
        if (videoAsset && audioAsset) {
            eligible.push({ shot_id: shot.shot_id, shot_code: shot.shot_code });
        }
    }

    json(res, 200, {
        project_id: projectId, eligible_shots: eligible.length, shots: eligible,
        hint: 'Each eligible shot has both video and dialogue audio assets ready for lip-sync.',
    });
}

// -- Status & Listing ----------------------------------------------------

function getLipsyncStatus(req, res, shotId) {
    const jobs = db.prepare('SELECT * FROM film_lipsync_jobs WHERE shot_id = ? ORDER BY created_at DESC').all(shotId);
    const assets = db.prepare("SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'video_synced' ORDER BY created_at DESC").all(shotId);

    json(res, 200, {
        shot_id: shotId, jobs,
        synced_videos: assets.map(a => ({
            asset_id: a.id, file_name: a.file_name,
            video_url: a.file_name ? getFileUrl('video', a.project_id, a.file_name) : null,
        })),
    });
}

function listLipsyncJobs(req, res, projectId, query) {
    const status = query.status || null;
    let jobs;
    if (status) {
        jobs = db.prepare('SELECT * FROM film_lipsync_jobs WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(projectId, status);
    } else {
        jobs = db.prepare('SELECT * FROM film_lipsync_jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
    }
    json(res, 200, { project_id: projectId, total: jobs.length, jobs });
}

// -- FILM-027: Viseme Track Generation ------------------------------------

async function generateVisemeTrack(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (e) { console.error('[lipsync] stored sceneCard is not valid JSON; using the default:', e.message); }

    const dialogue = sceneCard.dialogue || [];
    if (dialogue.length === 0) {
        return json(res, 200, { shot_id: shotId, message: 'No dialogue in this shot', viseme_tracks: [] });
    }

    const tracks = [];
    for (const line of dialogue) {
        if (!line.character || !line.line) continue;

        const durationMs = shot.duration_ms || 4000;
        const track = buildVisemeTrack(line.line, durationMs);

        const trackId = generateId();
        db.prepare(
            `INSERT INTO film_viseme_tracks (id, project_id, shot_id, character_id, dialogue_text, viseme_data, duration_ms, phoneme_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(trackId, scene.project_id, shotId, null, line.line,
            JSON.stringify(track.visemes), track.duration_ms, track.phoneme_count);

        tracks.push({
            track_id: trackId, character: line.character,
            dialogue: line.line, ...track,
        });
    }

    json(res, 200, { shot_id: shotId, shot_code: shot.shot_code, viseme_tracks: tracks });
}

function getVisemeTracks(req, res, shotId) {
    const tracks = db.prepare('SELECT * FROM film_viseme_tracks WHERE shot_id = ? ORDER BY created_at DESC').all(shotId);
    json(res, 200, {
        shot_id: shotId,
        tracks: tracks.map(t => ({
            ...t,
            viseme_data: t.viseme_data ? JSON.parse(t.viseme_data) : [],
        })),
    });
}

// -- FILM-039: Viseme-Guided Sync Enhancement -----------------------------

async function visemeGuidedSync(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const lipsyncProvider = resolveGenerator('lipsync', spendContext({ id: scene.project_id }, shot, scene));

    // Get viseme tracks for this shot
    const visemeTracks = db.prepare('SELECT * FROM film_viseme_tracks WHERE shot_id = ? ORDER BY created_at DESC').all(shotId);
    if (visemeTracks.length === 0) {
        return json(res, 400, { error: 'No viseme tracks found. Generate viseme tracks first.' });
    }

    // Get video and audio assets
    const { videoAsset, audioAsset } = findShotAssets(shotId);
    if (!videoAsset) return json(res, 400, { error: 'No video asset found.' });
    if (!audioAsset) return json(res, 400, { error: 'No audio asset found.' });

    // Build enhanced lipsync payload with viseme guidance
    const latestViseme = visemeTracks[0];
    let visemeData = [];
    try { visemeData = JSON.parse(latestViseme.viseme_data || '[]'); } catch (e) { console.error('[lipsync] stored visemeData is not valid JSON; using the default:', e.message); }

    // If audio timings are provided in the request, merge them
    const audioTimings = (req.body && req.body.audio_timings) || null;
    let finalTrack = { visemes: visemeData, duration_ms: latestViseme.duration_ms, phoneme_count: latestViseme.phoneme_count };
    if (audioTimings) {
        finalTrack = mergeVisemesWithAudio(finalTrack, audioTimings);

        // Update stored track
        db.prepare('UPDATE film_viseme_tracks SET viseme_data = ?, audio_aligned = 1 WHERE id = ?')
            .run(JSON.stringify(finalTrack.visemes), latestViseme.id);
    }

    const payload = {
        video_url: videoAsset.file_path || getFileUrl('video', scene.project_id, videoAsset.file_name),
        audio_url: audioAsset.file_path || getFileUrl('audio', scene.project_id, audioAsset.file_name),
        model: (req.body && req.body.model) || 'wav2lip',
        quality: 'high',
        output_format: 'mp4',
        viseme_guidance: {
            enabled: true,
            visemes: finalTrack.visemes,
            blend_weight: (req.body && req.body.viseme_weight) || 0.7,
        },
    };

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_lipsync_jobs (id, project_id, shot_id, video_asset_id, audio_asset_id, status, model, quality)
         VALUES (?, ?, ?, ?, ?, 'processing', ?, 'high')`
    ).run(jobId, scene.project_id, shotId, videoAsset.id, audioAsset.id, payload.model);

    try {
        const result = await lipsyncProvider.generate('lipsync', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_lipsync_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (lipsyncProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(LIPSYNC_ENDPOINT, 'lipsync'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = `${shot.shot_code}_viseme_synced.mp4`;
        ensureDir(scene.project_id, 'video');
        const filePath = await persistProviderMedia(scene.project_id, 'video', filename, result.data, { serveDir: 'videos' });

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, shot_id, asset_type, file_path, file_name,
                format, mime_type, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'video_synced', ?, ?, 'mp4', 'video/mp4', 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, shotId, filePath, filename,
            lipsyncProvider.id, resultModel(result, payload), resultJobId(result)
        );

        db.prepare('UPDATE film_lipsync_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            video_url: getFileUrl('video', scene.project_id, filename),
            viseme_guided: true, viseme_count: finalTrack.visemes.length,
        });
    } catch (err) {
        db.prepare('UPDATE film_lipsync_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (lipsyncProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(LIPSYNC_ENDPOINT, 'lipsync'));
        json(res, 500, { error: err.message });
    }
}

module.exports = { handleLipsync };
