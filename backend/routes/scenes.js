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
        // /film/scenes/:id/edit — change named phrases in place
        if (urlParts[3] === 'edit' && req.method === 'POST') {
            return editScene(req, res, sceneId);
        }
        // /film/scenes/:id/card — what the scene is ABOUT, beside what it says
        if (urlParts[3] === 'card') {
            if (req.method === 'PUT') return writeSceneCard(req, res, sceneId);
            if (req.method === 'GET') return readSceneCard(req, res, sceneId);
        }
        // /film/scenes/:id/history[/:version/restore] — derived from the script
        // versions we already keep. No table.
        if (urlParts[3] === 'history') {
            if (urlParts[4] && urlParts[5] === 'restore' && req.method === 'POST') {
                return restoreSceneVersion(req, res, sceneId, urlParts[4]);
            }
            if (req.method === 'GET') return sceneHistory(req, res, sceneId);
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

    /*
     * How many spoken lines each scene holds.
     *
     * Because a control that cannot work should say so BEFORE it is pressed.
     * The table-read button was offered on every scene, and on a scene with no
     * dialogue it wrote one line into the status bar at the foot of the screen
     * and did nothing else — indistinguishable from a broken button, and
     * reported as exactly that.
     *
     * Counted in ONE pass over the script rather than per scene: only
     * scene_heading rows carry a scene_number, so the lines belonging to a
     * scene are the ones between its heading and the next.
     */
    const script = db.prepare(
        'SELECT id FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1'
    ).get(projectId);
    const lines = {};
    if (script) {
        let current = null;
        for (const el of db.prepare(
            'SELECT element_type, scene_number FROM film_script_elements WHERE script_id = ? ORDER BY element_index'
        ).all(script.id)) {
            const type = String(el.element_type || '').replace(/_/g, '-');
            if (type === 'scene-heading') { current = String(el.scene_number); lines[current] = lines[current] || 0; continue; }
            if (type === 'dialogue' && current !== null) lines[current] = (lines[current] || 0) + 1;
        }
    }
    for (const scene of rows) {
        scene.dialogue_lines = lines[String(scene.scene_number)] || 0;
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
// ── Surgical edit ───────────────────────────────────────────────────────
//
// `updateScene` replaces a whole scene, which for a one-line change means
// re-sending every other line and trusting the model reproduced them exactly.
// It usually does; when it does not, the diff blames the wrong sentence and the
// scene quietly becomes something nobody wrote.
//
// This changes named phrases in place. Three rules make it usable by an agent:
// a phrase must match EXACTLY ONCE unless `all` is set, a phrase that is not
// there is a failure rather than a no-op, and **if any edit in a batch fails,
// none are written**. The last one is what turns "commit and hope" into "try
// it": a batch that applies two of three changes leaves a scene that cannot be
// reconstructed from either the before or the after.

function editScene(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }
    const edits = Array.isArray(req.body && req.body.edits) ? req.body.edits : [];
    if (!edits.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: 'edits is required: [{ find, replace, all? }]',
            hint: 'Each `find` must appear exactly once in the scene unless you pass all: true.',
        }));
    }

    const script = db.prepare(
        'SELECT * FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(scene.project_id);
    if (!script || !script.fountain_content) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'This project has no Fountain screenplay to edit.' }));
    }

    const ordered = db.prepare(
        `SELECT id FROM film_scenes WHERE project_id = ? AND status != 'removed'
          ORDER BY CAST(scene_number AS INTEGER), scene_number`).all(scene.project_id);
    const positional = ordered.findIndex(r => r.id === sceneId);
    if (positional < 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'That scene is not in the current screenplay.' }));
    }
    // Checked, not assumed: the phrase is found in THIS scene's text, not in
    // whichever scene sits at its position after an autosave.
    const found = locateSceneSpan(scene, script.fountain_content, positional);
    if (found.error) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(found.error));
    }

    const lines = script.fountain_content.split('\n');
    const span = found.span;
    let text = lines.slice(span.start, span.end + 1).join('\n');

    // DRY RUN FIRST. Every edit is checked against the scene before any is
    // applied, so a batch that cannot succeed writes nothing at all.
    const problems = [];
    let probe = text;
    for (const [i, e] of edits.entries()) {
        const find = String((e && e.find) || '');
        if (!find) { problems.push(`edit ${i + 1}: no \`find\``); continue; }
        const count = probe.split(find).length - 1;
        if (count === 0) {
            problems.push(`edit ${i + 1}: "${find}" does not appear in this scene`);
        } else if (count > 1 && !(e && e.all)) {
            problems.push(
                `edit ${i + 1}: "${find}" appears ${count} times — pass all: true, or quote more of the line`);
        } else {
            probe = e && e.all
                ? probe.split(find).join(String(e.replace || ''))
                : probe.replace(find, String(e.replace || ''));
        }
    }
    if (problems.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: `${problems.length} of ${edits.length} edit(s) cannot be applied, so NONE were applied.`,
            problems,
            note: 'The batch is all-or-nothing on purpose: applying some of it would leave a scene '
                + 'that is neither what you had nor what you asked for.',
        }));
    }

    let applied = 0;
    for (const e of edits) {
        const find = String(e.find);
        if (e.all) {
            applied += text.split(find).length - 1;
            text = text.split(find).join(String(e.replace || ''));
        } else {
            applied += 1;
            text = text.replace(find, String(e.replace || ''));
        }
    }

    // Through the same splice a whole-scene rewrite takes: one reconciler, one
    // versioning rule. And it DOES mark the scene changed — this is screenplay
    // text, so anything generated from it is now behind, and staying quiet
    // would be worse than the false-drift problem it superficially resembles.
    const wrapped = new Proxy(res, {
        get(target, prop) {
            if (prop !== 'end') return typeof target[prop] === 'function'
                ? target[prop].bind(target) : target[prop];
            return function (chunk) {
                let payload = {};
                try { payload = JSON.parse(String(chunk || '{}')); } catch (_) { payload = {}; }
                return target.end(JSON.stringify({
                    ...payload, edits_applied: applied,
                    note: `${applied} change(s) made in place. Everything else in the scene, and every `
                        + 'other scene, is byte-identical.',
                }));
            };
        },
    });
    return updateScene({ ...req, body: { fountain: text } }, wrapped, sceneId);
}

// ── Scene cards ─────────────────────────────────────────────────────────
//
// What a scene is ABOUT, beside what it says. Conflict and outcome cannot live
// in the Fountain — a synopsis line is prose you cannot sort on — so they are
// columns on film_scenes, which is safe only because reconciliation rewrites
// exactly int_ext/location/time_of_day/description/characters_present and
// because scene ids now survive a revision.

const CARD_FIELDS = ['pov_character', 'conflict', 'outcome'];

function readSceneCard(req, res, sceneId) {
    const row = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        scene_id: sceneId,
        heading: `${row.int_ext || ''} ${row.location || ''}`.trim(),
        card: Object.fromEntries(CARD_FIELDS.map(f => [f, row[f] || ''])),
        note: 'Authored metadata, not screenplay text. Writing it does NOT mark the scene as changed, '
            + 'so nothing generated from it is reported as behind.',
    }));
}

function writeSceneCard(req, res, sceneId) {
    const row = db.prepare('SELECT id FROM film_scenes WHERE id = ?').get(sceneId);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }
    const body = req.body || {};
    const sets = [];
    const vals = [];
    for (const f of CARD_FIELDS) {
        if (body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(String(body[f]).slice(0, 2000)); }
    }
    if (!sets.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Nothing to write. Fields: ${CARD_FIELDS.join(', ')}` }));
    }
    vals.push(sceneId);
    db.prepare(`UPDATE film_scenes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    // stampScene is NOT called. A card is authored metadata rather than
    // screenplay text, and restamping would report every shot in the scene as
    // behind because someone wrote down what the scene is about.
    return readSceneCard(req, res, sceneId);
}

// ── Per-scene history, derived ──────────────────────────────────────────
//
// No table. Every version of every scene is already in film_scripts — one full
// Fountain per version — so history is a view over documents we keep anyway, and
// a table would store what we can compute and then have to be kept in step with
// the documents it duplicates.
//
// A scene is traced through the versions by HEADING rather than by position,
// because position is exactly what a revision changes. Two scenes sharing a
// heading collapse into one history, which is a real limit and is reported
// rather than hidden.

function sceneTextIn(fountain, heading) {
    const { sceneSpans } = require('../lib/scene-splice');
    const lines = String(fountain || '').split('\n');
    const span = sceneSpans(fountain).find(sp => sp.heading.toUpperCase() === String(heading).toUpperCase());
    if (!span) return null;
    return lines.slice(span.start, span.end + 1).join('\n').replace(/\n+$/, '');
}

function sceneHistory(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }
    const heading = `${scene.int_ext || ''}. ${scene.location || ''}${scene.time_of_day ? ' - ' + scene.time_of_day : ''}`.trim();

    const versions = db.prepare(
        `SELECT version, fountain_content, created_at FROM film_scripts
          WHERE project_id = ? AND fountain_content IS NOT NULL ORDER BY version DESC`).all(scene.project_id);

    const history = [];
    let previous = null;
    for (const v of versions) {
        let text = sceneTextIn(v.fountain_content, heading);
        if (text === null) {
            // Try the heading as the parser would have written it at the time —
            // a scene renamed mid-draft has two headings and belongs to both.
            const alt = `${scene.int_ext || ''}. ${scene.location || ''}`.trim();
            text = sceneTextIn(v.fountain_content, alt);
        }
        if (text === null) continue;
        // Only versions where the text actually differs. A screenplay saved
        // fifty times has fifty versions and perhaps four in which this scene
        // moved, and listing the other forty-six is noise.
        if (text === previous) continue;
        history.push({ version: v.version, created_at: v.created_at, text, chars: text.length });
        previous = text;
    }

    const sameHeading = db.prepare(
        `SELECT COUNT(*) n FROM film_scenes WHERE project_id = ? AND location = ? AND status != 'removed'`)
        .get(scene.project_id, scene.location).n;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        scene_id: sceneId,
        heading,
        history,
        note: 'Derived from the saved script versions — nothing is stored per scene, so this cannot fall '
            + 'out of step with the screenplay. Only versions where this scene\u2019s text CHANGED are listed.',
        ...(sameHeading > 1 ? {
            warning: `${sameHeading} scenes in this project share the heading "${scene.location}". `
                + 'Their histories cannot be told apart and are merged here.',
        } : {}),
    }));
}

/**
 * Put an earlier version of one scene back.
 *
 * Forward, never backward: the old text is spliced in as a NEW script version,
 * exactly as restoring a storyboard frame writes a new frame version. Rewinding
 * would discard every change made since, to the whole screenplay, to undo one
 * scene.
 */
function restoreSceneVersion(req, res, sceneId, version) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }
    const row = db.prepare(
        'SELECT fountain_content FROM film_scripts WHERE project_id = ? AND version = ?')
        .get(scene.project_id, Number(version));
    if (!row || !row.fountain_content) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `No version ${version} for this project.` }));
    }

    const heading = `${scene.int_ext || ''}. ${scene.location || ''}${scene.time_of_day ? ' - ' + scene.time_of_day : ''}`.trim();
    let text = sceneTextIn(row.fountain_content, heading);
    if (text === null) text = sceneTextIn(row.fountain_content, `${scene.int_ext || ''}. ${scene.location || ''}`.trim());
    if (text === null) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: `Version ${version} does not contain a scene with heading "${heading}".`,
        }));
    }

    // Straight through the splice a normal scene edit uses, so there is one
    // reconciler and one versioning rule.
    return updateScene({ ...req, body: { fountain: text } }, res, sceneId);
}

/**
 * Where this scene is in the screenplay, checked rather than assumed.
 *
 * Scenes are matched to the document by POSITION among the scene rows, which
 * is only right while the rows and the document agree. The editor's autosave
 * changes the document without touching the rows, so a scene typed in above
 * this one made position 3 the wrong scene — and an edit overwrote its
 * neighbour's text, reporting success. So the heading at that position must
 * be this scene's; if it is not, the scene is found by its heading; and if
 * that is ambiguous or absent, the caller is refused rather than guessed for.
 */
function locateSceneSpan(scene, fountain, positionalIndex) {
    const { sceneSpans } = require('../lib/scene-splice');
    const spans = sceneSpans(fountain);
    const place = String(scene.location || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    const time = String(scene.time_of_day || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    const names = sp => {
        const n = ` ${String(sp.heading || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
        return !!place && n.includes(` ${place} `) && (!time || n.includes(` ${time} `));
    };
    if (positionalIndex >= 0 && spans[positionalIndex] && names(spans[positionalIndex])) {
        return { index: positionalIndex, span: spans[positionalIndex] };
    }
    const candidates = spans.filter(names);
    if (candidates.length === 1) return { index: candidates[0].index, span: candidates[0] };
    return {
        error: {
            error: 'The screenplay and the scene list are out of step, so this scene cannot be found in the '
                + 'document by position, and its heading ' + (candidates.length ? 'appears more than once' : 'is not in it')
                + '. Nothing was changed.',
            code: 'SCENES_OUT_OF_STEP',
            action: 'Save the screenplay (a new version reconciles the scene list), then edit the scene again.',
        },
    };
}

function updateScene(req, res, sceneId) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Scene not found' }));
    }

    /*
     * How this scene is PLAYED.
     *
     * Handled before the fountain requirement, because it is a property of the
     * scene rather than of its text — writing it must not require re-sending
     * the whole screenplay, and a splice must not be the price of a note about
     * performance.
     */
    if (req.body && req.body.delivery_direction !== undefined && req.body.fountain === undefined) {
        db.prepare('UPDATE film_scenes SET delivery_direction = ? WHERE id = ?')
            .run(String(req.body.delivery_direction || '').slice(0, 500), sceneId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            ...db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId),
            changed: true,
            note: 'Applies to every line in this scene that carries no parenthetical of its own. '
                + 'Lines already generated are unaffected until they are regenerated.',
        }));
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
    let index = ordered.findIndex(r => r.id === sceneId);
    if (index < 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'That scene has been removed from the screenplay.' }));
    }

    const found = locateSceneSpan(scene, script.fountain_content, index);
    if (found.error) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(found.error));
    }
    index = found.index;

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

module.exports = { handleScenes };
