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
} = require('../lib/previs-blocking');
const { PRIMITIVES, primitiveGeometry } = require('../lib/previs-primitives');
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
    return json(res, 200, { shot_id: shotId, blocking: loadBlocking(shotId) });
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
        movement: body.movement || 'static',
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

module.exports = { handlePrevis, loadBlocking, validateBlocking };
