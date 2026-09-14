/**
 * The score-session HTTP API.
 *
 *   GET    /film/projects/:id/music-sessions            list
 *   POST   /film/projects/:id/music-sessions            create (stamped against the brief it was written to)
 *   GET    /film/music-sessions/vocabulary              FREE: every enum, range and lifecycle table the validators enforce
 *   GET    /film/music-sessions/health                  FREE: every operation area by status, what is stalled or failed and how to recover, the encoder and each DAW — no secret, no path (MUS-023)
 *   GET    /film/music-sessions/:id                     the ScoreSession read model
 *   PUT    /film/music-sessions/:id                     update (lifecycle through the contract)
 *   DELETE /film/music-sessions/:id
 *   GET    /film/music-sessions/:id/brief               FREE: the compiled ScoreBrief with provenance and fingerprints
 *   GET    /film/music-sessions/:id/drift               FREE: what moved since the session was stamped; writes nothing
 *   POST   /film/music-sessions/:id/rebase              the explicit rebase
 *   POST   /film/music-sessions/:id/batch               ordered, atomic ops over the child kinds
 *   POST   /film/music-sessions/:id/stems               aligned stem import: one or several files, one operation, one transaction
 *   GET    /film/music-sessions/:id/bounce/plan         FREE: what a bounce would render, what it would leave out and why, the version it would become
 *   POST   /film/music-sessions/:id/bounce              the deterministic bounce: master + delivery stems at 48 kHz, registered; 409 when unchanged
 *   GET    /film/music-sessions/:id/bounces[/:opId]     every bounce of the session with its outputs, newest version first
 *   GET    /film/music-sessions/:id/emotion/brief        FREE: the brief, the accepted arc, the pending proposals, the schema, the rules — for the model to reason from
 *   GET|POST /film/music-sessions/:id/emotion/proposals  list proposals / store one (proposed, never accepted)
 *   POST   /film/music-sessions/:id/emotion/proposals/:pid/accept  the explicit acceptance, per range, with edits
 *   GET    /film/music-sessions/:id/separations/plan     FREE: provider, variation, expected stems, placement and cost hint for separating a clip
 *   POST   /film/music-sessions/:id/separations          separate a clip into 2 or 6 stems (SPENDS); answers at once with a running operation
 *   GET    /film/music-sessions/:id/separations[/:opId]  every separation of the session, or one, with its stems or its failure
 *   POST   /film/music-sessions/:id/separations/:opId/retry  a failed separation again, as a new operation naming the one it retries
 *   POST   /film/music-sessions/:id/generate/plan        FREE: compose, parts, reference, video or inpaint — provider, length, outputs, context, cost, take behaviour
 *   POST   /film/music-sessions/:id/generate             generate (SPENDS): new assets and new clips as candidate takes, nothing replaced
 *   GET    /film/music-sessions/:id/generations[/:opId]  every generation of the session, with its outputs or its failure
 *   GET    /film/music-sessions/:id/jobs[/:opId]         FREE: every generation and separation as a parent with its ordered children
 *   POST   /film/music-sessions/:id/jobs/:opId/poll      FREE: where a job has got to; one whose process is gone is reported interrupted
 *   POST   /film/music-sessions/:id/jobs/:opId/retry     a failed job again as the next attempt (SPENDS)
 *   POST   /film/music-sessions/:id/package              FREE (a local render at most): the portable score package — manifest, aligned BWF stems, master, picture
 *   GET    /film/music-sessions/:id/packages             every package built from the session
 *   POST   /film/projects/:id/music-packages/import      validate (validate_only) or import a package; into session_id as candidate takes, or a new session
 *   POST   /film/music-sessions/:id/approve             select a bounce as the approved mix (refused when stale); POST …/unapprove takes it back (MUS-020)
 *   GET    /film/music-sessions/:id/lineage             FREE: every clip and the mix walked to their sources — origin, status, owner, provider, hash — and every issue (MUS-022)
 *   GET    /film/projects/:id/music-score                FREE: the approved mixes the film consumes, their offsets, and every session not consumed and why
 *   GET    /film/daw/:adapter/{status,session}           FREE: is the DAW reachable and compatible; the DAW session as it is (MUS-018)
 *   GET    /film/music-sessions/:id/daw/:adapter/push/plan   FREE: what a push would create, update, leave alone, and every conflict
 *   POST   /film/music-sessions/:id/daw/:adapter/push    carry out a fingerprinted push plan (changes the DAW; idempotent)
 *   GET    /film/music-sessions/:id/daw/:adapter/pull/plan   FREE: what the DAW has rendered that could come back
 *   POST   /film/music-sessions/:id/daw/:adapter/pull    bring a render back, validated by hash and alignment, as candidate takes
 *   POST   /film/music-sessions/:id/daw/:adapter/transport   play / stop / locate, only when a person asked (supervised)
 *   GET    /film/music-sessions/:id/daw/:adapter/audit   FREE: every DAW push, pull and transport on the session, needing no connection (MUS-019)
 *   POST   /film/music-sessions/:id/tracks/:trackId/render  FREE: play a lane's own notes through its own instrument, landing the audio as a take on it
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

const fs = require('fs');
const { db, generateId } = require('../db/database');
const contracts = require('../lib/music-session');
const context = require('../lib/music-context');
const stems = require('../lib/music-stems');
const renderer = require('../lib/music-renderer');
const emotion = require('../lib/music-emotion');
const separation = require('../lib/music-separation');
const generation = require('../lib/music-generation');
const musicJobs = require('../lib/music-jobs');
const musicPackage = require('../lib/music-package');
const dawDriver = require('../lib/daw-adapter');
const dawRegistry = require('../lib/daw-registry');
const musicApproval = require('../lib/music-approval');
const musicHealth = require('../lib/music-health');

const { VALIDATORS, canTransition, toRow, fromRow, readScoreSession } = contracts;

/**
 * A refusal a person can act on: the page shows `error` and nothing else, so
 * the field and the rule go in it. "Invalid clip" alone reads as saving being
 * broken; "gain_db must be between -96 and 24 dB" says what to change.
 */
const explain = errors => (errors || []).map(e => (e && typeof e === 'object' ? e.message || e.field : String(e))).join('; ');

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
// approved_mix_asset_id and approved_at are written by the approval (lib/music-approval.js), never by a body.
const NEVER_FROM_BODY = new Set(['id', 'session_id', 'project_id', 'created_at', 'updated_at', 'approved_mix_asset_id', 'approved_at']);

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
    if (!v.ok) return reply(400, { error: `Invalid session: ${explain(v.errors)}`, errors: v.errors });
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
        // Approval selects a mix; a status write cannot (MUS-020).
        if (b.status === 'approved') return reply(409, { code: 'USE_APPROVE', error: 'a session is approved by selecting a bounce: POST /film/music-sessions/:id/approve (music_session_approve), which refuses a bounce made before the session last changed' });
    }
    let picture = {};
    if (b.sequence_id !== undefined || b.scene_id !== undefined) {
        const p = pictureFor(session.project_id, { sequence_id: b.sequence_id, scene_id: b.scene_id });
        if (p.error) return p.error;
        picture = p;
    }
    const v = VALIDATORS.film_music_sessions({ ...current, ...b, ...picture });
    if (!v.ok) return reply(400, { error: `Invalid session: ${explain(v.errors)}`, errors: v.errors });
    const row = toRow('film_music_sessions', v.value);
    const cols = Object.keys(row).filter(k => !NEVER_FROM_BODY.has(k));
    db.prepare(`UPDATE film_music_sessions SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...cols.map(k => row[k]), session.id);
    return reply(200, { session: readScoreSession(db, session.id).session });
}

function deleteSession(session) {
    db.prepare('DELETE FROM film_music_sessions WHERE id = ?').run(session.id);
    return reply(200, { deleted: true, id: session.id });
}

// ── Children ───────────────────────────────────────────────────────────────

/**
 * PLAY A TRACK: its own notes, through its own instrument, into its own lane.
 *
 * "The score should be where this all happens." The session is the place with
 * the tracks, the ruler and the mixer, so this is where composing happens: a
 * track carries notes and an instrument, and rendering lands the audio as a
 * take on that track — a candidate where something is already there, so what
 * is playing keeps playing until somebody chooses otherwise (MUS-013).
 *
 * Free: it runs on this machine and no provider is billed.
 */
async function renderTrack(sessionId, trackId) {
    const session = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!session) return reply(404, { error: 'no such session' });
    const track = childRow('tracks', sessionId, trackId);
    if (!track) return reply(404, { error: 'no such track in this session' });

    let notes = null;
    try { notes = JSON.parse(track.notes_json || 'null'); } catch (_) { notes = null; }
    if (!notes || !Array.isArray(notes.notes) || !notes.notes.length) {
        return reply(412, {
            code: 'PRECONDITION', error: `"${track.name || 'this track'}" has no notes to play`,
            fix: 'write them with music_track_update — { notes: { program, notes: [{ start_ms, duration_ms, pitch, velocity }] } }',
        });
    }
    if (!track.instrument_id) {
        const instruments = require('../lib/instruments');
        return reply(400, {
            error: `"${track.name || 'this track'}" has no instrument to play it`,
            fix: 'set instrument_id on the track',
            instruments: instruments.listInstruments({ limit: 20 }).map(i => ({ id: i.id, name: i.name, library: i.library })),
            find: 'GET /film/instruments/catalogue?q= — your own sounds, read live from Kontakt',
        });
    }

    const instruments = require('../lib/instruments');
    const instrument = instruments.getInstrument(track.instrument_id);
    if (!instrument) return reply(400, { error: 'that instrument is not in the library any more' });
    if (!instrument.available) {
        return reply(409, { error: `${instrument.name} cannot play right now: its plugin or its patch is missing`, plugin: instrument.plugin });
    }
    const state = instruments.stateOf(instrument.id);
    if (!state.ok) return reply(409, { error: state.reason, instrument: instrument.name });

    // The session's own length and tempo: a part is written against the picture.
    const model = readScoreSession(db, sessionId);
    const lastNote = Math.max(...notes.notes.map(n => n.start_ms + n.duration_ms));
    const lengthMs = Math.max(Number(model.duration_ms) || 0, lastNote);
    const tempo = (model.session.tempo_map || [])[0];
    const midi = require('../lib/midi');
    const checked = midi.validateScore({
        plan: {
            tempo_bpm: (tempo && tempo.tempo_bpm) || 120,
            meter: (tempo && tempo.meter) || '4/4',
            length_ms: lengthMs,
        },
        parts: [{ name: track.name || 'track', program: notes.program, drums: notes.drums, notes: notes.notes }],
    }, { length_ms: lengthMs });
    if (!checked.ok) return reply(400, { error: checked.errors[0], errors: checked.errors });

    const { saveFile, getFilePath, getFileUrl, ensureDir } = require('../lib/file-storage');
    const host = require('../lib/instrument-host');
    ensureDir(session.project_id, 'music');
    const fileName = `track_${trackId.slice(0, 8)}_${Date.now().toString(36)}.wav`;
    const outPath = getFilePath(session.project_id, 'music', fileName);
    const rendered = await host.renderPart({
        plugin: instrument.plugin, state: state.state, midi: midi.writeSmf(checked.score),
        lengthMs, outPath,
    });
    if (!rendered.ok) {
        const status = ['config', 'unreachable'].includes(rendered.stage) ? 503
            : rendered.stage === 'silence' ? 422 : 502;
        return reply(status, {
            error: rendered.reason, stage: rendered.stage, fix: rendered.fix,
            instrument: instrument.name, guide: 'docs/instrument-sidecar.md',
        });
    }

    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, scene_id, asset_type, file_path, file_name, format, mime_type,
         size_bytes, duration_ms, version, provider, license_source, license_status, metadata)
        VALUES (?, ?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', ?, ?, 1, 'instrument', '', 'unknown', ?)`)
        .run(assetId, session.project_id, session.scene_id || null, outPath, fileName,
            fs.statSync(outPath).size, rendered.duration_ms, JSON.stringify({
                kind: 'instrument_render', session_id: sessionId, track_id: trackId,
                instrument_id: instrument.id, instrument: instrument.name, library: instrument.library,
                source_ref: instrument.source_ref, source_file: instrument.source_file,
                levels: rendered.levels,
            }));

    // A take, not a replacement: what is playing keeps playing until chosen.
    const already = db.prepare('SELECT COUNT(*) AS n FROM film_music_clips WHERE track_id = ?').get(trackId).n;
    const clip = createChild('clips', sessionId, {
        track_id: trackId, asset_id: assetId, name: instrument.name,
        start_ms: 0, duration_ms: rendered.duration_ms, source_offset_ms: 0,
        source_kind: 'generated',
        /*
         * ONE LANE IS ONE PART, SO ITS TAKES ARE ONE GROUP.
         *
         * Without a group `mwHeard` falls back to "is it selected", so a
         * candidate is never played AND the take switcher reports "no group" —
         * the take is landed and unreachable, which from the page is
         * indistinguishable from the render having done nothing.
         */
        take_group: trackId,
        take_status: already ? 'candidate' : 'selected',
    });
    if (clip.status >= 400) return clip;

    return reply(201, {
        clip: clip.body, asset_id: assetId, track: track.name,
        instrument: instrument.name, library: instrument.library || null,
        duration_ms: rendered.duration_ms, levels: rendered.levels,
        url: getFileUrl('music', session.project_id, fileName, assetId),
        spends: 'nothing',
        note: already
            ? `Played by ${instrument.name} as a new take. The take that was there still plays until you choose this one.`
            : `Played by ${instrument.name}. It is on the track now.`,
    });
}

function createChild(kind, sessionId, body) {
    const spec = CHILD_KINDS[kind];
    const b = body || {};
    let owner;
    if (spec.owner === 'track') {
        owner = ownedTrack(sessionId, b.track_id);
        if (!owner) return reply(404, { error: `track_id must name a track in this session`, field: 'track_id' });
    }
    const v = VALIDATORS[spec.table](b);
    if (!v.ok) return reply(400, { error: `Invalid ${kind.replace(/s$/, '')}: ${explain(v.errors)}`, errors: v.errors });
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
    if (!v.ok) return reply(400, { error: `Invalid ${kind.replace(/s$/, '')}: ${explain(v.errors)}`, errors: v.errors });
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

    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'music-score' && req.method === 'GET') {
        // Which approved mixes the film consumes, where each sits, and every session that is not consumed and why.
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        const rep = musicApproval.approvedScores(db, urlParts[2]);
        const tl = require('./timeline').loadTimeline(urlParts[2]);
        return json(res, 200, { project_id: urlParts[2], scores: rep.scores, placements: (tl && tl.score && tl.score.placements) || [], reports: (tl && tl.score && tl.score.reports) || rep.reports });
    }
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'music-packages') {
        // The portable score package (lib/music-package.js). `import` carries
        // a file, so it takes the file ceiling; validate_only answers the
        // verdict and writes nothing.
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (urlParts[4] !== 'import' || req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
        const b = req.body || {};
        const got = musicPackage.packageBytes(db, b);
        if (got.error) return json(res, got.error.status || 400, got.error);
        if (b.validate_only === true || b.validate_only === 'true') {
            const v = musicPackage.validatePackage(got.bytes);
            return json(res, 200, { ok: v.ok, errors: v.errors, warnings: v.warnings, manifest: v.manifest ? { format: v.manifest.format, version: v.manifest.version, package: v.manifest.package, session: v.manifest.session, stems: v.manifest.stems, timing: v.manifest.timing } : null });
        }
        const out = musicPackage.importPackage(db, urlParts[2], got.bytes, { session_id: b.session_id || null });
        return json(res, out.ok ? 201 : (out.status || 400), out);
    }

    if (urlParts[1] === 'music-sessions' && urlParts[2] === 'vocabulary') {
        // The page's pickers are filled from HERE, on the card-vocabulary
        // precedent: a page holding its own copy offers values the route then
        // refuses, and the refusal reads as saving being broken.
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return json(res, 200, {
            vocabulary: contracts.VOCABULARY, ranges: contracts.RANGES,
            automation_ranges: contracts.AUTOMATION_RANGES, transitions: contracts.TRANSITIONS,
        });
    }

    if (urlParts[1] === 'music-sessions' && urlParts[2] === 'health') {
        // What the workstation is doing and what is stuck, for nothing. The
        // report itself redacts; the route only scopes it (MUS-023).
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        const q = query || {};
        for (const k of ['project_id', 'session_id']) if (q[k] && !UUID_RE.test(q[k])) return json(res, 400, { error: `Invalid ${k}` });
        const probe = q.probe === true || q.probe === 'true' || q.probe === '1';
        return json(res, 200, await musicHealth.musicHealth(db, { project_id: q.project_id || null, session_id: q.session_id || null, probe }));
    }

    if (urlParts[1] === 'daw' && urlParts[2]) {
        // The DAW contract's two reads that belong to no session (MUS-018).
        // The adapter comes from lib/daw-registry.js; the rules from the driver.
        const got = dawRegistry.adapterFor(urlParts[2]);
        if (!got.ok) return json(res, got.status, { error: got.error, guide: got.guide });
        const leaf = urlParts[3];
        if (leaf === 'status' && req.method === 'GET') { const out = await dawDriver.status(got.adapter); return json(res, out.ok ? 200 : 502, out); }
        if (leaf === 'session' && req.method === 'GET') { const out = await dawDriver.readSession(got.adapter); return json(res, out.ok ? 200 : 502, out); }
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
        if (sub === 'lineage' && req.method === 'GET') {
            // Every clip and the mix, walked to their sources, with the policy in force (MUS-022).
            const out = require('../lib/music-rights').scoreLineage(db, id);
            return json(res, out.ok ? 200 : (out.status || 400), out);
        }
        if ((sub === 'approve' || sub === 'unapprove') && req.method === 'POST') {
            // The explicit approval (lib/music-approval.js): select a bounce, or take it back.
            const b = req.body || {};
            const out = sub === 'approve'
                ? musicApproval.approveMix(db, id, { bounce_operation_id: b.bounce_operation_id, ignore_stale: b.ignore_stale === true, ignore_rights: b.ignore_rights === true })
                : musicApproval.revokeApproval(db, id);
            if (!out.ok) return json(res, out.status || 409, out);
            return json(res, 200, { ...out, session: readScoreSession(db, id).session });
        }
        if (sub === 'bounce') {
            // The renderer is the whole rule (lib/music-renderer.js); the route
            // turns a verdict into a status. A plan writes nothing.
            if (urlParts[4] === 'plan' && req.method === 'GET') {
                const plan = renderer.planBounce(db, id, { stems: query && query.stems });
                return json(res, plan.ok ? 200 : (plan.status || 409), plan);
            }
            if (!urlParts[4] && req.method === 'POST') {
                const b = req.body || {};
                const out = await renderer.runBounce(db, id, { stems: b.stems, force: b.force === true || b.force === 1 || b.force === 'true' });
                return json(res, out.ok ? 201 : (out.status || 400), out);
            }
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (sub === 'emotion') {
            // The proposal flow (lib/music-emotion.js). No route here calls a
            // model: the brief goes OUT to the connected agent and the proposal
            // comes BACK as rows that stay proposed until a person accepts.
            const leaf = urlParts[4], pid = urlParts[5], verb = urlParts[6];
            if (leaf === 'brief' && !pid && req.method === 'GET') { const out = emotion.emotionBrief(db, id); return json(res, out.ok ? 200 : (out.status || 400), out); }
            if (leaf === 'proposals' && !pid && req.method === 'GET') return json(res, 200, { session_id: id, proposals: emotion.listProposals(db, id) });
            if (leaf === 'proposals' && !pid && req.method === 'POST') { const out = emotion.propose(db, id, req.body); return json(res, out.ok ? 201 : (out.status || 400), out); }
            if (leaf === 'proposals' && pid && verb === 'accept' && req.method === 'POST') {
                if (!UUID_RE.test(pid)) return json(res, 400, { error: 'Invalid proposal id' });
                const out = emotion.accept(db, id, pid, req.body); return json(res, out.ok ? 200 : (out.status || 400), out);
            }
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (sub === 'bounces' && req.method === 'GET') {
            if (!urlParts[4]) return json(res, 200, { session_id: id, bounces: renderer.listBounces(db, id) });
            if (!UUID_RE.test(urlParts[4])) return json(res, 400, { error: 'Invalid id' });
            const one = renderer.getBounce(db, id, urlParts[4]);
            return one ? json(res, 200, one) : json(res, 404, { error: 'Bounce not found' });
        }
        if (sub === 'package' && req.method === 'POST') {
            const out = await musicPackage.buildPackage(db, id, { include_picture: (req.body || {}).include_picture !== false });
            if (!out.ok) return json(res, out.status || 400, out);
            const { file_path, manifest, ...rest } = out;
            return json(res, out.reused ? 200 : 201, { ...rest, manifest: { format: manifest.format, version: manifest.version, package: manifest.package, stems: manifest.stems, picture: manifest.picture, timing: manifest.timing } });
        }
        if (sub === 'packages' && req.method === 'GET') return json(res, 200, { session_id: id, packages: musicPackage.listPackages(db, id) });
        if (sub === 'daw' && urlParts[4] && urlParts[5] === 'audit' && req.method === 'GET') {
            // History needs no connection: it is what Film Engine recorded (MUS-019).
            if (!dawRegistry.ADAPTERS[urlParts[4]]) return json(res, 404, { error: `no DAW adapter '${urlParts[4]}'` });
            return json(res, 200, { session_id: id, adapter_id: urlParts[4], audit: dawDriver.listAudit(db, id).filter(r => r.adapter_id === urlParts[4]) });
        }
        if (sub === 'daw' && urlParts[4]) {
            // Push, pull and transport through the MUS-016 driver (MUS-018): the
            // driver holds every adapter to acknowledgement, idempotency, the
            // ownership boundary, conflicts, hash-validated pulls and supervision.
            const got = dawRegistry.adapterFor(urlParts[4]);
            if (!got.ok) return json(res, got.status, { error: got.error, guide: got.guide });
            const adapter = got.adapter, leaf = urlParts[5], plan = urlParts[6] === 'plan', b = req.body || {};
            const reply = (out, okStatus) => json(res, out.ok ? (okStatus || 200) : (out.status || 502), out);
            if (leaf === 'push' && plan && req.method === 'GET') return reply(await dawDriver.planPush(db, id, adapter));
            if (leaf === 'push' && !plan && req.method === 'POST') {
                return reply(await dawDriver.push(db, id, adapter, { plan_fingerprint: b.plan_fingerprint, resolutions: b.resolutions, idempotency_key: b.idempotency_key }));
            }
            if (leaf === 'pull' && plan && req.method === 'GET') {
                const out = await dawDriver.planPull(db, id, adapter);
                if (out.ok && adapter.pullReason) out.unavailable = adapter.pullReason;
                return reply(out);
            }
            if (leaf === 'pull' && !plan && req.method === 'POST') {
                const out = await dawDriver.pull(db, id, adapter, { item_id: b.item_id, idempotency_key: b.idempotency_key });
                if (!out.ok && adapter.pullReason && out.status === 404) out.error = `${out.error}. ${adapter.pullReason}`;
                return reply(out);
            }
            if (leaf === 'transport' && req.method === 'POST') {
                return reply(await dawDriver.transport(db, id, adapter, { command: b.command, position_ms: b.position_ms, supervised: b.supervised === true }));
            }
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (sub === 'jobs') {
            // Grouped jobs (lib/music-jobs.js): a parent's status is derived
            // from its children, so what is read here cannot claim a finished
            // job while one of its outputs failed.
            const opId = urlParts[4], verb = urlParts[5];
            if (!opId && req.method === 'GET') return json(res, 200, { session_id: id, jobs: musicJobs.listJobs(db, id) });
            if (!opId) return json(res, 405, { error: 'Method not allowed' });
            if (!UUID_RE.test(opId)) return json(res, 400, { error: 'Invalid job id' });
            if (!verb && req.method === 'GET') { const one = musicJobs.readJob(db, id, opId); return one ? json(res, 200, one) : json(res, 404, { error: 'Job not found' }); }
            if (verb === 'poll' && req.method === 'POST') { const one = musicJobs.pollJob(db, id, opId); return one ? json(res, 200, one) : json(res, 404, { error: 'Job not found' }); }
            if (verb === 'retry' && req.method === 'POST') {
                const b = req.body || {};
                const out = await musicJobs.retryJob(db, id, opId, { wait: b.wait === true || b.wait === 'true' });
                if (typeof out.status === 'number') return json(res, out.status, generation.publicPlan(out));
                if (out.operation_id) return json(res, out.ok ? 202 : 502, { ...(musicJobs.readJob(db, id, out.operation_id) || {}), error: out.error });
                return json(res, 502, out);
            }
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (sub === 'generate') {
            // The generation is the whole rule (lib/music-generation.js). The
            // plan is a POST only because its input is structured (a range, a
            // list of parts); it writes nothing and spends nothing.
            const b = req.body || {};
            const { workflow, ...input } = b;
            if (urlParts[4] === 'plan' && req.method === 'POST') {
                const plan = generation.planGeneration(db, id, workflow, input);
                return json(res, plan.ok ? 200 : (plan.status || 400), generation.publicPlan(plan));
            }
            if (!urlParts[4] && req.method === 'POST') {
                const out = await generation.generate(db, id, workflow, input);
                if (out.ok) return json(res, 201, out);
                return json(res, typeof out.status === 'number' ? out.status : (out.http_status || 502), generation.publicPlan(out));
            }
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (sub === 'generations' && req.method === 'GET') {
            if (!urlParts[4]) return json(res, 200, { session_id: id, generations: generation.listGenerations(db, id) });
            if (!UUID_RE.test(urlParts[4])) return json(res, 400, { error: 'Invalid generation id' });
            const one = generation.getGeneration(db, id, urlParts[4]);
            return one ? json(res, 200, one) : json(res, 404, { error: 'Generation not found' });
        }
        if (sub === 'separations') {
            // The separation is the whole rule (lib/music-separation.js). A
            // start answers at once with a RUNNING operation — the provider
            // takes as long as it takes — unless the caller asked to wait.
            const leaf = urlParts[4], verb = urlParts[5];
            const wait = (v) => v === true || v === 1 || v === 'true';
            if (leaf === 'plan' && req.method === 'GET') {
                const plan = separation.planSeparation(db, id, { clip_id: query && query.clip_id, stems: query && query.stems, output_format: query && query.output_format });
                return json(res, plan.ok ? 200 : (plan.status || 400), plan);
            }
            if (!leaf && req.method === 'GET') return json(res, 200, { session_id: id, separations: separation.listSeparations(db, id) });
            if (!leaf && req.method === 'POST') {
                const b = req.body || {};
                const out = await separation.startSeparation(db, id, { clip_id: b.clip_id, stems: b.stems, output_format: b.output_format }, { wait: wait(b.wait) });
                if (typeof out.status === 'number') return json(res, out.status, out);
                const one = separation.getSeparation(db, id, out.operation_id);
                return json(res, 202, { ...one, warnings: out.warnings || (one && one.warnings) || [] });
            }
            if (leaf && !UUID_RE.test(leaf)) return json(res, 400, { error: 'Invalid separation id' });
            if (leaf && !verb && req.method === 'GET') {
                const one = separation.getSeparation(db, id, leaf);
                return one ? json(res, 200, one) : json(res, 404, { error: 'Separation not found' });
            }
            if (leaf && verb === 'retry' && req.method === 'POST') {
                const out = await separation.retrySeparation(db, id, leaf, { wait: wait((req.body || {}).wait) });
                if (typeof out.status === 'number') return json(res, out.status, out);
                return json(res, 202, separation.getSeparation(db, id, out.operation_id));
            }
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (sub === 'stems' && req.method === 'POST') {
            // The importer is the whole rule (lib/music-stems.js); the route
            // only turns its verdict into a status. A refusal wrote nothing.
            const out = await stems.importStems(db, id, req.body);
            return json(res, out.ok ? 201 : (out.status || 400), out);
        }

        if (sub === 'tracks' && urlParts[4] && urlParts[5] === 'render' && req.method === 'POST') {
            if (!UUID_RE.test(urlParts[4])) return json(res, 400, { error: 'Invalid id' });
            const r = await renderTrack(id, urlParts[4]);
            return json(res, r.status, r.body);
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
