/**
 * Phase 0 — previs optics.
 *
 * These are the numbers a director acts on. A field of view that is 10% wrong
 * still renders a perfectly plausible picture, and nobody finds out until a
 * shot does not match on the day — so checking the formula against itself is
 * worthless here. Every assertion is one of three kinds that cannot be satisfied
 * by a wrong-but-self-consistent implementation:
 *
 *   1. PUBLISHED VALUES. A small reference table of full-frame angles of view
 *      taken from standard lens charts, independent of our code.
 *   2. INVERSES. frameCoverage and framingDistance must undo each other; if
 *      either drifts, the round trip stops closing.
 *   3. PHYSICAL LAWS. Focusing at the hyperfocal distance must put the near
 *      limit at exactly H/2 and the far limit at infinity. That property falls
 *      out of the optics, not out of the arithmetic, so it fails loudly if the
 *      depth-of-field expression is subtly rearranged.
 *
 * Coverage is set-based over SENSORS x LENS_KIT rather than spot-checked: a
 * sensor whose dimensions are transposed produces sane-looking angles on every
 * lens, and only shows up when the whole grid is swept for monotonicity.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    SENSORS, LENS_KIT, APERTURES,
    sensorFor, fieldOfView, frameCoverage, framingDistance,
    hyperfocalDistance, depthOfField, equivalentFocalLength,
} = require('../lib/previs-camera');

const SENSOR_IDS = Object.keys(SENSORS);
const close = (a, b, tol) => Math.abs(a - b) <= tol;

// ── 1. Published values ─────────────────────────────────────────────────────

// Horizontal angle of view on a 36mm-wide full-frame gate, from standard lens
// charts. These are the check that the model matches the world.
const PUBLISHED_FULLFRAME_HFOV = {
    24: 73.7, 35: 54.4, 50: 39.6, 85: 23.9, 135: 15.2, 200: 10.3,
};

test('horizontal FOV matches published full-frame values within 0.1 degrees', () => {
    const ff = sensorFor('fullframe');
    const wrong = [];
    for (const [focal, expected] of Object.entries(PUBLISHED_FULLFRAME_HFOV)) {
        const got = fieldOfView(Number(focal), ff).hDeg;
        if (!close(got, expected, 0.1)) wrong.push({ focal, expected, got: +got.toFixed(3) });
    }
    assert.deepStrictEqual(wrong, [], JSON.stringify(wrong));
});

test('a Super 35 fifty is the ~28 degrees everyone quotes', () => {
    assert.ok(close(fieldOfView(50, sensorFor('super35')).hDeg, 28.0, 0.15));
});

test('35mm-equivalent focal length follows the crop factor', () => {
    // A 25 on Super 35 frames like a ~36 on full frame. Independent of FOV code.
    const s35 = sensorFor('super35');
    const crop = SENSORS.fullframe.widthMm / s35.widthMm;
    assert.ok(close(equivalentFocalLength(25, s35), 25 * crop, 0.01));
    assert.strictEqual(equivalentFocalLength(50, sensorFor('fullframe')), 50);
});

// ── 2. Set-based sweeps ─────────────────────────────────────────────────────

test('every sensor has physically coherent dimensions', () => {
    const bad = SENSOR_IDS.filter(id => {
        const s = SENSORS[id];
        return !(s.widthMm > 0) || !(s.heightMm > 0) || !(s.circleOfConfusionMm > 0)
            || s.heightMm >= s.widthMm;   // every cinema gate is landscape
    });
    assert.deepStrictEqual(bad, [], `sensors with impossible dimensions: ${bad.join(', ')}`);
});

test('FOV narrows monotonically as focal length grows, on every sensor', () => {
    // Catches a transposed width/height or a sensor read from the wrong record:
    // both still produce plausible single values, neither survives the sweep.
    const broken = [];
    for (const id of SENSOR_IDS) {
        const sensor = sensorFor(id);
        for (let i = 1; i < LENS_KIT.length; i++) {
            const wide = fieldOfView(LENS_KIT[i - 1], sensor).hDeg;
            const tight = fieldOfView(LENS_KIT[i], sensor).hDeg;
            if (!(tight < wide)) broken.push(`${id}: ${LENS_KIT[i]}mm not tighter than ${LENS_KIT[i - 1]}mm`);
        }
    }
    assert.deepStrictEqual(broken, [], broken.join('; '));
});

test('a bigger gate is always a wider view at the same focal length', () => {
    const byWidth = SENSOR_IDS.slice().sort((a, b) => SENSORS[a].widthMm - SENSORS[b].widthMm);
    const broken = [];
    for (const focal of LENS_KIT) {
        for (let i = 1; i < byWidth.length; i++) {
            const small = fieldOfView(focal, sensorFor(byWidth[i - 1])).hDeg;
            const large = fieldOfView(focal, sensorFor(byWidth[i])).hDeg;
            if (!(large > small)) broken.push(`${focal}mm: ${byWidth[i]} not wider than ${byWidth[i - 1]}`);
        }
    }
    assert.deepStrictEqual(broken, [], broken.slice(0, 5).join('; '));
});

test('horizontal FOV always exceeds vertical on a landscape gate', () => {
    const broken = [];
    for (const id of SENSOR_IDS) {
        for (const focal of LENS_KIT) {
            const { hDeg, vDeg } = fieldOfView(focal, sensorFor(id));
            if (!(hDeg > vDeg)) broken.push(`${id} ${focal}mm`);
        }
    }
    assert.deepStrictEqual(broken, []);
});

// ── 3. Inverses ─────────────────────────────────────────────────────────────

test('framingDistance and frameCoverage undo each other, across the whole grid', () => {
    // The relation the whole feature rests on: "put this subject height in
    // frame" and "what fits at this distance" must be one function read two ways.
    const broken = [];
    for (const id of SENSOR_IDS) {
        const sensor = sensorFor(id);
        for (const focal of LENS_KIT) {
            for (const subjectM of [0.12, 0.45, 1.0, 2.2, 12.0]) {
                const d = framingDistance(subjectM, focal, sensor);
                const back = frameCoverage(d, focal, sensor).heightM;
                if (!close(back, subjectM, subjectM * 1e-6)) {
                    broken.push(`${id} ${focal}mm ${subjectM}m -> ${d.toFixed(4)}m -> ${back.toFixed(6)}m`);
                }
            }
        }
    }
    assert.deepStrictEqual(broken, [], broken.slice(0, 5).join('; '));
});

test('a longer lens pushes the camera further back for the same framing', () => {
    const sensor = sensorFor('super35');
    const distances = LENS_KIT.map(f => framingDistance(0.45, f, sensor));
    for (let i = 1; i < distances.length; i++) {
        assert.ok(distances[i] > distances[i - 1],
            `${LENS_KIT[i]}mm did not move the camera back relative to ${LENS_KIT[i - 1]}mm`);
    }
});

// ── 4. Physical laws ────────────────────────────────────────────────────────

test('focusing at hyperfocal puts the near limit at H/2 and the far at infinity', () => {
    // The strongest available check: this identity is a consequence of the
    // optics, so an expression that is merely self-consistent will not satisfy it.
    const broken = [];
    for (const id of SENSOR_IDS) {
        const sensor = sensorFor(id);
        for (const focal of LENS_KIT) {
            for (const fStop of APERTURES) {
                const H = hyperfocalDistance(focal, fStop, sensor);
                const dof = depthOfField(focal, fStop, H, sensor);
                if (!close(dof.nearM, H / 2, (H / 2) * 0.01)) {
                    broken.push(`${id} ${focal}mm f/${fStop}: near ${dof.nearM.toFixed(3)} != H/2 ${(H / 2).toFixed(3)}`);
                }
                if (Number.isFinite(dof.farM)) {
                    broken.push(`${id} ${focal}mm f/${fStop}: far is finite at hyperfocal`);
                }
            }
        }
    }
    assert.deepStrictEqual(broken, [], broken.slice(0, 5).join('; '));
});

test('depth of field is bracketed by the focus distance and grows with the f-number', () => {
    const sensor = sensorFor('super35');
    const focusM = 2;
    let previousTotal = -1;
    for (const fStop of APERTURES) {
        const dof = depthOfField(50, fStop, focusM, sensor);
        assert.ok(dof.nearM < focusM && dof.farM > focusM,
            `f/${fStop}: focus distance is outside its own depth of field`);
        const total = Number.isFinite(dof.farM) ? dof.totalM : Infinity;
        assert.ok(total > previousTotal, `f/${fStop} did not deepen the field`);
        previousTotal = total;
    }
});

test('depth of field falls roughly one third in front, two thirds behind', () => {
    // The classic rule, and it only holds well short of hyperfocal — asserting
    // it everywhere would be asserting a myth.
    const sensor = sensorFor('super35');
    const dof = depthOfField(50, 5.6, 3, sensor);
    const share = dof.inFrontM / dof.totalM;
    assert.ok(share > 0.25 && share < 0.45, `front share was ${share.toFixed(3)}`);
});

test('a wider aperture never deepens the field, on any lens or sensor', () => {
    const broken = [];
    for (const id of SENSOR_IDS) {
        const sensor = sensorFor(id);
        for (const focal of LENS_KIT) {
            const shallow = depthOfField(focal, APERTURES[0], 3, sensor);
            const deep = depthOfField(focal, APERTURES[APERTURES.length - 1], 3, sensor);
            const a = Number.isFinite(shallow.farM) ? shallow.totalM : Infinity;
            const b = Number.isFinite(deep.farM) ? deep.totalM : Infinity;
            if (!(b >= a)) broken.push(`${id} ${focal}mm`);
        }
    }
    assert.deepStrictEqual(broken, []);
});

// ── 5. Refusals ─────────────────────────────────────────────────────────────

test('nonsense inputs are refused rather than returning a plausible number', () => {
    const sensor = sensorFor('super35');
    for (const bad of [0, -50, NaN, null, undefined]) {
        assert.throws(() => fieldOfView(bad, sensor), /focal/i, `accepted focal ${bad}`);
    }
    assert.throws(() => depthOfField(50, 0, 2, sensor), /aperture|f-number/i);
    assert.throws(() => framingDistance(0, 50, sensor), /subject/i);
    assert.throws(() => sensorFor('no-such-sensor'), /sensor/i);
});

test('every lens in the kit and aperture in the set is usable on every sensor', () => {
    // No hole in the grid: a lens the UI offers must not throw when selected.
    const broken = [];
    for (const id of SENSOR_IDS) {
        for (const focal of LENS_KIT) {
            for (const fStop of APERTURES) {
                try {
                    const dof = depthOfField(focal, fStop, 2, sensorFor(id));
                    if (!(dof.nearM > 0)) broken.push(`${id} ${focal} f/${fStop}: near <= 0`);
                } catch (err) {
                    broken.push(`${id} ${focal} f/${fStop}: ${err.message}`);
                }
            }
        }
    }
    assert.deepStrictEqual(broken, [], broken.slice(0, 5).join('; '));
});
