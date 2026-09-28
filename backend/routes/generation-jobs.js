/**
 * Outstanding generations, and collecting them.
 *
 * A generation the host abandons is not lost: the provider's own id was written
 * down before polling began, so the job can be finished from that handle. These
 * two routes are what make the record usable — one to see what is outstanding,
 * one to deliver it.
 *
 * Both are FREE. Collecting polls a job that was already paid for; it never
 * starts a new generation.
 */

const { db } = require('../db/database');
const jobs = require('../lib/generation-jobs');

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function handleGenerationJobs(req, res, parts) {
    // /film/projects/:id/generation-jobs
    if (req.method === 'GET' && parts[1] === 'projects' && parts[3] === 'generation-jobs') {
        const projectId = parts[2];
        const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
        if (!project) return json(res, 404, { error: 'Project not found' });
        const open = jobs.pending(projectId);
        // Settled as failed by THIS engine, and possibly still sitting finished
        // at the provider. Collecting one is free; re-buying it is not.
        const stuck = jobs.recoverable(projectId);
        return json(res, 200, {
            project_id: projectId,
            pending: open,
            count: open.length,
            ...(stuck.length ? {
                recoverable: stuck.map(j => ({
                    id: j.id, provider: j.provider, capability: j.capability,
                    request_id: j.request_id, error: j.error, created_at: j.created_at,
                })),
                recoverable_note: 'These were recorded as FAILED here, but the provider may still hold '
                    + 'the finished result — a failure on this side does not un-render or refund a '
                    + 'generation. generation_collect re-polls them and is free.',
            } : {}),
            note: open.length
                ? 'These generations were accepted by their provider and have not been delivered here yet. '
                  + 'Collecting is free — the work is already paid for.'
                : 'Nothing is outstanding.',
        });
    }

    // /film/generation-jobs/:id/cancel — a real cancel where the provider has one,
    // otherwise "stop waiting" with the billing warning (PGN-012).
    if (req.method === 'POST' && parts[1] === 'generation-jobs' && parts[3] === 'cancel') {
        const out = await require('../lib/generation-cancel').cancelJob(parts[2]);
        return json(res, out.ok ? 200 : out.status, out);
    }
    // /film/generation-jobs/:id/collect
    if (req.method === 'POST' && parts[1] === 'generation-jobs' && parts[3] === 'collect') {
        /*
         * `belongs_to` names what the clip IS, for a handle recorded before the
         * engine stamped that itself. Every job created from now on carries its
         * own leg meta, so this is for the ones already on disk -- without it a
         * clip recovered from an older handle is stored and still invisible to
         * the sequence that bought it.
         */
        const b = (req.body && req.body.belongs_to) || null;
        /*
         * BOTH, because `belongs_to` answers two different questions.
         *
         * For a sequence leg it is meta the handle could not record, and it is
         * merged into the job's meta. For a PLATE it names the subject to file
         * against, which `collect` reads off opts directly. Passing only
         * metaPatch is why naming a plate here did nothing at all: the value
         * arrived, went into a meta bag nothing looked at for this purpose, and
         * the job answered "already completed" as if it had not been asked.
         */
        const out = await jobs.collect(parts[2], b ? { metaPatch: b, belongs_to: b } : {});
        return json(res, out.ok ? 200 : (out.status || 500), out);
    }

    // /film/generation-jobs/:id
    if (req.method === 'GET' && parts[1] === 'generation-jobs' && parts.length === 3) {
        const job = jobs.get(parts[2]);
        if (!job) return json(res, 404, { error: `no generation job ${parts[2]}` });
        return json(res, 200, job);
    }

    return json(res, 404, { error: 'Unknown generation-jobs route' });
}

module.exports = { handleGenerationJobs };
