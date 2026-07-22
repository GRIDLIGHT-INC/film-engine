/**
 * FILM-090-093: Music & Sound Design Pipeline
 *
 * POST /film/scenes/:id/music/generate          - Generate score for a scene
 * POST /film/scenes/:id/music/generate/stream    - SSE streaming
 * POST /film/shots/:id/sfx/generate             - Generate SFX for a shot
 * POST /film/scenes/:id/ambient/generate        - Generate ambient for a scene
 * POST /film/projects/:id/music/batch           - Batch all music/SFX/ambient
 * POST /film/projects/:id/music/batch/stream    - SSE batch
 * GET  /film/projects/:id/music/jobs            - List all music jobs
 * GET  /film/music/:projectId/:filename         - Serve music files
 */

const { db, generateId } = require('../db/database');
const { callGridlight, relayGridlightSSE, serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, ensureDir, serveFile } = require('../lib/file-storage');
const { buildMusicPrompt, buildSFXPrompts, buildAmbientPrompt } = require('../lib/music-prompt');
const { buildMixPayload, calculateDucking, buildStemExport, generateSRT } = require('../lib/audio-mixer');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUSIC_ENDPOINT = '/music';
const MIX_ENDPOINT = '/audio/mix';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// -- Route Handler -------------------------------------------------------

function handleMusicGen(req, res, urlParts, query) {
    // /film/music/:projectId/:filename
    if (urlParts[1] === 'music' && urlParts[2] && urlParts[3] && !['projects', 'scenes', 'shots'].includes(urlParts[1])) {
        return serveFile(res, urlParts[2], 'music', urlParts[3]);
    }

    // /film/scenes/:id/music/generate[/stream]
    if (urlParts[1] === 'scenes' && urlParts[2] && urlParts[3] === 'music') {
        const sceneId = urlParts[2];
        if (!UUID_RE.test(sceneId)) return json(res, 400, { error: 'Invalid scene ID' });

        if (urlParts[4] === 'generate' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return generateMusicStream(req, res, sceneId);
            return generateMusic(req, res, sceneId);
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/scenes/:id/ambient/generate
    if (urlParts[1] === 'scenes' && urlParts[2] && urlParts[3] === 'ambient') {
        const sceneId = urlParts[2];
        if (!UUID_RE.test(sceneId)) return json(res, 400, { error: 'Invalid scene ID' });

        if (urlParts[4] === 'generate' && req.method === 'POST') {
            return generateAmbient(req, res, sceneId);
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/shots/:id/audio/mix  (FILM-093)
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'audio') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        if (urlParts[4] === 'mix' && req.method === 'POST') return mixShotAudio(req, res, shotId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/shots/:id/sfx/generate
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'sfx') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        if (urlParts[4] === 'generate' && req.method === 'POST') {
            return generateSFX(req, res, shotId);
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/music[/batch[/stream] | /jobs]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'music') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        const sub = urlParts[4];
        if (sub === 'batch' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return batchMusicStream(req, res, projectId);
            return batchMusic(req, res, projectId);
        }
        if (sub === 'jobs' && req.method === 'GET') return listMusicJobs(req, res, projectId, query);
        if (sub === 'mix' && req.method === 'POST') return mixProjectAudio(req, res, projectId);
        if (sub === 'stems' && req.method === 'POST') return exportStems(req, res, projectId);
        if (sub === 'srt' && req.method === 'GET') return exportSRT(req, res, projectId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Generate Music Score for a Scene ------------------------------------

async function generateMusic(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);

    // Find music cues for this scene, or create from request body
    let musicCue = db.prepare('SELECT * FROM film_music_cues WHERE scene_id = ? ORDER BY start_ms LIMIT 1').get(sceneId);
    if (!musicCue && req.body) {
        musicCue = { mood: req.body.mood, genre: req.body.genre, description: req.body.description };
    }

    const payload = buildMusicPrompt(musicCue, scene, project);

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_music_jobs (id, project_id, scene_id, music_cue_id, gen_type, status, prompt, model, duration_ms, tempo_bpm)
         VALUES (?, ?, ?, ?, 'score', 'generating', ?, ?, ?, ?)`
    ).run(jobId, scene.project_id, sceneId, musicCue && musicCue.id ? musicCue.id : null,
        payload.prompt, payload.model, payload.duration_s * 1000, payload.tempo_bpm);

    try {
        const result = await callGridlight(MUSIC_ENDPOINT, payload);

        if (!result.ok) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (result.status === 503) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = `${scene.scene_number || sceneId}_score.wav`;
        ensureDir(scene.project_id, 'music');
        let filePath = '';

        if (Buffer.isBuffer(result.data)) {
            filePath = saveFile(scene.project_id, 'music', filename, result.data);
        } else if (result.data && result.data.audio_url) {
            filePath = result.data.audio_url;
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_path, file_name, format, mime_type, duration_ms, version)
             VALUES (?, ?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', ?, 1)`
        ).run(assetId, scene.project_id, sceneId, filePath, filename, payload.duration_s * 1000);

        // Note: scene-level music is not a shot render, and render_ledger.shot_id
        // is NOT NULL + FK to film_shots — so we track it in film_music_jobs only.
        db.prepare('UPDATE film_music_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            scene_id: sceneId, job_id: jobId, status: 'complete',
            music_url: getFileUrl('music', scene.project_id, filename),
            duration_s: payload.duration_s, mood: payload.mood, genre: payload.genre,
        });
    } catch (err) {
        db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
        json(res, 500, { error: err.message });
    }
}

// -- SSE Streaming Music Generation --------------------------------------

async function generateMusicStream(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
    let musicCue = db.prepare('SELECT * FROM film_music_cues WHERE scene_id = ? ORDER BY start_ms LIMIT 1').get(sceneId);
    const payload = buildMusicPrompt(musicCue, scene, project);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };
    sendEvent({ type: 'status', phase: 'starting', scene_id: sceneId, mood: payload.mood });

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_music_jobs (id, project_id, scene_id, gen_type, status, prompt, model)
         VALUES (?, ?, ?, 'score', 'generating', ?, ?)`
    ).run(jobId, scene.project_id, sceneId, payload.prompt, payload.model);

    try {
        const { ok, error } = await relayGridlightSSE(MUSIC_ENDPOINT, payload, res, {
            onComplete: (data) => {
                const filename = `${scene.scene_number || sceneId}_score.wav`;
                ensureDir(scene.project_id, 'music');

                const assetId = generateId();
                db.prepare(
                    `INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_name, format, mime_type, version)
                     VALUES (?, ?, ?, 'audio_music', ?, 'wav', 'audio/wav', 1)`
                ).run(assetId, scene.project_id, sceneId, filename);

                db.prepare('UPDATE film_music_jobs SET status = ? WHERE id = ?').run('complete', jobId);
            },
            onError: (data) => {
                db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', data.error || 'Unknown', jobId);
            },
        });

        if (!ok) sendEvent({ type: 'error', error: error || 'Music generation failed' });
    } catch (err) {
        sendEvent({ type: 'error', error: err.message });
    }

    sendEvent({ type: 'done' });
    res.end();
}

// -- Generate SFX for a Shot ---------------------------------------------

async function generateSFX(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}

    const sfxPayloads = buildSFXPrompts(sceneCard, scene);
    if (sfxPayloads.length === 0) {
        return json(res, 200, { shot_id: shotId, message: 'No SFX cues found in scene card', sfx_files: [] });
    }

    ensureDir(scene.project_id, 'music');
    const results = [];

    for (let i = 0; i < sfxPayloads.length; i++) {
        const payload = sfxPayloads[i];
        const jobId = generateId();

        db.prepare(
            `INSERT INTO film_music_jobs (id, project_id, shot_id, gen_type, status, prompt, model, duration_ms)
             VALUES (?, ?, ?, 'sfx', 'generating', ?, ?, ?)`
        ).run(jobId, scene.project_id, shotId, payload.prompt, payload.model, payload.duration_s * 1000);

        try {
            const result = await callGridlight(MUSIC_ENDPOINT, payload);
            if (!result.ok) {
                db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
                results.push({ index: i, status: 'failed', error: result.error });
                continue;
            }

            const filename = `${shot.shot_code}_sfx_${i}.wav`;
            let filePath = '';
            if (Buffer.isBuffer(result.data)) {
                filePath = saveFile(scene.project_id, 'music', filename, result.data);
            }

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, version)
                 VALUES (?, ?, ?, 'audio_sfx', ?, ?, 'wav', 'audio/wav', 1)`
            ).run(assetId, scene.project_id, shotId, filePath, filename);

            db.prepare('UPDATE film_music_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);
            results.push({ index: i, status: 'complete', sfx_url: getFileUrl('music', scene.project_id, filename) });
        } catch (err) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            results.push({ index: i, status: 'failed', error: err.message });
        }
    }

    json(res, 200, { shot_id: shotId, sfx_count: sfxPayloads.length, sfx_files: results });
}

// -- Generate Ambient for a Scene ----------------------------------------

async function generateAmbient(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const location = scene.location_id
        ? db.prepare('SELECT * FROM film_locations WHERE id = ?').get(scene.location_id)
        : null;

    const payload = buildAmbientPrompt(scene, location);

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_music_jobs (id, project_id, scene_id, gen_type, status, prompt, model, duration_ms)
         VALUES (?, ?, ?, 'ambient', 'generating', ?, ?, ?)`
    ).run(jobId, scene.project_id, sceneId, payload.prompt, payload.model, payload.duration_s * 1000);

    try {
        const result = await callGridlight(MUSIC_ENDPOINT, payload);

        if (!result.ok) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (result.status === 503) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = `${scene.scene_number || sceneId}_ambient.wav`;
        ensureDir(scene.project_id, 'music');
        let filePath = '';

        if (Buffer.isBuffer(result.data)) {
            filePath = saveFile(scene.project_id, 'music', filename, result.data);
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_path, file_name, format, mime_type, duration_ms, version)
             VALUES (?, ?, ?, 'audio_ambient', ?, ?, 'wav', 'audio/wav', ?, 1)`
        ).run(assetId, scene.project_id, sceneId, filePath, filename, payload.duration_s * 1000);

        db.prepare('UPDATE film_music_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            scene_id: sceneId, job_id: jobId, status: 'complete',
            ambient_url: getFileUrl('music', scene.project_id, filename), duration_s: payload.duration_s,
        });
    } catch (err) {
        db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
        json(res, 500, { error: err.message });
    }
}

// -- Batch Music/SFX/Ambient ---------------------------------------------

async function batchMusicStream(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };

    const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number').all(projectId);
    sendEvent({ type: 'status', phase: 'starting', total_scenes: scenes.length, project_id: projectId });

    let completed = 0, failed = 0;

    for (const scene of scenes) {
        if (clientGone || res.writableEnded) break; // client disconnected — stop remaining scenes
        // Music score
        sendEvent({ type: 'scene_start', scene_id: scene.id, scene_number: scene.scene_number, phase: 'music' });
        let musicCue = db.prepare('SELECT * FROM film_music_cues WHERE scene_id = ? ORDER BY start_ms LIMIT 1').get(scene.id);
        const musicPayload = buildMusicPrompt(musicCue, scene, project);

        try {
            const result = await callGridlight(MUSIC_ENDPOINT, musicPayload);
            if (!result.ok) throw new Error(result.error);

            const filename = `${scene.scene_number || scene.id}_score.wav`;
            ensureDir(projectId, 'music');
            if (Buffer.isBuffer(result.data)) saveFile(projectId, 'music', filename, result.data);

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_name, format, mime_type, version)
                 VALUES (?, ?, ?, 'audio_music', ?, 'wav', 'audio/wav', 1)`
            ).run(assetId, projectId, scene.id, filename);

            sendEvent({ type: 'music_complete', scene_number: scene.scene_number, music_url: getFileUrl('music', projectId, filename) });
            completed++;
        } catch (err) {
            sendEvent({ type: 'music_failed', scene_number: scene.scene_number, error: err.message });
            failed++;
        }

        // Ambient
        if (clientGone || res.writableEnded) break; // client left mid-scene — skip ambient
        const location = scene.location_id ? db.prepare('SELECT * FROM film_locations WHERE id = ?').get(scene.location_id) : null;
        const ambientPayload = buildAmbientPrompt(scene, location);

        try {
            const result = await callGridlight(MUSIC_ENDPOINT, ambientPayload);
            if (!result.ok) throw new Error(result.error);

            const filename = `${scene.scene_number || scene.id}_ambient.wav`;
            if (Buffer.isBuffer(result.data)) saveFile(projectId, 'music', filename, result.data);

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_name, format, mime_type, version)
                 VALUES (?, ?, ?, 'audio_ambient', ?, 'wav', 'audio/wav', 1)`
            ).run(assetId, projectId, scene.id, filename);

            sendEvent({ type: 'ambient_complete', scene_number: scene.scene_number });
            completed++;
        } catch (err) {
            sendEvent({ type: 'ambient_failed', scene_number: scene.scene_number, error: err.message });
            failed++;
        }
    }

    sendEvent({ type: 'result', project_id: projectId, items_completed: completed, items_failed: failed });
    sendEvent({ type: 'done' });
    res.end();
}

async function batchMusic(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number').all(projectId);

    json(res, 200, {
        project_id: projectId, total_scenes: scenes.length,
        scenes: scenes.map(s => ({ scene_id: s.id, scene_number: s.scene_number, location: s.location })),
        hint: 'Use POST /film/projects/:id/music/batch/stream for actual generation with progress',
    });
}

// -- List Music Jobs -----------------------------------------------------

function listMusicJobs(req, res, projectId, query) {
    const genType = query.type || null;
    const status = query.status || null;

    let sql = 'SELECT * FROM film_music_jobs WHERE project_id = ?';
    const params = [projectId];

    if (genType) { sql += ' AND gen_type = ?'; params.push(genType); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';

    const jobs = db.prepare(sql).all(...params);
    json(res, 200, { project_id: projectId, total: jobs.length, jobs });
}

// -- FILM-093: Per-Shot Audio Mix -----------------------------------------

function collectShotAudioTracks(shotId, scene) {
    const tracks = [];

    // Dialogue
    const dialogueAssets = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'audio_dialogue' ORDER BY created_at DESC"
    ).all(shotId);
    for (const a of dialogueAssets) {
        tracks.push({
            type: 'dialogue', url: a.file_path || getFileUrl('audio', a.project_id, a.file_name),
            start_ms: 0, duration_ms: a.duration_ms || 0, gain_db: 0,
        });
    }

    // SFX
    const sfxAssets = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'audio_sfx' ORDER BY created_at DESC"
    ).all(shotId);
    for (const a of sfxAssets) {
        tracks.push({
            type: 'sfx', url: a.file_path || getFileUrl('music', a.project_id, a.file_name),
            start_ms: 0, duration_ms: a.duration_ms || 0, gain_db: -3,
        });
    }

    // Scene-level music
    if (scene) {
        const musicAssets = db.prepare(
            "SELECT * FROM film_assets WHERE scene_id = ? AND asset_type = 'audio_music' ORDER BY created_at DESC LIMIT 1"
        ).all(scene.id);
        for (const a of musicAssets) {
            tracks.push({
                type: 'music', url: a.file_path || getFileUrl('music', a.project_id, a.file_name),
                start_ms: 0, duration_ms: a.duration_ms || 0, gain_db: -6,
            });
        }

        // Scene-level ambient
        const ambientAssets = db.prepare(
            "SELECT * FROM film_assets WHERE scene_id = ? AND asset_type = 'audio_ambient' ORDER BY created_at DESC LIMIT 1"
        ).all(scene.id);
        for (const a of ambientAssets) {
            tracks.push({
                type: 'ambient', url: a.file_path || getFileUrl('music', a.project_id, a.file_name),
                start_ms: 0, duration_ms: a.duration_ms || 0, gain_db: -12,
            });
        }
    }

    return tracks;
}

async function mixShotAudio(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const tracks = collectShotAudioTracks(shotId, scene);

    if (tracks.length === 0) {
        return json(res, 200, { shot_id: shotId, message: 'No audio tracks found for this shot', tracks: [] });
    }

    // Build ducking from dialogue regions
    const dialogueRegions = tracks
        .filter(t => t.type === 'dialogue')
        .map(t => ({ start_ms: t.start_ms, end_ms: t.start_ms + (t.duration_ms || 3000) }));
    const ducking = calculateDucking(dialogueRegions);

    const payload = buildMixPayload(tracks, {
        ...(req.body || {}),
        output_filename: `${shot.shot_code}_mix.wav`,
    });

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_audio_mix_jobs (id, project_id, shot_id, status, track_count, lufs_target, ducking_enabled, params)
         VALUES (?, ?, ?, 'processing', ?, ?, ?, ?)`
    ).run(jobId, scene.project_id, shotId, tracks.length,
        payload.master.lufs_target, payload.ducking.enabled ? 1 : 0, JSON.stringify(payload));

    try {
        const result = await callGridlight(MIX_ENDPOINT, payload);

        if (!result.ok) {
            db.prepare('UPDATE film_audio_mix_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (result.status === 503) return json(res, 503, serviceUnavailableError(MIX_ENDPOINT, 'audio mix'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = `${shot.shot_code}_mix.wav`;
        ensureDir(scene.project_id, 'music');
        let filePath = '';
        if (Buffer.isBuffer(result.data)) {
            filePath = saveFile(scene.project_id, 'music', filename, result.data);
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, version)
             VALUES (?, ?, ?, 'audio_mix', ?, ?, 'wav', 'audio/wav', 1)`
        ).run(assetId, scene.project_id, shotId, filePath, filename);

        db.prepare('UPDATE film_audio_mix_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            mix_url: getFileUrl('music', scene.project_id, filename),
            track_count: tracks.length, ducking_events: ducking.length,
        });
    } catch (err) {
        db.prepare('UPDATE film_audio_mix_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(MIX_ENDPOINT, 'audio mix'));
        json(res, 500, { error: err.message });
    }
}

// -- FILM-063: Audio Deliverables Packaging + SRT -------------------------

async function mixProjectAudio(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_id FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    const eligible = [];
    for (const shot of shots) {
        const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
        const tracks = collectShotAudioTracks(shot.shot_id, scene);
        if (tracks.length > 0) {
            eligible.push({ shot_id: shot.shot_id, shot_code: shot.shot_code, track_count: tracks.length });
        }
    }

    json(res, 200, {
        project_id: projectId, eligible_shots: eligible.length, shots: eligible,
        hint: 'POST /film/shots/:id/audio/mix for per-shot mixing, or POST /film/projects/:id/music/stems for stem export.',
    });
}

async function exportStems(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    // Collect all audio assets across the project
    const allTracks = [];
    const assets = db.prepare(
        "SELECT * FROM film_assets WHERE project_id = ? AND asset_type LIKE 'audio_%' ORDER BY created_at"
    ).all(projectId);

    for (const a of assets) {
        const typeMap = { audio_dialogue: 'dialogue', audio_music: 'music', audio_sfx: 'sfx', audio_ambient: 'ambient', audio_mix: 'mix' };
        allTracks.push({
            type: typeMap[a.asset_type] || 'other',
            url: a.file_path || a.file_name,
            start_ms: 0, duration_ms: a.duration_ms || 0,
        });
    }

    const stemPayload = buildStemExport(allTracks, req.body);

    json(res, 200, {
        project_id: projectId, total_tracks: allTracks.length,
        stems: stemPayload.stems.map(s => ({ name: s.stem_name, track_count: s.tracks.length })),
        payload: stemPayload,
        hint: 'Stem export payload ready. Send to audio processing endpoint for rendering.',
    });
}

function exportSRT(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    // Collect all dialogue from scene cards
    const shots = db.prepare(
        `SELECT s.id, s.shot_code, s.scene_card_yaml, s.duration_ms, sc.scene_number
         FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? AND sc.status != 'removed'
         ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    const dialogueLines = [];
    let cumulativeMs = 0;

    for (const shot of shots) {
        let card = {};
        try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}
        const dialogue = card.dialogue || [];
        const shotDur = shot.duration_ms || 4000;
        const lineInterval = dialogue.length > 0 ? shotDur / dialogue.length : shotDur;

        for (let i = 0; i < dialogue.length; i++) {
            if (!dialogue[i].line) continue;
            dialogueLines.push({
                character: dialogue[i].character || '',
                line: dialogue[i].line,
                start_ms: cumulativeMs + Math.round(i * lineInterval),
                end_ms: cumulativeMs + Math.round((i + 1) * lineInterval),
            });
        }
        cumulativeMs += shotDur;
    }

    const includeChar = !req.query || req.query.include_character !== 'false';
    const srt = generateSRT(dialogueLines, { include_character: includeChar });

    const safeTitle = (project.title || 'subtitles').replace(/[^a-zA-Z0-9_-]/g, '_');

    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeTitle}.srt"`,
    });
    res.end(srt);
}

module.exports = { handleMusicGen };
