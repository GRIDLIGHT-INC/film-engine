/**
 * One queue read model (PGN-010).
 *
 * Everything the Production graph's queue strip shows, from ONE free read:
 *
 *   running              a job heard from in the last few minutes, with progress
 *   waiting              the rest of a "Run what changed" / "Run to here" in progress,
 *                        and a flow run an apply has queued but not started
 *   paused               a flow run stopped at a pick, waiting for a person (FOG-007)
 *   done_today           finished today
 *   awaiting_collection  a provider still holds a job the caller stopped waiting for
 *   failed               refused or broke today — or a job with no provider handle
 *                        that went silent, because the process running it stopped
 *
 * Every job row lands in exactly one bucket or is left out as old, decided by
 * one pure function, so nothing is shown twice and nothing silently vanishes.
 */

const QUEUE_BUCKETS = Object.freeze(['running', 'waiting', 'paused', 'done_today', 'awaiting_collection', 'failed']);

/*
 * FLOW RUNS (FOG-007). Every status film_flow_runs' CHECK allows has a bucket,
 * or is left out on purpose with the reason. A finished or failed run shows
 * only on the day it settled, as a generation job does.
 */
const FLOW_RUN_STATUS = Object.freeze({
    pending: 'waiting', running: 'running', paused: 'paused',
    complete: 'done_today', failed: 'failed', cancelled: null,
});
const FLOW_RUN_LEFT_OUT = Object.freeze({
    cancelled: 'A cancelled run is over by a person\'s choice: nothing is running, waiting or owed, and any variations it made stay on the shot.',
});

/**
 * @param {object} row  a film_generation_jobs row with computed
 *                      silent_s (seconds since last heard), settled_today (0/1)
 */
function classifyJob(row) {
    if (!row) return null;
    const { RUNNING_SILENCE_SEC } = require('./production-graph');
    if (row.status === 'pending') {
        // Stopped waiting (PGN-012): the provider may still finish it, so it is
        // collectable, but nobody is waiting on it any more.
        if (Number(row.stopped_waiting) && Number(row.collectable)) return 'awaiting_collection';
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
            CASE WHEN date(settled_at) = date('now') THEN 1 ELSE 0 END AS settled_today,
            CASE WHEN json_valid(meta) THEN COALESCE(json_extract(meta, '$.stopped_waiting'), 0) ELSE 0 END AS stopped_waiting
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
        let adapter = null;
        try { adapter = require('./providers').get(j.provider); } catch (_) { adapter = null; }
        out[bucket].push({
            // What cancelling this would really do, said before the button is pressed.
            cancel: bucket === 'running' && Number(j.collectable) && adapter ? (adapter.cancel || 'stop_waiting') : null,
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
    // ── flow runs ──
    let applyLive = () => true;
    try { applyLive = require('./flow-apply').isApplyLive; } catch (_) { /* no applies to ask about */ }
    const flowRuns = db.prepare(`SELECT r.id, r.flow_id, r.shot_id, r.status, r.error_message, r.started_at, r.completed_at, r.created_at, r.apply_id,
            f.name AS flow_name, sh.shot_code,
            CASE WHEN date(r.completed_at) = date('now') THEN 1 ELSE 0 END AS settled_today
        FROM film_flow_runs r LEFT JOIN film_flows f ON f.id = r.flow_id LEFT JOIN film_shots sh ON sh.id = r.shot_id
        WHERE r.project_id = ? AND (r.status IN ('pending', 'running', 'paused') OR date(r.completed_at) = date('now'))
        ORDER BY COALESCE(r.completed_at, r.started_at, r.created_at) DESC`).all(projectId);
    for (const r of flowRuns) {
        let bucket = FLOW_RUN_STATUS[r.status];
        if (!bucket) continue;
        if ((bucket === 'done_today' || bucket === 'failed') && !Number(r.settled_today)) continue;
        // An applied run whose runner is gone (the process stopped) will never move.
        const orphan = (r.status === 'pending' || r.status === 'running') && r.apply_id && !applyLive(r.apply_id);
        if (orphan) bucket = 'failed';
        const key = r.shot_id ? `shot:${r.shot_id}` : null;
        out[bucket].push({
            kind: 'flow_run', run_id: r.id, flow_id: r.flow_id, flow_name: r.flow_name || 'flow', apply_id: r.apply_id || null,
            key, shot_code: r.shot_code || null, status: r.status,
            stage: bucket === 'paused' ? 'waiting for a pick' : (r.flow_name || 'flow'),
            started_at: r.started_at || r.created_at, settled_at: r.completed_at || null,
            error: bucket === 'failed' ? (orphan ? 'Interrupted: the process running this apply stopped before the run finished.' : (r.error_message || 'failed')) : null,
            // The existing cancel route stops a run that is still live.
            cancel: ['running', 'waiting', 'paused'].includes(bucket) ? 'cancel' : null,
            thumb: key ? shotFrame(r.shot_id) : null,
        });
    }

    out.counts = Object.fromEntries(QUEUE_BUCKETS.map(b => [b, out[b].length]));
    return out;
}

module.exports = { QUEUE_BUCKETS, FLOW_RUN_STATUS, FLOW_RUN_LEFT_OUT, classifyJob, projectQueue };
