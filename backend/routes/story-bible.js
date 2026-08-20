/**
 * The story bible: what things ARE, as opposed to what happens.
 *
 * GET    /film/projects/:id/bible          — every section
 * PUT    /film/projects/:id/bible          — write sections; merges
 * DELETE /film/projects/:id/bible/:section — remove one
 * GET    /film/projects/:id/bible-drift    — entities their section has outrun
 *
 * The response says plainly what a bible does and does not do, because the
 * whole failure mode of a feature like this is a director pasting sixty pages
 * in and believing it now conditions their frames. It does not. Four fields
 * reach an image model, and the bible's job is to be the thing someone writes
 * them from — with a link back, so revising a section flags what was written
 * from it rather than leaving that to memory.
 */

const { db } = require('../db/database');
const { listSections, writeSections, drift, SUBJECTS } = require('../lib/story-bible');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

const REACHES_GENERATION =
    'A bible reaches no image model by itself. Four fields do: a character’s appearance_prompt, '
    + 'a location’s description, a prop’s visual_prompt and the project’s style_preset. '
    + 'Write those from these sections, and pass bible_section when you do so a later revision can find them.';

function getBible(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const sections = listSections(projectId);
    return json(res, 200, {
        project_id: projectId,
        section_count: sections.length,
        sections,
        // What is linked to what, so a caller can see the wiring rather than
        // guess at it.
        linked: linkedSubjects(projectId),
        note: REACHES_GENERATION,
    });
}

/** Which entities say they were written from which section. */
function linkedSubjects(projectId) {
    const out = [];
    for (const spec of SUBJECTS) {
        try {
            for (const row of db.prepare(
                `SELECT id, name, bible_section FROM ${spec.table}
                  WHERE project_id = ? AND bible_section IS NOT NULL`).all(projectId)) {
                out.push({ kind: spec.kind, id: row.id, name: row.name, section: row.bible_section });
            }
        } catch (_) { /* table without the column yet */ }
    }
    return out;
}

function putBible(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const body = req.body || {};
    const sections = body.sections && typeof body.sections === 'object' ? body.sections : null;
    if (!sections || !Object.keys(sections).length) {
        return json(res, 400, {
            error: 'sections is required: an object of { "SECTION NAME": "body text" }',
            hint: 'Merges, so send only the sections you are changing.',
        });
    }

    const written = writeSections(projectId, sections);
    const behind = drift(projectId);
    return json(res, 200, {
        project_id: projectId,
        written,
        // Said at the moment of writing, not left for a separate call. Someone
        // revising MAYA's section wants to know now that her plate was built
        // from the previous version.
        now_behind: behind,
        note: behind.length
            ? `${behind.length} entity/entities were written from a section that has since changed. Re-read them.`
            : REACHES_GENERATION,
    });
}

function deleteSection(req, res, projectId, section) {
    const row = db.prepare('SELECT id FROM film_story_bible WHERE project_id = ? AND section = ?')
        .get(projectId, section);
    if (!row) return json(res, 404, { error: 'No such section' });
    db.prepare('DELETE FROM film_story_bible WHERE id = ?').run(row.id);
    // Entities that pointed at it are not unlinked: they keep saying what they
    // were written from, and the drift report names the deletion. Silently
    // clearing the link would lose the only record that they came from
    // something that no longer exists.
    return json(res, 200, { deleted: section, now_behind: drift(projectId) });
}

function handleStoryBible(req, res, urlParts) {
    const projectId = urlParts[2];
    if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

    if (urlParts[3] === 'bible-drift') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        const behind = drift(projectId);
        return json(res, 200, {
            project_id: projectId,
            count: behind.length,
            entities: behind,
            note: behind.length
                ? 'These descriptions were written from a bible section that has since changed. Nothing is blocked — re-read the section, update the field, and regenerate any plate marked plated.'
                : 'Every entity written from the bible matches the section it came from.',
        });
    }

    if (urlParts[3] === 'bible') {
        if (urlParts[4]) {
            if (req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed' });
            return deleteSection(req, res, projectId, decodeURIComponent(urlParts[4]));
        }
        if (req.method === 'GET') return getBible(req, res, projectId);
        if (req.method === 'PUT') return putBible(req, res, projectId);
        return json(res, 405, { error: 'Method not allowed' });
    }
    return json(res, 404, { error: 'Not found' });
}

module.exports = { handleStoryBible };
