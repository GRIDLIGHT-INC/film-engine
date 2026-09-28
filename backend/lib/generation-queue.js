/**
 * One queue read model (PGN-010).
 *
 * Everything the Production graph's queue strip shows, from ONE free read:
 *
 *   running              a job heard from in the last few minutes, with progress
 *   waiting              the rest of a "Run what changed" / "Run to here" in progress
 *   done_today           finished today
 *   awaiting_collection  a provider still holds a job the caller stopped waiting for
 *   failed               refused or broke today — or a job with no provider handle
 *                        that went silent, because the process running it stopped
 *
 * Every job row lands in exactly one bucket or is left out as old, decided by
 * one pure function, so nothing is shown twice and nothing silently vanishes.
 */

const QUEUE_BUCKETS = Object.freeze(['running', 'waiting', 'done_today', 'awaiting_collection', 'failed']);

/**
 * @param {object} row  a film_generation_jobs row with computed
 *                      silent_s (seconds since last heard), settled_today (0/1)
 */
function classifyJob(row) {
    if (!row) return null;
    const { RUNNING_SILENCE_SEC } = require('./production-graph');
    if (row.status === 'pending') {
        if (Number(row.silent_s) <= RUNNING_SILENCE_SEC) return 'running';
        return Number(row.collectable) ? 'awaiting_collection' : 'failed';
    }
    if (row.status === 'completed') return Number(row.settled_today) ? 'done_today' : null;
    if (row.status === 'failed') return Number(row.settled_today) ? 'failed' : null;
    return null;
}

function projectQueue(projectId) {
    const { db } = require('../db/database');
    const pg = require('./production-graph');
    if (!projectId || !db.prepare('SELECT 1 FROM film_projects WHERE id = ?').get(projectId)) return null;
    const rows = db.prepare(`SELECT *,
            (julianday('now') - julianday(COALESCE(heartbeat_at, started_at, created_at))) * 86400 AS silent_s,
            CASE WHEN date(settled_at) = date('now') THEN 1 ELSE 0 END AS settled_today
        FROM film_generation_jobs WHERE project_id = ?
          AND (status = 'pending' OR date(settled_at) = date('now'))
        ORDER BY COALESCE(settled_at, started_at, created_at) DESC`).all(projectId);

    const frameCache = new Map();
    const shotFrame = shotId => {
        if (frameCache.has(shotId)) return frameCache.get(shotId);
        let url = null;
        try {
            const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
            const f = shot && pg.shotFrames(db, shot).find(x => x.selected);
            url = (f && f.url) || null;
        } catch (_) { url = null; }
        frameCache.set(shotId, url);
        return url;
    };
    const assetThumb = assetId => {
        try {
            const a = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(assetId);
            return a && a.file_path ? require('./file-storage').urlForPath(a.file_path) || null : null;
        } catch (_) { return null; }
    };
    const thumbFor = (j, key) => {
        if (j.asset_id) { const t = assetThumb(j.asset_id); if (t) return t; }
        if (key && key.startsWith('shot:')) return shotFrame(key.slice(5));
        return null;
    };

    const out = Object.fromEntries(QUEUE_BUCKETS.map(b => [b, []]));
    for (const j of rows) {
        const bucket = classifyJob(j);
        if (!bucket) continue;
        const key = pg.jobNodeKey(j);
        out[bucket].push({
            job_id: j.id, key, provider: j.provider, capability: j.capability,
            percent: j.percent === null || j.percent === undefined ? null : Number(j.percent),
            phase: j.phase || null, started_at: j.started_at || j.created_at, settled_at: j.settled_at || null,
            error: bucket === 'failed' ? (j.error || (j.status === 'pending' ? 'No word from it for several minutes; the process running it stopped.' : null)) : null,
            thumb: thumbFor(j, key),
        });
    }
    for (const r of db.prepare(`SELECT id, params, steps_remaining FROM film_pipeline_runs
            WHERE project_id = ? AND status = 'running'`).all(projectId)) {
        let params = {}, remaining = [];
        try { params = JSON.parse(r.params || '{}'); } catch (_) { params = {}; }
        if (!['run_changed', 'run_to_here'].includes(params.kind)) continue;
        try { remaining = JSON.parse(r.steps_remaining || '[]'); } catch (_) { remaining = []; }
        for (const it of remaining) {
            out.waiting.push({ run_id: r.id, kind: params.kind, key: it.key || null, stage: it.stage, shot_code: it.shot_code || null,
                thumb: it.key && it.key.startsWith('shot:') ? shotFrame(it.key.slice(5)) : null });
        }
    }
    out.counts = Object.fromEntries(QUEUE_BUCKETS.map(b => [b, out[b].length]));
    return out;
}

module.exports = { QUEUE_BUCKETS, classifyJob, projectQueue };
