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
        return json(res, 200, {
            project_id: projectId,
            pending: open,
            count: open.length,
            note: open.length
                ? 'These generations were accepted by their provider and have not been delivered here yet. '
                  + 'Collecting is free — the work is already paid for.'
                : 'Nothing is outstanding.',
        });
    }

    // /film/generation-jobs/:id/collect
    if (req.method === 'POST' && parts[1] === 'generation-jobs' && parts[3] === 'collect') {
        const out = await jobs.collect(parts[2], {});
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
