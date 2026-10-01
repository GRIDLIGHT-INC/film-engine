/**
 * Where things stand, said in words an image model can act on.
 *
 * Previs could stage a scene in 3D and generation was blind to it. `previsFacets`
 * carried `objects` through untouched and `previsPromptParts` emitted framing,
 * focal length, angle, movement and distance — every one of them a fact about
 * the CAMERA. So a director could place the dragon in the near foreground with
 * its back to us and MAYA across the road facing camera, and the image prompt
 * said nothing about where either of them was. Previs was a camera calculator
 * wearing the name of a blocking tool.
 *
 * That is the difference this module exists to close: blocking a shot is
 * deciding what is in it and where, directing it is deciding where the camera
 * goes, and the second was the only one that reached a prompt.
 *
 * ── Only NAMED objects speak ──────────────────────────────────────────────
 *
 * A staged object with no name is scaffolding — a proxy wall, a mark on the
 * floor, a box standing in for something. Describing it would put a literal box
 * in the frame, which is worse than saying nothing, so the rule is the same one
 * markup already follows: geometry says WHERE, never WHAT, and a name is what
 * makes a position sayable. Unnamed objects are REPORTED as unsaid rather than
 * dropped silently, because a director who staged five things and sees three in
 * the prompt needs to know which two were scaffolding.
 *
 * ── Frame-relative, not world-relative ────────────────────────────────────
 *
 * "MAYA at x=2.4, z=11" means nothing to an image model. What it can act on is
 * "MAYA in the mid-ground at frame right, facing camera" — which is the same
 * fact expressed from the camera that is about to take the picture. So every
 * phrase is computed by projecting into the camera's own basis: it changes when
 * the camera moves, which is exactly right, because the blocking did not change
 * but what the shot SHOWS did.
 */

const { sensorFor, DEFAULT_SENSOR } = require('./previs-camera');
const { basis } = require('./previs-pick');
const { hasPath, subjectPoseAt, pathSummary } = require('./previs-subject-path');

const D2R = Math.PI / 180;

/*
 * Kinds with a front, so "facing camera" means something.
 *
 * A sphere and a crate have no face, and "the crate is facing camera" is noise
 * in a prompt already fighting for room. Named against the primitive registry
 * rather than guessed: the seeder invented the kinds `figure` and `box`, which
 * exist nowhere in PRIMITIVES, so every seeded subject failed validation and
 * the stage came back empty — a fault that looked like the feature not working
 * at all.
 */
const FACING_KINDS = new Set(['human', 'mesh', 'imageplane']);

/**
 * Lateral bands across the frame.
 *
 * Boundaries are in normalised frame width (-1 = left edge, +1 = right edge).
 * A third either side of centre, because thirds are how a frame is actually
 * composed and how a director says it.
 */
const LATERAL_BANDS = [
    { max: -1.0, phrase: 'just outside the left edge of frame', offFrame: true },
    { max: -0.33, phrase: 'at frame left' },
    { max: 0.33, phrase: 'centre frame' },
    { max: 1.0, phrase: 'at frame right' },
    { max: Infinity, phrase: 'just outside the right edge of frame', offFrame: true },
];

/**
 * Depth bands, measured against the framing subject's distance rather than in
 * metres. Three metres is the foreground of a close-up and the background of a
 * landscape, so an absolute measure would be wrong at one end or the other.
 */
const DEPTH_BANDS = [
    { max: 0.45, phrase: 'in the near foreground' },
    { max: 0.8, phrase: 'in the foreground' },
    { max: 1.25, phrase: 'in the mid-ground' },
    { max: 2.5, phrase: 'in the background' },
    { max: Infinity, phrase: 'far in the background' },
];

/**
 * Facing, from the angle between where a thing points and where the camera is.
 *
 * An object's forward is +Z turned by its yaw — the convention `rotateOffset`
 * already implements, read off its own matrix rather than assumed, since a sign
 * error here reads as "facing camera" for something with its back to us and
 * would be invisible until a frame came back wrong.
 */
const FACING_BANDS = [
    { max: 45, phrase: 'facing camera' },
    { max: 115, phrase: 'side-on to camera' },
    { max: 180, phrase: 'facing away from camera' },
];

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function len(a) { return Math.hypot(a[0], a[1], a[2]); }
function norm(a) { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
function band(bands, value) {
    for (const b of bands) if (value <= b.max) return b;
    return bands[bands.length - 1];
}

/** The direction a staged object points, from its yaw. */
function forwardOf(rotationDeg) {
    const yaw = (rotationDeg && Number(rotationDeg[0])) || 0;
    // rotateOffset's yaw: [x,y,z] -> [x*c + z*s, y, -x*s + z*c]; applied to +Z.
    return [Math.sin(yaw * D2R), 0, Math.cos(yaw * D2R)];
}

/**
 * Where each named object sits in the frame this camera would shoot.
 *
 * Returns { said, unsaid } rather than an array, because "nothing was staged"
 * and "five things were staged and none of them had a name" are different
 * situations needing different fixes, and a bare array cannot tell them apart.
 */
function stagingFacts(previs) {
    const out = { said: [], unsaid: [] };
    if (!previs) return out;

    const camera = previs.camera || {};
    const camPos = Array.isArray(camera.position) ? camera.position.map(Number) : null;
    const subjects = Array.isArray(previs.subjects) ? previs.subjects
        : (Array.isArray(previs.objects) ? previs.objects : []);
    if (!camPos || !subjects.length) return out;

    // What the camera is pointed at: the explicit target, or the framing
    // subject, or straight down its own -Z if neither is known.
    const target = previs.target || subjects.find(o => o && o.isTarget) || null;
    const aimPoint = target && Array.isArray(target.position)
        ? target.position.map(Number) : null;
    const forward = aimPoint ? norm(sub(aimPoint, camPos)) : [0, 0, 1];
    const targetDist = aimPoint ? len(sub(aimPoint, camPos)) : null;

    /*
     * The camera basis comes from previs-pick, which is what the renderer
     * projects with. Recomputing it here would be four lines and one sign, and
     * a sign error would describe something on the left of the picture as being
     * at frame right — a mistake invisible in words and obvious only when a
     * generated frame comes back mirrored. The prose has to agree with the
     * picture the director is looking at, so it is derived from the same
     * function that draws it, including its care over a straight-down camera.
     */
    const { right } = basis(camPos, aimPoint || [camPos[0], camPos[1], camPos[2] + 1]);

    // Half the horizontal angle of view, which is what turns a lateral offset
    // into a position in the FRAME rather than a distance in the world.
    /*
     * The blocking stores `sensorId`; a hand-built context may say `sensor`;
     * and `sensorFor` THROWS on an unknown one. Staging is an enhancement to a
     * prompt, so it must never be the reason a generation fails — the same rule
     * fingerprinting follows, and for the same reason: by the time this runs
     * the director is committed to the shot. An unknown sensor falls back to
     * the default rather than taking the whole prompt down with it.
     */
    let sensor;
    try {
        sensor = sensorFor(camera.sensorId || camera.sensor || DEFAULT_SENSOR);
    } catch (_) {
        sensor = sensorFor(DEFAULT_SENSOR);
    }
    const focal = Number(camera.focal_mm || camera.focalMm) > 0
        ? Number(camera.focal_mm || camera.focalMm) : 50;
    const halfFovTan = (sensor.widthMm / 2) / focal;

    for (const obj of subjects) {
        if (!obj || !Array.isArray(obj.position)) continue;
        // A subject that moves is described where it STARTS: a still is the first frame.
        const moves = hasPath(obj);
        const startAt = moves ? subjectPoseAt(obj, 0).position : obj.position;
        const name = String(obj.name || obj.label || '').trim();
        if (!name) {
            out.unsaid.push({
                kind: obj.kind || 'object',
                position: obj.position,
                reason: 'no name — a staged object with no name is scaffolding, and describing it '
                    + 'would put a literal box in the frame',
            });
            continue;
        }

        const v = sub(startAt.map(Number), camPos);
        const depth = dot(v, forward);
        if (depth <= 0) {
            out.unsaid.push({
                name, kind: obj.kind || 'object',
                reason: 'behind the camera — it is staged, but this shot does not see it',
            });
            continue;
        }

        const lateral = dot(v, right);
        const x = lateral / (depth * halfFovTan);       // -1 .. 1 across the frame
        const lat = band(LATERAL_BANDS, x);

        const ratio = targetDist && targetDist > 0 ? depth / targetDist : 1;
        const dep = band(DEPTH_BANDS, ratio);

        // Facing is only meaningful for something with a front. A sphere or a
        // box has no face, and "the crate is facing camera" is noise.
        let facing = null;
        if (obj.rotationDeg && FACING_KINDS.has(obj.kind)) {
            const fwd = forwardOf(obj.rotationDeg);
            const toCam = norm([-v[0], 0, -v[2]]);       // horizontal only
            const cosang = Math.max(-1, Math.min(1, dot(fwd, toCam)));
            const deg = Math.acos(cosang) / D2R;
            facing = band(FACING_BANDS, deg).phrase;
        }

        /*
         * Moving: one short clause, from the camera, in the words a director
         * uses — which way across the frame, and running or walking. The route
         * itself is the video's business; a still only needs to know it is a
         * moment in a run, not a pose.
         */
        let motion = null;
        if (moves) {
            const sum = pathSummary(obj);
            const d = [sum.to[0] - sum.from[0], 0, sum.to[2] - sum.from[2]];
            const across = dot(d, right), toward = dot(d, forward);
            const person = obj.kind === 'human' || (obj.model && ['man', 'woman', 'boy', 'girl'].includes(obj.model.library));
            const verb = person ? (sum.speedMs >= 2.2 ? 'running' : 'walking') : 'moving';
            const way = Math.hypot(across, toward) < 0.2 ? '' : (Math.abs(across) > Math.abs(toward)
                ? (across > 0 ? ' toward frame right' : ' toward frame left')
                : (toward < 0 ? ' toward camera' : ' away from camera'));
            motion = verb + way;
        }

        out.said.push({
            name,
            kind: obj.kind || 'object',
            phrase: `${name} ${dep.phrase} ${lat.phrase}` + (motion ? `, ${motion}` : (facing ? `, ${facing}` : '')),
            motion,
            frame_x: Number(x.toFixed(3)),
            depth_ratio: Number(ratio.toFixed(3)),
            off_frame: !!lat.offFrame,
            facing,
        });
    }

    // Nearest first: what is closest to camera dominates the frame, and a model
    // reading a list weights what it reads first.
    out.said.sort((a, b) => a.depth_ratio - b.depth_ratio);
    return out;
}

/**
 * One clause naming where everything stands, or null when nothing can be said.
 *
 * Null rather than an empty string so a caller cannot append emptiness and
 * leave a dangling separator in a prompt that is already fighting for room.
 */
function stagingPhrase(previs) {
    const facts = stagingFacts(previs);
    if (!facts.said.length) return null;
    return `Staging: ${facts.said.map(f => f.phrase).join('; ')}`;
}

module.exports = {
    stagingFacts, stagingPhrase, forwardOf,
    LATERAL_BANDS, DEPTH_BANDS, FACING_BANDS,
};
