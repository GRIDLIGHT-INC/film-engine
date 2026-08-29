/**
 * The three things a writer does around a screenplay.
 *
 *   GET|PUT|DELETE /film/projects/:id/treatment        — prose before the script
 *   GET            /film/projects/:id/treatment/versions
 *   GET            /film/projects/:id/analysis         — the last reading
 *   GET            /film/projects/:id/analysis/brief   — what a reader needs, FREE
 *   POST           /film/projects/:id/analysis         — store a reading
 *   DELETE         /film/analysis/:id
 *   GET            /film/projects/:id/timing           — eighths, screen time, effort
 *
 * The analysis pair is the shape that matters. There is no "run analysis"
 * endpoint, because the connected agent IS the model here: a route that called
 * a server-side LLM would ask the user for a second API key to answer a
 * question the attached model has already read the material for, and would fail
 * with a billing error the model cannot act on. So the engine hands over a
 * BRIEF and stores what comes back. `analysis/brief` spends nothing.
 */

const { db, generateId } = require('../db/database');
const A = require('../lib/screenplay-analysis');
const T = require('../lib/screenplay-timing');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function project(id) {
    return db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);
}

/** The current screenplay, and the elements it parsed into. */
function latestScript(projectId) {
    return db.prepare(
        'SELECT * FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
    ).get(projectId) || null;
}

/**
 * The screenplay as scenes of blocks, for anything that measures it.
 *
 * Read from film_script_elements rather than re-parsed: the elements are what
 * the breakdown, the comments and the shot tagger all index against, so
 * measuring anything else would measure a different document than the one the
 * rest of the app is working on.
 */
function sceneBlocks(script) {
    if (!script) return [];
    const els = db.prepare(
        'SELECT element_type, text, element_index, scene_number FROM film_script_elements '
        + 'WHERE script_id = ? ORDER BY element_index'
    ).all(script.id);

    const scenes = [];
    let current = null;
    for (const el of els) {
        // The stored spelling is `scene_heading`; the editor's is `scene-heading`.
        // Normalised at the module that owns the vocabulary.
        const type = require('../lib/screenplay-pagination').normalizeElementType(el.element_type);
        if (type === 'scene-heading') {
            current = {
                scene_number: el.scene_number != null ? el.scene_number : scenes.length + 1,
                heading: el.text,
                first_element_index: el.element_index,
                blocks: [],
            };
            scenes.push(current);
            continue;
        }
        if (!current) {
            // Anything before the first heading belongs to no scene. Kept in a
            // holder rather than dropped, so a screenplay that opens on action
            // is still measured.
            current = { scene_number: 0, heading: '', first_element_index: el.element_index, blocks: [] };
            scenes.push(current);
        }
        current.blocks.push({ type, text: el.text || '' });
    }
    return scenes;
}

/* ── treatment ─────────────────────────────────────────────────────────── */

function getTreatment(req, res, projectId) {
    if (!project(projectId)) return json(res, 404, { error: 'Project not found' });
    const row = db.prepare(
        'SELECT * FROM film_treatments WHERE project_id = ? ORDER BY version DESC LIMIT 1'
    ).get(projectId);
    if (!row) {
        return json(res, 200, {
            project_id: projectId, exists: false, version: 0, content: '',
            note: 'No treatment yet. A treatment is prose that states what happens, in order, '
                + 'without dialogue or screenplay format — it is what the screenplay is written FROM.',
        });
    }
    const words = String(row.content || '').trim().split(/\s+/).filter(Boolean).length;
    return json(res, 200, { project_id: projectId, exists: true, ...row, word_count: words });
}

function putTreatment(req, res, projectId) {
    if (!project(projectId)) return json(res, 404, { error: 'Project not found' });
    const body = req.body || {};
    if (typeof body.content !== 'string') {
        return json(res, 400, { error: 'content is required (a string)' });
    }

    const last = db.prepare(
        'SELECT * FROM film_treatments WHERE project_id = ? ORDER BY version DESC LIMIT 1'
    ).get(projectId);

    /*
     * An unchanged save writes nothing.
     *
     * The same rule scene editing follows: "did that apply?" has to be a free
     * question, and a new version for identical text makes the version list
     * useless as a record of what actually changed.
     */
    if (last && last.content === body.content && (body.title === undefined || body.title === last.title)) {
        return json(res, 200, { ...last, changed: false });
    }

    const id = generateId();
    const version = last ? last.version + 1 : 1;
    db.prepare(
        'INSERT INTO film_treatments (id, project_id, version, title, content) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectId, version, body.title || (last && last.title) || null, body.content);
    const row = db.prepare('SELECT * FROM film_treatments WHERE id = ?').get(id);
    return json(res, 201, { ...row, changed: true });
}

function treatmentVersions(req, res, projectId) {
    const rows = db.prepare(
        'SELECT id, version, title, length(content) AS length, created_at FROM film_treatments '
        + 'WHERE project_id = ? ORDER BY version DESC'
    ).all(projectId);
    return json(res, 200, { project_id: projectId, total: rows.length, versions: rows });
}

function deleteTreatment(req, res, projectId) {
    // Deletes the LATEST version only — a treatment is versioned, and removing
    // the whole history because someone wanted to undo one save is the kind of
    // destructive convenience this codebase has paid for before.
    const last = db.prepare(
        'SELECT * FROM film_treatments WHERE project_id = ? ORDER BY version DESC LIMIT 1'
    ).get(projectId);
    if (!last) return json(res, 404, { error: 'No treatment to delete' });
    db.prepare('DELETE FROM film_treatments WHERE id = ?').run(last.id);
    const now = db.prepare(
        'SELECT version FROM film_treatments WHERE project_id = ? ORDER BY version DESC LIMIT 1'
    ).get(projectId);
    return json(res, 200, { deleted_version: last.version, current_version: now ? now.version : 0 });
}

/* ── analysis ──────────────────────────────────────────────────────────── */

function analysisBrief(req, res, projectId) {
    const p = project(projectId);
    if (!p) return json(res, 404, { error: 'Project not found' });
    const script = latestScript(projectId);
    if (!script) {
        return json(res, 409, {
            error: 'NO_SCREENPLAY',
            message: 'There is no screenplay to read. Upload one first, or write a treatment '
                + 'and draft from it.',
        });
    }
    const scenes = sceneBlocks(script);
    const fountain = script.fountain_content || script.content || '';
    const timing = T.estimateScreenplay(scenes);

    const brief = A.buildBrief({ title: p.title, fountain, scenes, timing });
    return json(res, 200, {
        project_id: projectId,
        script_version: script.version,
        free: true,
        ...brief,
    });
}

function rowToAnalysis(row) {
    if (!row) return null;
    const parse = (s, fallback) => { try { return JSON.parse(s); } catch (_) { return fallback; } };
    return {
        id: row.id,
        project_id: row.project_id,
        script_id: row.script_id,
        script_version: row.script_version,
        analyst: row.analyst,
        created_at: row.created_at,
        map: parse(row.map_json, {}),
        observations: parse(row.observations_json, []),
        questions: parse(row.questions_json, []),
        opportunities: parse(row.opportunities_json, []),
    };
}

function getAnalysis(req, res, projectId, query) {
    if (!project(projectId)) return json(res, 404, { error: 'Project not found' });
    if (query && query.all === 'true') {
        const rows = db.prepare(
            'SELECT * FROM film_screenplay_analyses WHERE project_id = ? ORDER BY created_at DESC'
        ).all(projectId);
        return json(res, 200, { project_id: projectId, total: rows.length, analyses: rows.map(rowToAnalysis) });
    }
    const row = db.prepare(
        'SELECT * FROM film_screenplay_analyses WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(projectId);
    if (!row) return json(res, 200, { project_id: projectId, exists: false, analysis: null });

    const analysis = rowToAnalysis(row);
    const script = latestScript(projectId);
    /*
     * Say when the reading is of an older draft.
     *
     * A report presented beside a screenplay it does not describe is worse than
     * no report: every note still reads as current, and the writer acts on
     * observations about text they have already replaced.
     */
    const stale = !!(script && analysis.script_version != null && script.version !== analysis.script_version);
    return json(res, 200, {
        project_id: projectId, exists: true, analysis,
        of_current_draft: !stale,
        ...(stale ? {
            warning: `This reading is of draft v${analysis.script_version}; the screenplay is now `
                + `v${script.version}. Some notes may be about text that has changed.`,
        } : {}),
    });
}

function postAnalysis(req, res, projectId) {
    if (!project(projectId)) return json(res, 404, { error: 'Project not found' });
    const body = req.body || {};

    const check = A.validateAnalysis(body);
    if (!check.valid) {
        return json(res, 400, {
            error: 'INVALID_ANALYSIS',
            message: 'The analysis does not match the schema. Every observation and opportunity '
                + 'carries evidence, an effect, a question, strategies, a confidence and a kind.',
            errors: check.errors,
        });
    }

    const script = latestScript(projectId);
    const id = generateId();
    db.prepare(
        `INSERT INTO film_screenplay_analyses
           (id, project_id, script_id, script_version, analyst, map_json, observations_json,
            questions_json, opportunities_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, script ? script.id : null, script ? script.version : null,
        body.analyst || null,
        JSON.stringify(body.map || {}),
        JSON.stringify(body.observations || []),
        JSON.stringify(body.questions || []),
        JSON.stringify(body.opportunities || []));

    return json(res, 201, {
        ...rowToAnalysis(db.prepare('SELECT * FROM film_screenplay_analyses WHERE id = ?').get(id)),
        counts: {
            observations: (body.observations || []).length,
            questions: (body.questions || []).length,
            opportunities: (body.opportunities || []).length,
        },
    });
}

function deleteAnalysis(req, res, id) {
    const row = db.prepare('SELECT * FROM film_screenplay_analyses WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Analysis not found' });
    db.prepare('DELETE FROM film_screenplay_analyses WHERE id = ?').run(id);
    return json(res, 200, { deleted: id });
}

/* ── timing ────────────────────────────────────────────────────────────── */

/**
 * Eighths, screen time and shooting effort, per scene and for the whole script.
 *
 * Derived on every request rather than stored: a stored measurement is a second
 * copy of the screenplay that can disagree with the screenplay.
 */
function getTiming(req, res, projectId, query) {
    if (!project(projectId)) return json(res, 404, { error: 'Project not found' });
    const script = latestScript(projectId);
    if (!script) return json(res, 200, { project_id: projectId, exists: false, scenes: [] });

    const scenes = sceneBlocks(script);
    const delivery = (query && query.delivery) || 'ordinary';
    const report = T.estimateScreenplay(scenes, { delivery });

    // Shots per scene, so a director can see what the breakdown already covers.
    const shotCounts = {};
    for (const row of db.prepare(
        `SELECT s.scene_number AS n, COUNT(sh.id) AS c
           FROM film_scenes s LEFT JOIN film_shots sh ON sh.scene_id = s.id
          WHERE s.project_id = ? GROUP BY s.scene_number`).all(projectId)) {
        shotCounts[String(row.n)] = row.c;
    }

    return json(res, 200, {
        project_id: projectId,
        script_version: script.version,
        delivery,
        delivery_rates: T.DELIVERY_RATES,
        ...report,
        scenes: report.scenes.map((s, i) => ({
            ...s,
            scene_number: scenes[i] ? scenes[i].scene_number : i + 1,
            shot_count: shotCounts[String(scenes[i] ? scenes[i].scene_number : i + 1)] || 0,
        })),
    });
}

/* ── routing ───────────────────────────────────────────────────────────── */

function handleStoryDevelopment(req, res, urlParts, query) {
    // /film/projects/:id/{treatment,analysis,timing}
    if (urlParts[1] === 'projects' && urlParts[2]) {
        const projectId = urlParts[2];
        const section = urlParts[3];

        if (section === 'treatment') {
            if (urlParts[4] === 'versions' && req.method === 'GET') {
                return treatmentVersions(req, res, projectId);
            }
            if (req.method === 'GET') return getTreatment(req, res, projectId);
            if (req.method === 'PUT' || req.method === 'POST') return putTreatment(req, res, projectId);
            if (req.method === 'DELETE') return deleteTreatment(req, res, projectId);
            return json(res, 405, { error: 'Method not allowed' });
        }

        if (section === 'analysis') {
            if (urlParts[4] === 'brief') {
                if (req.method === 'GET') return analysisBrief(req, res, projectId);
                return json(res, 405, { error: 'Method not allowed' });
            }
            if (req.method === 'GET') return getAnalysis(req, res, projectId, query);
            if (req.method === 'POST') return postAnalysis(req, res, projectId);
            return json(res, 405, { error: 'Method not allowed' });
        }

        if (section === 'timing' && req.method === 'GET') {
            return getTiming(req, res, projectId, query);
        }
    }

    if (urlParts[1] === 'analysis' && urlParts[2] && req.method === 'DELETE') {
        return deleteAnalysis(req, res, urlParts[2]);
    }

    return json(res, 404, { error: 'Not found' });
}

module.exports = { handleStoryDevelopment, sceneBlocks };
