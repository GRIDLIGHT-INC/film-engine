/**
 * Can this camera actually be shot?
 *
 * Six checks, and the reason there are six rather than one is that the failure
 * is partial by nature: a validator that catches five is indistinguishable from
 * one that works, and the sixth ships a camera inside a wall.
 *
 * Pure — no database, no provider, and deliberately no language model. This is
 * the half of the directing layer the ENGINE owns: the model proposes a camera,
 * and geometry decides whether it exists. Judgement is the model's; physics is
 * ours, and physics is the part that can be checked.
 *
 * THE 180° RULE WARNS AND DOES NOT BLOCK. Crossing the line is a real creative
 * choice, and a validator that refuses the save is one a director switches off
 * within a day — taking the five checks that should have blocked with it.
 * Strict mode is opt-in, per shot, for the sequence where continuity is the
 * point.
 *
 * Convention throughout is the engine's own: right-handed, +Y up, camera looks
 * down −Z, degrees on the wire.
 */

const DEG = Math.PI / 180;

/** The near plane. Closer than this and the subject is inside the lens. */
const NEAR_M = 0.1;

const CHECKS = Object.freeze([
    'inside_geometry',
    'subject_behind_camera',
    'clipping',
    'focus_impossible',
    'occluded',
    'line_crossed',
]);

/** Only `line_crossed` is advisory; everything else means the shot cannot exist. */
const ADVISORY = Object.freeze(['line_crossed']);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Where the camera is pointing. Mirrors shot-motion.aimVector exactly. */
function aimVector(rotation) {
    const yaw = (rotation && rotation[0] || 0) * DEG;
    const pitch = (rotation && rotation[1] || 0) * DEG;
    const base = [0, Math.sin(pitch), -Math.cos(pitch)];
    return [
        base[0] * Math.cos(yaw) + base[2] * Math.sin(yaw),
        base[1],
        -base[0] * Math.sin(yaw) + base[2] * Math.cos(yaw),
    ];
}

/** The axis-aligned box a staged subject occupies, standing on its position. */
function boxOf(subject) {
    const p = subject.position || [0, 0, 0];
    // A staged subject carries sizeM (width, height, depth); `size` is the older name.
    const s = subject.size || subject.sizeM || [0.5, 1.7, 0.3];
    return {
        min: [p[0] - s[0] / 2, p[1], p[2] - s[2] / 2],
        max: [p[0] + s[0] / 2, p[1] + s[1], p[2] + s[2] / 2],
    };
}

function insideBox(p, box, pad) {
    const e = pad || 0;
    return p[0] >= box.min[0] - e && p[0] <= box.max[0] + e
        && p[1] >= box.min[1] - e && p[1] <= box.max[1] + e
        && p[2] >= box.min[2] - e && p[2] <= box.max[2] + e;
}

/** Slab test: does the segment from `a` to `b` pass through `box`? */
function segmentHitsBox(a, b, box) {
    const d = sub(b, a);
    let t0 = 0, t1 = 1;
    for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-9) {
            if (a[i] < box.min[i] || a[i] > box.max[i]) return false;
            continue;
        }
        let lo = (box.min[i] - a[i]) / d[i];
        let hi = (box.max[i] - a[i]) / d[i];
        if (lo > hi) { const t = lo; lo = hi; hi = t; }
        t0 = Math.max(t0, lo);
        t1 = Math.min(t1, hi);
        if (t0 > t1) return false;
    }
    return true;
}

/**
 * Which side of the scene axis a point falls on.
 *
 * Three answers, not two. A camera exactly on the line belongs to neither side,
 * and assigning it one at random is how the 180° warning comes to fire — or stay
 * quiet — by coin toss on the one position where the answer genuinely matters.
 */
function sideOfAxis(point, axis) {
    if (!axis || !axis.a || !axis.b) return 'ON_AXIS';
    const ax = axis.b[0] - axis.a[0];
    const az = axis.b[2] - axis.a[2];
    const px = point[0] - axis.a[0];
    const pz = point[2] - axis.a[2];
    const cross = ax * pz - az * px;
    // Scaled to the axis length, so the tolerance means the same thing on a
    // two-metre axis and a forty-metre one.
    const scale = Math.max(1e-6, Math.hypot(ax, az));
    if (Math.abs(cross) / scale < 1e-6) return 'ON_AXIS';
    return cross > 0 ? 'A' : 'B';
}

/** Which way a subject sits in frame from this camera. */
function screenDirection(subject, camera) {
    const p = (subject && subject.position) || [0, 0, 0];
    const eye = (camera && camera.position) || [0, 0, 0];
    const aim = aimVector(camera && camera.rotation);
    const right = [-aim[2], 0, aim[0]];          // aim x up, for a Y-up world
    const rl = len(right) || 1;
    const lateral = dot(sub(p, eye), [right[0] / rl, right[1] / rl, right[2] / rl]);
    if (Math.abs(lateral) < 0.05) return 'centre';
    return lateral > 0 ? 'right' : 'left';
}

/**
 * Run every check. Returns each failure by name, so a caller can say which one
 * rather than "invalid camera".
 */
function validateCamera(camera, world, blocking, opts) {
    const o = opts || {};
    const failures = [];
    /*
     * A CHECK THAT COULD NOT RUN IS NOT A CHECK THAT PASSED.
     *
     * With no world pinned there are no bounds, so `inside_geometry` cannot
     * fire — and a camera forty metres under the floor came back clean. A green
     * tick against a rule that was never applied is worse than silence: it is
     * the same failure this codebase already records for a runtime QA check on
     * a film with no target duration.
     */
    const skipped = [];
    const eye = (camera && camera.position) || [0, 0, 0];
    const aim = aimVector(camera && camera.rotation);
    const subjects = (blocking && blocking.subjects) || [];
    const target = subjects.find(s => s.isTarget) || subjects[0] || null;

    // 1 · inside geometry — under the floor, outside the reconstruction, or
    //     standing inside a staged subject.
    const bounds = world && world.bounds;
    if (!bounds) {
        skipped.push({ check: 'inside_geometry',
            why: 'this shot has no world pinned, so there is no geometry to be inside' });
    }
    if (bounds && (eye[1] < bounds.min[1] || eye[1] > bounds.max[1]
        || eye[0] < bounds.min[0] || eye[0] > bounds.max[0]
        || eye[2] < bounds.min[2] || eye[2] > bounds.max[2])) {
        failures.push({ check: 'inside_geometry',
            detail: `the camera is outside the reconstructed world at [${eye.map(n => n.toFixed(1))}]` });
    } else if (subjects.some(s => insideBox(eye, boxOf(s)))) {
        const s = subjects.find(x => insideBox(eye, boxOf(x)));
        failures.push({ check: 'inside_geometry', detail: `the camera is inside ${s.name || 'a staged subject'}` });
    }

    if (!target) {
        for (const c of ['subject_behind_camera', 'clipping', 'occluded']) {
            skipped.push({ check: c, why: 'nothing is staged in this shot, so there is no subject to check against' });
        }
    }
    if (target) {
        /*
         * The subject's CENTRE, not its feet. A low camera looking up at a
         * face has the feet behind its image plane and the person squarely in
         * frame; testing the feet refused every low-angle close-up.
         */
        const tb = boxOf(target);
        const centre = [(tb.min[0] + tb.max[0]) / 2, (tb.min[1] + tb.max[1]) / 2, (tb.min[2] + tb.max[2]) / 2];
        const toSubject = sub(centre, eye);
        const along = dot(toSubject, aim);

        // 2 · the subject is behind the lens
        if (along <= 0) {
            failures.push({ check: 'subject_behind_camera',
                detail: `${target.name || 'the subject'} is behind the camera` });
        } else if (along < NEAR_M) {
            // 3 · nearer than the near plane
            failures.push({ check: 'clipping',
                detail: `${target.name || 'the subject'} is ${along.toFixed(2)}m away, inside the ${NEAR_M}m near plane` });
        }

        // 5 · something solid between the camera and the subject
        for (const s of subjects) {
            if (s === target) continue;
            if (segmentHitsBox(eye, centre, boxOf(s))) {
                failures.push({ check: 'occluded',
                    detail: `${s.name || 'a subject'} stands between the camera and ${target.name || 'the subject'}` });
                break;
            }
        }
    }

    // 4 · a focus that cannot be set
    const focus = camera && camera.focusDistanceM;
    if (focus !== undefined && focus !== null && !(Number(focus) > 0 && Number.isFinite(Number(focus)))) {
        failures.push({ check: 'focus_impossible', detail: `focus distance ${focus} is not a distance` });
    }

    // 6 · the line — advisory unless strict
    if (!(o.axis && o.establishedSide)) {
        skipped.push({ check: 'line_crossed',
            why: 'no scene axis has been established, so there is no line to cross' });
    }
    if (o.axis && o.establishedSide) {
        const side = sideOfAxis(eye, o.axis);
        if (side !== 'ON_AXIS' && side !== o.establishedSide) {
            failures.push({ check: 'line_crossed',
                detail: `this camera is on side ${side} of the axis; the scene was established on side ${o.establishedSide}` });
        }
    }

    const blockingFailures = failures.filter(f =>
        !ADVISORY.includes(f.check) || o.strict === true);

    return {
        ok: failures.length === 0,
        blocking: blockingFailures.length > 0,
        failures,
        // Named, never folded into a pass.
        skipped,
        checked: CHECKS.filter(c => !skipped.some(s2 => s2.check === c)),
    };
}

module.exports = { CHECKS, ADVISORY, validateCamera, sideOfAxis, screenDirection, aimVector, NEAR_M };
