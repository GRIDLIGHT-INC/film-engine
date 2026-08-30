'use strict';

/**
 * -- The output list ---------------------------------------------------------
 *
 * One row per file that leaves the job. HTTP dispatch and persistence only:
 * every decision lives in `lib/deliverables.js`, which is pure and testable
 * without a database — the `pipeline-engine.js` / `routes/pipeline.js` split,
 * for the same reason.
 *
 * `…/check` is FREE and comes before anything is generated, on the rule the
 * whole engine follows: the free preview leads the paid path. It is also the
 * surface that answers the question the deliverable set exists to answer —
 * which ratios must be SHOT rather than cropped.
 */

const { db, generateId } = require('../db/database');
const {
    DELIVERY_PROFILES, PACKAGES, planDeliverables, nativeRatiosFor,
    frameCount, validateDeliverable,
} = require('../lib/deliverables');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/** The columns a caller may write. Machine fields are not in this list. */
const EDITABLE = ['key', 'label', 'profile_id', 'aspect_ratio', 'width', 'height', 'fps',
    'duration_ms', 'platform', 'loudness_target', 'caption_mode', 'native', 'sort_order',
    'status', 'notes'];

function rowsFor(projectId) {
    return db.prepare('SELECT * FROM film_deliverables WHERE project_id = ? ORDER BY sort_order, created_at')
        .all(projectId);
}

function listDeliverables(res, projectId) {
    const rows = rowsFor(projectId);
    json(res, 200, {
        project_id: projectId,
        deliverables: rows,
        count: rows.length,
        /*
         * The profiles and packages are SERVED, never retyped into the page:
         * the route validates against them, so a page holding its own copy
         * offers a platform the route refuses — and the refusal reads as saving
         * being broken. The rule GET /film/card-vocabulary already sets.
         */
        profiles: DELIVERY_PROFILES,
        packages: Object.keys(PACKAGES),
        native_ratios: nativeRatiosFor(rows),
    });
}

function insertRow(projectId, row) {
    const id = generateId();
    db.prepare(`INSERT INTO film_deliverables
        (id, project_id, key, label, profile_id, aspect_ratio, width, height, fps, duration_ms,
         platform, loudness_target, caption_mode, native, sort_order, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, projectId, row.key || '', row.label || '', row.profile_id || '',
            row.aspect_ratio || '16:9', Number(row.width) || 1920, Number(row.height) || 1080,
            Number(row.fps) || 29.97, Number(row.duration_ms) || 30000, row.platform || '',
            row.loudness_target || '', row.caption_mode || 'sidecar',
            row.native ? 1 : 0, Number(row.sort_order) || 0, row.status || 'planned', row.notes || '');
    return id;
}

function createDeliverable(req, res, projectId) {
    const body = req.body || {};
    const check = validateDeliverable({ ...body, key: body.key || 'untitled' });
    if (!check.valid) return json(res, 400, { error: 'Invalid deliverable', details: check.errors });
    const id = insertRow(projectId, body);
    json(res, 201, { deliverable: db.prepare('SELECT * FROM film_deliverables WHERE id = ?').get(id) });
}

/**
 * Apply a package preset.
 *
 * REPLACES the existing set by default and says so, because a package is a
 * statement about the whole job rather than an addition to it — applying
 * `campaign` twice should not leave twelve rows. `append` keeps what is there
 * for the case where a client adds a placement mid-campaign.
 */
function planRoute(req, res, projectId) {
    const body = req.body || {};
    let rows;
    try {
        rows = planDeliverables(body.package, body.overrides);
    } catch (err) {
        return json(res, 400, { error: err.message, packages: Object.keys(PACKAGES) });
    }
    /*
     * The package also decides the project's SHAPE and RATE.
     *
     * Applying a package set the list of files and left aspect_ratio,
     * target_resolution and target_fps at whatever a FILM defaults to — and a
     * spot generated at 24fps for a 29.97 buy cannot be conformed afterwards.
     *
     * Only where the caller has not already chosen: `settings: false` leaves
     * them alone, for the case where a director has deliberately set the
     * project up and is adding a package to it.
     */
    let applied = null;
    if (body.settings !== false) {
        const { settingsForPackage } = require('../lib/deliverables');
        /*
         * The package PROPOSES; a rate the director has already chosen stands.
         *
         * This ran an unconditional SET target_fps, so a project deliberately
         * cut at 24fps had it silently replaced by the package's air rate --
         * and `target_fps` is read by the conform and the NLE exporters and by
         * nothing else, so it was never a generation constraint to begin with.
         * Where the two differ, `rate_note` names the conversion the
         * deliverable needs rather than refusing the choice.
         */
        const current = db.prepare('SELECT target_fps FROM film_projects WHERE id = ?').get(projectId);
        applied = settingsForPackage(body.package, current);
        db.prepare(`UPDATE film_projects
                       SET aspect_ratio = ?, target_resolution = ?, target_fps = ?
                     WHERE id = ?`)
            .run(applied.aspect_ratio, applied.target_resolution, applied.target_fps, projectId);
    }

    const existing = rowsFor(projectId);
    if (!body.append && existing.length) {
        db.prepare('DELETE FROM film_deliverables WHERE project_id = ?').run(projectId);
    }
    const offset = body.append ? existing.length : 0;
    const ids = rows.map((r, i) => insertRow(projectId, { ...r, sort_order: offset + i }));
    const after = rowsFor(projectId);
    json(res, 201, {
        project_id: projectId,
        package: body.package,
        created: ids.length,
        replaced: body.append ? 0 : existing.length,
        deliverables: after,
        native_ratios: nativeRatiosFor(after),
        // What the project was set to, and why — a change to the frame rate is
        // not something to discover later on an export.
        project_settings: applied,
    });
}

function getDeliverable(res, id) {
    const row = db.prepare('SELECT * FROM film_deliverables WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Deliverable not found' });
    json(res, 200, { deliverable: row });
}

/** MERGES. A deliverable is a whole spec, and a replace would drop the fields
 *  the caller was not asked about — the rule provider_config learned the hard way. */
function updateDeliverable(req, res, id) {
    const row = db.prepare('SELECT * FROM film_deliverables WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Deliverable not found' });
    const body = req.body || {};
    const merged = { ...row };
    for (const f of EDITABLE) if (body[f] !== undefined) merged[f] = body[f];
    const check = validateDeliverable(merged);
    if (!check.valid) return json(res, 400, { error: 'Invalid deliverable', details: check.errors });

    const sets = [];
    const vals = [];
    for (const f of EDITABLE) {
        if (body[f] === undefined) continue;
        sets.push(`${f} = ?`);
        vals.push(f === 'native' ? (body[f] ? 1 : 0) : body[f]);
    }
    if (!sets.length) return json(res, 400, { error: 'No fields to update' });
    vals.push(id);
    db.prepare(`UPDATE film_deliverables SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...vals);
    json(res, 200, { deliverable: db.prepare('SELECT * FROM film_deliverables WHERE id = ?').get(id) });
}

function deleteDeliverable(res, id) {
    const row = db.prepare('SELECT * FROM film_deliverables WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Deliverable not found' });
    db.prepare('DELETE FROM film_deliverables WHERE id = ?').run(id);
    json(res, 200, { deleted: true, id });
}

/**
 * The verdict. FREE — reads rows and does arithmetic, generates nothing.
 *
 * Two questions, and the second is the one the whole subsystem exists for:
 * does the cut hit the runtime each deliverable is bought at, and which ratios
 * must be SHOT rather than cropped.
 */
function checkRoute(res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const rows = rowsFor(projectId);

    const { coverageFor, foldShots, measuredDurations } = require('../lib/clip-coverage');
    const { orderBySql } = require('../lib/running-order');
    const shots = db.prepare(`
        SELECT sh.id, sh.shot_code, sh.duration_ms, sh.scene_id, sh.aspect_ratio
          FROM film_shots sh JOIN film_scenes s ON sh.scene_id = s.id
         WHERE s.project_id = ? ORDER BY ${orderBySql('s', 'sh')}`).all(projectId);
    const folded = foldShots(shots, coverageFor(db, projectId), measuredDurations(db, projectId)).shots;
    const totalMs = folded.reduce((n, s) => n + (s.duration_ms || 0), 0);

    const target = Number(project.target_duration_ms) || 0;
    const perDeliverable = rows.map(d => {
        const frames = frameCount(d.duration_ms, d.fps);
        const overMs = totalMs - d.duration_ms;
        return {
            id: d.id, key: d.key, label: d.label,
            aspect_ratio: d.aspect_ratio, width: d.width, height: d.height, fps: d.fps,
            duration_ms: d.duration_ms, frames,
            /*
             * A ONE-FRAME tolerance, stated rather than assumed: a cut is
             * measured in whole frames and a target expressed in milliseconds
             * cannot always land on one exactly.
             */
            cut_ms: totalMs,
            over_ms: overMs,
            fits: Math.abs(overMs) <= Math.ceil(1000 / d.fps),
        };
    });

    const native = nativeRatiosFor(rows);
    const shotsNative = folded.filter(s => s.aspect_ratio).map(s => s.shot_code);
    json(res, 200, {
        project_id: projectId,
        cut_duration_ms: totalMs,
        target_duration_ms: target,
        /*
         * A target of 0 is "no target", which is every film ever made in this
         * tool — reported as `null` rather than as a failure to hit zero.
         */
        on_target: target ? Math.abs(totalMs - target) <= 40 : null,
        deliverables: perDeliverable,
        native_ratios: native,
        shots_flagged_native: shotsNative,
        /*
         * The actionable line. A native ratio nothing is flagged for means every
         * vertical placement will be a crop of the master, losing two-thirds of
         * the width — which is invisible until the client sees the cut.
         */
        needs_native_shots: native.length > 0 && shotsNative.length === 0,
        free: true,
    });
}

function handleDeliverables(req, res, urlParts, query) {
    // /film/projects/:id/deliverables[/plan|/check]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'deliverables') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });
        const sub = urlParts[4];
        if (sub === 'plan' && req.method === 'POST') return planRoute(req, res, projectId);
        if (sub === 'check' && req.method === 'GET') return checkRoute(res, projectId);
        if (!sub) {
            if (req.method === 'GET') return listDeliverables(res, projectId);
            if (req.method === 'POST') return createDeliverable(req, res, projectId);
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/deliverables/:id
    if (urlParts[1] === 'deliverables' && urlParts[2]) {
        const id = urlParts[2];
        if (req.method === 'GET') return getDeliverable(res, id);
        if (req.method === 'PUT') return updateDeliverable(req, res, id);
        if (req.method === 'DELETE') return deleteDeliverable(res, id);
        return json(res, 405, { error: 'Method not allowed' });
    }

    return json(res, 404, { error: 'Not found' });
}

/*
 * EDITABLE is exported so the manual-edit audit can derive its denominator from
 * the route's OWN field list rather than from a regex over the handler body.
 * The list is the authority on what a caller may write; a scan that infers it
 * is only as good as the parameter names it happens to guess.
 */
module.exports = { handleDeliverables, EDITABLE };
