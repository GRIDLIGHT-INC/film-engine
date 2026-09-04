const test = require('node:test');
const assert = require('node:assert');
const cine = require('../lib/cinematography');
const validate = require('../lib/camera-validate');

/*
 * Every metric field a camera proposal may carry is named `...M`, and every one
 * of them used to be written straight into `camera.position` — which is in the
 * reconstruction's own units. Marble promises no unit, so on a world calibrated
 * at 1.747 units/metre a 1.6 m eye-height camera landed 2.8 m up, through the
 * ceiling, and the validator correctly refused the most ordinary camera in film.
 *
 * Set-based over the four metric fields, because the failure is partial by
 * nature: converting the height and forgetting the dolly is a camera that
 * frames correctly and stands in the wrong place.
 */

// The Glass Harbour diner, as Marble actually reconstructed it.
const WORLD = {
    scale_factor: 1.7472335468841,
    bounds: { min: [-3.85, -0.967, -4.82], max: [3.21, 0.75, 5.79] },
};
const FLOOR = WORLD.bounds.min[1];

const METRIC_FIELDS = ['cameraHeightM', 'pedestalM', 'dollyM', 'truckM'];

test('every metric field is converted out of metres', () => {
    for (const field of METRIC_FIELDS) {
        const cam = cine.applyProposal({ position: [0, 0, 0], rotation: [0, 0, 0] },
            { rationale: 'x', changes: { [field]: 1.0 } }, WORLD);
        assert.ok(cam, `${field} produced no camera`);
        const moved = cam.position.map((v, i) => v - [0, 0, 0][i]).find(v => Math.abs(v) > 1e-9);
        const axis = cam.position.findIndex(v => Math.abs(v - (field === 'cameraHeightM' ? FLOOR : 0)) > 1e-9);
        assert.notStrictEqual(axis, -1, `${field} moved nothing`);
        // One metre must become 1/factor world units, never a bare 1.
        const delta = field === 'cameraHeightM'
            ? cam.position[1] - FLOOR
            : Math.abs(moved);
        assert.ok(Math.abs(delta - 1 / WORLD.scale_factor) < 1e-6,
            `${field}: one metre became ${delta} world units, expected ${1 / WORLD.scale_factor}`);
    }
});

test('height is measured from the floor, not the origin', () => {
    const cam = cine.applyProposal({ position: [0, 0, 0], rotation: [0, 0, 0] },
        { rationale: 'eye height', changes: { cameraHeightM: 1.6 } }, WORLD);
    const metresAboveFloor = (cam.position[1] - FLOOR) * WORLD.scale_factor;
    assert.ok(Math.abs(metresAboveFloor - 1.6) < 1e-6,
        `asked for 1.6 m above the floor, got ${metresAboveFloor}`);
});

test('an ordinary eye-height camera can actually be shot', () => {
    const cam = cine.applyProposal({ position: [0, 0, 0], rotation: [0, 0, 0] },
        { rationale: 'eye height', changes: { cameraHeightM: 1.6 } }, WORLD);
    const out = validate.validateCamera(cam, WORLD, { subjects: [] }, {});
    const inside = out.failures.find(f => f.check === 'inside_geometry');
    assert.strictEqual(inside, undefined,
        `a 1.6 m eye-height camera was refused: ${inside && inside.detail}`);
});

/*
 * THE RULE THE SCALE MODULE IS BUILT AROUND: a NULL factor is not 1.0.
 *
 * An uncalibrated world has no metres to place a metric camera in, so the
 * proposal is REFUSED. Reading the number as world units would put the camera
 * somewhere wrong that looks deliberate.
 */
test('a metric proposal against an uncalibrated world is refused, not reinterpreted', () => {
    for (const field of METRIC_FIELDS) {
        const cam = cine.applyProposal({ position: [0, 0, 0], rotation: [0, 0, 0] },
            { rationale: 'x', changes: { [field]: 1.6 } },
            { scale_factor: null, bounds: WORLD.bounds });
        assert.strictEqual(cam, null, `${field} was placed in a world with no scale`);
    }
});

/* Non-metric fields are unaffected by scale and must still apply. */
test('rotations and the lens are not scaled', () => {
    const cam = cine.applyProposal({ position: [0, 0, 0], rotation: [0, 0, 0], focalMm: 50 },
        { rationale: 'x', changes: { panDeg: 30, focalLengthMm: 85 } }, WORLD);
    assert.strictEqual(cam.rotation[0], 30, 'thirty degrees is thirty degrees in any world');
    assert.strictEqual(cam.focalMm, 85);
});

/* An uncalibrated world must not block a purely rotational proposal. */
test('a rotation-only proposal works on an uncalibrated world', () => {
    const cam = cine.applyProposal({ position: [0, 0, 0], rotation: [0, 0, 0] },
        { rationale: 'x', changes: { tiltDeg: -10 } }, { scale_factor: null });
    assert.ok(cam, 'a tilt needs no scale and must not be refused');
    assert.strictEqual(cam.rotation[1], -10);
});
