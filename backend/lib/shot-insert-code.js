/**
 * The code an inserted shot gets (PGN-019), said once.
 *
 * Numbered the way a script supervisor numbers an insert: after 2A comes 2AA,
 * and a second insert after the same shot walks the suffix to 2AB — nothing
 * already written down is renamed. The insert route writes with this, and the
 * production graph's add palette previews with a mirror of it held equal by
 * tests/graph-add-palette.test.js, so the code a person is shown is the code
 * the shot gets.
 *
 * @returns {string|null} the next free code, or null when all 26 are taken.
 */
function nextInsertCode(anchorCode, usedCodes) {
    const used = new Set((usedCodes || []).map(c => String(c || '').toUpperCase()));
    let code = String(anchorCode || '') + 'A';
    let guard = 0;
    while (used.has(code.toUpperCase()) && guard++ < 25) {
        code = code.slice(0, -1) + String.fromCharCode(code.charCodeAt(code.length - 1) + 1);
    }
    return used.has(code.toUpperCase()) ? null : code;
}

/** The next `n` insert codes after an anchor, in order (2AA, 2AB, 2AC), or null when they run out. */
function insertCodes(anchorCode, usedCodes, n) {
    const used = [...(usedCodes || [])];
    const out = [];
    for (let i = 0; i < n; i++) {
        const c = nextInsertCode(anchorCode, used);
        if (!c) return null;
        out.push(c); used.push(c);
    }
    return out;
}

/** A card's own length, in milliseconds; 0 when it states none. */
function cardDurationMs(card) {
    const c = card || {};
    if (Number(c.duration_ms) > 0) return Math.round(Number(c.duration_ms));
    if (Number(c.duration_seconds) > 0) return Math.round(Number(c.duration_seconds) * 1000);
    return 0;
}

/**
 * Insert shots after an anchor, in order, as a script supervisor numbers
 * inserts: after 2A come 2AA, 2AB, 2AC, and nothing already written is
 * renamed — only the running order moves. The one way a shot is inserted, used
 * by the insert route and by the graph's coverage patterns, so the two cannot
 * come to number or order an insert differently.
 *
 * @returns {{ids, codes, scene_id, project_id, anchor_code}} | {{status, error, hint?, details?}}
 */
function insertShotsAfter(db, anchorId, cards, opts) {
    const o = opts || {};
    const anchor = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(anchorId);
    if (!anchor) return { status: 404, error: 'Shot not found' };
    const scene = db.prepare('SELECT id, project_id FROM film_scenes WHERE id = ?').get(anchor.scene_id);
    if (!scene) return { status: 404, error: 'Scene not found' };
    if (o.projectId && scene.project_id !== o.projectId) return { status: 404, error: 'That shot is not in this project' };
    const list = cards || [];
    if (!list.length) return { status: 400, error: 'Nothing to insert' };
    for (const c of list) {
        if (!c || !c.description || !String(c.description).trim()) {
            return { status: 400, error: 'A shot with no description generates from nothing. Say what is in frame.' };
        }
    }
    const siblings = db.prepare('SELECT id, shot_code FROM film_shots WHERE scene_id = ? ORDER BY sort_order, shot_code').all(scene.id);
    const at = siblings.findIndex(x => x.id === anchorId);
    if (at === -1) return { status: 500, error: 'That shot is not in its own scene' };
    const codes = insertCodes(anchor.shot_code, siblings.map(x => x.shot_code), list.length);
    if (!codes) return { status: 409, error: `There are already 26 inserts after ${anchor.shot_code}.`, hint: 'Give this shot an explicit code instead.' };
    const prepared = list.map((c, i) => ({ ...c, shot_code: codes[i] }));
    const { validateSceneCards } = require('./scene-card-schema');
    const validation = validateSceneCards(prepared);
    if (!validation.valid) return { status: 400, error: 'That would make an invalid scene card', details: validation.errors };

    const { generateId } = require('../db/database');
    const ids = prepared.map(() => generateId());
    const following = siblings.slice(at + 1);
    try {
        db.transaction(() => {
            const ins = db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?)`);
            prepared.forEach((c, i) => ins.run(ids[i], scene.id, c.shot_code, JSON.stringify(c),
                cardDurationMs(c), at + 1 + i, new Date().toISOString()));
            // Everything after the inserts moves down; the CODES deliberately do not.
            const move = db.prepare('UPDATE film_shots SET sort_order = ? WHERE id = ?');
            following.forEach((sib, i) => move.run(at + 1 + prepared.length + i, sib.id));
        })();
    } catch (err) {
        return { status: 500, error: 'Could not insert the shot: ' + err.message };
    }
    for (const id of ids) {
        try { require('./screenplay-drift').stampShot(id); } catch (_) { /* drift stamping must not fail an insert */ }
    }
    return { ids, codes, scene_id: scene.id, project_id: scene.project_id, anchor_code: anchor.shot_code };
}

module.exports = { nextInsertCode, insertCodes, insertShotsAfter, cardDurationMs };
