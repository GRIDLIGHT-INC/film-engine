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

// Gap 5: steps that produce something a director can watch and circle as a take.
// Audio-only steps are logged in the ledger but are not takes of the shot.
const TAKE_STEPS = ['keyframe', 'video', 'lipsync', 'post', 'assembly'];

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

    // Gap 7d: GET /film/shots/:id/prompt-history — prompts across renders
    if (sub === 'prompt-history' && req.method === 'GET') return getPromptHistory(req, res, shotId, query);

    // Gap 7d: GET /film/shots/:id/prompt-diff?a=X&b=Y — token-level diff
    if (sub === 'prompt-diff' && req.method === 'GET') return getPromptDiff(req, res, shotId, query);

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

/**
 * Gap 7d: the prompt as it evolved across renders.
 *
 * render_ledger already versions every parameter, but the prompt could only be
 * read as opaque blocks. This returns them in order with a per-render flag for
 * whether the prompt actually moved, so "which take changed the prompt" is
 * answerable at a glance instead of by eye-diffing paragraphs.
 */
function getPromptHistory(req, res, shotId, query) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Shot not found' }));
        return;
    }

    let sql = `
        SELECT id, version, step, prompt, negative_prompt, seed, model_id,
               sampler, steps, guidance, lora_ids, controlnets, model_hash, created_at
        FROM render_ledger
        WHERE shot_id = ?
    `;
    const params = [shotId];
    if (query.step && VALID_STEPS.includes(query.step)) {
        sql += ' AND step = ?';
        params.push(query.step);
    }
    sql += ' ORDER BY created_at ASC, version ASC';

    const rows = db.prepare(sql).all(...params);

    // Mark where the prompt actually changed relative to the previous render of
    // the same step. Comparing across steps would be meaningless — a video
    // prompt is not a revision of a keyframe prompt.
    const lastByStep = new Map();
    const history = rows.map(row => {
        const previous = lastByStep.get(row.step);
        lastByStep.set(row.step, row.prompt);
        return {
            ...row,
            prompt_changed: previous !== undefined && previous !== row.prompt,
            is_first_of_step: previous === undefined,
        };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        history,
        count: history.length,
        changed_count: history.filter(h => h.prompt_changed).length,
    }));
}

/**
 * Gap 7d: token-level diff between two renders of the same shot.
 *
 * Both ledger IDs are verified to belong to this shot — otherwise the endpoint
 * would happily diff a render from an unrelated project given a guessed ID.
 */
function getPromptDiff(req, res, shotId, query) {
    if (!query.a || !query.b) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Both a and b render ledger IDs are required' }));
        return;
    }
    if (!UUID_RE.test(query.a) || !UUID_RE.test(query.b)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid render ledger ID' }));
        return;
    }

    const get = db.prepare('SELECT * FROM render_ledger WHERE id = ? AND shot_id = ?');
    const a = get.get(query.a, shotId);
    const b = get.get(query.b, shotId);

    if (!a || !b) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Render not found for this shot' }));
        return;
    }

    const { comparePrompts } = require('../lib/prompt-diff');
    const comparison = comparePrompts(a, b);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        shot_id: shotId,
        a: { id: a.id, version: a.version, step: a.step, created_at: a.created_at, prompt: a.prompt },
        b: { id: b.id, version: b.version, step: b.step, created_at: b.created_at, prompt: b.prompt },
        // Diffing across steps is almost always a mistake; flag rather than block.
        cross_step: a.step !== b.step,
        ...comparison,
    }));
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

    // Gap 5: a logged render IS a take, so materialize the version row here.
    //
    // film_shot_versions was created back in migration 012 and, until now,
    // nothing in the codebase ever wrote to it — it was read by getShotVersions
    // and by A/B compare, backed up, and bundled, but never populated. That made
    // version history and A/B comparison permanently empty, and left selects with
    // nothing to select from. This is the natural write point: every render
    // produces a take, and the take carries its ledger row so the parameters
    // that produced it are one join away.
    //
    // Only picture-producing steps become takes. Logging a music or ambient
    // render as a "take of the shot" would pollute the take list with rows a
    // director can't watch or circle.
    if (TAKE_STEPS.includes(step) && !body.skip_version) {
        const takeVer = db.prepare(
            'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM film_shot_versions WHERE shot_id = ?'
        ).get(shotId);

        db.prepare(`
            INSERT INTO film_shot_versions
                (id, shot_id, version, render_ledger_id, video_path, thumbnail_path, status, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            generateId(), shotId, takeVer.next, id,
            (body.output_path || ''),
            (body.thumbnail_path || ''),
            'draft',
            (body.editor_notes || '').slice(0, 5000),
            now
        );
    }

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

    // Get render ledger entries for both versions.
    //
    // Join through film_shot_versions.render_ledger_id, NOT by numeric version.
    // The two version numbers count different things: render_ledger.version is
    // scoped per (shot_id, step), while film_shot_versions.version is a global
    // per-shot take counter. So a shot with one keyframe render and one video
    // render has ledger versions 1 and 1, but take versions 1 and 2 — matching
    // on the number would pull the wrong ledger row for take 1 and find nothing
    // for take 2. Each take already records exactly which render produced it.
    //
    // This was latent until takes began to be materialized: film_shot_versions
    // was never populated, so this endpoint always 404'd at the check above and
    // the mismatch never surfaced. Returning confidently wrong parameters is a
    // worse failure than the 404 it replaced.
    const ledgerById = db.prepare('SELECT * FROM render_ledger WHERE id = ? AND shot_id = ?');
    const renderA = verA.render_ledger_id ? ledgerById.get(verA.render_ledger_id, shotId) : null;
    const renderB = verB.render_ledger_id ? ledgerById.get(verB.render_ledger_id, shotId) : null;

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
