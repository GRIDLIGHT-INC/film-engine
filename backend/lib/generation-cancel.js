/**
 * Cancel, stated honestly (PGN-012).
 *
 * A job is cancelled only where its provider really can be told to stop —
 * the adapter declares `cancel: 'provider'` and implements cancelJob(handle).
 * Everywhere else the honest offer is "stop waiting": the job is no longer
 * treated as running, it stays collectable, and the answer says the provider
 * may still finish it and bill for it. A synchronous call has no handle and
 * nothing to cancel.
 *
 * A batch run is cancelled by marking its run row; the runner re-reads it
 * before every step, so a cancel from any process stops it there.
 */

function db() { return require('../db/database').db; }

async function cancelJob(jobId) {
    const row = jobId ? db().prepare('SELECT * FROM film_generation_jobs WHERE id = ?').get(jobId) : null;
    if (!row) return { ok: false, status: 404, error: `no generation job ${jobId}` };
    if (row.status !== 'pending') return { ok: false, status: 409, error: `this job already ${row.status === 'completed' ? 'finished' : 'failed'}; there is nothing to cancel` };
    if (!Number(row.collectable)) {
        return { ok: false, status: 409, error: 'this call has no provider job to stop; it finishes on its own, so there is nothing to cancel' };
    }
    const adapter = require('./providers').get(row.provider);
    if (adapter && adapter.cancel === 'provider' && typeof adapter.cancelJob === 'function') {
        const r = await adapter.cancelJob(row.request_id);
        if (!r || !r.ok) return { ok: false, status: (r && r.status) || 502, error: (r && r.error) || `${row.provider} did not confirm the cancel` };
        require('./generation-jobs').fail(row.id, 'cancelled by the director');
        return { ok: true, mode: 'provider', cancelled: true, job_id: row.id,
            message: `${row.provider} cancelled the job.` };
    }
    let meta = {};
    try { meta = JSON.parse(row.meta || '{}') || {}; } catch (_) { meta = {}; }
    meta.stopped_waiting = 1;
    db().prepare("UPDATE film_generation_jobs SET meta = ?, phase = 'stopped waiting' WHERE id = ?").run(JSON.stringify(meta), row.id);
    return { ok: true, mode: 'stop_waiting', cancelled: false, job_id: row.id,
        warning: `${row.provider} cannot be told to stop a job once it has started. It may still finish and bill; it stays under "Waiting to be collected", so nothing it makes is lost.` };
}

function cancelRun(projectId, runId) {
    const row = runId ? db().prepare('SELECT id, status FROM film_pipeline_runs WHERE id = ? AND project_id = ?').get(runId, projectId) : null;
    if (!row) return { ok: false, status: 404, error: 'No such run' };
    if (row.status !== 'running' && row.status !== 'pending') return { ok: false, status: 409, error: `this run is already ${row.status}` };
    db().prepare("UPDATE film_pipeline_runs SET status = 'cancelled' WHERE id = ?").run(runId);
    return { ok: true, run_id: runId,
        message: 'Cancelled: it stops before its next step. A step already running finishes (or can be cancelled on its own).' };
}

module.exports = { cancelJob, cancelRun };
