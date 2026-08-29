/**
 * ── Seeing the move, over the frame you already have ─────────────────────────
 *
 * Previs could decide a camera move in six degrees of freedom, sample it,
 * approve it, write it onto the card and hand it to a video provider. What it
 * could never do was SHOW you the move against the picture the shot actually
 * has. Playback held the storyboard still, dead centre, for its slot — so
 * "push in over the cul-de-sac" and "locked off on the cul-de-sac" played
 * identically, and the only way to find out whether a move worked was to buy
 * the clip.
 *
 * This turns a camera move into a transform over that still. It is the same
 * geometry the previs camera pane already does when it stands the generated
 * frame in the world: the picture is treated as a WINDOW ONTO THE SCENE, so a
 * pan translates the way the world does behind a real pan, rather than
 * keystoning the way a photograph does when you turn past it. That is the
 * choice worth stating, because the alternative is defensible and wrong for
 * this job: previs answers "how does this shot read", and a real pan does not
 * keystone the world.
 *
 * WHAT IT CANNOT DO, said once rather than discovered: a still holds no
 * parallax. Move the camera laterally and the near and far planes travel
 * together, because there is only one plane. The subject comes out right and
 * the background does not — the same stated limit the previs plate quad
 * carries, and the reason this is an animatic rather than a render.
 *
 * Every number below is derived from the film's OWN optics
 * (lib/previs-camera.js), never from a feel-good constant: how far a 30° pan
 * travels across the frame is a fact about the lens, so the same move on a
 * 24mm and an 85mm produces different pictures — which is exactly the thing a
 * director is trying to see.
 */

const {
    MOVEMENTS, SENSORS,
    samplePath, defaultBlocking, solveShot, resolveTarget, moveAmount,
    shortestAngleDeltaDegrees, yawVector, easeT, effectiveCamera,
    DEFAULT_SUBJECT_HEIGHT_M,
} = require('./previs-blocking');
const { sensorFor, fieldOfView, frameCoverage, framingDistance } = require('./previs-camera');

/** How many samples a generated track carries. Matches previs's own sampling. */
const TRACK_FRAMES = 24;

/*
 * How much push-in a move may cost before it stops being honest.
 *
 * A move that travels needs somewhere to travel FROM: to pan across a still you
 * must first push into it, or the frame runs off the edge of the picture. At
 * 2.0 the shot is playing on half the width it was generated at, which is
 * already soft; past that the animatic stops resembling the shot and starts
 * resembling a crop of it. It is a REPORTING threshold, never a refusal — a
 * director asking to see a 90° whip pan over one still is asking a fair
 * question, and the useful answer is "here it is, and here is why it looks
 * like that", not a disabled button.
 */
const CROP_LIMIT = 2.0;

/*
 * Below this the move does not read. Two per cent of the frame over a whole
 * shot is under half a pixel per frame at 24fps on a 1080 frame — a number, not
 * a taste.
 */
const PERCEPTIBLE = 0.02;

/*
 * The framing the movement registry's own amounts were written for.
 *
 * Derived from defaultBlocking rather than typed, so it cannot drift from the
 * stage those numbers describe.
 */
const REFERENCE_DISTANCE_M = (() => {
    const b = defaultBlocking();
    return Math.max(0.2, b.camera.position[2] - b.subject.position[2]);
})();

/**
 * How far a movement WORD travels at this framing.
 *
 * A word on a card is a proportional intent, not a dolly track measured in
 * metres — "push in on the wide" means the frame tightens, and 0.6m means
 * nothing until you know how far away the subject is. Held at the registry's
 * amount, 1A's push-in came out at 1.2% of the frame on a 26-metre
 * establishing wide (invisible, and reported as such) while the same word on a
 * close-up sent the camera straight through the subject.
 *
 * So a metre amount is scaled by the framing distance, against the distance the
 * registry's own numbers were written for. Rotations are NOT scaled: thirty
 * degrees is thirty degrees at any distance, and the unit says which is which
 * rather than a list here saying it again.
 *
 * Previs is untouched. An amount someone TYPED is metres and stays metres —
 * this is only what an unqualified word means.
 */
function wordAmount(movement, distanceM) {
    const move = MOVEMENTS[movement];
    if (!move || move.unit !== 'm') return undefined;
    return moveAmount(movement) * (Math.max(0.2, distanceM) / REFERENCE_DISTANCE_M);
}

const IDENTITY = { scale: 1, x: 0, y: 0, rotate: 0 };

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const vec3 = v => (Array.isArray(v) && v.length === 3 && v.every(c => Number.isFinite(Number(c)))
    ? v.map(Number) : null);

/** Where a camera at this rotation is looking. +pitch is up; +yaw turns left. */
function aimVector(rotation) {
    const [yaw, pitch] = rotation;
    const p = (Number(pitch) || 0) * Math.PI / 180;
    return yawVector([0, Math.sin(p), -Math.cos(p)], Number(yaw) || 0);
}

/**
 * One pose against the pose the still was taken from, in screen units.
 *
 * Units are FRACTIONS OF THE ORIGINAL FRAME: x = 0.25 means the picture moves
 * a quarter of a frame width to the right. Scale is about the frame centre.
 * The composition order is fixed here and mirrored in the page — scale first,
 * then translate — because a transform assembled in the other order puts every
 * mark in a different place on a move that both scales and travels.
 *
 * The signs all follow one rule: THE PICTURE MOVES OPPOSITE THE CAMERA. Pan
 * left and what was centre swings right; crane up and it drops. That rule is
 * what keeps the seen move agreeing with the word the provider is told, and
 * every one of them is asserted from film language rather than from whichever
 * way the axes happened to point.
 */
function screenAt(anchor, pose, optics) {
    const sensor = optics && optics.sensor ? optics.sensor : sensorFor('super35');
    const focal0 = num(anchor && anchor.focalMm) || 50;
    const fov = fieldOfView(focal0, sensor);

    // The distance the still is "about". Everything on the subject plane comes
    // out right; everything else is the parallax this cannot carry.
    const distance = Math.max(0.2, num(optics && optics.distanceM) || 3);
    const cover = frameCoverage(distance, focal0, sensor);

    const rotA = vec3(anchor && anchor.rotation) || [0, 0, 0];
    const rotB = vec3(pose && pose.rotation) || rotA;
    const posA = vec3(anchor && anchor.position) || [0, 0, 0];
    const posB = vec3(pose && pose.position) || posA;

    const dYaw = shortestAngleDeltaDegrees(rotA[0], rotB[0]);
    const dPitch = shortestAngleDeltaDegrees(rotA[1], rotB[1]);
    const dRoll = shortestAngleDeltaDegrees(rotA[2], rotB[2]);

    // World travel expressed from the operator's position, exactly as
    // analyzePath names it — the same helper, so the move that is SEEN and the
    // move that is NAMED for the provider cannot come from two different
    // rotations of the same vector.
    const local = yawVector(posB.map((v, i) => v - posA[i]), -rotA[0]);

    // Rotation: a pan of one whole field of view moves the picture one whole
    // frame. Nothing here is a tuned constant — swap the lens and it changes.
    let x = fov.hDeg > 0 ? dYaw / fov.hDeg : 0;
    let y = fov.vDeg > 0 ? dPitch / fov.vDeg : 0;

    // Travel: a truck of one frame-width moves the picture one whole frame.
    if (cover.widthM > 0) x -= local[0] / cover.widthM;
    if (cover.heightM > 0) y += local[1] / cover.heightM;

    /*
     * Dolly is perspective, not translation: closing half the distance doubles
     * the subject. Measured as the REAL distance to what the shot is framing,
     * not as travel along the camera's own Z — an orbit displaces the camera
     * several metres "forward" in its starting frame while staying exactly as
     * far from the subject, and reading that as a dolly doubled the subject on
     * a move that never approached it.
     */
    const aim = aimVector(rotA);
    const target = posA.map((v, i) => v + aim[i] * distance);
    const d0 = Math.max(0.2, Math.hypot(...posA.map((v, i) => v - target[i])));
    const d1 = Math.max(0.2, Math.hypot(...posB.map((v, i) => v - target[i])));
    let scale = d0 / d1;

    // A zoom is the lens doing it instead, and the two compound on set.
    const focalT = num(pose && pose.focalMm);
    if (focalT && focal0 > 0) scale *= focalT / focal0;

    return { scale, x, y, rotate: -dRoll };
}

/**
 * How far the still must be pushed in so no edge of it ever shows.
 *
 * Conservative on the rotation term by construction: it is better to crop a
 * little more than needed than to expose the black beyond the picture, which
 * reads as the feature being broken rather than as a limit being reached.
 */
function cropFor(keys, aspect) {
    const a = num(aspect) > 0 ? Number(aspect) : 16 / 9;
    const wide = Math.max(a, 1 / a);
    let crop = 1;
    for (const k of keys) {
        const s = Math.max(1e-6, k.scale);
        const rad = Math.abs(k.rotate) * Math.PI / 180;
        const rotCover = Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)) * wide;
        crop = Math.max(crop,
            (1 + 2 * Math.abs(k.x)) / s,
            (1 + 2 * Math.abs(k.y)) / s,
            rotCover / s);
    }
    return crop;
}

/**
 * The card's optics, read once.
 *
 * A shot that was never blocked — which on a real board is most of them — still
 * names a lens, a sensor and a movement, and those are what the move has to be
 * computed from. The reading itself lives in previs-blocking beside the
 * registries it validates against, so previs's own from-card seed and this
 * cannot come to disagree about what "40mm anamorphic" means.
 */
function cardStage(card, filmOptics) {
    const { cardOptics } = require('./previs-blocking');
    const optics = cardOptics((card && card.camera) || {}, filmOptics || {});
    const sensor = sensorFor(optics.sensorId);
    const subject = { position: [0, 0, 0], heightM: DEFAULT_SUBJECT_HEIGHT_M };
    const solution = solveShot({
        shotType: optics.shotType, focalMm: optics.focalMm, sensor, subject,
    });
    return {
        blocking: defaultBlocking({
            camera: {
                position: [solution.position[0], optics.heightM, solution.position[2]],
                rotation: solution.rotation,
                focalMm: optics.focalMm,
                sensorId: optics.sensorId,
                fStop: optics.fStop,
                focusDistanceM: solution.distanceM,
            },
            subject,
            rig: solution.rig,
        }),
        distanceM: solution.distanceM,
        sensor,
    };
}

/**
 * How far away the plane this shot is framing sits — measured ALONG THE AIM.
 *
 * Not the straight-line distance: previs's own plate quad learned this once,
 * because a straight line puts the plane behind the subject the moment the
 * camera tilts, and a figure's stored position is its feet on the floor while
 * the camera is at eye height.
 */
function stagedDistance(previs) {
    const cam = vec3(previs && previs.camera && previs.camera.position);
    const rot = vec3(previs && previs.camera && previs.camera.rotation) || [0, 0, 0];
    if (!cam) return null;
    const target = resolveTarget(previs);
    const at = vec3(target && target.position);
    if (!at) return null;
    const aim = aimVector(rot);
    const along = at.reduce((sum, v, i) => sum + (v - cam[i]) * aim[i], 0);
    return along > 0.2 ? along : null;
}

/**
 * The move this shot plays, and what it costs to show it over a still.
 *
 * Precedence is the one that already exists — STAGED, then WRITTEN, then
 * nothing. A shot blocked in previs plays the path that was actually approved;
 * a shot with only a movement word on its card plays that word, sampled through
 * previs's own sampler rather than a second one; a shot that says nothing holds
 * exactly as it does today. Consulting effectiveCamera rather than restating
 * the rule is what stops playback showing a move generation is not going to
 * make.
 */
function motionTrack(input) {
    const opts = input || {};
    const card = opts.card || {};
    const previs = opts.previs || null;
    const frames = Math.max(2, Number(opts.frames) || TRACK_FRAMES);
    const aspect = num(opts.aspect) > 0 ? Number(opts.aspect) : 16 / 9;
    const durationMs = Math.max(0, Number(opts.durationMs) || 0);

    const eff = effectiveCamera(card.camera || {}, previs, opts.filmOptics || {});
    const movement = (eff.movement && eff.movement.value) || 'static';
    const source = (eff.movement && eff.movement.source) || null;

    const still = (why, extra) => ({
        movement: 'static',
        source: source || null,
        keys: [{ t: 0, ...IDENTITY }],
        duration_ms: durationMs,
        crop: 1,
        magnification: 1,
        shown_percent: 100,
        carried: true,
        perceptible: true,
        reach: 0,
        note: null,
        why: why || null,
        ...(extra || {}),
    });

    // A stored path is what the director approved on the stage, sampled with
    // its own easing already baked in. Re-deriving it from the movement WORD
    // would silently discard a hand-flown camera and every compound leg.
    const stored = Array.isArray(previs && previs.path) ? previs.path : [];
    let poses = null;
    let anchor = null;
    let sensor = null;
    let distanceM = null;
    let from = null;

    if (stored.length >= 2) {
        poses = stored.map((p, i) => ({
            t: Number.isFinite(Number(p.t)) ? Number(p.t) : i / (stored.length - 1),
            position: vec3(p.position) || [0, 0, 0],
            rotation: vec3(p.rotation) || [0, 0, 0],
            focalMm: num(p.focalMm) || num(previs.camera && previs.camera.focalMm) || 50,
        }));
        anchor = poses[0];
        sensor = sensorFor(SENSORS[previs.camera && previs.camera.sensorId]
            ? previs.camera.sensorId : 'super35');
        distanceM = stagedDistance(previs)
            || framingDistance(DEFAULT_SUBJECT_HEIGHT_M, anchor.focalMm, sensor);
        from = 'path';
    } else if (MOVEMENTS[movement] && movement !== 'static') {
        const stage = cardStage(card, opts.filmOptics);
        // Sampled through previs's own sampler, so the eighteen movements
        // cannot mean one thing on the stage and another in playback.
        const raw = samplePath(movement, stage.blocking,
            { frames, amount: wordAmount(movement, stage.distanceM) });
        /*
         * Eased, because we generated it.
         *
         * A move that starts and stops instantly has no dropped frames and is
         * mechanical in every other sense — previs learned that once already
         * and gave its legs an ease. A STORED path is deliberately left alone:
         * its easing is baked in, and applying a second one would flatten the
         * shape of a move a director shaped by hand.
         */
        poses = [];
        for (let i = 0; i < frames; i++) {
            const t = i / (frames - 1);
            const u = easeT('ease-in-out', t);
            let n = 0;
            while (n < raw.length - 2 && raw[n + 1].t < u) n++;
            const a = raw[n], b = raw[n + 1] || raw[n];
            const span = b.t - a.t;
            const f = span > 0 ? Math.max(0, Math.min(1, (u - a.t) / span)) : 0;
            const mix = (p, q) => p + (q - p) * f;
            poses.push({
                t,
                position: a.position.map((v, ax) => mix(v, b.position[ax])),
                rotation: a.rotation.map((v, ax) => v + shortestAngleDeltaDegrees(v, b.rotation[ax]) * f),
                focalMm: mix(a.focalMm, b.focalMm),
            });
        }
        anchor = poses[0];
        sensor = stage.sensor;
        distanceM = stage.distanceM;
        from = 'card';
    } else {
        return still(movement === 'static' ? null : `'${movement}' is not a movement this engine knows`);
    }

    const keys = poses.map(p => ({ t: p.t, ...screenAt(anchor, p, { sensor, distanceM }) }));
    const crop = Math.ceil(cropFor(keys, aspect) * 1000) / 1000;

    /*
     * How tight the still is ever shown.
     *
     * The crop alone was the wrong measure. A pan needs the frame pushed in and
     * a dolly does not — but a dolly that closes most of the distance to the
     * subject enlarges the picture five times, which costs exactly as much
     * resolution as a five-times crop and reported as perfectly carried because
     * no edge was ever exposed. What a director is looking at is one number:
     * the largest magnification anywhere in the move.
     */
    const magnification = Math.max(...keys.map(k => crop * k.scale));
    const carried = magnification <= CROP_LIMIT;

    /*
     * Does this move actually READ?
     *
     * The registry's amounts are written for a subject a few metres away, and
     * a 0.3m push-in is a tenth of the frame on a medium and one per cent of it
     * on a 26-metre establishing wide. That is not a bug — it is what a 30cm
     * dolly does on a wide, and a director is better off knowing than watching
     * a "push-in" that never moves and concluding the feature is broken. So it
     * is reported with the number and the two ways out.
     */
    const reach = Math.max(...keys.map(k => Math.max(
        Math.abs(k.scale - 1), 2 * Math.abs(k.x), 2 * Math.abs(k.y), Math.abs(k.rotate) / 45)));
    const perceptible = reach >= PERCEPTIBLE;

    return {
        movement,
        source,
        from,
        keys,
        duration_ms: durationMs,
        distance_m: Math.round(distanceM * 100) / 100,
        focal_mm: Math.round((num(anchor.focalMm) || 50) * 10) / 10,
        sensor: sensor.id,
        crop,
        magnification: Math.round(magnification * 1000) / 1000,
        // What fraction of the width the frame was generated at is on screen at
        // the tightest point of the move.
        shown_percent: Math.round(100 / magnification),
        carried,
        perceptible,
        reach: Math.round(reach * 1000) / 1000,
        note: perceptible ? null
            : `this ${movement} changes the frame by ${(reach * 100).toFixed(1)}% at a framing distance of `
              + `${distanceM.toFixed(1)}m, which will not read. Set an amount on the shot, or block it in previs.`,
        why: carried ? null
            : `a ${movement} this large magnifies the frame ${magnification.toFixed(1)}x, so playback shows `
              + `${Math.round(100 / magnification)}% of the width the frame was generated at`
              + (crop > 1.05 ? ` (${crop.toFixed(1)}x of it is the push-in a travelling move needs to have room)` : '')
              + '. A still holds no parallax either — the background travels with the subject. '
              + 'Generate the clip to see it properly, or reduce the amount.',
    };
}

/**
 * The transform at a moment, 0..1 through the shot.
 *
 * Mirrored in the SPA, and held equal by test: the page cannot require a node
 * module (build.target: single-html), and two interpolations that must agree
 * and are maintained separately eventually do not — the one that loses is what
 * a director is looking at.
 */
function transformAt(track, t) {
    const keys = track && Array.isArray(track.keys) ? track.keys : [];
    if (!keys.length) return { ...IDENTITY };
    const u = Math.max(0, Math.min(1, Number(t) || 0));
    let i = 0;
    while (i < keys.length - 2 && Number(keys[i + 1].t) < u) i++;
    const a = keys[i];
    const b = keys[i + 1] || a;
    const span = Number(b.t) - Number(a.t);
    const f = span > 0 ? Math.max(0, Math.min(1, (u - Number(a.t)) / span)) : 0;
    const mix = (p, q) => Number(p) + (Number(q) - Number(p)) * f;
    const crop = Number(track && track.crop) > 0 ? Number(track.crop) : 1;
    return {
        scale: crop * mix(a.scale, b.scale),
        x: mix(a.x, b.x),
        y: mix(a.y, b.y),
        rotate: mix(a.rotate, b.rotate),
    };
}

/** Scale first, then translate — stated once, so the page cannot invert it. */
function cssTransform(at) {
    return `translate(${(at.x * 100).toFixed(4)}%, ${(at.y * 100).toFixed(4)}%) `
        + `rotate(${at.rotate.toFixed(4)}deg) scale(${at.scale.toFixed(5)})`;
}

/*
 * ── Reading a shot ──────────────────────────────────────────────────────────
 *
 * The database handle is required lazily rather than threaded through every
 * call site, on the rule lib/scene-score.js already follows: this is read by
 * the timeline, by the shot route and by the MCP tool, and passing a handle
 * through all three to fetch one blocking row is how two of them end up
 * reading it differently.
 */

function parseJson(text, fallback) {
    try { const v = JSON.parse(text); return v === null ? fallback : v; } catch (_) { return fallback; }
}

/**
 * A film_previs_blocking row in the shape motionTrack reads.
 *
 * One reading, used by the per-shot loader AND by the timeline's bulk pass.
 * They were written separately and the second silently omitted nothing at
 * first — which is exactly the state in which one of them later loses the
 * stored path and demotes every blocked shot to its card's word, with the
 * precedence still consulted so nothing looks wrong.
 */
function rowToBlocking(row) {
    if (!row) return null;
    return {
        camera: parseJson(row.camera_json, {}),
        subject: parseJson(row.subject_json, {}),
        subjects: parseJson(row.subjects_json, []),
        stage: parseJson(row.stage_json, {}),
        rig: row.rig,
        movement: row.movement,
        path: parseJson(row.path_json, []),
        moves: parseJson(row.moves_json, []),
        duration_ms: row.duration_ms,
    };
}

/** The stored blocking for a shot. */
function blockingFor(db, shotId) {
    return rowToBlocking(db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId));
}

/** Everything about a project that is the same for every shot in it. */
function projectContext(db, projectId) {
    const { aspectValue } = require('./project-presets');
    const { filmOptics } = require('./look-development');
    let project = null;
    try {
        project = db.prepare('SELECT aspect_ratio FROM film_projects WHERE id = ?').get(projectId);
    } catch (_) { /* an unreadable project still gets a default frame */ }
    return {
        aspect: aspectValue(project && project.aspect_ratio, 16 / 9),
        filmOptics: filmOptics(db, projectId),
    };
}

/**
 * The move one shot plays. Free — it reads rows and does arithmetic.
 */
function loadShotMotion(shotId, opts) {
    const { db } = require('../db/database');
    const shot = db.prepare(`
        SELECT s.id, s.shot_code, s.scene_card_yaml, s.duration_ms, sc.project_id
        FROM film_shots s JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE s.id = ?`).get(shotId);
    if (!shot) return null;

    const ctx = projectContext(db, shot.project_id);
    const card = parseJson(shot.scene_card_yaml, {}) || {};
    const track = motionTrack({
        card,
        previs: blockingFor(db, shotId),
        filmOptics: ctx.filmOptics,
        aspect: ctx.aspect,
        durationMs: Number((opts && opts.durationMs) || shot.duration_ms) || 0,
    });
    return { shot_id: shot.id, shot_code: shot.shot_code, ...track };
}

/**
 * A track per timeline entry, in one pass.
 *
 * Attached only where it can be used — a clip already contains its own move,
 * and putting a track on one invites a second move being applied over the top
 * of the one that was generated.
 */
function attachTracks(db, projectId, timeline) {
    if (!timeline || !Array.isArray(timeline.entries)) return timeline;
    const ctx = projectContext(db, projectId);

    const cards = new Map();
    for (const row of db.prepare(`
        SELECT s.id, s.scene_card_yaml FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id WHERE sc.project_id = ?`).all(projectId)) {
        cards.set(row.id, parseJson(row.scene_card_yaml, {}) || {});
    }
    const blocking = new Map();
    try {
        for (const row of db.prepare(`
            SELECT b.* FROM film_previs_blocking b
            JOIN film_shots s ON s.id = b.shot_id
            JOIN film_scenes sc ON sc.id = s.scene_id WHERE sc.project_id = ?`).all(projectId)) {
            blocking.set(row.shot_id, rowToBlocking(row));
        }
    } catch (_) { /* a project with no stage is a project of unblocked shots */ }

    /*
     * The shape of the delivered frame, so the player can make the still's own
     * box the FRAME rather than the stage. A translate measured against a
     * letterboxed element travels the wrong distance, and drags the black bars
     * into shot while it does it.
     */
    timeline.aspect = ctx.aspect;

    for (const entry of timeline.entries) {
        if (entry.kind !== 'still') continue;
        entry.motion = motionTrack({
            card: cards.get(entry.shot_id) || {},
            previs: blocking.get(entry.shot_id) || null,
            filmOptics: ctx.filmOptics,
            aspect: ctx.aspect,
            durationMs: entry.duration_ms,
        });
    }
    return timeline;
}

module.exports = {
    TRACK_FRAMES, CROP_LIMIT, PERCEPTIBLE, REFERENCE_DISTANCE_M, wordAmount,
    screenAt, aimVector, cropFor, cardStage, stagedDistance,
    motionTrack, transformAt, cssTransform,
    rowToBlocking, blockingFor, loadShotMotion, attachTracks,
};
