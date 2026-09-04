/**
 * Previs blocking — phase 1.
 *
 * Where the camera stands, what it is mounted on, and how it travels. Pure
 * data and pure functions: no DB, no DOM. The viewer in phase 2 renders what
 * this returns; it does not decide any of it.
 *
 * Coordinates follow glTF 2.0 — right-handed, +Y up, camera looking down -Z,
 * metres. Not an arbitrary pick: lib/threed-prompt.js already emits .glb for
 * characters and props, so a generated model drops into the stage without a
 * conversion step, and a conversion step is where sign errors live.
 *
 * TWO THINGS THIS MODULE RECORDS THAT THE ENUMS CANNOT.
 *
 * First, VALID_SHOT_TYPES is three lists wearing one coat. Its eighteen values
 * mix how tight the frame is (`close-up`), where the camera is (`low-angle`),
 * and what it is bolted to (`steadicam`). As prompt tokens that is harmless —
 * they are all appended to a string. In 3D it is load-bearing, because the three
 * are computed from different quantities: framing from lens and distance, angle
 * from height and pitch, rig from the motion path. SHOT_TYPES assigns each value
 * to exactly one axis. The enum itself is untouched, so every scene card already
 * in the database still validates.
 *
 * Second, six of the eighteen movements are the same transform. `dolly-in`,
 * `tracking-forward` and `push-in` all translate camera-local -Z; their
 * opposites all translate +Z. They differ in magnitude and in what rig performs
 * them, not in direction. The vocabulary has twelve distinct transforms. That is
 * invisible to a prompt, where three tokens read as three shots, and unavoidable
 * here, where they would render identically if magnitude and rig did not differ.
 */

const { SENSORS, sensorFor, framingDistance, framingDistanceForWidth, frameCoverage } = require('./previs-camera');

// ── Rigs ────────────────────────────────────────────────────────────────────
//
// A rig is not decoration: it decides which movements are physically available.
// A tripod cannot translate. A slider has about a metre of travel, so a three
// metre tracking shot on one is a mistake worth catching before the truck is
// loaded. Encoding affordances is what turns a drawing into a feasibility check.

const RIGS = {
    tripod: {
        id: 'tripod', label: 'Tripod / fluid head', heightRangeM: [0.3, 1.9],
        affords: ['static', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'zoom-in', 'zoom-out'],
    },
    dolly: {
        id: 'dolly', label: 'Dolly on track', heightRangeM: [0.4, 1.7],
        affords: ['dolly-in', 'dolly-out', 'tracking-left', 'tracking-right', 'tracking-forward',
            'tracking-back', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'static', 'zoom-in', 'zoom-out'],
    },
    slider: {
        id: 'slider', label: 'Slider', travelM: [0.3, 1.5],
        affords: ['tracking-left', 'tracking-right', 'push-in', 'pull-out', 'dolly-in', 'dolly-out', 'zoom-in', 'zoom-out'],
    },
    crane: {
        id: 'crane', label: 'Jib / crane', armLengthM: [1.5, 9.0],
        affords: ['crane-up', 'crane-down', 'orbit', 'tilt-up', 'tilt-down', 'pan-left', 'pan-right', 'zoom-in', 'zoom-out'],
    },
    steadicam: {
        id: 'steadicam', label: 'Steadicam', heightRangeM: [0.2, 2.1],
        affords: ['tracking-forward', 'tracking-back', 'tracking-left', 'tracking-right', 'orbit',
            'dolly-in', 'dolly-out', 'crane-up', 'crane-down', 'zoom-in', 'zoom-out'],
    },
    handheld: {
        id: 'handheld', label: 'Handheld', heightRangeM: [0.2, 2.0], noiseAmplitude: 0.35,
        affords: ['static', 'tracking-forward', 'tracking-back', 'tracking-left', 'tracking-right',
            'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'zoom-in', 'zoom-out'],
    },
    gimbal: {
        id: 'gimbal', label: 'Gimbal', heightRangeM: [0.1, 2.2],
        affords: ['tracking-forward', 'tracking-back', 'tracking-left', 'tracking-right', 'orbit',
            'push-in', 'pull-out', 'pan-left', 'pan-right', 'zoom-in', 'zoom-out'],
    },
    drone: {
        id: 'drone', label: 'Drone', heightRangeM: [0.5, 120.0],
        affords: ['crane-up', 'crane-down', 'orbit', 'tracking-forward', 'tracking-back',
            'tracking-left', 'tracking-right', 'tilt-down', 'pan-left', 'pan-right', 'zoom-in', 'zoom-out'],
    },
    cablecam: {
        id: 'cablecam', label: 'Cable cam', heightRangeM: [2.0, 60.0],
        affords: ['tracking-forward', 'tracking-back', 'crane-down', 'crane-up', 'zoom-in', 'zoom-out'],
    },
};

// ── Movements ───────────────────────────────────────────────────────────────
//
// translate  metres at intensity 1, in `space`
// rotate     [yaw, pitch, roll] degrees at intensity 1, applied to the camera
// focalScale multiplier on focal length across the move
// space      camera | world | subject | none

const MOVEMENTS = {
    'static': { space: 'none', translate: [0, 0, 0], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.0, cameraControlType: 'static', rigs: ['tripod', 'dolly', 'handheld'] },
    'pan-left': { space: 'camera', translate: [0, 0, 0], rotate: [30, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'pan-left', rigs: ['tripod', 'dolly', 'crane', 'handheld', 'gimbal', 'drone'] },
    'pan-right': { space: 'camera', translate: [0, 0, 0], rotate: [-30, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'pan-right', rigs: ['tripod', 'dolly', 'crane', 'handheld', 'gimbal', 'drone'] },
    'tilt-up': { space: 'camera', translate: [0, 0, 0], rotate: [0, 20, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'tilt-up', rigs: ['tripod', 'crane', 'handheld'] },
    'tilt-down': { space: 'camera', translate: [0, 0, 0], rotate: [0, -20, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'tilt-down', rigs: ['tripod', 'crane', 'handheld', 'drone'] },
    'dolly-in': { space: 'camera', translate: [0, 0, -2], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'dolly-in', rigs: ['dolly', 'slider', 'steadicam'] },
    'dolly-out': { space: 'camera', translate: [0, 0, 2], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'dolly-out', rigs: ['dolly', 'slider', 'steadicam'] },
    'zoom-in': { space: 'none', translate: [0, 0, 0], rotate: [0, 0, 0], focalScale: 2.0, defaultIntensity: 0.6, cameraControlType: 'zoom-in', rigs: ['tripod', 'dolly', 'slider', 'crane', 'steadicam', 'handheld', 'gimbal', 'drone', 'cablecam'] },
    'zoom-out': { space: 'none', translate: [0, 0, 0], rotate: [0, 0, 0], focalScale: 0.5, defaultIntensity: 0.6, cameraControlType: 'zoom-out', rigs: ['tripod', 'dolly', 'slider', 'crane', 'steadicam', 'handheld', 'gimbal', 'drone', 'cablecam'] },
    'tracking-left': { space: 'camera', translate: [-2, 0, 0], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'tracking-left', rigs: ['dolly', 'slider', 'steadicam', 'handheld', 'gimbal', 'drone'] },
    'tracking-right': { space: 'camera', translate: [2, 0, 0], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'tracking-right', rigs: ['dolly', 'slider', 'steadicam', 'handheld', 'gimbal', 'drone'] },
    'tracking-forward': { space: 'camera', translate: [0, 0, -3], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'tracking-forward', rigs: ['dolly', 'steadicam', 'handheld', 'gimbal', 'drone', 'cablecam'] },
    'tracking-back': { space: 'camera', translate: [0, 0, 3], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'tracking-back', rigs: ['dolly', 'steadicam', 'handheld', 'gimbal', 'drone', 'cablecam'] },
    'crane-up': { space: 'world', translate: [0, 2.5, 0], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.6, cameraControlType: 'crane-up', rigs: ['crane', 'steadicam', 'drone', 'cablecam'] },
    'crane-down': { space: 'world', translate: [0, -2.5, 0], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.6, cameraControlType: 'crane-down', rigs: ['crane', 'steadicam', 'drone', 'cablecam'] },
    'orbit': { space: 'subject', translate: [0, 0, 0], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.7, cameraControlType: 'orbit', orbitDegrees: 90, rigs: ['crane', 'steadicam', 'gimbal', 'drone'] },
    'push-in': { space: 'camera', translate: [0, 0, -0.6], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'push-in', rigs: ['dolly', 'slider', 'gimbal'] },
    'pull-out': { space: 'camera', translate: [0, 0, 0.6], rotate: [0, 0, 0], focalScale: 1, defaultIntensity: 0.5, cameraControlType: 'pull-out', rigs: ['dolly', 'slider', 'gimbal'] },
};

/**
 * How far, in units a crew would use.
 *
 * The magnitude was baked into each movement's vector with only an abstract
 * 0..1 intensity on top, so "dolly in two metres" was not sayable — you could
 * ask for half of whatever two metres happened to be. Unit and amount are
 * DERIVED from the vector rather than retyped beside it, because two numbers
 * that must agree and are maintained separately eventually do not, and the one
 * that loses is the saved shot.
 */
for (const move of Object.values(MOVEMENTS)) {
    const translate = Math.hypot(...move.translate);
    const rotate = move.orbitDegrees || Math.hypot(...move.rotate);

    if (translate > 0) { move.unit = 'm'; move.defaultAmount = translate; }
    else if (rotate > 0) { move.unit = 'deg'; move.defaultAmount = rotate; }
    else if (move.focalScale !== 1) { move.unit = 'ratio'; move.defaultAmount = move.focalScale; }
    else { move.unit = 'none'; move.defaultAmount = 0; }

    // Unit direction, so an amount can be applied without re-deriving it per call.
    move.direction = translate > 0 ? move.translate.map(v => v / translate) : [0, 0, 0];
    move.rotateDirection = Math.hypot(...move.rotate) > 0
        ? move.rotate.map(v => v / Math.hypot(...move.rotate)) : [0, 0, 0];
}

/** The magnitude a leg will actually use: an explicit amount, or the default. */
function moveAmount(movement, amount) {
    const move = MOVEMENTS[movement];
    if (!move) throw new Error(`previs: unknown movement '${movement}'`);
    return (typeof amount === 'number' && Number.isFinite(amount)) ? amount : move.defaultAmount;
}

// ── Shot types, decomposed ──────────────────────────────────────────────────

const SHOT_TYPES = {
    'extreme-close-up': { axis: 'framing', subjectHeightM: 0.18 },
    'close-up': { axis: 'framing', subjectHeightM: 0.45 },
    'medium': { axis: 'framing', subjectHeightM: 1.0 },
    'two-shot': { axis: 'framing', subjectHeightM: 1.3, subjectWidthM: 1.6 },
    'over-the-shoulder': { axis: 'framing', subjectHeightM: 0.9, foregroundOccluder: true },
    'wide': { axis: 'framing', subjectHeightM: 2.2 },
    'insert': { axis: 'framing', subjectHeightM: 0.12 },
    'establishing': { axis: 'framing', subjectHeightM: 12.0 },

    'low-angle': { axis: 'angle', cameraHeightM: 0.45, pitchDegrees: 18 },
    'high-angle': { axis: 'angle', cameraHeightM: 2.6, pitchDegrees: -22 },
    'dutch-angle': { axis: 'angle', cameraHeightM: 1.6, pitchDegrees: 0, rollDegrees: 15 },
    'aerial': { axis: 'angle', cameraHeightM: 40.0, pitchDegrees: -55, requiresRig: 'drone' },
    'pov': { axis: 'angle', cameraHeightM: 1.65, pitchDegrees: 0 },

    'tracking': { axis: 'rig', rig: 'dolly' },
    'dolly': { axis: 'rig', rig: 'dolly' },
    'steadicam': { axis: 'rig', rig: 'steadicam' },
    'handheld': { axis: 'rig', rig: 'handheld' },
    'crane': { axis: 'rig', rig: 'crane' },
};

/** Eye height of a standing adult — the default the angle axis is measured against. */
const DEFAULT_EYE_HEIGHT_M = 1.6;
const DEFAULT_SUBJECT_HEIGHT_M = 1.7;

// ── Small vector helpers ────────────────────────────────────────────────────

const DEG = Math.PI / 180;

/** Rotate a vector about +Y by yaw degrees. Pitch is deliberately excluded. */
function yawVector([x, y, z], yawDeg) {
    const a = yawDeg * DEG;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return [x * cos + z * sin, y, -x * sin + z * cos];
}

/**
 * Deterministic value noise in [-1, 1].
 *
 * Deliberately not Math.random. A handheld path that differs between two calls
 * cannot be written to a render ledger, and the same blocking would previs
 * differently every time it was opened — the shot would stop being a decision
 * and become a mood.
 */
function noise(seed, index, channel) {
    const n = Math.sin((seed + 1) * 12.9898 + index * 78.233 + channel * 37.719) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1;
}

// ── Blocking ────────────────────────────────────────────────────────────────

/** A neutral stage: subject at the origin, camera back and at eye height. */
/**
 * What a scene card says the camera IS, read once.
 *
 * "50mm", "50 mm", 50 — the card's lens is a free string by design, so it is
 * parsed rather than trusted, and an unparseable one falls back instead of
 * failing: a card that says "anamorphic" should still open a stage.
 *
 * This was inline in the previs from-card seed, which was fine while previs was
 * the only thing that had to turn a written shot into optics. It is not any
 * more — playback has to compute the move a card names for shots nobody ever
 * blocked, which on a real board is most of them — and two readings of the same
 * free string is exactly how a stage and a playhead come to disagree about
 * which lens a shot is on.
 */
function cardOptics(cam, filmDefaults) {
    const camera = cam || {};
    const film = filmDefaults || {};
    const focalMm = (() => {
        const raw = camera.focal_mm !== undefined ? camera.focal_mm : camera.lens;
        const n = typeof raw === 'number' ? raw : parseFloat(String(raw || '').replace(/[^0-9.]/g, ''));
        if (Number.isFinite(n) && n > 0) return n;
        return Number(film.focalMm) > 0 ? Number(film.focalMm) : 50;
    })();
    return {
        shotType: SHOT_TYPES[camera.shot_type] ? camera.shot_type : 'medium',
        movement: MOVEMENTS[camera.movement] ? camera.movement : 'static',
        focalMm,
        sensorId: SENSORS[camera.sensor] ? camera.sensor
            : (SENSORS[film.sensorId] ? film.sensorId : 'super35'),
        fStop: Number(camera.aperture) > 0 ? Number(camera.aperture)
            : (Number(film.fStop) > 0 ? Number(film.fStop) : 2.8),
        heightM: Number(camera.height_m) > 0 ? Number(camera.height_m) : DEFAULT_EYE_HEIGHT_M,
    };
}

function defaultBlocking(overrides) {
    return {
        camera: { position: [0, DEFAULT_EYE_HEIGHT_M, 3], rotation: [0, 0, 0], focalMm: 50, sensorId: 'super35', fStop: 2.8, focusDistanceM: 3 },
        subject: { position: [0, 0, 0], heightM: DEFAULT_SUBJECT_HEIGHT_M },
        stage: { widthM: 12, depthM: 12 },
        rig: 'dolly',
        ...(overrides || {}),
    };
}

/**
 * Place the camera for a shot type.
 *
 * Each axis answers a different question, which is why the enum had to be split
 * before any of this could be computed:
 *   framing -> how far back, from lens and subject height
 *   angle   -> how high and at what pitch
 *   rig     -> what it is mounted on; framing left at the caller's default
 */
function solveShot(opts) {
    const { shotType, focalMm, sensor, subject, rig } = opts || {};
    const azimuthDeg = Number.isFinite(opts && opts.azimuthDeg) ? opts.azimuthDeg : 0;
    const def = SHOT_TYPES[shotType];
    if (!def) throw new Error(`previs: unknown shot type '${shotType}'`);

    const gate = sensor || sensorFor('super35');
    const focal = focalMm || 50;
    const target = (subject && subject.position) || [0, 0, 0];
    const subjectHeight = (subject && subject.heightM) || DEFAULT_SUBJECT_HEIGHT_M;

    let distanceM;
    let heightM = DEFAULT_EYE_HEIGHT_M;
    let pitch = 0;
    let roll = 0;
    let resolvedRig = rig || 'dolly';

    if (def.axis === 'framing') {
        // Width governs when it is the wider of the two — a two-shot is defined
        // by fitting two people side by side, not by their height.
        const byHeight = framingDistance(def.subjectHeightM, focal, gate);
        const byWidth = def.subjectWidthM ? framingDistanceForWidth(def.subjectWidthM, focal, gate) : 0;
        distanceM = Math.max(byHeight, byWidth);
    } else if (def.axis === 'angle') {
        heightM = def.cameraHeightM;
        pitch = def.pitchDegrees;
        roll = def.rollDegrees || 0;
        distanceM = framingDistance(subjectHeight, focal, gate);
        if (def.requiresRig) resolvedRig = def.requiresRig;
    } else {
        resolvedRig = def.rig;
        distanceM = framingDistance(subjectHeight, focal, gate);
    }

    const azimuth = azimuthDeg * DEG;
    return {
        shotType,
        axis: def.axis,
        distanceM,
        // Camera looks down -Z, so standing it at +Z aims it at the subject.
        position: [target[0] + Math.sin(azimuth) * distanceM, heightM,
            target[2] + Math.cos(azimuth) * distanceM],
        rotation: [azimuthDeg, pitch, roll],
        focalMm: focal,
        sensorId: gate.id,
        rig: resolvedRig,
    };
}

const ROTATION_UNITS = new Set(['degrees', 'radians']);

function keyRotationDegrees(key) {
    const rotation = Array.isArray(key && key.rotation) ? key.rotation : [0, 0, 0];
    const unit = (key && key.rotationUnit) || 'radians';
    if (!ROTATION_UNITS.has(unit)) throw new Error(`previs: unknown rotation unit '${unit}'`);
    return unit === 'degrees' ? rotation.map(Number) : rotation.map(value => Number(value) / DEG);
}

function shortestAngleDeltaDegrees(from, to) {
    let delta = (Number(to) - Number(from)) % 360;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
}

/** Convert public/MCP keys into the one unit persisted by Previs. */
function normalizeCameraKeys(keys) {
    return (Array.isArray(keys) ? keys : []).map(key => ({
        ...key,
        position: Array.isArray(key.position) ? key.position.map(Number) : key.position,
        rotation: keyRotationDegrees(key),
        focalMm: Number(key.focalMm),
        rotationUnit: 'degrees',
    }));
}

/** Interpolate director-authored full camera keys into the stored preview path. */
function sampleCameraKeys(keys, opts) {
    const source = normalizeCameraKeys(keys).filter(k => k && Number.isFinite(k.t))
        .slice().sort((a, b) => a.t - b.t);
    if (!source.length) return [];
    if (source.length === 1) return [JSON.parse(JSON.stringify(source[0]))];
    const frames = Math.max(2, Number(opts && opts.frames) || 24);
    const out = [];
    const mix = (a, b, t) => a + (b - a) * t;
    for (let i = 0; i < frames; i++) {
        const t = i / (frames - 1);
        let n = 0;
        while (n < source.length - 2 && source[n + 1].t < t) n++;
        const a = source[n], b = source[n + 1];
        const f = b.t === a.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
        out.push({ t,
            position: a.position.map((v, x) => mix(v, b.position[x], f)),
            rotation: a.rotation.map((v, x) => v + shortestAngleDeltaDegrees(v, b.rotation[x]) * f),
            focalMm: mix(a.focalMm, b.focalMm, f),
            rotationUnit: 'degrees' });
    }
    return out;
}

/** Name a free path once for both prompt prose and provider-safe control. */
function analyzePath(path) {
    const keys = Array.isArray(path) ? path : [];
    if (keys.length < 2) return { dominantMovement: 'static', description: 'locked-off camera' };
    const scores = new Map();
    const add = (id, score) => {
        if (!(score > 0)) return;
        scores.set(id, (scores.get(id) || 0) + score);
    };
    const legs = [];
    const source = normalizeCameraKeys(keys);

    // Accumulate every leg. Endpoint subtraction calls an out-and-back move
    // static, even though both the prompt and provider must know it moved.
    for (let i = 0; i < source.length - 1; i++) {
        const a = source[i] || {}, b = source[i + 1] || {};
        const pa = Array.isArray(a.position) ? a.position : [0, 0, 0];
        const pb = Array.isArray(b.position) ? b.position : pa;
        const ra = Array.isArray(a.rotation) ? a.rotation : [0, 0, 0];
        const rb = Array.isArray(b.rotation) ? b.rotation : ra;
        const worldDelta = pb.map((v, axis) => Number(v) - Number(pa[axis]));
        // A move is named from what the operator sees, not from the stage's
        // world axes. Inverting the starting yaw expresses it camera-locally.
        const local = yawVector(worldDelta, -(Number(ra[0]) || 0));
        const yaw = shortestAngleDeltaDegrees(ra[0], rb[0]);
        const pitch = shortestAngleDeltaDegrees(ra[1], rb[1]);
        const roll = shortestAngleDeltaDegrees(ra[2], rb[2]);
        const fa = Number(a.focalMm), fb = Number(b.focalMm);
        const events = [];
        const event = (id, score, words) => {
            if (!(score > 0)) return;
            add(id, score);
            events.push({ id, score, words: words || id.replaceAll('-', ' ') });
        };

        // Scores are normalised by the registry's typical physical amount so
        // centimetres of drift cannot outrank metres of intentional travel.
        if (Math.abs(local[0]) > .01) event(local[0] > 0 ? 'tracking-right' : 'tracking-left', Math.abs(local[0]) / 2);
        if (Math.abs(worldDelta[1]) > .01) event(worldDelta[1] > 0 ? 'crane-up' : 'crane-down', Math.abs(worldDelta[1]) / 2.5);
        if (Math.abs(local[2]) > .01) event(local[2] < 0 ? 'dolly-in' : 'dolly-out', Math.abs(local[2]) / 2);
        if (Math.abs(yaw) >= .5) event(yaw > 0 ? 'pan-left' : 'pan-right', Math.abs(yaw) / 30);
        if (Math.abs(pitch) >= .5) event(pitch > 0 ? 'tilt-up' : 'tilt-down', Math.abs(pitch) / 20);
        // Roll has no provider enum. Orbit is the closest honest supported
        // control while the prose explicitly names the roll.
        if (Math.abs(roll) >= .5) {
            event('orbit', Math.abs(roll) / 90,
                roll > 0 ? 'roll clockwise' : 'roll counterclockwise');
        }
        if (fa > 0 && fb > 0 && Math.abs(fb - fa) > .1) {
            event(fb > fa ? 'zoom-in' : 'zoom-out', Math.abs(Math.log2(fb / fa)));
        }
        if (events.length) legs.push(events.sort((x, y) => y.score - x.score)
            .map(item => item.words).join(' while '));
    }
    if (!scores.size) return { dominantMovement: 'static', description: 'locked-off camera' };
    const dominantMovement = [...scores].sort((a, b) => b[1] - a[1])[0][0];
    return { dominantMovement, description: legs.join(' then ') };
}

/**
 * What the shot is OF.
 *
 * There used to be a standalone "framing subject" — its own box, standing next
 * to the staged objects, with its own height. That box was redundant the moment
 * objects existed: it duplicated a silhouette, and it carried a height unrelated
 * to the figure someone had actually placed, so typing 1.82 into a field marked
 * subject height changed nothing about the figure in front of it.
 *
 * The ROLE is not redundant. Every camera operation is relative to something:
 * framing distance, orbit centre, where the camera points, what the stage view
 * looks at. So the subject becomes a pointer at one of the objects, and its
 * height is that object's real height.
 *
 * The fallback is a POINT, not a resurrected box, because framing on empty
 * space is a real thing to want — a doorway someone will walk through, a mark
 * on the floor where an actor will stand.
 */
function resolveTarget(blocking) {
    const state = blocking || {};
    const objects = Array.isArray(state.subjects) ? state.subjects : [];

    if (objects.length) {
        // Designated, else the first one placed: making someone nominate a
        // subject before anything works would be ceremony.
        let index = objects.findIndex(o => o && o.isTarget);
        if (index < 0) index = 0;
        const object = objects[index];
        const size = (object.sizeM && object.sizeM.length === 3) ? object.sizeM : [0.5, DEFAULT_SUBJECT_HEIGHT_M, 0.5];
        return {
            index,
            isPoint: false,
            position: (object.position || [0, 0, 0]).slice(),
            heightM: size[1],
        };
    }

    // Nothing staged. Honour a stored subject if this blocking predates the
    // pointer, otherwise aim at the origin.
    const stored = state.subject || {};
    return {
        index: -1,
        isPoint: true,
        position: Array.isArray(stored.position) ? stored.position.slice() : [0, 0, 0],
        heightM: stored.heightM > 0 ? stored.heightM : DEFAULT_SUBJECT_HEIGHT_M,
    };
}

/**
 * How long a move takes — the dial that turns a path into a shot.
 *
 * A 1.5m push over one second is a lunge; the same push over eight is a creep.
 * The geometry is identical, so duration is the only thing that says which, and
 * it was the one property a blocked move did not carry.
 *
 * Defaults to four seconds, but the caller should prefer the SHOT's own
 * duration_ms: a camera move that outlasts its shot is a mistake worth seeing
 * in previs rather than in the edit.
 */
const DEFAULT_MOVE_MS = 4000;

/**
 * Split a duration across legs by weight.
 *
 * Rounded so the parts add back to the whole — the last leg absorbs the
 * remainder, because a move that is three milliseconds short of its shot is
 * noise, and a total that does not match its parts is a bug someone will chase.
 */
function legTimings(moves, durationMs) {
    const legs = Array.isArray(moves) ? moves.filter(m => m && MOVEMENTS[m.movement]) : [];
    if (!legs.length) return [];

    const total = durationMs > 0 ? durationMs : DEFAULT_MOVE_MS;
    const groups = groupLegs(legs);
    const weights = groups.map(g => Math.max(...g.map(l =>
        (typeof l.weight === 'number' && l.weight > 0) ? l.weight : 1)));
    const sum = weights.reduce((a, b) => a + b, 0);

    // Legs in a group SHARE their slice rather than each taking one, so running
    // two moves together does not make the shot twice as long.
    let spent = 0;
    const out = [];
    groups.forEach((group, gi) => {
        const ms = (gi === groups.length - 1) ? total - spent : Math.round(total * weights[gi] / sum);
        spent += ms;
        for (const leg of group) {
            const amount = moveAmount(leg.movement, leg.amount);
            out.push({ movement: leg.movement, amount, ms, with: !!leg.with, pace: movePace(leg.movement, amount, ms) });
        }
    });
    return out;
}

/**
 * Pace, in the unit the movement is measured in.
 *
 * Metres per second for a dolly, degrees per second for a pan. Reporting a
 * single number for both would be comparing a distance to an angle, which is
 * how you end up with a "speed" that means nothing.
 */
function movePace(movement, amount, ms) {
    const move = MOVEMENTS[movement];
    if (!move || move.unit === 'none') return { value: 0, unit: '', label: 'still' };

    const seconds = ms > 0 ? ms / 1000 : 0;
    const magnitude = (typeof amount === 'number' && Number.isFinite(amount)) ? amount : move.defaultAmount;
    const value = seconds > 0 ? magnitude / seconds : 0;

    return {
        value,
        unit: `${move.unit}/s`,
        label: `${value.toFixed(move.unit === 'deg' ? 0 : 2)} ${move.unit}/s`,
    };
}

/**
 * Read the camera pose at any moment in a path.
 *
 * Playback stepped to the NEAREST keyframe, so a 24-key path repainted at 60fps
 * moved twenty-four times and stood still in between. Every movement was
 * stepped, not just the short ones — a pull-out is simply where it is most
 * obvious, because its default travel is 30cm and each hop is a visible 12mm.
 *
 * Interpolating between the bracketing keys makes smoothness independent of how
 * densely the path was sampled, which is the property that matters: the key
 * count is a storage decision, and it should not be visible in the shot.
 */
function poseAt(path, t) {
    if (!Array.isArray(path) || !path.length) return null;
    if (path.length === 1) return path[0];

    const clamped = Math.max(0, Math.min(1, t));
    const span = (path.length - 1) * clamped;
    const i = Math.min(path.length - 2, Math.floor(span));
    const f = span - i;

    const a = path[i];
    const b = path[i + 1];
    const mix = (x, y) => x + (y - x) * f;

    return {
        t: clamped,
        position: a.position.map((v, axis) => mix(v, b.position[axis])),
        rotation: a.rotation.map((v, axis) => mix(v, b.rotation[axis])),
        focalMm: mix(a.focalMm, b.focalMm),
    };
}

/**
 * Easing curves.
 *
 * A move that starts and stops instantly is smooth in the sense of having no
 * dropped frames and mechanical in every other sense — real camera moves ramp.
 * Linear stays the default so nothing already blocked changes; easing is a
 * choice, recorded per leg like its distance.
 */
const EASINGS = {
    'linear': t => t,
    'ease-in': t => t * t,
    'ease-out': t => 1 - (1 - t) * (1 - t),
    'ease-in-out': t => (t < 0.5) ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
};

/*
 * HOLD is the absence of travel, not a curve.
 *
 * EASINGS is the set of ways a value moves BETWEEN two poses; a held leg does
 * not move at all, so it has no curve to be. Keeping it out of EASINGS is what
 * lets previs-routes go on pinning the viewer's curve set to this one — the
 * guarantee that stops the preview and the stored path describing different
 * moves — and it is also just true.
 *
 * An UNKNOWN name still falls back to linear rather than holding. Silently
 * freezing a camera because somebody mistyped an easing is a worse failure than
 * ignoring the typo, and much harder to see.
 */
const HOLD = 'hold';

function easeT(name, t) {
    if (name === HOLD) return 0;
    const curve = EASINGS[name] || EASINGS.linear;
    return curve(Math.max(0, Math.min(1, t)));
}

/** Can this rig physically perform this move? A refusal always says why. */
function rigCanPerform(rigId, movement) {
    const rig = RIGS[rigId];
    if (!rig) return { ok: false, reason: `unknown rig '${rigId}'` };
    if (!MOVEMENTS[movement]) return { ok: false, reason: `unknown movement '${movement}'` };
    if (rig.affords.includes(movement)) return { ok: true };

    const alternatives = Object.values(RIGS).filter(r => r.affords.includes(movement)).map(r => r.label);
    return {
        ok: false,
        reason: `a ${rig.label} cannot perform '${movement}'` +
            (alternatives.length ? `; it needs ${alternatives.join(', ')}` : ''),
    };
}

/**
 * Sample a movement into keyframes.
 *
 * Stored sampled rather than parametric, for the same reason
 * film_flow_runs.graph_snapshot stores the graph as run: a path derived from an
 * enum silently stops meaning anything the moment that enum's default intensity
 * is retuned, and "recreate this shot exactly" has to survive the taxonomy
 * changing underneath it.
 */
function samplePath(movement, blocking, opts) {
    const move = MOVEMENTS[movement];
    if (!move) throw new Error(`previs: unknown movement '${movement}'`);

    const options = opts || {};
    const frames = Math.max(2, options.frames || 24);
    const intensity = options.intensity === undefined ? move.defaultIntensity : options.intensity;
    const state = blocking || defaultBlocking();

    // Scale the declared vectors to the requested magnitude. Omitting `amount`
    // reproduces the pre-existing vectors exactly, which is what keeps every
    // blocking saved before this existed sampling to the same path.
    const amount = moveAmount(movement, options.amount);
    const scale = move.defaultAmount > 0 ? amount / move.defaultAmount : 1;
    const translate = move.translate.map(v => v * scale);
    const rotateBy = move.rotate.map(v => v * scale);
    const orbitDegrees = (move.orbitDegrees || 0) * scale;
    const focalScale = move.unit === 'ratio' ? amount : move.focalScale;

    const from = state.camera.position;
    const rot = state.camera.rotation;
    const focal = state.camera.focalMm;
    const target = state.subject.position;

    const rig = RIGS[state.rig];
    const shake = rig && rig.noiseAmplitude ? rig.noiseAmplitude : 0;
    // Seeded from the start pose so the same blocking always shakes the same way.
    const seed = Math.abs(from[0] * 7 + from[1] * 13 + from[2] * 17) + frames;

    // Orbit is polar, so its radius and start angle come off the actual
    // geometry rather than from a translation vector.
    const radius = Math.hypot(from[0] - target[0], from[2] - target[2]);
    const startAngle = Math.atan2(from[0] - target[0], from[2] - target[2]);

    const ease = options.ease || 'linear';
    const keys = [];
    for (let i = 0; i < frames; i++) {
        const linearT = i / (frames - 1);
        // Eased progress drives the geometry; the key's own `t` stays linear so
        // the path is still a uniform timeline for anything reading it.
        const t = easeT(ease, linearT);
        let position = [...from];
        let rotation = [...rot];

        if (move.space === 'camera') {
            const step = yawVector(translate, rot[0]).map(v => v * intensity * t);
            position = position.map((v, axis) => v + step[axis]);
        } else if (move.space === 'world') {
            position = position.map((v, axis) => v + translate[axis] * intensity * t);
        } else if (move.space === 'subject') {
            const sweep = orbitDegrees * intensity * t * DEG;
            const angle = startAngle + sweep;
            position = [target[0] + Math.sin(angle) * radius, from[1], target[2] + Math.cos(angle) * radius];
            // Stay pointed at the subject through the arc.
            rotation = [rot[0] + orbitDegrees * intensity * t, rot[1], rot[2]];
        }

        if (move.space !== 'subject') {
            rotation = rotation.map((v, axis) => v + rotateBy[axis] * intensity * t);
        }

        if (shake && intensity > 0) {
            for (let axis = 0; axis < 3; axis++) position[axis] += noise(seed, i, axis) * shake * 0.02;
            for (let axis = 0; axis < 3; axis++) rotation[axis] += noise(seed, i, axis + 3) * shake * 0.4;
        }

        keys.push({
            t: linearT,
            position,
            rotation,
            // Interpolated geometrically: a zoom is a constant ratio per unit
            // time, not a constant number of millimetres.
            focalMm: focal * Math.pow(focalScale, intensity * t),
        });
    }

    return keys;
}

/**
 * Sample a SEQUENCE of moves into one continuous path.
 *
 * A real camera move is rarely one primitive: push in, settle, then pan off the
 * subject. Each leg starts from where the previous one ended — the whole point,
 * and the reason a sequence cannot be N independent paths concatenated. The
 * camera state carried forward is position, rotation and focal length, so a
 * dolly followed by a zoom compounds the way it would on set.
 *
 * `weight` splits the frames between legs. Equal by default, because a
 * sequence with no stated rhythm is more honestly an even one than a guess.
 *
 * @param {Array<{movement:string, amount?:number, weight?:number}>} moves
 */
function sampleSequence(moves, blocking, opts) {
    const options = opts || {};
    const frames = Math.max(2, options.frames || 24);
    const state = blocking || defaultBlocking();
    const legs = Array.isArray(moves) ? moves.filter(m => m && MOVEMENTS[m.movement]) : [];

    // A leg's amount IS its magnitude. Letting the movement's default intensity
    // scale it too would mean asking for fifteen degrees and getting seven and a
    // half, which makes the number on screen a lie. Intensity stays available as
    // an explicit overall scale for the whole sequence.
    const intensity = options.intensity === undefined ? 1 : options.intensity;

    if (!legs.length) {
        // A camera with nothing asked of it is locked off, not an error: an
        // empty move list is what a shot looks like before anyone blocks it.
        return samplePath('static', state, { ...options, frames });
    }

    // Legs marked `with` join the PREVIOUS one and run at the same time. A
    // push while panning is one move, not two beats, and the difference is the
    // whole shot — so concurrency is a property of the leg rather than a second
    // list the caller has to keep in step.
    const groups = groupLegs(legs);

    const weights = groups.map(g => Math.max(...g.map(leg =>
        (typeof leg.weight === 'number' && leg.weight > 0) ? leg.weight : 1)));
    const total = weights.reduce((a, b) => a + b, 0);

    // Frames are apportioned by weight, with the remainder going to the last
    // leg so the path always has exactly `frames` keys.
    const counts = weights.map(w => Math.max(2, Math.round(frames * w / total)));
    let excess = counts.reduce((a, b) => a + b, 0) - (frames + groups.length - 1);
    for (let i = counts.length - 1; i >= 0 && excess !== 0; i--) {
        const room = counts[i] - 2;
        const take = Math.max(-room, Math.min(excess, room));
        counts[i] -= take;
        excess -= take;
    }

    let cursor = { ...state, camera: { ...state.camera } };
    const keys = [];

    for (let i = 0; i < groups.length; i++) {
        const legKeys = sampleGroup(groups[i], cursor, {
            frames: counts[i],
            intensity,
        });

        // Drop the first key of every leg after the first: it is the previous
        // leg's last pose, and keeping both would stall the move for a frame.
        keys.push(...(i === 0 ? legKeys : legKeys.slice(1)));

        const last = legKeys[legKeys.length - 1];
        cursor = {
            ...cursor,
            camera: { ...cursor.camera, position: last.position, rotation: last.rotation, focalMm: last.focalMm },
        };
    }

    // Re-time across the whole sequence so t still spans 0..1.
    return keys.map((k, i) => ({ ...k, t: keys.length === 1 ? 0 : i / (keys.length - 1) }));
}

/** Split a leg list into groups that run at the same time. */
function groupLegs(legs) {
    const groups = [];
    for (const leg of legs) {
        // A `with` on the very first leg has nothing to join, so it simply
        // opens the first group rather than being an error.
        if (leg.with && groups.length) groups[groups.length - 1].push(leg);
        else groups.push([leg]);
    }
    return groups;
}

/**
 * Sample several movements running at once.
 *
 * Each leg is sampled from the SAME start pose, and their deltas are composed:
 * translations add as vectors, rotations add, focal lengths multiply. Composing
 * deltas rather than chaining poses is what makes a dolly-zoom come out right —
 * chaining would apply the zoom to a camera that had already moved, which is a
 * different shot.
 */
function sampleGroup(group, blocking, opts) {
    if (group.length === 1) {
        return samplePath(group[0].movement, blocking, { ...opts, amount: group[0].amount, ease: group[0].ease });
    }

    const perLeg = group.map(leg => samplePath(leg.movement, blocking, { ...opts, amount: leg.amount, ease: leg.ease }));
    const base = perLeg[0][0];

    return perLeg[0].map((_, frame) => {
        const position = base.position.slice();
        const rotation = base.rotation.slice();
        let focalMm = base.focalMm;

        for (const keys of perLeg) {
            const k = keys[frame];
            for (let a = 0; a < 3; a++) {
                position[a] += k.position[a] - base.position[a];
                rotation[a] += k.rotation[a] - base.rotation[a];
            }
            if (base.focalMm) focalMm *= k.focalMm / base.focalMm;
        }
        return { t: perLeg[0][frame].t, position, rotation, focalMm };
    });
}

/**
 * The payload the video layer already understands, plus the sampled path.
 *
 * `type` and `intensity` are copied from the movement definition unchanged, so
 * a blocked shot generates exactly what an unblocked one would; the path is
 * additive. Previs that quietly retuned the control would make blocking a shot
 * change its look for reasons nobody asked for.
 */
function toCameraControl(blocking, movement) {
    const move = MOVEMENTS[movement];
    if (!move) throw new Error(`previs: unknown movement '${movement}'`);

    const state = blocking || defaultBlocking();
    // A blocking that carries a sequence is sampled as one; the named movement
    // still decides the control type, because that is what the generator knows.
    const path = (Array.isArray(state.moves) && state.moves.length)
        ? sampleSequence(state.moves, state, { frames: 24 })
        : samplePath(movement, state, { frames: 12 });

    return {
        type: move.cameraControlType,
        intensity: move.defaultIntensity,
        rig: state.rig,
        // Without this the generator has the shape of the move and no idea how
        // fast to travel it, which is half a description of a shot.
        duration_ms: state.durationMs > 0 ? state.durationMs : DEFAULT_MOVE_MS,
        path: path.map(k => ({
            t: +k.t.toFixed(4),
            position: k.position.map(v => +v.toFixed(4)),
            rotation: k.rotation.map(v => +v.toFixed(4)),
            focal_mm: +k.focalMm.toFixed(2),
        })),
    };
}

/**
 * Stored blocking → the flat facts a prompt can be written from.
 *
 * The two halves of previs speak different shapes. What is SAVED is geometry —
 * a camera position, a focal length, a sensor id — because that is what the
 * viewer draws and what "recreate this shot exactly" needs. What a PROMPT wants
 * is words: a framing, an angle, a distance. Nothing converted between them, so
 * the prompt builder read `previs.focal_mm` off an object that only ever had
 * `previs.camera.focalMm`, found nothing, and silently described a shot by its
 * movement alone.
 *
 * Framing is DERIVED rather than stored, and that is the point: it is whatever
 * the lens actually covers at the distance the camera actually stands. A stored
 * label would go stale the moment someone dragged the camera, which in an
 * iterative loop is constantly.
 */
function previsFacets(blocking) {
    if (!blocking || typeof blocking !== 'object') return null;

    // Already flat (a caller passing facts directly, and every test that was
    // written against this shape before the geometry existed).
    if (blocking.focal_mm !== undefined || blocking.shot_type !== undefined
        || blocking.distance_m !== undefined || blocking.camera_height_m !== undefined) {
        return { ...blocking };
    }

    const camera = blocking.camera || {};
    const focalMm = Number(camera.focalMm);
    const position = Array.isArray(camera.position) ? camera.position : null;

    const facets = {};
    if (blocking.movement) facets.movement = blocking.movement;
    if (Array.isArray(blocking.cameraKeys) && blocking.cameraKeys.length > 1) {
        const named = analyzePath(blocking.path && blocking.path.length ? blocking.path : blocking.cameraKeys);
        facets.movement = named.dominantMovement;
        facets.movement_description = named.description;
    }
    // A sequence, when one was blocked. Kept as the leg list rather than
    // flattened here, so the prompt can say "closer, then panning right" and
    // the video payload can still send the sampled path.
    if (Array.isArray(blocking.moves) && blocking.moves.length > 1) {
        facets.moves = blocking.moves.map(m => m && m.movement).filter(Boolean);
    }
    if (Number.isFinite(focalMm) && focalMm > 0) facets.focal_mm = focalMm;
    if (camera.sensorId || camera.sensor) facets.sensor = camera.sensorId || camera.sensor;
    if (Number(camera.fStop) > 0) facets.aperture = Number(camera.fStop);
    if (Number(camera.focusDistanceM) > 0) facets.focus_distance_m = Number(camera.focusDistanceM);
    if (position && Number.isFinite(Number(position[1]))) facets.camera_height_m = Number(position[1]);

    const target = resolveTarget(blocking);
    if (position && target && Array.isArray(target.position)) {
        const dx = Number(position[0]) - Number(target.position[0]);
        const dy = Number(position[1]) - Number(target.position[1]);
        const dz = Number(position[2]) - Number(target.position[2]);
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (Number.isFinite(distance) && distance > 0) facets.distance_m = distance;
    }

    // Invert the framing out of the optics. `subjectHeightM` on each framing IS
    // the vertical coverage it means, so the nearest one is the honest name for
    // what this camera sees.
    if (facets.distance_m && facets.focal_mm) {
        const sensor = sensorFor(camera.sensorId || camera.sensor);
        const coverage = frameCoverage(facets.distance_m, facets.focal_mm, sensor);
        if (coverage && Number.isFinite(coverage.heightM)) {
            facets.coverage_height_m = coverage.heightM;
            let best = null;
            for (const [id, def] of Object.entries(SHOT_TYPES)) {
                if (def.axis !== 'framing' || !Number.isFinite(def.subjectHeightM)) continue;
                const delta = Math.abs(def.subjectHeightM - coverage.heightM);
                if (!best || delta < best.delta) best = { id, delta };
            }
            if (best) facets.shot_type = best.id;
        }
    }

    return Object.keys(facets).length ? facets : null;
}


/**
 * What a shot's camera actually IS, once the stage has had its say.
 *
 * Precedence is staged → written → what the production shoots on, merged PER
 * FACET: blocking wins wherever it has an opinion and the card fills the rest.
 * Swapping the whole group looks equivalent and is not — stored blocking knows
 * its movement long before it can derive a framing, so an all-or-nothing swap
 * on a merely-staged shot dropped the card's framing AND lens and described the
 * shot by its movement alone.
 *
 * It exists as a function because there were about to be two of them: the
 * prompt builder had the rule inline, and the board needed to SHOW the same
 * answer. Two copies of a precedence rule is how a board comes to display the
 * facets that generation is not going to use.
 *
 * `source` is returned alongside every value because that is the thing a
 * director cannot otherwise see: a lens reading 50mm means something different
 * when it came from the stage than when it is the film's default.
 */
function effectiveCamera(cardCamera, previs, filmOptics, opts) {
    const card = cardCamera || {};
    const film = filmOptics || {};
    const usable = (opts && opts.framingIsUsable) || (() => true);
    const facets = previsFacets(previs) || {};

    const blockedFraming = facets.shot_type || facets.framing;
    const shotType = (blockedFraming && usable(blockedFraming))
        ? { value: blockedFraming, source: 'blocking' }
        : (card.shot_type ? { value: card.shot_type, source: 'card' } : { value: null, source: null });

    const blockedFocal = Number(facets.focal_mm);
    let lens;
    if (Number.isFinite(blockedFocal) && blockedFocal > 0) {
        lens = { value: `${Math.round(blockedFocal)}mm`, source: 'blocking' };
    } else if (card.lens) {
        lens = { value: card.lens, source: 'card' };
    } else if (Number(film.focalMm) > 0) {
        lens = { value: `${Math.round(Number(film.focalMm))}mm`, source: 'film' };
    } else {
        lens = { value: null, source: null };
    }

    const movement = facets.movement
        ? { value: facets.movement, source: 'blocking' }
        : (card.movement ? { value: card.movement, source: 'card' } : { value: null, source: null });

    const stagedOrCard = (staged, written, filmValue) => {
        if (staged !== undefined && staged !== null && staged !== '') return { value: staged, source: 'blocking' };
        if (written !== undefined && written !== null && written !== '') return { value: written, source: 'card' };
        if (filmValue !== undefined && filmValue !== null && filmValue !== '') return { value: filmValue, source: 'film' };
        return { value: null, source: null };
    };

    return {
        shot_type: shotType,
        lens,
        movement,
        sensor: stagedOrCard(facets.sensor, card.sensor, film.sensorId),
        aperture: stagedOrCard(facets.aperture, card.aperture, film.fStop),
        focus_distance_m: stagedOrCard(facets.focus_distance_m, card.focus_distance_m, null),
        // Blocking-only measurements. A card has never held either, so there is
        // nothing to merge them against.
        distance_m: Number.isFinite(Number(facets.distance_m)) ? Number(facets.distance_m) : null,
        camera_height_m: Number.isFinite(Number(facets.camera_height_m)) ? Number(facets.camera_height_m) : null,
        blocked: Object.keys(facets).length > 0,
    };
}

module.exports = {
    RIGS, MOVEMENTS, SHOT_TYPES, SENSORS,
    DEFAULT_EYE_HEIGHT_M, DEFAULT_SUBJECT_HEIGHT_M,
    defaultBlocking, cardOptics, solveShot, samplePath, sampleSequence, sampleCameraKeys, normalizeCameraKeys,
    yawVector,
    shortestAngleDeltaDegrees, analyzePath, moveAmount, resolveTarget,
    rigCanPerform, toCameraControl, legTimings, movePace, groupLegs, DEFAULT_MOVE_MS,
    poseAt, EASINGS, HOLD, easeT,
    previsFacets,
    effectiveCamera,
};
