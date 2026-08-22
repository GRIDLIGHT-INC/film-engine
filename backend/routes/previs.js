/**
 * Phase 2: previs blocking over HTTP.
 *
 * GET    /film/shots/:id/previs         — the blocking, or null
 * PUT    /film/shots/:id/previs         — save it; re-saving replaces
 * DELETE /film/shots/:id/previs         — remove it
 * POST   /film/shots/:id/previs/solve   — where to stand for a shot type
 * GET    /film/previs/taxonomy          — the vocabulary the viewer draws from
 *
 * One handler export dispatched by parts[1], per ADR-002. The maths lives in
 * lib/previs-camera.js and lib/previs-blocking.js; this file does HTTP and
 * SQLite and nothing else, which is what lets a shot be solved from a route, a
 * batch job or a test with no server.
 */

const { db, generateId } = require('../db/database');
const { saveFile, serveFile } = require('../lib/file-storage');
const { EASINGS } = require('../lib/previs-blocking');
const {
    RIGS, MOVEMENTS, SHOT_TYPES,
    solveShot, samplePath, sampleSequence, rigCanPerform, defaultBlocking, resolveTarget,
    legTimings, DEFAULT_MOVE_MS,
    DEFAULT_EYE_HEIGHT_M, DEFAULT_SUBJECT_HEIGHT_M,
} = require('../lib/previs-blocking');
const { PRIMITIVES, primitiveGeometry } = require('../lib/previs-primitives');
const crypto = require('crypto');
const { validateSceneCards } = require('../lib/scene-card-schema');
const {
    SENSORS, LENS_KIT, APERTURES,
    sensorFor, fieldOfView, depthOfField, frameCoverage,
} = require('../lib/previs-camera');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

const parse = (text, fallback) => {
    try { return JSON.parse(text); } catch (_) { return fallback; }
};

// ── Row <-> blocking ────────────────────────────────────────────────────────

function loadBlocking(shotId) {
    const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    if (!row) return null;
    return {
        camera: parse(row.camera_json, {}),
        subject: parse(row.subject_json, {}),
        stage: parse(row.stage_json, {}),
        rig: row.rig,
        movement: row.movement,
        durationMs: row.duration_ms || 0,
        moves: parse(row.moves_json, []),
        subjects: parse(row.subjects_json, []),
        path: parse(row.path_json, []),
        updated_at: row.updated_at,
    };
}

/**
 * The single movement that best names a sequence: the leg that runs longest.
 *
 * `movement` is one column and a sequence is many legs, so something has to be
 * chosen. Weight is proportional to time, so the heaviest leg is what the shot
 * mostly does — and a viewer describing the move in one word would say the same
 * thing. Ties go to the first, which is the order they were authored in.
 */
function dominantMovement(moves) {
    if (!Array.isArray(moves) || !moves.length) return null;
    let best = null;
    for (const leg of moves) {
        if (!leg || !leg.movement) continue;
        const weight = Number(leg.weight) > 0 ? Number(leg.weight) : 1;
        if (!best || weight > best.weight) best = { movement: leg.movement, weight };
    }
    return best ? best.movement : null;
}

/**
 * Validate a blocking payload.
 *
 * The split that matters: ERRORS are things the maths cannot proceed from — an
 * unknown sensor, a focal length of zero. WARNINGS are things a production
 * would find awkward — a slider asked to crane. Previs is a thinking tool, so
 * an impossible rig choice must be reported and still saved; refusing it would
 * stop someone sketching a shot before deciding how to achieve it.
 */
function validateBlocking(body) {
    const errors = [];
    const warnings = [];

    const camera = body.camera || {};
    const rig = body.rig || 'dolly';
    const movement = body.movement || 'static';

    if (!RIGS[rig]) errors.push(`rig must be one of: ${Object.keys(RIGS).join(', ')}`);
    if (!MOVEMENTS[movement]) errors.push(`movement must be one of: ${Object.keys(MOVEMENTS).join(', ')}`);

    const sensorId = camera.sensorId || 'super35';
    if (!SENSORS[sensorId]) errors.push(`camera.sensorId must be one of: ${Object.keys(SENSORS).join(', ')}`);

    if (camera.focalMm !== undefined && !(typeof camera.focalMm === 'number' && camera.focalMm > 0)) {
        errors.push('camera.focalMm must be a positive focal length in millimetres');
    }
    if (camera.fStop !== undefined && !(typeof camera.fStop === 'number' && camera.fStop > 0)) {
        errors.push('camera.fStop must be a positive f-number');
    }
    for (const field of ['position', 'rotation']) {
        if (camera[field] !== undefined && (!Array.isArray(camera[field]) || camera[field].length !== 3
            || !camera[field].every(Number.isFinite))) {
            errors.push(`camera.${field} must be three finite numbers`);
        }
    }

    // Move legs. Each names a movement and may state how far in its own unit.
    const moves = Array.isArray(body.moves) ? body.moves : [];
    moves.forEach((leg, i) => {
        if (!leg || !MOVEMENTS[leg.movement]) { errors.push(`moves[${i}].movement is not a known movement`); return; }
        if (leg.amount !== undefined && !(typeof leg.amount === 'number' && Number.isFinite(leg.amount) && leg.amount >= 0)) {
            errors.push(`moves[${i}].amount must be a non-negative number of ${MOVEMENTS[leg.movement].unit}`);
        }
        if (leg.weight !== undefined && !(typeof leg.weight === 'number' && leg.weight > 0)) {
            errors.push(`moves[${i}].weight must be a positive number`);
        }
        if (leg.ease !== undefined && !EASINGS[leg.ease]) {
            errors.push(`moves[${i}].ease must be one of: ${Object.keys(EASINGS).join(', ')}`);
        }
    });

    // Staged objects.
    const subjects = Array.isArray(body.subjects) ? body.subjects : [];
    subjects.forEach((obj, i) => {
        if (!obj || !PRIMITIVES[obj.kind]) {
            errors.push(`subjects[${i}].kind must be one of: ${Object.keys(PRIMITIVES).join(', ')}`);
            return;
        }
        if (obj.position !== undefined && (!Array.isArray(obj.position) || obj.position.length !== 3
            || !obj.position.every(Number.isFinite))) {
            errors.push(`subjects[${i}].position must be three finite numbers`);
        }
        if (obj.sizeM !== undefined && (!Array.isArray(obj.sizeM) || obj.sizeM.length !== 3
            || !obj.sizeM.every(v => Number.isFinite(v) && v > 0))) {
            errors.push(`subjects[${i}].sizeM must be three positive numbers`);
        }
        if (obj.rotationDeg !== undefined && (!Array.isArray(obj.rotationDeg) || obj.rotationDeg.length !== 3
            || !obj.rotationDeg.every(Number.isFinite))) {
            errors.push(`subjects[${i}].rotationDeg must be three finite numbers`);
        }
        // The name is the link back to the card, and the only thing that makes
        // a position sayable: an object with no name is scaffolding, and the
        // prompt deliberately says nothing about it. Optional, because a proxy
        // wall is a legitimate thing to stage.
        if (obj.name !== undefined && typeof obj.name !== 'string') {
            errors.push(`subjects[${i}].name must be a string naming a character or prop`);
        }
    });

    // One subject, or none. Two things claiming to be what the shot is of makes
    // every framing solve ambiguous.
    if (subjects.filter(o => o && o.isTarget).length > 1) {
        errors.push('only one staged object may be the framing subject');
    }

    if (body.durationMs !== undefined
        && (typeof body.durationMs !== 'number' || !Number.isFinite(body.durationMs) || body.durationMs < 0)) {
        errors.push('durationMs must be a non-negative number of milliseconds');
    }

    if (!errors.length) {
        // A leg its rig cannot perform is worth saying, per leg.
        for (const leg of moves) {
            const legVerdict = rigCanPerform(rig, leg.movement);
            if (!legVerdict.ok) warnings.push(legVerdict.reason);
        }
        const verdict = rigCanPerform(rig, movement);
        if (!verdict.ok) warnings.push(verdict.reason);

        const range = RIGS[rig].heightRangeM;
        const height = (camera.position || [])[1];
        if (range && typeof height === 'number' && (height < range[0] || height > range[1])) {
            warnings.push(`a ${RIGS[rig].label} sits between ${range[0]}m and ${range[1]}m; this camera is at ${height}m`);
        }
    }

    // Deduped: per-leg and top-level checks find the same impossible pairing,
    // and the same sentence three times reads as three problems.
    return { errors, warnings: [...new Set(warnings)] };
}

// ── Handlers ────────────────────────────────────────────────────────────────

function getBlocking(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    return json(res, 200, {
        shot_id: shotId,
        blocking: loadBlocking(shotId),
        keyframe: shotKeyframe(shotId),
        approval: approvalState(shotId),
    });
}

function putBlocking(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const body = req.body || {};
    const { errors, warnings } = validateBlocking(body);
    if (errors.length) return json(res, 400, { error: 'Invalid blocking', errors });

    const base = defaultBlocking();
    const blocking = {
        camera: { ...base.camera, ...(body.camera || {}) },
        stage: { ...base.stage, ...(body.stage || {}) },
        rig: body.rig || base.rig,
        // Derived from the legs when a sequence was saved without naming one.
        //
        // The column and moves[] were written independently, so blocking a
        // two-leg "dolly in, then pan right" and not also setting `movement`
        // stored `static` — and that column is what BOTH downstream consumers
        // read. The video payload went out as camera_control.type "static"
        // beside a path that plainly moves, and the keyframe prompt asked
        // MOVEMENT_MAP['static'], which is the empty string, so the sequence
        // was invisible to the still entirely.
        //
        // The HEAVIEST leg, not the first: weight is how long a leg runs, so
        // the dominant motion is the honest single-word answer for a field that
        // can only hold one. An explicit movement still wins — somebody naming
        // it means it.
        movement: body.movement || dominantMovement(body.moves) || 'static',
        moves: Array.isArray(body.moves) ? body.moves : [],
        subjects: Array.isArray(body.subjects) ? body.subjects : [],
    };

    // The subject is DERIVED from whichever staged object is the target, so
    // there is one position and one height rather than two that can disagree.
    // Still written to subject_json: solveShot takes it, the orbit centres on
    // it, and blocking saved before the pointer existed reads the same shape.
    const target = resolveTarget({ ...blocking, subject: body.subject });
    blocking.subject = { position: target.position, heightM: target.heightM };

    // A move inherits the length of the shot it belongs to unless told
    // otherwise, so the default is a real number somebody chose rather than a
    // constant — and a move that outlasts its shot is visible immediately.
    const shotRow = db.prepare('SELECT duration_ms FROM film_shots WHERE id = ?').get(shotId);
    blocking.durationMs = (typeof body.durationMs === 'number' && body.durationMs > 0)
        ? Math.round(body.durationMs)
        : (shotRow && shotRow.duration_ms > 0 ? shotRow.duration_ms : DEFAULT_MOVE_MS);

    if (shotRow && shotRow.duration_ms > 0 && blocking.durationMs > shotRow.duration_ms) {
        warnings.push(`the move runs ${(blocking.durationMs / 1000).toFixed(1)}s but the shot is ${(shotRow.duration_ms / 1000).toFixed(1)}s`);
    }

    // Sampled at save time, so what is stored is what was seen. A sequence is
    // sampled as one continuous path; a lone movement keeps the old call, which
    // is what makes every blocking saved before phase 5 reload unchanged.
    const frames = body.frames || 24;
    const path = blocking.moves.length
        ? sampleSequence(blocking.moves, blocking, { frames })
        : samplePath(blocking.movement, blocking, { frames });

    const existing = db.prepare('SELECT id FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    const id = existing ? existing.id : generateId();

    db.prepare(`
        INSERT INTO film_previs_blocking (id, shot_id, camera_json, subject_json, stage_json, rig, movement, path_json, moves_json, subjects_json, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(shot_id) DO UPDATE SET
            camera_json = excluded.camera_json,
            subject_json = excluded.subject_json,
            stage_json = excluded.stage_json,
            rig = excluded.rig,
            movement = excluded.movement,
            path_json = excluded.path_json,
            moves_json = excluded.moves_json,
            subjects_json = excluded.subjects_json,
            duration_ms = excluded.duration_ms,
            updated_at = datetime('now')
    `).run(id, shotId, JSON.stringify(blocking.camera), JSON.stringify(blocking.subject),
        JSON.stringify(blocking.stage), blocking.rig, blocking.movement, JSON.stringify(path),
        JSON.stringify(blocking.moves), JSON.stringify(blocking.subjects), blocking.durationMs);

    return json(res, 200, {
        shot_id: shotId,
        blocking: loadBlocking(shotId),
        timings: legTimings(blocking.moves, blocking.durationMs),
        warnings,
    });
}

function deleteBlocking(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    // Idempotent: deleting nothing is a success, because the caller's intent —
    // "this shot has no blocking" — is satisfied either way.
    const result = db.prepare('DELETE FROM film_previs_blocking WHERE shot_id = ?').run(shotId);
    return json(res, 200, { shot_id: shotId, deleted: result.changes > 0 });
}

/**
 * Where to stand, and what that gives you.
 *
 * The answer a director is actually asking for: not "here is a close-up" but
 * "a close-up on the 85 puts you 2.05m out, with 8cm of focus to play with".
 */
function solve(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const body = req.body || {};
    const shotType = body.shot_type;
    if (!SHOT_TYPES[shotType]) {
        return json(res, 400, { error: `shot_type must be one of: ${Object.keys(SHOT_TYPES).join(', ')}` });
    }

    const sensorId = body.sensor_id || 'super35';
    if (!SENSORS[sensorId]) return json(res, 400, { error: `Unknown sensor '${sensorId}'` });

    const focalMm = body.focal_mm || 50;
    const fStop = body.f_stop || 2.8;
    if (!(focalMm > 0)) return json(res, 400, { error: 'focal_mm must be positive' });
    if (!(fStop > 0)) return json(res, 400, { error: 'f_stop must be positive' });

    const sensor = sensorFor(sensorId);
    const stored = loadBlocking(shotId);
    const target = resolveTarget(stored || {});
    const subject = { position: target.position, heightM: target.heightM };

    const solution = solveShot({ shotType, focalMm, sensor, subject, rig: body.rig });

    return json(res, 200, {
        shot_id: shotId,
        solution,
        fieldOfView: fieldOfView(focalMm, sensor),
        frameCoverage: frameCoverage(solution.distanceM, focalMm, sensor),
        depthOfField: depthOfField(focalMm, fStop, solution.distanceM, sensor),
    });
}

/**
 * The vocabulary, straight off the runtime registries.
 *
 * Served rather than duplicated in the SPA so the viewer cannot offer a
 * movement, rig or sensor the server would refuse — the same guarantee
 * /film/flows/node-types gives the flows palette.
 */
function taxonomy(req, res) {
    return json(res, 200, {
        movements: MOVEMENTS,
        shotTypes: SHOT_TYPES,
        rigs: RIGS,
        sensors: SENSORS,
        lensKit: LENS_KIT,
        apertures: APERTURES,
        easings: Object.keys(EASINGS),
        primitives: PRIMITIVES,
        humanParts: require('../lib/previs-primitives').HUMAN_PARTS,
    });
}

/**
 * The payload the video generator would actually receive for this shot.
 *
 * Phase 3's point is that previs is not a drawing exercise: what was blocked in
 * 3D has to arrive at the provider. This returns the whole payload rather than
 * just the camera, because "will this generate what I blocked" is a question
 * about the prompt and the seed too, and a preview that showed only the part we
 * changed would hide the parts we did not.
 *
 * Built through lib/capability-payloads.js — the same path the orchestrator and
 * the per-domain route use — so this cannot show something generation would not.
 */
function toVideo(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const stale = staleApproval(req, shotId);
    if (stale) return json(res, 409, stale);

    const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');
    const ctx = loadShotContext(shotId);
    if (!ctx) return json(res, 404, { error: 'Shot not found' });

    let built;
    try {
        built = buildCapabilityPayload('video', ctx);
    } catch (err) {
        // A precondition failure here is informative, not a server error: it
        // means the shot is not ready to generate, which is worth seeing.
        return json(res, err.code === 'PRECONDITION' ? 409 : 500, { error: err.message });
    }

    const payload = Array.isArray(built.payload) ? built.payload[0] : built.payload;
    return json(res, 200, { shot_id: shotId, blocked: !!ctx.previs, ...payload });
}

/**
 * Save what the previs looks like.
 *
 * Two kinds, and they are good for different things:
 *
 *   frame  a still of the camera pane. NOT an init_image — a grey-box render
 *          fed to a video model produces grey boxes. Its value is as a
 *          composition reference: the exact framing, lens and blocking that a
 *          storyboard or a generated shot should match, and a structural guide
 *          for anything that conditions on layout.
 *   move   the camera pane recorded across the path. An animatic: it carries
 *          the timing and the pace, which a still cannot.
 *
 * The pixels are rendered in the browser, because the projection lives there
 * and re-implementing it server-side would be a second renderer that could
 * disagree with the one the user approved.
 */
const EXPORT_KINDS = {
    frame: { mime: /^image\/(png|jpeg|webp)$/, ext: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } },
    move: { mime: /^video\/(webm|mp4)$/, ext: { 'video/webm': 'webm', 'video/mp4': 'mp4' } },
};

// A canvas recording is easily tens of megabytes; the ceiling is here so a
// runaway recording cannot fill the disk. Checked on the STRING, before the
// base64 is decoded into a buffer twice its size.
const MAX_EXPORT_CHARS = 64 * 1024 * 1024;

function exportPrevis(req, res, shotId) {
    const shot = db.prepare('SELECT id, scene_id, shot_code FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const scene = db.prepare('SELECT project_id FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const body = req.body || {};
    const spec = EXPORT_KINDS[body.kind];
    if (!spec) return json(res, 400, { error: `kind must be one of: ${Object.keys(EXPORT_KINDS).join(', ')}` });

    const data = body.data;
    if (typeof data !== 'string' || !data.startsWith('data:')) {
        return json(res, 400, { error: 'data must be a data: URL of the rendered previs' });
    }
    if (data.length > MAX_EXPORT_CHARS) {
        return json(res, 413, { error: `export is larger than ${Math.round(MAX_EXPORT_CHARS / 1024 / 1024)}MB` });
    }

    const match = data.match(/^data:([\w/+.-]+);base64,(.*)$/);
    if (!match) return json(res, 400, { error: 'data must be base64-encoded' });

    const mime = match[1];
    if (!spec.mime.test(mime)) {
        return json(res, 400, { error: `a '${body.kind}' export must be ${spec.mime.source}, got ${mime}` });
    }

    let buffer;
    try { buffer = Buffer.from(match[2], 'base64'); } catch (err) { buffer = null; }
    if (!buffer || !buffer.length) return json(res, 400, { error: 'the data could not be decoded' });

    const ext = spec.ext[mime] || 'bin';
    // Named for the shot, not for the clock: re-exporting replaces, so a shot
    // has one current previs frame rather than a pile of near-identical ones.
    const safeCode = String(shot.shot_code || shot.id).replace(/[^\w.-]/g, '_');
    const fileName = `${safeCode}_previs_${body.kind}.${ext}`;

    let filePath;
    try {
        filePath = saveFile(scene.project_id, 'previs', fileName, buffer);
    } catch (err) {
        return json(res, 500, { error: `could not store the export: ${err.message}` });
    }

    // The blocking that produced it, so the frame is reproducible rather than
    // a picture nobody can get back to.
    const blocking = loadBlocking(shotId) || {};
    const camera = blocking.camera || {};
    const metadata = {
        kind: `previs_${body.kind}`,
        movement: blocking.movement || null,
        rig: blocking.rig || null,
        focal_mm: camera.focalMm || null,
        sensor_id: camera.sensorId || null,
        f_stop: camera.fStop || null,
        duration_ms: blocking.durationMs || null,
    };

    const existing = db.prepare(
        "SELECT id FROM film_assets WHERE shot_id = ? AND asset_type = 'other' AND file_name = ?"
    ).get(shotId, fileName);
    const assetId = existing ? existing.id : generateId();

    // asset_type 'other' with a metadata discriminator: the registry's CHECK
    // cannot be widened in place (SQLite cannot ALTER a CHECK, and the
    // migration runner cannot disable FK enforcement inside its transaction),
    // which is the same reason lib/threed-prompt.js registers meshes this way.
    if (existing) {
        db.prepare('UPDATE film_assets SET file_path = ?, mime_type = ?, format = ?, metadata = ? WHERE id = ?')
            .run(filePath, mime, ext, JSON.stringify(metadata), assetId);
    } else {
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, version, metadata)
                    VALUES (?, ?, ?, 'other', ?, ?, ?, ?, 1, ?)`)
            .run(assetId, scene.project_id, shotId, filePath, fileName, ext, mime, JSON.stringify(metadata));
    }

    return json(res, 200, {
        shot_id: shotId, asset_id: assetId, file_name: fileName, file_path: filePath,
        url: `/film/previs/media/${scene.project_id}/${encodeURIComponent(fileName)}`,
        metadata,
    });
}

/**
 * Serve a saved previs frame or recording.
 *
 * Delegated to lib/file-storage.serveFile, which already sanitises the name and
 * checks containment against the resolved path. Hand-rolling that here would be
 * a second, less audited copy of a check that guards the filesystem.
 */
function servePrevisMedia(req, res, projectId, fileName) {
    let decoded = fileName;
    try { decoded = decodeURIComponent(fileName); } catch (err) { /* serveFile will reject it */ }
    return serveFile(res, projectId, 'previs', decoded);
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Write the blocking back onto the scene card.
 *
 * The missing half of the round trip. /solve turns a written shot into a camera
 * position; without this, everything discovered by moving that camera stayed in
 * the previs table and the card still described the shot as first written. A
 * director could stage a better angle and the rest of the pipeline would never
 * hear about it.
 *
 * The card is updated, not replaced: only the camera facets the stage actually
 * determines are touched, so description, characters and dialogue survive.
 */
function applyBlockingToCard(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const blocking = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    if (!blocking) return json(res, 409, { error: 'Shot has no blocking to apply' });

    let card = {};
    try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }

    let camera = {};
    try { camera = JSON.parse(blocking.camera_json || '{}'); } catch (_) { camera = {}; }

    const before = { ...(card.camera || {}) };
    card.camera = { ...(card.camera || {}) };

    // Only what the stage decides. shot_type comes from the solved framing,
    // lens from the actual focal length, movement from what was blocked.
    if (blocking.shot_type) card.camera.shot_type = blocking.shot_type;
    if (Number(camera.focal_mm) > 0) card.camera.lens = `${Math.round(Number(camera.focal_mm))}mm`;
    if (blocking.movement) card.camera.movement = blocking.movement;
    if (camera.sensor) card.camera.sensor = camera.sensor;
    if (Number(camera.f_stop) > 0) card.camera.aperture = Number(camera.f_stop);
    if (Number(camera.height_m) > 0) card.camera.height_m = Number(camera.height_m);

    /*
     * What was STAGED becomes what the shot is blocked with.
     *
     * Previs is a way of deciding the same facts as the Direct panel — who is
     * in the shot and where the camera goes — so a director who stands MAYA and
     * the DRAGON on the stage has blocked the shot, and the card has to know.
     * Without this the two surfaces disagree: previs says two subjects, the
     * card says none, and the plates attach from the card.
     *
     * Named objects only, on the same rule the prompt follows: an unnamed
     * object is scaffolding. And the card's own lists are UNIONED rather than
     * replaced — a director may have named a subject that is not staged (an
     * off-screen voice, something they have not placed yet), and silently
     * dropping it would make applying an angle delete part of the blocking.
     */
    const stagedNames = (Array.isArray(blocking.subjects) ? blocking.subjects : [])
        .map(o => String((o && o.name) || '').trim()).filter(Boolean);
    if (stagedNames.length) {
        const project = db.prepare(
            'SELECT project_id FROM film_scenes WHERE id = ?').get(shot.scene_id);
        const pid = project ? project.project_id : null;
        const known = (table) => pid
            ? db.prepare(`SELECT name FROM ${table} WHERE project_id = ?`).all(pid)
                .map(r => String(r.name || '')) : [];
        const chars = known('film_characters');
        const props = known('film_props');
        const matches = (list, n) => list.find(x => x.toLowerCase() === n.toLowerCase());
        const union = (existing, add) => {
            const out = Array.isArray(existing) ? existing.slice() : [];
            for (const n of add) if (!out.some(x => String(x).toLowerCase() === n.toLowerCase())) out.push(n);
            return out;
        };
        const asChars = stagedNames.filter(n => matches(chars, n));
        const asProps = stagedNames.filter(n => matches(props, n));
        if (asChars.length) card.characters = union(card.characters, asChars);
        if (asProps.length) card.props = union(card.props, asProps);
    }

    const validation = validateSceneCards([card]);
    if (!validation.valid) {
        return json(res, 400, { error: 'Blocking produced an invalid scene card', details: validation.errors });
    }

    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify(card), shotId);

    return json(res, 200, {
        shot_id: shotId,
        shot_code: shot.shot_code,
        camera_before: before,
        camera_after: card.camera,
        blocking_after: { characters: card.characters, props: card.props },
        applied: true,
    });
}

/**
 * The image payload a blocked shot would generate — the mirror of /to-video.
 *
 * Previews rather than generates, so a director can see how the blocking reads
 * as a prompt before spending a credit on it.
 */
function toStoryboard(req, res, shotId) {
    const stale = staleApproval(req, shotId);
    if (stale) return json(res, 409, stale);

    const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');
    let ctx;
    try { ctx = loadShotContext(shotId); } catch (err) {
        return json(res, 400, { error: err.message, code: err.code || undefined });
    }
    if (!ctx) return json(res, 404, { error: 'Shot not found' });

    try {
        const { payload, meta } = buildCapabilityPayload('image', ctx);
        return json(res, 200, {
            shot_id: shotId,
            blocked: !!ctx.previs,
            previs: ctx.previs || null,
            payload,
            meta: meta || undefined,
        });
    } catch (err) {
        return json(res, 400, { error: err.message, code: err.code || undefined });
    }
}

/**
 * The shot's own generated frame, ready to stand in the stage.
 *
 * The `imageplane` primitive has always been able to hold a picture — it reads
 * `o.src` — but nothing ever told the viewer where this shot's picture lives,
 * so the one image most worth standing next to the camera was the one you had
 * to go and find. Restaging against the frame you actually generated is the
 * whole point of iterating between the two views.
 */
function shotKeyframe(shotId) {
    const row = db.prepare(
        `SELECT a.id, a.file_name, a.project_id, a.version FROM film_assets a
          WHERE a.shot_id = ? AND a.asset_type = 'storyboard'
       ORDER BY a.version DESC, a.created_at DESC LIMIT 1`).get(shotId);
    if (!row) return null;
    return {
        asset_id: row.id,
        file_name: row.file_name,
        asset_version: row.version,
        /*
         * The URL the viewer paints from, KEYED TO THE VERSION.
         *
         * A regeneration overwrites the file at a fixed name, so the URL never
         * changes and the browser serves whatever it cached — previs sat there
         * showing the frame you replaced, which reads as previs being broken
         * rather than as a cache. The board learned this and busts with
         * ?v=asset_version; previs used the raw path and did not.
         *
         * Emitted from the SERVER rather than left to each client to remember,
         * because the board, the viewer and previs each paint this and only two
         * of them got it right.
         */
        src: `/film/storyboards/${row.project_id}/${row.file_name}`
            + (row.version ? `?v=${row.version}` : ''),
    };
}

/**
 * What was approved, reduced to a value that changes when the shot does.
 *
 * Only the things that alter the frame: where the camera is, what it is
 * looking through, what it is mounted on, how it moves, and what is staged.
 * Deliberately NOT the sampled path — a path is derived from the movement, so
 * including it would make a re-sample read as a creative change.
 */
function blockingFingerprint(shotId) {
    const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    if (!row) return null;
    const shot = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
    let card = {};
    try { card = JSON.parse((shot && shot.scene_card_yaml) || '{}'); } catch (_) { card = {}; }
    const material = JSON.stringify({
        camera: parse(row.camera_json, {}),
        subjects: parse(row.subjects_json, []),
        subject: parse(row.subject_json, {}),
        rig: row.rig,
        movement: row.movement,
        moves: parse(row.moves_json, []),
        camera_card: card.camera || {},
    });
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Approval state for a shot, and whether it still describes what is there now.
 *
 * A shot that was never approved returns `approved: false, stale: false` — it
 * is not pending judgement, it is simply outside this workflow, and must
 * generate exactly as it did before any of this existed.
 */
function approvalState(shotId) {
    const row = db.prepare(
        'SELECT approved_fingerprint, approved_at FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    if (!row || !row.approved_fingerprint) return { approved: false, stale: false, approved_at: null };
    const now = blockingFingerprint(shotId);
    return {
        approved: true,
        stale: now !== row.approved_fingerprint,
        approved_at: row.approved_at,
    };
}

/**
 * Sign off the blocking as it stands.
 *
 * Records the fingerprint rather than a flag, so "approved" can later be
 * distinguished from "approved, then changed" — which is the distinction the
 * whole iterate-until-happy loop turns on.
 */
function approveBlocking(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const fingerprint = blockingFingerprint(shotId);
    if (!fingerprint) return json(res, 409, { error: 'Shot has no blocking to approve' });

    db.prepare('UPDATE film_previs_blocking SET approved_fingerprint = ?, approved_at = datetime(\'now\') WHERE shot_id = ?')
        .run(fingerprint, shotId);
    // The status enum has always had this value; nothing ever wrote it.
    db.prepare("UPDATE film_shots SET status = 'approved' WHERE id = ?").run(shotId);

    return json(res, 200, { shot_id: shotId, approved: true, fingerprint });
}

/** Withdraw an approval so the shot can be iterated on freely again. */
function unapproveBlocking(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    db.prepare('UPDATE film_previs_blocking SET approved_fingerprint = NULL, approved_at = NULL WHERE shot_id = ?')
        .run(shotId);
    db.prepare("UPDATE film_shots SET status = 'pending' WHERE id = ? AND status = 'approved'").run(shotId);
    return json(res, 200, { shot_id: shotId, approved: false });
}

/**
 * Refuse to generate from a sign-off that no longer describes the shot.
 *
 * Returns an error response body when the run should stop, or null to proceed.
 * Overridable exactly the way the budget gate is: a fingerprint that has gone
 * stale for a reason the director does not care about must not make the shot
 * ungeneratable, but they have to say so.
 */
function staleApproval(req, shotId) {
    const body = req.body || {};
    if (body.ignore_approval) return null;
    const state = approvalState(shotId);
    if (!state.approved || !state.stale) return null;
    return {
        error: 'The blocking changed after it was approved',
        code: 'STALE_APPROVAL',
        detail: 'This shot was signed off, then restaged. Generating now would shoot a frame nobody approved. '
            + 'Re-approve it, or pass ignore_approval to generate anyway.',
        approved_at: state.approved_at,
    };
}

/**
 * Seed the stage from what was written.
 *
 * The loop's missing entry edge. /solve computes a camera position but takes
 * shot_type and focal_mm from the REQUEST, so a shot whose card already says
 * "close-up on a 50" made the director retype both before the 3D view showed
 * anything — and any typo silently previewed a different shot than the one the
 * screenplay breakdown produced.
 *
 * Refuses to overwrite by default. Blocking is hand-made work, and re-seeding
 * from the card is exactly the action that would discard it.
 */
function fromCard(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const body = req.body || {};
    const existing = db.prepare('SELECT id FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    if (existing && !body.overwrite) {
        return json(res, 409, {
            error: 'Shot is already blocked',
            detail: 'Pass overwrite to replace the existing blocking with one seeded from the scene card.',
        });
    }

    let card = {};
    try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }
    const cam = card.camera || {};

    // The film's own optics, chosen once on the mood board. Without these a
    // card that says nothing opens on a 50mm super35 default that belongs to
    // no production in particular.
    let filmDefaults = {};
    try {
        const owner = db.prepare('SELECT project_id FROM film_scenes WHERE id = ?').get(shot.scene_id);
        const board = db.prepare(
            'SELECT spec_kind, spec_value FROM film_mood_board WHERE project_id = ? AND spec_kind IS NOT NULL')
            .all(owner ? owner.project_id : null)
            .map(r => ({ kind: r.spec_kind, value: r.spec_value }));
        filmDefaults = require('../lib/look-development').previsDefaults(board);
    } catch (_) { filmDefaults = {}; }

    const shotType = SHOT_TYPES[cam.shot_type] ? cam.shot_type : 'medium';
    const movement = MOVEMENTS[cam.movement] ? cam.movement : 'static';
    // "50mm", "50 mm", 50 — the card's lens is a free string by design, so it
    // is parsed rather than trusted, and an unparseable one falls back instead
    // of failing: a card that says "anamorphic" should still open a stage.
    const focalMm = (() => {
        const raw = cam.focal_mm !== undefined ? cam.focal_mm : cam.lens;
        const n = typeof raw === 'number' ? raw : parseFloat(String(raw || '').replace(/[^0-9.]/g, ''));
        if (Number.isFinite(n) && n > 0) return n;
        return Number(filmDefaults.focalMm) > 0 ? Number(filmDefaults.focalMm) : 50;
    })();
    const sensorId = SENSORS[cam.sensor] ? cam.sensor
        : (SENSORS[filmDefaults.sensorId] ? filmDefaults.sensorId : 'super35');
    const fStop = Number(cam.aperture) > 0 ? Number(cam.aperture)
        : (Number(filmDefaults.fStop) > 0 ? Number(filmDefaults.fStop) : 2.8);
    const heightM = Number(cam.height_m) > 0 ? Number(cam.height_m) : DEFAULT_EYE_HEIGHT_M;

    const sensor = sensorFor(sensorId);

    /*
     * The people and things the card says are in this shot, staged by name.
     *
     * This seeded ONE anonymous 1.7m figure at the origin regardless of who the
     * card named, so a two-hander opened as a single nameless proxy and a
     * director had to rebuild the cast by hand before blocking anything. Worse,
     * an unnamed object says nothing to the prompt by design — so the stage a
     * seed produced could be arranged perfectly and still reach generation as
     * silence.
     *
     * Heights come from the subject-scale columns where they exist and are left
     * at the default where they do not, on the same rule those columns follow:
     * an invented size is indistinguishable from a declared one and would be
     * wrong silently in every frame the subject appears in.
     *
     * Positions are a starting arrangement, not a claim. Everything faces the
     * camera and spreads laterally at the framing distance, which is the
     * neutral opening a director then drags into the actual blocking — the
     * point is that the cast is ON the stage with the right names and sizes.
     */
    const staged = [];
    try {
        const owner = db.prepare('SELECT project_id FROM film_scenes WHERE id = ?').get(shot.scene_id);
        const pid = owner ? owner.project_id : null;
        const names = [
            ...(Array.isArray(card.characters) ? card.characters : []).map(n => ({ n: String(n), kind: 'character' })),
            ...(Array.isArray(card.props) ? card.props : []).map(n => ({ n: String(n), kind: 'prop' })),
        ].filter(x => x.n.trim());

        const chars = pid ? db.prepare('SELECT name, height_m FROM film_characters WHERE project_id = ?').all(pid) : [];
        const props = pid ? db.prepare('SELECT name, height_m, width_m, length_m FROM film_props WHERE project_id = ?').all(pid) : [];
        const findRow = (list, name) =>
            list.find(r => String(r.name || '').toLowerCase() === name.toLowerCase()) || null;

        names.forEach((entry, i) => {
            const row = findRow(entry.kind === 'character' ? chars : props, entry.n);
            const h = Number(row && row.height_m) > 0 ? Number(row.height_m) : null;
            // Spread left, right, left… around the framing point.
            const step = 1.4 * Math.ceil(i / 2) * (i % 2 === 0 ? -1 : 1);
            staged.push({
                kind: entry.kind === 'character' ? 'human' : 'cube',
                name: entry.n,
                // Lateral placement is assigned below, once the framing is
                // solved: a fixed 1.4m step puts a subject outside the frame on
                // a close-up and on top of the target on a wide, and a seed
                // that opens with the cast off-screen reads as broken.
                position: [0, 0, 0],
                spreadRank: i,
                // The seeded camera sits on +Z looking back at the origin, and
                // an object's forward is +Z turned by its yaw — so yaw 0 faces
                // the camera. Seeding 180 pointed the whole cast away, which
                // the staging phrase then reported perfectly accurately.
                rotationDeg: [0, 0, 0],
                isTarget: i === 0,
                ...(entry.kind === 'character'
                    ? (h ? { heightM: h } : {})
                    : { sizeM: [
                        Number(row && row.width_m) > 0 ? Number(row.width_m) : 0.6,
                        h || 0.6,
                        Number(row && row.length_m) > 0 ? Number(row.length_m) : 0.6] }),
            });
        });
    } catch (_) { /* a stage with no cast is still a stage */ }

    const targetHeight = (() => {
        const t = staged.find(o => o.isTarget);
        return t && Number(t.heightM) > 0 ? Number(t.heightM) : DEFAULT_SUBJECT_HEIGHT_M;
    })();
    const subject = { position: [0, 0, 0], heightM: targetHeight };
    const solution = solveShot({ shotType, focalMm, sensor, subject });

    /*
     * Spread the cast across the frame this shot actually covers.
     *
     * The framing subject holds the centre and everyone else steps out inside
     * the frame width at that distance, alternating left and right. The point
     * of a seed is that the cast is visible and roughly placed; the director
     * then drags them into the real blocking.
     */
    try {
        const cov = frameCoverage(solution.distanceM, focalMm, sensor);
        const usable = (Number(cov.widthM) > 0 ? Number(cov.widthM) : 4) * 0.35;
        staged.forEach(o => {
            const r = o.spreadRank || 0;
            delete o.spreadRank;
            if (r === 0) return;
            const sides = Math.max(1, Math.ceil((staged.length - 1) / 2));
            const step = usable / sides;
            o.position = [step * Math.ceil(r / 2) * (r % 2 ? 1 : -1), 0, 0];
        });
    } catch (_) {
        staged.forEach(o => { delete o.spreadRank; });
    }

    const camera = {
        position: [0, heightM, solution.distanceM],
        rotation: [0, 0, 0],
        focalMm,
        sensorId,
        fStop,
        focusDistanceM: solution.distanceM,
    };

    const blocking = {
        camera,
        subject,
        stage: { widthM: 12, depthM: 12 },
        rig: solution.rig || 'dolly',
        movement,
        durationMs: shot.duration_ms || 0,
        subjects: staged,
        moves: [],
    };

    // Saved through the same validator and sampler the editor writes through,
    // so a seeded blocking is indistinguishable from a hand-made one.
    req.body = blocking;
    return putBlocking(req, res, shotId);
}

function handlePrevis(req, res, urlParts) {
    // /film/nav-flow — the sidebar order, from the status machine.
    if (urlParts[1] === 'nav-flow' && req.method === 'GET') {
        const { orderedPhases, ALWAYS_AVAILABLE } = require('../lib/nav-flow');
        return json(res, 200, { phases: orderedPhases(), always: ALWAYS_AVAILABLE });
    }

    // /film/previs/taxonomy
    if (urlParts[1] === 'previs') {
        if (urlParts[2] === 'taxonomy' && req.method === 'GET') return taxonomy(req, res);
        if (urlParts[2] === 'media' && urlParts[3] && urlParts[4] && req.method === 'GET') {
            return servePrevisMedia(req, res, urlParts[3], urlParts[4]);
        }
        return json(res, 404, { error: 'Not found' });
    }

    // /film/shots/:id/previs[/solve]
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'previs') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        if (urlParts[4] === 'export') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            return exportPrevis(req, res, shotId);
        }
        if (urlParts[4] === 'to-video') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            return toVideo(req, res, shotId);
        }
        if (urlParts[4] === 'from-card') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            return fromCard(req, res, shotId);
        }
        if (urlParts[4] === 'approve') {
            if (req.method === 'POST') return approveBlocking(req, res, shotId);
            if (req.method === 'DELETE') return unapproveBlocking(req, res, shotId);
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (urlParts[4] === 'apply') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            return applyBlockingToCard(req, res, shotId);
        }
        if (urlParts[4] === 'to-storyboard') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            return toStoryboard(req, res, shotId);
        }
        if (urlParts[4] === 'solve') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            return solve(req, res, shotId);
        }
        if (urlParts[4]) return json(res, 404, { error: 'Not found' });

        if (req.method === 'GET') return getBlocking(req, res, shotId);
        if (req.method === 'PUT') return putBlocking(req, res, shotId);
        if (req.method === 'DELETE') return deleteBlocking(req, res, shotId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    return json(res, 404, { error: 'Not found' });
}

module.exports = { handlePrevis, loadBlocking, validateBlocking, approvalState };
