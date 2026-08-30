/**
 * FILM-008: Shot creation from scene cards
 * FILM-010: Shotlist endpoint
 * FILM-141: Shot reorder + transition API
 *
 * POST /film/shots — create shots from scene cards (batch)
 * GET  /film/projects/:id/shotlist — aggregate shot list
 * PUT  /film/shots/:id/order — set sort_order for a shot
 * POST /film/projects/:id/shots/reorder — batch reorder shots
 * PUT  /film/shots/:id/transition — set transition metadata
 */
const { db, generateId } = require('../db/database');
const { stampShot } = require('../lib/screenplay-drift');
const { orderBySql } = require('../lib/running-order');
const { validateSceneCards, VALID_SHOT_TYPES, VALID_CAMERA_MOVES, VALID_LIGHTING,
    VALID_GEN_MODES, VALID_SENSORS } = require('../lib/scene-card-schema');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TRANSITIONS = [
    'cut', 'dissolve', 'cross-dissolve', 'fade-from-black', 'fade-from-white',
    'wipe-left', 'wipe-right', 'dip-to-black', 'dip-to-white',
];

/**
 * Remove a shot.
 *
 * Reports what went with it rather than a bare {deleted:true}. A shot can carry
 * generated frames and clips that cost money to make, and a caller — human or
 * agent — deserves to know whether it removed a placeholder or a day's work.
 * Assets fall away by foreign key; the count is read first so it can be said.
 */
function deleteShot(req, res, shotId) {
    const shot = db.prepare('SELECT id, shot_code FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Shot not found' }));
    }

    const assets = db.prepare('SELECT COUNT(*) AS n FROM film_assets WHERE shot_id = ?').get(shotId).n;
    db.prepare('DELETE FROM film_shots WHERE id = ?').run(shotId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true, shot_id: shotId, shot_code: shot.shot_code, assets_affected: assets }));
}

/**
 * Card blocks that MERGE rather than replace.
 *
 * `card[key] = body[key]` is right for a string and for a list, and wrong for
 * these two. A camera block carries more than any one caller is thinking about
 * — sensor, aperture, focus distance, height, and whatever previs wrote the last
 * time the shot was blocked — so setting `camera.note` replaced the lens, the
 * shot type and the movement on a real shot, in a single call, with no error.
 * The card stayed valid, so nothing downstream could tell it had happened.
 *
 * The editor already learned this and fixed it for itself ("rebuilding would
 * drop whatever previs wrote"). The route it posts to did not, so every other
 * caller — MCP, curl, a script — still had the destructive version. Fixed here
 * instead, which is the one place all of them pass through.
 *
 * Lists are deliberately NOT in this set. A merging array could never shorten,
 * so removing a character from a shot would become unsayable — the same class
 * of silent failure, pointing the other way.
 */
const MERGED_BLOCKS = new Set(['camera', 'lighting']);

/**
 * Merge one nested block, with `null` as the way to clear a single facet.
 *
 * Without an explicit clear, merging makes every value it holds permanent: a
 * camera note could be written and never taken back off. `null` erases and an
 * absent key means "leave it alone" — the same distinction the rest of this
 * route already draws between the fields a caller named and the ones it did not.
 */
function mergeBlock(existing, incoming) {
    if (incoming === null) return null;                        // clear the block itself
    if (typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
    const base = (existing && typeof existing === 'object' && !Array.isArray(existing))
        ? { ...existing } : {};
    for (const [k, v] of Object.entries(incoming)) {
        if (v === null) delete base[k];
        else base[k] = v;
    }
    return base;
}

/**
 * Edit a shot's scene card.
 *
 * There was no way to. PUT /shots/:id/order and /transition existed; the card
 * itself — the description every keyframe, clip and report is built from —
 * could only be written by whoever created the shot. So a director looking at a
 * frame that came back wrong had no way to change what it was generated from,
 * and the only remedy inside Film Engine was to regenerate from the same words.
 *
 * MERGES, never replaces. A card is a whole document; a PUT that swapped it
 * would quietly drop the dialogue every time someone fixed a typo in the
 * action.
 *
 * Validated like every other write to a card, because an edit route that
 * skipped validation would be the one way to get a broken card into the
 * database.
 */
function updateShotCard(req, res, shotId) {
    const shot = db.prepare('SELECT id, scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Shot not found' }));
    }

    let card = {};
    try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }

    const body = req.body || {};
    const EDITABLE = ['description', 'direction', 'action', 'camera', 'lighting', 'characters', 'props',
        'dialogue', 'sfx_cues', 'duration_seconds', 'notes', 'location_view'];
    const changed = [];
    for (const key of EDITABLE) {
        if (body[key] === undefined) continue;
        card[key] = MERGED_BLOCKS.has(key) ? mergeBlock(card[key], body[key]) : body[key];
        changed.push(key);
    }
    if (!changed.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Nothing to change. Editable: ${EDITABLE.join(', ')}` }));
    }

    const validation = validateSceneCards([card]);
    if (!validation.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'That would make the scene card invalid', details: validation.errors }));
    }

    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?').run(JSON.stringify(card), shotId);

    /*
     * A shot's own aspect ratio is a COLUMN, not a card field.
     *
     * It is a production decision about how this shot is SHOT — a vertical hero
     * or product shot is generated at 9:16 because a crop to it keeps 32% of the
     * width — rather than something the writing says, so it is not part of the
     * card's validated vocabulary and does not mark the card stale on its own.
     *
     * '' clears it back to inheriting the project's, which is what every shot
     * does by default; the two states are genuinely different and must not be
     * spelled the same way.
     */
    if (body.aspect_ratio !== undefined) {
        const want = String(body.aspect_ratio || '').trim();
        const { ASPECT_RATIO_IDS } = require('../lib/project-presets');
        if (want && !ASPECT_RATIO_IDS.includes(want)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                error: `Invalid aspect_ratio "${want}"`,
                valid: ASPECT_RATIO_IDS,
            }));
        }
        db.prepare('UPDATE film_shots SET aspect_ratio = ? WHERE id = ?').run(want, shotId);
        changed.push('aspect_ratio');
    }

    // Editing a card by hand is how a director answers a screenplay revision,
    // so this is where the drift warning clears. A warning that cannot be
    // cleared by doing the work it asks for is noise within a day.
    let rewrittenAgainst = null;
    try {
        const row = db.prepare('SELECT scene_id FROM film_shots WHERE id = ?').get(shotId);
        if (row && row.scene_id) rewrittenAgainst = stampShot(shotId, row.scene_id);
    } catch (_) { /* never fail an edit that already succeeded */ }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        shot_id: shotId, changed, card,
        scene_fingerprint: rewrittenAgainst,
        // Said plainly: anything generated from the old words no longer matches.
        note: 'Anything generated from this card is now stale. Check staleness before generating.',
    }));
}

/**
 * The vocabulary a scene card is allowed to use.
 *
 * The board showed "establishing · 40mm anamorphic · push-in · blue-hour" and
 * offered no way to change any of it, because the lists live in the validator
 * and the UI had no way to read them. Hardcoding them in the page would have
 * worked exactly once: a shot type added here would become an option the board
 * offers and the validator refuses, which is the failure the flows canvas
 * already learned to avoid by serving its palette from the registry.
 *
 * `lens` is deliberately absent. It is a free string on purpose — "40mm
 * anamorphic" and "50mm" and "24-70 at 35" are all things a director writes,
 * and a select would refuse two of the three.
 */
function cardVocabulary(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        prop_categories: require('../lib/prop-categories').PROP_CATEGORIES,
        prop_category_labels: require('../lib/prop-categories').PROP_CATEGORY_LABELS,
        shot_types: VALID_SHOT_TYPES,
        camera_moves: VALID_CAMERA_MOVES,
        lighting: VALID_LIGHTING,
        gen_modes: VALID_GEN_MODES,
        sensors: VALID_SENSORS,
    }));
}


/**
 * This module writes its responses directly, like most of routes/. One helper
 * defined here rather than imported under a different name — the board-lock
 * handlers called json() in a module that has no json(), every source-grep test
 * passed, and the route 500'd on its first real call.
 */
function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

/**
 * POST /film/shots/:id/insert-after — add a shot between two others.
 *
 * Numbered the way a script supervisor numbers an insert: a shot added after 2A
 * becomes **2AA**, and nothing else moves.
 *
 * The alternative — call it 2B and shift 2B→2C, 2C→2D — reads more tidily and
 * is what a clean-slate tool would do. Production does not do it, and the
 * reason applies here literally rather than by analogy: the existing codes are
 * already on the slate, the call sheet, the continuity notes and the editor's
 * bins. In this app they are also FILENAMES (`2B_v11.png`), rows in the render
 * ledger, and the word a director has been using for that shot all day.
 * Renumbering means moving every file every renamed shot ever generated, and a
 * half-applied rename orphans frames on a shot nobody touched.
 *
 * So the insert is additive. Repeated inserts after the same shot walk the
 * suffix — 2AA, then 2AB — so they stay in the order they were made.
 */
function insertShotAfter(req, res, afterShotId) {
    const body = req.body || {};
    const anchor = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(afterShotId);
    if (!anchor) return sendJson(res, 404, { error: 'Shot not found' });
    const scene = db.prepare('SELECT id, project_id FROM film_scenes WHERE id = ?').get(anchor.scene_id);
    if (!scene) return sendJson(res, 404, { error: 'Scene not found' });

    const card = Object.assign({}, body.card || {});
    if (!card.description || !String(card.description).trim()) {
        return sendJson(res, 400, {
            error: 'A shot with no description generates from nothing. Say what is in frame.',
        });
    }

    const siblings = db.prepare(
        'SELECT id, shot_code FROM film_shots WHERE scene_id = ? ORDER BY sort_order, shot_code')
        .all(scene.id);
    const at = siblings.findIndex(x => x.id === afterShotId);
    if (at === -1) return sendJson(res, 500, { error: 'That shot is not in its own scene' });

    // 2A -> 2AA; a second insert after the same shot -> 2AB. The walk keeps
    // repeated inserts in the order they were made rather than colliding.
    const used = new Set(siblings.map(x => String(x.shot_code || '').toUpperCase()));
    let newCode = anchor.shot_code + 'A';
    let guard = 0;
    while (used.has(newCode.toUpperCase()) && guard++ < 25) {
        newCode = newCode.slice(0, -1)
            + String.fromCharCode(newCode.charCodeAt(newCode.length - 1) + 1);
    }
    if (used.has(newCode.toUpperCase())) {
        return sendJson(res, 409, {
            error: `There are already 26 inserts after ${anchor.shot_code}.`,
            hint: 'Give this shot an explicit code instead.',
        });
    }

    card.shot_code = newCode;
    const validation = validateSceneCards([card]);
    if (!validation.valid) {
        return sendJson(res, 400, {
            error: 'That would make an invalid scene card',
            details: validation.errors,
        });
    }

    const newId = generateId();
    const following = siblings.slice(at + 1);
    try {
        db.transaction(() => {
            db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(newId, scene.id, newCode, JSON.stringify(card),
                    card.duration_ms || 0, at + 1, new Date().toISOString());
            // The new shot takes the next position; everything after it moves
            // down one. Order is what changed — the CODES deliberately did not.
            following.forEach((sib, i) => {
                db.prepare('UPDATE film_shots SET sort_order = ? WHERE id = ?').run(at + 2 + i, sib.id);
            });
        })();
    } catch (err) {
        return sendJson(res, 500, { error: 'Could not insert the shot: ' + err.message });
    }

    try { stampShot(newId); } catch (_) { /* drift stamping must not fail an insert */ }

    return sendJson(res, 201, {
        shot_id: newId,
        shot_code: newCode,
        scene_id: scene.id,
        after: anchor.shot_code,
        renamed: [],
        note: `${newCode} added after ${anchor.shot_code}. Nothing else was renamed — every code `
            + 'already written down still points at the same picture, which is how a script '
            + 'supervisor numbers an insert.',
    });
}

/**
 * Read one shot's scene card.
 *
 * There was a PUT and no GET. Editing a card meant listing a whole project to
 * find the one row you were about to write, which is a strange shape for an
 * API and a worse one for an agent — and it meant the editor could only ever
 * show the fields the storyboard panel happened to carry, rather than the card.
 */
function getShot(req, res, shotId) {
    const shot = db.prepare(
        `SELECT s.*, sc.scene_number, sc.location, sc.time_of_day,
                sc.description AS scene_description
           FROM film_shots s LEFT JOIN film_scenes sc ON sc.id = s.scene_id
          WHERE s.id = ?`).get(shotId);
    if (!shot) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Shot not found' }));
    }
    let card = {};
    try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        id: shot.id, shot_code: shot.shot_code, scene_id: shot.scene_id,
        scene_number: shot.scene_number, location: shot.location, time_of_day: shot.time_of_day,
        status: shot.status, duration_ms: shot.duration_ms, sort_order: shot.sort_order,
        card,
        // The screenplay this shot came from, alongside the card it became.
        //
        // Only the CARD reaches the prompt — `sceneCard.action || .description`
        // and nothing else — so any nuance the card did not restate is invisible
        // to generation. That is the right rule (a card is this shot, and
        // pasting the whole scene would describe things out of frame), but it
        // makes the card the only place the nuance can live, and whoever edits
        // one was working blind. Returning the source next to the card is what
        // lets an editor see what it is meant to be honouring.
        scene_text: shot.scene_description || '',
        note: 'Only `card` reaches the image prompt. `scene_text` is the screenplay it was derived from — anything in it the card does not say will not appear in the frame.',
    }));
}

function handleShots(req, res, urlParts, query) {
    // POST /film/shots — parts: ['film', 'shots']
    if (urlParts[1] === 'shots' && !urlParts[2] && req.method === 'POST') {
        return createShots(req, res);
    }

    // GET /film/card-vocabulary — what a card is allowed to say, from the
    // validator's own lists rather than a copy of them in the page.
    if (urlParts[1] === 'card-vocabulary' && req.method === 'GET') {
        return cardVocabulary(req, res);
    }

    // GET /film/shots/:id — read the card the PUT below writes.
    if (urlParts[1] === 'shots' && urlParts[2] && !urlParts[3] && req.method === 'GET') {
        return getShot(req, res, urlParts[2]);
    }

    // PUT /film/shots/:id — edit the scene card.
    if (urlParts[1] === 'shots' && urlParts[2] && !urlParts[3] && req.method === 'PUT') {
        return updateShotCard(req, res, urlParts[2]);
    }

    // DELETE /film/shots/:id — a shot could be created and never removed, by
    // the UI or by an agent. Every other entity had one.
    if (urlParts[1] === 'shots' && urlParts[2] && !urlParts[3] && req.method === 'DELETE') {
        return deleteShot(req, res, urlParts[2]);
    }

    // POST /film/shots/:id/insert-after — a shot between two others
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'insert-after' && req.method === 'POST') {
        return insertShotAfter(req, res, urlParts[2]);
    }

    // PUT /film/shots/:id/order
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'order' && req.method === 'PUT') {
        return setShotOrder(req, res, urlParts[2]);
    }

    // PUT /film/shots/:id/transition
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'transition' && req.method === 'PUT') {
        return setShotTransition(req, res, urlParts[2]);
    }

    // GET /film/projects/:id/shotlist — parts: ['film', 'projects', id, 'shotlist']
    if (urlParts[1] === 'projects' && urlParts[3] === 'shotlist' && req.method === 'GET') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project ID' }));
            return;
        }
        return getShotlist(req, res, projectId, query);
    }

    // POST /film/projects/:id/shots/reorder
    if (urlParts[1] === 'projects' && urlParts[3] === 'shots' && urlParts[4] === 'reorder' && req.method === 'POST') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project ID' }));
            return;
        }
        return reorderShots(req, res, projectId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function createShots(req, res) {
    const body = req.body;

    // Validate scene_id
    if (!body.scene_id || !UUID_RE.test(body.scene_id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid scene_id is required' }));
        return;
    }

    // Verify scene exists
    const scene = db.prepare('SELECT id FROM film_scenes WHERE id = ?').get(body.scene_id);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Scene not found' }));
        return;
    }

    // Validate scene cards
    if (!body.cards || !Array.isArray(body.cards)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cards array is required' }));
        return;
    }

    const validation = validateSceneCards(body.cards);
    if (!validation.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid scene cards', details: validation.errors }));
        return;
    }

    // Insert shots
    const insertStmt = db.prepare(`
        INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const selectStmt = db.prepare('SELECT * FROM film_shots WHERE id = ?');

    const inserted = [];
    for (const card of body.cards) {
        const shotId = generateId();
        const cardYaml = JSON.stringify(card, null, 2);
        const now = new Date().toISOString();

        insertStmt.run(shotId, body.scene_id, card.shot_code, cardYaml, card.duration_ms || 0, now);
        stampShot(shotId, body.scene_id);
        inserted.push(selectStmt.get(shotId));
    }

    // Update scene status to broken_down
    db.prepare(`
        UPDATE film_scenes SET status = 'broken_down'
        WHERE id = ? AND status = 'written'
    `).run(body.scene_id);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shots: inserted, count: inserted.length }));
}

function getShotlist(req, res, projectId, query) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 50));
    const offset = (page - 1) * limit;

    const rows = db.prepare(`
        SELECT
            s.id, s.shot_code, s.status, s.duration_ms, s.sort_order,
            s.transition_in_type, s.transition_in_duration_ms,
            s.transition_out_type, s.transition_out_duration_ms,
            s.created_at,
            sc.scene_number, sc.location, sc.time_of_day, sc.id AS scene_id
        FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ?
        ORDER BY ${orderBySql({ shots: 's', scenes: 'sc' })}
        LIMIT ? OFFSET ?
    `).all(projectId, limit, offset);

    const countRow = db.prepare(`
        SELECT COUNT(*) AS count FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ?
    `).get(projectId);

    const total = countRow.count;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shots: rows, total, page, limit }));
}

/**
 * PUT /film/shots/:id/order — set sort_order for a single shot
 */
function setShotOrder(req, res, shotId) {
    if (!UUID_RE.test(shotId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid shot ID' }));
        return;
    }

    const body = req.body;
    if (body.sort_order === undefined || typeof body.sort_order !== 'number') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sort_order (number) is required' }));
        return;
    }

    const result = db.prepare(
        'UPDATE film_shots SET sort_order = ? WHERE id = ?'
    ).run(Math.floor(body.sort_order), shotId);

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Shot not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

/**
 * POST /film/projects/:id/shots/reorder — batch reorder shots
 * Body: { shot_ids: [id1, id2, id3, ...] }
 * Sets sort_order = index position (0, 1, 2, ...)
 */
function reorderShots(req, res, projectId) {
    const body = req.body;
    if (!body.shot_ids || !Array.isArray(body.shot_ids)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'shot_ids array is required' }));
        return;
    }

    // Verify all IDs are valid UUIDs
    for (const id of body.shot_ids) {
        if (!UUID_RE.test(id)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Invalid shot ID: ${id}` }));
            return;
        }
    }

    const updateStmt = db.prepare('UPDATE film_shots SET sort_order = ? WHERE id = ?');
    const reorder = db.transaction(() => {
        for (let i = 0; i < body.shot_ids.length; i++) {
            updateStmt.run(i, body.shot_ids[i]);
        }
    });

    reorder();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reordered: body.shot_ids.length }));
}

/**
 * PUT /film/shots/:id/transition — set transition metadata
 * Body: { transition_in_type?, transition_in_duration_ms?, transition_out_type?, transition_out_duration_ms? }
 */
function setShotTransition(req, res, shotId) {
    if (!UUID_RE.test(shotId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid shot ID' }));
        return;
    }

    const body = req.body;
    const fields = [];
    const values = [];

    if (body.transition_in_type !== undefined) {
        if (!VALID_TRANSITIONS.includes(body.transition_in_type)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Invalid transition_in_type. Valid: ${VALID_TRANSITIONS.join(', ')}` }));
            return;
        }
        fields.push('transition_in_type = ?');
        values.push(body.transition_in_type);
    }

    if (body.transition_in_duration_ms !== undefined) {
        const dur = parseInt(body.transition_in_duration_ms);
        if (isNaN(dur) || dur < 0 || dur > 10000) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'transition_in_duration_ms must be 0-10000' }));
            return;
        }
        fields.push('transition_in_duration_ms = ?');
        values.push(dur);
    }

    if (body.transition_out_type !== undefined) {
        if (!VALID_TRANSITIONS.includes(body.transition_out_type)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Invalid transition_out_type. Valid: ${VALID_TRANSITIONS.join(', ')}` }));
            return;
        }
        fields.push('transition_out_type = ?');
        values.push(body.transition_out_type);
    }

    if (body.transition_out_duration_ms !== undefined) {
        const dur = parseInt(body.transition_out_duration_ms);
        if (isNaN(dur) || dur < 0 || dur > 10000) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'transition_out_duration_ms must be 0-10000' }));
            return;
        }
        fields.push('transition_out_duration_ms = ?');
        values.push(dur);
    }

    if (fields.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid transition fields to update' }));
        return;
    }

    values.push(shotId);
    const result = db.prepare(
        `UPDATE film_shots SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Shot not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

module.exports = { handleShots, VALID_TRANSITIONS };
