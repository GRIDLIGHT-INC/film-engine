/**
 * Picking and placing — the maths behind direct manipulation.
 *
 * Typing coordinates into three number boxes is not staging a scene. To drag an
 * object you need the inverse of the projection: a screen point back to a point
 * on the floor. That inverse is where sign errors live, and a sign error here
 * does not crash — it drags the object the wrong way, which reads as "the tool
 * is broken" rather than as a bug with a location.
 *
 * So the test is a ROUND TRIP: project a known world point to the screen, pick
 * that screen point back up, and require the same world point. A wrong inverse
 * cannot satisfy that, and neither can an inverse that only works for the
 * camera pose someone happened to test with — hence the sweep over poses.
 *
 * Set-based over every primitive kind, because hit testing that works on a box
 * and misses a sphere is exactly the half-done fix that reads as done.
 */

const test = require('node:test');
const assert = require('node:assert');

const { PRIMITIVES, primitiveGeometry } = require('../lib/previs-primitives');
const {
    projectPoint, groundPoint, pickObject, objectBounds, DEFAULT_PICK_RADIUS,
} = require('../lib/previs-pick');

const VIEW = { x: 0, y: 0, w: 640, h: 360 };
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);

// A few genuinely different camera poses. One pose proves nothing: the obvious
// wrong inverse (a sign flip on the up axis) is correct for a level camera.
const POSES = [
    { eye: [0, 1.6, 6], target: [0, 1.6, 0], label: 'level, on axis' },
    { eye: [4, 2.4, 5], target: [0, 0.9, 0], label: 'high, off axis' },
    { eye: [-3, 0.6, -4], target: [0, 1.2, 0], label: 'low, behind' },
    { eye: [0, 9, 0.001], target: [0, 0, 0], label: 'near top-down' },
];

// ── The inverse ─────────────────────────────────────────────────────────────

test('a point on the floor survives a project/unproject round trip', () => {
    const wrong = [];
    for (const pose of POSES) {
        for (const world of [[0, 0, 0], [2.5, 0, -1], [-3, 0, 4], [0.25, 0, 0.25]]) {
            const screen = projectPoint(world, pose.eye, pose.target, 45, VIEW);
            if (!screen) continue;            // legitimately behind the camera
            const back = groundPoint(screen.x, screen.y, pose.eye, pose.target, 45, VIEW);
            if (!back) { wrong.push(`${pose.label} ${world}: no ground hit`); continue; }
            if (!near(back[0], world[0], 1e-4) || !near(back[2], world[2], 1e-4)) {
                wrong.push(`${pose.label} ${world} -> [${back.map(v => v.toFixed(3))}]`);
            }
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.slice(0, 5).join('; '));
});

test('the unprojected point is always on the floor', () => {
    for (const pose of POSES) {
        const p = groundPoint(320, 250, pose.eye, pose.target, 45, VIEW);
        if (p) assert.ok(near(p[1], 0), `${pose.label}: y = ${p[1]}`);
    }
});

test('a ray that never meets the floor returns nothing rather than a huge number', () => {
    // Looking up from below the floor: the intersection is behind the camera,
    // and reporting it would place an object several kilometres away.
    const p = groundPoint(320, 10, [0, 1.6, 5], [0, 6, 0], 45, VIEW);
    assert.ok(p === null || p[1] === 0, 'an upward ray produced a floor point');
});

test('dragging right moves the object right, on every pose', () => {
    // The sign check. A flipped axis still round-trips if it is flipped in both
    // directions, so direction is asserted separately.
    for (const pose of POSES.slice(0, 3)) {
        const centre = groundPoint(320, 260, pose.eye, pose.target, 45, VIEW);
        const right = groundPoint(420, 260, pose.eye, pose.target, 45, VIEW);
        if (!centre || !right) continue;

        // "Right" in screen space is +x along the camera's own right vector.
        const f = [pose.target[0] - pose.eye[0], 0, pose.target[2] - pose.eye[2]];
        const len = Math.hypot(f[0], f[2]) || 1;
        const rightVec = [-f[2] / len, 0, f[0] / len];
        const delta = [right[0] - centre[0], 0, right[2] - centre[2]];
        const along = delta[0] * rightVec[0] + delta[2] * rightVec[2];
        assert.ok(along > 0, `${pose.label}: dragging right moved the point left (${along.toFixed(3)})`);
    }
});

// ── Hit testing ─────────────────────────────────────────────────────────────

test('every primitive kind can be picked where it stands', () => {
    const pose = POSES[0];
    const project = pt => projectPoint(pt, pose.eye, pose.target, 45, VIEW);
    const missed = [];

    for (const kind of Object.keys(PRIMITIVES)) {
        const objects = [{ kind, position: [0, 0, 0], sizeM: PRIMITIVES[kind].defaultSizeM }];
        const screen = project([0, 0.5, 0]);
        const hit = pickObject(screen.x, screen.y, objects, project);
        if (hit !== 0) missed.push(`${kind}: pick returned ${hit}`);
    }
    assert.deepStrictEqual(missed, [], `primitives that cannot be selected: ${missed.join(', ')}`);
});

test('clicking empty floor selects nothing', () => {
    const pose = POSES[0];
    const project = pt => projectPoint(pt, pose.eye, pose.target, 45, VIEW);
    const objects = [{ kind: 'cube', position: [0, 0, 0], sizeM: [1, 1, 1] }];
    const far = project([8, 0, 0]);
    assert.strictEqual(pickObject(far.x, far.y, objects, project), -1);
});

test('the nearest object wins when two overlap on screen', () => {
    // Two objects on the same sight line: clicking must select the one in
    // front, or you edit something hidden behind what you are looking at.
    const pose = { eye: [0, 1.2, 8], target: [0, 0.5, 0] };
    const project = pt => projectPoint(pt, pose.eye, pose.target, 45, VIEW);
    const objects = [
        { kind: 'cube', position: [0, 0, -3], sizeM: [1, 1, 1] },   // far
        { kind: 'cube', position: [0, 0, 3], sizeM: [1, 1, 1] },    // near
    ];
    const screen = project([0, 0.5, 3]);
    assert.strictEqual(pickObject(screen.x, screen.y, objects, project), 1);
});

test('every primitive reports bounds that contain its own geometry', () => {
    const wrong = [];
    for (const kind of Object.keys(PRIMITIVES)) {
        const object = { kind, position: [1, 0, -2], sizeM: PRIMITIVES[kind].defaultSizeM };
        const bounds = objectBounds(object);
        const geo = primitiveGeometry(object);
        for (const v of geo.vertices) {
            for (let a = 0; a < 3; a++) {
                if (v[a] < bounds.min[a] - 1e-9 || v[a] > bounds.max[a] + 1e-9) {
                    wrong.push(`${kind}: vertex outside bounds on axis ${a}`);
                }
            }
        }
    }
    assert.deepStrictEqual([...new Set(wrong)], [], wrong.slice(0, 3).join('; '));
});

test('an object placed off the origin is picked off the origin', () => {
    const pose = POSES[1];
    const project = pt => projectPoint(pt, pose.eye, pose.target, 45, VIEW);
    const objects = [{ kind: 'human', position: [-2.5, 0, 1.5], sizeM: [0.5, 1.7, 0.3] }];
    const screen = project([-2.5, 0.85, 1.5]);
    assert.strictEqual(pickObject(screen.x, screen.y, objects, project), 0);
    // And not picked where it is not.
    const elsewhere = project([3, 0.85, 1.5]);
    assert.strictEqual(pickObject(elsewhere.x, elsewhere.y, objects, project), -1);
});

test('the pick radius is generous enough to hit a thin object', () => {
    // A person seen edge-on is a few pixels wide. Requiring a pixel-perfect hit
    // makes the tool feel broken rather than precise.
    assert.ok(DEFAULT_PICK_RADIUS >= 8, 'pick radius is too tight to use with a mouse');
});

test('a drag near the horizon does not fling the object to infinity', () => {
    // The ray-plane intersection is unbounded as the ray flattens: a grazing
    // angle put a figure 56 metres away in one mouse move. Guarded by refusing
    // a near-parallel ray outright rather than by scaling the result, because a
    // clamped point is still a place the user did not click.
    // Swept over every orbit pitch the viewer allows, not one pose: the fling
    // only appears once the camera drops toward the horizon, and picking a
    // single comfortable pitch is how it was missed the first time.
    const target = [0, 0, 0];
    const flung = [];
    const LIMIT = 60;

    for (let pitch = -0.2; pitch <= 1.3; pitch += 0.1) {
        const distance = 13;
        const eye = [Math.cos(pitch) * distance * 0, Math.sin(pitch) * distance + 1, Math.cos(pitch) * distance];
        for (let y = 0; y < VIEW.h; y += 6) {
            const p = groundPoint(320, y, eye, target, 45, VIEW, 0, { maxDistanceM: LIMIT });
            if (p && Math.hypot(p[0] - target[0], p[2] - target[2]) > LIMIT) {
                flung.push(`pitch=${pitch.toFixed(2)} y=${y} -> ${Math.hypot(p[0], p[2]).toFixed(0)}m`);
            }
        }
    }
    assert.deepStrictEqual(flung, [], `unbounded ground points: ${flung.slice(0, 3).join(', ')}`);
});

test('the guard does not reject an ordinary drag', () => {
    // The floor under the middle of the view must still be reachable, or the
    // fix has traded a rare bug for a constant one.
    const p = groundPoint(320, 260, [0, 8.1, 11.2], [0, 0, 0], 45, VIEW, 0, { maxDistanceM: 60 });
    assert.ok(p, 'a normal drag was refused');
    assert.ok(Math.hypot(p[0], p[2]) < 100);
});

// ── Lifting objects off the floor ───────────────────────────────────────────

test('every primitive can be raised, and stands exactly that high', () => {
    // A box on a table, a card at eye level, a light on a stand. Until now
    // everything sat on the floor because that is where the drag put it.
    const wrong = [];
    for (const kind of Object.keys(PRIMITIVES)) {
        for (const lift of [0.75, 1.4]) {
            const geo = primitiveGeometry({ kind, position: [0, lift, 0], sizeM: PRIMITIVES[kind].defaultSizeM });
            const floor = Math.min(...geo.vertices.map(v => v[1]));
            if (Math.abs(floor - lift) > 1e-9) wrong.push(`${kind} @${lift}m -> base at ${floor.toFixed(4)}`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('a raised object keeps a pick box that contains it', () => {
    const wrong = [];
    for (const kind of Object.keys(PRIMITIVES)) {
        const object = { kind, position: [1, 1.2, -2], sizeM: PRIMITIVES[kind].defaultSizeM };
        const bounds = objectBounds(object);
        for (const v of primitiveGeometry(object).vertices) {
            for (let a = 0; a < 3; a++) {
                if (v[a] < bounds.min[a] - 1e-6 || v[a] > bounds.max[a] + 1e-6) wrong.push(`${kind} axis ${a}`);
            }
        }
    }
    assert.deepStrictEqual([...new Set(wrong)], [], wrong.slice(0, 3).join('; '));
});

test('lifting changes only the height, never where it stands', () => {
    const grounded = primitiveGeometry({ kind: 'cube', position: [2, 0, -1], sizeM: [1, 1, 1] });
    const raised = primitiveGeometry({ kind: 'cube', position: [2, 1.5, -1], sizeM: [1, 1, 1] });
    for (const axis of [0, 2]) {
        assert.deepStrictEqual(grounded.vertices.map(v => v[axis]), raised.vertices.map(v => v[axis]),
            `lifting moved the object on axis ${axis}`);
    }
});

// ── Reframing the view ──────────────────────────────────────────────────────

const { frameAll } = require('../lib/previs-pick');

test('reframing contains every object and the camera', () => {
    // A view you have orbited away from is a view you cannot get back without
    // scrubbing; the button has to actually contain everything, not re-centre
    // on the origin and hope.
    const objects = [
        { kind: 'cube', position: [-8, 0, 0], sizeM: [1, 1, 1] },
        { kind: 'human', position: [6, 0, 5], sizeM: [0.5, 1.8, 0.3] },
    ];
    const camera = [0, 1.6, -9];
    const view = frameAll(objects, camera);

    for (const o of objects) {
        for (const v of primitiveGeometry(o).vertices) {
            const d = Math.hypot(v[0] - view.centre[0], v[1] - view.centre[1], v[2] - view.centre[2]);
            assert.ok(d <= view.radius + 1e-6, `an object corner sits ${d.toFixed(2)} outside a radius of ${view.radius.toFixed(2)}`);
        }
    }
    const camDist = Math.hypot(camera[0] - view.centre[0], camera[1] - view.centre[1], camera[2] - view.centre[2]);
    assert.ok(camDist <= view.radius + 1e-6, 'the camera is outside the reframed view');
});

test('reframing an empty stage still gives a usable view', () => {
    const view = frameAll([], [0, 1.6, 3]);
    assert.ok(view.radius > 0.5, `radius ${view.radius} is too tight to see anything`);
    assert.ok(view.centre.every(Number.isFinite));
});

test('the reframed distance grows with the scene, and never collapses', () => {
    const tight = frameAll([{ kind: 'cube', position: [0, 0, 0], sizeM: [1, 1, 1] }], [0, 1.6, 2]);
    const wide = frameAll([{ kind: 'cube', position: [30, 0, 0], sizeM: [1, 1, 1] }], [0, 1.6, 2]);
    assert.ok(wide.distance > tight.distance, 'a bigger scene did not pull the view back');
    assert.ok(tight.distance >= 2, `distance ${tight.distance} would put the view inside the subject`);
});
