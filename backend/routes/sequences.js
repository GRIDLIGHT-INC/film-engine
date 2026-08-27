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
const { importMedia } = require('../lib/media-imports');
const { persistProviderMedia } = require('../lib/provider-media');
const { getFileUrl } = require('../lib/file-storage');

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
            `SELECT file_path, version FROM film_assets
              WHERE shot_id = ? AND asset_type IN ('storyboard', 'keyframe')
              ORDER BY version DESC`).all(shot.id);
        const chosen = shot.current_frame_version
            ? frame.find(f => f.version === shot.current_frame_version) || frame[0]
            : frame[0];
        return {
            id: shot.id,
            shot_code: shot.shot_code,
            description: String(card.description || card.action || '').slice(0, 300),
            duration_ms: Number(shot.duration_ms) || Number(card.duration_ms) || 5000,
            keyframe: chosen ? chosen.file_path : null,
        };
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
    const plan = planSequence(shotsOf(row), {
        maxKeyframes: ceiling.max, description: row.description,
        modelPolicy: runway && runway.RUNWAY_VIDEO_MODELS[model],
    });
    const shotList = shotsOf(row);
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

async function generateSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });

    const ceiling = keyframeCeiling(row.project_id, req);
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

module.exports = { handleSequences, shotsOf, sequenceFileName };
