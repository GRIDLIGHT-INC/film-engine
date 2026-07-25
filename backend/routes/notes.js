/**
 * FILM-085: Shot notes, reviews, and revisions
 * POST /film/shots/:id/notes — add note
 * GET  /film/shots/:id/notes — list notes
 * PUT  /film/notes/:id — update/resolve note
 * POST /film/shots/:id/review — approval/rejection
 */
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_NOTE_TYPES = [
    'direction', 'revision', 'approval', 'rejection',
    'camera', 'lighting', 'performance', 'continuity',
    'vfx', 'audio', 'color', 'general'
];

const VALID_PRIORITIES = ['low', 'normal', 'high', 'critical'];

function handleNotes(req, res, urlParts, query) {
    // /film/shots/:id/notes
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'notes') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return badReq(res, 'Invalid shot ID');
        if (req.method === 'GET') return listShotNotes(req, res, shotId, query);
        if (req.method === 'POST') return createShotNote(req, res, shotId);
    }

    // /film/shots/:id/review
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'review') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return badReq(res, 'Invalid shot ID');
        if (req.method === 'POST') return reviewShot(req, res, shotId);
    }

    // /film/notes/:id (update/resolve)
    if (urlParts[1] === 'notes' && urlParts[2]) {
        const noteId = urlParts[2];
        if (!UUID_RE.test(noteId)) return badReq(res, 'Invalid note ID');
        if (req.method === 'PUT') return updateNote(req, res, noteId);
        if (req.method === 'DELETE') return deleteNote(req, res, noteId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

/**
 * Gap 4: normalize an incoming timecode_ms.
 *
 * Returns null for absent/null (a shot-level note), an integer for a valid
 * position, or the sentinel `false` for invalid input so the caller can reject
 * it. Distinguishing "not supplied" from "supplied as garbage" matters —
 * silently coercing a bad value to 0 would pin the note to the first frame,
 * which looks like a working feature while being wrong.
 */
function parseTimecodeMs(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) return false;
    return n;
}

function listShotNotes(req, res, shotId, query) {
    let sql = 'SELECT * FROM film_shot_notes WHERE shot_id = ?';
    const params = [shotId];

    if (query.type && VALID_NOTE_TYPES.includes(query.type)) {
        sql += ' AND note_type = ?';
        params.push(query.type);
    }
    if (query.unresolved === 'true') {
        sql += ' AND resolved = 0';
    }
    // Gap 4: only notes pinned to a moment, for the player's marker track.
    if (query.timecoded === 'true') {
        sql += ' AND timecode_ms IS NOT NULL';
    }

    // Timecoded notes are read in playback order — a marker track sorted by
    // recency would be unusable. Shot-level notes keep newest-first.
    sql += query.timecoded === 'true'
        ? ' ORDER BY timecode_ms ASC'
        : ' ORDER BY created_at DESC';

    const rows = db.prepare(sql).all(...params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notes: rows, count: rows.length }));
}

function createShotNote(req, res, shotId) {
    // Verify shot exists
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Shot not found' }));
        return;
    }

    const body = req.body;
    if (!body.content || !body.content.trim()) return badReq(res, 'Note content is required');

    const noteType = VALID_NOTE_TYPES.includes(body.note_type) ? body.note_type : 'general';
    const priority = VALID_PRIORITIES.includes(body.priority) ? body.priority : 'normal';

    // Gap 4: optional shot-relative position. Absent/null keeps the historical
    // behaviour — a note about the shot as a whole.
    const timecodeMs = parseTimecodeMs(body.timecode_ms);
    if (timecodeMs === false) return badReq(res, 'timecode_ms must be a non-negative integer or null');

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_shot_notes (id, shot_id, author, note_type, content, priority, timecode_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, shotId, (body.author || 'director').slice(0, 100), noteType, body.content.slice(0, 10000), priority, timecodeMs, now);

    const row = db.prepare('SELECT * FROM film_shot_notes WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function reviewShot(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Shot not found' }));
        return;
    }

    const body = req.body;
    const approved = body.approved === true;
    const noteType = approved ? 'approval' : 'rejection';

    // Create review note
    const noteId = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_shot_notes (id, shot_id, author, note_type, content, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        noteId, shotId,
        (body.author || 'director').slice(0, 100),
        noteType,
        (body.notes || (approved ? 'Approved' : 'Rejected')).slice(0, 10000),
        approved ? 'normal' : 'high',
        now
    );

    // Update shot status
    const newStatus = approved ? 'approved' : 'pending';
    db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run(newStatus, shotId);

    const updatedShot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    const note = db.prepare('SELECT * FROM film_shot_notes WHERE id = ?').get(noteId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shot: updatedShot, review: note }));
}

function updateNote(req, res, noteId) {
    const body = req.body;
    const fields = [];
    const values = [];

    if (body.content !== undefined) {
        fields.push('content = ?');
        values.push(String(body.content).slice(0, 10000));
    }
    if (body.priority !== undefined && VALID_PRIORITIES.includes(body.priority)) {
        fields.push('priority = ?');
        values.push(body.priority);
    }
    if (body.resolved !== undefined) {
        fields.push('resolved = ?');
        values.push(body.resolved ? 1 : 0);
        if (body.resolved) {
            fields.push("resolved_at = datetime('now')");
        } else {
            fields.push('resolved_at = NULL');
        }
    }
    // Gap 4: re-pin a note to a different moment, or explicitly clear its
    // position back to a shot-level note by sending null.
    if (body.timecode_ms !== undefined) {
        const timecodeMs = parseTimecodeMs(body.timecode_ms);
        if (timecodeMs === false) return badReq(res, 'timecode_ms must be a non-negative integer or null');
        fields.push('timecode_ms = ?');
        values.push(timecodeMs);
    }

    if (fields.length === 0) return badReq(res, 'No valid fields to update');

    values.push(noteId);
    const result = db.prepare(`UPDATE film_shot_notes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Note not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_shot_notes WHERE id = ?').get(noteId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function deleteNote(req, res, noteId) {
    const result = db.prepare('DELETE FROM film_shot_notes WHERE id = ?').run(noteId);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Note not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

module.exports = { handleNotes };
