/**
 * The mood board — where a look is decided before anything generates.
 *
 *   GET    /film/projects/:id/mood-board
 *   POST   /film/projects/:id/mood-board            add an entry
 *   POST   /film/projects/:id/mood-board/compose    board → style preset
 *   DELETE /film/mood-board/:entryId
 *
 * The board's OUTPUT is the style preset, and that is the whole point. A mood
 * board that sits beside generation is a scrapbook; one whose output feeds
 * generation is look development. It is also the moment at which a style
 * carrying a subject becomes catchable — before eight frames have been paid
 * for, rather than after.
 *
 * Composing does NOT apply. Previewing a look and committing to it are
 * different decisions, and applying silently would rewrite the look of every
 * future frame from something the director was only trying out.
 */

const { db, generateId } = require('../db/database');
const { validateStylePreset, SPEC_KINDS, allowedSpecValues, validateSpec, applyProjectSpecs } = require('../lib/look-development');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * The order facets read in a style string.
 *
 * Not alphabetical and not insertion order: a style is read by a model roughly
 * front-to-back, so the medium and palette lead and the grain trails — the same
 * ordering rule the plate builders learned the hard way when appending the look
 * last let boilerplate decide the medium.
 */
const KIND_ORDER = ['medium', 'palette', 'lighting', 'lens', 'framing', 'texture', 'image', 'note'];

function listBoard(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const entries = db.prepare(
        'SELECT * FROM film_mood_board WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId);
    return json(res, 200, { project_id: projectId, entries, count: entries.length });
}

function addEntry(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const body = req.body || {};
    const kind = String(body.kind || 'image').trim() || 'image';
    const note = String(body.note || '').trim();
    const imagePath = String(body.image_path || '').trim();
    // An entry with neither words nor a picture is not a reference, it is a
    // blank row that will later look like a lost one.
    if (!note && !imagePath && !body.asset_id && body.spec_kind === undefined) {
        return json(res, 400, { error: 'An entry needs a note, an image, an asset, or a spec' });
    }

    // A spec is picked from the engine's own registry, never typed. Rejecting
    // an unknown value here is what makes the board able to reach previs and
    // the delivery settings at all — free text can only reach a prompt.
    if (body.spec_kind !== undefined) {
        const check = validateSpec(String(body.spec_kind), body.spec_value);
        if (!check.ok) return json(res, 400, { error: check.error, allowed: allowedSpecValues(String(body.spec_kind)) });
    }

    const id = generateId();
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM film_mood_board WHERE project_id = ?')
        .get(projectId).n;
    db.prepare(
        `INSERT INTO film_mood_board (id, project_id, kind, note, asset_id, image_path, sort_order, spec_kind, spec_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, projectId, kind, note, body.asset_id || null, imagePath, next,
            body.spec_kind ? String(body.spec_kind) : null,
            body.spec_value !== undefined ? String(body.spec_value) : null);

    return json(res, 201, { entry: db.prepare('SELECT * FROM film_mood_board WHERE id = ?').get(id) });
}

function deleteEntry(req, res, entryId) {
    const row = db.prepare('SELECT id FROM film_mood_board WHERE id = ?').get(entryId);
    if (!row) return json(res, 404, { error: 'Entry not found' });
    db.prepare('DELETE FROM film_mood_board WHERE id = ?').run(entryId);
    return json(res, 200, { deleted: true, id: entryId });
}

/**
 * Compose the board into a style preset.
 *
 * Image-only entries contribute nothing to the words — a picture cannot be
 * concatenated into a prompt, and pretending otherwise would produce a style
 * that silently ignores half the board. They stay on the board as references
 * for a human eye and for plate generation.
 */
function compose(req, res, projectId) {
    const project = db.prepare('SELECT id, style_preset FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const entries = db.prepare(
        'SELECT * FROM film_mood_board WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId);

    const rank = k => {
        const i = KIND_ORDER.indexOf(String(k || '').toLowerCase());
        return i < 0 ? KIND_ORDER.length : i;
    };
    const parts = entries
        .filter(e => String(e.note || '').trim())
        .sort((a, b) => rank(a.kind) - rank(b.kind) || a.sort_order - b.sort_order)
        .map(e => String(e.note).trim());

    const style = parts.join(', ');

    if (!style) {
        // Applying an empty string would strip the look from a project that
        // already had one, which is a destructive answer to "what does my board
        // say?".
        return json(res, 200, {
            project_id: projectId, style_preset: '', applied: false,
            message: entries.length
                ? 'The board has only images, which cannot be composed into words. Add a note to an entry.'
                : 'The board is empty, so there is nothing to compose.',
        });
    }

    const check = validateStylePreset(style);

    // The specs on the board, and where each one lands. Reported whether or not
    // they are applied, so composing answers "what would this do" completely.
    const specs = entries
        .filter(e => e.spec_kind && SPEC_KINDS[e.spec_kind])
        .map(e => ({ kind: e.spec_kind, value: e.spec_value, target: SPEC_KINDS[e.spec_kind].target }));

    let applied = false;
    let appliedSpecs = [];
    if (req.body && req.body.apply) {
        db.prepare('UPDATE film_projects SET style_preset = ? WHERE id = ?').run(style, projectId);
        // Written through the same columns the settings UI uses, so a look
        // decided here and one typed into settings cannot disagree about what
        // is delivered.
        appliedSpecs = applyProjectSpecs(db, projectId, specs);
        applied = true;
    }

    return json(res, 200, {
        project_id: projectId,
        style_preset: style,
        applied,
        contributing_entries: parts.length,
        specs,
        applied_specs: appliedSpecs,
        spec_kinds: Object.fromEntries(Object.entries(SPEC_KINDS)
            .map(([k, v]) => [k, { target: v.target, label: v.label, allowed: allowedSpecValues(k) }])),
        // Warned at the moment the look is decided, rather than after the
        // frames come back with something nobody wrote.
        warning: check.ok ? null : { subjects: check.subjects, detail: check.detail },
    });
}

function handleMoodBoard(req, res, urlParts) {
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'mood-board') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (urlParts[4] === 'compose') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            return compose(req, res, urlParts[2]);
        }
        if (req.method === 'GET') return listBoard(req, res, urlParts[2]);
        if (req.method === 'POST') return addEntry(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }

    if (urlParts[1] === 'mood-board' && urlParts[2]) {
        if (req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed' });
        return deleteEntry(req, res, urlParts[2]);
    }

    return json(res, 404, { error: 'Not found' });
}

module.exports = { handleMoodBoard, compose, KIND_ORDER };
