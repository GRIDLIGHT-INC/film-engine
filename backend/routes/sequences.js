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
        `SELECT sh.id, sh.shot_code, sh.scene_card_yaml, sh.current_frame_version,
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
function keyframeCeiling(projectId) {
    let adapter = null;
    try {
        adapter = resolve('video', providerConfigFor(projectId));
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
    const ids = Array.isArray(body.shot_ids) ? body.shot_ids.filter(x => typeof x === 'string') : [];
    if (!ids.length) return json(res, 400, { error: 'Pick at least one shot for the sequence' });

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
    const next = {
        name: body.name !== undefined ? String(body.name).slice(0, 200) : row.name,
        shot_ids: Array.isArray(body.shot_ids) ? JSON.stringify(body.shot_ids) : row.shot_ids,
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
    const plan = planSequence(shotsOf(row), {
        maxKeyframes: ceiling.max, description: row.description,
    });
    return json(res, plan.refused ? 409 : 200, {
        sequence_id: id, provider: ceiling.provider,
        ...(ceiling.unresolved ? { provider_unresolved: ceiling.unresolved } : {}),
        ...plan,
        // The prompts and the frame COUNT travel; the frames themselves do not.
        // A plan is read in a browser and four base64 stills is megabytes spent
        // showing something the page already has thumbnails of.
        segments: (plan.segments || []).map(s => ({
            from: s.from, to: s.to, prompt: s.prompt, keyframes: s.keyframes.length,
        })),
        generations: (plan.segments || []).length,
    });
}

async function generateSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });

    const ceiling = keyframeCeiling(row.project_id);
    const plan = planSequence(shotsOf(row), { maxKeyframes: ceiling.max, description: row.description });
    if (plan.refused) return json(res, 409, { sequence_id: id, ...plan });

    const provider = resolve('video', providerConfigFor(row.project_id));
    if (!provider || typeof provider.generate !== 'function') {
        return json(res, 502, { error: 'no video provider resolved' });
    }

    const { toDataUri } = require('../lib/reference-images');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(row.project_id);
    const results = [];

    db.prepare("UPDATE film_sequences SET status = 'generating', updated_at = datetime('now') WHERE id = ?").run(id);

    for (const segment of plan.segments) {
        const keyframes = segment.keyframes
            .map(k => ({ uri: toDataUri(k.uri), position: k.position }))
            .filter(k => k.uri);
        // eslint-disable-next-line no-await-in-loop
        const result = await provider.generate('video', {
            prompt: segment.prompt,
            keyframes,
            duration_s: 5,
            width: 1280, height: 720,
            ...(project && project.frame_rate ? { target_fps: project.frame_rate } : {}),
        }, { timeout: 600000 });

        if (!result.ok) {
            results.push({ from: segment.from, to: segment.to, ok: false, error: result.error });
            // A provider that has started refusing will refuse the rest; stop
            // rather than buying the same failure N times.
            break;
        }

        const fileName = `sequence_${id.slice(0, 8)}_${segment.from}_${segment.to}.mp4`;
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
        not_attempted: plan.segments.slice(results.length).map(s => `${s.from}→${s.to}`),
        needs_stitching: plan.needs_stitching,
        note: plan.needs_stitching && !failed.length
            ? 'Each segment is a separate clip. Stitch them in the timeline or your NLE.'
            : undefined,
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
        if (sub === 'import' && req.method === 'POST') return importSequenceClip(req, res, id);
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

module.exports = { handleSequences, shotsOf };
