/**
 * A generation the host abandons is not lost.
 *
 * Every async provider here returns an id the moment it accepts a job, and that
 * id lived only in a local variable inside the poll loop. A tool call through
 * an MCP host is abandoned at sixty seconds; a generation still polling then is
 * not slow, it is LOST — the handler is torn down mid-await, nothing reaches
 * film_assets, and the caller is told the device did not respond. That reads
 * like a connection fault. It is not: the provider very likely finished and
 * billed for it, and the result had nowhere to be delivered.
 *
 * Measured across the adapters that poll: meshy and seedance budget FIFTEEN
 * MINUTES, bfl and runway five, against a sixty-second abort.
 *
 * NO TIMEOUT VALUE FIXES THIS. No budget is both longer than a 4K render and
 * shorter than the abort, so shortening them alone trades a lost result for a
 * failed one and still burns the money. What fixes it is writing the handle
 * down BEFORE polling: the process can die, the host can abort, and the job is
 * still collectable.
 *
 * The happy path is deliberately unchanged. The adapter still polls and still
 * returns bytes; this only means the id was written down first.
 */

/**
 * How long a caller may wait, and who decides.
 *
 * THE BUDGET BELONGS TO THE CALLER, NOT THE ADAPTER. An HTTP request can wait
 * fifteen minutes for a mesh and nothing abandons it. A tool call has sixty
 * seconds whatever the adapter would prefer. An adapter with a hardcoded budget
 * cannot be run safely from both, which is why every one of them now takes
 * `opts.timeout` and this decides what to pass.
 *
 * Declared by the MCP SERVER PROCESS rather than detected, because that process
 * is the one with the constraint — `backend/mcp-server.js` is a separate
 * program from `backend/server.js`, so an environment variable set at its own
 * startup is unambiguous and cannot leak into the HTTP path.
 */
const COLLECT_MARGIN_MS = 15000;

function hostWindowMs() {
    const raw = Number(process.env.FILM_HOST_ABORT_MS || 0);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * The margin is not politeness. The adapter has to notice the deadline, stop
 * polling, write the handle, and return a message the model can act on — all
 * before the host stops listening. A budget equal to the window produces the
 * exact failure this exists to prevent, one layer down.
 */
function budgetFor(defaultMs) {
    const window = hostWindowMs();
    const asked = Number(defaultMs) || 0;
    if (!window) return asked;                       // nothing abandons this caller
    const room = Math.max(20000, window - COLLECT_MARGIN_MS);
    return asked ? Math.min(asked, room) : room;
}

/** Lazily, because lib modules are required by tests that never open a database. */
function handle() {
    const { db, generateId } = require('../db/database');
    return { db, generateId };
}

/**
 * Write the handle down.
 *
 * NEVER THROWS. By the time this runs the request has been made and the money
 * is gone; turning a paid, accepted generation into an error because the
 * bookkeeping failed is the worst trade available — the rule `stampAsset`
 * already documents for fingerprinting.
 *
 * A duplicate (provider, request_id) is the SAME job seen twice, so it returns
 * the existing row rather than recording a second one: two rows for one request
 * would offer a collect that has already happened.
 */
function record(job) {
    try {
        const j = job || {};
        if (!j.provider || !j.requestId) return null;
        const { db, generateId } = handle();
        const existing = db.prepare(
            'SELECT id FROM film_generation_jobs WHERE provider = ? AND request_id = ?'
        ).get(String(j.provider), String(j.requestId));
        if (existing) return existing.id;

        const id = generateId();
        db.prepare(`INSERT INTO film_generation_jobs
            (id, project_id, shot_id, scene_id, provider, capability, request_id, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, j.projectId || null, j.shotId || null, j.sceneId || null,
                 String(j.provider), String(j.capability || 'unknown'), String(j.requestId),
                 JSON.stringify(j.meta || {}));
        return id;
    } catch (_) {
        // A generation must never fail because its receipt could not be filed.
        return null;
    }
}

function settle(jobId, status, patch) {
    try {
        if (!jobId) return false;
        const { db } = handle();
        db.prepare(`UPDATE film_generation_jobs
            SET status = ?, asset_id = ?, error = ?, settled_at = datetime('now')
            WHERE id = ?`)
            .run(status, (patch && patch.assetId) || null, (patch && patch.error) || null, jobId);
        return true;
    } catch (_) { return false; }
}

const complete = (jobId, patch) => settle(jobId, 'completed', patch || {});
const fail = (jobId, error) => settle(jobId, 'failed', { error: String(error || '').slice(0, 2000) });

/** What is still outstanding, newest first. */
function pending(projectId) {
    try {
        const { db } = handle();
        return projectId
            ? db.prepare(`SELECT * FROM film_generation_jobs
                 WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(projectId)
            : db.prepare(`SELECT * FROM film_generation_jobs
                 WHERE status = 'pending' ORDER BY created_at DESC`).all();
    } catch (_) { return []; }
}

function get(jobId) {
    try {
        const { db } = handle();
        return db.prepare('SELECT * FROM film_generation_jobs WHERE id = ?').get(jobId) || null;
    } catch (_) { return null; }
}

/**
 * The result an adapter returns when it ran out of budget but the job is alive.
 *
 * `ok: false` because no bytes came back, and `pending: true` because that is a
 * different thing from a failure — the reported symptom was "the device did not
 * respond", which reads as a connection fault and sends the reader to the wrong
 * problem entirely. Naming the handle and the way to collect it is the whole
 * difference between a lost render and one that is simply not finished.
 */
function timedOut(info) {
    const i = info || {};
    const waited = i.waitedMs ? `${Math.round(i.waitedMs / 1000)}s` : 'its budget';
    const where = i.jobId ? `job ${i.jobId}` : `${i.provider} request ${i.requestId}`;
    return {
        ok: false,
        pending: true,
        status: 202,
        job_id: i.jobId || null,
        provider: i.provider || null,
        request_id: i.requestId || null,
        error: `${i.provider || 'the provider'} did not finish within ${waited}. `
            + `It is still running and has NOT been lost — collect it with `
            + `generation_collect (${where}). This call stopped early because the `
            + `agent host abandons a tool call at 60s.`,
    };
}


/**
 * Turn a stored handle back into a delivered asset.
 *
 * This is the half that makes the record worth keeping. It polls the provider
 * with the SAME function the live path uses, so a collected result cannot
 * differ from one that arrived normally, then files it where that capability's
 * output belongs -- read from `media-kinds`, the one registry that says so,
 * rather than restated here.
 *
 * A job that is still running stays `pending` and says so: collecting is
 * idempotent and safe to retry, which is the whole point of a handle. A job
 * whose provider reports failure is settled as failed, because a handle that
 * can never be collected must stop being offered.
 */
async function collect(jobId, opts) {
    const job = get(jobId);
    if (!job) return { ok: false, status: 404, error: `no generation job ${jobId}` };
    if (job.status !== 'pending') {
        return { ok: true, already: job.status, job, note: `this job was already ${job.status}` };
    }

    const providers = require('./providers');
    const adapter = providers.get(job.provider);
    if (!adapter || typeof adapter.collect !== 'function') {
        return { ok: false, status: 501,
            error: `${job.provider} cannot collect a job by handle` };
    }

    let meta = {};
    try { meta = JSON.parse(job.meta || '{}'); } catch (_) { meta = {}; }

    let out;
    try {
        out = await adapter.collect(job.request_id, Object.assign({ meta }, meta, opts || {}));
    } catch (err) {
        return { ok: false, status: 502, error: `${job.provider}: ${err.message}` };
    }

    // Still running. Left pending deliberately -- a handle is only useful if
    // asking again is safe.
    if (!out || (!out.ok && (out.pending || out.status === 504))) {
        return { ok: false, pending: true, status: 202, job_id: job.id,
            error: `${job.provider} has not finished job ${job.id} yet — it is still running, try again.` };
    }
    if (!out.ok) {
        fail(job.id, out.error);
        return { ok: false, status: out.status || 502, job_id: job.id, error: out.error };
    }

    /*
     * File it. A collected result that is not persisted is the original defect
     * with an extra step: the provider finished, the money is gone, and there is
     * still nothing in film_assets.
     */
    let stored = null;
    try {
        if (out.data) {
            const { persistCapabilityResult } = require('./capability-payloads');
            // PERSIST_EXT is what the registry actually calls it.
            const { PERSIST_EXT } = require('./media-kinds');
            const ext = (PERSIST_EXT && PERSIST_EXT[job.capability]) || 'bin';
            const name = `collected_${job.id}.${ext}`;
            stored = await persistCapabilityResult(job.capability, out,
                { project: { id: job.project_id }, project_id: job.project_id }, name);
        }
    } catch (err) {
        // The bytes arrived and could not be filed. Reported rather than
        // swallowed: the job stays pending so it can be collected again.
        return { ok: false, status: 500, job_id: job.id,
            error: `${job.provider} returned the result and it could not be stored — ${err.message}` };
    }

    complete(job.id, {});
    return { ok: true, job_id: job.id, provider: job.provider, capability: job.capability,
             stored: stored ? stored.path : null, url: out.url || null };
}

module.exports = {
    collect,
    hostWindowMs, budgetFor, record, complete, fail, pending, get, timedOut,
    COLLECT_MARGIN_MS,
};
