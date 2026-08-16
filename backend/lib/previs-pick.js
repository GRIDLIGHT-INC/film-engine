/**
 * Picking and placing — the inverse of the previs projection.
 *
 * Typing three numbers into three boxes is not staging a scene. Dragging an
 * object needs the projection run backwards: a point on the screen back to a
 * point on the floor. That inverse is where sign errors live, and a sign error
 * here does not crash — the object simply slides the wrong way, which reads as
 * "the tool is broken" rather than as a bug with an address.
 *
 * Kept here, in a pure module, so the round trip can be asserted without a
 * browser. `projectPoint` is deliberately the same maths the viewer draws with:
 * a picker that disagrees with the renderer selects things you are not pointing
 * at, and that disagreement is invisible until someone tries to use it.
 */

const { PRIMITIVES, humanProxy } = require('./previs-primitives');

/** Comfortably bigger than a mouse can be expected to land. A person seen
 *  edge-on is a few pixels wide, and demanding a pixel-perfect hit reads as
 *  broken rather than precise. */
const DEFAULT_PICK_RADIUS = 18;

/** How far from the camera a drag may land before it is refused as a
 *  horizon artefact. Generous — a previs stage is metres, not hundreds. */
const DEFAULT_MAX_GROUND_M = 200;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

/**
 * The camera basis, built once and shared by the projection and its inverse.
 *
 * `up` is derived rather than assumed to be +Y so a near-top-down camera does
 * not collapse: looking straight down makes forward parallel to world up, and
 * the naive cross product degenerates to a zero-length right vector.
 */
function basis(eye, target) {
    const forward = norm(sub(target, eye));
    const reference = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
    const right = norm(cross(forward, reference));
    const up = cross(right, forward);
    return { forward, right, up };
}

/** World -> screen. The same transform the viewer paints with. */
function projectPoint(point, eye, target, vFovDeg, view) {
    const { forward, right, up } = basis(eye, target);
    const d = sub(point, eye);
    const z = dot(d, forward);
    if (z <= 0.02) return null;                       // behind the eye

    const f = 1 / Math.tan(vFovDeg * Math.PI / 180 / 2);
    const aspect = view.w / view.h;
    return {
        x: view.x + (dot(d, right) / z) * (f / aspect) * view.w / 2 + view.w / 2,
        y: view.y - (dot(d, up) / z) * f * view.h / 2 + view.h / 2,
        z,
    };
}

/**
 * Screen -> the point on the floor under it.
 *
 * Rebuilds the ray the projection collapsed, then intersects y = 0. Returns
 * null when the ray never reaches the floor — looking at the horizon or above
 * it — because the alternative is an intersection several kilometres away that
 * the caller would happily place an object at.
 */
function groundPoint(screenX, screenY, eye, target, vFovDeg, view, planeY, opts) {
    const { forward, right, up } = basis(eye, target);
    const f = 1 / Math.tan(vFovDeg * Math.PI / 180 / 2);
    const aspect = view.w / view.h;

    const ndcX = (screenX - view.x - view.w / 2) / (view.w / 2);
    const ndcY = (view.y + view.h / 2 - screenY) / (view.h / 2);

    const cameraX = ndcX * aspect / f;
    const cameraY = ndcY / f;

    const ray = norm([
        forward[0] + right[0] * cameraX + up[0] * cameraY,
        forward[1] + right[1] * cameraX + up[1] * cameraY,
        forward[2] + right[2] * cameraX + up[2] * cameraY,
    ]);

    const y = planeY === undefined ? 0 : planeY;
    if (Math.abs(ray[1]) < 1e-9) return null;         // parallel to the floor
    const t = (y - eye[1]) / ray[1];
    if (t <= 0) return null;                          // the floor is behind us

    const hit = [eye[0] + ray[0] * t, y, eye[2] + ray[2] * t];

    // The intersection is UNBOUNDED as the ray flattens toward the horizon, and
    // near-horizon pixels are a large part of a low-pitched view. Dragging there
    // sent an object tens of metres away in one mouse move. Refused rather than
    // clamped: a clamped point is still somewhere the user did not click, and an
    // object that simply stops following past the horizon is easier to trust
    // than one that leaps to the edge of the stage.
    const limit = (opts && opts.maxDistanceM) || DEFAULT_MAX_GROUND_M;
    const from = (opts && opts.originM) || [eye[0], 0, eye[2]];
    if (Math.hypot(hit[0] - from[0], hit[2] - from[2]) > limit) return null;

    return hit;
}

/**
 * The axis-aligned box an object occupies.
 *
 * Used for hit testing rather than the full geometry: a person is eight boxes
 * and a sphere is a couple of hundred vertices, and testing every edge to
 * answer "did they click this" is work nobody can see.
 */
function objectBounds(object) {
    const spec = PRIMITIVES[object.kind];
    if (!spec) throw new Error(`previs: unknown primitive '${object.kind}'`);

    // A rotated object no longer fits its declared box, so the bounds come from
    // the geometry that was actually drawn. Skipped when unrotated, because the
    // analytic box is cheaper and this runs on every mouse move.
    if (object.rotationDeg && object.rotationDeg.some(v => v)) {
        const { primitiveGeometry } = require('./previs-primitives');
        const vs = primitiveGeometry(object).vertices;
        return {
            min: [0, 1, 2].map(a => Math.min(...vs.map(v => v[a]))),
            max: [0, 1, 2].map(a => Math.max(...vs.map(v => v[a]))),
        };
    }

    const size = (object.sizeM && object.sizeM.length === 3) ? object.sizeM : spec.defaultSizeM;
    const [x, y, z] = object.position || [0, 0, 0];

    // A figure is sized by HEIGHT alone — its width and depth follow from the
    // proportions, so a typed width means nothing for it. Taking the declared
    // width instead left the arms outside the pick box, which is a person you
    // cannot click on the part of them sticking out.
    if (object.kind === 'human') {
        const parts = humanProxy(size[1]);
        let halfW = 0;
        let halfD = 0;
        for (const part of parts) {
            halfW = Math.max(halfW, Math.abs(part.centreM[0]) + part.sizeM[0] / 2);
            halfD = Math.max(halfD, Math.abs(part.centreM[2]) + part.sizeM[2] / 2);
        }
        return { min: [x - halfW, y, z - halfD], max: [x + halfW, y + size[1], z + halfD] };
    }

    // Every other primitive stands ON its position, so the box runs upward.
    return {
        min: [x - size[0] / 2, y, z - size[2] / 2],
        max: [x + size[0] / 2, y + size[1], z + size[2] / 2],
    };
}

/** The eight corners of a bounds box, which is what gets projected. */
function boundsCorners(bounds) {
    const { min, max } = bounds;
    const corners = [];
    for (const x of [min[0], max[0]]) {
        for (const y of [min[1], max[1]]) {
            for (const z of [min[2], max[2]]) corners.push([x, y, z]);
        }
    }
    return corners;
}

/**
 * Which object is under this screen point?
 *
 * Projects each object's bounds, takes the screen rectangle they cover, and
 * returns the NEAREST object whose rectangle contains the point. Nearest, not
 * first: two objects on one sight line must resolve to the one in front, or
 * clicking edits something hidden behind what you are looking at.
 *
 * @param {function} project  world point -> {x, y, z} or null, injected so the
 *                            picker and the renderer cannot drift apart
 * @returns {number} index into `objects`, or -1
 */
function pickObject(screenX, screenY, objects, project, radius) {
    const slack = radius === undefined ? DEFAULT_PICK_RADIUS : radius;
    let best = -1;
    let bestDepth = Infinity;

    (objects || []).forEach((object, index) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let depth = Infinity;
        let visible = false;

        for (const corner of boundsCorners(objectBounds(object))) {
            const p = project(corner);
            if (!p) continue;
            visible = true;
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
            depth = Math.min(depth, p.z);
        }
        if (!visible) return;

        const inside = screenX >= minX - slack && screenX <= maxX + slack
            && screenY >= minY - slack && screenY <= maxY + slack;
        if (inside && depth < bestDepth) { best = index; bestDepth = depth; }
    });

    return best;
}

/**
 * A view that contains everything.
 *
 * Orbiting away from a scene is easy and orbiting back is fiddly, so "reframe"
 * has to genuinely contain the stage rather than re-centre on the origin and
 * hope. Returns the bounding sphere of every object AND the shot camera —
 * leaving the camera out would frame the subject while the thing being blocked
 * sat off screen.
 */
function frameAll(objects, cameraPosition) {
    const { primitiveGeometry } = require('./previs-primitives');

    const points = [];
    for (const object of objects || []) {
        try { points.push(...primitiveGeometry(object).vertices); } catch (_) { /* skip unknown kinds */ }
    }
    if (Array.isArray(cameraPosition)) points.push(cameraPosition);

    if (!points.length) {
        // Nothing staged. A default that shows the floor rather than a
        // degenerate zero-radius view the orbit maths cannot use.
        return { centre: [0, 0.8, 0], radius: 4, distance: 12 };
    }

    const min = [0, 1, 2].map(a => Math.min(...points.map(p => p[a])));
    const max = [0, 1, 2].map(a => Math.max(...points.map(p => p[a])));
    const centre = [0, 1, 2].map(a => (min[a] + max[a]) / 2);

    // The true bounding radius, not half the diagonal of the box: the corners
    // of a box are further out than its faces, and a radius taken from the box
    // clips the very objects it was measured from.
    let radius = 0;
    for (const p of points) {
        radius = Math.max(radius, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]));
    }
    radius = Math.max(radius, 1);

    // Pulled back far enough that the sphere fits a 45-degree view, with a
    // little air so nothing sits on the frame edge.
    const distance = Math.max(2, radius / Math.tan(22.5 * Math.PI / 180) * 1.15);
    return { centre, radius, distance };
}

module.exports = {
    projectPoint, groundPoint, pickObject, objectBounds, boundsCorners, basis, frameAll,
    DEFAULT_PICK_RADIUS, DEFAULT_MAX_GROUND_M,
};
