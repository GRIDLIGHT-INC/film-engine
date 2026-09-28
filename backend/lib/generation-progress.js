/**
 * What is running, and how far along it is (PGN-001).
 *
 * film_generation_jobs is the one place the page reads to learn what is
 * running. The HTTP server and the MCP server are two processes, so progress
 * cannot live in memory: a job Claude started would never reach the page. It is
 * written to the row, and the page's live channel (routes/events.js) notices
 * another connection's write.
 *
 * Writes are THROTTLED to one a second per job. A provider can report many
 * times a second, and each write is a commit that wakes every open page; the
 * latest value is kept in memory and flushed when the job settles, so nothing
 * the provider said last is lost to the throttle.
 *
 * NEVER THROWS, on the rule generation-jobs.js already states: by the time any
 * of this runs a generation is under way or finished, and bookkeeping must not
 * be the thing that fails it.
 */

const THROTTLE_MS = 1000;
const PHASE_MAX = 80;

let clock = () => Date.now();
/** Test seam: the throttle is about time, and a test must not sleep for it. */
function _setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }

/** jobId -> { lastWrite, pending: {percent?, phase?} } */
const state = new Map();

function handle() {
    const { db, generateId } = require('../db/database');
    return { db, generateId };
}

function cleanPercent(v) {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(0, Math.min(100, n));
}

function cleanPhase(v) {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s ? s.slice(0, PHASE_MAX) : undefined;
}

/**
 * Open a row for a generation that has no provider handle yet — a synchronous
 * call, or an async one before the provider has accepted it. `collectable` is 0
 * until attachHandle() says a provider holds the job.
 */
function start(job) {
    try {
        const j = job || {};
        if (!j.provider) return null;
        const { db, generateId } = handle();
        const id = generateId();
        db.prepare(`INSERT INTO film_generation_jobs
            (id, project_id, shot_id, scene_id, provider, capability, request_id, meta,
             phase, started_at, heartbeat_at, collectable)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`)
            .run(id, j.projectId || null, j.shotId || null, j.sceneId || null,
                 String(j.provider), String(j.capability || 'unknown'), 'local:' + id,
                 JSON.stringify(j.meta || {}), cleanPhase(j.phase) || 'running');
        // lastWrite 0: the first report after start is written at once — the
        // insert says a job exists, not how far along it is.
        state.set(id, { lastWrite: 0, pending: null });
        return id;
    } catch (_) {
        return null;
    }
}

/**
 * The provider accepted the job: this row now IS its handle. If the same
 * (provider, request) was already recorded — a retry that re-submitted with the
 * same id — the existing row wins and this one is removed, because two rows for
 * one request would offer a collect twice.
 */
function attachHandle(jobId, requestId, meta) {
    try {
        if (!jobId || !requestId) return jobId || null;
        const { db } = handle();
        const row = db.prepare('SELECT provider, meta FROM film_generation_jobs WHERE id = ?').get(jobId);
        if (!row) return null;
        const clash = db.prepare(
            'SELECT id FROM film_generation_jobs WHERE provider = ? AND request_id = ? AND id != ?'
        ).get(row.provider, String(requestId), jobId);
        if (clash) {
            db.prepare('DELETE FROM film_generation_jobs WHERE id = ?').run(jobId);
            state.delete(jobId);
            return clash.id;
        }
        let merged = {};
        try { merged = JSON.parse(row.meta || '{}'); } catch (_) { merged = {}; }
        Object.assign(merged, meta || {});
        db.prepare(`UPDATE film_generation_jobs
            SET request_id = ?, collectable = 1, meta = ?, heartbeat_at = datetime('now')
            WHERE id = ?`).run(String(requestId), JSON.stringify(merged), jobId);
        return jobId;
    } catch (_) {
        return jobId || null;
    }
}

function write(jobId, p) {
    const { db } = handle();
    const sets = ["heartbeat_at = datetime('now')"];
    const args = [];
    if (p && p.percent !== undefined) { sets.push('percent = ?'); args.push(p.percent); }
    if (p && p.phase !== undefined) { sets.push('phase = ?'); args.push(p.phase); }
    args.push(jobId);
    db.prepare(`UPDATE film_generation_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

/**
 * Record progress. Returns true when it was written now, false when it was held
 * back by the throttle (and kept, to be written on the next report or flush).
 * A value that is not a number is ignored rather than written as 0: "unknown"
 * and "nothing done yet" are different answers.
 */
function report(jobId, p) {
    try {
        if (!jobId) return false;
        const next = {};
        const pct = cleanPercent(p && p.percent);
        const ph = cleanPhase(p && p.phase);
        if (pct !== undefined) next.percent = pct;
        if (ph !== undefined) next.phase = ph;
        const s = state.get(jobId) || { lastWrite: 0, pending: null };
        s.pending = Object.assign(s.pending || {}, next);
        const now = clock();
        if (s.lastWrite && now - s.lastWrite < THROTTLE_MS) { state.set(jobId, s); return false; }
        write(jobId, s.pending);
        s.lastWrite = now;
        s.pending = null;
        state.set(jobId, s);
        return true;
    } catch (_) {
        return false;
    }
}

/** Write whatever the throttle held back. Called when a job settles. */
function flush(jobId) {
    try {
        const s = state.get(jobId);
        if (s && s.pending && Object.keys(s.pending).length) write(jobId, s.pending);
    } catch (_) { /* never fails a generation */ }
    state.delete(jobId);
}

module.exports = { start, attachHandle, report, flush, THROTTLE_MS, _setClock };
