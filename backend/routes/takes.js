/**
 * Gap 5: take / select management ("circle takes").
 *
 * GET    /film/shots/:id/takes            — every take for a shot
 * POST   /film/versions/:id/select        — circle this take
 * DELETE /film/versions/:id/select        — un-circle
 * GET    /film/projects/:id/selects       — the selects reel, in cut order
 *
 * A take IS a version (film_shot_versions), so this adds selection semantics to
 * the existing version history rather than a parallel table that would drift.
 */
const { db } = require('../db/database');
const { orderShots } = require('../lib/timeline');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleTakes(req, res, urlParts) {
    // /film/shots/:id/takes
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'takes') {
        if (!UUID_RE.test(urlParts[2])) return badReq(res, 'Invalid shot ID');
        if (req.method === 'GET') return listTakes(req, res, urlParts[2]);
    }

    // /film/versions/:id/select
    if (urlParts[1] === 'versions' && urlParts[2] && urlParts[3] === 'select') {
        if (!UUID_RE.test(urlParts[2])) return badReq(res, 'Invalid version ID');
        if (req.method === 'POST') return selectTake(req, res, urlParts[2]);
        if (req.method === 'DELETE') return deselectTake(req, res, urlParts[2]);
    }

    // /film/projects/:id/selects
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'selects') {
        if (!UUID_RE.test(urlParts[2])) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listSelects(req, res, urlParts[2]);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

function notFound(res, msg) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

function listTakes(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return notFound(res, 'Shot not found');

    const takes = db.prepare(`
        SELECT v.*, r.prompt, r.seed, r.model_id, r.sampler, r.steps, r.guidance
        FROM film_shot_versions v
        LEFT JOIN render_ledger r ON v.render_ledger_id = r.id
        WHERE v.shot_id = ?
        ORDER BY v.version DESC
    `).all(shotId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        takes,
        count: takes.length,
        selected_id: (takes.find(t => t.is_select) || {}).id || null,
    }));
}

/**
 * Circle a take.
 *
 * At most one select per shot. SQLite can't express that as a constraint added
 * via ALTER TABLE, so it's enforced here: clearing the prior select and setting
 * the new one happen in a single transaction. Without the transaction, a crash
 * between the two statements leaves a shot with zero selects (silently losing
 * the director's choice) or two (making "the" select ambiguous).
 */
function selectTake(req, res, versionId) {
    const version = db.prepare('SELECT id, shot_id, is_select FROM film_shot_versions WHERE id = ?').get(versionId);
    if (!version) return notFound(res, 'Version not found');

    const note = ((req.body && req.body.note) || '').slice(0, 2000);
    const now = new Date().toISOString();

    const apply = db.transaction(() => {
        // Clear select_note too, matching deselectTake. Leaving a stale "best
        // performance" note on a take that is no longer circled reads as if two
        // takes were chosen.
        db.prepare(`
            UPDATE film_shot_versions
            SET is_select = 0, select_note = '', selected_at = NULL
            WHERE shot_id = ? AND id != ?
        `).run(version.shot_id, versionId);

        db.prepare(`
            UPDATE film_shot_versions
            SET is_select = 1, select_note = ?, selected_at = ?
            WHERE id = ?
        `).run(note, now, versionId);
    });
    apply();

    const updated = db.prepare('SELECT * FROM film_shot_versions WHERE id = ?').get(versionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ take: updated, shot_id: version.shot_id }));
}

function deselectTake(req, res, versionId) {
    const version = db.prepare('SELECT id, shot_id FROM film_shot_versions WHERE id = ?').get(versionId);
    if (!version) return notFound(res, 'Version not found');

    db.prepare(`
        UPDATE film_shot_versions
        SET is_select = 0, select_note = '', selected_at = NULL
        WHERE id = ?
    `).run(versionId);

    const updated = db.prepare('SELECT * FROM film_shot_versions WHERE id = ?').get(versionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ take: updated, shot_id: version.shot_id }));
}

/**
 * The selects reel: the chosen take for every shot, in cut order.
 *
 * Also reports shots that have takes but no circled one — the actionable gap a
 * director cares about ("11 of 18 shots have a select"), which is the whole
 * point of tracking selection rather than just storing versions.
 */
function listSelects(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return notFound(res, 'Project not found');

    const shots = db.prepare(`
        SELECT s.id, s.shot_code, s.scene_id, s.sort_order, s.duration_ms, sc.scene_number
        FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ?
    `).all(projectId);

    if (shots.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ selects: [], count: 0, shots_total: 0, shots_without_select: [] }));
        return;
    }

    const ordered = orderShots(shots);
    const placeholders = ordered.map(() => '?').join(',');
    const versions = db.prepare(`
        SELECT id, shot_id, version, is_select, select_note, selected_at,
               video_path, thumbnail_path, status
        FROM film_shot_versions
        WHERE shot_id IN (${placeholders})
    `).all(...ordered.map(s => s.id));

    const selectByShot = new Map();
    const takeCounts = new Map();
    for (const v of versions) {
        takeCounts.set(v.shot_id, (takeCounts.get(v.shot_id) || 0) + 1);
        if (v.is_select) selectByShot.set(v.shot_id, v);
    }

    const selects = [];
    const without = [];
    for (const shot of ordered) {
        const chosen = selectByShot.get(shot.id);
        const takes = takeCounts.get(shot.id) || 0;
        if (chosen) {
            selects.push({
                shot_id: shot.id,
                shot_code: shot.shot_code,
                scene_number: shot.scene_number,
                duration_ms: shot.duration_ms,
                take_count: takes,
                ...chosen,
            });
        } else {
            without.push({
                shot_id: shot.id,
                shot_code: shot.shot_code,
                scene_number: shot.scene_number,
                take_count: takes,
                // Distinguishes "nothing generated yet" from "generated several
                // and never chose" — different problems, different fixes.
                reason: takes === 0 ? 'no_takes' : 'not_circled',
            });
        }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        selects,
        count: selects.length,
        shots_total: ordered.length,
        shots_without_select: without,
        coverage: ordered.length ? Math.round((selects.length / ordered.length) * 100) : 0,
    }));
}

module.exports = { handleTakes };
