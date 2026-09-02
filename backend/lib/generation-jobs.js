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

/**
 * Jobs this engine settled as FAILED that the provider may still hold.
 *
 * Surfaced because `pending` alone cannot see them, and a failure caused by
 * this side -- a misread result field, a storage error -- leaves a rendered,
 * billed clip sitting on the provider's CDN with nothing pointing at it. Free
 * to ask about and free to collect, so the only cost of listing them is a line
 * of output; the cost of NOT listing them is re-buying footage that exists.
 *
 * Bounded to a week: a handle old enough that the provider has expired its
 * result is a false promise, and offering it is worse than silence.
 */
function recoverable(projectId) {
    try {
        const { db } = handle();
        const sql = `SELECT * FROM film_generation_jobs
             WHERE status = 'failed' AND request_id IS NOT NULL
               AND created_at >= datetime('now', '-7 days')`;
        return projectId
            ? db.prepare(`${sql} AND project_id = ? ORDER BY created_at DESC`).all(projectId)
            : db.prepare(`${sql} ORDER BY created_at DESC`).all();
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
function safeMeta(job) {
    try { return JSON.parse((job && job.meta) || '{}'); } catch (_) { return {}; }
}

/**
 * The plate an untagged handle was bought for, named by the caller.
 *
 * `belongs_to: { kind, subject_id, view? }` — for a job recorded before the
 * engine stamped what it was, which is every plate generated before
 * `plate-delivery` existed. Those results are not lost; they are unclaimed.
 */
function plateBindingOf(opts, meta) {
    const b = opts && opts.belongs_to;
    if (b && b.kind && (b.subject_id || b.subjectId)) {
        return { kind: String(b.kind), subjectId: b.subject_id || b.subjectId, view: b.view || '' };
    }
    // A location or prop plate stamps itself under `plate`.
    const p = meta && meta.plate;
    if (p && p.kind && p.subject_id && !p.explore) {
        return { kind: String(p.kind), subjectId: p.subject_id, view: p.view || '' };
    }
    const stamped = meta && meta[require('./plate-delivery').JOB_META_KEY];
    if (stamped && stamped.character_id) {
        return { kind: 'character', subjectId: stamped.character_id, view: stamped.view || 'front',
                 styleApplied: stamped.style_applied };
    }
    return null;
}

/** File the picture a settled job left on disk as the plate it was bought for. */
async function adoptPlate(job, plate) {
    const meta = safeMeta(job);
    const delivery = require('./plate-delivery');
    const { PERSIST_EXT, SUBDIR } = require('./media-kinds');
    const { getFilePath } = require('./file-storage');
    const ext = (PERSIST_EXT && PERSIST_EXT[job.capability]) || 'bin';
    const subdir = (SUBDIR && SUBDIR[job.capability]) || 'storyboards';
    let onDisk = null;
    try { onDisk = getFilePath(job.project_id, subdir, `collected_${job.id}.${ext}`); } catch (_) { onDisk = null; }
    const filed = onDisk && await delivery.adoptFile({
        filePath: onDisk,
        kind: plate.kind, projectId: job.project_id, subjectId: plate.subjectId, view: plate.view,
        provider: job.provider, providerModel: (meta.meter && meta.meter.model) || '',
        providerJobId: job.request_id, collectedFromJob: job.id,
    });
    if (filed && filed.ok) {
        return { ok: true, job_id: job.id, adopted: true, plate: filed,
            note: 'This job had already been collected but never filed. The picture it left on disk '
                + 'is now the plate for that subject — nothing was regenerated or re-bought.' };
    }
    return { ok: false, status: 409, job_id: job.id,
        error: `job ${job.id} is ${job.status} and its collected file could not be adopted`
             + `${filed && filed.error ? ` — ${filed.error}` : ''}` };
}

async function collect(jobId, opts) {
    const job = get(jobId);
    if (!job) return { ok: false, status: 404, error: `no generation job ${jobId}` };
    /*
     * A COMPLETED job is done: the bytes are filed and re-polling could only
     * file them twice.
     *
     * A FAILED one is not the same thing, and treating it as final is what
     * turned a rendered clip into a lost one. `failed` here means THIS ENGINE
     * gave up on the job — including when it gave up because of its own bug:
     * the poll read `data.output` while MuAPI answers `outputs`, so a finished,
     * billed clip was settled as a failure and then refused collection forever.
     * The provider is the source of truth about its own job, and asking it is
     * FREE. So a failed handle is re-polled: if the provider really did fail,
     * the same failure comes back and nothing changes; if it holds a result,
     * the money stops being wasted.
     */
    if (job.status === 'completed') {
        /*
         * ADOPTION, not a re-buy.
         *
         * "The bytes are filed" was an assumption, and it was wrong for every
         * plate. A plate collected before `plate-delivery` existed was written
         * to `collected_<job>.png` and registered NOWHERE — nine of those
         * accumulated in one afternoon on this production, two of them better
         * than the plates actually in use, and refusing to look at them again
         * is what turned a filing gap into work bought twice.
         *
         * So when the caller NAMES what the job was for, the picture already on
         * disk becomes that plate. The provider is not asked for bytes this
         * engine already has: nothing is re-polled and nothing is spent.
         */
        const claimed = plateBindingOf(opts, safeMeta(job));
        if (claimed) return adoptPlate(job, claimed);
        return { ok: true, already: job.status, job, note: 'this job was already completed' };
    }
    const retryingFailed = job.status === 'failed';

    const providers = require('./providers');
    const adapter = providers.get(job.provider);
    if (!adapter || typeof adapter.collect !== 'function') {
        return { ok: false, status: 501,
            error: `${job.provider} cannot collect a job by handle` };
    }

    let meta = {};
    try { meta = JSON.parse(job.meta || '{}'); } catch (_) { meta = {}; }
    // A caller may supply what an older handle could not record. The stored
    // meta still wins: what the engine wrote at the time is evidence, and a
    // caller's guess must never overwrite it.
    if (opts && opts.metaPatch) meta = Object.assign({}, opts.metaPatch, meta);

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
    let assetId = null;
    let plateFiled = null;
    try {
        /*
         * BYTES OR A URL. Seedance returns a CDN link and no buffer, and this
         * read `out.data` alone -- so the one adapter most likely to be
         * collected was the one whose result was silently never filed.
         */
        /*
         * A PLATE IS FILED AS A PLATE.
         *
         * Nano Banana Pro takes about two minutes; the host window is one. So
         * every character plate on that model timed out, was collected here,
         * and was written to `collected_<job>.png` in the storyboards directory
         * — a finished, billed reference picture with no film_assets row, no
         * entry in the character library, and `has_plate` still false. The
         * director sees "failed", regenerates, and buys it twice.
         *
         * The handle now carries what the generation was FOR, so this road can
         * do what the live road does. Same filing rule, one implementation, in
         * lib/plate-delivery.js — exactly the arrangement the sequence-leg
         * branch below already uses for the same reason.
         */
        const plateDelivery = require('./plate-delivery');
        const plate = plateBindingOf(opts, meta);
        if (plate && (out.data || out.url)) {
            const filed = await plateDelivery.fileSubjectPlate({
                kind: plate.kind,
                projectId: job.project_id,
                subjectId: plate.subjectId,
                view: plate.view,
                data: out.data || out,
                provider: out.provider || job.provider,
                providerModel: out.provider_model || (meta.meter && meta.meter.model) || '',
                providerJobId: job.request_id,
                styleApplied: plate.styleApplied,
                collectedFromJob: job.id,
            });
            if (!filed.ok) {
                return { ok: false, status: 500, job_id: job.id,
                    error: `${job.provider} returned the plate and it could not be filed — ${filed.error}` };
            }
            assetId = filed.asset_id;
            plateFiled = filed;
            stored = { path: filed.file_path };
        } else if (out.data || out.url) {
            const { persistCapabilityResult } = require('./capability-payloads');
            // PERSIST_EXT is what the registry actually calls it.
            const { PERSIST_EXT } = require('./media-kinds');
            const ext = (PERSIST_EXT && PERSIST_EXT[job.capability]) || 'bin';
            /*
             * A leg of a sequence is stored under the name that sequence looks
             * it up by -- never `collected_<job>.mp4`, which is a file on disk
             * that the sequence it was bought for cannot see.
             */
            const leg = meta && meta.sequence_id && meta.from && meta.to ? meta : null;
            const name = leg
                ? require('./sequence-delivery').clipFileName(leg.sequence_id, leg.from, leg.to)
                : `collected_${job.id}.${ext}`;
            stored = await persistCapabilityResult(job.capability, out,
                { project: { id: job.project_id }, project_id: job.project_id }, name);
            if (leg) {
                assetId = require('./sequence-delivery').fileSequenceClip({
                    projectId: job.project_id,
                    sequenceId: leg.sequence_id, from: leg.from, to: leg.to,
                    shotId: leg.from_shot_id || job.shot_id || null,
                    fileName: name,
                    filePath: typeof stored === 'string' ? stored : (stored && stored.path) || '',
                    extra: { collected_from_job: job.id },
                });
            }
        }
    } catch (err) {
        // The bytes arrived and could not be filed. Reported rather than
        // swallowed: the job stays pending so it can be collected again.
        return { ok: false, status: 500, job_id: job.id,
            error: `${job.provider} returned the result and it could not be stored — ${err.message}` };
    }

    /*
     * POST THE SPEND. This is the other half of the stamp `resolve()` writes at
     * handle time.
     *
     * The live meter fires on a successful result, and a job that reached here
     * did NOT return one to the caller — it timed out, or it was recorded as
     * failed. So nothing has been billed on this side yet, and there is no
     * double-count to guard against: a job that genuinely succeeded live was
     * settled `completed` and never gets this far.
     *
     * Money the provider took and the ledger never saw is worse than no ledger:
     * a spend report that reads $0 for video is believed.
     */
    try {
        if (meta && meta.meter && Number(meta.meter.quantity) > 0) {
            require('./usage-meter').recordUsage({
                provider: job.provider,
                capability: job.capability,
                model: meta.meter.model || '',
                unit: meta.meter.unit,
                quantity: meta.meter.quantity,
                parts: meta.meter.parts || null,
                projectId: job.project_id || null,
                shotId: meta.from_shot_id || job.shot_id || null,
                sceneId: job.scene_id || null,
            });
        }
    } catch (err) {
        // Bookkeeping never fails the delivery it is keeping books on.
        console.error('[generation-jobs] collected but could not record spend:', err.message);
    }

    complete(job.id, assetId ? { assetId } : {});
    return { ok: true, job_id: job.id, provider: job.provider, capability: job.capability,
             ...(retryingFailed ? { recovered: true,
                 note: 'This job had been settled as failed by this engine. The provider still '
                     + 'held the result, so it was re-polled and delivered rather than re-bought.' } : {}),
             ...(assetId ? { asset_id: assetId,
                 ...(meta.sequence_id ? { sequence_id: meta.sequence_id } : {}) } : {}),
             ...(plateFiled ? { plate: {
                 kind: plateFiled.kind, subject_id: plateFiled.subject_id, view: plateFiled.view,
                 file_name: plateFiled.file_name, image_url: plateFiled.image_url,
                 filed: 'This plate finished after the call was abandoned and is now the reference '
                      + 'for that view — it is in the character library, not a loose file.' } } : {}),
             stored: stored ? stored.path : null, url: out.url || null };
}

module.exports = {
    collect,
    hostWindowMs, budgetFor, record, complete, fail, pending, recoverable, get, timedOut,
    COLLECT_MARGIN_MS,
};
