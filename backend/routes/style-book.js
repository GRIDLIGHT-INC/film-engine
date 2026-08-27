/**
 * The style book — HTTP.
 *
 *   GET    /film/style-book                          the library (project_id IS NULL)
 *   POST   /film/projects/:id/style-book             create; scope = 'library' | 'project'
 *   GET    /film/projects/:id/style-book             this project's entries + the library
 *   GET    /film/style-book/:entryId
 *   PUT    /film/style-book/:entryId                 merge, never replace
 *   DELETE /film/style-book/:entryId
 *   POST   /film/style-book/:entryId/media           attach a visual
 *   DELETE /film/style-book/media/:mediaId
 *   POST   /film/shots/:shotId/style-book/:entryId   apply to that shot's card
 *
 * The dispatch shape mirrors routes/mood-board.js: one handler, a urlParts
 * switch, registered once in server.js.
 */

const { db, generateId } = require('../db/database');
const styleBook = require('../lib/style-book');

/**
 * What the visuals actually do, said in the response.
 *
 * KIND_RANK is anchor 0, character 1, location 2, prop 3, style 4, against a
 * budget of three references on Runway and five on Meshy. A style reference
 * already ranks LAST, so a style-book still is dropped before the request is
 * built on any shot that names a cast and a location. And a reference CLIP
 * reaches no generator at all — every image path takes stills.
 *
 * Said out loud because the alternative is a director attaching five pictures
 * and believing the frame is conditioned on them.
 */
const MEDIA_NOTE = 'Visuals are reference for you. A still is the lowest-ranked reference kind '
    + 'and is dropped before the request is built on any shot with a cast and a location; a clip '
    + 'reaches no generator at all. What reaches a picture is the camera facets, via the shot card.';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function parseCamera(raw) {
    try { return JSON.parse(raw || '{}') || {}; } catch (_) { return {}; }
}

/** A stored row as the API reports it. */
function present(row, media) {
    return {
        id: row.id,
        // The flows precedent, verbatim, so the two cannot mean different
        // things by the same word.
        scope: row.project_id ? 'project' : 'library',
        project_id: row.project_id,
        name: row.name,
        description: row.description,
        camera: parseCamera(row.camera_json),
        tags: row.tags,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
        ...(media ? { media } : {}),
    };
}

function mediaFor(entryId) {
    return db.prepare(
        `SELECT id, media_kind, asset_id, file_path, note, sort_order
           FROM film_style_book_media WHERE entry_id = ? ORDER BY sort_order, created_at`
    ).all(entryId);
}

/**
 * A project's entries plus the library.
 *
 * `WHERE project_id = ? OR project_id IS NULL` — the flows query, unchanged.
 * Ordered so the project's own variants read before the library ones: a
 * film-specific version of an angle exists because it differs, and burying it
 * under the general one is backwards.
 */
function listStyleBook(res, projectId) {
    const rows = projectId
        ? db.prepare(
            `SELECT * FROM film_style_book WHERE project_id = ? OR project_id IS NULL
              ORDER BY (project_id IS NULL), sort_order, created_at`).all(projectId)
        : db.prepare(
            `SELECT * FROM film_style_book WHERE project_id IS NULL
              ORDER BY sort_order, created_at`).all();

    return json(res, 200, {
        project_id: projectId || null,
        entries: rows.map(r => present(r, mediaFor(r.id))),
        scopes: {
            library: rows.filter(r => !r.project_id).length,
            project: rows.filter(r => r.project_id).length,
        },
        note: MEDIA_NOTE,
    });
}

function getEntry(res, entryId) {
    const row = db.prepare('SELECT * FROM film_style_book WHERE id = ?').get(entryId);
    if (!row) return json(res, 404, { error: 'Style-book entry not found' });
    return json(res, 200, { entry: present(row, mediaFor(entryId)), note: MEDIA_NOTE });
}

function createEntry(req, res, projectId) {
    const body = req.body || {};
    const check = styleBook.validateEntry(body);
    if (!check.valid) return json(res, 400, { error: 'Invalid entry', details: check.errors });

    /*
     * Default is LIBRARY, and that is the point of the feature.
     *
     * "My directing style" accumulates across films. Defaulting to the project
     * would mean the common case — the one the director asked for — needs a
     * flag every time, and the entries would quietly become per-film.
     */
    const scope = String(body.scope || 'library').toLowerCase();
    if (scope !== 'library' && scope !== 'project') {
        return json(res, 400, { error: "scope must be 'library' or 'project'" });
    }
    if (scope === 'project' && !projectId) {
        return json(res, 400, { error: 'a project-scoped entry needs a project' });
    }

    const id = generateId();
    db.prepare(
        `INSERT INTO film_style_book (id, project_id, name, description, camera_json, tags, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id,
        scope === 'project' ? projectId : null,
        String(body.name).trim().slice(0, styleBook.NAME_MAX),
        String(body.description || '').trim().slice(0, styleBook.DESCRIPTION_MAX),
        JSON.stringify(body.camera || {}),
        String(body.tags || '').trim().slice(0, styleBook.TAGS_MAX),
        Number.isFinite(body.sort_order) ? body.sort_order : 0
    );

    const row = db.prepare('SELECT * FROM film_style_book WHERE id = ?').get(id);
    return json(res, 201, { entry: present(row, []) });
}

/**
 * Update, MERGED.
 *
 * A partial write is the normal case — renaming an entry must not clear its
 * camera — and replacing is what dropped provider pins on every settings save.
 * The camera object merges per facet for the same reason applyEntryToShot
 * does.
 */
function updateEntry(req, res, entryId) {
    const existing = db.prepare('SELECT * FROM film_style_book WHERE id = ?').get(entryId);
    if (!existing) return json(res, 404, { error: 'Style-book entry not found' });

    const body = req.body || {};
    const merged = {
        name: body.name !== undefined ? String(body.name) : existing.name,
        description: body.description !== undefined ? String(body.description) : existing.description,
        tags: body.tags !== undefined ? String(body.tags) : existing.tags,
        camera: body.camera !== undefined
            ? { ...parseCamera(existing.camera_json), ...(body.camera || {}) }
            : parseCamera(existing.camera_json),
    };
    // A facet explicitly set to null CLEARS it — otherwise a facet could be
    // added and never removed, which is the destructive-default problem in
    // reverse.
    for (const [k, v] of Object.entries(body.camera || {})) if (v === null) delete merged.camera[k];

    const check = styleBook.validateEntry(merged);
    if (!check.valid) return json(res, 400, { error: 'Invalid entry', details: check.errors });

    const fields = ['name = ?', 'description = ?', 'tags = ?', 'camera_json = ?', "updated_at = datetime('now')"];
    const values = [
        merged.name.trim().slice(0, styleBook.NAME_MAX),
        merged.description.trim().slice(0, styleBook.DESCRIPTION_MAX),
        merged.tags.trim().slice(0, styleBook.TAGS_MAX),
        JSON.stringify(merged.camera),
    ];
    if (body.scope === 'library') { fields.push('project_id = NULL'); }
    else if (body.scope === 'project' && body.project_id) { fields.push('project_id = ?'); values.push(body.project_id); }
    if (Number.isFinite(body.sort_order)) { fields.push('sort_order = ?'); values.push(body.sort_order); }

    db.prepare(`UPDATE film_style_book SET ${fields.join(', ')} WHERE id = ?`).run(...values, entryId);
    const row = db.prepare('SELECT * FROM film_style_book WHERE id = ?').get(entryId);
    return json(res, 200, { entry: present(row, mediaFor(entryId)) });
}

function deleteEntry(res, entryId) {
    const row = db.prepare('SELECT id FROM film_style_book WHERE id = ?').get(entryId);
    if (!row) return json(res, 404, { error: 'Style-book entry not found' });
    // Media CASCADEs from the entry.
    db.prepare('DELETE FROM film_style_book WHERE id = ?').run(entryId);
    return json(res, 200, { deleted: entryId });
}

function addMedia(req, res, entryId) {
    const entry = db.prepare('SELECT id FROM film_style_book WHERE id = ?').get(entryId);
    if (!entry) return json(res, 404, { error: 'Style-book entry not found' });

    const body = req.body || {};
    const kind = String(body.media_kind || 'image').toLowerCase();
    // Checked against the engine's own registry rather than a local list, so a
    // kind added there is accepted here without an edit.
    const known = Object.keys(require('../lib/media-kinds').MEDIA_KINDS || {});
    if (known.length && !known.includes(kind)) {
        return json(res, 400, { error: `media_kind must be one of: ${known.join(', ')}`, media_kinds: known });
    }
    if (!body.file_path && !body.asset_id) {
        return json(res, 400, { error: 'a visual needs a file_path or an asset_id' });
    }

    const id = generateId();
    db.prepare(
        `INSERT INTO film_style_book_media (id, entry_id, media_kind, asset_id, file_path, note, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, entryId, kind, body.asset_id || null, String(body.file_path || ''),
        String(body.note || '').slice(0, 500),
        Number.isFinite(body.sort_order) ? body.sort_order : mediaFor(entryId).length);

    return json(res, 201, { media: mediaFor(entryId), note: MEDIA_NOTE });
}

function deleteMedia(res, mediaId) {
    const row = db.prepare('SELECT id FROM film_style_book_media WHERE id = ?').get(mediaId);
    if (!row) return json(res, 404, { error: 'Visual not found' });
    db.prepare('DELETE FROM film_style_book_media WHERE id = ?').run(mediaId);
    return json(res, 200, { deleted: mediaId });
}

/**
 * Apply an entry to a shot's card.
 *
 * This is the step that makes the feature worth building: the card is already
 * what both prompt builders read, so writing onto it is how a favourite angle
 * reaches a generation with no new plumbing.
 *
 * Precedence is UNCHANGED — this writes onto the card rather than becoming a
 * fourth level in effectiveCamera(). A display that is consulted at generation
 * time is a display that eventually disagrees with the generator.
 */
function applyToShot(req, res, shotId, entryId) {
    const entry = db.prepare('SELECT * FROM film_style_book WHERE id = ?').get(entryId);
    if (!entry) return json(res, 404, { error: 'Style-book entry not found' });

    // The column is scene_card_yaml and holds JSON, which is what
    // PUT /shots/:id reads and writes. Matched exactly rather than guessed:
    // film_shots also has no updated_at.
    const shot = db.prepare('SELECT id, scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    let card = {};
    try { card = JSON.parse(shot.scene_card_yaml || '{}') || {}; } catch (_) { card = {}; }

    const out = styleBook.applyEntryToShot({ ...entry, camera: parseCamera(entry.camera_json) }, card);

    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify(out.card), shotId);

    /*
     * A card the entry changed is a card whose generated frame is now behind.
     * Stamping is best-effort and must never fail the apply, the rule
     * stampAsset already documents.
     */
    try { require('../lib/screenplay-drift').stampShot(shotId); } catch (_) { /* not fatal */ }

    return json(res, 200, {
        shot_id: shotId,
        entry: present(entry),
        applied: out.applied,
        skipped: out.skipped,
        card: out.card,
        note: out.applied.length
            ? `Applied ${out.applied.length} facet(s) to ${shotId}. Regenerate the frame to see it.`
            : 'This entry carried no facets this shot could use — nothing changed.',
    });
}

function handleStyleBook(req, res, urlParts, query) {
    // /film/projects/:id/style-book
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'style-book') {
        if (req.method === 'GET') return listStyleBook(res, urlParts[2]);
        if (req.method === 'POST') return createEntry(req, res, urlParts[2]);
    }

    // /film/shots/:id/style-book/:entryId
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'style-book' && urlParts[4]) {
        if (req.method === 'POST') return applyToShot(req, res, urlParts[2], urlParts[4]);
    }

    if (urlParts[1] === 'style-book') {
        // /film/style-book — the library
        if (!urlParts[2]) {
            if (req.method === 'GET') return listStyleBook(res, null);
            // Creatable with no project open. The style book exists before any
            // film does — that is half the point of it being cross-project —
            // and requiring a project to add to your own library would make
            // the common case the awkward one.
            if (req.method === 'POST') return createEntry(req, res, null);
        }
        // /film/style-book/media/:id
        if (urlParts[2] === 'media' && urlParts[3]) {
            if (req.method === 'DELETE') return deleteMedia(res, urlParts[3]);
        }
        // /film/style-book/:id[/media]
        if (urlParts[2] && urlParts[2] !== 'media') {
            if (urlParts[3] === 'media') {
                if (req.method === 'POST') return addMedia(req, res, urlParts[2]);
            } else if (!urlParts[3]) {
                if (req.method === 'GET') return getEntry(res, urlParts[2]);
                if (req.method === 'PUT') return updateEntry(req, res, urlParts[2]);
                if (req.method === 'DELETE') return deleteEntry(res, urlParts[2]);
            }
        }
    }

    return json(res, 405, { error: 'Method not allowed' });
}

module.exports = { handleStyleBook, listStyleBook, MEDIA_NOTE };
