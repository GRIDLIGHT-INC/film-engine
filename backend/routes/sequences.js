/**
 * Sequences: several shots, ordered, generated as one continuous move.
 *
 *   GET|POST   /film/projects/:id/sequences
 *   GET|PUT|DELETE /film/sequences/:id
 *   GET        /film/sequences/:id/plan       — free: what it would send and cost
 *   POST       /film/sequences/:id/generate   — spends
 *   POST       /film/sequences/:id/import     — a clip made elsewhere
 *
 * The plan is FREE and separate from the generate, on the same reasoning as the
 * run plan and the prompt preview: this is the one control that can spend
 * several generations in a press, and a confirmation that cannot name what it
 * is about to buy teaches people to click past it.
 */

const { db, generateId } = require('../db/database');
const { imageOverride } = require('../lib/generation-override');

/**
 * The config a sequence generation should resolve against.
 *
 * A sequence buys several clips at once, so which generator makes them is the
 * same per-generation choice a single clip has — read through the one helper
 * every other paid path uses rather than a second reading of the same fields.
 */
function seqConfig(projectId, req) {
    const base = providerConfigFor(projectId);
    const o = imageOverride((req && req.body) || {});
    if (!o || !o.image) return base;
    return { ...base, video: o.image };
}
const { resolve } = require('../lib/providers');
const { providerConfigFor } = require('../lib/provider-config');
const { planSequence } = require('../lib/video-sequence');
const { planSequenceFrames, inbetweenPrompt } = require('../lib/sequence-frames');
const { parseResolution } = require('../lib/project-presets');
const { importMedia } = require('../lib/media-imports');
const { persistProviderMedia } = require('../lib/provider-media');
const { getFileUrl, serveFile } = require('../lib/file-storage');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function parseIds(row) {
    try { const v = JSON.parse(row.shot_ids || '[]'); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
}

function sequenceFileName(sequenceId, from, to) {
    const safe = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'shot';
    return `sequence_${safe(String(sequenceId || '').slice(0, 8))}_${safe(from)}_${safe(to)}.mp4`;
}

/** Validate the ordered shot list at the write boundary, before it can drift projects. */
function validShotIds(projectId, input) {
    const ids = Array.isArray(input) ? input.filter(x => typeof x === 'string') : [];
    if (!ids.length) return { error: 'Pick at least one shot for the sequence' };
    if (new Set(ids).size !== ids.length) return { error: 'A shot can appear only once in a sequence' };
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT sh.id
        FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id
        WHERE sc.project_id = ? AND sh.id IN (${placeholders})`).all(projectId, ...ids);
    if (rows.length !== ids.length) {
        return { error: 'Every selected shot must exist in this project' };
    }
    return { ids };
}

/**
 * The shots this sequence travels through, IN THE ORDER THE DIRECTOR PUT THEM.
 *
 * Never in table order: a sequence is a statement about play order, and sorting
 * by anything else silently reorders the move. Each carries the picture that is
 * currently SHOWN for that shot — its selected version, not the newest — which
 * is the rule every other surface follows.
 */
function shotsOf(row) {
    const ids = parseIds(row);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(
        `SELECT sh.id, sh.shot_code, sh.scene_card_yaml, sh.current_frame_version, sh.duration_ms,
                sc.project_id
           FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id
          WHERE sh.id IN (${placeholders})`).all(...ids);
    const byId = new Map(found.map(s => [s.id, s]));

    return ids.map(id => {
        const shot = byId.get(id);
        if (!shot) return { id, shot_code: id.slice(0, 8), keyframe: null, missing: true };
        let card = {};
        try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }
        const frame = db.prepare(
            `SELECT id, file_path, file_name, version FROM film_assets
              WHERE shot_id = ? AND asset_type IN ('storyboard', 'keyframe')
              ORDER BY version DESC`).all(shot.id);
        const chosen = shot.current_frame_version
            ? frame.find(f => f.version === shot.current_frame_version) || frame[0]
            : frame[0];
        return {
            id: shot.id,
            shot_code: shot.shot_code,
            description: String(card.description || card.action || '').slice(0, 300),
            direction: String(card.direction || '').slice(0, 1000),
            camera: card.camera && typeof card.camera === 'object' ? card.camera : {},
            duration_ms: Number(shot.duration_ms) || Number(card.duration_ms) || 5000,
            keyframe: chosen ? chosen.file_path : null,
            keyframe_asset_id: chosen ? chosen.id : null,
            keyframe_file_name: chosen ? chosen.file_name : null,
        };
    });
}

function motionBoardRows(sequenceId) {
    return db.prepare(
        `SELECT f.*, a.file_path, a.file_name, a.created_at AS asset_created_at,
                sh.shot_code AS source_shot_code
           FROM film_sequence_frames f
           LEFT JOIN film_assets a ON a.id = f.asset_id
           LEFT JOIN film_shots sh ON sh.id = f.source_shot_id
          WHERE f.sequence_id = ? ORDER BY f.frame_index`
    ).all(sequenceId);
}

/**
 * Make the durable board agree with the sequence plan without overwriting a
 * generated experiment that still describes the same sampled moment.
 */
function syncMotionBoard(row) {
    const shots = shotsOf(row);
    const plan = planSequenceFrames(shots);
    if (plan.refused) return { ...plan, rows: [] };
    const existing = new Map(motionBoardRows(row.id).map(f => [f.frame_index, f]));
    const wantedIndexes = new Set(plan.frames.map(f => f.index));
    const changedAnchor = plan.frames.some(frame => {
        if (frame.kind !== 'anchor') return false;
        const old = existing.get(frame.index);
        const shot = shots.find(item => item.id === frame.source_shot_id);
        return old && old.asset_id !== (shot && shot.keyframe_asset_id);
    });

    const write = db.transaction(() => {
        for (const old of existing.values()) {
            if (!wantedIndexes.has(old.frame_index)) {
                db.prepare('DELETE FROM film_sequence_frames WHERE id = ?').run(old.id);
            }
        }
        for (const frame of plan.frames) {
            const old = existing.get(frame.index);
            const anchorShot = frame.kind === 'anchor'
                ? shots.find(s => s.id === frame.source_shot_id) : null;
            const sameMoment = old
                && old.kind === frame.kind
                && old.source_shot_id === frame.source_shot_id
                && old.from_shot_id === frame.from_shot_id
                && old.to_shot_id === frame.to_shot_id
                && (!anchorShot || old.asset_id === anchorShot.keyframe_asset_id)
                && (frame.kind === 'anchor' || !changedAnchor)
                && Math.abs(Number(old.time_ms) - frame.time_ms) < 2;
            if (sameMoment) continue;

            if (old) db.prepare('DELETE FROM film_sequence_frames WHERE id = ?').run(old.id);
            db.prepare(
                `INSERT INTO film_sequence_frames
                    (id, sequence_id, frame_index, time_ms, kind, source_shot_id,
                     from_shot_id, to_shot_id, asset_id, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(generateId(), row.id, frame.index, frame.time_ms, frame.kind,
                frame.source_shot_id, frame.from_shot_id, frame.to_shot_id,
                anchorShot ? anchorShot.keyframe_asset_id : null,
                anchorShot ? 'approved' : 'missing');
        }
    });
    write();
    return { ...plan, rows: motionBoardRows(row.id) };
}

function publicMotionFrame(row, projectId) {
    let imageUrl = null;
    if (row.file_name) {
        imageUrl = row.kind === 'anchor'
            ? getFileUrl('storyboards', projectId,
                `${row.source_shot_code || String(row.file_name || '').replace(/\.png$/i, '')}.png`,
                row.asset_created_at)
            : getFileUrl('sequence-frames', projectId, row.file_name, row.asset_created_at);
    }
    return {
        id: row.id,
        index: row.frame_index,
        time_ms: row.time_ms,
        kind: row.kind,
        source_shot_id: row.source_shot_id,
        from_shot_id: row.from_shot_id,
        to_shot_id: row.to_shot_id,
        status: row.status,
        direction: row.direction || '',
        prompt: row.prompt || '',
        error: row.error_message || null,
        asset_id: row.asset_id || null,
        image_url: imageUrl,
    };
}

function motionBoardRoute(res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const board = syncMotionBoard(row);
    if (board.refused) return json(res, 409, board);
    const ceiling = keyframeCeiling(row.project_id);
    const approved = board.rows.filter(f => f.status === 'approved' && f.asset_id).length;
    return json(res, 200, {
        free: true,
        sequence_id: id,
        duration_ms: board.duration_ms,
        frame_count: board.frame_count,
        interval_ms: board.interval_ms,
        capped: board.capped,
        approved,
        ready: approved === board.rows.length,
        provider: ceiling.provider,
        provider_max_images: ceiling.max,
        provider_ready: !ceiling.unresolved && ceiling.max >= board.rows.length,
        provider_warning: ceiling.unresolved || (ceiling.max < board.rows.length
            ? `${ceiling.provider || 'The selected provider'} accepts ${ceiling.max} image(s), but this motion board contains ${board.rows.length}. Select Seedance or another multi-image provider.`
            : null),
        frames: board.rows.map(f => publicMotionFrame(f, row.project_id)),
        note: 'Storyboard anchors are already approved. Generate, revise and approve every in-between before sending the complete board to video.',
    });
}

function updateMotionFrame(req, res, sequenceId, frameIndex) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(sequenceId);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const board = syncMotionBoard(row);
    if (board.refused) return json(res, 409, board);
    const frame = board.rows.find(f => f.frame_index === Number(frameIndex));
    if (!frame) return json(res, 404, { error: 'Motion-board frame not found' });
    const body = req.body || {};
    const direction = body.direction !== undefined
        ? String(body.direction || '').slice(0, 2000) : frame.direction;
    let status = frame.status;
    if (body.status !== undefined) {
        if (!['draft', 'approved'].includes(body.status)) {
            return json(res, 400, { error: 'status must be draft or approved' });
        }
        if (body.status === 'approved' && !frame.asset_id) {
            return json(res, 409, { error: 'Generate this frame before approving it' });
        }
        status = body.status;
    }
    db.prepare(`UPDATE film_sequence_frames SET direction = ?, status = ?,
                updated_at = datetime('now') WHERE id = ?`).run(direction, status, frame.id);
    const fresh = motionBoardRows(sequenceId).find(f => f.id === frame.id);
    return json(res, 200, { frame: publicMotionFrame(fresh, row.project_id) });
}

function frameFileName(sequenceId, index) {
    return `motion_${String(sequenceId).slice(0, 8)}_${String(index).padStart(2, '0')}_${generateId().slice(0, 8)}.png`;
}

async function generateMotionFrames(req, res, sequenceId, frameIndex) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(sequenceId);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const board = syncMotionBoard(row);
    if (board.refused) return json(res, 409, board);
    const shots = shotsOf(row);
    const byId = new Map(shots.map(s => [s.id, s]));
    const wanted = frameIndex === undefined
        ? board.rows.filter(f => f.kind === 'inbetween' && ['missing', 'failed'].includes(f.status))
        : board.rows.filter(f => f.kind === 'inbetween' && f.frame_index === Number(frameIndex));
    if (frameIndex !== undefined && !wanted.length) {
        return json(res, 400, { error: 'Only generated in-between frames can be regenerated' });
    }
    if (!wanted.length) return json(res, 200, { sequence_id: sequenceId, made: [], note: 'No missing frames.' });

    const { generateImageWithFallback } = require('../lib/image-fallback');
    const { toDataUri } = require('../lib/reference-images');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(row.project_id);
    const made = [];
    let refusal = null;

    for (const target of wanted) {
        if (refusal) break;
        const liveRows = motionBoardRows(sequenceId);
        const from = byId.get(target.from_shot_id);
        const to = byId.get(target.to_shot_id);
        const segmentStart = liveRows.find(f => f.source_shot_id === target.from_shot_id);
        const segmentEnd = liveRows.find(f => f.source_shot_id === target.to_shot_id);
        const progress = segmentStart && segmentEnd && segmentEnd.frame_index !== segmentStart.frame_index
            ? (target.frame_index - segmentStart.frame_index) / (segmentEnd.frame_index - segmentStart.frame_index)
            : 0;
        const direction = String((req.body && req.body.direction) || target.direction || '').slice(0, 2000);
        const prompt = inbetweenPrompt({
            sequenceDescription: row.description,
            frame: { index: target.frame_index, time_ms: target.time_ms, progress, direction },
            from, to,
        });
        const references = [from && from.keyframe, to && to.keyframe]
            .filter((value, index, all) => value && all.indexOf(value) === index)
            .slice(0, 2)
            .map((filePath, i) => ({ uri: toDataUri(filePath), kind: 'anchor', role: i ? 'destination' : 'continuity' }))
            .filter(r => r.uri);
        const claim = db.prepare(`UPDATE film_sequence_frames SET status = 'generating', prompt = ?, direction = ?,
                    error_message = NULL, updated_at = datetime('now')
                    WHERE id = ? AND status != 'generating'`).run(prompt, direction, target.id);
        if (!claim.changes) {
            refusal = `Frame ${target.frame_index} is already generating.`;
            break;
        }

        let result;
        try {
            // eslint-disable-next-line no-await-in-loop
            result = await generateImageWithFallback({
                prompt,
                reference_images: references,
                ...(parseResolution(project && project.target_resolution) || { width: 1280, height: 720 }),
            }, providerConfigFor(row.project_id), { timeout: 300000 });
        } catch (err) {
            refusal = err.message;
            db.prepare(`UPDATE film_sequence_frames SET status = 'failed', error_message = ?,
                        updated_at = datetime('now') WHERE id = ?`).run(refusal, target.id);
            break;
        }
        if (!result || !result.ok) {
            refusal = (result && result.error) || 'image generation failed';
            db.prepare(`UPDATE film_sequence_frames SET status = 'failed', error_message = ?,
                        updated_at = datetime('now') WHERE id = ?`).run(refusal, target.id);
            break;
        }

        const fileName = frameFileName(sequenceId, target.frame_index);
        let filePath;
        try {
            // eslint-disable-next-line no-await-in-loop
            filePath = await persistProviderMedia(row.project_id, 'sequence-frames', fileName,
                result.data, { serveDir: 'images' });
        } catch (err) {
            refusal = err.message;
            db.prepare(`UPDATE film_sequence_frames SET status = 'failed', error_message = ?,
                        updated_at = datetime('now') WHERE id = ?`).run(refusal, target.id);
            break;
        }
        const assetId = target.asset_id || generateId();
        const metadata = JSON.stringify({ kind: 'sequence_inbetween', sequence_id: sequenceId,
            frame_index: target.frame_index, time_ms: target.time_ms });
        if (target.asset_id) {
            db.prepare(`UPDATE film_assets SET file_path = ?, file_name = ?, format = 'png',
                mime_type = 'image/png', metadata = ?, provider = ?, provider_model = ?,
                provider_job_id = ?, created_at = datetime('now') WHERE id = ?`).run(
                filePath, fileName, metadata, result.provider || null,
                result.provider_model || null, result.provider_job_id || null, assetId);
        } else db.prepare(`INSERT INTO film_assets
            (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type,
             version, metadata, provider, provider_model, provider_job_id)
            VALUES (?, ?, ?, 'reference_image', ?, ?, 'png', 'image/png', 1, ?, ?, ?, ?)`).run(
            assetId, row.project_id, target.from_shot_id, filePath, fileName,
            metadata,
            result.provider || null, result.provider_model || null, result.provider_job_id || null);
        db.prepare(`UPDATE film_sequence_frames SET asset_id = ?, status = 'draft', error_message = NULL,
                    updated_at = datetime('now') WHERE id = ?`).run(assetId, target.id);
        made.push(publicMotionFrame(motionBoardRows(sequenceId).find(f => f.id === target.id), row.project_id));
    }

    return json(res, made.length || !refusal ? 200 : 502, {
        sequence_id: sequenceId,
        made,
        ...(refusal ? { error: refusal,
            not_attempted: wanted.slice(made.length + 1).map(f => f.frame_index) } : {}),
    });
}

/**
 * How many stills this project's video provider can be pinned to.
 *
 * The catch here used to swallow EVERYTHING and return 1, which is the failure
 * this whole feature is about: a wiring mistake became "this provider takes one
 * keyframe", the plan silently degraded to a series of stills, and the only
 * symptom was a sequence that produced N segments where it should have produced
 * N-1. A provider that genuinely cannot be resolved is reported as unresolved
 * rather than described as limited.
 */
function keyframeCeiling(projectId, req) {
    let adapter = null;
    try {
        // `req` is optional: the ceiling is also read from paths that have no
        // request in hand. Passing an undefined one resolves against the
        // project's own config, which is the right default.
        adapter = resolve('video', seqConfig(projectId, req));
    } catch (err) {
        return { max: 1, provider: null, unresolved: err.message };
    }
    if (!adapter) return { max: 1, provider: null, unresolved: 'no video provider is configured' };
    return {
        max: Math.max(1, Number(adapter.maxKeyframes) || 1),
        provider: adapter.id,
        // An adapter that declares nothing is held at one, and says so, because
        // silently assuming two sends a destination the endpoint ignores.
        ...(adapter.maxKeyframes ? {} : { undeclared: true }),
    };
}

function listSequences(res, projectId) {
    const rows = db.prepare(
        'SELECT * FROM film_sequences WHERE project_id = ? ORDER BY created_at').all(projectId);
    return json(res, 200, {
        project_id: projectId,
        sequences: rows.map(r => ({
            ...r, shot_ids: parseIds(r),
            shots: shotsOf(r).map(s => ({ id: s.id, shot_code: s.shot_code, has_keyframe: !!s.keyframe })),
        })),
    });
}

function createSequence(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const body = req.body || {};
    const checked = validShotIds(projectId, body.shot_ids);
    if (checked.error) return json(res, 400, { error: checked.error });
    const ids = checked.ids;

    const id = generateId();
    db.prepare(`INSERT INTO film_sequences (id, project_id, name, shot_ids, description)
                VALUES (?, ?, ?, ?, ?)`)
        .run(id, projectId, String(body.name || '').slice(0, 200),
            JSON.stringify(ids), String(body.description || '').slice(0, 2000));
    return json(res, 201, { sequence: db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id) });
}

function updateSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const body = req.body || {};
    // Merged, not replaced: renaming a sequence must not silently drop the
    // description someone spent time on, the rule PUT /shots/:id already sets.
    const checked = body.shot_ids !== undefined ? validShotIds(row.project_id, body.shot_ids) : null;
    if (checked && checked.error) return json(res, 400, { error: checked.error });
    const next = {
        name: body.name !== undefined ? String(body.name).slice(0, 200) : row.name,
        shot_ids: checked ? JSON.stringify(checked.ids) : row.shot_ids,
        description: body.description !== undefined
            ? String(body.description).slice(0, 2000) : row.description,
    };
    db.prepare(`UPDATE film_sequences SET name = ?, shot_ids = ?, description = ?,
                updated_at = datetime('now') WHERE id = ?`)
        .run(next.name, next.shot_ids, next.description, id);
    return json(res, 200, { sequence: db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id) });
}

/** What this would send, and what it would cost. Free. */
function planRoute(res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const ceiling = keyframeCeiling(row.project_id);
    const runway = ceiling.provider === 'runway' ? require('../lib/providers/runway') : null;
    const model = runway ? (process.env.RUNWAY_VIDEO_MODEL || 'gen4.5') : null;
    const shotList = shotsOf(row);
    const plan = planSequence(shotList, {
        maxKeyframes: ceiling.max, description: row.description,
        modelPolicy: runway && runway.RUNWAY_VIDEO_MODELS[model],
    });
    const storedMotionRows = motionBoardRows(id);
    const motionRows = storedMotionRows.length ? syncMotionBoard(row).rows : [];
    const motionBoard = motionRows.length ? {
        frame_count: motionRows.length,
        approved_count: motionRows.filter(frame => frame.status === 'approved').length,
        ready: motionRows.every(frame => frame.status === 'approved' && frame.asset_id),
        duration_ms: motionRows[motionRows.length - 1].time_ms,
        provider_ready: ceiling.max >= motionRows.length,
        provider_max_images: ceiling.max,
    } : null;
    let native = null;
    if (!plan.refused && runway && shotList.length >= 3 && shotList.length <= 5) {
        try {
            const built = runway.buildMultiShotRequest({ mode: 'custom', ratio: '1280:720',
                shots: shotList.map(s => ({ prompt: `${s.shot_code}: ${s.description || row.description || 'Continue the story.'}`,
                    duration: Math.max(1, Math.round((s.duration_ms || 3000) / 1000)) })) });
            native = { available: true, mode: 'custom-cuts', duration_s: built.body.duration,
                estimated_credits: built.estimatedCredits, estimated_usd: built.estimatedCredits / 100,
                outbound: built.body };
        } catch (err) { native = { available: false, reason: err.message }; }
    }
    return json(res, plan.refused ? 409 : 200, {
        sequence_id: id, provider: ceiling.provider,
        motion_board: motionBoard,
        ...(ceiling.unresolved ? { provider_unresolved: ceiling.unresolved } : {}),
        ...plan,
        // The prompts and the frame COUNT travel; the frames themselves do not.
        // A plan is read in a browser and four base64 stills is megabytes spent
        // showing something the page already has thumbnails of.
        segments: (plan.segments || []).map(s => ({
            from: s.from, to: s.to, prompt: s.prompt, keyframes: s.keyframes.length,
            duration_s: s.duration_s, estimated_credits: s.estimated_credits,
            complete: !!db.prepare(`SELECT 1 FROM film_assets WHERE project_id = ?
                AND json_extract(metadata, '$.sequence_id') = ?
                AND json_extract(metadata, '$.from') = ? AND json_extract(metadata, '$.to') = ? LIMIT 1`)
                .get(row.project_id, id, s.from, s.to),
        })),
        generations: (plan.segments || []).length,
        native_multi_shot: native,
    });
}

async function generateNativeSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const shots = shotsOf(row);
    if (shots.length < 3 || shots.length > 5) return json(res, 409, { error: 'Native multi-shot requires 3–5 shots' });
    if (shots.some(s => !s.keyframe)) return json(res, 409, { error: 'Every native multi-shot sequence needs an approved frame' });
    const provider = resolve('video', seqConfig(row.project_id, req));
    if (!provider || provider.id !== 'runway') return json(res, 409, { error: 'Native multi-shot requires the Runway provider' });
    const { toDataUri } = require('../lib/reference-images');
    const payload = {
        runway_recipe: 'multi_shot_video', mode: 'custom', ratio: (req.body && req.body.ratio) || '1280:720',
        promptImage: toDataUri(shots[0].keyframe),
        shots: shots.map(s => ({ prompt: `${s.shot_code}: ${s.description || row.description || 'Continue the story.'}`,
            duration: Math.max(1, Math.round((s.duration_ms || 3000) / 1000)) })),
    };
    const result = await provider.generate('video', payload, { timeout: 600000 });
    if (!result.ok) return json(res, 502, { error: result.error });
    const fileName = sequenceFileName(id, shots[0].shot_code, 'multi-shot');
    const saved = await persistProviderMedia(row.project_id, 'video', fileName, result.data, { serveDir: 'videos' });
    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, asset_type, file_path, file_name, format, version, metadata, provider, provider_model, provider_job_id)
        VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1, ?, 'runway', ?, ?)`)
        .run(assetId, row.project_id, shots[0].id, typeof saved === 'string' ? saved : saved.path, fileName,
            JSON.stringify({ sequence_id: id, kind: 'native_multi_shot' }), result.provider_model || 'multi_shot_video', result.provider_job_id || null);
    db.prepare("UPDATE film_sequences SET output_asset_id = ?, status = 'complete', updated_at = datetime('now') WHERE id = ?").run(assetId, id);
    return json(res, 200, { sequence_id: id, asset_id: assetId, url: getFileUrl('video', row.project_id, fileName), mode: 'native_multi_shot' });
}

async function generateApprovedMotionBoard(req, res, row, boardRows, ceiling) {
    const incomplete = boardRows.filter(f => f.status !== 'approved' || !f.file_path);
    if (incomplete.length) {
        return json(res, 409, {
            error: 'MOTION_BOARD_NOT_APPROVED',
            reason: `${incomplete.length} motion-board frame(s) still need generation or approval.`,
            frames: incomplete.map(f => ({ index: f.frame_index, status: f.status })),
        });
    }
    if (ceiling.max < boardRows.length) {
        return json(res, 409, {
            error: 'PROVIDER_IMAGE_LIMIT',
            reason: `${ceiling.provider || 'The selected video provider'} accepts ${ceiling.max} image(s), but this approved motion board contains ${boardRows.length}. Nothing was sent or dropped.`,
        });
    }

    const provider = resolve('video', seqConfig(row.project_id, req));
    const { toDataUri } = require('../lib/reference-images');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(row.project_id);
    const shots = shotsOf(row);
    const durationMs = Number(boardRows.at(-1).time_ms) || 1000;
    const resolution = parseResolution(project && project.target_resolution) || { width: 1280, height: 720 };
    const keyframes = boardRows.map((f, index) => ({
        uri: toDataUri(f.file_path),
        position: index === 0 ? 'first' : index === boardRows.length - 1 ? 'last' : index,
    })).filter(k => k.uri);
    if (keyframes.length !== boardRows.length) {
        return json(res, 409, { error: 'One or more approved motion-board images cannot be read from disk.' });
    }

    const claim = db.prepare(`UPDATE film_sequences SET status = 'generating', updated_at = datetime('now')
        WHERE id = ? AND status != 'generating'`).run(row.id);
    if (!claim.changes) {
        return json(res, 409, { error: 'SEQUENCE_ALREADY_GENERATING', reason: 'This sequence is already generating.' });
    }
    let result;
    try {
        result = await provider.generate('video', {
            prompt: `${row.description || 'One continuous cinematic sequence.'} Follow the supplied images in chronological order as the visual path of the shot. Preserve identity, wardrobe, location, lighting, geography and screen direction between every image.`,
            keyframes,
            duration_s: Math.max(1, Math.round(durationMs / 1000)),
            width: resolution.width,
            height: resolution.height,
            ...(project && project.target_fps ? { target_fps: project.target_fps } : {}),
        }, { timeout: 900000 });
    } catch (err) {
        db.prepare("UPDATE film_sequences SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(row.id);
        throw err;
    }
    if (!result || !result.ok) {
        db.prepare("UPDATE film_sequences SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(row.id);
        return json(res, 502, { error: (result && result.error) || 'video generation failed' });
    }

    const first = shots[0];
    const last = shots[shots.length - 1];
    const fileName = sequenceFileName(row.id, first.shot_code, `${last.shot_code}_motion`);
    const saved = await persistProviderMedia(row.project_id, 'video', fileName, result.data,
        { serveDir: 'videos' });
    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, asset_type, file_path, file_name, format, version,
         metadata, provider, provider_model, provider_job_id)
        VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1, ?, ?, ?, ?)`).run(
        assetId, row.project_id, first.id,
        typeof saved === 'string' ? saved : (saved && saved.path) || '', fileName,
        JSON.stringify({ sequence_id: row.id, kind: 'motion_board_sequence',
            frame_ids: boardRows.map(f => f.id) }),
        provider.id, result.provider_model || null, result.provider_job_id || null);
    db.prepare("UPDATE film_sequences SET output_asset_id = ?, status = 'complete', updated_at = datetime('now') WHERE id = ?")
        .run(assetId, row.id);
    return json(res, 200, {
        sequence_id: row.id,
        mode: 'approved_motion_board',
        reference_images: boardRows.length,
        asset_id: assetId,
        url: getFileUrl('video', row.project_id, fileName),
    });
}

async function generateSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });

    const ceiling = keyframeCeiling(row.project_id, req);
    const storedMotionRows = motionBoardRows(id);
    const motionRows = storedMotionRows.length ? syncMotionBoard(row).rows : [];
    if (motionRows.length) {
        if (req.body && req.body.segment_index !== undefined) {
            return json(res, 409, {
                error: 'This sequence has a motion board and must be generated once from the complete approved frame set.',
            });
        }
        return generateApprovedMotionBoard(req, res, row, motionRows, ceiling);
    }
    const runway = ceiling.provider === 'runway' ? require('../lib/providers/runway') : null;
    const model = runway ? (process.env.RUNWAY_VIDEO_MODEL || 'gen4.5') : null;
    const plan = planSequence(shotsOf(row), { maxKeyframes: ceiling.max, description: row.description,
        modelPolicy: runway && runway.RUNWAY_VIDEO_MODELS[model] });
    if (plan.refused) return json(res, 409, { sequence_id: id, ...plan });

    const provider = resolve('video', seqConfig(row.project_id, req));
    if (!provider || typeof provider.generate !== 'function') {
        return json(res, 502, { error: 'no video provider resolved' });
    }

    const { toDataUri } = require('../lib/reference-images');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(row.project_id);
    const results = [];

    db.prepare("UPDATE film_sequences SET status = 'generating', updated_at = datetime('now') WHERE id = ?").run(id);

    const requestedIndex = req.body && req.body.segment_index;
    const selected = requestedIndex === undefined ? plan.segments
        : plan.segments.filter((_, i) => i === Number(requestedIndex));
    if (!selected.length) return json(res, 400, { error: 'segment_index is outside this sequence plan' });
    for (const segment of selected) {
        const keyframes = segment.keyframes
            .map(k => ({ uri: toDataUri(k.uri), position: k.position }))
            .filter(k => k.uri);
        // eslint-disable-next-line no-await-in-loop
        const result = await provider.generate('video', {
            prompt: segment.prompt,
            keyframes,
            duration_s: segment.duration_s,
            width: 1280, height: 720,
            ...(project && project.target_fps ? { target_fps: project.target_fps } : {}),
        }, { timeout: 600000 });

        if (!result.ok) {
            results.push({ from: segment.from, to: segment.to, ok: false, error: result.error });
            // A provider that has started refusing will refuse the rest; stop
            // rather than buying the same failure N times.
            break;
        }

        const fileName = sequenceFileName(id, segment.from, segment.to);
        // eslint-disable-next-line no-await-in-loop
        const saved = await persistProviderMedia(row.project_id, 'video', fileName, result.data,
            { serveDir: 'videos' });
        const assetId = generateId();
        db.prepare(`INSERT INTO film_assets
            (id, project_id, shot_id, asset_type, file_path, file_name, format, version, metadata)
            VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1, ?)`)
            .run(assetId, row.project_id, segment.from_shot_id,
                typeof saved === 'string' ? saved : (saved && saved.path) || '',
                fileName, JSON.stringify({ sequence_id: id, from: segment.from, to: segment.to }));
        results.push({
            from: segment.from, to: segment.to, ok: true, asset_id: assetId,
            url: getFileUrl('video', row.project_id, fileName),
        });
    }

    const failed = results.filter(r => !r.ok);
    db.prepare("UPDATE film_sequences SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(failed.length ? 'failed' : 'complete', id);

    return json(res, failed.length && !results.some(r => r.ok) ? 502 : 200, {
        sequence_id: id, segments: results,
        not_attempted: selected.slice(results.length).map(s => `${s.from}→${s.to}`),
        needs_stitching: plan.needs_stitching,
        note: plan.needs_stitching && !failed.length
            ? 'Each segment is a separate clip. Stitch them in the timeline or your NLE.'
            : undefined,
    });
}

/**
 * The clips this sequence has produced, in play order.
 *
 * Ordered by the SEQUENCE, never by created_at: a director who regenerated the
 * middle segment would otherwise get it last, and a film assembled in the wrong
 * order plays perfectly and is wrong.
 */
function clipsOf(row) {
    const id = row.id;
    const shots = shotsOf(row);
    const out = [];
    for (let i = 0; i < shots.length; i += 1) {
        const from = shots[i];
        const to = shots[i + 1] || shots[i];
        const clip = db.prepare(
            `SELECT id, file_path, file_name FROM film_assets
              WHERE project_id = ? AND json_extract(metadata, '$.sequence_id') = ?
                AND json_extract(metadata, '$.from') = ?
              ORDER BY created_at DESC LIMIT 1`).get(row.project_id, id, from.shot_code);
        if (clip) out.push({ ...clip, from: from.shot_code, to: to.shot_code });
        if (shots.length === 1) break;
        if (i === shots.length - 2) break;
    }
    return out;
}

/**
 * Join the sequence's clips into ONE file.
 *
 * The sequence produced N-1 clips and asked the director to join them
 * elsewhere, which makes the last step of the pipeline happen outside it.
 *
 * Free: no provider is called and nothing is generated. It re-encodes what has
 * already been paid for.
 */
async function stitchSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });

    const clips = clipsOf(row);
    if (!clips.length) {
        return json(res, 409, {
            error: 'NOTHING_TO_JOIN',
            reason: 'This sequence has no clips yet. Generate it, or upload a clip, first.',
        });
    }

    const shots = shotsOf(row);
    const expected = Math.max(1, shots.length - 1);
    if (clips.length < expected) {
        /*
         * Joining what is there would produce a shorter film that plays fine —
         * the failure nobody notices until they watch all of it. Named per
         * missing segment, because "3 of 4 clips" sends the director to the
         * database to work out which.
         */
        const have = new Set(clips.map(c => `${c.from}`));
        const missing = shots.slice(0, expected)
            .filter(s => !have.has(s.shot_code))
            .map((s, i) => `${s.shot_code}\u2192${(shots[shots.indexOf(s) + 1] || s).shot_code}`);
        return json(res, 409, {
            error: 'INCOMPLETE',
            reason: `${clips.length} of ${expected} clips exist. Missing: ${missing.join(', ')}. `
                + 'Generate the rest before joining, or the film is short and plays as though it is whole.',
            have: clips.length, expected, missing,
        });
    }

    const { stitchClips, resolveFfmpeg } = require('../lib/ffmpeg');
    const encoder = resolveFfmpeg();
    if (!encoder.available) {
        return json(res, 503, { error: 'NO_ENCODER', reason: encoder.reason });
    }

    /*
     * The project's delivery rate, from the column that exists. This read
     * `frame_rate`, which film_projects does not have — so every join silently
     * fell back to 24 and a 25fps production would have been conformed at the
     * wrong rate, which surfaces as drift in a cut long after delivery.
     */
    const project = db.prepare('SELECT target_fps FROM film_projects WHERE id = ?').get(row.project_id);
    const fileName = `sequence_${String(row.name || id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || id.slice(0, 8)}.mp4`;
    const outputPath = require('path').join(
        require('../lib/file-storage').DATA_DIR, 'video', row.project_id, fileName);

    const result = await stitchClips(clips, outputPath, {
        fps: Number(project && project.target_fps) || 24,
    });
    if (!result.ok) return json(res, result.state === 'no_executor' ? 503 : 502, { ...result });

    // Replace the previous join rather than accumulating one per press: this is
    // derived output, and a folder of near-identical masters is how the wrong
    // one gets delivered.
    const prior = db.prepare(
        `SELECT id FROM film_assets WHERE project_id = ? AND file_name = ? AND asset_type = 'video_final'`)
        .all(row.project_id, fileName);
    for (const p of prior) db.prepare('DELETE FROM film_assets WHERE id = ?').run(p.id);

    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, size_bytes, version, metadata)
        VALUES (?, ?, ?, 'video_final', ?, ?, 'mp4', 'video/mp4', ?, 1, ?)`)
        .run(assetId, row.project_id, shotsOf(row)[0].id, outputPath, fileName, result.bytes,
            JSON.stringify({ kind: 'sequence_master', sequence_id: id, clips: result.clips }));
    db.prepare("UPDATE film_sequences SET output_asset_id = ?, status = 'complete', updated_at = datetime('now') WHERE id = ?")
        .run(assetId, id);

    return json(res, 200, {
        sequence_id: id, asset_id: assetId, clips: result.clips,
        file_name: fileName, bytes: result.bytes,
        url: getFileUrl('video', row.project_id, fileName),
        encoder: result.encoder,
        note: 'One file, joined from the clips this sequence generated. Nothing was generated and '
            + 'nothing was spent.',
    });
}

/** A clip generated somewhere else, dropped straight onto the sequence. */
function importSequenceClip(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const body = req.body || {};
    if (!body.data) return json(res, 400, { error: 'no file supplied' });

    // Attached to the sequence's FIRST shot, because a clip has to belong to a
    // shot for the timeline and the export to find it — and the first shot is
    // where the sequence starts playing.
    const first = shotsOf(row)[0];
    if (!first || first.missing) return json(res, 409, { error: 'This sequence has no shots to attach a clip to' });

    try {
        const imported = importMedia('video-media', {
            shotId: first.id, data: body.data, name: body.name,
        });
        db.prepare("UPDATE film_sequences SET output_asset_id = ?, status = 'complete', updated_at = datetime('now') WHERE id = ?")
            .run(imported.asset_id, id);
        return json(res, 201, {
            sequence_id: id, attached_to: first.shot_code, ...imported,
        });
    } catch (err) {
        return json(res, /not found/i.test(err.message) ? 404 : 400, { error: err.message });
    }
}

async function handleSequences(req, res, urlParts) {
    if (urlParts[1] === 'sequence-frames' && urlParts[2] && urlParts[3] && req.method === 'GET') {
        return serveFile(res, urlParts[2], 'sequence-frames', urlParts[3]);
    }
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'sequences') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method === 'GET') return listSequences(res, urlParts[2]);
        if (req.method === 'POST') return createSequence(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }

    if (urlParts[1] === 'sequences' && urlParts[2]) {
        const id = urlParts[2];
        if (!UUID_RE.test(id)) return json(res, 400, { error: 'Invalid sequence ID' });
        const sub = urlParts[3];
        if (sub === 'plan' && req.method === 'GET') return planRoute(res, id);
        if (sub === 'frames') {
            if (!urlParts[4] && req.method === 'GET') return motionBoardRoute(res, id);
            if (urlParts[4] === 'generate' && req.method === 'POST') {
                return generateMotionFrames(req, res, id);
            }
            const frameIndex = urlParts[4];
            if (/^\d+$/.test(String(frameIndex || ''))) {
                if (!urlParts[5] && req.method === 'PUT') return updateMotionFrame(req, res, id, frameIndex);
                if (urlParts[5] === 'generate' && req.method === 'POST') {
                    return generateMotionFrames(req, res, id, frameIndex);
                }
            }
        }
        if (sub === 'generate' && req.method === 'POST') return generateSequence(req, res, id);
        if (sub === 'generate-native' && req.method === 'POST') return generateNativeSequence(req, res, id);
        if (sub === 'import' && req.method === 'POST') return importSequenceClip(req, res, id);
        // Free: joins clips already paid for into one file.
        if (sub === 'stitch' && req.method === 'POST') return stitchSequence(req, res, id);
        if (!sub) {
            if (req.method === 'GET') {
                const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
                if (!row) return json(res, 404, { error: 'Sequence not found' });
                return json(res, 200, { sequence: { ...row, shot_ids: parseIds(row) }, shots: shotsOf(row) });
            }
            if (req.method === 'PUT') return updateSequence(req, res, id);
            if (req.method === 'DELETE') {
                const row = db.prepare('SELECT id FROM film_sequences WHERE id = ?').get(id);
                if (!row) return json(res, 404, { error: 'Sequence not found' });
                db.prepare('DELETE FROM film_sequences WHERE id = ?').run(id);
                // The clips survive: they are on their shots, they cost money,
                // and deleting a plan must not delete the footage it produced.
                return json(res, 200, { deleted: id, note: 'Clips generated for this sequence are kept on their shots.' });
            }
        }
    }
    return false;
}

module.exports = { handleSequences, shotsOf, sequenceFileName, syncMotionBoard, motionBoardRows };
