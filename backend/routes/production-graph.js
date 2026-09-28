/**
 * The production graph: one page for the whole Production phase.
 *
 *   GET          /film/projects/:id/production-graph         — every node, edge and group (free)
 *   PUT          /film/projects/:id/production-graph/layout  — nodes a person moved; pins them
 *   POST         /film/projects/:id/production-graph/tidy    — re-place every node nobody moved
 *   POST|DELETE  /film/shots/:id/video/select                — which of a shot's clips plays
 *   POST|DELETE  /film/music-cues/:id/select                 — which of a cue's sounds plays
 *
 * A frame is selected through the existing POST /film/shots/:id/frames/:v/restore
 * and a sequence clip through POST /film/sequences/:id/video/select — one
 * pointer per kind of thing, each where its parent already lives.
 *
 * Everything here is free: it reads rows and moves pointers. Nothing spends.
 */

const { db } = require('../db/database');
const pg = require('../lib/production-graph');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^(shot|seq|sound|ver):[0-9a-f-]{36}$|^link:[0-9a-f-]{36}:(start|end)$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function getGraph(res, projectId) {
    const graph = pg.buildGraph(db, projectId);
    if (!graph) return json(res, 404, { error: 'Project not found' });
    return json(res, 200, { ...graph, pending: pg.pendingWork(graph) });
}

/**
 * A node a person dragged stays where they put it. Pinned on write, because a
 * drag IS the statement "I want it here" — and Tidy layout must leave it alone.
 */
function putLayout(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const nodes = Array.isArray((req.body || {}).nodes) ? req.body.nodes : null;
    if (!nodes) return json(res, 400, { error: 'nodes must be a list of { key, x, y }' });
    const bad = nodes.filter(n => !n || !KEY_RE.test(String(n.key || ''))
        || !Number.isFinite(Number(n.x)) || !Number.isFinite(Number(n.y)));
    if (bad.length) return json(res, 400, { error: `${bad.length} node(s) have no valid key or position`, bad });
    const upsert = db.prepare(`INSERT INTO production_node_layout (project_id, node_key, x, y, pinned, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(project_id, node_key) DO UPDATE SET x = excluded.x, y = excluded.y,
            pinned = excluded.pinned, updated_at = excluded.updated_at`);
    db.transaction(() => {
        for (const n of nodes) {
            upsert.run(projectId, n.key, Math.round(Number(n.x)), Math.round(Number(n.y)), n.pinned === false ? 0 : 1);
        }
    })();
    return json(res, 200, { saved: nodes.length });
}

/** Forget every position nobody pinned; the next read places them afresh. */
function tidy(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const all = (req.body || {}).all === true;
    const n = all
        ? db.prepare('DELETE FROM production_node_layout WHERE project_id = ?').run(projectId).changes
        : db.prepare('DELETE FROM production_node_layout WHERE project_id = ? AND pinned = 0').run(projectId).changes;
    return getGraphAfter(res, projectId, { released: n, kept_pinned: !all });
}

function getGraphAfter(res, projectId, extra) {
    const graph = pg.buildGraph(db, projectId);
    return json(res, 200, { ...graph, pending: pg.pendingWork(graph), ...extra });
}

/**
 * Which of a shot's own clips plays. The player reads this pointer before its
 * type ranking, so a second generation can be chosen over the first.
 */
function selectShotVideo(req, res, shotId) {
    const shot = db.prepare(`SELECT sh.*, s.project_id FROM film_shots sh
        JOIN film_scenes s ON s.id = sh.scene_id WHERE sh.id = ?`).get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const assetId = req.method === 'DELETE' ? null : (req.body || {}).asset_id;
    if (assetId) {
        const a = db.prepare('SELECT id, project_id, shot_id, asset_type FROM film_assets WHERE id = ?').get(assetId);
        if (!a || a.shot_id !== shotId || !/^video_/.test(a.asset_type)) {
            return json(res, 400, { error: 'that is not a video of this shot' });
        }
    }
    db.prepare('UPDATE film_shots SET selected_video_asset_id = ? WHERE id = ?').run(assetId || null, shotId);
    return json(res, 200, { shot_id: shotId, selected_video_asset_id: assetId || null });
}

/**
 * Which of a cue's sounds plays. generated_asset_id has always been "the audio
 * THIS cue produced", and the timeline plays it; selecting a version is
 * pointing it at a different one the cue made.
 */
function selectCueVersion(req, res, cueId) {
    const cue = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(cueId);
    if (!cue) return json(res, 404, { error: 'Music cue not found' });
    const assetId = req.method === 'DELETE' ? null : (req.body || {}).asset_id;
    if (assetId && !pg.cueVersions(db, cue).some(v => v.asset_id === assetId)) {
        return json(res, 400, { error: 'that is not a sound this cue made' });
    }
    db.prepare('UPDATE film_music_cues SET generated_asset_id = ? WHERE id = ?').run(assetId || null, cueId);
    return json(res, 200, { cue_id: cueId, selected_asset_id: assetId || null });
}

function handleProductionGraph(req, res, parts, query) {
    if (parts[1] === 'projects' && parts[2] && parts[3] === 'production-graph') {
        if (!UUID_RE.test(parts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (!parts[4] && req.method === 'GET') return getGraph(res, parts[2]);
        // What is running right now, and on which node — free, polled by the page
        // while anything runs, because the live channel is silent about our own writes.
        if (parts[4] === 'running' && req.method === 'GET') return json(res, 200, { running: pg.runningWork(db, parts[2]) });
        // The queue strip's one read: running, waiting, done today, awaiting
        // collection and failed, each with its node (PGN-010). Free.
        if (parts[4] === 'queue' && req.method === 'GET') {
            const out = require('../lib/generation-queue').projectQueue(parts[2]);
            return out ? json(res, 200, out) : json(res, 404, { error: 'Project not found' });
        }
        // "Run what changed", planned for free: the redo-now list, priced, with
        // what is left out and why (PGN-006). Nothing here resolves a provider.
        if (parts[4] === 'run-changed' && parts[5] === 'plan' && req.method === 'GET') {
            const plan = require('../lib/run-changed').planRunChanged(parts[2]);
            return plan ? json(res, 200, plan) : json(res, 404, { error: 'Project not found' });
        }
        // Run it: one confirmation on the page, then one item at a time in the
        // background (PGN-007). Answers at once with the run id.
        // "Run to here", planned for free: what a clip, sequence or sound still
        // needs, frames before clips, borrowed frames traced (PGN-008).
        if (parts[4] === 'nodes' && parts[5] && parts[6] === 'run-to-here' && parts[7] === 'plan' && req.method === 'GET') {
            const plan = require('../lib/run-to-here').planForNode(parts[2], decodeURIComponent(parts[5]));
            if (!plan) return json(res, 404, { error: 'Project not found' });
            return plan.error ? json(res, 400, plan) : json(res, 200, plan);
        }
        if (parts[4] === 'nodes' && parts[5] && parts[6] === 'run-to-here' && !parts[7] && req.method === 'POST') {
            const out = require('../lib/run-to-here').startRunToHere(parts[2], decodeURIComponent(parts[5]),
                { ignore_budget: !!(req.body || {}).ignore_budget });
            return json(res, out.status, out.body);
        }
        // Which of this project's files is the one dropped on the canvas —
        // by its hash, sent without the bytes (PGN-015). A GET: it writes
        // nothing, so it must not make the page refresh over the drawer it opens.
        if (parts[4] === 'match' && !parts[5] && req.method === 'GET') {
            if (!db.prepare('SELECT 1 FROM film_projects WHERE id = ?').get(parts[2])) return json(res, 404, { error: 'Project not found' });
            const out = require('../lib/asset-match').matchFile(db, parts[2], query || {});
            return json(res, out.error ? 400 : 200, out);
        }
        if (parts[4] === 'runs' && parts[5] && parts[6] === 'cancel' && req.method === 'POST') {
            const out = require('../lib/generation-cancel').cancelRun(parts[2], parts[5]);
            return json(res, out.ok ? 200 : out.status, out);
        }
        if (parts[4] === 'run-changed' && !parts[5] && req.method === 'POST') {
            const out = require('../lib/run-changed').startRunChanged(parts[2], { ignore_budget: !!(req.body || {}).ignore_budget });
            return json(res, out.status, out.body);
        }
        if (parts[4] === 'run-changed' && parts[5] && parts[5] !== 'plan' && req.method === 'GET') {
            const run = require('../lib/run-changed').getRun(parts[2], parts[5]);
            return run ? json(res, 200, run) : json(res, 404, { error: 'No such run' });
        }
        if (parts[4] === 'layout' && req.method === 'PUT') return putLayout(req, res, parts[2]);
        if (parts[4] === 'tidy' && req.method === 'POST') return tidy(req, res, parts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }
    if (parts[1] === 'shots' && parts[2] && parts[3] === 'video' && parts[4] === 'select') {
        if (!UUID_RE.test(parts[2])) return json(res, 400, { error: 'Invalid shot ID' });
        if (req.method === 'POST' || req.method === 'DELETE') return selectShotVideo(req, res, parts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }
    if (parts[1] === 'music-cues' && parts[2] && parts[3] === 'select') {
        if (!UUID_RE.test(parts[2])) return json(res, 400, { error: 'Invalid cue ID' });
        if (req.method === 'POST' || req.method === 'DELETE') return selectCueVersion(req, res, parts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }
    return false;
}

module.exports = { handleProductionGraph, selectShotVideo, selectCueVersion };
