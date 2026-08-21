/**
 * Beat sheets and writing directives.
 *
 *   GET  /film/projects/:id/beats        — the structure, and its holes
 *   POST /film/projects/:id/beats        — apply a framework
 *   PUT  /film/beats/:id                 — link a scene, rename, note
 *   DELETE /film/beats/:id               — a beat this film does not want
 *   GET|PUT /film/projects/:id/directives — house rules on the writing
 *
 * The holes are the point. A list of beats you have covered answers the easy
 * half of the question; the useful half is the beat with nothing against it,
 * because that is where the adaptation has a gap.
 */

const { db, generateId } = require('../db/database');
const { FRAMEWORKS, holesIn, suggestScenes } = require('../lib/beat-sheets');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function loadBeats(projectId) {
    return db.prepare(
        `SELECT b.*, s.scene_number, s.location, s.int_ext, s.time_of_day
           FROM film_beats b LEFT JOIN film_scenes s ON s.id = b.scene_id
          WHERE b.project_id = ? ORDER BY b.sort_order, b.at_percent`).all(projectId)
        .map(r => ({
            id: r.id, framework: r.framework, name: r.name, guidance: r.guidance,
            at: r.at_percent, notes: r.notes,
            scene_id: r.scene_id || null,
            // The heading, not just the id. "Beat 4 → scene c3f9…" is a database
            // row; "Midpoint → EXT. SLUICE - MORNING" is something a writer can
            // check against what they remember writing.
            scene_heading: r.scene_id
                ? `${r.int_ext || ''} ${r.location || ''}${r.time_of_day ? ' - ' + r.time_of_day : ''}`.trim()
                : null,
            scene_number: r.scene_number || null,
        }));
}

function getBeats(req, res, projectId) {
    const beats = loadBeats(projectId);
    const sceneCount = db.prepare(
        "SELECT COUNT(*) n FROM film_scenes WHERE project_id = ? AND status != 'removed'").get(projectId).n;

    return json(res, 200, {
        project_id: projectId,
        framework: beats.length ? beats[0].framework : null,
        beats,
        // Named first in the payload's meaning if not its order: this is what
        // the endpoint is FOR.
        holes: holesIn(beats),
        suggestions: suggestScenes(beats.filter(b => !b.scene_id), sceneCount),
        scene_count: sceneCount,
        note: beats.length
            ? 'The holes are beats with no scene against them — that is where the structure is missing, '
                + 'and the suggestions are a guess from pacing alone, never an assignment.'
            : 'No beat sheet yet. POST a framework to lay one over this script.',
    });
}

function applyFramework(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const id = String((req.body && req.body.framework) || '').trim();
    const fw = FRAMEWORKS[id];
    if (!fw) {
        return json(res, 400, {
            error: `Unknown framework '${id}'.`,
            available: Object.entries(FRAMEWORKS).map(([k, f]) => ({ id: k, label: f.label, beats: f.beats.length, note: f.note })),
        });
    }

    const existing = db.prepare('SELECT COUNT(*) n FROM film_beats WHERE project_id = ?').get(projectId).n;
    if (existing && !(req.body && req.body.replace)) {
        // Refused rather than merged. Two frameworks laid over one script is not
        // a structure, it is two opinions, and silently adding fifteen beats to
        // an existing eight is the kind of help that takes an hour to undo.
        return json(res, 409, {
            error: `This project already has ${existing} beat(s). Pass replace: true to lay a different framework over it.`,
            hint: 'Replacing discards the beats and their scene links; the scenes themselves are untouched.',
        });
    }
    if (existing) db.prepare('DELETE FROM film_beats WHERE project_id = ?').run(projectId);

    const insert = db.prepare(
        `INSERT INTO film_beats (id, project_id, framework, name, guidance, at_percent, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction(() => {
        fw.beats.forEach((b, i) => insert.run(generateId(), projectId, id, b.name, b.guidance, b.at, i));
    });
    tx();

    return json(res, 201, {
        project_id: projectId, framework: id, label: fw.label,
        beats_created: fw.beats.length,
        replaced: !!existing,
        note: 'Every beat starts unlinked. GET this endpoint for the holes, and link a scene to close one.',
    });
}

function updateBeat(req, res, beatId) {
    const beat = db.prepare('SELECT * FROM film_beats WHERE id = ?').get(beatId);
    if (!beat) return json(res, 404, { error: 'Beat not found' });

    const body = req.body || {};
    const fields = [];
    const values = [];

    if (body.scene_id !== undefined) {
        if (body.scene_id === null || body.scene_id === '') {
            fields.push('scene_id = NULL');
        } else {
            const scene = db.prepare('SELECT id, project_id FROM film_scenes WHERE id = ?').get(String(body.scene_id));
            if (!scene || scene.project_id !== beat.project_id) {
                // A beat pointing at another film's scene would report a closed
                // hole that is not closed.
                return json(res, 400, { error: 'That scene is not in this project.' });
            }
            fields.push('scene_id = ?');
            values.push(scene.id);
        }
    }
    for (const [key, col] of [['name', 'name'], ['guidance', 'guidance'], ['notes', 'notes']]) {
        if (body[key] !== undefined) { fields.push(`${col} = ?`); values.push(String(body[key])); }
    }
    if (body.at !== undefined && Number.isFinite(Number(body.at))) {
        fields.push('at_percent = ?'); values.push(Number(body.at));
    }
    if (!fields.length) return json(res, 400, { error: 'Nothing to change.' });

    values.push(beatId);
    db.prepare(`UPDATE film_beats SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    const after = loadBeats(beat.project_id).find(b => b.id === beatId);
    return json(res, 200, { beat: after, holes_remaining: holesIn(loadBeats(beat.project_id)).length });
}

function deleteBeat(req, res, beatId) {
    const beat = db.prepare('SELECT id FROM film_beats WHERE id = ?').get(beatId);
    if (!beat) return json(res, 404, { error: 'Beat not found' });
    db.prepare('DELETE FROM film_beats WHERE id = ?').run(beatId);
    return json(res, 200, { deleted: true, id: beatId });
}

/**
 * House rules on the WRITING.
 *
 * Kept apart from `style_preset` on purpose, and the response says so. That
 * field is appended to every image prompt; putting "present tense, no camera
 * directions in action" into it would send screenwriting instructions to an
 * image model on every frame of the film. Two audiences, two fields.
 */
function getDirectives(req, res, projectId) {
    const row = db.prepare('SELECT writing_directives, style_preset FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return json(res, 404, { error: 'Project not found' });
    return json(res, 200, {
        project_id: projectId,
        directives: row.writing_directives || '',
        note: 'These govern how the SCREENPLAY is written and are read before drafting. They are NOT '
            + 'the style_preset, which governs how frames are generated and is appended to every image prompt.',
        style_preset: row.style_preset || '',
    });
}

function setDirectives(req, res, projectId) {
    const row = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return json(res, 404, { error: 'Project not found' });
    const text = String((req.body && req.body.directives) || '').slice(0, 8000);
    db.prepare('UPDATE film_projects SET writing_directives = ? WHERE id = ?').run(text, projectId);
    return json(res, 200, {
        project_id: projectId, directives: text,
        note: 'Read these before writing or revising a scene. They do not reach any image prompt.',
    });
}

function handleStoryStructure(req, res, urlParts) {
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'beats') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method === 'GET') return getBeats(req, res, urlParts[2]);
        if (req.method === 'POST') return applyFramework(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'directives') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method === 'GET') return getDirectives(req, res, urlParts[2]);
        if (req.method === 'PUT') return setDirectives(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }
    if (urlParts[1] === 'beats' && urlParts[2]) {
        if (req.method === 'PUT') return updateBeat(req, res, urlParts[2]);
        if (req.method === 'DELETE') return deleteBeat(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }
    return json(res, 404, { error: 'Not found' });
}

module.exports = { handleStoryStructure, FRAMEWORKS };
