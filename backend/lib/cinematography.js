/**
 * Direct the Shot — the creative layer, and the engine's half of it.
 *
 * THE ARCHITECTURE, AND IT IS THE WHOLE POINT:
 *
 *     engine computes FACTS  →  cinematography_brief
 *                            →  the CONNECTED MODEL reasons
 *                            →  camera_propose
 *                            →  engine VALIDATES against geometry
 *                            →  engine applies
 *
 * The connected agent host IS the language model here. That is what lets this
 * pipeline reach one with no API key of its own, and it is why `buildBrief`
 * returns no conclusion: an engine that decides and hands the model its own
 * answer is directing the film while reading as collaboration. A route that
 * called a server-side model would ask the user for a second key to answer a
 * question the attached model has already read, and fail with a billing error
 * the model cannot act on.
 *
 * So the intents below are BIAS DESCRIPTIONS handed to the model, not formulas
 * the server applies. "More heroic" is a way of seeing, and the codebase's own
 * rule about style presets applies: a rigid formula gets switched off the first
 * time it overrules a director, and takes the useful part with it.
 *
 * Pure. No database, no provider, and no llm-client — asserted by test, and by
 * the derived rule in mcp-no-server-llm.
 */

const validate = require('./camera-validate');
const { DEFAULT_SENSOR } = require('./previs-camera');

/** The seven intentions the design puts on the panel. */
const INTENTS = Object.freeze([
    'heroic', 'vulnerable', 'oppressive', 'intimate', 'chaotic', 'isolated', 'cinematic_depth',
]);

/*
 * What each intent tends to mean, in cinematographic terms — handed over so the
 * model reasons in the same vocabulary a director would, and so two people
 * asking for "more heroic" get the same kind of answer. Deliberately a
 * DESCRIPTION and not a rule: none of these is always right, and a creature
 * film may want the opposite of every one of them.
 */
const BIAS = Object.freeze({
    heroic: 'Lower the camera and widen the lens so the subject dominates and the perspective '
        + 'exaggerates. Tilt up. Let the foreground subject read large against sky or architecture.',
    vulnerable: 'Raise the camera above the subject and give them more negative space. Smaller '
        + 'frame occupancy, often a longer lens, the subject low in frame with headroom above.',
    oppressive: 'Compress the negative space. Put something in the foreground that obstructs, box '
        + 'the subject inside architecture, and let the frame close down around them.',
    intimate: 'Move closer and lengthen the lens. Shallower depth, the face and eyes prioritised, '
        + 'the background falling away rather than competing.',
    chaotic: 'Break the horizon. Roll the camera, decentre the subject, bring the foreground close '
        + 'and let the framing feel unresolved rather than composed.',
    isolated: 'Make the subject small and the environment large. Wide negative space, distance, '
        + 'the figure placed off-centre with the world dominating.',
    cinematic_depth: 'Build layers — something in the foreground, the subject in the middle, a '
        + 'separated background. Wider lens, lower camera, real spatial separation between planes.',
});

/**
 * The fields a proposal may carry.
 *
 * Spec §32: the model may move the CAMERA. It may not silently restage the
 * world, the blocking, who is in the shot, or the look — and anything outside
 * this list is refused BY NAME, because "invalid proposal" tells a model nothing
 * it can correct.
 */
const PROPOSAL_FIELDS = Object.freeze([
    'focalLengthMm', 'cameraHeightM',
    'dollyM', 'truckM', 'pedestalM',
    'panDeg', 'tiltDeg', 'rollDeg',
    'targetOccupancy', 'framingTarget', 'rig',
]);

/** The five axes a comparison reports, computed the same way for both cameras. */
const COMPARE_AXES = Object.freeze(['lens', 'height', 'distance', 'tilt', 'occupancy']);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

function targetOf(blocking) {
    const s = (blocking && blocking.subjects) || [];
    return s.find(x => x.isTarget) || s[0] || null;
}

function distanceToTarget(blocking) {
    const t = targetOf(blocking);
    const cam = (blocking && blocking.camera) || {};
    if (!t || !cam.position) return null;
    return len(sub(t.position || [0, 0, 0], cam.position));
}

/**
 * Everything the model needs, and no answer.
 *
 * If this ever grows a `changes` block it has stopped being a brief. A test
 * asserts the absence by name, because the failure is comfortable: an engine
 * that quietly decides looks exactly like one that collaborates.
 */
function buildBrief(ctx) {
    const o = ctx || {};
    const blocking = o.blocking || {};
    const camera = blocking.camera || {};
    const subjects = (blocking.subjects || []).map(s => ({
        name: s.name,
        position: s.position,
        size: s.size,
        is_framing_target: !!s.isTarget,
        screen_direction: validate.screenDirection(s, camera),
    }));
    const world = o.world || {};
    const factor = Number(world.scale_factor);
    const usable = Number.isFinite(factor) && factor > 0 ? factor : null;
    const dist = distanceToTarget(blocking);

    return {
        intent: o.intent || null,
        bias: o.intent ? (BIAS[o.intent] || null) : null,
        intents: INTENTS.slice(),
        facts: {
            camera: {
                position: camera.position,
                rotation_deg: camera.rotation,
                focal_mm: camera.focalMm,
                sensor: camera.sensorId,
                aperture: camera.fStop,
                focus_distance: camera.focusDistanceM,
                height: camera.position ? camera.position[1] : null,
            },
            subjects,
            world: {
                bounds: world.bounds || null,
                // Stated in words as well as a number: an uncalibrated world has
                // no metres to give, and a model handed a bare figure will
                // reason about it as though it did.
                scale_factor: usable,
                scale_state: usable ? 'SCALE CALIBRATED' : 'APPROXIMATE SCALE',
            },
            axis: o.axis || null,
            established_side: o.establishedSide || null,
            distance_to_target: dist,
            distance_to_target_m: usable == null || dist == null ? null : dist * usable,
        },
        contract: {
            you_may_change: PROPOSAL_FIELDS.slice(),
            you_may_not_change: ['world geometry', 'blocking', 'which subjects are in the shot',
                                 'wardrobe', 'the style preset'],
        },
        note: 'These are facts about the shot as it stands. No camera is proposed here — '
            + 'that is what you are being asked for.',
    };
}

/** The six coverage categories the design draws. Names and intents only. */
const EXPLORE_CATEGORIES = Object.freeze([
    { key: 'A', name: 'Neutral Wide',           intent: 'Orientation / geography' },
    { key: 'B', name: 'Heroic Low',             intent: 'Power / dominance' },
    { key: 'C', name: 'Long Lens Compression',  intent: 'Claustrophobic / observational' },
    { key: 'D', name: 'Extreme Foreground',     intent: 'Scale / threat' },
    { key: 'E', name: 'Over the Shoulder',      intent: 'Alignment / complicity' },
    { key: 'F', name: 'Dutch / Unstable',       intent: 'Disorientation / panic' },
]);

function exploreBrief(ctx) {
    const brief = buildBrief(ctx);
    return Object.assign(brief, {
        categories: EXPLORE_CATEGORIES.map(c => Object.assign({}, c)),
        note: 'Propose one camera per category, from the same world and the same blocking. '
            + 'Each is a camera configuration only — nothing here generates an image.',
    });
}

/** Refuse anything outside the contract, and name what was wrong. */
function validateProposal(proposal, brief) {
    const errors = [];
    const p = proposal || {};
    const changes = p.changes || {};
    if (!p.rationale || !String(p.rationale).trim()) {
        errors.push('a proposal must carry a rationale — a camera change nobody can argue with '
            + 'is one nobody can learn from');
    }
    for (const key of Object.keys(changes)) {
        if (!PROPOSAL_FIELDS.includes(key)) {
            errors.push(`"${key}" is not something a camera proposal may change. `
                + `Allowed: ${PROPOSAL_FIELDS.join(', ')}`);
        }
    }
    if (Object.keys(changes).length === 0) errors.push('the proposal changes nothing');
    const t = changes.framingTarget;
    if (t && brief && brief.facts && Array.isArray(brief.facts.subjects)
        && !brief.facts.subjects.some(s => s.name === t)) {
        errors.push(`framingTarget "${t}" is not a subject in this shot`);
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Apply a proposal, returning a NEW camera.
 *
 * Never mutates: a rejected proposal that has already been applied cannot be
 * undone, and undo is the whole reason exploring is safe.
 *
 * Translations and their reasons: `cameraHeightM` is absolute because a
 * director says "put it on the floor", not "lower it by 1.2". Dolly, truck and
 * pedestal are relative because they are moves. Pan, tilt and roll are relative
 * for the same reason.
 */
function applyProposal(camera, proposal, world, opts) {
    const o = opts || {};
    const c = camera || {};
    const ch = (proposal && proposal.changes) || {};
    const pos = (c.position || [0, 0, 0]).slice();
    const rot = (c.rotation || [0, 0, 0]).slice();

    /*
     * METRES IN, WORLD UNITS OUT.
     *
     * Every field here is named `...M` and every one of them was written
     * straight into `camera.position`, which is in the reconstruction's own
     * units. Marble promises no unit, so on a real diner calibrated at 1.75
     * units per metre an ordinary 1.6 m eye-height camera landed at 1.6 world
     * units — 2.8 m up, through the ceiling — and `inside_geometry` refused the
     * most ordinary camera in film.
     *
     * `toMetres` already exists for the other direction; this is its inverse,
     * and it obeys the same rule the scale module is built around: a NULL
     * factor is not 1.0. An uncalibrated world cannot convert a metric
     * instruction, so `metric()` returns null and the caller REFUSES rather
     * than quietly reinterpreting metres as world units — which is the silent
     * wrong answer this whole module is written against.
     */
    const factor = Number(world && world.scale_factor);
    const calibrated = Number.isFinite(factor) && factor > 0;
    const units = (m) => (calibrated ? Number(m) / factor : null);

    /*
     * AND HEIGHT IS MEASURED FROM THE FLOOR, not from the origin.
     *
     * A reconstruction's origin sits wherever Marble put it — on this diner the
     * floor is at Y = -0.967 — so "put the camera at 1.6 m" means 1.6 m above
     * the floor, which is the only reading a director means. Writing an
     * absolute Y makes the same instruction mean something different in every
     * world.
     */
    const floor = world && world.bounds && Array.isArray(world.bounds.min)
        ? Number(world.bounds.min[1]) : 0;

    if (ch.cameraHeightM !== undefined) {
        const u = units(ch.cameraHeightM);
        if (u === null) return null;
        pos[1] = (Number.isFinite(floor) ? floor : 0) + u;
    }
    if (ch.pedestalM !== undefined) {
        const u = units(ch.pedestalM); if (u === null) return null; pos[1] += u;
    }
    /*
     * CAMERA-LOCAL, read at the camera's yaw before this proposal turns it:
     * -Z is forward, so a negative dolly moves toward what it is looking at,
     * and a positive truck moves to its own right. They were added to world Z
     * and X, which is only "forward" for a camera facing due north — a camera
     * turned to the east dollied sideways.
     */
    const yaw = (Number(rot[0]) || 0) * Math.PI / 180;
    if (ch.dollyM !== undefined) {
        const u = units(ch.dollyM); if (u === null) return null;
        pos[0] += Math.sin(yaw) * u; pos[2] += Math.cos(yaw) * u;
    }
    if (ch.truckM !== undefined) {
        const u = units(ch.truckM); if (u === null) return null;
        pos[0] += Math.cos(yaw) * u; pos[2] -= Math.sin(yaw) * u;
    }

    if (ch.panDeg !== undefined) rot[0] += Number(ch.panDeg);
    if (ch.tiltDeg !== undefined) rot[1] += Number(ch.tiltDeg);
    if (ch.rollDeg !== undefined) rot[2] += Number(ch.rollDeg);

    /*
     * A FOCAL LENGTH WITHOUT A SENSOR IS HALF A CAMERA.
     *
     * A focal length only defines an angle of view relative to a sensor, so a
     * camera carrying one and not the other cannot be read back — and a real
     * shot directed through this path was written that way, with a lens and no
     * sensor, which then threw on the storyboard's optics and returned a 500
     * for the whole board.
     *
     * The film's own sensor when the caller supplied one, else the default the
     * rest of previs already opens on. Never invented beyond that: this fills
     * in what a camera needs to be legible, it does not decide the format.
     */
    const focal = ch.focalLengthMm === undefined ? c.focalMm : Number(ch.focalLengthMm);
    const sensorId = c.sensorId || (o.sensorId) || (Number(focal) > 0 ? DEFAULT_SENSOR : undefined);

    return Object.assign({}, c, {
        position: pos,
        rotation: rot,
        sensorId,
        focalMm: focal,
        rig: ch.rig === undefined ? c.rig : ch.rig,
        framingTarget: ch.framingTarget === undefined ? c.framingTarget : ch.framingTarget,
    });
}

/**
 * Take the model's candidates, keep the ones that can actually be shot, and
 * REPORT the rest. A coverage grid containing cameras inside a wall is worse
 * than a short one, and a short one padded to six is worse still.
 */
function acceptCandidates(candidates, ctx) {
    const o = ctx || {};
    const accepted = [], rejected = [];
    for (const cand of candidates || []) {
        const camera = applyProposal((o.blocking && o.blocking.camera) || {}, cand, o.world);
        // A metric candidate against an uncalibrated world cannot be placed.
        // Rejected with the remedy, never silently read as world units.
        if (camera === null) {
            rejected.push(Object.assign({}, cand, { failures: [{ check: 'uncalibrated_world',
                detail: 'this camera is given in metres and the world has no scale — calibrate it first' }] }));
            continue;
        }
        const blocking = Object.assign({}, o.blocking, { camera });
        const out = validate.validateCamera(camera, o.world, blocking, {
            axis: o.axis, establishedSide: o.establishedSide, strict: false,
        });
        // Advisory failures do not disqualify a candidate — crossing the line is
        // a choice, and Explore is where you look at choices.
        const hard = out.failures.filter(f => !validate.ADVISORY.includes(f.check));
        if (hard.length === 0) accepted.push(Object.assign({}, cand, { camera, warnings: out.failures }));
        else rejected.push(Object.assign({}, cand, { failures: hard }));
    }
    return {
        accepted, rejected,
        shortfall: Math.max(0, EXPLORE_CATEGORIES.length - accepted.length),
        note: rejected.length
            ? `${rejected.length} candidate(s) could not be shot and were dropped, with reasons.`
            : null,
    };
}

/** Has this camera reversed a subject's established screen direction? */
function screenDirectionWarning(current, established) {
    if (!current || !established || !established.subject) return null;
    const subj = ((current.subjects || []).find(s => s.name === established.subject));
    if (!subj) return null;
    const now = validate.screenDirection(subj, current.camera);
    if (now === 'centre' || !established.direction || now === established.direction) return null;
    return {
        subject: established.subject,
        from: established.direction,
        to: now,
        shot: established.shot_code,
        // The shot is NAMED. A count sends the reader to the database.
        message: `This camera reverses ${established.subject}'s screen direction from shot `
            + `${established.shot_code}: ${established.direction} → ${now}.`,
    };
}

/** Two cameras on the same axes, each computed the same way. */
function compareCameras(a, b) {
    const axis = (label, fa, fb) => ({ label, a: fa, b: fb });
    const of = (side) => {
        const c = (side && side.camera) || {};
        const bl = side && side.blocking;
        const d = distanceToTarget(bl || { camera: c, subjects: [] });
        return {
            lens: c.focalMm == null ? null : `${c.focalMm}mm`,
            height: c.position ? Number(c.position[1].toFixed(2)) : null,
            distance: d == null ? null : Number(d.toFixed(2)),
            tilt: c.rotation ? c.rotation[1] : null,
            occupancy: side && side.occupancy != null ? side.occupancy : null,
        };
    };
    const A = of(a), B = of(b);
    return {
        axes: COMPARE_AXES.map(k => axis(k, A[k], B[k])),
    };
}

module.exports = {
    INTENTS, BIAS, PROPOSAL_FIELDS, EXPLORE_CATEGORIES, COMPARE_AXES,
    buildBrief, exploreBrief, validateProposal, applyProposal, acceptCandidates,
    screenDirectionWarning, compareCameras,
};
