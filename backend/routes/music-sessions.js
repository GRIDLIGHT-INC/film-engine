/**
 * The score-session HTTP API.
 *
 *   GET    /film/projects/:id/music-sessions            list
 *   POST   /film/projects/:id/music-sessions            create (stamped against the brief it was written to)
 *   GET    /film/music-sessions/:id                     the ScoreSession read model
 *   PUT    /film/music-sessions/:id                     update (lifecycle through the contract)
 *   DELETE /film/music-sessions/:id
 *   GET    /film/music-sessions/:id/brief               FREE: the compiled ScoreBrief with provenance and fingerprints
 *   GET    /film/music-sessions/:id/drift               FREE: what moved since the session was stamped; writes nothing
 *   POST   /film/music-sessions/:id/rebase              the explicit rebase
 *   POST   /film/music-sessions/:id/batch               ordered, atomic ops over the child kinds
 *   POST   /film/music-sessions/:id/stems               aligned stem import: one or several files, one operation, one transaction
 *   GET|POST /film/music-sessions/:id/:kind             list / create a child
 *   PUT|DELETE /film/music-sessions/:id/:kind/:childId  update / delete a child
 *
 * THIS ROUTE DECIDES NOTHING. A write is a validator's verdict from
 * lib/music-session.js, a read is `readScoreSession`, drift is `sessionDrift`
 * and the rebase is `stampSessionContext` from lib/music-context.js. A route
 * that re-derived any of those would be the second shape of one thing that
 * this epic exists to prevent, and MCP (MUS-005) will dispatch through this
 * handler rather than beside it, for the same reason.
 *
 * EVERY WRITE IS SCOPED. A session belongs to a project; a child belongs to a
 * session, directly or through its track. A row reached through another
 * session's URL is not found — not forbidden, not found — and a clip cannot
 * be placed on a track of another session. The batch runs in ONE transaction:
 * a failing third op leaves the first two unwritten and is named by index.
 */

const { db, generateId } = require('../db/database');
const contracts = require('../lib/music-session');
const context = require('../lib/music-context');
const stems = require('../lib/music-stems');

const { VALIDATORS, canTransition, toRow, fromRow, readScoreSession } = contracts;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * The child kinds, by URL segment. `owner` says which column ties a row to
 * its session: directly, or through the track it sits on. Held equal to the
 * schema's child tables by tests/music-sessions-routes.test.js.
 */
const CHILD_KINDS = Object.freeze({
    tracks: { table: 'film_music_tracks', owner: 'session' },
    clips: { table: 'film_music_clips', owner: 'track' },
    markers: { table: 'film_music_markers', owner: 'session' },
    'emotion-ranges': { table: 'film_music_emotion_ranges', owner: 'session' },
    automation: { table: 'film_music_automation', owner: 'track' },
});

/** Columns the caller never sets: identity, ownership, timestamps. */
const NEVER_FROM_BODY = new Set(['id', 'session_id', 'project_id', 'created_at', 'updated_at']);

const reply = (status, body) => ({ status, body });

// ── Ownership ──────────────────────────────────────────────────────────────

function sessionRow(id, query) {
    const row = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(id);
    if (!row) return null;
    if (query && query.project_id && row.project_id !== query.project_id) return null;
    return row;
}

function ownedTrack(sessionId, trackId) {
    if (!trackId) return null;
    return db.prepare('SELECT * FROM film_music_tracks WHERE id = ? AND session_id = ?').get(trackId, sessionId) || null;
}

function childRow(kind, sessionId, id) {
    const spec = CHILD_KINDS[kind];
    if (spec.owner === 'session') {
        return db.prepare(`SELECT * FROM ${spec.table} WHERE id = ? AND session_id = ?`).get(id, sessionId) || null;
    }
    return db.prepare(
        `SELECT c.* FROM ${spec.table} c JOIN film_music_tracks t ON t.id = c.track_id WHERE c.id = ? AND t.session_id = ?`)
        .get(id, sessionId) || null;
}

// ── Sessions ───────────────────────────────────────────────────────────────

function listSessions(projectId) {
    const rows = db.prepare('SELECT * FROM film_music_sessions WHERE project_id = ? ORDER BY created_at, id').all(projectId);
    return reply(200, {
        project_id: projectId,
        sessions: rows.map(r => {
            const s = fromRow('film_music_sessions', r);
            delete s.warnings;
            return { ...s, picture_kind: r.sequence_id ? 'sequence' : r.scene_id ? 'scene' : null };
        }),
    });
}

/** The picture unit a session is attached to must be the project's own. */
function pictureFor(projectId, body) {
    const b = body || {};
    if (b.sequence_id) {
        const seq = db.prepare('SELECT id FROM film_sequences WHERE id = ? AND project_id = ?').get(b.sequence_id, projectId);
        if (!seq) return { error: reply(404, { error: 'That sequence is not in this project' }) };
        return { sequence_id: seq.id, scene_id: null };
    }
    if (b.scene_id) {
        const sc = db.prepare('SELECT id FROM film_scenes WHERE id = ? AND project_id = ?').get(b.scene_id, projectId);
        if (!sc) return { error: reply(404, { error: 'That scene is not in this project' }) };
        return { sequence_id: null, scene_id: sc.id };
    }
    return { error: reply(400, { error: 'A session is attached to a picture sequence (sequence_id), or to a scene (scene_id) when the project has none' }) };
}

function createSession(projectId, body) {
    if (!db.prepare('SELECT 1 FROM film_projects WHERE id = ?').get(projectId)) return reply(404, { error: 'Project not found' });
    const picture = pictureFor(projectId, body);
    if (picture.error) return picture.error;
    const v = VALIDATORS.film_music_sessions({ ...(body || {}), ...picture });
    if (!v.ok) return reply(400, { error: 'Invalid session', errors: v.errors });
    const row = toRow('film_music_sessions', v.value);
    const id = generateId();
    const cols = Object.keys(row).filter(k => !NEVER_FROM_BODY.has(k));
    db.prepare(`INSERT INTO film_music_sessions (id, project_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
        .run(id, projectId, ...cols.map(k => row[k]));
    // Stamped with what it was written against, so drift is sayable from
    // the first read. The brief may carry warnings (no screenplay yet); they
    // travel with the answer rather than stopping the create.
    const stamped = context.stampSessionContext(db, id);
    const model = readScoreSession(db, id);
    return reply(201, { session: model.session, fingerprints: stamped.ok ? stamped.fingerprints : null, warnings: stamped.ok ? stamped.warnings : [stamped.error] });
}

function updateSession(session, body) {
    const b = body || {};
    const current = fromRow('film_music_sessions', session);
    delete current.warnings;
    // The lifecycle is the contract's, not this route's.
    if (b.status !== undefined && b.status !== session.status) {
        const t = canTransition('film_music_sessions.status', session.status, b.status);
        if (!t.ok) return reply(409, { error: t.error, code: 'LIFECYCLE' });
    }
    let picture = {};
    if (b.sequence_id !== undefined || b.scene_id !== undefined) {
        const p = pictureFor(session.project_id, { sequence_id: b.sequence_id, scene_id: b.scene_id });
        if (p.error) return p.error;
        picture = p;
    }
    const v = VALIDATORS.film_music_sessions({ ...current, ...b, ...picture });
    if (!v.ok) return reply(400, { error: 'Invalid session', errors: v.errors });
    const row = toRow('film_music_sessions', v.value);
    const cols = Object.keys(row).filter(k => !NEVER_FROM_BODY.has(k));
    db.prepare(`UPDATE film_music_sessions SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...cols.map(k => row[k]), session.id);
    if (b.status === 'approved' && session.status !== 'approved') {
        db.prepare("UPDATE film_music_sessions SET approved_at = datetime('now') WHERE id = ?").run(session.id);
    }
    return reply(200, { session: readScoreSession(db, session.id).session });
}

function deleteSession(session) {
    db.prepare('DELETE FROM film_music_sessions WHERE id = ?').run(session.id);
    return reply(200, { deleted: true, id: session.id });
}

// ── Children ───────────────────────────────────────────────────────────────

function createChild(kind, sessionId, body) {
    const spec = CHILD_KINDS[kind];
    const b = body || {};
    let owner;
    if (spec.owner === 'track') {
        owner = ownedTrack(sessionId, b.track_id);
        if (!owner) return reply(404, { error: `track_id must name a track in this session`, field: 'track_id' });
    }
    const v = VALIDATORS[spec.table](b);
    if (!v.ok) return reply(400, { error: `Invalid ${kind.replace(/s$/, '')}`, errors: v.errors });
    const row = toRow(spec.table, v.value);
    const cols = Object.keys(row).filter(k => !NEVER_FROM_BODY.has(k) && k !== 'track_id');
    const id = generateId();
    const ownerCol = spec.owner === 'session' ? 'session_id' : 'track_id';
    const ownerId = spec.owner === 'session' ? sessionId : owner.id;
    db.prepare(`INSERT INTO ${spec.table} (id, ${ownerCol}, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
        .run(id, ownerId, ...cols.map(k => row[k]));
    return reply(201, { id, kind, ...fromRow(spec.table, db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id)) });
}

function updateChild(kind, sessionId, id, body) {
    const spec = CHILD_KINDS[kind];
    const existing = childRow(kind, sessionId, id);
    if (!existing) return reply(404, { error: `No ${kind.replace(/s$/, '')} ${id} in this session` });
    const b = body || {};
    let trackId = existing.track_id;
    if (spec.owner === 'track' && b.track_id !== undefined && b.track_id !== existing.track_id) {
        const moved = ownedTrack(sessionId, b.track_id);
        if (!moved) return reply(404, { error: 'track_id must name a track in this session', field: 'track_id' });
        trackId = moved.id;
    }
    const current = fromRow(spec.table, existing);
    delete current.warnings;
    const v = VALIDATORS[spec.table]({ ...current, ...b });
    if (!v.ok) return reply(400, { error: `Invalid ${kind.replace(/s$/, '')}`, errors: v.errors });
    const row = toRow(spec.table, v.value);
    const cols = Object.keys(row).filter(k => !NEVER_FROM_BODY.has(k) && k !== 'track_id');
    const hasUpdatedAt = spec.table !== 'film_music_markers';
    db.prepare(`UPDATE ${spec.table} SET ${cols.map(k => `${k} = ?`).join(', ')}${spec.owner === 'track' ? ', track_id = ?' : ''}${hasUpdatedAt ? ", updated_at = datetime('now')" : ''} WHERE id = ?`)
        .run(...cols.map(k => row[k]), ...(spec.owner === 'track' ? [trackId] : []), id);
    return reply(200, { id, kind, ...fromRow(spec.table, db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id)) });
}

function deleteChild(kind, sessionId, id) {
    const spec = CHILD_KINDS[kind];
    const existing = childRow(kind, sessionId, id);
    if (!existing) return reply(404, { error: `No ${kind.replace(/s$/, '')} ${id} in this session` });
    db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(id);
    return reply(200, { deleted: true, id, kind });
}

function listChildren(kind, sessionId) {
    const spec = CHILD_KINDS[kind];
    const rows = spec.owner === 'session'
        ? db.prepare(`SELECT * FROM ${spec.table} WHERE session_id = ? ORDER BY created_at, id`).all(sessionId)
        : db.prepare(`SELECT c.* FROM ${spec.table} c JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ? ORDER BY c.created_at, c.id`).all(sessionId);
    return reply(200, { kind, items: rows.map(r => { const v = fromRow(spec.table, r); delete v.warnings; return v; }) });
}

// ── Batch ──────────────────────────────────────────────────────────────────

class BatchError extends Error {
    constructor(index, result) { super(result.body.error || 'batch failed'); this.index = index; this.result = result; }
}

/**
 * Ordered ops in one transaction. `$n` anywhere in an op's `id` or `data`
 * names the id produced by op n, so a track and its clips can be made
 * together. Any refusal rolls back everything and names the op by index.
 */
function runBatch(sessionId, body) {
    const ops = body && body.ops;
    if (!Array.isArray(ops) || !ops.length) return reply(400, { error: 'ops must be a non-empty list of { op, kind, id?, data? }' });
    if (ops.length > 200) return reply(400, { error: 'a batch is at most 200 ops' });

    const results = [];
    const resolve = (value, index) => {
        if (typeof value !== 'string' || !/^\$\d+$/.test(value)) return value;
        const n = Number(value.slice(1));
        if (!(n < index) || !results[n] || !results[n].id) {
            throw new BatchError(index, reply(400, { error: `op ${index} refers to ${value}, which is not an earlier result with an id` }));
        }
        return results[n].id;
    };

    const run = db.transaction(() => {
        ops.forEach((op, i) => {
            const o = op && typeof op === 'object' ? op : {};
            if (!CHILD_KINDS[o.kind]) throw new BatchError(i, reply(400, { error: `op ${i}: kind must be one of ${Object.keys(CHILD_KINDS).join(', ')}` }));
            const data = Object.fromEntries(Object.entries(o.data || {}).map(([k, v]) => [k, resolve(v, i)]));
            let r;
            if (o.op === 'create') r = createChild(o.kind, sessionId, data);
            else if (o.op === 'update') r = updateChild(o.kind, sessionId, resolve(o.id, i), data);
            else if (o.op === 'delete') r = deleteChild(o.kind, sessionId, resolve(o.id, i));
            else throw new BatchError(i, reply(400, { error: `op ${i}: op must be create, update or delete` }));
            if (r.status >= 400) throw new BatchError(i, r);
            results.push({ op: o.op, kind: o.kind, id: r.body.id, status: r.status });
        });
    });
    try {
        run();
    } catch (err) {
        if (err instanceof BatchError) {
            return reply(err.result.status, { ...err.result.body, failed_at: err.index, applied: 0, note: 'nothing was written; a batch is all or nothing' });
        }
        throw err;
    }
    return reply(200, { results, applied: results.length });
}

// ── Dispatch ───────────────────────────────────────────────────────────────

async function handleMusicSessions(req, res, urlParts, query) {
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'music-sessions') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method === 'GET') { const r = listSessions(urlParts[2]); return json(res, r.status, r.body); }
        if (req.method === 'POST') { const r = createSession(urlParts[2], req.body); return json(res, r.status, r.body); }
        return json(res, 405, { error: 'Method not allowed' });
    }

    if (urlParts[1] === 'music-sessions' && urlParts[2]) {
        const id = urlParts[2];
        if (!UUID_RE.test(id)) return json(res, 400, { error: 'Invalid session ID' });
        const session = sessionRow(id, query);
        if (!session) return json(res, 404, { error: 'Score session not found' });
        const sub = urlParts[3];

        if (!sub) {
            if (req.method === 'GET') return json(res, 200, readScoreSession(db, id));
            if (req.method === 'PUT') { const r = updateSession(session, req.body); return json(res, r.status, r.body); }
            if (req.method === 'DELETE') { const r = deleteSession(session); return json(res, r.status, r.body); }
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (sub === 'brief' && req.method === 'GET') {
            const out = context.compileScoreContext(db, { sessionId: id });
            return json(res, out.ok ? 200 : 409, out);
        }
        if (sub === 'drift' && req.method === 'GET') {
            const out = context.sessionDrift(db, id);
            return json(res, out.ok ? 200 : 409, out);
        }
        if (sub === 'rebase' && req.method === 'POST') {
            const out = context.stampSessionContext(db, id);
            return json(res, out.ok ? 200 : 409, out);
        }
        if (sub === 'batch' && req.method === 'POST') { const r = runBatch(id, req.body); return json(res, r.status, r.body); }
        if (sub === 'stems' && req.method === 'POST') {
            // The importer is the whole rule (lib/music-stems.js); the route
            // only turns its verdict into a status. A refusal wrote nothing.
            const out = await stems.importStems(db, id, req.body);
            return json(res, out.ok ? 201 : (out.status || 400), out);
        }

        if (CHILD_KINDS[sub]) {
            const childId = urlParts[4];
            if (!childId) {
                if (req.method === 'GET') { const r = listChildren(sub, id); return json(res, r.status, r.body); }
                if (req.method === 'POST') { const r = createChild(sub, id, req.body); return json(res, r.status, r.body); }
                return json(res, 405, { error: 'Method not allowed' });
            }
            if (!UUID_RE.test(childId)) return json(res, 400, { error: 'Invalid id' });
            if (req.method === 'PUT') { const r = updateChild(sub, id, childId, req.body); return json(res, r.status, r.body); }
            if (req.method === 'DELETE') { const r = deleteChild(sub, id, childId); return json(res, r.status, r.body); }
            return json(res, 405, { error: 'Method not allowed' });
        }
        return json(res, 404, { error: 'Not found' });
    }
    return false;
}

module.exports = { handleMusicSessions, CHILD_KINDS };
