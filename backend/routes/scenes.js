/**
 * Scene endpoints
 * GET /film/projects/:id/scenes — list scenes for a project
 * GET /film/scenes/:id — get single scene with shots
 * DELETE /film/scenes/:id — delete a scene and its shots
 * POST /film/projects/:id/scenes/delete — delete several scenes at once
 */
const { db } = require('../db/database');
const { spliceScene } = require('../lib/scene-splice');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleScenes(req, res, urlParts, query) {
    // /film/projects/:id/scenes — parts: ['film', 'projects', id, 'scenes']
    if (urlParts[1] === 'projects' && urlParts[3] === 'scenes') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project ID' }));
            return;
        }
        if (req.method === 'GET') return listScenes(req, res, projectId);
        // Bulk delete: a bad paste can produce dozens of junk scenes, and
        // removing them one at a time is its own punishment.
        if (req.method === 'POST' && urlParts[4] === 'delete') return deleteScenes(req, res, projectId);
    }

    // /film/scenes/:id — parts: ['film', 'scenes', id]
    if (urlParts[1] === 'scenes' && urlParts[2]) {
        const sceneId = urlParts[2];
        if (!UUID_RE.test(sceneId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid scene ID' }));
            return;
        }
        // /film/scenes/:id/anchor — which frame establishes this scene.
        // Its own path rather than a field on PUT /scenes/:id, because that
        // route is the Fountain splice and requires the replacement scene text;
        // pinning an anchor is not an edit to the screenplay.
        if (urlParts[3] === 'anchor') {
            if (req.method === 'PUT') return setSceneAnchor(req, res, sceneId);
            if (req.method === 'DELETE') return clearSceneAnchor(req, res, sceneId);
            if (req.method === 'GET') return getSceneAnchor(req, res, sceneId);
        }
        if (req.method === 'GET') return getScene(req, res, sceneId);
        if (req.method === 'PUT') return updateScene(req, res, sceneId);
        if (req.method === 'DELETE') return deleteScene(req, res, sceneId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function listScenes(req, res, projectId) {
    const rows = db.prepare(
        'SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number'
    ).all(projectId);

    // Attach shot counts per scene
    const countStmt = db.prepare('SELECT COUNT(*) AS count FROM film_shots WHERE scene_id = ?');
    for (const scene of rows) {
        scene.shot_count = countStmt.get(scene.id).count;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scenes: rows }));
}

function getScene(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);

    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Scene not found' }));
        return;
    }

    // Include shots
    const shots = db.prepare(
        'SELECT * FROM film_shots WHERE scene_id = ? ORDER BY shot_code'
    ).all(sceneId);

    scene.shots = shots;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scene));
}


/**
 * Count what a scene deletion takes with it.
 *
 * Shots cascade, and everything hanging off a shot — versions, notes, render
 * ledger entries — goes with them. Scene-linked assets such as score and
 * ambient are unlinked rather than deleted, so the audio files survive on disk
 * and in the asset registry. Callers surface these numbers before confirming,
 * because "delete scene" reads much smaller than what it actually does.
 */
function sceneImpact(sceneId) {
    const shots = db.prepare('SELECT COUNT(*) AS c FROM film_shots WHERE scene_id = ?').get(sceneId).c;
    let assets = 0;
    try {
        assets = db.prepare('SELECT COUNT(*) AS c FROM film_assets WHERE scene_id = ?').get(sceneId).c;
    } catch (_) { /* column added in a later migration */ }
    return { shots, unlinked_assets: assets };
}

function deleteScene(req, res, sceneId) {
    const scene = db.prepare('SELECT id, scene_number, location FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Scene not found' }));
        return;
    }

    const impact = sceneImpact(sceneId);
    db.prepare('DELETE FROM film_scenes WHERE id = ?').run(sceneId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true, scene, ...impact }));
}

/**
 * Delete several scenes in one transaction.
 *
 * All or nothing: a partial bulk delete would leave the user unable to tell
 * which scenes survived, and re-running it would compound the confusion.
 */
function deleteScenes(req, res, projectId) {
    const body = req.body || {};
    const ids = Array.isArray(body.scene_ids) ? body.scene_ids : null;
    if (!ids || ids.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scene_ids array is required' }));
        return;
    }
    if (ids.some(id => !UUID_RE.test(id))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'scene_ids contains an invalid ID' }));
        return;
    }

    // Only scenes belonging to this project — an id from another project must
    // not be deletable by addressing it through this one.
    const placeholders = ids.map(() => '?').join(',');
    const owned = db.prepare(
        `SELECT id FROM film_scenes WHERE project_id = ? AND id IN (${placeholders})`
    ).all(projectId, ...ids).map(r => r.id);

    if (owned.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No matching scenes in this project' }));
        return;
    }

    let shots = 0;
    let unlinked = 0;
    for (const id of owned) {
        const impact = sceneImpact(id);
        shots += impact.shots;
        unlinked += impact.unlinked_assets;
    }

    const del = db.prepare('DELETE FROM film_scenes WHERE id = ?');
    db.transaction(() => { for (const id of owned) del.run(id); })();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        deleted: owned.length,
        // Reported so a caller passing ids from a stale list can tell that some
        // were already gone rather than assuming everything was removed.
        requested: ids.length,
        shots_deleted: shots,
        assets_unlinked: unlinked,
    }));
}

/**
 * Rewrite one scene, in the screenplay, leaving every other byte alone.
 *
 * The screenplay is the source and `film_scenes` is a projection of it, so
 * writing a scene's description directly would put the two out of step
 * immediately — the row would say one thing and the document another, and every
 * report built on either would be right about the wrong text.
 *
 * Requiring a whole-document rewrite instead is its own bug, though: the caller
 * has to reproduce every OTHER scene faithfully, and the cost of one stray
 * reflow is silent — scene 1's shots get marked as behind and a director redoes
 * work nobody asked for. So this splices the new scene into the Fountain and
 * saves the result through the same path a full rewrite uses: one new version,
 * scenes reconciled, ids preserved, shots intact.
 *
 * PUT /film/scenes/:id  { fountain: "EXT. STREET - DUSK\n\n..." }
 */
function updateScene(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }

    const text = String((req.body && req.body.fountain) || '').trim();
    if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: 'fountain is required: the replacement scene, starting with its own scene heading',
        }));
    }

    const script = db.prepare(
        'SELECT * FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(scene.project_id);
    if (!script || !script.fountain_content) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: 'This project has no Fountain screenplay to edit. Upload one with script_write first.',
        }));
    }

    // Position, not id. The document knows scenes by order; the row knows them
    // by number, and film_scenes.scene_number has INTEGER affinity so it may
    // come back as 2 or '2A'. Ordering the rows the same way the reconciler
    // matched them is the only mapping that cannot drift.
    const ordered = db.prepare(
        `SELECT id FROM film_scenes WHERE project_id = ? AND status != 'removed'
          ORDER BY CAST(scene_number AS INTEGER), scene_number`).all(scene.project_id);
    const index = ordered.findIndex(r => r.id === sceneId);
    if (index < 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'That scene has been removed from the screenplay.' }));
    }

    let next;
    try {
        next = spliceScene(script.fountain_content, index, text);
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message, code: err.code }));
    }

    if (next === script.fountain_content) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            scene_id: sceneId, changed: false,
            note: 'That is what the scene already says. No version was saved, and nothing is now behind.',
        }));
    }

    // Straight through the same save a full rewrite takes, so there is one
    // reconciler, one versioning rule and one set of bugs.
    const { handleScripts } = require('./scripts');
    return handleScripts(
        { method: 'POST', body: { fountain_content: next, sync_scenes: true } },
        res, ['film', 'projects', scene.project_id, 'script'], {});
}

// ── The frame a scene is measured against ───────────────────────────────
//
// The anchor is DERIVED by default — the first shot in the scene that has a
// frame — and this pins it instead. The pin exists because the first shot of a
// scene is frequently an insert or a detail, and conditioning eight frames on a
// close-up of a doorknob is exactly the wrong picture. Only a director can say
// which frame establishes a scene.

/** The scene's anchor, asked without a vantage shot. */
function sceneAnchorAt(sceneId, pinnedShotId) {
    const { pickAnchor } = require('../lib/scene-anchor');
    const shots = db.prepare(
        `SELECT s.id, s.shot_code,
                (SELECT COUNT(*) FROM film_assets a
                  WHERE a.shot_id = s.id AND a.asset_type IN ('storyboard', 'keyframe')) AS frames
           FROM film_shots s WHERE s.scene_id = ? ORDER BY s.shot_code`).all(sceneId)
        .map(r => ({ id: r.id, shot_code: r.shot_code, has_frame: r.frames > 0 }));
    return pickAnchor(shots, null, pinnedShotId);
}

function sceneAnchorPayload(sceneId) {
    const scene = db.prepare('SELECT id, anchor_shot_id FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return null;
    // Resolved from NO vantage shot: the question here is which frame the scene
    // is measured against, not whether some particular shot may use it. Asking
    // on behalf of a shot that turns out to BE the anchor answers "you are
    // standing on it", which reads as the scene having none.
    const resolved = sceneAnchorAt(sceneId, scene.anchor_shot_id);
    return {
        scene_id: sceneId,
        pinned_shot_id: scene.anchor_shot_id || null,
        anchor_shot_code: resolved && resolved.shot ? resolved.shot.shot_code : null,
        pinned: !!(resolved && resolved.pinned),
        reason: resolved ? resolved.reason : null,
        note: 'Every other shot in this scene is generated FROM this frame: the same location, '
            + 'the same set dressing and the same subjects where they stand in it, re-shot on '
            + 'whatever lens and angle that shot\u2019s own card asks for. Plates for subjects '
            + 'already standing in it are not sent, since the frame has established them. Fixed '
            + 'rather than chained to the previous shot, so drift cannot accumulate down the scene.',
    };
}

function getSceneAnchor(req, res, sceneId) {
    const payload = sceneAnchorPayload(sceneId);
    if (!payload) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function setSceneAnchor(req, res, sceneId) {
    const scene = db.prepare('SELECT id FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }
    const shotId = String((req.body && req.body.shot_id) || '').trim();
    if (!shotId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'shot_id is required: which frame establishes this scene' }));
    }
    // A shot from another scene would be accepted by the foreign key and then
    // silently ignored by the resolver, which is the worst of both.
    const shot = db.prepare('SELECT id, shot_code, scene_id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot || shot.scene_id !== sceneId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: 'That shot is not in this scene. An anchor is what THIS scene looks like.',
        }));
    }
    db.prepare('UPDATE film_scenes SET anchor_shot_id = ? WHERE id = ?').run(shotId, sceneId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...sceneAnchorPayload(sceneId), pinned_shot_code: shot.shot_code }));
}

function clearSceneAnchor(req, res, sceneId) {
    const scene = db.prepare('SELECT id FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }
    db.prepare('UPDATE film_scenes SET anchor_shot_id = NULL WHERE id = ?').run(sceneId);
    // Unpinning falls back to the derived anchor rather than to nothing: the
    // scene still has a first framed shot, and reporting "no anchor" here would
    // read as the feature having been turned off.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...sceneAnchorPayload(sceneId), unpinned: true }));
}

module.exports = { handleScenes };
