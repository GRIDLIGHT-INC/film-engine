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

const { db, generateId } = require('../db/database');
const { serviceUnavailableError } = require('../lib/gridlight-client');
const { getFileUrl, ensureDir, serveFile } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const { extractDialogue, buildVoicePayload, dialogueFilename } = require('../lib/dialogue-builder');

/**
 * How this scene is played, for every line that does not say otherwise.
 *
 * One reading, used by every path that builds a voice payload — three of them
 * built one independently, and a direction honoured by two is worse than none:
 * the same line would be read differently depending on which button generated
 * it, and only whoever used the third path would ever find out.
 */
function sceneContext(scene) {
    return { scene: { delivery: (scene && scene.delivery_direction) || '' } };
}

const { resolve } = require('../lib/providers');
const { providerConfigFor, spendContext } = require('../lib/provider-config');
const { buildShotReferencePayload, applyConsistencyToVoicePayload, recordConsistencyCheck } = require('../lib/consistency-context');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOICE_ENDPOINT = '/voice';

/**
 * What this recording was made FROM.
 *
 * `prompt_hash` stored a hash of the TEXT alone, so recasting a character
 * produced an identical hash for a line that now had to be spoken by somebody
 * else — the one change most likely to need a regeneration was the one it
 * could not see. It covers the text, the voice and the delivery, which are
 * exactly the three things that change what comes back.
 *
 * The same reasoning as the artefact fingerprint: what it was made from decides
 * whether it is still current.
 */
/** Does the recording this row names still exist on disk? */
function fsExists(p) {
    try { return require('fs').existsSync(p); } catch (_) { return false; }
}

function lineHash(payload, line) {
    const crypto = require('crypto');
    return crypto.createHash('sha1').update([
        payload.text || line.line || '',
        payload.voice_id || 'default',
        payload.delivery || '',
        payload.model || '',
    ].join('|')).digest('hex');
}

/**
 * The cue "RAY" and the character "RAY MERCER" are one person.
 *
 * Matched exactly, they were not: thirty of RAY's lines in The Glass Harbour
 * resolved to no character, so no voice profile, so no voice_id — and the
 * adapter fell back to its hardcoded default, a voice that is not even in this
 * account's list, which came back as "402: Free users cannot use library
 * voices". A casting fault wearing a billing error.
 *
 * The rule is not reinvented: `canonicaliseCharacterNames` already collapses a
 * first name onto the full name it prefixes, on a word boundary so RAY does not
 * match RAYMOND. The table read uses it too — one question, one answer, or the
 * take that ships is cast differently from the read that approved it.
 */
function characterForCue(characters, cue) {
    const name = String(cue || '').replace(/\s*\(CONT'D\)\s*$/i, '').trim();
    if (!name) return null;
    const exact = characters.find(c => c.name && c.name.toUpperCase() === name.toUpperCase());
    if (exact) return exact;
    try {
        const { canonicaliseCharacterNames } = require('./scripts');
        const names = characters.map(c => c.name).filter(Boolean);
        const canonical = canonicaliseCharacterNames([...names, name], names);
        const pick = canonical.get(name);
        if (!pick) return null;
        return characters.find(c => c.name && c.name.toUpperCase() === String(pick).toUpperCase()) || null;
    } catch (_) {
        return null;
    }
}

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// One implementation, in lib/provider-config.js — it also tags the config
// with the project id so spend can be attributed. See that file for why.
const parseProjectConfig = providerConfigFor;


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
        if (sub === 'preview' && req.method === 'GET') return previewVoice(req, res, shotId, query);
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

/**
 * Generate one shot's dialogue and return the result.
 *
 * Extracted so the single-shot route and the project batch share ONE
 * implementation. They did not: `batchVoice` enumerated the work and performed
 * none of it, so the button reported "0 lines" while every asset came from
 * whatever had been generated by hand. Two paths for one job is how one of them
 * acquires the cue-collapse fix and the other keeps casting to the default.
 */
async function generateVoiceForShotId(shotId, req_body) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return { error: 'Shot not found' };

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return { error: 'Scene not found' };

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (e) { console.error('[voice] stored sceneCard is not valid JSON; using the default:', e.message); }

    const dialogueLines = extractDialogue(sceneCard);
    if (dialogueLines.length === 0) {
        return { shot_id: shotId, shot_code: shot.shot_code,
            message: 'No dialogue in this shot', audio_files: [] };
    }

    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(scene.project_id);
    const voiceProfiles = db.prepare(
        'SELECT * FROM film_voice_profiles WHERE character_id IN (SELECT id FROM film_characters WHERE project_id = ?)'
    ).all(scene.project_id);
    const voiceProvider = resolve('voice', spendContext({ id: scene.project_id }, shot, scene));
    const consistencyContext = buildShotReferencePayload(shot, scene, { id: scene.project_id });

    ensureDir(scene.project_id, 'audio');
    const results = [];

    const { withContext, deliveryFor, TAG_MODELS } = require('../lib/dialogue-delivery');

    for (const line of dialogueLines) {
        const character = characterForCue(characters, line.character);
        const voiceProfile = character ? voiceProfiles.find(vp => vp.character_id === character.id) : null;
        let payload = applyConsistencyToVoicePayload(
            buildVoicePayload(line, voiceProfile, character, sceneContext(scene)),
            consistencyContext,
            line.character
        );

        /*
         * The line's place in the exchange.
         *
         * previous_text and next_text are used for prosody and are NOT spoken.
         * Without them each of sixty-eight lines is read in isolation, which is
         * why a generated scene sounds like a list rather than two people
         * talking. Free — no extra request, no extra characters billed.
         */
        const prev = dialogueLines[line.index - 1];
        const next = dialogueLines[line.index + 1];
        payload = withContext(payload, {
            previous: prev ? prev.line : null,
            next: next ? next.line : null,
        });

        /*
         * A tag needs a model that reads tags.
         *
         * Only eleven_v3 honours them; on anything else the tag is SPOKEN.
         * Upgraded per line rather than by changing the default, so a line with
         * no direction produces exactly the request it always did and nothing
         * about an existing project changes.
         */
        if (line.direction && deliveryFor(line.direction) && !TAG_MODELS.includes(payload.model)) {
            payload.model = TAG_MODELS[0];
            payload = buildVoicePayload({ ...line }, { ...(voiceProfile || {}), tts_model: TAG_MODELS[0] }, character, sceneContext(scene));
            payload = withContext(payload, {
                previous: prev ? prev.line : null,
                next: next ? next.line : null,
            });
        }
        /*
         * Already recorded, from the same text in the same voice.
         *
         * Asked directly: "if I change the screenplay or recast, will it
         * regenerate?" It regenerated EVERYTHING, every press, because nothing
         * compared what a line was made from. Now a line whose text, voice and
         * delivery are unchanged is reused and costs nothing, and changing any
         * of the three regenerates exactly the lines it affects.
         */
        const wantHash = lineHash(payload, line);
        const already = db.prepare(
            `SELECT file_path, file_name, duration_ms FROM film_assets
              WHERE shot_id = ? AND asset_type = 'audio_dialogue' AND prompt_hash = ?
              ORDER BY created_at DESC LIMIT 1`).get(shotId, wantHash);
        if (!(req_body && req_body.regenerate === true)
            && already && already.file_path && fsExists(already.file_path)) {
            results.push({
                character: line.character, line: line.line, status: 'complete', reused: true,
                audio_url: getFileUrl('audio', scene.project_id, already.file_name),
                duration_ms: already.duration_ms || 0,
            });
            continue;
        }

        const jobId = generateId();

        db.prepare(
            `INSERT INTO film_voice_jobs (id, project_id, shot_id, character_id, dialogue_text, emotion, voice_profile_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'generating')`
        ).run(jobId, scene.project_id, shotId, character ? character.id : null, line.line, line.emotion, voiceProfile ? voiceProfile.id : null);

        try {
            const result = await voiceProvider.generate('voice', payload, { timeout: 300000 });

            if (!result.ok) {
                /*
                 * A refusal a director can act on.
                 *
                 * "elevenlabs 402: Free users cannot use library voices via the
                 * API" in a results row reads as a billing fault and blames the
                 * vendor. It is actually a CASTING fault with a one-click fix —
                 * and the catalogue cannot predict it, because every voice in
                 * the list reports category "premade" including the ones a free
                 * plan is refused. So the refusal is recorded against the voice
                 * and the caster marks it from then on: learned from evidence
                 * rather than guessed from a field that does not carry it.
                 */
                let hint = null;
                if (/library voices|upgrade your subscription/i.test(String(result.error || ''))) {
                    const voiceId = (payload && payload.voice_id) || null;
                    try {
                        require('../lib/providers/elevenlabs')
                            .recordVoiceRefusal(voiceId, 'This plan cannot use this voice through the API.');
                    } catch (_) { /* bookkeeping must not fail a generation */ }
                    hint = `${line.character} is cast in a voice this ElevenLabs plan cannot use through `
                        + 'the API. Cast them in another voice, or upgrade the plan. It is marked in the '
                        + 'catalogue now, so it will not be suggested again.';
                }
                db.prepare('UPDATE film_voice_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
                results.push({ character: line.character, line: line.line, status: 'failed',
                    error: result.error, ...(hint ? { hint } : {}) });
                continue;
            }

            const filename = filenameForResult(dialogueFilename(shot.shot_code, line.character, line.index), result);
            let filePath, durationMs = 0;

            if (!Buffer.isBuffer(result.data) && result.data) durationMs = result.data.duration_ms || 0;
            try {
                filePath = await persistProviderMedia(scene.project_id, 'audio', filename, result.data, { serveDir: 'music' });
            } catch (err) {
                const storeError = `audio generated but could not be stored: ${err.message}`;
                db.prepare('UPDATE film_voice_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', storeError, jobId);
                results.push({ character: line.character, line: line.line, status: 'failed', error: storeError });
                continue;
            }

            /*
             * MEASURE the line, because the card's duration is a guess.
             *
             * ElevenLabs returns raw bytes, so `result.data.duration_ms` is
             * never set and every dialogue asset was stored as 0 — which meant
             * playback held each shot for the duration written on its card,
             * cut away mid-sentence, and moved on. A four-second card carrying
             * a four-line exchange lost most of it.
             *
             * Measured from the file with the same helper the media importer
             * uses: a second duration probe is how one of them acquires the
             * stderr fix and the other keeps reporting zero.
             */
            if (!durationMs && filePath) {
                try {
                    const { measureDurationMs } = require('../lib/media-imports');
                    durationMs = measureDurationMs(
                        typeof filePath === 'string' ? filePath : (filePath && filePath.path) || '');
                } catch (_) {
                    // A line with no measured length is still a line: it falls
                    // back to the card, exactly as before.
                }
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
                voiceProvider.id, result.provider_model || payload.model || '', result.provider_job_id || '', lineHash(payload, line)
            );
            recordConsistencyCheck(shot, scene, { id: scene.project_id }, {
                context: consistencyContext,
                output_asset_id: assetId,
                scorer: 'stub',
            });

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
                // The worker returns; the route decides the status code.
                return { shot_id: shotId, shot_code: shot.shot_code,
                    error: serviceUnavailableError(VOICE_ENDPOINT, 'voice').error || 'voice service unavailable',
                    audio_files: results };
            }
            results.push({ character: line.character, line: line.line, status: 'failed', error: err.message });
        }
    }

    return { shot_id: shotId, shot_code: shot.shot_code,
        dialogue_count: dialogueLines.length, audio_files: results };
}

/** The route: the same work, wrapped in a response. */

/**
 * What a voice generation would send, for FREE.
 *
 * Every other paid path had a preview and voice had none, so the three dialogue
 * buttons could only show a bare confirm() naming a count. For dialogue "the
 * prompt" is the LINES, who says them, in which voice, and how -- so that is
 * what this reports, in the shape the shared confirmation already renders
 * (`prompt`, `provider`, `model`, `notes`).
 *
 * Generates nothing and costs nothing: it reads rows and runs the same
 * builders the paid path runs.
 */
function previewVoice(req, res, shotId, query) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (e) { console.error('[voice] stored sceneCard is not valid JSON; using the default:', e.message); }
    const lines = extractDialogue(sceneCard);

    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(scene.project_id);
    const voiceProfiles = db.prepare(
        'SELECT * FROM film_voice_profiles WHERE character_id IN (SELECT id FROM film_characters WHERE project_id = ?)'
    ).all(scene.project_id);

    const { generationOverride } = require('../lib/generation-override');
    const chosen = generationOverride('voice', { ...(query || {}) });
    const config = spendContext({ id: scene.project_id }, shot, scene, chosen);
    const adapter = resolve('voice', config);

    const notes = [];
    const uncast = [];
    const rendered = lines.map(line => {
        const character = characterForCue(characters, line.character);
        const vp = character ? voiceProfiles.find(x => x.character_id === character.id) : null;
        if (!vp || !vp.voice_id) uncast.push(line.character);
        const how = line.direction ? ` (${line.direction})` : '';
        return `${line.character}${how}\n  ${line.line}`;
    });

    if (!lines.length) notes.push('This shot has no dialogue — nothing would be generated.');
    if (uncast.length) {
        notes.push(`Not cast, so these would use the provider default voice: ${
            [...new Set(uncast)].join(', ')}. Cast them on the character sheet first.`);
    }

    const chars = lines.reduce((n, l) => n + String(l.line || '').length, 0);
    return json(res, 200, {
        shot_id: shotId,
        shot_code: shot.shot_code,
        prompt: rendered.join('\n\n'),
        line_count: lines.length,
        billed_characters: chars,
        provider: (adapter && adapter.id) || 'unresolved',
        model: (chosen && chosen.voice_model) || null,
        notes,
    });
}

async function generateVoice(req, res, shotId) {
    const out = await generateVoiceForShotId(shotId, req.body);
    if (out.error) return json(res, out.error === 'Shot not found' || out.error === 'Scene not found' ? 404 : 502, out);
    return json(res, 200, out);
}

// -- SSE Streaming Voice Generation --------------------------------------

async function generateVoiceStream(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (e) { console.error('[voice] stored sceneCard is not valid JSON; using the default:', e.message); }

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
    const voiceProvider = resolve('voice', spendContext({ id: scene.project_id }, shot, scene));
    const consistencyContext = buildShotReferencePayload(shot, scene, { id: scene.project_id });
    ensureDir(scene.project_id, 'audio');

    let completed = 0, failed = 0;

    for (let i = 0; i < dialogueLines.length; i++) {
        if (clientGone || res.writableEnded) break; // client disconnected — stop firing voice jobs
        const line = dialogueLines[i];
        const character = characterForCue(characters, line.character);
        const voiceProfile = character ? voiceProfiles.find(vp => vp.character_id === character.id) : null;
        const payload = applyConsistencyToVoicePayload(
            buildVoicePayload(line, voiceProfile, character, sceneContext(scene)),
            consistencyContext,
            line.character
        );

        sendEvent({ type: 'progress', line_index: i, total_lines: dialogueLines.length, character: line.character, phase: 'generating' });

        try {
            const result = await voiceProvider.generate('voice', payload, { timeout: 300000 });
            if (!result.ok) throw new Error(result.error);

            const filename = filenameForResult(dialogueFilename(shot.shot_code, line.character, line.index), result);
            const filePath = await persistProviderMedia(scene.project_id, 'audio', filename, result.data, { serveDir: 'music' });

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
                voiceProvider.id, result.provider_model || payload.model || '', result.provider_job_id || '', lineHash(payload, line)
            );
            recordConsistencyCheck(shot, scene, { id: scene.project_id }, {
                context: consistencyContext,
                output_asset_id: assetId,
                scorer: 'stub',
            });

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

    // A held shot is left alone and named (PGN-017).
    const { run: shots, held } = require('../lib/graph-hold').splitShots(db, db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_card_yaml, s.scene_id, sc.project_id
         FROM film_shots s JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId));

    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(projectId);
    const voiceProfiles = db.prepare(
        'SELECT * FROM film_voice_profiles WHERE character_id IN (SELECT id FROM film_characters WHERE project_id = ?)'
    ).all(projectId);
    const voiceProvider = resolve('voice', parseProjectConfig(projectId));
    ensureDir(projectId, 'audio');

    let totalCompleted = 0, totalFailed = 0;
    sendEvent({ type: 'status', phase: 'starting', total_shots: shots.length, project_id: projectId });
    if (held.length) sendEvent({ type: 'held', held });

    for (const shot of shots) {
        if (clientGone || res.writableEnded) break; // client disconnected — stop remaining shots
        let sceneCard = {};
        try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (e) { console.error('[voice] stored sceneCard is not valid JSON; using the default:', e.message); }
        const dialogueLines = extractDialogue(sceneCard);
        if (dialogueLines.length === 0) continue;

        sendEvent({ type: 'shot_start', shot_id: shot.shot_id, shot_code: shot.shot_code, dialogue_lines: dialogueLines.length });

        for (const line of dialogueLines) {
            if (clientGone || res.writableEnded) break;
            const character = characterForCue(characters, line.character);
            const voiceProfile = character ? voiceProfiles.find(vp => vp.character_id === character.id) : null;
            const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
            const consistencyContext = buildShotReferencePayload(
                { id: shot.shot_id, scene_id: shot.scene_id, scene_card_yaml: shot.scene_card_yaml },
                scene,
                project
            );
            const payload = applyConsistencyToVoicePayload(
                buildVoicePayload(line, voiceProfile, character, sceneContext(scene)),
                consistencyContext,
                line.character
            );

            try {
                const result = await voiceProvider.generate('voice', payload, { timeout: 300000 });
                if (!result.ok) throw new Error(result.error);

                const filename = filenameForResult(dialogueFilename(shot.shot_code, line.character, line.index), result);
                const filePath = await persistProviderMedia(projectId, 'audio', filename, result.data, { serveDir: 'music' });

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
                    voiceProvider.id, result.provider_model || payload.model || '', result.provider_job_id || '', lineHash(payload, line)
                );
                recordConsistencyCheck(
                    { ...shot, id: shot.shot_id },
                    { ...shot, id: shot.scene_id, project_id: projectId, location: shot.location },
                    { id: projectId },
                    { context: consistencyContext, output_asset_id: assetId, scorer: 'stub' }
                );

                sendEvent({ type: 'line_complete', shot_code: shot.shot_code, character: line.character, audio_url: getFileUrl('audio', projectId, filename) });
                totalCompleted++;
            } catch (err) {
                sendEvent({ type: 'line_failed', shot_code: shot.shot_code, character: line.character, error: err.message });
                totalFailed++;
            }
        }
    }

    sendEvent({ type: 'result', project_id: projectId, lines_completed: totalCompleted, lines_failed: totalFailed, held });
    sendEvent({ type: 'done' });
    res.end();
}

async function batchVoice(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const { run: shots, held } = require('../lib/graph-hold').splitShots(db, db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_card_yaml, sc.project_id
         FROM film_shots s JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId));

    const withDialogue = [];
    for (const shot of shots) {
        let sceneCard = {};
        try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (e) { console.error('[voice] stored sceneCard is not valid JSON; using the default:', e.message); }
        const dialogueLines = extractDialogue(sceneCard);
        if (dialogueLines.length === 0) continue;
        withDialogue.push({ ...shot, dialogue_lines: dialogueLines.length });
    }

    /*
     * It used to stop here and return the list.
     *
     * A route named `batch` that enumerates the work and performs none of it is
     * the shape the scene and project PIPELINE runners had: a caller gets a
     * plausible 200, nothing is generated, and the button reports "0 lines".
     * The plan is still returned — it is worth having — but the work is done.
     *
     * Sequentially: several voice calls at one provider is how a queue earns a
     * 429, and the retry costs more than the wait. A provider that starts
     * refusing stops the run with the shots not attempted NAMED, because a
     * partial batch reported as success is how somebody plays back a scene
     * believing every line is there.
     */
    if (req.body && req.body.plan_only === true) {
        return json(res, 200, {
            project_id: projectId, plan_only: true, held,
            shots_with_dialogue: withDialogue.length,
            shots: withDialogue.map(s => ({ shot_id: s.shot_id, shot_code: s.shot_code,
                dialogue_lines: s.dialogue_lines })),
        });
    }

    const done = [];
    const notAttempted = [];
    let refusal = null;
    for (const shot of withDialogue) {
        if (refusal) { notAttempted.push(shot.shot_code); continue; }
        const out = await generateVoiceForShotId(shot.shot_id, req.body);
        if (out.error) { refusal = out.error; notAttempted.push(shot.shot_code); continue; }
        const failed = (out.audio_files || []).filter(a => a.status !== 'complete');
        done.push({ shot_id: shot.shot_id, shot_code: shot.shot_code,
            generated: (out.audio_files || []).length - failed.length,
            failed: failed.length,
            ...(failed.length ? { errors: failed.map(f => f.hint || f.error) } : {}) });
        // A per-line failure is reported and does not stop the run; a provider
        // that refuses outright does.
        if (failed.length && failed.length === (out.audio_files || []).length) {
            refusal = failed[0].error;
        }
    }

    const generated = done.reduce((n, s) => n + s.generated, 0);
    json(res, 200, {
        project_id: projectId,
        shots_with_dialogue: withDialogue.length,
        held,
        shots_done: done.length,
        generated,
        shots: done,
        ...(refusal ? { error: refusal, not_attempted: notAttempted,
            note: 'The provider refused, so the remaining shots were not attempted rather than '
                + 'asked for again.' } : {}),
    });
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
