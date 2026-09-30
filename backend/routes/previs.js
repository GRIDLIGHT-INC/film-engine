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
    solveShot, samplePath, sampleSequence, normalizeCameraKeys, rigCanPerform, defaultBlocking, cardOptics, resolveTarget,
    legTimings, DEFAULT_MOVE_MS,
    DEFAULT_SUBJECT_HEIGHT_M,
} = require('../lib/previs-blocking');
const { PRIMITIVES } = require('../lib/previs-primitives');
const crypto = require('crypto');
const { validateSceneCards } = require('../lib/scene-card-schema');
const { directorIntentFromCard, applyDirectorIntent, applicationFingerprints, decisionParts, DECISION_CHIPS } = require('../lib/decision-contract');
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
    const camera = parse(row.camera_json, {});
    const director = parse(row.director_json, null);
    return {
        camera,
        director,
        subject: parse(row.subject_json, {}),
        stage: parse(row.stage_json, {}),
        rig: row.rig,
        movement: row.movement,
        durationMs: row.duration_ms || 0,
        moves: parse(row.moves_json, []),
        subjects: parse(row.subjects_json, []),
        path: parse(row.path_json, []),
        cameraKeys: parse(row.camera_keys_json, []),
        updated_at: row.updated_at,
    };
}

function applicationState(shotId) {
    const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    if (!row || !row.applied_fingerprint || !row.applied_card_fingerprint) {
        return { state: row ? 'staged' : 'none', applied: false, staged: !!row, card_ahead: false, applied_at: null };
    }
    const shot = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
    const now = applicationFingerprints(row, parse((shot && shot.scene_card_yaml) || '{}', {}), {
        knownNames: recognizedSubjectNames(shotId),
    });
    const stageMoved = now.stage !== row.applied_fingerprint;
    const cardMoved = now.card !== row.applied_card_fingerprint;
    const state = stageMoved && cardMoved ? 'conflict'
        : stageMoved ? 'staged' : cardMoved ? 'card_ahead' : 'applied';
    return { state, applied: state === 'applied', staged: state === 'staged',
        card_ahead: state === 'card_ahead', conflict: state === 'conflict', applied_at: row.applied_at };
}

function markApplied(shotId) {
    const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    const shot = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
    if (!row || !shot) return null;
    const fingerprints = applicationFingerprints(row, parse(shot.scene_card_yaml || '{}', {}), {
        knownNames: recognizedSubjectNames(shotId),
    });
    db.prepare("UPDATE film_previs_blocking SET applied_fingerprint = ?, applied_card_fingerprint = ?, applied_at = datetime('now') WHERE shot_id = ?")
        .run(fingerprints.stage, fingerprints.card, shotId);
    // The same apply, cut per decision, so each chip can say what it is doing.
    const parts = decisionParts(row, parse(shot.scene_card_yaml || '{}', {}), subjectNamesByKind(shotId));
    if (parts) {
        db.prepare('UPDATE film_previs_blocking SET applied_parts_json = ? WHERE shot_id = ?')
            .run(JSON.stringify(parts), shotId);
    }
    return fingerprints;
}

/** The project's known names, split by what they are — cast or prop. */
function subjectNamesByKind(shotId) {
    const owner = db.prepare(`
        SELECT sc.project_id FROM film_shots sh
        JOIN film_scenes sc ON sc.id = sh.scene_id WHERE sh.id = ?`).get(shotId);
    if (!owner) return { characterNames: [], propNames: [] };
    return {
        characterNames: db.prepare('SELECT name FROM film_characters WHERE project_id = ?').all(owner.project_id).map(r => r.name),
        propNames: db.prepare('SELECT name FROM film_props WHERE project_id = ?').all(owner.project_id).map(r => r.name),
    };
}

/*
 * WHAT EACH DECISION IS DOING, ONE CHIP AT A TIME.
 *
 *   none        nothing staged for it
 *   trying      the stage differs from what was applied (or was never applied)
 *   applied     on the scene card — what generation will send
 *   card_ahead  the Shot Board changed it after the apply
 *   conflict    both sides moved
 *   locked      applied AND locked by the director
 *   stale       locked, then changed on either side
 *
 * A shot applied before per-decision fingerprints existed has only the whole
 * pair; it reads each decision from the whole-shot state rather than calling
 * everything "trying", because nothing about it changed.
 */
/*
 * What each decision reads as on the scene card, in words. Production shows
 * these read-only beside the lock, so it must be the CARD's value — the one
 * generation sends — never the staging still being tried in Previs.
 */
function decisionValues(card) {
    const c = card || {};
    const cam = c.camera || {};
    const words = v => {
        if (v == null || v === '') return '';
        if (Array.isArray(v)) return v.map(words).filter(Boolean).join(', ');
        if (typeof v === 'object') return Object.entries(v).filter(([, x]) => x != null && x !== '' && typeof x !== 'object')
            .map(([k, x]) => `${k.replace(/_/g, ' ')} ${x}`).join(' · ');
        return String(v);
    };
    const lens = cam.lens != null ? String(cam.lens).replace(/mm$/i, '') + 'mm' : '';
    const height = cam.height_m != null ? `${Number(cam.height_m).toFixed(2)} m high` : '';
    const clip = t => (t.length > 140 ? t.slice(0, 137) + '…' : t);
    return {
        camera: [lens, height, cam.aperture != null ? `f/${String(cam.aperture).replace(/^f\//i, '')}` : ''].filter(Boolean).join(' · '),
        direction: clip(words(c.direction)),
        lighting: clip(words(c.lighting)),
        location_view: clip(words(c.location_view)),
        characters: words(c.characters),
        props: words(c.props),
        movement: clip(words(cam.movement)),
    };
}

function decisionStates(shotId) {
    const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    const chips = DECISION_CHIPS.map(c => ({ id: c.id, label: c.label }));
    const shot = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
    const card = parse((shot && shot.scene_card_yaml) || '{}', {});
    const values = decisionValues(card);
    if (!row) return chips.map(c => ({ ...c, state: 'none', value: values[c.id] || '' }));
    const now = decisionParts(row, card, subjectNamesByKind(shotId));
    const applied = parse(row.applied_parts_json, null);
    const locked = new Set(parse(row.locked_parts_json, []) || []);
    const whole = applied ? null : applicationState(shotId);
    return chips.map(c => {
        const part = now[c.id];
        let state;
        if (applied && applied[c.id]) {
            const stageMoved = part.stage !== applied[c.id].stage;
            const cardMoved = part.card !== applied[c.id].card;
            state = stageMoved && cardMoved ? 'conflict' : stageMoved ? 'trying' : cardMoved ? 'card_ahead' : 'applied';
            if (state === 'applied' && !part.has && part.card === part.stage) state = 'none';
        } else if (whole && whole.applied) {
            state = part.has ? 'applied' : 'none';
        } else {
            state = part.has ? 'trying' : 'none';
        }
        if (locked.has(c.id)) state = state === 'applied' ? 'locked' : 'stale';
        return { ...c, state, value: values[c.id] || '' };
    });
}

/*
 * Lock or unlock decisions. A lock is a promise that what generation sends for
 * that decision will not change underneath the director, so only an APPLIED
 * decision can be locked — locking something still being tried would lock a
 * value the card does not hold. `all` locks every applied decision and signs
 * the blocking off, which is what "Lock shot" means.
 */
function lockDecisions(req, res, shotId, lock) {
    const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    if (!row) return json(res, 409, { error: 'Shot has no blocking to lock' });
    const body = req.body || {};
    const known = new Set(DECISION_CHIPS.map(c => c.id));
    const states = decisionStates(shotId);
    let ids = body.all ? states.filter(d => lock ? d.state === 'applied' : true).map(d => d.id)
        : (Array.isArray(body.decisions) ? body.decisions : []).map(String);
    const unknown = ids.filter(id => !known.has(id));
    if (unknown.length) return json(res, 400, { error: `Unknown decision: ${unknown.join(', ')}`, known: [...known] });
    if (!ids.length && !body.all) return json(res, 400, { error: 'Name the decisions to change, or pass all: true' });
    if (lock) {
        const notApplied = ids.filter(id => { const d = states.find(x => x.id === id); return !d || !['applied', 'locked'].includes(d.state); });
        if (notApplied.length) {
            return json(res, 409, { error: 'Apply before locking — only a decision on the scene card can be locked',
                code: 'NOT_APPLIED', decisions: notApplied });
        }
    }
    const current = new Set(parse(row.locked_parts_json, []) || []);
    ids.forEach(id => (lock ? current.add(id) : current.delete(id)));
    db.prepare('UPDATE film_previs_blocking SET locked_parts_json = ? WHERE shot_id = ?')
        .run(current.size ? JSON.stringify([...current]) : null, shotId);
    if (body.all) {
        if (lock) {
            const fingerprint = blockingFingerprint(shotId);
            db.prepare("UPDATE film_previs_blocking SET approved_fingerprint = ?, approved_at = datetime('now') WHERE shot_id = ?")
                .run(fingerprint, shotId);
            db.prepare("UPDATE film_shots SET status = 'approved' WHERE id = ?").run(shotId);
        } else {
            db.prepare('UPDATE film_previs_blocking SET approved_fingerprint = NULL, approved_at = NULL WHERE shot_id = ?').run(shotId);
            db.prepare("UPDATE film_shots SET status = 'pending' WHERE id = ? AND status = 'approved'").run(shotId);
        }
    }
    return json(res, 200, { shot_id: shotId, locked: [...current], decisions: decisionStates(shotId), approval: approvalState(shotId) });
}

function recognizedSubjectNames(shotId) {
    const owner = db.prepare(`
        SELECT sc.project_id FROM film_shots sh
        JOIN film_scenes sc ON sc.id = sh.scene_id WHERE sh.id = ?`).get(shotId);
    if (!owner) return [];
    return [
        ...db.prepare('SELECT name FROM film_characters WHERE project_id = ?').all(owner.project_id),
        ...db.prepare('SELECT name FROM film_props WHERE project_id = ?').all(owner.project_id),
    ].map(row => row.name);
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
    if (camera.focusDistanceM !== undefined && !(typeof camera.focusDistanceM === 'number'
        && Number.isFinite(camera.focusDistanceM) && camera.focusDistanceM > 0)) {
        errors.push('camera.focusDistanceM must be a positive distance in metres');
    }
    for (const field of ['position', 'rotation']) {
        if (camera[field] !== undefined && (!Array.isArray(camera[field]) || camera[field].length !== 3
            || !camera[field].every(Number.isFinite))) {
            errors.push(`camera.${field} must be three finite numbers`);
        }
    }
    if (body.cameraKeys !== undefined) {
        if (!Array.isArray(body.cameraKeys)) errors.push('cameraKeys must be an array');
        else body.cameraKeys.forEach((key, i) => {
            if (!key || !Number.isFinite(key.t) || key.t < 0 || key.t > 1
                || !Array.isArray(key.position) || key.position.length !== 3 || !key.position.every(Number.isFinite)
                || !Array.isArray(key.rotation) || key.rotation.length !== 3 || !key.rotation.every(Number.isFinite)
                || (key.rotationUnit !== undefined && !['degrees', 'radians'].includes(key.rotationUnit))
                || !(Number.isFinite(key.focalMm) && key.focalMm > 0)) {
                errors.push(`cameraKeys[${i}] must contain t 0..1, finite position/rotation triples and a positive focalMm`);
            }
        });
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
        // WHICH model a staged figure is: a Previs library entry (people and
        // furniture) or one of the project's own 3D models (a Meshy creature).
        // Ownership of an asset_id is checked where the shot's project is known.
        if (obj.model !== undefined) {
            const m = obj.model || {};
            if (!['mesh', 'human'].includes(obj.kind)) errors.push(`subjects[${i}].model belongs on a mesh or human`);
            if (!!m.library === !!m.asset_id) errors.push(`subjects[${i}].model needs exactly one of library or asset_id`);
            else if (m.library && !require('../lib/previs-library').get(m.library)) {
                errors.push(`subjects[${i}].model.library '${m.library}' is not in the Previs library`);
            }
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

/*
 * How this shot is lit, and where each part came from: what is staged in
 * Previs, else the shot's card, else its location (lib/lighting). The film's
 * general look is the style preset and is not repeated.
 */
function shotLighting(shotId, blocking) {
    const { resolveLighting } = require('../lib/lighting');
    const { matchLocation } = require('../lib/shot-references');
    const row = db.prepare(`SELECT s.scene_card_yaml, sc.location, sc.project_id FROM film_shots s
        JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?`).get(shotId);
    if (!row) return null;
    const card = parse(row.scene_card_yaml || '{}', {});
    const locations = db.prepare('SELECT * FROM film_locations WHERE project_id = ?').all(row.project_id);
    const location = matchLocation(row.location, locations);
    const staged = blocking && blocking.director && blocking.director.lighting;
    const resolved = resolveLighting(staged ? { lighting: staged } : card, location);
    if (staged) for (const k of Object.keys(resolved.sources)) if (resolved.sources[k] === 'shot') resolved.sources[k] = 'previs';
    resolved.location = location ? { id: location.id, name: location.name } : null;
    resolved.card = card.lighting || null;
    /*
     * The rig, placed from the SAVED camera and the framing subject — lights
     * are set for a setup, so walking the camera does not drag them along.
     */
    const { rigLights, MOODS, kelvinToHex } = require('../lib/lighting');
    const cam = blocking && blocking.camera && Array.isArray(blocking.camera.position) ? blocking.camera.position : null;
    const subs = (blocking && blocking.subjects) || [];
    const target = subs.find(x => x && x.isTarget) || subs[0];
    resolved.rig = cam && target && Array.isArray(target.position) ? rigLights(resolved, cam, target.position) : [];
    const mood = MOODS[resolved.type] || null;
    resolved.mood = mood ? { kelvin: mood.kelvin, colour: kelvinToHex(mood.kelvin), ambient: mood.ambient, colours: mood.colours || null } : null;
    return resolved;
}

function getBlocking(req, res, shotId) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const blocking = loadBlocking(shotId);
    return json(res, 200, {
        shot_id: shotId,
        blocking,
        lighting: shotLighting(shotId, blocking),
        keyframe: shotKeyframe(shotId),
        approval: approvalState(shotId),
        application: applicationState(shotId),
        decisions: decisionStates(shotId),
    });
}

/**
 * Only the staged objects change: what the Plan view saves when something is
 * placed, moved, turned or removed. Everything else is read back and written
 * through the one writer, so the camera keys survive and the path re-samples
 * (an orbit centres on its subject).
 */
/*
 * A PARTIAL save, over the blocking as it stands. A PUT of /previs rebuilds the
 * whole blocking from defaults, so a caller that only meant to move a person or
 * add a camera key, and sent only that, reset the camera to its default and
 * wiped everything else staged. Both partial routes re-send what is there and
 * replace only the fields they own.
 */
function putMerged(req, res, shotId, patch) {
    const current = loadBlocking(shotId);
    const body = current ? {
        camera: current.camera, stage: current.stage, rig: current.rig, movement: current.movement,
        moves: current.moves, cameraKeys: current.cameraKeys, durationMs: current.durationMs,
        subjects: current.subjects, director: current.director || undefined, ...patch,
    } : { ...patch };
    return putBlocking(Object.assign({}, req, { body }), res, shotId);
}

function putSubjects(req, res, shotId) {
    const subjects = (req.body || {}).subjects;
    if (!Array.isArray(subjects)) return json(res, 400, { error: 'subjects must be an array' });
    return putMerged(req, res, shotId, { subjects });
}

/*
 * The director's staged intent (direction, lighting, location view, camera
 * note), merged field by field: sending the lighting must not erase the
 * direction. Staged like everything in Previs — Apply writes it to the card.
 */
function putDirector(req, res, shotId) {
    const b = req.body || {};
    const current = loadBlocking(shotId);
    const director = { ...((current && current.director) || {}) };
    for (const k of ['direction', 'lighting', 'location_view', 'camera_note']) {
        if (b[k] === undefined) continue;
        if (b[k] === null || b[k] === '') delete director[k]; else director[k] = b[k];
    }
    if (b.lighting) {
        const { TECHNIQUES, MOODS, KEY_SIDES } = require('../lib/lighting');
        const l = b.lighting;
        if (typeof l !== 'object') return json(res, 400, { error: 'lighting must be an object' });
        if (l.technique && !TECHNIQUES[l.technique]) return json(res, 400, { error: `unknown lighting technique '${l.technique}'` });
        if (l.type && !MOODS[l.type]) return json(res, 400, { error: `unknown lighting mood '${l.type}'` });
        if (l.key_side && !KEY_SIDES.includes(l.key_side)) return json(res, 400, { error: 'key_side must be left or right' });
    }
    return putMerged(req, res, shotId, { director });
}

/** The move: legs, camera keys and length. The camera and the stage are untouched. */
function putTimeline(req, res, shotId) {
    const b = req.body || {};
    const patch = {};
    if (b.moves !== undefined) {
        if (!Array.isArray(b.moves)) return json(res, 400, { error: 'moves must be an array' });
        patch.moves = b.moves;
        // The single movement is derived from the legs again, unless named.
        patch.movement = b.movement || undefined;
    }
    if (b.cameraKeys !== undefined) patch.cameraKeys = b.cameraKeys;
    if (b.durationMs !== undefined) patch.durationMs = b.durationMs;
    if (!Object.keys(patch).length) return json(res, 400, { error: 'send moves, cameraKeys or durationMs' });
    return putMerged(req, res, shotId, patch);
}

function putBlocking(req, res, shotId, internal) {
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    // Underscore-prefixed fields are server bookkeeping, never caller
    // authority. Copying only public keys prevents HTTP and MCP clients from
    // forging the from-card path that records a blocking as applied.
    const body = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => !key.startsWith('_')));
    const { errors, warnings } = validateBlocking(body);
    const projectId = (db.prepare('SELECT sc.project_id FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?').get(shotId) || {}).project_id;
    (Array.isArray(body.subjects) ? body.subjects : []).forEach((o, i) => {
        const id = o && o.model && o.model.asset_id;
        if (!id) return;
        const row = db.prepare('SELECT metadata FROM film_assets WHERE id = ? AND project_id = ?').get(id, projectId);
        let kind = null;
        try { kind = row && JSON.parse(row.metadata || '{}').kind; } catch (_) { kind = null; }
        if (!/^model_/.test(kind || '')) errors.push(`subjects[${i}].model.asset_id is not one of this project's 3D models`);
    });
    if (errors.length) return json(res, 400, { error: 'Invalid blocking', errors });

    const base = defaultBlocking();
    const existing = db.prepare('SELECT id, director_json FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    const existingDirector = existing ? parse(existing.director_json || '{}', {}) : {};
    const blocking = {
        camera: { ...base.camera, ...(body.camera || {}) },
        // A camera-only save is not an instruction to erase the director's
        // words. Explicit null clears; omission preserves the staged intent.
        director: body.director === undefined ? existingDirector : (body.director || {}),
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
        cameraKeys: Array.isArray(body.cameraKeys) ? normalizeCameraKeys(body.cameraKeys) : [],
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
    const path = blocking.cameraKeys.length
        ? require('../lib/previs-blocking').sampleCameraKeys(blocking.cameraKeys, { frames })
        : blocking.moves.length
            ? sampleSequence(blocking.moves, blocking, { frames })
            : samplePath(blocking.movement, blocking, { frames });
    if (blocking.cameraKeys.length) {
        blocking.movement = require('../lib/previs-blocking').analyzePath(path).dominantMovement;
    }

    const id = existing ? existing.id : generateId();

    db.prepare(`
        INSERT INTO film_previs_blocking (id, shot_id, camera_json, subject_json, stage_json, rig, movement, path_json, moves_json, subjects_json, duration_ms, director_json, camera_keys_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            director_json = excluded.director_json,
            camera_keys_json = excluded.camera_keys_json,
            updated_at = datetime('now')
    `).run(id, shotId, JSON.stringify(blocking.camera), JSON.stringify(blocking.subject),
        JSON.stringify(blocking.stage), blocking.rig, blocking.movement, JSON.stringify(path),
        JSON.stringify(blocking.moves), JSON.stringify(blocking.subjects), blocking.durationMs,
        JSON.stringify(blocking.director), JSON.stringify(blocking.cameraKeys));

    // A stage seeded from the card agrees with it by construction. Record the
    // projected fingerprint after persistence so later edits are derived as
    // staged; no writer has to remember to clear a flag.
    if (internal && internal.seededFromCard) markApplied(shotId);

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

    const solution = solveShot({ shotType, focalMm, sensor, subject, rig: body.rig,
        azimuthDeg: Number.isFinite(body.azimuth_deg) ? body.azimuth_deg : 0 });

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
    const ctx = loadShotContext(shotId, { previsMode: 'staged' });
    if (!ctx) return json(res, 404, { error: 'Shot not found' });
    if (ctx.previs && ctx.previs.director) {
        ctx.sceneCard = applyDirectorIntent({
            ...ctx.sceneCard, camera: { ...(ctx.sceneCard.camera || {}) },
        }, ctx.previs.director);
    }

    let built;
    try {
        built = buildCapabilityPayload('video', ctx);
    } catch (err) {
        // A precondition failure here is informative, not a server error: it
        // means the shot is not ready to generate, which is worth seeing.
        return json(res, err.code === 'PRECONDITION' ? 409 : 500, { error: err.message });
    }

    const payload = Array.isArray(built.payload) ? built.payload[0] : built.payload;
    const appliedState = applicationState(shotId);
    const staged = !!ctx.previs && appliedState.staged;
    return json(res, 200, {
        shot_id: shotId,
        blocked: !!ctx.previs,
        staged,
        applied: appliedState.applied,
        card_ahead: appliedState.card_ahead,
        conflict: appliedState.conflict,
        application_state: appliedState.state,
        staged_notice: staged
            ? 'This video preview includes staged Previs intent. Apply it before generating from the Shot Board.'
            : appliedState.card_ahead || appliedState.conflict
                ? 'The Shot Board changed after this Previs was applied. Re-seed Previs before applying again.' : null,
        film_facts: {
            direction: ctx.sceneCard.direction || '',
            location_view: ctx.sceneCard.location_view || '',
            lighting: ctx.sceneCard.lighting || null,
            anchor_attached: !!ctx.anchorAttached,
            annotation_feedback: !!ctx.useAnnotations,
        },
        ...payload,
    });
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
    // The width comes off the request itself: this helper is not handed the
    // parsed query, and referencing one that does not exist would throw on
    // every previs image rather than merely skipping the thumbnail.
    let width = null;
    try { width = new URL(req.url, 'http://x').searchParams.get('w'); } catch (_) { width = null; }
    return serveFile(res, projectId, 'previs', decoded, { width });
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
    // markApplied records applied_fingerprint after the projected card write;
    // applicationState derives whether the current stage still matches it.
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const blocking = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    if (!blocking) return json(res, 409, { error: 'Shot has no blocking to apply' });
    const application = applicationState(shotId);
    if (application.card_ahead || application.conflict) {
        return json(res, 409, {
            error: 'The Shot Board changed after this Previs was applied', code: 'CARD_AHEAD',
            detail: 'Re-seed Previs from the card before applying again so the newer board direction is not overwritten.',
            application,
        });
    }

    let card = {};
    try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }

    let camera = {};
    try { camera = JSON.parse(blocking.camera_json || '{}'); } catch (_) { camera = {}; }

    const before = { ...(card.camera || {}) };
    card.camera = { ...(card.camera || {}) };

    // Only what the stage decides. shot_type comes from the solved framing,
    // lens from the actual focal length, movement from what was blocked.
    if (blocking.shot_type) card.camera.shot_type = blocking.shot_type;
    const focalMm = camera.focalMm !== undefined ? camera.focalMm : camera.focal_mm;
    const sensorId = camera.sensorId || camera.sensor;
    const fStop = camera.fStop !== undefined ? camera.fStop : camera.f_stop;
    const cameraHeight = Array.isArray(camera.position) ? camera.position[1] : camera.height_m;
    const focusDistance = camera.focusDistanceM !== undefined
        ? camera.focusDistanceM : camera.focus_distance_m;
    if (Number(focalMm) > 0) card.camera.lens = `${Math.round(Number(focalMm))}mm`;
    if (blocking.movement) card.camera.movement = blocking.movement;
    if (sensorId) card.camera.sensor = sensorId;
    if (Number(fStop) > 0) card.camera.aperture = Number(fStop);
    if (Number(cameraHeight) > 0) card.camera.height_m = Number(cameraHeight);
    if (Number(focusDistance) > 0) card.camera.focus_distance_m = Number(focusDistance);
    if (Array.isArray(camera.position) && camera.position.length === 3) card.camera.position = camera.position;
    if (Array.isArray(camera.rotation) && camera.rotation.length === 3) card.camera.rotation = camera.rotation;
    const director = parse(blocking.director_json, {});
    applyDirectorIntent(card, director);

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
    markApplied(shotId);

    return json(res, 200, {
        shot_id: shotId,
        shot_code: shot.shot_code,
        camera_before: before,
        camera_after: card.camera,
        blocking_after: {
            characters: card.characters, props: card.props,
            direction: card.direction, location_view: card.location_view, lighting: card.lighting,
        },
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
    try { ctx = loadShotContext(shotId, { previsMode: 'staged' }); } catch (err) {
        return json(res, 400, { error: err.message, code: err.code || undefined });
    }
    if (!ctx) return json(res, 404, { error: 'Shot not found' });

    try {
        // Previs Preview is allowed to show the experiment before Apply. Keep
        // that overlay local to this free preview; the durable card remains
        // untouched until the director commits it.
        if (ctx.previs && ctx.previs.director) {
            ctx.sceneCard = applyDirectorIntent({
                ...ctx.sceneCard, camera: { ...(ctx.sceneCard.camera || {}) },
            }, ctx.previs.director);
        }
        const { payload, meta } = buildCapabilityPayload('image', ctx);
        const appliedState = applicationState(shotId);
        const staged = !!ctx.previs && appliedState.staged;
        return json(res, 200, {
            shot_id: shotId,
            blocked: !!ctx.previs,
            staged,
            applied: appliedState.applied,
            card_ahead: appliedState.card_ahead,
            conflict: appliedState.conflict,
            application_state: appliedState.state,
            staged_notice: staged
                ? 'Previewing staged Previs intent. It is not applied to the Shot Board until you choose Apply to card.'
                : appliedState.card_ahead || appliedState.conflict
                    ? 'The Shot Board changed after this Previs was applied. Re-seed Previs before applying again.' : null,
            film_facts: {
                direction: ctx.sceneCard.direction || '',
                location_view: ctx.sceneCard.location_view || '',
                lighting: ctx.sceneCard.lighting || null,
                anchor_attached: !!ctx.anchorAttached,
                annotation_feedback: !!ctx.useAnnotations,
                references: (ctx.references || []).map(r => ({
                    kind: r.kind || null, name: r.name || null,
                    view: r.view || null, role: r.role || null,
                })),
                prompt_budget: (meta && meta.budget) || [],
            },
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
    /*
     * The version the shot is SHOWING, not its newest.
     *
     * Selecting an earlier attempt moves a pointer; asking for the highest here
     * made previs paint a different frame from the board, and key its URL to a
     * version the file no longer is.
     */
    const shotRow = db.prepare('SELECT current_frame_version FROM film_shots WHERE id = ?').get(shotId);
    const showing = shotRow && shotRow.current_frame_version != null
        ? shotRow.current_frame_version : null;
    const row = db.prepare(
        `SELECT a.id, a.file_name, a.project_id, a.version FROM film_assets a
          WHERE a.shot_id = ? AND a.asset_type = 'storyboard'
            AND (? IS NULL OR a.version = ?)
       ORDER BY a.version DESC, a.created_at DESC LIMIT 1`).get(shotId, showing, showing);
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
    const stagedDirector = {
        ...directorIntentFromCard(card),
        direction: card.direction || '',
        location_view: card.location_view || '',
        lighting: card.lighting || null,
    };

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

    // One reading of the card's optics, shared with playback's move — see
    // cardOptics in lib/previs-blocking.js.
    const { shotType, movement, focalMm, sensorId, fStop } = cardOptics(cam, filmDefaults);

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
    const savedRotation = Array.isArray(cam.rotation) && cam.rotation.length === 3 ? cam.rotation : null;
    const solution = solveShot({ shotType, focalMm, sensor, subject,
        azimuthDeg: savedRotation && Number.isFinite(savedRotation[0]) ? savedRotation[0] : 0 });
    if (Array.isArray(cam.position) && cam.position.length === 3 && cam.position.every(Number.isFinite)) {
        solution.position = cam.position.slice();
    }
    if (savedRotation && savedRotation.every(Number.isFinite)) solution.rotation = savedRotation.slice();

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
        /*
         * The SOLVED pose, not a hardcoded one.
         *
         * This used to persist [0, heightM, distanceM] with a zero rotation,
         * which threw away both the azimuth solveShot had just computed and any
         * camera the card itself carried — only distanceM survived. Seeding
         * therefore always faced one way however the shot was written.
         */
        position: solution.position,
        rotation: solution.rotation,
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
        director: stagedDirector,
    };

    // Saved through the same validator and sampler the editor writes through,
    // so a seeded blocking is indistinguishable from a hand-made one.
    req.body = blocking;
    return putBlocking(req, res, shotId, { seededFromCard: true });
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
        if (urlParts[4] === 'image' && urlParts[5] === 'import') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            try {
                const imported = require('../lib/media-imports').importMedia('previs-image', {
                    shotId, name: req.body && req.body.name, data: req.body && req.body.data,
                });
                return json(res, 201, imported);
            } catch (err) {
                return json(res, /not found/i.test(err.message) ? 404 : 400, { error: err.message });
            }
        }
        if (urlParts[4] === 'to-video') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            return toVideo(req, res, shotId);
        }
        /*
         * The move this shot plays over its own storyboard frame — free.
         *
         * It reads rows and does arithmetic: nothing is generated and nothing
         * is spent, which is what makes trying three lenses a question of taste
         * rather than of budget. Same track playback uses.
         */
        if (urlParts[4] === 'motion' && req.method === 'GET') {
            const track = require('../lib/shot-motion').loadShotMotion(shotId);
            if (!track) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Shot not found' }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(track));
        }
        if (urlParts[4] === 'subjects') {
            if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed' });
            return putSubjects(req, res, shotId);
        }
        if (urlParts[4] === 'director') {
            if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed' });
            return putDirector(req, res, shotId);
        }
        if (urlParts[4] === 'timeline') {
            if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed' });
            return putTimeline(req, res, shotId);
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
        if (urlParts[4] === 'lock' || urlParts[4] === 'unlock') {
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            return lockDecisions(req, res, shotId, urlParts[4] === 'lock');
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

module.exports = { handlePrevis, loadBlocking, validateBlocking, approvalState, decisionStates };
