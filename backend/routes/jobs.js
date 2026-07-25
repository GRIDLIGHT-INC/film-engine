/**
 * Unified generation job queue.
 *
 * GET /film/projects/:id/jobs
 * GET /film/projects/:id/jobs/summary
 */
const { db } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = new Set(['pending', 'queued', 'generating', 'processing', 'complete', 'failed', 'cancelled', 'planned']);

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function projectExists(projectId) {
    return db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
}

function handleJobs(req, res, urlParts, query) {
    if (urlParts[1] !== 'projects' || !urlParts[2] || urlParts[3] !== 'jobs') {
        return json(res, 404, { error: 'Not found' });
    }

    const projectId = urlParts[2];
    if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    if (!projectExists(projectId)) return json(res, 404, { error: 'Project not found' });

    if (urlParts[4] === 'summary') return getJobSummary(res, projectId, query);
    if (!urlParts[4]) return listJobs(res, projectId, query);
    return json(res, 404, { error: 'Not found' });
}

function normalizeStatus(status) {
    if (status === 'generating') return 'processing';
    return status || 'unknown';
}

function listJobs(res, projectId, query) {
    const params = [projectId];
    let sql = 'SELECT * FROM film_unified_generation_jobs WHERE project_id = ?';

    if (query.status && VALID_STATUSES.has(query.status)) {
        sql += ' AND status = ?';
        params.push(query.status);
    }

    if (query.type) {
        sql += ' AND job_type LIKE ?';
        params.push(`${String(query.type).slice(0, 40)}%`);
    }

    sql += ' ORDER BY created_at DESC';
    if (query.limit) {
        const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
        sql += ` LIMIT ${limit}`;
    }

    const jobs = db.prepare(sql).all(...params).map(row => ({
        ...row,
        normalized_status: normalizeStatus(row.status),
        is_active: ['pending', 'queued', 'generating', 'processing'].includes(row.status),
    }));

    json(res, 200, {
        project_id: projectId,
        total: jobs.length,
        summary: summarize(jobs),
        jobs,
    });
}

function getJobSummary(res, projectId, query) {
    const rows = db.prepare('SELECT * FROM film_unified_generation_jobs WHERE project_id = ?').all(projectId);
    const jobs = rows.map(row => ({ ...row, normalized_status: normalizeStatus(row.status) }));
    const type = query.type ? String(query.type).slice(0, 40) : '';
    const filtered = type ? jobs.filter(job => job.job_type.startsWith(type)) : jobs;
    json(res, 200, {
        project_id: projectId,
        total: filtered.length,
        summary: summarize(filtered),
    });
}

function summarize(jobs) {
    const by_status = {};
    const by_type = {};
    for (const job of jobs) {
        const status = normalizeStatus(job.status);
        by_status[status] = (by_status[status] || 0) + 1;
        by_type[job.job_type] = (by_type[job.job_type] || 0) + 1;
    }
    return {
        active: jobs.filter(job => ['pending', 'queued', 'generating', 'processing'].includes(job.status)).length,
        failed: jobs.filter(job => job.status === 'failed').length,
        complete: jobs.filter(job => job.status === 'complete').length,
        by_status,
        by_type,
    };
}

module.exports = { handleJobs, summarize };
