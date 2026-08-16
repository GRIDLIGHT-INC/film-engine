/**
 * Phase 5 — moves you can measure, sequence, and stage.
 *
 * Three things the single-primitive model could not express:
 *
 *   HOW FAR   every movement carried a magnitude baked into its vector and only
 *             an abstract 0..1 intensity on top, so "dolly in two metres" was
 *             not sayable. Each movement now declares a unit and an amount.
 *   SEQUENCE  a shot was one movement. Real moves are compound — push in, then
 *             pan off — and each leg has to start where the last one ended.
 *   STAGE     a featureless box tells you nothing about a complex move. A
 *             standing figure and some primitives do.
 *
 * Set-based over the schema's registries as before, plus a compatibility set:
 * every blocking saved before this phase must keep producing the SAME path, or
 * the shots already blocked in the viewer quietly change.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-moves-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const { VALID_CAMERA_MOVES } = require('../lib/scene-card-schema');
const {
    MOVEMENTS, RIGS, defaultBlocking, samplePath, sampleSequence, moveAmount, toCameraControl,
} = require('../lib/previs-blocking');
const { PRIMITIVES, primitiveGeometry, humanProxy } = require('../lib/previs-primitives');

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const travel = keys => dist(keys[0].position, keys[keys.length - 1].position);

// ── How far: every movement declares a magnitude in real units ──────────────

test('every movement declares a unit and a default amount', () => {
    const UNITS = new Set(['m', 'deg', 'ratio', 'none']);
    const bad = [];
    for (const id of VALID_CAMERA_MOVES) {
        const move = MOVEMENTS[id];
        if (!UNITS.has(move.unit)) bad.push(`${id}: unit '${move.unit}'`);
        if (typeof move.defaultAmount !== 'number') bad.push(`${id}: no defaultAmount`);
        if (move.unit !== 'none' && !(move.defaultAmount > 0)) bad.push(`${id}: amount ${move.defaultAmount}`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
    assert.strictEqual(MOVEMENTS.static.unit, 'none', 'static is the only move with nothing to measure');
});

test('the declared amount matches the vector the movement already carried', () => {
    // Derived, not retyped: if the two disagree, changing one silently changes
    // what a saved shot does.
    const wrong = [];
    for (const id of VALID_CAMERA_MOVES) {
        const m = MOVEMENTS[id];
        const expected = m.unit === 'm' ? Math.hypot(...m.translate)
            : m.unit === 'deg' ? (m.orbitDegrees || Math.hypot(...m.rotate))
                : m.unit === 'ratio' ? m.focalScale : 0;
        if (Math.abs(m.defaultAmount - expected) > 1e-9) {
            wrong.push(`${id}: declares ${m.defaultAmount}, vector says ${expected}`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('asking for a distance gets that distance, on every translating move', () => {
    const wrong = [];
    for (const id of VALID_CAMERA_MOVES) {
        if (MOVEMENTS[id].unit !== 'm') continue;
        for (const metres of [0.5, 2, 7.25]) {
            const keys = samplePath(id, defaultBlocking(), { frames: 8, intensity: 1, amount: metres });
            const moved = travel(keys);
            if (Math.abs(moved - metres) > 1e-6) wrong.push(`${id} @${metres}m -> ${moved.toFixed(4)}m`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.slice(0, 5).join('; '));
});

test('asking for an angle gets that angle, on every rotating move', () => {
    const wrong = [];
    for (const id of VALID_CAMERA_MOVES) {
        if (MOVEMENTS[id].unit !== 'deg' || id === 'orbit') continue;
        for (const degrees of [5, 45, 120]) {
            const keys = samplePath(id, defaultBlocking(), { frames: 8, intensity: 1, amount: degrees });
            const swung = Math.hypot(...keys[keys.length - 1].rotation.map((v, i) => v - keys[0].rotation[i]));
            if (Math.abs(swung - degrees) > 1e-6) wrong.push(`${id} @${degrees}° -> ${swung.toFixed(3)}°`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('orbit takes its sweep in degrees and keeps its radius', () => {
    const blocking = defaultBlocking();
    const keys = samplePath('orbit', blocking, { frames: 24, intensity: 1, amount: 180 });
    const t = blocking.subject.position;
    const radii = keys.map(k => Math.hypot(k.position[0] - t[0], k.position[2] - t[2]));
    for (const r of radii) assert.ok(Math.abs(r - radii[0]) < 1e-6, 'orbit drifted off its radius');

    // 180 degrees puts the camera on the far side.
    const start = keys[0].position;
    const end = keys[keys.length - 1].position;
    assert.ok(Math.abs(dist(start, end) - radii[0] * 2) < 1e-6, 'a half orbit did not cross the subject');
});

test('amount and intensity are different dials and both still work', () => {
    const full = samplePath('dolly-in', defaultBlocking(), { frames: 4, intensity: 1, amount: 4 });
    const half = samplePath('dolly-in', defaultBlocking(), { frames: 4, intensity: 0.5, amount: 4 });
    assert.ok(Math.abs(travel(full) - 4) < 1e-6);
    assert.ok(Math.abs(travel(half) - 2) < 1e-6, 'intensity no longer scales the move');
});

// ── Compatibility: nothing already blocked may change ───────────────────────

test('omitting the amount reproduces the pre-phase-5 path exactly', () => {
    // The compatibility set. Every blocking already saved omits `amount`, so
    // every one of these must sample to what it sampled before.
    const wrong = [];
    for (const id of VALID_CAMERA_MOVES) {
        const withoutAmount = samplePath(id, defaultBlocking(), { frames: 12 });
        const withDefault = samplePath(id, defaultBlocking(), { frames: 12, amount: MOVEMENTS[id].defaultAmount });
        if (JSON.stringify(withoutAmount) !== JSON.stringify(withDefault)) wrong.push(id);
    }
    assert.deepStrictEqual(wrong, [], `default amount is not the old behaviour for: ${wrong.join(', ')}`);
});

test('a single movement string still samples as it always did', () => {
    // The old call signature is the one stored in every existing row.
    const keys = samplePath('crane-up', defaultBlocking(), { frames: 6 });
    assert.strictEqual(keys.length, 6);
    assert.ok(Math.abs(travel(keys) - 2.5 * MOVEMENTS['crane-up'].defaultIntensity) < 1e-9);
});

// ── Sequence: multiple moves ────────────────────────────────────────────────

test('a sequence runs its legs in order, each starting where the last ended', () => {
    const seq = [
        { movement: 'dolly-in', amount: 2 },
        { movement: 'tracking-right', amount: 3 },
    ];
    const keys = sampleSequence(seq, defaultBlocking(), { frames: 24, intensity: 1 });

    assert.strictEqual(keys.length, 24);
    assert.strictEqual(keys[0].t, 0);
    assert.strictEqual(keys[keys.length - 1].t, 1);

    // No teleport anywhere along the join.
    let biggest = 0;
    for (let i = 1; i < keys.length; i++) biggest = Math.max(biggest, dist(keys[i - 1].position, keys[i].position));
    assert.ok(biggest < 1, `the path jumps ${biggest.toFixed(3)}m between frames`);

    // Total displacement is the two legs combined, at right angles: sqrt(4+9).
    assert.ok(Math.abs(travel(keys) - Math.hypot(2, 3)) < 0.05, `travelled ${travel(keys).toFixed(3)}m`);
});

test('a one-move sequence equals that move on its own', () => {
    const single = samplePath('dolly-in', defaultBlocking(), { frames: 12, intensity: 1, amount: 2 });
    const seq = sampleSequence([{ movement: 'dolly-in', amount: 2 }], defaultBlocking(), { frames: 12, intensity: 1 });
    assert.deepStrictEqual(seq.map(k => k.position), single.map(k => k.position));
});

test('an empty sequence is a locked-off camera, not a crash', () => {
    const keys = sampleSequence([], defaultBlocking(), { frames: 6 });
    assert.strictEqual(keys.length, 6);
    assert.ok(travel(keys) < 1e-9);
});

test('legs can be weighted, and the weights decide how much time each gets', () => {
    const seq = [
        { movement: 'dolly-in', amount: 2, weight: 3 },
        { movement: 'pan-left', amount: 90, weight: 1 },
    ];
    const keys = sampleSequence(seq, defaultBlocking(), { frames: 40, intensity: 1 });
    // The pan only starts in the last quarter, so rotation is still zero at 70%.
    const atSeventy = keys[Math.floor(keys.length * 0.7)];
    assert.ok(Math.abs(atSeventy.rotation[0]) < 1e-6, 'the second leg started early');
    assert.ok(Math.abs(keys[keys.length - 1].rotation[0] - 90) < 1e-6, 'the second leg did not finish');
});

test('every movement can be a leg of a sequence', () => {
    const broken = [];
    for (const id of VALID_CAMERA_MOVES) {
        try {
            const keys = sampleSequence([{ movement: id }, { movement: 'static' }], defaultBlocking(), { frames: 10 });
            if (keys.length !== 10) broken.push(`${id}: ${keys.length} frames`);
            if (!keys.every(k => k.position.every(Number.isFinite))) broken.push(`${id}: non-finite`);
        } catch (err) { broken.push(`${id}: ${err.message}`); }
    }
    assert.deepStrictEqual(broken, [], broken.slice(0, 5).join('; '));
});

test('a sequence reaches the generator as one path', () => {
    const blocking = { ...defaultBlocking(), moves: [{ movement: 'push-in', amount: 1 }, { movement: 'tilt-up', amount: 15 }] };
    const control = toCameraControl(blocking, 'push-in');
    assert.ok(control.path.length >= 2);
    assert.strictEqual(control.type, 'push-in', 'the first leg names the control the generator already knows');
    assert.ok(Math.abs(control.path[control.path.length - 1].rotation[1] - 15) < 0.01,
        'the second leg never reached the payload');
});

// ── Stage: a figure and some primitives ─────────────────────────────────────

test('every primitive kind declares what it needs to be drawn', () => {
    const bad = Object.entries(PRIMITIVES).filter(([, p]) => !p.label || !Array.isArray(p.defaultSizeM) || p.defaultSizeM.length !== 3);
    assert.deepStrictEqual(bad.map(([k]) => k), []);
    for (const required of ['human', 'cube', 'sphere']) {
        assert.ok(PRIMITIVES[required], `no '${required}' primitive`);
    }
});

test('every primitive produces geometry a renderer can draw', () => {
    const bad = [];
    for (const kind of Object.keys(PRIMITIVES)) {
        const geo = primitiveGeometry({ kind, position: [0, 0, 0] });
        if (!geo.vertices.length) bad.push(`${kind}: no vertices`);
        if (!geo.edges.length) bad.push(`${kind}: no edges`);
        for (const [a, b] of geo.edges) {
            if (!geo.vertices[a] || !geo.vertices[b]) bad.push(`${kind}: edge references a missing vertex`);
        }
        if (!geo.vertices.every(v => v.length === 3 && v.every(Number.isFinite))) bad.push(`${kind}: bad vertex`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('the human proxy actually stands the height it is given', () => {
    // The number that makes it useful: a 1.7m figure has to measure 1.7m, or
    // every framing solved against it is wrong.
    for (const height of [1.5, 1.7, 2.05]) {
        const geo = primitiveGeometry({ kind: 'human', position: [0, 0, 0], sizeM: [0.5, height, 0.3] });
        const ys = geo.vertices.map(v => v[1]);
        assert.ok(Math.abs(Math.min(...ys)) < 1e-9, 'the figure does not stand on the floor');
        assert.ok(Math.abs(Math.max(...ys) - height) < 1e-9, `figure measured ${Math.max(...ys)}, wanted ${height}`);
    }
});

test('the human proxy is made of parts, and they are named', () => {
    // Named parts are what let the viewer say "her eyeline", and what stops the
    // figure being an undifferentiated blob at a distance.
    const parts = humanProxy(1.7);
    assert.ok(parts.length >= 5, 'too few parts to read as a person');
    const names = parts.map(p => p.name);
    for (const expected of ['head', 'torso']) {
        assert.ok(names.includes(expected), `no ${expected}`);
    }
    assert.ok(parts.every(p => p.sizeM.every(v => v > 0)), 'a part has no size');
});

test('a primitive placed away from the origin is drawn there', () => {
    const geo = primitiveGeometry({ kind: 'cube', position: [3, 0, -2], sizeM: [1, 1, 1] });
    const xs = geo.vertices.map(v => v[0]);
    const zs = geo.vertices.map(v => v[2]);
    assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 3) < 1e-9);
    assert.ok(Math.abs((Math.min(...zs) + Math.max(...zs)) / 2 + 2) < 1e-9);
});

test('a sphere is round, and rests on the floor like every other primitive', () => {
    // `position` is where an object STANDS, not where its middle is — a box, a
    // figure and a sphere dropped at the same point all sit on the same floor.
    // Centring the sphere instead would half-bury it while the other two did not.
    const geo = primitiveGeometry({ kind: 'sphere', position: [0, 0, 0], sizeM: [1.4, 1.4, 1.4] });
    const r = 0.7;
    for (const v of geo.vertices) {
        const d = Math.hypot(v[0], v[1] - r, v[2]);
        assert.ok(Math.abs(d - r) < 1e-6, `vertex ${d.toFixed(4)} from centre, expected ${r}`);
    }
    assert.ok(Math.abs(Math.min(...geo.vertices.map(v => v[1]))) < 1e-9, 'the sphere is not resting on the floor');
});

test('an unknown primitive kind is refused rather than drawn as nothing', () => {
    assert.throws(() => primitiveGeometry({ kind: 'dodecahedron', position: [0, 0, 0] }), /primitive/i);
});

// ── Image planes ────────────────────────────────────────────────────────────

test('an image plane is a primitive like any other', () => {
    // Cutout previs: a generated keyframe or character sheet standing in the
    // scene as a card. Registered as a primitive rather than special-cased, so
    // it is placeable, draggable and deletable by the code that already does
    // that for boxes — and so the add menu offers it without being told.
    assert.ok(PRIMITIVES.imageplane, 'no image plane primitive');
    assert.ok(PRIMITIVES.imageplane.acceptsImage, 'the image plane does not declare that it takes an image');
});

test('every primitive that accepts an image says so, and no other does', () => {
    const accepting = Object.entries(PRIMITIVES).filter(([, p]) => p.acceptsImage).map(([k]) => k);
    assert.deepStrictEqual(accepting, ['imageplane'],
        'a solid primitive claims to take an image, or the image plane does not');
});

test('an image plane stands on the floor at the size it is given', () => {
    const geo = primitiveGeometry({ kind: 'imageplane', position: [1, 0, -2], sizeM: [1.2, 1.8, 0.02] });
    const ys = geo.vertices.map(v => v[1]);
    const xs = geo.vertices.map(v => v[0]);
    assert.ok(Math.abs(Math.min(...ys)) < 1e-9, 'the card is not standing on the floor');
    assert.ok(Math.abs(Math.max(...ys) - 1.8) < 1e-9, `card measured ${Math.max(...ys)}`);
    assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 1) < 1e-9, 'the card is not where it was placed');
});

test('an image plane is flat: four corners, not eight', () => {
    // A card with depth would foreshorten into a box and stop reading as a
    // cutout, which is the entire idea.
    const geo = primitiveGeometry({ kind: 'imageplane', position: [0, 0, 0], sizeM: [1, 1.8, 0.02] });
    assert.strictEqual(geo.vertices.length, 4, `${geo.vertices.length} corners`);
    assert.strictEqual(geo.edges.length, 4);
    const zs = new Set(geo.vertices.map(v => +v[2].toFixed(6)));
    assert.strictEqual(zs.size, 1, 'the card has thickness');
});

test('the corners come back in a known order so a texture can be mapped', () => {
    // Drawing the image means mapping it onto the quad; that needs the corners
    // in a stated order, not whatever the loop happened to emit.
    const geo = primitiveGeometry({ kind: 'imageplane', position: [0, 0, 0], sizeM: [2, 1, 0.02] });
    const [tl, tr, br, bl] = geo.vertices;
    assert.ok(tl[1] > bl[1] && tr[1] > br[1], 'the first two corners are not the top ones');
    assert.ok(tl[0] < tr[0], 'top-left is not left of top-right');
    assert.ok(bl[0] < br[0], 'bottom-left is not left of bottom-right');
});

// ── Orientation ─────────────────────────────────────────────────────────────

const extent = (geo, axis) => {
    const vs = geo.vertices.map(v => v[axis]);
    return +(Math.max(...vs) - Math.min(...vs)).toFixed(6);
};

test('every primitive accepts a rotation, and zero changes nothing', () => {
    // Identity first: a rotation field that subtly moves an unrotated object
    // would shift every scene already staged.
    const wrong = [];
    for (const kind of Object.keys(PRIMITIVES)) {
        const base = { kind, position: [1, 0, -2], sizeM: PRIMITIVES[kind].defaultSizeM };
        const plain = primitiveGeometry(base);
        const zero = primitiveGeometry({ ...base, rotationDeg: [0, 0, 0] });
        if (JSON.stringify(plain.vertices) !== JSON.stringify(zero.vertices)) wrong.push(kind);
    }
    assert.deepStrictEqual(wrong, [], `rotating by zero moved: ${wrong.join(', ')}`);
});

test('a quarter turn about the vertical swaps an object width for its depth', () => {
    const wrong = [];
    for (const kind of ['cube', 'imageplane', 'human']) {
        const size = kind === 'cube' ? [2, 1, 0.5] : PRIMITIVES[kind].defaultSizeM;
        const before = primitiveGeometry({ kind, position: [0, 0, 0], sizeM: size });
        const after = primitiveGeometry({ kind, position: [0, 0, 0], sizeM: size, rotationDeg: [90, 0, 0] });
        if (Math.abs(extent(after, 0) - extent(before, 2)) > 1e-4) {
            wrong.push(`${kind}: x after ${extent(after, 0)} != z before ${extent(before, 2)}`);
        }
        if (Math.abs(extent(after, 1) - extent(before, 1)) > 1e-4) wrong.push(`${kind}: yaw changed its height`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('rolling an image card ninety degrees turns portrait into widescreen', () => {
    const portrait = primitiveGeometry({ kind: 'imageplane', position: [0, 0, 0], sizeM: [1.0, 1.7, 0.02] });
    const rolled = primitiveGeometry({ kind: 'imageplane', position: [0, 0, 0], sizeM: [1.0, 1.7, 0.02], rotationDeg: [0, 0, 90] });

    assert.ok(Math.abs(extent(portrait, 0) - 1.0) < 1e-6, `portrait width ${extent(portrait, 0)}`);
    assert.ok(Math.abs(extent(portrait, 1) - 1.7) < 1e-6, `portrait height ${extent(portrait, 1)}`);
    assert.ok(Math.abs(extent(rolled, 0) - 1.7) < 1e-6, `rolled width ${extent(rolled, 0)}`);
    assert.ok(Math.abs(extent(rolled, 1) - 1.0) < 1e-6, `rolled height ${extent(rolled, 1)}`);
});

test('a rotated card stays flat and keeps its corner order', () => {
    const geo = primitiveGeometry({ kind: 'imageplane', position: [0, 0, 0], sizeM: [1, 1.7, 0.02], rotationDeg: [35, 0, 0] });
    assert.strictEqual(geo.vertices.length, 4);
    const [tl, tr, br, bl] = geo.vertices;
    assert.ok(tl[1] > bl[1] && tr[1] > br[1], 'the top corners are no longer on top');
    const u = tr.map((v, i) => v - tl[i]);
    const w = bl.map((v, i) => v - tl[i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const d = br.map((v, i) => v - tl[i]);
    assert.ok(Math.abs(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) < 1e-9, 'the card is no longer flat');
});

test('rotation is about the object own base, so it does not wander', () => {
    for (const deg of [30, 90, 180]) {
        const geo = primitiveGeometry({ kind: 'cube', position: [4, 0, -3], sizeM: [1, 1, 1], rotationDeg: [deg, 0, 0] });
        const xs = geo.vertices.map(v => v[0]);
        const zs = geo.vertices.map(v => v[2]);
        assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 4) < 1e-6, `${deg}: drifted in x`);
        assert.ok(Math.abs((Math.min(...zs) + Math.max(...zs)) / 2 + 3) < 1e-6, `${deg}: drifted in z`);
    }
});

test('a rotated object can still be picked where it now is', () => {
    const { objectBounds } = require('../lib/previs-pick');
    const object = { kind: 'cube', position: [0, 0, 0], sizeM: [3, 1, 0.4], rotationDeg: [90, 0, 0] };
    const bounds = objectBounds(object);
    for (const v of primitiveGeometry(object).vertices) {
        for (let a = 0; a < 3; a++) {
            assert.ok(v[a] >= bounds.min[a] - 1e-6 && v[a] <= bounds.max[a] + 1e-6,
                `a rotated corner sits outside the pick box on axis ${a}`);
        }
    }
});

// ── The target is a staged object, not a box of its own ─────────────────────

const { resolveTarget, solveShot } = require('../lib/previs-blocking');
const { sensorFor } = require('../lib/previs-camera');
const S35 = sensorFor('super35');

test('any primitive can be the thing the shot is of', () => {
    // The framing subject used to be its own box standing next to the objects:
    // a duplicate silhouette, and a second height unrelated to the figure you
    // actually placed. The role survives as a POINTER; the box does not.
    const wrong = [];
    for (const kind of Object.keys(PRIMITIVES)) {
        const size = PRIMITIVES[kind].defaultSizeM;
        const blocking = {
            ...defaultBlocking(),
            subjects: [{ kind, position: [1.5, 0, -2], sizeM: size, isTarget: true }],
        };
        const target = resolveTarget(blocking);
        if (target.index !== 0) wrong.push(`${kind}: index ${target.index}`);
        if (JSON.stringify(target.position) !== JSON.stringify([1.5, 0, -2])) wrong.push(`${kind}: position`);
        if (Math.abs(target.heightM - size[1]) > 1e-9) wrong.push(`${kind}: height ${target.heightM} != ${size[1]}`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('exactly one object is the target, and the first wins if more claim it', () => {
    const blocking = {
        ...defaultBlocking(),
        subjects: [
            { kind: 'cube', position: [0, 0, 0], sizeM: [1, 1, 1] },
            { kind: 'human', position: [2, 0, 0], sizeM: [0.5, 1.7, 0.3], isTarget: true },
            { kind: 'sphere', position: [4, 0, 0], sizeM: [1, 1, 1], isTarget: true },
        ],
    };
    assert.strictEqual(resolveTarget(blocking).index, 1, 'a later claim overrode an earlier one');
});

test('with objects but none marked, the first one is the subject', () => {
    // Placing a figure and framing on it is the obvious intent; making someone
    // designate it before anything works would be ceremony.
    const blocking = {
        ...defaultBlocking(),
        subjects: [{ kind: 'human', position: [0, 0, 1], sizeM: [0.5, 1.82, 0.3] }],
    };
    const target = resolveTarget(blocking);
    assert.strictEqual(target.index, 0);
    assert.strictEqual(target.heightM, 1.82);
});

test('an empty stage still gives the camera something to aim at', () => {
    // Framing on empty space is real — a doorway, a mark on the floor — so the
    // fallback is a POINT, not a resurrected box.
    const target = resolveTarget({ ...defaultBlocking(), subjects: [] });
    assert.deepStrictEqual(target.position, [0, 0, 0]);
    assert.ok(target.heightM > 0, 'no height to solve an angle shot against');
    assert.strictEqual(target.index, -1, 'the fallback claims to be an object');
    assert.strictEqual(target.isPoint, true);
});

test('blocking saved before the target existed still resolves', () => {
    // Every row already stored carries subject_json and no isTarget flag.
    const legacy = { ...defaultBlocking(), subject: { position: [3, 0, -1], heightM: 1.55 } };
    delete legacy.subjects;
    const target = resolveTarget(legacy);
    assert.deepStrictEqual(target.position, [3, 0, -1]);
    assert.strictEqual(target.heightM, 1.55);
});

test('an orbit centres on the designated object, wherever it stands', () => {
    const blocking = {
        ...defaultBlocking(),
        subjects: [
            { kind: 'cube', position: [0, 0, 0], sizeM: [1, 1, 1] },
            { kind: 'human', position: [-2.5, 0, 1.5], sizeM: [0.5, 1.7, 0.3], isTarget: true },
        ],
    };
    const target = resolveTarget(blocking);
    const path = samplePath('orbit', { ...blocking, subject: { position: target.position, heightM: target.heightM } },
        { frames: 16, intensity: 1, amount: 180 });

    const radii = path.map(k => Math.hypot(k.position[0] - (-2.5), k.position[2] - 1.5));
    for (const r of radii) {
        assert.ok(Math.abs(r - radii[0]) < 1e-6, `orbit is not centred on the target: ${r} vs ${radii[0]}`);
    }
});

test('solving a framing shot uses the target height for angle shots', () => {
    const blocking = {
        ...defaultBlocking(),
        subjects: [{ kind: 'human', position: [0, 0, 0], sizeM: [0.5, 2.0, 0.3], isTarget: true }],
    };
    const target = resolveTarget(blocking);
    const solved = solveShot({ shotType: 'low-angle', focalMm: 50, sensor: S35, subject: { position: target.position, heightM: target.heightM } });
    const expected = solveShot({ shotType: 'low-angle', focalMm: 50, sensor: S35, subject: { position: [0, 0, 0], heightM: 2.0 } });
    assert.strictEqual(solved.distanceM, expected.distanceM);
});

// ── Pace: how long the move takes ───────────────────────────────────────────

const { legTimings, movePace, DEFAULT_MOVE_MS } = require('../lib/previs-blocking');

test('a move has a duration, and it defaults to something sane', () => {
    assert.ok(DEFAULT_MOVE_MS >= 500 && DEFAULT_MOVE_MS <= 10000, `implausible default ${DEFAULT_MOVE_MS}`);
});

test('the duration is split across legs by weight, and adds back up', () => {
    // Pace is per leg: a two-second push followed by a six-second pan is a
    // different shot from the reverse, and the weights are what say which.
    const legs = [
        { movement: 'push-in', amount: 1.5, weight: 1 },
        { movement: 'pan-right', amount: 60, weight: 3 },
    ];
    const timings = legTimings(legs, 8000);
    assert.strictEqual(timings.length, 2);
    assert.strictEqual(timings[0].ms + timings[1].ms, 8000, 'the legs do not add up to the move');
    assert.strictEqual(timings[0].ms, 2000);
    assert.strictEqual(timings[1].ms, 6000);
});

test('legs with no weights share the time evenly', () => {
    const timings = legTimings([{ movement: 'dolly-in' }, { movement: 'tilt-up' }, { movement: 'static' }], 3000);
    assert.deepStrictEqual(timings.map(t => t.ms), [1000, 1000, 1000]);
});

test('an empty move list still reports the whole duration', () => {
    assert.deepStrictEqual(legTimings([], 4000), []);
});

test('pace is reported in the unit the movement is measured in', () => {
    // The number a director actually reacts to. Metres per second for a dolly,
    // degrees per second for a pan — reporting one number for both would be
    // comparing a distance to an angle.
    const wrong = [];
    for (const id of VALID_CAMERA_MOVES) {
        const move = MOVEMENTS[id];
        const pace = movePace(id, move.defaultAmount, 2000);
        if (move.unit === 'none') {
            if (pace.value !== 0) wrong.push(`${id}: static has a pace`);
            continue;
        }
        if (pace.unit !== `${move.unit}/s`) wrong.push(`${id}: unit ${pace.unit}`);
        const expected = move.defaultAmount / 2;
        if (Math.abs(pace.value - expected) > 1e-9) wrong.push(`${id}: ${pace.value} != ${expected}`);
    }
    assert.deepStrictEqual(wrong, [], wrong.slice(0, 5).join('; '));
});

test('halving the time doubles the pace', () => {
    const slow = movePace('dolly-in', 2, 4000);
    const fast = movePace('dolly-in', 2, 2000);
    assert.ok(Math.abs(fast.value - slow.value * 2) < 1e-9, `${fast.value} vs ${slow.value}`);
});

test('a zero-length move does not divide by zero', () => {
    const pace = movePace('dolly-in', 2, 0);
    assert.ok(Number.isFinite(pace.value), `pace was ${pace.value}`);
});

test('the sampled path carries the duration it was timed against', () => {
    const blocking = {
        ...defaultBlocking(),
        durationMs: 6000,
        moves: [{ movement: 'push-in', amount: 1 }, { movement: 'tilt-up', amount: 15 }],
    };
    const control = toCameraControl(blocking, 'push-in');
    assert.strictEqual(control.duration_ms, 6000,
        'the generator is told the path but not how fast to travel it');
});

test('an unblocked control still reports a duration', () => {
    const control = toCameraControl(defaultBlocking(), 'dolly-in');
    assert.ok(control.duration_ms > 0);
});

// ── Combined moves: two things at once ──────────────────────────────────────

test('a leg marked `with` runs alongside the previous one, not after it', () => {
    // The ask: push in WHILE panning. Sequentially these are two beats; together
    // they are one move, and the difference is the whole shot.
    const together = sampleSequence(
        [{ movement: 'push-in', amount: 1.5 }, { movement: 'pan-right', amount: 60, with: true }],
        defaultBlocking(), { frames: 16, intensity: 1 });

    // Both must be changing in the SAME frames.
    const mid = together[8];
    const start = together[0];
    assert.ok(Math.abs(mid.position[2] - start.position[2]) > 0.1, 'the push had not begun by the midpoint');
    assert.ok(Math.abs(mid.rotation[0] - start.rotation[0]) > 5, 'the pan had not begun by the midpoint');

    // And both must finish.
    const end = together[together.length - 1];
    assert.ok(Math.abs(end.position[2] - start.position[2] + 1.5) < 1e-6, 'the push did not complete');
    assert.ok(Math.abs(end.rotation[0] - start.rotation[0] + 60) < 1e-6, 'the pan did not complete');
});

test('the same two moves in sequence do NOT overlap', () => {
    // The contrast that proves `with` means something.
    const after = sampleSequence(
        [{ movement: 'push-in', amount: 1.5 }, { movement: 'pan-right', amount: 60 }],
        defaultBlocking(), { frames: 16, intensity: 1 });
    const mid = after[7];
    assert.ok(Math.abs(mid.rotation[0] - after[0].rotation[0]) < 1e-6,
        'the second leg started before the first finished');
});

test('combining any movement with static leaves it unchanged', () => {
    // Set-based over the whole vocabulary: a composition that quietly drops or
    // doubles a leg shows up here and nowhere else.
    const wrong = [];
    for (const id of VALID_CAMERA_MOVES) {
        const alone = sampleSequence([{ movement: id }], defaultBlocking(), { frames: 10, intensity: 1 });
        const withStatic = sampleSequence([{ movement: id }, { movement: 'static', with: true }],
            defaultBlocking(), { frames: 10, intensity: 1 });
        if (JSON.stringify(alone.map(k => k.position.map(v => +v.toFixed(9)))) !==
            JSON.stringify(withStatic.map(k => k.position.map(v => +v.toFixed(9))))) wrong.push(id);
    }
    assert.deepStrictEqual(wrong, [], `combining with static changed: ${wrong.join(', ')}`);
});

test('two translations run together add up as vectors', () => {
    const combined = sampleSequence(
        [{ movement: 'dolly-in', amount: 2 }, { movement: 'tracking-right', amount: 3, with: true }],
        defaultBlocking(), { frames: 12, intensity: 1 });
    const start = combined[0].position;
    const end = combined[combined.length - 1].position;
    const travelled = Math.hypot(end[0] - start[0], end[2] - start[2]);
    assert.ok(Math.abs(travelled - Math.hypot(2, 3)) < 1e-6, `travelled ${travelled.toFixed(4)}`);
});

test('a combined group takes one slot of time, not two', () => {
    // Two legs running together must not double the length of the move.
    const timings = legTimings(
        [{ movement: 'push-in' }, { movement: 'pan-right', with: true }, { movement: 'tilt-up' }], 6000);
    assert.strictEqual(timings.length, 3, 'a timing per leg');
    assert.strictEqual(timings[0].ms, timings[1].ms, 'combined legs do not share their slice');
    assert.strictEqual(timings[0].ms + timings[2].ms, 6000, 'the move got longer than it was told to be');
});

test('a first leg marked `with` is simply the first leg', () => {
    const odd = sampleSequence([{ movement: 'dolly-in', amount: 1, with: true }], defaultBlocking(), { frames: 8, intensity: 1 });
    const plain = sampleSequence([{ movement: 'dolly-in', amount: 1 }], defaultBlocking(), { frames: 8, intensity: 1 });
    assert.deepStrictEqual(odd.map(k => k.position), plain.map(k => k.position));
});

test('a zoom combined with a dolly is the shot that needs both', () => {
    // The dolly-zoom: position and focal length must both move, in the same frames.
    const keys = sampleSequence(
        [{ movement: 'dolly-in', amount: 2 }, { movement: 'zoom-out', amount: 0.5, with: true }],
        defaultBlocking(), { frames: 12, intensity: 1 });
    assert.ok(Math.abs(keys[11].position[2] - keys[0].position[2]) > 1, 'the camera did not move');
    assert.ok(keys[11].focalMm < keys[0].focalMm, 'the lens did not widen');
});

// ── Smoothness ──────────────────────────────────────────────────────────────

const { poseAt, EASINGS, easeT } = require('../lib/previs-blocking');

test('a pose can be read at any moment, not only at a keyframe', () => {
    const path = samplePath('dolly-in', defaultBlocking(), { frames: 5, intensity: 1, amount: 4 });
    const a = poseAt(path, 0);
    const z = poseAt(path, 1);
    assert.deepStrictEqual(a.position, path[0].position);
    assert.deepStrictEqual(z.position, path[path.length - 1].position);

    // Halfway must be halfway, not the nearest key.
    const mid = poseAt(path, 0.5);
    assert.ok(Math.abs(mid.position[2] - (a.position[2] + z.position[2]) / 2) < 1e-9,
        `midpoint ${mid.position[2]} is not between ${a.position[2]} and ${z.position[2]}`);
});

test('every movement plays smoothly, with no held frames', () => {
    // THE test for the reported jank. Playback stepped to the NEAREST keyframe,
    // so a 24-key path repainted at 60fps moved 24 times and stood still in
    // between. Sampling far more often than there are keys is exactly what the
    // player does, and a nearest-neighbour reader fails it on every movement.
    const stuck = [];
    for (const id of VALID_CAMERA_MOVES) {
        if (id === 'static') continue;
        const path = samplePath(id, defaultBlocking(), { frames: 12, intensity: 1 });

        const SAMPLES = 120;
        const deltas = [];
        let previous = poseAt(path, 0);
        for (let i = 1; i <= SAMPLES; i++) {
            const pose = poseAt(path, i / SAMPLES);
            deltas.push(Math.hypot(
                pose.position[0] - previous.position[0],
                pose.position[1] - previous.position[1],
                pose.position[2] - previous.position[2],
            ) + Math.abs(pose.rotation[0] - previous.rotation[0]) / 100
              + Math.abs(pose.rotation[1] - previous.rotation[1]) / 100
              + Math.abs(pose.focalMm - previous.focalMm) / 100);
            previous = pose;
        }
        const held = deltas.filter(d => d < 1e-12).length;
        if (held > 0) stuck.push(`${id}: ${held} of ${SAMPLES} frames held still`);
    }
    assert.deepStrictEqual(stuck, [], stuck.slice(0, 5).join('; '));
});

test('the step between frames stays even, so nothing stutters', () => {
    // Uneven steps read as a stutter even when nothing is held. Linear moves
    // must advance by the same amount every frame.
    const uneven = [];
    for (const id of ['dolly-in', 'pull-out', 'tracking-left', 'crane-up', 'orbit']) {
        const path = samplePath(id, defaultBlocking(), { frames: 9, intensity: 1 });
        const steps = [];
        let previous = poseAt(path, 0);
        for (let i = 1; i <= 90; i++) {
            const pose = poseAt(path, i / 90);
            steps.push(Math.hypot(...pose.position.map((v, a) => v - previous.position[a])));
            previous = pose;
        }
        const biggest = Math.max(...steps);
        const smallest = Math.min(...steps);
        if (biggest > smallest * 1.2 + 1e-9) uneven.push(`${id}: ${smallest.toFixed(6)}..${biggest.toFixed(6)}`);
    }
    assert.deepStrictEqual(uneven, [], uneven.join('; '));
});

test('poseAt is safe at the edges and on a degenerate path', () => {
    const path = samplePath('dolly-in', defaultBlocking(), { frames: 4, intensity: 1 });
    assert.deepStrictEqual(poseAt(path, -3).position, path[0].position);
    assert.deepStrictEqual(poseAt(path, 9).position, path[path.length - 1].position);
    assert.ok(poseAt([], 0.5) === null, 'an empty path should report nothing rather than crash');
    assert.deepStrictEqual(poseAt([path[0]], 0.7).position, path[0].position);
});

// ── Easing ──────────────────────────────────────────────────────────────────

test('every easing starts at nothing and finishes complete', () => {
    // A curve that does not reach 1 leaves the move short of where it was
    // aimed, which reads as the camera stopping early.
    const wrong = [];
    for (const name of Object.keys(EASINGS)) {
        if (Math.abs(easeT(name, 0)) > 1e-9) wrong.push(`${name}: starts at ${easeT(name, 0)}`);
        if (Math.abs(easeT(name, 1) - 1) > 1e-9) wrong.push(`${name}: ends at ${easeT(name, 1)}`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('every easing only ever moves forward', () => {
    // A curve that dips backwards makes the camera reverse mid-move.
    const wrong = [];
    for (const name of Object.keys(EASINGS)) {
        let previous = -1;
        for (let i = 0; i <= 100; i++) {
            const v = easeT(name, i / 100);
            if (v < previous - 1e-12) { wrong.push(`${name} went backwards at t=${i / 100}`); break; }
            previous = v;
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('linear is the default, so nothing already blocked changes', () => {
    const plain = samplePath('dolly-in', defaultBlocking(), { frames: 8, intensity: 1, amount: 2 });
    const explicit = samplePath('dolly-in', defaultBlocking(), { frames: 8, intensity: 1, amount: 2, ease: 'linear' });
    assert.deepStrictEqual(plain, explicit);
});

test('an eased move starts slower than a linear one and still arrives', () => {
    const linear = samplePath('dolly-in', defaultBlocking(), { frames: 21, intensity: 1, amount: 4, ease: 'linear' });
    const eased = samplePath('dolly-in', defaultBlocking(), { frames: 21, intensity: 1, amount: 4, ease: 'ease-in-out' });

    const travelled = keys => Math.abs(keys[2].position[2] - keys[0].position[2]);
    assert.ok(travelled(eased) < travelled(linear), 'the eased move did not start gently');
    assert.ok(Math.abs(eased[20].position[2] - linear[20].position[2]) < 1e-9, 'the eased move did not arrive');
});
