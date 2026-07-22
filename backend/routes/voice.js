/**
 * FILM-022-028: Voice & Dialogue Pipeline
 *
 * POST /film/shots/:id/voice/generate          - Generate dialogue audio for a shot
 * POST /film/shots/:id/voice/generate/stream    - SSE streaming version
 * POST /film/projects/:id/voice/batch           - Batch all dialogue
 * POST /film/projects/:id/voice/batch/stream    - SSE batch
 * GET  /film/shots/:id/voice                    - Get voice job status
 * GET  /film/projects/:id/voice                 - List voice jobs
 * GET  /film/audio/:projectId/:filename         - Serve audio files
 */

const crypto = require('crypto');
const { db, generateId } = require('../db/database');
const { serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, ensureDir, serveFile } = require('../lib/file-storage');
const { extractDialogue, buildVoicePayload, dialogueFilename } = require('../lib/dialogue-builder');
const { resolve } = require('../lib/providers');
const { buildShotReferencePayload, applyConsistencyToVoicePayload } = require('../lib/consistency-context');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOICE_ENDPOINT = '/voice';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function parseProjectConfig(projectId) {
    const row = db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return {};
    try { return JSON.parse(row.provider_config || '{}'); } catch (_) { return {}; }
}

function hashPrompt(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function filenameForResult(baseFilename, result) {
    const format = result && result.meta && result.meta.format ? result.meta.format : '';
    if (format === 'mp3') return baseFilename.replace(/\.[^.]+$/, '.mp3');
    if (format === 'wav') return baseFilename.replace(/\.[^.]+$/, '.wav');
    return baseFilename;
}

function mimeForResult(result) {
    return (result && result.contentType) || (result && result.meta && result.meta.format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
}

function formatForResult(result) {
    const format = result && result.meta && result.meta.format ? result.meta.format : '';
    if (format) return format;
    const contentType = result && result.contentType ? result.contentType : '';
    if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
    return 'wav';
}

// -- Route Handler -------------------------------------------------------

function handleVoice(req, res, urlParts, query) {
    // /film/audio/:projectId/:filename
    if (urlParts[1] === 'audio' && urlParts[2] && urlParts[3]) {
        return serveFile(res, urlParts[2], 'audio', urlParts[3]);
    }

    // /film/shots/:id/voice[/generate[/stream]]
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'voice') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        const sub = urlParts[4];
        if (sub === 'generate' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return generateVoiceStream(req, res, shotId);
            return generateVoice(req, res, shotId);
        }
        if (!sub && req.method === 'GET') return getVoiceStatus(req, res, shotId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/voice[/batch[/stream]]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'voice') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        const sub = urlParts[4];
        if (sub === 'batch' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return batchVoiceStream(req, res, projectId);
            return batchVoice(req, res, projectId);
        }
        if (!sub && req.method === 'GET') return listVoiceJobs(req, res, projectId, query);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Generate Voice for a Shot -------------------------------------------

async function generateVoice(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}

    const dialogueLines = extractDialogue(sceneCard);
    if (dialogueLines.length === 0) {
        return json(res, 200, { shot_id: shotId, message: 'No dialogue in this shot', audio_files: [] });
    }

    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(scene.project_id);
    const voiceProfiles = db.prepare(
        'SELECT * FROM film_voice_profiles WHERE character_id IN (SELECT id FROM film_characters WHERE project_id = ?)'
    ).all(scene.project_id);
    const voiceProvider = resolve('voice', parseProjectConfig(scene.project_id));
    const consistencyContext = buildShotReferencePayload(shot, scene, { id: scene.project_id });

    ensureDir(scene.project_id, 'audio');
    const results = [];

    for (const line of dialogueLines) {
        const character = characters.find(c => c.name && c.name.toUpperCase() === line.character.toUpperCase());
        const voiceProfile = character ? voiceProfiles.find(vp => vp.character_id === character.id) : null;
        const payload = applyConsistencyToVoicePayload(
            buildVoicePayload(line, voiceProfile, character),
            consistencyContext,
            line.character
        );
        const jobId = generateId();

        db.prepare(
            `INSERT INTO film_voice_jobs (id, project_id, shot_id, character_id, dialogue_text, emotion, voice_profile_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'generating')`
        ).run(jobId, scene.project_id, shotId, character ? character.id : null, line.line, line.emotion, voiceProfile ? voiceProfile.id : null);

        try {
            const result = await voiceProvider.generate('voice', payload, { timeout: 300000 });

            if (!result.ok) {
                db.prepare('UPDATE film_voice_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
                results.push({ character: line.character, line: line.line, status: 'failed', error: result.error });
                continue;
            }

            const filename = filenameForResult(dialogueFilename(shot.shot_code, line.character, line.index), result);
            let filePath = '', durationMs = 0;

            if (Buffer.isBuffer(result.data)) {
                filePath = saveFile(scene.project_id, 'audio', filename, result.data);
            } else if (result.data && result.data.audio_url) {
                filePath = result.data.audio_url;
                durationMs = result.data.duration_ms || 0;
            }

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, shot_id, character_id, asset_type, file_path, file_name,
                    format, mime_type, duration_ms, version,
                    provider, provider_model, provider_job_id, license_source, license_status, prompt_hash
                 )
                 VALUES (?, ?, ?, ?, 'audio_dialogue', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated', ?)`
            ).run(
                assetId, scene.project_id, shotId, character ? character.id : null,
                filePath, filename, formatForResult(result), mimeForResult(result), durationMs,
                voiceProvider.id, result.provider_model || payload.model || '', result.provider_job_id || '', hashPrompt(payload.text || line.line)
            );

            db.prepare(
                `INSERT INTO render_ledger (id, shot_id, version, step, model_id, prompt, mode)
                 VALUES (?, ?, 1, 'voice', ?, ?, 'creative')`
            ).run(generateId(), shotId, payload.model, line.line);

            db.prepare('UPDATE film_voice_jobs SET status = ?, output_path = ?, duration_ms = ? WHERE id = ?')
                .run('complete', filePath, durationMs, jobId);

            results.push({
                character: line.character, line: line.line, status: 'complete',
                audio_url: getFileUrl('audio', scene.project_id, filename), duration_ms: durationMs,
            });
        } catch (err) {
            db.prepare('UPDATE film_voice_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            if (voiceProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) {
                return json(res, 503, serviceUnavailableError(VOICE_ENDPOINT, 'voice'));
            }
            results.push({ character: line.character, line: line.line, status: 'failed', error: err.message });
        }
    }

    json(res, 200, { shot_id: shotId, shot_code: shot.shot_code, dialogue_count: dialogueLines.length, audio_files: results });
}

// -- SSE Streaming Voice Generation --------------------------------------

async function generateVoiceStream(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}

    const dialogueLines = extractDialogue(sceneCard);
    if (dialogueLines.length === 0) {
        return json(res, 200, { shot_id: shotId, message: 'No dialogue in this shot' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };
    sendEvent({ type: 'status', phase: 'starting', total_lines: dialogueLines.length, shot_id: shotId });

    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(scene.project_id);
    const voiceProfiles = db.prepare(
        'SELECT * FROM film_voice_profiles WHERE character_id IN (SELECT id FROM film_characters WHERE project_id = ?)'
    ).all(scene.project_id);
    const voiceProvider = resolve('voice', parseProjectConfig(scene.project_id));
    const consistencyContext = buildShotReferencePayload(shot, scene, { id: scene.project_id });
    ensureDir(scene.project_id, 'audio');

    let completed = 0, failed = 0;

    for (let i = 0; i < dialogueLines.length; i++) {
        if (clientGone || res.writableEnded) break; // client disconnected — stop firing voice jobs
        const line = dialogueLines[i];
        const character = characters.find(c => c.name && c.name.toUpperCase() === line.character.toUpperCase());
        const voiceProfile = character ? voiceProfiles.find(vp => vp.character_id === character.id) : null;
        const payload = applyConsistencyToVoicePayload(
            buildVoicePayload(line, voiceProfile, character),
            consistencyContext,
            line.character
        );

        sendEvent({ type: 'progress', line_index: i, total_lines: dialogueLines.length, character: line.character, phase: 'generating' });

        try {
            const result = await voiceProvider.generate('voice', payload, { timeout: 300000 });
            if (!result.ok) throw new Error(result.error);

            const filename = filenameForResult(dialogueFilename(shot.shot_code, line.character, line.index), result);
            let filePath = filename;
            if (Buffer.isBuffer(result.data)) {
                filePath = saveFile(scene.project_id, 'audio', filename, result.data);
            }

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, shot_id, character_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status, prompt_hash
                 )
                 VALUES (?, ?, ?, ?, 'audio_dialogue', ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated', ?)`
            ).run(
                assetId, scene.project_id, shotId, character ? character.id : null,
                filePath, filename, formatForResult(result), mimeForResult(result),
                voiceProvider.id, result.provider_model || payload.model || '', result.provider_job_id || '', hashPrompt(payload.text || line.line)
            );

            sendEvent({ type: 'progress', line_index: i, total_lines: dialogueLines.length, character: line.character, phase: 'complete', audio_url: getFileUrl('audio', scene.project_id, filename) });
            completed++;
        } catch (err) {
            sendEvent({ type: 'progress', line_index: i, total_lines: dialogueLines.length, character: line.character, phase: 'failed', error: err.message });
            failed++;
        }
    }

    sendEvent({ type: 'result', shot_id: shotId, lines_completed: completed, lines_failed: failed });
    sendEvent({ type: 'done' });
    res.end();
}

// -- Batch Voice Generation ----------------------------------------------

async function batchVoiceStream(req, res, projectId) {
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

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_card_yaml, s.scene_id, sc.project_id
         FROM film_shots s JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(projectId);
    const voiceProfiles = db.prepare(
        'SELECT * FROM film_voice_profiles WHERE character_id IN (SELECT id FROM film_characters WHERE project_id = ?)'
    ).all(projectId);
    const voiceProvider = resolve('voice', parseProjectConfig(projectId));
    ensureDir(projectId, 'audio');

    let totalCompleted = 0, totalFailed = 0;
    sendEvent({ type: 'status', phase: 'starting', total_shots: shots.length, project_id: projectId });

    for (const shot of shots) {
        if (clientGone || res.writableEnded) break; // client disconnected — stop remaining shots
        let sceneCard = {};
        try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}
        const dialogueLines = extractDialogue(sceneCard);
        if (dialogueLines.length === 0) continue;

        sendEvent({ type: 'shot_start', shot_id: shot.shot_id, shot_code: shot.shot_code, dialogue_lines: dialogueLines.length });

        for (const line of dialogueLines) {
            if (clientGone || res.writableEnded) break;
            const character = characters.find(c => c.name && c.name.toUpperCase() === line.character.toUpperCase());
            const voiceProfile = character ? voiceProfiles.find(vp => vp.character_id === character.id) : null;
            const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
            const consistencyContext = buildShotReferencePayload(
                { id: shot.shot_id, scene_id: shot.scene_id, scene_card_yaml: shot.scene_card_yaml },
                scene,
                project
            );
            const payload = applyConsistencyToVoicePayload(
                buildVoicePayload(line, voiceProfile, character),
                consistencyContext,
                line.character
            );

            try {
                const result = await voiceProvider.generate('voice', payload, { timeout: 300000 });
                if (!result.ok) throw new Error(result.error);

                const filename = filenameForResult(dialogueFilename(shot.shot_code, line.character, line.index), result);
                let filePath = filename;
                if (Buffer.isBuffer(result.data)) filePath = saveFile(projectId, 'audio', filename, result.data);

                const assetId = generateId();
                db.prepare(
                    `INSERT INTO film_assets (
                        id, project_id, shot_id, character_id, asset_type, file_path, file_name,
                        format, mime_type, version,
                        provider, provider_model, provider_job_id, license_source, license_status, prompt_hash
                     )
                     VALUES (?, ?, ?, ?, 'audio_dialogue', ?, ?, ?, ?, 1, ?, ?, ?, 'generated', 'generated', ?)`
                ).run(
                    assetId, projectId, shot.shot_id, character ? character.id : null,
                    filePath, filename, formatForResult(result), mimeForResult(result),
                    voiceProvider.id, result.provider_model || payload.model || '', result.provider_job_id || '', hashPrompt(payload.text || line.line)
                );

                sendEvent({ type: 'line_complete', shot_code: shot.shot_code, character: line.character, audio_url: getFileUrl('audio', projectId, filename) });
                totalCompleted++;
            } catch (err) {
                sendEvent({ type: 'line_failed', shot_code: shot.shot_code, character: line.character, error: err.message });
                totalFailed++;
            }
        }
    }

    sendEvent({ type: 'result', project_id: projectId, lines_completed: totalCompleted, lines_failed: totalFailed });
    sendEvent({ type: 'done' });
    res.end();
}

async function batchVoice(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_card_yaml, sc.project_id
         FROM film_shots s JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    const shotResults = [];
    for (const shot of shots) {
        let sceneCard = {};
        try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}
        const dialogueLines = extractDialogue(sceneCard);
        if (dialogueLines.length === 0) continue;
        shotResults.push({ shot_id: shot.shot_id, shot_code: shot.shot_code, dialogue_lines: dialogueLines.length });
    }

    json(res, 200, { project_id: projectId, shots_with_dialogue: shotResults.length, shots: shotResults });
}

// -- Status & Listing ----------------------------------------------------

function getVoiceStatus(req, res, shotId) {
    const jobs = db.prepare('SELECT * FROM film_voice_jobs WHERE shot_id = ? ORDER BY created_at').all(shotId);
    const assets = db.prepare("SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'audio_dialogue' ORDER BY created_at").all(shotId);

    json(res, 200, {
        shot_id: shotId, jobs,
        audio_files: assets.map(a => ({
            asset_id: a.id, file_name: a.file_name,
            audio_url: a.file_name ? getFileUrl('audio', a.project_id, a.file_name) : null,
            duration_ms: a.duration_ms, character_id: a.character_id,
            provider: a.provider, provider_model: a.provider_model, provider_job_id: a.provider_job_id,
            license_source: a.license_source, license_status: a.license_status, prompt_hash: a.prompt_hash,
        })),
    });
}

function listVoiceJobs(req, res, projectId, query) {
    const status = query.status || null;
    let jobs;
    if (status) {
        jobs = db.prepare('SELECT * FROM film_voice_jobs WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(projectId, status);
    } else {
        jobs = db.prepare('SELECT * FROM film_voice_jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
    }
    json(res, 200, { project_id: projectId, total: jobs.length, jobs });
}

module.exports = { handleVoice };
