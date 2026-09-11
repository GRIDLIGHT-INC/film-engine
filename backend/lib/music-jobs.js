/**
 * ONE PARENT, ORDERED CHILDREN, AND A PARENT THAT CANNOT LIE.
 *
 * MUS-013. A generation or a separation is one PARENT operation with a CHILD
 * row per output (`group_id`, migration 107), in order (`seq`). Each child
 * carries the provider, model and provider job id that made it, its share of
 * the cost, the attempt it belongs to, the fingerprints of what it was made
 * from, its take number within its take group, and the clip it became — whose
 * own `take_status` IS the acceptance state, read rather than copied, so the
 * record cannot disagree with the arrangement.
 *
 * THE PARENT'S STATUS IS DERIVED. `deriveStatus` is the one rule: complete
 * only when there is at least one child, every child is complete and none the
 * parent expected is missing; running while any child is still open; failed
 * otherwise, with the reason naming the child. A stored status is a cache of
 * that answer — `readJob` reports the derived one, flags a stored status that
 * disagrees, and `rollup` repairs it. A failed child therefore cannot leave a
 * parent looking complete, however the row was written.
 *
 * RESUMABLE. A run this process owns is registered while it is in flight.
 * Polling a job nobody owns any more — the server restarted mid-generation —
 * reports it INTERRUPTED and fails its open children, rather than leaving a
 * row that says "running" for ever; `retryJob` then runs it again as the next
 * attempt, with `parent_id` naming the attempt it retries. Every music
 * provider wired today answers synchronously, so there is no provider job to
 * collect after a restart; a provider that returns a handle would be polled
 * here through the same record.
 */

const { generateId } = require('../db/database');
const { VALIDATORS, toRow, fromRow } = require('./music-session');

/** The columns that make an operation a child, as the migration adds them. */
const CHILD_COLUMNS = Object.freeze(['group_id', 'seq', 'attempt', 'take_number', 'output_clip_id', 'source_fingerprint', 'context_fingerprint']);
const OPEN = new Set(['planned', 'running']);
const BAD = new Set(['failed', 'cancelled']);
const JOB_KINDS = Object.freeze(['generate', 'separate']);

/** Runs this process owns right now. A job not in here cannot still be running. */
const LIVE = new Set();
const isLive = id => LIVE.has(id);
const release = id => { LIVE.delete(id); };

// ── The rule ───────────────────────────────────────────────────────────────

/**
 * The parent's status from its children. `expected` is how many outputs the
 * parent asked for (null when the provider decides, as a separation does);
 * `parentStored` lets a parent that has not produced its children yet read
 * as running rather than as having produced nothing.
 */
function deriveStatus(children, expected, parentStored) {
    const kids = (children || []).slice().sort((a, b) => a.seq - b.seq);
    const label = c => `child #${c.seq}${c.label ? ` (${c.label})` : ''}`;
    if (kids.some(c => OPEN.has(c.status))) return { status: 'running', reason: null };
    if (!kids.length) {
        if (OPEN.has(parentStored)) return { status: 'running', reason: null };
        return { status: 'failed', reason: 'no outputs: the operation finished without producing a single child' };
    }
    const failed = kids.filter(c => c.status === 'failed');
    if (failed.length) return { status: 'failed', reason: failed.map(c => `${label(c)} failed${c.error_message ? `: ${c.error_message}` : ''}`).join('; ') };
    const cancelled = kids.filter(c => c.status === 'cancelled');
    if (cancelled.length) return { status: 'failed', reason: cancelled.map(c => `${label(c)} was cancelled${c.error_message ? `: ${c.error_message}` : ''}`).join('; ') };
    if (expected != null && kids.length < expected) return { status: 'failed', reason: `missing outputs: ${expected} were expected and ${kids.length} came back` };
    return { status: 'complete', reason: null };
}

// ── Writing ────────────────────────────────────────────────────────────────

function insert(db, sessionId, fields) {
    const v = VALIDATORS.film_music_operations(fields);
    if (!v.ok) throw new Error(v.errors.map(e => e.message).join('; '));
    const r = toRow('film_music_operations', v.value);
    const id = generateId();
    db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, parent_id, source_asset_id, output_asset_id, provider, model, job_ref, params_json, cost_usd, error_message,
                    group_id, seq, attempt, take_number, output_clip_id, source_fingerprint, context_fingerprint, started_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(id, sessionId, r.kind, r.status, r.parent_id, r.source_asset_id, r.output_asset_id, r.provider, r.model, r.job_ref, r.params_json, r.cost_usd, r.error_message,
            r.group_id, r.seq, r.attempt, r.take_number, r.output_clip_id, r.source_fingerprint, r.context_fingerprint);
    return id;
}

/** Open a parent. `expected` (a count, or null) is stored so the rollup can tell a missing child. `live` registers it as owned by this process. */
function openJob(db, sessionId, f) {
    const o = f || {};
    const params = { ...(o.params || {}), expected: o.expected == null ? null : Number(o.expected) };
    const id = insert(db, sessionId, {
        kind: o.kind, status: 'running', parent_id: o.parent_id || null, source_asset_id: o.source_asset_id || null,
        provider: o.provider || '', model: o.model || '', params, attempt: o.attempt || 1,
        source_fingerprint: o.source_fingerprint || '', context_fingerprint: o.context_fingerprint || '',
    });
    if (o.live) LIVE.add(id);
    return id;
}

/** Add a child to a parent, inheriting its kind, session, provider, model, attempt and fingerprints unless given. */
function addChild(db, parentId, f) {
    const o = f || {};
    const p = db.prepare('SELECT * FROM film_music_operations WHERE id = ?').get(parentId);
    if (!p) throw new Error(`no parent operation ${parentId}`);
    return insert(db, p.session_id, {
        kind: p.kind, status: o.status || 'running', group_id: parentId, seq: o.seq || 0, attempt: p.attempt,
        provider: o.provider || p.provider, model: o.model || p.model, source_asset_id: o.source_asset_id || p.source_asset_id,
        source_fingerprint: o.source_fingerprint != null ? o.source_fingerprint : p.source_fingerprint,
        context_fingerprint: o.context_fingerprint != null ? o.context_fingerprint : p.context_fingerprint,
        params: { label: o.label || '', ...(o.params || {}) },
        take_number: o.take_number || null, output_asset_id: o.output_asset_id || null, output_clip_id: o.output_clip_id || null,
        job_ref: o.job_ref || '', cost_usd: o.cost_usd || 0, error_message: o.error || '',
    });
}

/** Settle a child: its outcome and whatever it produced. */
function settleChild(db, childId, f) {
    const o = f || {};
    const sets = ['status = ?', "completed_at = datetime('now')"];
    const vals = [o.status];
    const put = (col, v) => { if (v !== undefined) { sets.push(`${col} = ?`); vals.push(v); } };
    put('error_message', o.error);
    put('output_asset_id', o.output_asset_id);
    put('output_clip_id', o.output_clip_id);
    put('take_number', o.take_number);
    put('job_ref', o.job_ref);
    put('cost_usd', o.cost_usd);
    put('model', o.model);
    put('source_fingerprint', o.source_fingerprint);
    put('context_fingerprint', o.context_fingerprint);
    db.prepare(`UPDATE film_music_operations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, childId);
}

function childrenOf(db, parentId) {
    return db.prepare('SELECT * FROM film_music_operations WHERE group_id = ? ORDER BY seq, rowid').all(parentId).map(r => {
        const op = fromRow('film_music_operations', r);
        return { ...r, label: (op.params && op.params.label) || '' };
    });
}

function paramsOf(row) {
    try { return JSON.parse(row.params_json || '{}') || {}; } catch (_) { return {}; }
}

/** Write the derived status, the reason and the summed cost onto the parent. */
function rollup(db, parentId, extra) {
    const p = db.prepare('SELECT * FROM film_music_operations WHERE id = ?').get(parentId);
    if (!p) return null;
    const kids = childrenOf(db, parentId);
    const params = { ...paramsOf(p), ...((extra && extra.params) || {}) };
    const d = deriveStatus(kids, params.expected, p.status);
    const cost = kids.reduce((s, c) => s + (Number(c.cost_usd) || 0), 0);
    const done = d.status !== 'running';
    const outputs = kids.filter(c => c.status === 'complete' && c.output_asset_id);
    db.prepare(`UPDATE film_music_operations SET status = ?, error_message = ?, cost_usd = ?, params_json = ?, output_asset_id = ?,
                    job_ref = COALESCE(NULLIF(?, ''), job_ref), completed_at = CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE NULL END WHERE id = ?`)
        .run(d.status, d.reason || (extra && extra.error) || '', cost, JSON.stringify(params), outputs.length === 1 ? outputs[0].output_asset_id : p.output_asset_id,
            (extra && extra.job_ref) || '', done ? 1 : 0, parentId);
    return d;
}

/** Fail a parent that could not produce children at all (a refusal before any output). */
function failJob(db, parentId, error) {
    for (const c of childrenOf(db, parentId).filter(k => OPEN.has(k.status))) settleChild(db, c.id, { status: 'failed', error });
    db.prepare("UPDATE film_music_operations SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?").run(error, parentId);
    release(parentId);
}

// ── Reading ────────────────────────────────────────────────────────────────

const ACCEPTANCE = { selected: 'accepted', candidate: 'pending', rejected: 'rejected' };

function acceptanceOf(db, clipId) {
    if (!clipId) return null;
    const c = db.prepare('SELECT take_status FROM film_music_clips WHERE id = ?').get(clipId);
    return c ? (ACCEPTANCE[c.take_status] || 'pending') : 'removed';
}

function presentChild(db, c) {
    return {
        operation_id: c.id, seq: c.seq, label: c.label, status: c.status, provider: c.provider, model: c.model, job_ref: c.job_ref,
        cost_usd: Number(c.cost_usd) || 0, attempt: c.attempt, output_asset_id: c.output_asset_id, output_clip_id: c.output_clip_id,
        take_number: c.take_number, acceptance: acceptanceOf(db, c.output_clip_id),
        source_fingerprint: c.source_fingerprint, context_fingerprint: c.context_fingerprint, error_message: c.error_message,
        started_at: c.started_at, completed_at: c.completed_at,
    };
}

function presentJob(db, p) {
    const kids = childrenOf(db, p.id);
    const params = paramsOf(p);
    const d = deriveStatus(kids, params.expected, p.status);
    return {
        operation_id: p.id, session_id: p.session_id, kind: p.kind, workflow: params.workflow || (p.kind === 'separate' ? 'music_separate' : null),
        status: d.status, stored_status: p.status, consistent: d.status === p.status, reason: d.reason || p.error_message || null,
        live: isLive(p.id), attempt: p.attempt, parent_id: p.parent_id, provider: p.provider, model: p.model,
        expected: params.expected == null ? null : params.expected,
        // What it was asked, so a regeneration can ask again (MUS-014).
        input: params.input || null,
        cost_usd: kids.length ? kids.reduce((s, c) => s + (Number(c.cost_usd) || 0), 0) : Number(p.cost_usd) || 0,
        source_fingerprint: p.source_fingerprint, context_fingerprint: p.context_fingerprint,
        children: kids.map(c => presentChild(db, c)),
        started_at: p.started_at, completed_at: p.completed_at, created_at: p.created_at,
    };
}

function jobRow(db, sessionId, opId) {
    return db.prepare(`SELECT * FROM film_music_operations WHERE id = ? AND session_id = ? AND group_id IS NULL AND kind IN (${JOB_KINDS.map(() => '?').join(', ')})`).get(opId, sessionId, ...JOB_KINDS);
}

function readJob(db, sessionId, opId) {
    const p = jobRow(db, sessionId, opId);
    return p ? presentJob(db, p) : null;
}

function listJobs(db, sessionId) {
    return db.prepare(`SELECT * FROM film_music_operations WHERE session_id = ? AND group_id IS NULL AND kind IN (${JOB_KINDS.map(() => '?').join(', ')}) ORDER BY created_at DESC, rowid DESC`)
        .all(sessionId, ...JOB_KINDS).map(p => presentJob(db, p));
}

// ── Resuming ───────────────────────────────────────────────────────────────

/**
 * Where a job has got to, free. A job still running that this process does
 * not own was orphaned by a restart: its open children and itself are failed
 * as INTERRUPTED, so it reads as what it is and can be retried.
 */
function pollJob(db, sessionId, opId) {
    const p = jobRow(db, sessionId, opId);
    if (!p) return null;
    const job = presentJob(db, p);
    if (job.status === 'running' && !isLive(p.id)) {
        const why = 'interrupted: the process that was running it is gone, so it will not finish on its own; retry it';
        for (const c of childrenOf(db, p.id).filter(k => OPEN.has(k.status))) settleChild(db, c.id, { status: 'failed', error: why });
        if (!childrenOf(db, p.id).length) db.prepare("UPDATE film_music_operations SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?").run(why, p.id);
        else rollup(db, p.id);
        const after = presentJob(db, jobRow(db, sessionId, opId));
        return { ...after, reason: `${why}${after.reason && !after.reason.startsWith('interrupted') ? ` (${after.reason})` : ''}`, resumable: 'retry' };
    }
    if (job.status !== 'running' && !job.consistent) rollup(db, p.id);
    return { ...presentJob(db, jobRow(db, sessionId, opId)), resumable: job.status === 'failed' ? 'retry' : job.status === 'running' ? 'poll' : null };
}

/** A failed job run again as the next attempt, naming the one it retries. Spends. */
async function retryJob(db, sessionId, opId, opts) {
    const p = jobRow(db, sessionId, opId);
    if (!p) return { ok: false, status: 404, error: 'Job not found in this session' };
    const job = presentJob(db, p);
    if (job.status === 'running' && !isLive(p.id)) pollJob(db, sessionId, opId);
    const now = presentJob(db, jobRow(db, sessionId, opId));
    if (now.status !== 'failed') return { ok: false, status: 409, error: `that job is ${now.status}; only a failed job is retried` };
    const params = paramsOf(p);
    const o = { ...(opts || {}), parent_id: p.id, attempt: (p.attempt || 1) + 1 };
    if (p.kind === 'separate') {
        const sep = require('./music-separation');
        return sep.retrySeparation(db, sessionId, p.id, o);
    }
    if (!params.workflow || !params.input) return { ok: false, status: 409, error: 'this job predates retry lineage and did not record its input; plan and generate it again' };
    const gen = require('./music-generation');
    return gen.generate(db, sessionId, params.workflow, params.input, o);
}

module.exports = {
    CHILD_COLUMNS, JOB_KINDS, deriveStatus, openJob, addChild, settleChild, rollup, failJob, release, isLive,
    readJob, listJobs, pollJob, retryJob, childrenOf,
};
