/**
 * FILM-001: Film project CRUD endpoints
 * POST/GET/PUT/DELETE /film/projects
 */
const { db, generateId } = require('../db/database');
const { validateProjectSettings, resolveDeliveryPreset } = require('../lib/project-presets');

// UUID v4 format check
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES = [
    'concept', 'script', 'pre-production', 'storyboard',
    'production', 'post-production', 'review', 'export', 'complete'
];

const SETTINGS_COLUMNS = [
    'target_resolution', 'target_fps', 'aspect_ratio', 'aspect_ratio_custom',
    'color_space', 'delivery_format', 'timecode_start',
];

function handleProjects(req, res, urlParts, query) {
    // /film/projects/:id  — parts: ['film', 'projects', id?]
    const id = urlParts[2] || null;

    // /film/projects/:id/anchor — the one frame this project is currently
    // shooting from. Its own path rather than a field on PUT /projects/:id,
    // because it is an action a director takes and puts down, not a setting
    // that describes the film.
    if (id && urlParts[3] === 'anchor') {
        if (req.method === 'GET') return getAnchor(req, res, id);
        if (req.method === 'PUT') return setAnchor(req, res, id);
        if (req.method === 'DELETE') return clearAnchor(req, res, id);
    }

    /*
     * /film/projects/:id/board-lock — "I feel it's done."
     *
     * Its own path for the same reason the anchor has one: it is an action a
     * director takes and takes back, not a setting that describes the film.
     * DELETE unlocks, because a lock with no way off is a trap rather than a
     * decision.
     */
    if (id && urlParts[3] === 'board-lock') {
        if (req.method === 'GET') return getBoardLock(req, res, id);
        if (req.method === 'PUT' || req.method === 'POST') return setBoardLock(req, res, id);
        if (req.method === 'DELETE') return clearBoardLock(req, res, id);
    }

    if (req.method === 'GET' && !id) return listProjects(req, res, query);
    if (req.method === 'GET' && id) return getProject(req, res, id);
    if (req.method === 'POST' && !id) return createProject(req, res);
    if (req.method === 'PUT' && id) return updateProject(req, res, id);
    if (req.method === 'DELETE' && !id) return deleteAllProjects(req, res);
    if (req.method === 'DELETE' && id) return deleteProject(req, res, id);

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function listProjects(req, res, query) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    const offset = (page - 1) * limit;
    const status = query.status && VALID_STATUSES.includes(query.status) ? query.status : null;

    let sql = 'SELECT * FROM film_projects';
    const params = [];

    if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params);

    // Get total count
    let countSql = 'SELECT COUNT(*) AS count FROM film_projects';
    const countParams = [];
    if (status) {
        countSql += ' WHERE status = ?';
        countParams.push(status);
    }
    const countRow = db.prepare(countSql).get(...countParams);
    const total = countRow.count;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projects: rows, total, page, limit }));
}

function getProject(req, res, id) {
    if (!UUID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);

    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const sceneCount = db.prepare('SELECT COUNT(*) AS count FROM film_scenes WHERE project_id = ?').get(id);
    const shotCount = db.prepare(`
        SELECT COUNT(*) AS count FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ?
    `).get(id);
    const scriptCount = db.prepare(
        'SELECT COUNT(*) AS count, MAX(version) AS latest_version FROM film_scripts WHERE project_id = ?'
    ).get(id);

    project.scene_count = sceneCount.count;
    project.shot_count = shotCount.count;
    project.script_count = scriptCount.count;
    project.latest_script_version = scriptCount.latest_version || 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(project));
}

// Titles that indicate automated/accidental creation
const BLOCKED_TITLES = ['undefined', 'null', 'untitled', 'new project', 'test', ''];

function createProject(req, res) {
    const body = req.body;

    if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title is required' }));
        return;
    }

    const trimmedTitle = body.title.trim();
    if (trimmedTitle.length < 3) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Title must be at least 3 characters' }));
        return;
    }

    if (BLOCKED_TITLES.includes(trimmedTitle.toLowerCase())) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Please provide a meaningful project title' }));
        return;
    }

    // Validate project settings if any provided
    const settingsFields = {};
    for (const key of SETTINGS_COLUMNS) {
        if (body[key] !== undefined) settingsFields[key] = body[key];
    }
    if (Object.keys(settingsFields).length > 0) {
        const validation = validateProjectSettings(settingsFields);
        if (!validation.valid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project settings', details: validation.errors }));
            return;
        }
    }

    const id = generateId();
    const title = body.title.trim().slice(0, 500);

    /*
     * WHERE THIS FILM'S FILES GO, decided before the row exists. A folder that
     * cannot be used is refused now, while nothing depends on it, rather than
     * at the first generation — after the money. No answer means the default:
     * a folder named after the film inside the person's projects folder.
     */
    const projectStorage = require('../lib/project-storage');
    const where = projectStorage.resolveRequested(
        { assets_dir: body.assets_dir, parent: body.assets_parent }, title, id);
    if (!where.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Project folder: ${where.error}`, field: 'assets_dir' }));
        return;
    }
    const logline = (body.logline || '').trim().slice(0, 2000);
    const genre = (body.genre || '').trim().slice(0, 100);
    // 2000, not 100. style_preset stopped being an enum key the moment the
    // prompt builder began passing unknown values through verbatim: a director
    // describing their own look ("Guillermo del Toro gothic: teal/amber, wet
    // streets, anamorphic...") was silently cut mid-word and the fragment baked
    // into every frame. The column is TEXT; the cap was never a storage limit.
    const style_preset = (body.style_preset || '').trim().slice(0, 2000);
    const status = VALID_STATUSES.includes(body.status) ? body.status : 'concept';
    const target_resolution = settingsFields.target_resolution || '1920x1080';
    const target_fps = settingsFields.target_fps !== undefined ? Number(settingsFields.target_fps) : 24;
    const aspect_ratio = settingsFields.aspect_ratio || '16:9';
    const aspect_ratio_custom = settingsFields.aspect_ratio_custom || '';
    const color_space = settingsFields.color_space || 'Rec.709';
    const delivery_format = settingsFields.delivery_format || '';
    const timecode_start = settingsFields.timecode_start || '01:00:00:00';
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_projects (id, title, logline, genre, style_preset, status,
            target_resolution, target_fps, aspect_ratio, aspect_ratio_custom,
            color_space, delivery_format, timecode_start, provider_config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, logline, genre, style_preset, status,
        target_resolution, target_fps, aspect_ratio, aspect_ratio_custom,
        color_space, delivery_format, timecode_start,
        /*
         * EMPTY. A NEW PROJECT PINS NOTHING.
         *
         * This used to stamp `defaultProviderConfig()` — a full pin for every
         * capability, frozen at whatever happened to be configured the day the
         * project was made. The reasoning was that a blank column shows nothing
         * in Provider Settings. The cost of it is much larger than that: a
         * per-project pin OUTRANKS the account default, so every project was
         * born overriding the one global setting that exists, with a choice
         * nobody made.
         *
         * The symptom is a person setting their studio's image provider once,
         * in Settings, and watching every project keep using the vendor that
         * was preferred months ago. Which is exactly what happened here: the
         * boards kept going to Meshy — capped at 1MP, no size control — while
         * the account and the preference order both pointed elsewhere.
         *
         * A pin now means what the resolver already assumes it means: somebody
         * deliberately chose this provider FOR THIS FILM. Everything else
         * follows the account default, then the quality tier, then the
         * preference order — all of which are live, and all of which a
         * blank config lets through. Provider Settings shows the RESOLVED
         * provider and where it came from (`resolutionOf`/`describeResolution`),
         * so the display problem this was solving is solved properly.
         */
        JSON.stringify({}),
        now, now);

    try {
        projectStorage.assignOnCreate(id, title, { assets_dir: where.dir });
    } catch (e) {
        // The folder passed validation a moment ago; if it cannot be made now,
        // the project must not exist pointing at nothing.
        db.prepare('DELETE FROM film_projects WHERE id = ?').run(id);
        res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Project folder: ${e.message}`, field: 'assets_dir' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(withStyleWarning(row)));
}

/**
 * Attach a warning when the style preset names a subject.
 *
 * A style preset is appended to EVERY image prompt, so a thing named here gets
 * drawn into frames nobody wrote it into — which is how an establishing shot
 * described as "empty, ordinary, still" came back with a creature standing in
 * the road. Warned, never refused: a creature film may mean it, and a tool that
 * blocks the save is overruling its author.
 */
function withStyleWarning(row) {
    if (!row) return row;
    const check = require('../lib/look-development').validateStylePreset(row.style_preset);
    if (check.ok) return row;
    return { ...row, style_warning: { subjects: check.subjects, detail: check.detail } };
}

function updateProject(req, res, id) {
    if (!UUID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    const body = req.body;
    const fields = [];
    const values = [];

    // The folder is not a field: changing it MOVES files and repoints every
    // record, which is an action with its own route and its own confirmation.
    if (body.assets_dir !== undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'The project folder is changed by moving it: POST /film/projects/:id/storage/move {"assets_dir": "..."} (or project_storage_move).',
            field: 'assets_dir',
        }));
        return;
    }

    if (body.title !== undefined) {
        fields.push('title = ?');
        values.push(String(body.title).trim().slice(0, 500));
    }
    if (body.logline !== undefined) {
        fields.push('logline = ?');
        values.push(String(body.logline).trim().slice(0, 2000));
    }
    if (body.genre !== undefined) {
        fields.push('genre = ?');
        values.push(String(body.genre).trim().slice(0, 100));
    }
    if (body.style_preset !== undefined) {
        fields.push('style_preset = ?');
        values.push(String(body.style_preset).trim().slice(0, 2000));
    }
    /*
     * Commercial mode. A spot is a job for a CLIENT on a CAMPAIGN, with a brand
     * kit that outlives it and a runtime it is bought at — and every one of
     * those is expensive to discover late, which is why they belong on the
     * project rather than being inferred.
     *
     * `target_duration_ms` of 0 is "no target", which is every film ever made
     * in this tool and must stay the behaviour of a project that never sets one.
     * `brand_id` of '' unlinks; the two states are genuinely different.
     */
    if (body.client !== undefined) {
        fields.push('client = ?');
        values.push(String(body.client).trim().slice(0, 200));
    }
    if (body.campaign !== undefined) {
        fields.push('campaign = ?');
        values.push(String(body.campaign).trim().slice(0, 200));
    }
    if (body.brand_id !== undefined) {
        fields.push('brand_id = ?');
        values.push(String(body.brand_id || '').trim());
    }
    if (body.target_duration_ms !== undefined) {
        const ms = Number(body.target_duration_ms);
        if (!Number.isFinite(ms) || ms < 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'target_duration_ms must be a non-negative number of milliseconds (0 = no target)' }));
        }
        fields.push('target_duration_ms = ?');
        values.push(Math.round(ms));
    }

    // PAR-026: does markup on a frame reach the next prompt, or only inform a
    // human? Per project, and off unless someone says otherwise — see
    // migration 072 and lib/annotation-prompt.js.
    if (body.annotation_feedback !== undefined) {
        fields.push('annotation_feedback = ?');
        values.push(body.annotation_feedback ? 1 : 0);
    }
    if (body.status !== undefined && VALID_STATUSES.includes(body.status)) {
        fields.push('status = ?');
        values.push(body.status);
    }

    // Project settings columns
    const settingsToValidate = {};
    for (const key of SETTINGS_COLUMNS) {
        if (body[key] !== undefined) settingsToValidate[key] = body[key];
    }
    if (Object.keys(settingsToValidate).length > 0) {
        const validation = validateProjectSettings(settingsToValidate);
        if (!validation.valid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project settings', details: validation.errors }));
            return;
        }
        for (const key of SETTINGS_COLUMNS) {
            if (body[key] !== undefined) {
                fields.push(`${key} = ?`);
                values.push(key === 'target_fps' ? Number(body[key]) : String(body[key]));
            }
        }
    }

    /*
     * DRAFTING: THE SWITCH THAT HAD NO SWITCH.
     *
     * `video_draft` has existed as a column since migration 100 and was
     * writable from nowhere — not this route, not the SPA, not a tool. It
     * decides whether footage generates at the model's cheapest tier or at the
     * project's delivery raster, which on Seedance is the difference between
     * $0.17 and $1.70 a second. A setting that governs the largest variable
     * cost in the pipeline and cannot be changed is not a default, it is a
     * lock.
     *
     * Boolean in, INTEGER out: the column is INTEGER NOT NULL DEFAULT 1 and
     * `!project.video_draft` is how every reader tests it, so a stored 'false'
     * string would be truthy and drafting would stay on while the settings say
     * otherwise.
     */
    if (body.video_draft !== undefined) {
        const on = body.video_draft === true || body.video_draft === 1
            || body.video_draft === 'true' || body.video_draft === '1';
        fields.push('video_draft = ?');
        values.push(on ? 1 : 0);
    }

    /*
     * PROVIDER CONFIG, MERGED — NEVER REPLACED.
     *
     * Provider selection is per project, and this route refused the field
     * outright, so an agent could create a project and then could not
     * configure it or repair one whose config had been damaged. The only way
     * in was the SPA, which is precisely the wrong constraint for a pipeline
     * whose reasoning happens in an agent host.
     *
     * Merged for the same reason PUT /providers merges: a partial write is the
     * normal case, and replacing drops every capability the caller did not
     * happen to name. `null` removes a key, matching the providers route so
     * the two cannot mean different things by the same payload.
     */
    if (body.provider_config !== undefined) {
        const incoming = body.provider_config;
        if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'provider_config must be an object of capability -> provider id',
                hint: 'Send null as a value to clear one capability. Keys you omit are left alone.',
            }));
            return;
        }
        let merged = {};
        try {
            merged = JSON.parse(
                (db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(id) || {})
                    .provider_config || '{}'
            ) || {};
        } catch (_) { merged = {}; }

        const providers = require('../lib/providers');
        const unknown = [];
        for (const [key, value] of Object.entries(incoming)) {
            if (value === null) { delete merged[key]; continue; }
            if (typeof value !== 'string') continue;
            const v = value.trim();
            if (!v) continue;                       // no opinion — keep what is stored
            if (providers.CAPABILITIES.includes(key)) {
                // A capability may only name a provider that exists, or the
                // pin is stored, sent, and silently ignored at generation time.
                if (!providers.get(v)) { unknown.push(`${key}: ${v}`); continue; }
                merged[key] = v;
            } else if (key === 'image_quality' || key === 'image_model') {
                merged[key] = v.slice(0, 80);
            } else {
                unknown.push(key);
            }
        }
        if (unknown.length) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: `Unknown provider or capability: ${unknown.join(', ')}`,
                capabilities: providers.CAPABILITIES,
                providers: providers.list().map(a => a.id),
            }));
            return;
        }
        fields.push('provider_config = ?');
        values.push(JSON.stringify(merged));
    }

    if (fields.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid fields to update' }));
        return;
    }

    fields.push("updated_at = datetime('now')");
    values.push(id);

    const result = db.prepare(
        `UPDATE film_projects SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(withStyleWarning(row)));
}

function deleteProject(req, res, id) {
    if (!UUID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    // Archive plan scans before the project cascade removes their registry rows.
    require('../lib/orientation-plans').dropOrientationPlansForProject(id);
    const result = db.prepare('DELETE FROM film_projects WHERE id = ?').run(id);

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

function deleteAllProjects(req, res) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM film_projects').get().count;
    if (count === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: 0, message: 'No projects to delete' }));
        return;
    }

    require('../lib/orientation-plans').dropAllOrientationPlans();
    db.prepare('DELETE FROM film_projects').run();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: count }));
}


/**
 * This module writes its responses directly rather than through a shared
 * helper, so one is defined here rather than importing a differently-named one
 * — and the board-lock handlers called `json()`, which does not exist in this
 * file. Every source-grep test passed and the route 500'd on its first real
 * call: a test that asserts a route EXISTS cannot tell you it runs.
 */
function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

/**
 * Is this board locked, and what does that mean right now.
 *
 * Returns the frame count alongside, because "locked" is only meaningful with
 * "…and there are 34 frames behind it" — a lock on an empty board is a
 * statement about nothing, and a director should be able to see which they
 * have before deciding.
 */
function getBoardLock(req, res, projectId) {
    const row = db.prepare('SELECT board_locked_at FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return sendJson(res, 404, { error: 'Project not found' });
    const frames = db.prepare(
        `SELECT COUNT(*) n FROM film_assets WHERE project_id = ? AND asset_type = 'storyboard'`)
        .get(projectId).n;
    return sendJson(res, 200, {
        project_id: projectId,
        locked: !!row.board_locked_at,
        locked_at: row.board_locked_at || null,
        frames,
        note: row.board_locked_at
            ? 'Generating, refining and restoring frames are refused while this board is locked. '
              + 'Editing cards, previewing prompts and reading the board are unaffected — a lock '
              + 'protects the pictures, not the planning.'
            : 'Lock the board when you are happy with it. Nothing that replaces a frame will run '
              + 'until you unlock it.',
    });
}

function setBoardLock(req, res, projectId) {
    const row = db.prepare('SELECT board_locked_at FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return sendJson(res, 404, { error: 'Project not found' });
    // Locking an already-locked board keeps the ORIGINAL timestamp: "when did
    // we call this done" is the useful half of the answer, and re-stamping it
    // on every click would quietly destroy it.
    if (!row.board_locked_at) {
        db.prepare('UPDATE film_projects SET board_locked_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    }
    return getBoardLock(req, res, projectId);
}

function clearBoardLock(req, res, projectId) {
    const row = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return sendJson(res, 404, { error: 'Project not found' });
    db.prepare('UPDATE film_projects SET board_locked_at = NULL WHERE id = ?').run(projectId);
    return getBoardLock(req, res, projectId);
}

/**
 * POST /film/projects/:id/settings/preset — apply a delivery preset
 */
function handleProjectSettingsPreset(req, res, parts) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    const id = parts[2];
    if (!UUID_RE.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    const body = req.body;
    const presetId = body.preset;
    if (!presetId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'preset field is required' }));
        return;
    }

    const preset = resolveDeliveryPreset(presetId);
    if (!preset) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown preset: ${presetId}` }));
        return;
    }

    const result = db.prepare(`
        UPDATE film_projects SET
            target_resolution = ?, target_fps = ?, aspect_ratio = ?,
            color_space = ?, delivery_format = ?, updated_at = datetime('now')
        WHERE id = ?
    `).run(
        preset.target_resolution, preset.target_fps, preset.aspect_ratio,
        preset.color_space, preset.id, id
    );

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ project: row, applied_preset: preset }));
}

// ── The frame this project is currently shooting from ───────────────────
//
// Exactly one, set explicitly, replaced by setting another, cleared in a
// click. There is no derived anchor and no separate on/off switch: setting one
// IS turning it on, and a pinned frame that reached nothing while a checkbox
// elsewhere sat clear is the state nobody can hold in their head.

function anchorPayload(projectId) {
    const row = db.prepare('SELECT anchor_shot_id FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return null;
    if (!row.anchor_shot_id) {
        return {
            project_id: projectId, anchor_shot_id: null, shot_code: null, scene_number: null,
            note: 'No anchor. Every shot generates from its own card and its plates.',
        };
    }
    const shot = db.prepare(
        `SELECT s.id, s.shot_code, sc.scene_number,
                (SELECT COUNT(*) FROM film_assets a
                  WHERE a.shot_id = s.id AND a.asset_type IN ('storyboard', 'keyframe')) AS frames
           FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?`)
        .get(row.anchor_shot_id);
    return {
        project_id: projectId,
        anchor_shot_id: row.anchor_shot_id,
        shot_code: shot ? shot.shot_code : null,
        scene_number: shot ? shot.scene_number : null,
        // Named, because an anchor whose frame has been deleted looks identical
        // to a working one until a generation quietly falls back to plates.
        has_frame: !!(shot && shot.frames > 0),
        note: 'Every OTHER shot you generate is built from this frame: the same location, '
            + 'the same set dressing and the same subjects where they stand in it, re-shot on '
            + 'whatever lens and angle that shot\u2019s own card asks for. Plates for subjects '
            + 'already standing in it are not sent. Clear it to go back to plates.',
    };
}

function getAnchor(req, res, projectId) {
    const payload = anchorPayload(projectId);
    if (!payload) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Project not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function setAnchor(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Project not found' }));
    }
    const shotId = String((req.body && req.body.shot_id) || '').trim();
    if (!shotId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'shot_id is required: the frame to shoot from' }));
    }
    const shot = db.prepare(
        `SELECT s.id, s.shot_code, sc.project_id,
                (SELECT COUNT(*) FROM film_assets a
                  WHERE a.shot_id = s.id AND a.asset_type IN ('storyboard', 'keyframe')) AS frames
           FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?`).get(shotId);
    if (!shot || shot.project_id !== projectId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'That shot is not in this project' }));
    }
    // Refused rather than accepted-and-ignored. An anchor with no picture can
    // only fall back to plates at generation time, which looks exactly like the
    // feature not working.
    if (!shot.frames) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: `${shot.shot_code} has no generated frame yet, so there is nothing to shoot from.`,
            hint: 'Generate that frame first, then anchor on it.',
        }));
    }
    // Setting one replaces the last. One at a time is the whole model.
    db.prepare('UPDATE film_projects SET anchor_shot_id = ? WHERE id = ?').run(shotId, projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(anchorPayload(projectId)));
}

function clearAnchor(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Project not found' }));
    }
    db.prepare('UPDATE film_projects SET anchor_shot_id = NULL WHERE id = ?').run(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...anchorPayload(projectId), cleared: true }));
}

module.exports = { handleProjects, handleProjectSettingsPreset };
