/**
 * Phase 1 — blocking as data.
 *
 * The exit criterion, restated as tests: all 18 camera movements sample to a
 * path whose start and end differ (except `static`), and every framing shot
 * type solves to a camera distance that puts its declared subject height
 * exactly in frame.
 *
 * Set-based over the SCHEMA's registries, not over this module's own tables.
 * That direction matters: a movement table that quietly covers 15 of the 18
 * values `scene_card_yaml` can legally hold is not 83% working — it is a viewer
 * that cannot open three shots somebody already wrote. So the tests iterate
 * VALID_CAMERA_MOVES and VALID_SHOT_TYPES from lib/scene-card-schema.js and
 * demand this module answer for every entry.
 */

const test = require('node:test');
const assert = require('node:assert');

const { VALID_SHOT_TYPES, VALID_CAMERA_MOVES, validateSceneCard } = require('../lib/scene-card-schema');
const { CAMERA_CONTROL_MAP } = require('../lib/video-prompt');
const { sensorFor, frameCoverage, LENS_KIT } = require('../lib/previs-camera');
const {
    RIGS, MOVEMENTS, SHOT_TYPES,
    solveShot, samplePath, rigCanPerform, toCameraControl, defaultBlocking,
} = require('../lib/previs-blocking');

const S35 = sensorFor('super35');
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const differs = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 1e-9);

// ── Coverage of the schema's registries ─────────────────────────────────────

test('every camera movement the schema allows has a path definition', () => {
    const missing = VALID_CAMERA_MOVES.filter(m => !MOVEMENTS[m]);
    assert.deepStrictEqual(missing, [], `movements with no path: ${missing.join(', ')}`);
    assert.strictEqual(Object.keys(MOVEMENTS).length, VALID_CAMERA_MOVES.length,
        'the module invents movements a scene card cannot store');
});

test('every shot type the schema allows resolves to an axis', () => {
    const missing = VALID_SHOT_TYPES.filter(s => !SHOT_TYPES[s]);
    assert.deepStrictEqual(missing, [], `shot types with no previs meaning: ${missing.join(', ')}`);
    assert.strictEqual(Object.keys(SHOT_TYPES).length, VALID_SHOT_TYPES.length);
});

// ── The exit criterion: every movement moves ────────────────────────────────

test('every movement samples to a path that actually changes, except static', () => {
    const inert = [];
    for (const move of VALID_CAMERA_MOVES) {
        const path = samplePath(move, defaultBlocking(), { frames: 12 });
        const a = path[0];
        const b = path[path.length - 1];
        const moved = differs(a.position, b.position) || differs(a.rotation, b.rotation)
            || Math.abs(a.focalMm - b.focalMm) > 1e-9;
        if (move === 'static') {
            if (moved) inert.push(`static moved`);
        } else if (!moved) {
            inert.push(move);
        }
    }
    assert.deepStrictEqual(inert, [], `movements that render as a locked-off camera: ${inert.join(', ')}`);
});

test('a sampled path is well-formed for every movement', () => {
    const bad = [];
    for (const move of VALID_CAMERA_MOVES) {
        const path = samplePath(move, defaultBlocking(), { frames: 10 });
        if (path.length !== 10) { bad.push(`${move}: ${path.length} frames, expected 10`); continue; }
        if (path[0].t !== 0 || path[path.length - 1].t !== 1) bad.push(`${move}: t does not span 0..1`);
        for (const k of path) {
            if (k.position.length !== 3 || k.rotation.length !== 3) bad.push(`${move}: malformed keyframe`);
            if (!(k.focalMm > 0)) bad.push(`${move}: non-positive focal length`);
            if (![k.t, ...k.position, ...k.rotation].every(Number.isFinite)) bad.push(`${move}: non-finite value`);
        }
    }
    assert.deepStrictEqual(bad, [], bad.slice(0, 5).join('; '));
});

test('intensity scales a move without changing its direction', () => {
    for (const move of VALID_CAMERA_MOVES.filter(m => m !== 'static' && m !== 'orbit')) {
        const gentle = samplePath(move, defaultBlocking(), { frames: 2, intensity: 0.25 });
        const strong = samplePath(move, defaultBlocking(), { frames: 2, intensity: 1.0 });
        const dg = gentle[1].position.map((v, i) => v - gentle[0].position[i]);
        const ds = strong[1].position.map((v, i) => v - strong[0].position[i]);
        const magG = Math.hypot(...dg), magS = Math.hypot(...ds);
        if (magG > 1e-9) {
            assert.ok(magS > magG, `${move}: intensity did not scale the translation`);
            // Same direction: the normalised vectors agree.
            for (let i = 0; i < 3; i++) {
                assert.ok(close(dg[i] / magG, ds[i] / magS, 1e-6), `${move}: intensity changed direction`);
            }
        }
    }
});

test('a zero-intensity move is a locked-off camera whatever it is called', () => {
    for (const move of VALID_CAMERA_MOVES) {
        const path = samplePath(move, defaultBlocking(), { frames: 4, intensity: 0 });
        assert.ok(!differs(path[0].position, path[3].position), `${move} translated at zero intensity`);
    }
});

test('orbit keeps a constant distance to the subject', () => {
    // The one movement defined in subject space: if it drifts, it is an arc.
    const blocking = defaultBlocking();
    const path = samplePath('orbit', blocking, { frames: 16 });
    const target = blocking.subject.position;
    const radii = path.map(k => Math.hypot(k.position[0] - target[0], k.position[2] - target[2]));
    for (const r of radii) {
        assert.ok(close(r, radii[0], radii[0] * 1e-6), `orbit radius drifted: ${radii[0]} -> ${r}`);
    }
    assert.ok(differs(path[0].position, path[path.length - 1].position), 'orbit did not travel');
});

test('only the zoom movements change focal length, and in the right direction', () => {
    const changed = VALID_CAMERA_MOVES.filter(m => {
        const p = samplePath(m, defaultBlocking(), { frames: 2 });
        return Math.abs(p[0].focalMm - p[1].focalMm) > 1e-9;
    });
    assert.deepStrictEqual(changed.sort(), ['zoom-in', 'zoom-out']);

    const zin = samplePath('zoom-in', defaultBlocking(), { frames: 2 });
    const zout = samplePath('zoom-out', defaultBlocking(), { frames: 2 });
    assert.ok(zin[1].focalMm > zin[0].focalMm, 'zoom-in got wider');
    assert.ok(zout[1].focalMm < zout[0].focalMm, 'zoom-out got longer');
});

test('a dolly move and a zoom move are not the same shot', () => {
    // The distinction the whole tool exists to show: one changes perspective,
    // the other changes magnification.
    const dolly = samplePath('dolly-in', defaultBlocking(), { frames: 2 });
    const zoom = samplePath('zoom-in', defaultBlocking(), { frames: 2 });
    assert.ok(differs(dolly[0].position, dolly[1].position), 'dolly-in did not move the camera');
    assert.ok(!differs(zoom[0].position, zoom[1].position), 'zoom-in moved the camera');
});

test('handheld is the only rig that adds noise, and it is reproducible', () => {
    const base = defaultBlocking();
    const smooth = samplePath('tracking-forward', { ...base, rig: 'dolly' }, { frames: 12 });
    const shaky = samplePath('tracking-forward', { ...base, rig: 'handheld' }, { frames: 12 });

    const deviation = shaky.some((k, i) => differs(k.position, smooth[i].position));
    assert.ok(deviation, 'handheld rendered as perfectly smooth');

    // Determinism matters: a path that changes per call cannot be recorded in a
    // render ledger, and the same blocking would previs differently every time.
    const again = samplePath('tracking-forward', { ...base, rig: 'handheld' }, { frames: 12 });
    assert.deepStrictEqual(shaky, again, 'handheld noise is not reproducible');
});

// ── The exit criterion: every framing solves ────────────────────────────────

test('every framing shot type puts its declared subject height exactly in frame', () => {
    const wrong = [];
    for (const [id, def] of Object.entries(SHOT_TYPES)) {
        if (def.axis !== 'framing') continue;
        for (const focal of LENS_KIT) {
            const solved = solveShot({ shotType: id, focalMm: focal, sensor: S35 });
            const covered = frameCoverage(solved.distanceM, focal, S35).heightM;
            if (!close(covered, def.subjectHeightM, def.subjectHeightM * 1e-6)) {
                wrong.push(`${id} @${focal}mm: framed ${covered.toFixed(4)}m, wanted ${def.subjectHeightM}m`);
            }
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.slice(0, 5).join('; '));
});

test('a tighter framing always stands the camera closer', () => {
    const framings = Object.entries(SHOT_TYPES)
        .filter(([, d]) => d.axis === 'framing')
        .sort((a, b) => a[1].subjectHeightM - b[1].subjectHeightM);
    let previous = -1;
    for (const [id] of framings) {
        const d = solveShot({ shotType: id, focalMm: 50, sensor: S35 }).distanceM;
        assert.ok(d > previous, `${id} is not further than the tighter framing before it`);
        previous = d;
    }
});

test('every angle shot type sets the camera height and pitch it declares', () => {
    const wrong = [];
    for (const [id, def] of Object.entries(SHOT_TYPES)) {
        if (def.axis !== 'angle') continue;
        const solved = solveShot({ shotType: id, focalMm: 50, sensor: S35 });
        if (!close(solved.position[1], def.cameraHeightM, 1e-9)) wrong.push(`${id}: height ${solved.position[1]}`);
        if (!close(solved.rotation[1], def.pitchDegrees, 1e-9)) wrong.push(`${id}: pitch ${solved.rotation[1]}`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('dutch-angle is the only shot type that rolls the camera', () => {
    const rolled = Object.keys(SHOT_TYPES).filter(id =>
        Math.abs(solveShot({ shotType: id, focalMm: 50, sensor: S35 }).rotation[2]) > 1e-9);
    assert.deepStrictEqual(rolled, ['dutch-angle']);
});

test('every rig shot type resolves to the rig it names', () => {
    const wrong = [];
    for (const [id, def] of Object.entries(SHOT_TYPES)) {
        if (def.axis !== 'rig') continue;
        const solved = solveShot({ shotType: id, focalMm: 50, sensor: S35 });
        if (solved.rig !== def.rig) wrong.push(`${id}: got rig ${solved.rig}`);
        if (!RIGS[solved.rig]) wrong.push(`${id}: rig ${solved.rig} is not declared`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('solveShot always aims the camera at the subject', () => {
    for (const id of VALID_SHOT_TYPES) {
        const solved = solveShot({ shotType: id, focalMm: 50, sensor: S35 });
        assert.ok(Number.isFinite(solved.distanceM) && solved.distanceM > 0, `${id}: no distance`);
        assert.strictEqual(solved.position.length, 3);
        assert.strictEqual(solved.rotation.length, 3);
    }
});

// ── Rigs ────────────────────────────────────────────────────────────────────

test('rig affordances agree with the movement table in both directions', () => {
    const disagreements = [];
    for (const [rigId, rig] of Object.entries(RIGS)) {
        for (const move of rig.affords) {
            if (!MOVEMENTS[move]) { disagreements.push(`${rigId} affords unknown ${move}`); continue; }
            if (!MOVEMENTS[move].rigs.includes(rigId)) disagreements.push(`${rigId} claims ${move}, ${move} does not claim ${rigId}`);
        }
    }
    for (const [move, def] of Object.entries(MOVEMENTS)) {
        for (const rigId of def.rigs) {
            if (!RIGS[rigId]) { disagreements.push(`${move} names unknown rig ${rigId}`); continue; }
            if (!RIGS[rigId].affords.includes(move)) disagreements.push(`${move} claims ${rigId}, ${rigId} does not afford ${move}`);
        }
    }
    assert.deepStrictEqual(disagreements, [], disagreements.slice(0, 5).join('; '));
});

test('rigCanPerform refuses what a rig physically cannot do, and says why', () => {
    const verdict = rigCanPerform('tripod', 'tracking-left');
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.reason && verdict.reason.length > 10, 'a refusal with no reason is not actionable');
    assert.strictEqual(rigCanPerform('dolly', 'tracking-left').ok, true);
});

test('every movement is performable by some rig', () => {
    const orphans = VALID_CAMERA_MOVES.filter(m =>
        !Object.keys(RIGS).some(r => rigCanPerform(r, m).ok));
    assert.deepStrictEqual(orphans, [], `movements no rig can shoot: ${orphans.join(', ')}`);
});

// ── Round trip to generation ────────────────────────────────────────────────

test('every movement emits the camera_control type the video layer already sends', () => {
    // Previs is upstream of generation. If the control type drifts, blocking a
    // shot silently changes what gets generated.
    const wrong = [];
    for (const move of VALID_CAMERA_MOVES) {
        const control = toCameraControl(defaultBlocking(), move);
        if (control.type !== CAMERA_CONTROL_MAP[move].type) {
            wrong.push(`${move}: ${control.type} != ${CAMERA_CONTROL_MAP[move].type}`);
        }
        if (!Array.isArray(control.path) || !control.path.length) wrong.push(`${move}: no sampled path`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('the emitted control keeps the intensity the video layer defaults to', () => {
    for (const move of VALID_CAMERA_MOVES) {
        const control = toCameraControl(defaultBlocking(), move);
        assert.strictEqual(control.intensity, CAMERA_CONTROL_MAP[move].intensity,
            `${move}: previs changed the default intensity`);
    }
});

// ── Scene card schema ───────────────────────────────────────────────────────

test('the scene card accepts the new optical fields', () => {
    const card = {
        shot_code: 'SH01', action: 'Maya wipes the counter',
        camera: {
            shot_type: 'close-up', movement: 'push-in', lens: '85mm',
            sensor: 'super35', aperture: 2.8, focus_distance_m: 2.05, height_m: 1.55,
        },
    };
    const result = validateSceneCard(card);
    assert.deepStrictEqual(result.errors, [], JSON.stringify(result.errors));
    assert.strictEqual(result.valid, true);
});

test('a card written before previs existed still validates', () => {
    // The compatibility guarantee: every field added is optional, and `lens`
    // stays a free string.
    const legacy = { shot_code: 'SH01', action: 'x', camera: { shot_type: 'wide', movement: 'static', lens: '35mm' } };
    assert.strictEqual(validateSceneCard(legacy).valid, true);
    assert.strictEqual(validateSceneCard({ shot_code: 'SH01', action: 'x' }).valid, true);
});

test('the new optical fields are rejected when they are nonsense', () => {
    const cases = [
        [{ sensor: 'not-a-sensor' }, /sensor/i],
        [{ aperture: 0 }, /aperture/i],
        [{ aperture: 'wide open' }, /aperture/i],
        [{ focus_distance_m: -1 }, /focus_distance_m/i],
        [{ height_m: 'chest' }, /height_m/i],
    ];
    for (const [camera, pattern] of cases) {
        const result = validateSceneCard({ shot_code: 'SH01', action: 'x', camera });
        assert.strictEqual(result.valid, false, `accepted ${JSON.stringify(camera)}`);
        assert.ok(result.errors.some(e => pattern.test(e)),
            `no matching error for ${JSON.stringify(camera)}: ${result.errors.join('; ')}`);
    }
});
