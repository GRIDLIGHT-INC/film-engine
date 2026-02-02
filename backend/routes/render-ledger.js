/**
 * FILM-048-051: Render ledger & reproducibility
 * POST /film/shots/:id/render — log render params
 * GET  /film/shots/:id/renders — render history
 * GET  /film/shots/:id/versions — shot version history
 * POST /film/shots/:id/re-render — re-render from ledger
 */
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STEPS = [
    'keyframe', 'video', 'voice', 'lipsync',
    'music', 'sfx', 'ambient', 'post', 'assembly'
];

function handleRenderLedger(req, res, urlParts, query) {
    // All render ledger routes go through /film/shots/:id/...
    if (urlParts[1] !== 'shots' || !urlParts[2]) {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    const shotId = urlParts[2];
    if (!UUID_RE.test(shotId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid shot ID' }));
        return;
    }

    const sub = urlParts[3];

    // POST /film/shots/:id/render — log a render
    if (sub === 'render' && req.method === 'POST') return logRender(req, res, shotId);

    // GET /film/shots/:id/renders — render history
    if (sub === 'renders' && req.method === 'GET') return getRenderHistory(req, res, shotId, query);

    // GET /film/shots/:id/versions/compare?a=X&b=Y — A/B comparison
    if (sub === 'versions' && urlParts[4] === 'compare' && req.method === 'GET') {
        return compareVersions(req, res, shotId, query);
    }

    // GET /film/shots/:id/versions — shot version history
    if (sub === 'versions' && req.method === 'GET') return getShotVersions(req, res, shotId);

    // POST /film/shots/:id/re-render — re-render from ledger
    if (sub === 're-render' && req.method === 'POST') return reRender(req, res, shotId);

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function logRender(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Shot not found' }));
        return;
    }

    const body = req.body;
    const step = VALID_STEPS.includes(body.step) ? body.step : 'keyframe';
    const mode = (body.mode === 'locked') ? 'locked' : 'creative';

    // Get next version for this shot+step
    const verRow = db.prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM render_ledger WHERE shot_id = ? AND step = ?'
    ).get(shotId, step);

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO render_ledger (id, shot_id, version, step, model_id, model_hash,
            seed, sampler, steps, guidance, lora_ids, controlnets,
            prompt, negative_prompt, camera_params, lighting_params,
            output_path, duration_ms, resolution, fps, device, inference_ms,
            mode, editor_pass, editor_notes, extra_params, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, shotId, verRow.next, step,
        (body.model_id || '').slice(0, 300),
        (body.model_hash || '').slice(0, 128),
        body.seed ?? -1,
        (body.sampler || '').slice(0, 100),
        body.steps || 0,
        body.guidance || 7.5,
        JSON.stringify(body.lora_ids || []),
        JSON.stringify(body.controlnets || []),
        (body.prompt || '').slice(0, 10000),
        (body.negative_prompt || '').slice(0, 5000),
        JSON.stringify(body.camera_params || {}),
        JSON.stringify(body.lighting_params || {}),
        (body.output_path || ''),
        body.duration_ms || 0,
        (body.resolution || '').slice(0, 20),
        body.fps || 24,
        (body.device || '').slice(0, 100),
        body.inference_ms || 0,
        mode,
        body.editor_pass != null ? (body.editor_pass ? 1 : 0) : null,
        (body.editor_notes || '').slice(0, 5000),
        JSON.stringify(body.extra_params || {}),
        now
    );

    const row = db.prepare('SELECT * FROM render_ledger WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function getRenderHistory(req, res, shotId, query) {
    let sql = 'SELECT * FROM render_ledger WHERE shot_id = ?';
    const params = [shotId];

    if (query.step && VALID_STEPS.includes(query.step)) {
        sql += ' AND step = ?';
        params.push(query.step);
    }

    sql += ' ORDER BY step, version DESC';

    const rows = db.prepare(sql).all(...params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ renders: rows, count: rows.length }));
}

function getShotVersions(req, res, shotId) {
    const versions = db.prepare(
        'SELECT * FROM film_shot_versions WHERE shot_id = ? ORDER BY version DESC'
    ).all(shotId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ versions: versions, count: versions.length }));
}

function reRender(req, res, shotId) {
    const body = req.body;

    // Find the latest locked render for this shot (or a specific ledger entry)
    let ledgerEntry;
    if (body.ledger_id && UUID_RE.test(body.ledger_id)) {
        ledgerEntry = db.prepare('SELECT * FROM render_ledger WHERE id = ? AND shot_id = ?').get(body.ledger_id, shotId);
    } else {
        // Get latest render for the specified step (or 'keyframe' default)
        const step = VALID_STEPS.includes(body.step) ? body.step : 'keyframe';
        ledgerEntry = db.prepare(
            'SELECT * FROM render_ledger WHERE shot_id = ? AND step = ? ORDER BY version DESC LIMIT 1'
        ).get(shotId, step);
    }

    if (!ledgerEntry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No render history found for this shot. Generate first.' }));
        return;
    }

    // Build re-render params from ledger, applying any overrides
    const reRenderParams = {
        shot_id: shotId,
        step: ledgerEntry.step,
        mode: body.mode || ledgerEntry.mode,
        model_id: body.model_id || ledgerEntry.model_id,
        seed: body.seed ?? ledgerEntry.seed,
        sampler: body.sampler || ledgerEntry.sampler,
        steps: body.steps || ledgerEntry.steps,
        guidance: body.guidance || ledgerEntry.guidance,
        prompt: body.prompt || ledgerEntry.prompt,
        negative_prompt: body.negative_prompt || ledgerEntry.negative_prompt,
        camera_params: body.camera_params || JSON.parse(ledgerEntry.camera_params || '{}'),
        lighting_params: body.lighting_params || JSON.parse(ledgerEntry.lighting_params || '{}'),
        lora_ids: body.lora_ids || JSON.parse(ledgerEntry.lora_ids || '[]'),
        controlnets: body.controlnets || JSON.parse(ledgerEntry.controlnets || '[]'),
        resolution: body.resolution || ledgerEntry.resolution,
        fps: body.fps || ledgerEntry.fps,
        source_ledger_id: ledgerEntry.id
    };

    // Update shot status to 'generating'
    db.prepare("UPDATE film_shots SET status = 'generating' WHERE id = ?").run(shotId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        message: 'Re-render queued',
        params: reRenderParams,
        hint: 'Submit these params to the render pipeline. The ledger entry will be created on completion.'
    }));
}

/**
 * GET /film/shots/:id/versions/compare?a=X&b=Y
 * Returns both versions with their render params and a param diff.
 */
function compareVersions(req, res, shotId, query) {
    const versionA = parseInt(query.a);
    const versionB = parseInt(query.b);

    if (isNaN(versionA) || isNaN(versionB)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Query params a and b (version numbers) are required' }));
        return;
    }

    if (versionA === versionB) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Versions a and b must be different' }));
        return;
    }

    const verA = db.prepare(
        'SELECT * FROM film_shot_versions WHERE shot_id = ? AND version = ?'
    ).get(shotId, versionA);
    const verB = db.prepare(
        'SELECT * FROM film_shot_versions WHERE shot_id = ? AND version = ?'
    ).get(shotId, versionB);

    if (!verA || !verB) {
        const missing = !verA ? versionA : versionB;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Version ${missing} not found for this shot` }));
        return;
    }

    // Get render ledger entries for both versions
    const renderA = db.prepare(
        'SELECT * FROM render_ledger WHERE shot_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1'
    ).get(shotId, versionA);
    const renderB = db.prepare(
        'SELECT * FROM render_ledger WHERE shot_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1'
    ).get(shotId, versionB);

    // Compute param diff between render entries
    const paramDiff = computeParamDiff(renderA, renderB);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        shot_id: shotId,
        version_a: { version: verA, render_params: renderA || null },
        version_b: { version: verB, render_params: renderB || null },
        param_diff: paramDiff,
    }));
}

const COMPARE_FIELDS = [
    'model_id', 'model_hash', 'seed', 'sampler', 'steps', 'guidance',
    'lora_ids', 'controlnets', 'prompt', 'negative_prompt',
    'camera_params', 'lighting_params', 'resolution', 'fps', 'mode',
];

function computeParamDiff(renderA, renderB) {
    if (!renderA || !renderB) return null;

    const diff = {};
    for (const field of COMPARE_FIELDS) {
        const valA = renderA[field];
        const valB = renderB[field];
        const strA = typeof valA === 'object' ? JSON.stringify(valA) : String(valA ?? '');
        const strB = typeof valB === 'object' ? JSON.stringify(valB) : String(valB ?? '');
        if (strA !== strB) {
            diff[field] = { a: valA, b: valB };
        }
    }
    return diff;
}

module.exports = { handleRenderLedger };
