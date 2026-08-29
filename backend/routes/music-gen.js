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
const { callGridlight, serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, ensureDir, serveFile } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const { buildMusicPrompt, buildSFXPrompts, buildAmbientPrompt } = require('../lib/music-prompt');
const { buildMixPayload, calculateDucking, buildStemExport, generateSRT } = require('../lib/audio-mixer');
const { resolve, get } = require('../lib/providers');
const { providerConfigFor, spendContext } = require('../lib/provider-config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUSIC_ENDPOINT = '/music';
const MIX_ENDPOINT = '/audio/mix';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// One implementation, in lib/provider-config.js — it also tags the config
// with the project id so spend can be attributed. See that file for why.
const parseProjectConfig = providerConfigFor;

function resultModel(result, payload) {
    return (result && result.provider_model) || (payload && payload.model) || '';
}

function resultJobId(result) {
    return (result && result.provider_job_id) || '';
}

function resolveGenerator(capability, projectConfig) {
    const adapter = resolve(capability, projectConfig);
    if (adapter && typeof adapter.generate === 'function') return adapter;
    return get('gridlight');
}

function formatForResult(result) {
    const format = result && result.meta && result.meta.format ? result.meta.format : '';
    if (format) return format;
    const contentType = result && result.contentType ? result.contentType : '';
    if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
    return 'wav';
}

function mimeForResult(result) {
    return (result && result.contentType) || (formatForResult(result) === 'mp3' ? 'audio/mpeg' : 'audio/wav');
}

function filenameForResult(baseFilename, result) {
    const format = formatForResult(result);
    if (format === 'mp3') return baseFilename.replace(/\.[^.]+$/, '.mp3');
    return baseFilename.replace(/\.[^.]+$/, '.wav');
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

        // The brief is a SIBLING of generate, not a child of it: nested inside
        // the POST branch a GET could never reach it.
        if (urlParts[4] === 'brief' && req.method === 'GET') return musicBrief(req, res, sceneId);
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

/**
 * Everything the engine knows about a scene, for a score.
 *
 * Gathered here rather than at each call site, because three of them build a
 * music payload and only one of them getting the scene is how a batch comes
 * back as wallpaper while a single generation sounds right.
 */
function sceneScoreContext(scene) {
    const { sceneCutLength } = require('../lib/clip-coverage');
    const shots = db.prepare('SELECT id, scene_card_yaml FROM film_shots WHERE scene_id = ?').all(scene.id);

    let dialogueLines = 0;
    const cast = new Set();
    for (const shot of shots) {
        let card = {};
        try { card = JSON.parse(shot.scene_card_yaml || '{}') || {}; } catch (_) { card = {}; }
        for (const d of (card.dialogue || [])) {
            dialogueLines++;
            if (d.character) cast.add(String(d.character).toUpperCase());
        }
        for (const c of (card.characters || [])) {
            cast.add(String(typeof c === 'string' ? c : (c && c.name) || '').toUpperCase());
        }
    }
    cast.delete('');

    /*
     * A dialogue-only scene has a length too.
     *
     * sceneCutLength reads measured CLIPS, so a scene with no footage returns
     * null and the cue falls to thirty seconds. The Glass Harbour diner scene
     * has no clips and 216 seconds of measured dialogue — scoring it at 30
     * writes a cue for a scene that does not exist.
     */
    const dialogueMs = db.prepare(
        `SELECT COALESCE(SUM(a.duration_ms), 0) AS ms FROM film_assets a
           JOIN film_shots sh ON sh.id = a.shot_id
          WHERE sh.scene_id = ? AND a.asset_type = 'audio_dialogue'`).get(scene.id).ms || 0;

    return {
        characters: [...cast],
        dialogue_lines: dialogueLines,
        shot_count: shots.length,
        cut_ms: sceneCutLength(db, scene.id),
        dialogue_ms: dialogueMs,
    };
}

/**
 * The cue this scene is scored from.
 *
 * A cue somebody WROTE always wins — it is the musical direction, and deriving
 * over it would overrule the director. With no cue, the scene's own facts are
 * used rather than the defaults, which is the whole fix: the old fallback was
 * `mood: calm, genre: ambient` for every scene in every film.
 */
function cueForScene(scene, project, body) {
    const { scoreBrief, cueFromBrief, cueSeconds } = require('../lib/scene-score');
    const written = db.prepare(
        'SELECT * FROM film_music_cues WHERE scene_id = ? ORDER BY start_ms LIMIT 1').get(scene.id);
    const context = sceneScoreContext(scene);

    const length = cueSeconds({
        cue_ms: written && written.duration_ms,
        cut_ms: context.cut_ms,
        dialogue_ms: context.dialogue_ms,
        explain: true,
    });

    if (written) {
        return { cue: written, context, length, derived: false,
            brief: scoreBrief(scene, context, project) };
    }

    const brief = scoreBrief(scene, context, project);
    const derived = cueFromBrief(brief);
    // A body may still steer it: mood and genre are judgements, and a caller
    // saying "make it tense" must beat a derivation that had no opinion.
    if (body && body.mood) derived.mood = body.mood;
    if (body && body.genre) derived.genre = body.genre;
    if (body && body.description) derived.description = body.description;
    if (length.seconds) derived.duration_ms = length.seconds * 1000;

    return { cue: derived, context, length, derived: true, brief };
}

/**
 * What this scene is, for somebody deciding what it should sound like.
 *
 * FREE, and it returns no conclusion. What a scene should sound like is a
 * judgement and the connected agent is the model here, so the engine assembles
 * the facts and validates the answer rather than asking a second LLM what the
 * music is. Write the answer back with music_cue_create.
 */
function musicBrief(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);

    const scored = cueForScene(scene, project, null);
    const { buildMusicPrompt } = require('../lib/music-prompt');
    const wouldSend = buildMusicPrompt(scored.cue, scene, project);
    if (scored.length.seconds) wouldSend.duration_s = scored.length.seconds;

    return json(res, 200, {
        free: true,
        scene_id: sceneId,
        scene: {
            number: scene.scene_number,
            heading: `${scene.int_ext || ''} ${scene.location || ''} - ${scene.time_of_day || ''}`.trim(),
            description: scene.description || null,
        },
        facts: scored.brief.facts,
        length: scored.length,
        // What a cue somebody already wrote says, or null — so a model knows
        // whether it is writing the direction or reading it.
        existing_cue: scored.derived ? null : {
            mood: scored.cue.mood, genre: scored.cue.genre,
            description: scored.cue.description,
            reference_track: scored.cue.reference_track || null,
        },
        derived_description: scored.brief.description,
        would_send: { prompt: wouldSend.prompt, duration_s: wouldSend.duration_s },
        guidance: 'Decide the mood, the genre, the instruments and a reference track, then store '
            + 'them with music_cue_create. A cue you write always beats the derivation. Note the '
            + 'dialogue count: a wall-to-wall dialogue scene wants sparse underscore that never '
            + 'becomes melodic, because a melody there fights the words.',
    });
}

async function generateMusic(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
    const musicProvider = resolveGenerator('music', spendContext({ id: scene.project_id }, null, scene));

    // Find music cues for this scene, or create from request body
    const scored = cueForScene(scene, project, req.body);
    let musicCue = scored.cue;

    const payload = buildMusicPrompt(musicCue, scene, project);
    /*
     * The length the SCENE is, not the length a default guessed.
     *
     * Named, because "216 seconds because that is how long the dialogue runs"
     * and "30 seconds because nothing was measured" are different claims and a
     * director planning against the second needs to know which they have.
     */
    if (scored && scored.length && scored.length.seconds) {
        payload.duration_s = scored.length.seconds;
        payload.duration_source = scored.length.source;
    }

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_music_jobs (id, project_id, scene_id, music_cue_id, gen_type, status, prompt, model, duration_ms, tempo_bpm)
         VALUES (?, ?, ?, ?, 'score', 'generating', ?, ?, ?, ?)`
    ).run(jobId, scene.project_id, sceneId, musicCue && musicCue.id ? musicCue.id : null,
        payload.prompt, payload.model, payload.duration_s * 1000, payload.tempo_bpm);

    try {
        const result = await musicProvider.generate('music', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (musicProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = filenameForResult(`${scene.scene_number || sceneId}_score.wav`, result);
        ensureDir(scene.project_id, 'music');

        let filePath;
        try {
            filePath = await persistProviderMedia(scene.project_id, 'music', filename, result.data, { serveDir: 'music' });
        } catch (err) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            return json(res, 502, { error: `music generated but could not be stored: ${err.message}` });
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, scene_id, asset_type, file_path, file_name,
                format, mime_type, duration_ms, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'audio_music', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, sceneId, filePath, filename, formatForResult(result), mimeForResult(result), payload.duration_s * 1000,
            musicProvider.id, resultModel(result, payload), resultJobId(result)
        );

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
        if (musicProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
        json(res, 500, { error: err.message });
    }
}

// -- SSE Streaming Music Generation --------------------------------------

async function generateMusicStream(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
    const musicProvider = resolveGenerator('music', spendContext({ id: scene.project_id }, null, scene));
    const scored = cueForScene(scene, project, req.body);
    let musicCue = scored.cue;
    const payload = buildMusicPrompt(musicCue, scene, project);
    /*
     * The length the SCENE is, not the length a default guessed.
     *
     * Named, because "216 seconds because that is how long the dialogue runs"
     * and "30 seconds because nothing was measured" are different claims and a
     * director planning against the second needs to know which they have.
     */
    if (scored && scored.length && scored.length.seconds) {
        payload.duration_s = scored.length.seconds;
        payload.duration_source = scored.length.source;
    }

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
        // The SSE relay calls onComplete synchronously, so the download happens
        // after the stream resolves; otherwise the asset keeps an empty
        // file_path and never reaches the timeline as real media.
        let streamedAsset = null;

        const { ok, error } = await musicProvider.generateStream('music', payload, res, {
            onComplete: (data) => {
                const filename = filenameForResult(`${scene.scene_number || sceneId}_score.wav`, data);
                ensureDir(scene.project_id, 'music');

                const assetId = generateId();
                streamedAsset = { assetId, filename, data };
                db.prepare(
                    `INSERT INTO film_assets (
                        id, project_id, scene_id, asset_type, file_name, format, mime_type, version,
                        provider, provider_model, provider_job_id, license_source, license_status
                     )
                     VALUES (?, ?, ?, 'audio_music', ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
                ).run(
                    assetId, scene.project_id, sceneId, filename, formatForResult(data), mimeForResult(data),
                    musicProvider.id, resultModel(data, payload), resultJobId(data)
                );

                db.prepare('UPDATE film_music_jobs SET status = ? WHERE id = ?').run('complete', jobId);
            },
            onError: (data) => {
                db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', data.error || 'Unknown', jobId);
            },
        });

        if (!ok) {
            sendEvent({ type: 'error', error: error || 'Music generation failed' });
        } else if (streamedAsset) {
            try {
                const filePath = await persistProviderMedia(
                    scene.project_id, 'music', streamedAsset.filename, streamedAsset.data, { serveDir: 'music' }
                );
                db.prepare('UPDATE film_assets SET file_path = ? WHERE id = ?').run(filePath, streamedAsset.assetId);
            } catch (err) {
                db.prepare('DELETE FROM film_assets WHERE id = ?').run(streamedAsset.assetId);
                db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', `media not stored: ${err.message}`, jobId);
                sendEvent({ type: 'error', error: `music generated but could not be stored: ${err.message}` });
            }
        }
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
    const sfxProvider = resolveGenerator('sfx', spendContext({ id: scene.project_id }, shot, scene));

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
            const result = await sfxProvider.generate('sfx', payload, { timeout: 300000 });
            if (!result.ok) {
                db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
                results.push({ index: i, status: 'failed', error: result.error });
                continue;
            }

            const filename = filenameForResult(`${shot.shot_code}_sfx_${i}.wav`, result);
            let filePath;
            try {
                filePath = await persistProviderMedia(scene.project_id, 'music', filename, result.data, { serveDir: 'music' });
            } catch (err) {
                results.push({ index: i, status: 'failed', error: `sfx generated but could not be stored: ${err.message}` });
                continue;
            }

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, shot_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'audio_sfx', ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, scene.project_id, shotId, filePath, filename, formatForResult(result), mimeForResult(result),
                sfxProvider.id, resultModel(result, payload), resultJobId(result)
            );

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
    const ambientProvider = resolveGenerator('ambient', spendContext({ id: scene.project_id }, null, scene));

    const payload = buildAmbientPrompt(scene, location);

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_music_jobs (id, project_id, scene_id, gen_type, status, prompt, model, duration_ms)
         VALUES (?, ?, ?, 'ambient', 'generating', ?, ?, ?)`
    ).run(jobId, scene.project_id, sceneId, payload.prompt, payload.model, payload.duration_s * 1000);

    try {
        const result = await ambientProvider.generate('ambient', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (ambientProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
            return json(res, result.status || 500, { error: result.error });
        }

        const filename = filenameForResult(`${scene.scene_number || sceneId}_ambient.wav`, result);
        ensureDir(scene.project_id, 'music');

        let filePath;
        try {
            filePath = await persistProviderMedia(scene.project_id, 'music', filename, result.data, { serveDir: 'music' });
        } catch (err) {
            db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            return json(res, 502, { error: `ambient generated but could not be stored: ${err.message}` });
        }

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, scene_id, asset_type, file_path, file_name,
                format, mime_type, duration_ms, version,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, ?, 'audio_ambient', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, scene.project_id, sceneId, filePath, filename, formatForResult(result), mimeForResult(result), payload.duration_s * 1000,
            ambientProvider.id, resultModel(result, payload), resultJobId(result)
        );

        db.prepare('UPDATE film_music_jobs SET status = ?, output_path = ? WHERE id = ?').run('complete', filePath, jobId);

        json(res, 200, {
            scene_id: sceneId, job_id: jobId, status: 'complete',
            ambient_url: getFileUrl('music', scene.project_id, filename), duration_s: payload.duration_s,
        });
    } catch (err) {
        db.prepare('UPDATE film_music_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (ambientProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(MUSIC_ENDPOINT, 'music'));
        json(res, 500, { error: err.message });
    }
}

// -- Batch Music/SFX/Ambient ---------------------------------------------

async function batchMusicStream(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const providerConfig = parseProjectConfig(projectId);
    const musicProvider = resolveGenerator('music', providerConfig);
    const ambientProvider = resolveGenerator('ambient', providerConfig);

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
            const result = await musicProvider.generate('music', musicPayload, { timeout: 300000 });
            if (!result.ok) throw new Error(result.error);

            const filename = filenameForResult(`${scene.scene_number || scene.id}_score.wav`, result);
            ensureDir(projectId, 'music');
            const filePath = await persistProviderMedia(projectId, 'music', filename, result.data, { serveDir: 'music' });

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, scene_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'audio_music', ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, projectId, scene.id, filePath, filename, formatForResult(result), mimeForResult(result),
                musicProvider.id, resultModel(result, musicPayload), resultJobId(result)
            );

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
            const result = await ambientProvider.generate('ambient', ambientPayload, { timeout: 300000 });
            if (!result.ok) throw new Error(result.error);

            const filename = filenameForResult(`${scene.scene_number || scene.id}_ambient.wav`, result);
            const filePath = await persistProviderMedia(projectId, 'music', filename, result.data, { serveDir: 'music' });

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, scene_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status
                 )
                 VALUES (?, ?, ?, 'audio_ambient', ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated')`
            ).run(
                assetId, projectId, scene.id, filePath, filename, formatForResult(result), mimeForResult(result),
                ambientProvider.id, resultModel(result, ambientPayload), resultJobId(result)
            );

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
    // Imported beds have no generation job by design. Return the durable asset
    // slots beside jobs so Music & Sound can show and play either provenance.
    const assets = db.prepare(`SELECT * FROM film_assets
        WHERE project_id = ? AND asset_type IN ('audio_music','audio_ambient')
        ORDER BY created_at DESC`).all(projectId).map(a => ({
        ...a,
        url: a.file_name ? getFileUrl('music', a.project_id, a.file_name) : null,
    }));
    json(res, 200, { project_id: projectId, total: jobs.length, jobs, assets });
}

// -- FILM-093: Per-Shot Audio Mix -----------------------------------------

function collectShotAudioTracks(shotId, scene, shot) {
    const tracks = [];

    // How long the mix runs, and therefore how long a looping bed has to cover.
    // Prefer the shot's own duration; fall back to the longest asset we collect
    // so a shot with no recorded duration still gets a bed that reaches the end.
    const shotDurationMs = (shot && shot.duration_ms) || 0;

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
            // The bed is generated as a short seamless loop (see
            // buildAmbientPrompt), so it has to be tiled across the shot or it
            // stops early and the rest plays dry.
            //
            // Most accurate first: the shot's own duration, then the furthest
            // any other track reaches, then the scene estimate. A shot whose
            // only track is the bed has no other track to measure against, so
            // without the scene fallback it would get no loop target at all and
            // the loop would silently not apply.
            const longestOther = tracks.reduce((max, t) => Math.max(max, (t.start_ms || 0) + (t.duration_ms || 0)), 0);
            const loopUntilMs = shotDurationMs || longestOther || (scene && scene.estimated_duration) || 0;
            tracks.push({
                type: 'ambient', url: a.file_path || getFileUrl('music', a.project_id, a.file_name),
                start_ms: 0, duration_ms: a.duration_ms || 0, gain_db: -12,
                loop: true,
                loop_until_ms: loopUntilMs,
                crossfade_ms: 5000,
            });
        }
    }

    return tracks;
}

async function mixShotAudio(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const tracks = collectShotAudioTracks(shotId, scene, shot);

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

        let filePath;
        try {
            filePath = await persistProviderMedia(scene.project_id, 'music', filename, result.data, { serveDir: 'music' });
        } catch (err) {
            db.prepare('UPDATE film_audio_mix_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            return json(res, 502, { error: `audio mix generated but could not be stored: ${err.message}` });
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
        const tracks = collectShotAudioTracks(shot.shot_id, scene, shot);
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
