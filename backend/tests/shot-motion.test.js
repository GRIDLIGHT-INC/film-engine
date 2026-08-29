/**
 * A move you can only read about
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Previs could decide a camera move and playback held the storyboard frame
 * dead still for its slot, so "push in over the cul-de-sac" and "locked off"
 * played identically. These hold the conversion from a camera move to a
 * transform over that frame.
 *
 * Set-based over MOVEMENTS rather than over the handful of moves anyone
 * remembers: the failure here is PARTIAL by nature — a dolly is a scale and a
 * pan is a translate, so a conversion that handles one perfectly can do nothing
 * at all for the other, and a test written against push-in passes in exactly
 * that state.
 *
 * The sign assertions are written in FILM LANGUAGE — "pan left and what was
 * centre swings right" — never in axis language. Which way +yaw points is a
 * convention this codebase can change; which way a pan reads is not, and a test
 * that agrees with the code's own axes cannot catch a mirrored camera.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const motion = require('../lib/shot-motion');
const { MOVEMENTS, cardOptics, samplePath, defaultBlocking } = require('../lib/previs-blocking');
const { sensorFor } = require('../lib/previs-camera');

const SRC = path.join(__dirname, '..', '..', 'src', 'index.html');
const PREVIS_ROUTE = path.join(__dirname, '..', 'routes', 'previs.js');

const card = (movement, extra) => ({
    camera: { lens: '40mm', shot_type: 'medium', movement, ...(extra || {}) },
});
const track = (movement, extra, opts) =>
    motion.motionTrack({ card: card(movement, extra), durationMs: 4000, aspect: 16 / 9, ...(opts || {}) });
const endOf = t => motion.transformAt(t, 1);

// ── 1. Every movement in the registry, not the ones anyone remembers ────────

test('every movement in the registry produces a track', () => {
    const names = Object.keys(MOVEMENTS);
    assert.ok(names.length >= 18, `expected the full movement registry, got ${names.length}`);
    for (const name of names) {
        const t = track(name);
        assert.equal(t.movement, name, `${name}: track does not report the movement it was asked for`);
        assert.ok(Array.isArray(t.keys) && t.keys.length >= 1, `${name}: no keys`);
        for (const k of t.keys) {
            for (const field of ['t', 'scale', 'x', 'y', 'rotate']) {
                assert.ok(Number.isFinite(k[field]),
                    `${name}: key.${field} is ${k[field]} — a NaN reaches the page as a dead transform`);
            }
        }
        assert.ok(t.keys[0].t === 0, `${name}: track does not start at t=0`);
    }
});

test('every non-static movement actually moves the picture', () => {
    const moving = Object.keys(MOVEMENTS).filter(m => m !== 'static');
    const dead = moving.filter(name => {
        const t = track(name);
        return t.keys.every(k => Math.abs(k.scale - 1) < 1e-6
            && Math.abs(k.x) < 1e-6 && Math.abs(k.y) < 1e-6 && Math.abs(k.rotate) < 1e-6);
    });
    assert.deepEqual(dead, [],
        `these movements convert to a frozen frame, which is indistinguishable from the feature being off: ${dead}`);
});

// ── 2. The picture moves OPPOSITE the camera ────────────────────────────────

test('the picture moves opposite the camera, for every axis', () => {
    // Stated as a director would state it, so a mirrored axis fails here rather
    // than agreeing with itself.
    const cases = [
        ['pan-left', e => e.x > 0.05, 'pan left and what was centre swings right'],
        ['pan-right', e => e.x < -0.05, 'pan right and what was centre swings left'],
        ['tilt-up', e => e.y > 0.05, 'tilt up and what was centre drops'],
        ['tilt-down', e => e.y < -0.05, 'tilt down and what was centre rises'],
        ['crane-up', e => e.y > 0.05, 'crane up and the subject drops in frame'],
        ['crane-down', e => e.y < -0.05, 'crane down and the subject rises in frame'],
        ['tracking-right', e => e.x < -0.05, 'truck right and the subject slides left'],
        ['tracking-left', e => e.x > 0.05, 'truck left and the subject slides right'],
    ];
    for (const [move, ok, why] of cases) {
        const e = endOf(track(move));
        assert.ok(ok(e), `${move}: ${why} — got x=${e.x.toFixed(3)} y=${e.y.toFixed(3)}`);
    }
});

test('rolling the camera rolls the picture the other way', () => {
    /*
     * No movement in the registry rolls, so this axis reached the page
     * untested — and a free camera key or a dutch angle rolls. A mirrored roll
     * looks entirely plausible: the horizon tilts, just the wrong way.
     */
    const b = defaultBlocking();
    const path = [0, 0.5, 1].map(t => ({
        t, position: b.camera.position, focalMm: b.camera.focalMm,
        rotation: [0, 0, 15 * t],   // camera rolling clockwise
    }));
    const t = motion.motionTrack({
        card: {}, durationMs: 4000,
        previs: { ...b, subjects: [], movement: 'orbit', path },
    });
    assert.ok(endOf(t).rotate < -10,
        `roll the camera clockwise and the picture rolls anticlockwise; got ${endOf(t).rotate}`);
    assert.ok(t.crop > 1.05, 'a rolled frame shows its own corners unless it is pushed in');
});

test('closing on the subject enlarges it; backing off shrinks it', () => {
    for (const move of ['dolly-in', 'push-in', 'tracking-forward', 'zoom-in']) {
        const t = track(move);
        const a = motion.transformAt(t, 0), b = endOf(t);
        assert.ok(b.scale > a.scale * 1.001, `${move}: subject did not grow (${a.scale} -> ${b.scale})`);
    }
    for (const move of ['dolly-out', 'pull-out', 'tracking-back', 'zoom-out']) {
        const t = track(move);
        const a = motion.transformAt(t, 0), b = endOf(t);
        assert.ok(b.scale < a.scale * 0.999, `${move}: subject did not shrink (${a.scale} -> ${b.scale})`);
    }
});

test('an orbit is not read as a dolly', () => {
    /*
     * The first version measured the dolly from travel along the camera's own
     * Z. An orbit displaces the camera metres "forward" in its starting frame
     * while staying exactly as far from the subject, so a 63-degree swing
     * doubled the subject on a move that never approached it.
     */
    const t = track('orbit');
    const raw = t.keys.map(k => k.scale);
    for (const s of raw) {
        assert.ok(Math.abs(s - 1) < 0.05,
            `orbit changed subject size by ${((s - 1) * 100).toFixed(0)}% at constant radius`);
    }
});

// ── 3. Static is exactly what playback does today ───────────────────────────

test('a shot that names no movement holds exactly as it does now', () => {
    for (const t of [track('static'), motion.motionTrack({ card: {}, durationMs: 4000 })]) {
        assert.equal(t.movement, 'static');
        assert.equal(t.crop, 1, 'a static shot must not be cropped — it would reframe every board');
        for (const at of [0, 0.5, 1]) {
            assert.deepEqual(motion.transformAt(t, at), { scale: 1, x: 0, y: 0, rotate: 0 });
        }
    }
});

test('an unknown movement holds, and says why, rather than throwing', () => {
    const t = motion.motionTrack({ card: card('swoop-thing'), durationMs: 4000 });
    assert.equal(t.movement, 'static');
    assert.ok(/swoop-thing/.test(t.why || ''), 'the refusal must name the word it could not read');
});

// ── 4. The film's own optics decide the move ────────────────────────────────

test('the same pan on a different lens is a different move', () => {
    // Differential: this is the whole claim of deriving from previs-camera
    // rather than from a constant. A long lens covers less, so the same
    // 15 degrees travels further across the frame.
    const wide = endOf(track('pan-left', { lens: '24mm' }));
    const long = endOf(track('pan-left', { lens: '85mm' }));
    assert.ok(long.x > wide.x * 1.5,
        `85mm should travel much further than 24mm for one pan; got ${wide.x.toFixed(3)} vs ${long.x.toFixed(3)}`);
});

test('a movement WORD is a proportional intent, not a dolly track in metres', () => {
    /*
     * Held at the registry's literal 0.6m, 1A's push-in came out at 1.2% of the
     * frame on a 26-metre establishing wide — invisible — while the same word
     * on a close-up sent the camera a metre through a subject 0.96m away. A
     * word on a card names a move; metres only mean metres once someone has
     * said how far away the subject is.
     */
    const mag = st => track('push-in', { shot_type: st }).magnification;
    const [close, wide] = [mag('close-up'), mag('establishing')];
    assert.ok(Math.abs(close - wide) < 0.01,
        `the same written push-in reads differently at two framings: ${close} vs ${wide}`);
    assert.ok(close > 1.05, 'a written push-in that changes nothing is indistinguishable from static');

    // Rotations are not distance: thirty degrees is thirty degrees.
    assert.ok(Math.abs(track('pan-left', { shot_type: 'close-up' }).magnification
        - track('pan-left', { shot_type: 'establishing' }).magnification) < 0.01);
    assert.equal(motion.wordAmount('pan-left', 40), undefined,
        'a rotation was scaled by the framing distance');
    assert.ok(motion.wordAmount('dolly-in', motion.REFERENCE_DISTANCE_M * 2)
        > motion.wordAmount('dolly-in', motion.REFERENCE_DISTANCE_M) * 1.9);
});

test('metres someone actually blocked stay metres', () => {
    // The proportional reading applies to an unqualified word. A staged move is
    // a decision about a real camera on a real stage, and rescaling it would
    // overrule the director who typed the number.
    const at = distance => {
        const b = defaultBlocking({
            camera: { position: [0, 1.6, distance], rotation: [0, 0, 0], focalMm: 40, sensorId: 'super35', fStop: 2.8, focusDistanceM: distance },
            subject: { position: [0, 1.6, 0], heightM: 1.7 },
        });
        return motion.motionTrack({
            card: {}, durationMs: 4000,
            previs: { ...b, subjects: [], movement: 'dolly-in', path: samplePath('dolly-in', b, { frames: 8, amount: 1 }) },
        }).magnification;
    };
    assert.ok((at(3) - 1) > (at(25) - 1) * 3,
        `one metre must mean more at three metres than at twenty-five; got ${at(3).toFixed(3)} vs ${at(25).toFixed(3)}`);
});

// ── 5. Precedence: staged, then written, then nothing ───────────────────────

function blockedPath(movement) {
    const blocking = defaultBlocking();
    return {
        camera: blocking.camera,
        subject: blocking.subject,
        subjects: [],
        rig: blocking.rig,
        movement,
        path: samplePath(movement, blocking, { frames: 12 }),
    };
}

test('a blocked shot plays what was staged, not what the card says', () => {
    const staged = motion.motionTrack({
        card: card('pan-left'), previs: blockedPath('dolly-in'), durationMs: 4000,
    });
    assert.equal(staged.movement, 'dolly-in', 'the card outranked the stage');
    assert.equal(staged.source, 'blocking');
    assert.equal(staged.from, 'path', 'the stored path was discarded and re-derived from a word');
    assert.ok(Math.abs(endOf(staged).x) < 0.01, 'a staged dolly came out with the card\'s pan in it');
});

test('an unblocked shot plays what is written on its card', () => {
    const t = track('pan-left');
    assert.equal(t.source, 'card');
    assert.equal(t.from, 'card');
});

// ── 6. A stored path keeps its own shape ───────────────────────────────────

test('a stored path is not eased a second time', () => {
    /*
     * samplePath is linear; a generated track is eased because we generated it.
     * Easing a stored one flattens the shape of a move a director flew by hand.
     */
    /*
     * Measured on the CAMERA, not on the scale. A dolly at constant speed
     * produces a hyperbolic scale (d0/d), so asserting that the scale is linear
     * asserts that the camera is decelerating — which is the very thing an ease
     * does, and the assertion would then pass on the bug it was written for.
     * With no crop, distance travelled is recoverable as 1/scale.
     */
    const travelled = (t, at) => 1 - 1 / motion.transformAt(t, at).scale;

    const stored = motion.motionTrack({ card: {}, previs: blockedPath('dolly-in'), durationMs: 4000 });
    const total = travelled(stored, 1);
    for (const at of [0.25, 0.5, 0.75]) {
        assert.ok(Math.abs(travelled(stored, at) - total * at) < total * 0.03,
            `a stored linear dolly came back eased: at ${at} the camera has covered `
            + `${(travelled(stored, at) / total * 100).toFixed(0)}% of the move`);
    }

    const generated = track('dolly-in');
    const gTotal = travelled(generated, 1);
    assert.ok(travelled(generated, 0.25) < gTotal * 0.25 * 0.8,
        'a generated move starts instantly instead of easing in');
    assert.ok(Math.abs(travelled(generated, 0.5) - gTotal * 0.5) < gTotal * 0.03,
        'ease-in-out is symmetric: half the time is half the move');
});

// ── 7. The crop never exposes the edge of the picture ───────────────────────

test('no move ever shows past the edge of the still', () => {
    for (const name of Object.keys(MOVEMENTS)) {
        const t = track(name);
        for (const k of t.keys) {
            const covered = t.crop * k.scale;
            assert.ok(covered >= 1 + 2 * Math.abs(k.x) - 1e-6,
                `${name}: at t=${k.t.toFixed(2)} the frame runs off the side (${covered.toFixed(3)} < ${(1 + 2 * Math.abs(k.x)).toFixed(3)})`);
            assert.ok(covered >= 1 + 2 * Math.abs(k.y) - 1e-6,
                `${name}: at t=${k.t.toFixed(2)} the frame runs off the top`);
        }
    }
});

test('the crop is one framing for the whole shot, not a hidden zoom', () => {
    // A crop recomputed per key would subtly zoom as the camera pans — a move
    // the director never asked for, on top of the one they did.
    const t = track('pan-left');
    assert.equal(typeof t.crop, 'number');
    const scales = t.keys.map(k => k.scale);
    assert.ok(Math.max(...scales) - Math.min(...scales) < 0.01,
        'a pure pan changed the subject size');
});

// ── 8 & 9. What it cannot do, said out loud ────────────────────────────────

test('a move too big for a still says so, and says what to do', () => {
    const t = track('crane-up');
    assert.equal(t.carried, false, 'a 1.5m crane at 2m is far more than a still can carry');
    assert.ok(/crane-up/.test(t.why), 'the reason must name the movement');
    assert.ok(/parallax/i.test(t.why), 'the reason must name the limit a still actually has');
    assert.ok(/Generate the clip|reduce the amount/i.test(t.why), 'the reason must name a way out');

    const fine = track('dolly-in');
    assert.equal(fine.carried, true);
    assert.equal(fine.why, null, 'a move that fits must not carry a warning');
});

test('a move that will not read says so with the number', () => {
    // A 3cm dolly, deliberately blocked, on a subject twenty-five metres away.
    const b = defaultBlocking({
        camera: { position: [0, 1.6, 25], rotation: [0, 0, 0], focalMm: 40, sensorId: 'super35', fStop: 2.8, focusDistanceM: 25 },
        subject: { position: [0, 1.6, 0], heightM: 1.7 },
    });
    const t = motion.motionTrack({
        card: {}, durationMs: 4000,
        previs: { ...b, subjects: [], movement: 'dolly-in', path: samplePath('dolly-in', b, { frames: 8, amount: 0.03 }) },
    });
    assert.equal(t.perceptible, false);
    assert.ok(/will not read/.test(t.note || ''), 'an invisible move must be named, not silently played');
    assert.ok(/\d/.test(t.note), 'the note must carry the number, or it is not actionable');

    assert.equal(track('dolly-in').perceptible, true);
    assert.equal(track('dolly-in').note, null);
});

// ── 10 & 11. Evaluating the track ──────────────────────────────────────────

test('transformAt clamps, interpolates and carries the crop', () => {
    const t = track('dolly-in');
    assert.deepEqual(motion.transformAt(t, -5), motion.transformAt(t, 0));
    assert.deepEqual(motion.transformAt(t, 99), motion.transformAt(t, 1));
    const a = motion.transformAt(t, 0.30), b = motion.transformAt(t, 0.31);
    assert.ok(b.scale > a.scale, 'the track does not advance between keys');

    const cropped = track('pan-left');
    assert.ok(Math.abs(motion.transformAt(cropped, 0).scale - cropped.crop) < 1e-9,
        'the crop is not applied, so the move runs off the edge it was computed to avoid');
});

test('the transform is written scale-first, translate-second', () => {
    // CSS applies the rightmost function first. Our x and y are fractions of the
    // ORIGINAL frame, so translate must come before scale in the string or every
    // travelling move lands somewhere else on a shot that also scales.
    const css = motion.cssTransform({ scale: 1.5, x: 0.25, y: -0.1, rotate: 3 });
    assert.ok(css.indexOf('translate') < css.indexOf('scale'), css);
    assert.ok(/translate\(25\.0000%, -10\.0000%\)/.test(css), css);
    assert.ok(/scale\(1\.50000\)/.test(css), css);
});

// ── 12. One reading of the card ────────────────────────────────────────────

test('previs and playback read the card through one function', () => {
    const src = fs.readFileSync(PREVIS_ROUTE, 'utf8');
    assert.ok(/cardOptics\(/.test(src), 'the previs seed no longer uses the shared reading');
    // The parse it replaced, in the form it had. A second copy anywhere is how
    // a stage and a playhead come to disagree about what "40mm anamorphic" is.
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/replace\(\s*\/\[\^0-9\.\]\/g/.test(body),
        'routes/previs.js parses a lens itself again');
    assert.equal(cardOptics({ lens: '40mm anamorphic' }, {}).focalMm, 40);
    assert.equal(cardOptics({ lens: 'anamorphic' }, { focalMm: 32 }).focalMm, 32);
    assert.equal(cardOptics({}, {}).movement, 'static');
});

// ── 13. The page and the library evaluate the same track ───────────────────

test('the page evaluates a track exactly as the library does', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const fn = src.match(/function motionTransformAt\(track, t\) \{[\s\S]*?\n    \}/);
    assert.ok(fn, 'src/index.html has no motionTransformAt — playback cannot read a track');
    const css = src.match(/function motionCss\(at\) \{[\s\S]*?\n    \}/);
    assert.ok(css, 'src/index.html has no motionCss');

    // eslint-disable-next-line no-new-func
    const page = new Function(`${fn[0]}\n${css[0]}\nreturn { motionTransformAt, motionCss };`)();

    const samples = Object.keys(MOVEMENTS).map(m => track(m))
        .concat([motion.motionTrack({ card: {}, previs: blockedPath('pan-left'), durationMs: 3000 })]);
    for (const t of samples) {
        for (const at of [0, 0.13, 0.25, 0.5, 0.77, 1, 1.4, -0.2]) {
            const mine = motion.transformAt(t, at);
            const theirs = page.motionTransformAt(t, at);
            for (const f of ['scale', 'x', 'y', 'rotate']) {
                assert.ok(Math.abs(mine[f] - theirs[f]) < 1e-9,
                    `${t.movement} @${at}: page ${f} ${theirs[f]} != lib ${mine[f]}`);
            }
            assert.equal(page.motionCss(theirs), motion.cssTransform(mine),
                `${t.movement} @${at}: the page writes a different transform string`);
        }
    }
});

// ── 14. Previs and playback turn the same way ──────────────────────────────

test('the previs camera pane turns the way the library says it does', () => {
    /*
     * previsAim built its direction as [sin(yaw), .., -cos(yaw)] while
     * yawVector — which samplePath's orbit, analyzePath and solveShot's azimuth
     * all use — turns the other way. So pressing pan-left swung the previs
     * camera RIGHT while the provider was told pan-left, and a shot solved at
     * an azimuth pointed away from its own subject.
     */
    const src = fs.readFileSync(SRC, 'utf8');
    const aim = src.match(/function previsAim\(pose\) \{[\s\S]*?\n    \}/);
    assert.ok(aim, 'previsAim is gone — this test no longer covers what it was written for');

    // eslint-disable-next-line no-new-func
    const page = new Function(`const P_DEG = Math.PI / 180;\n${aim[0]}\nreturn previsAim;`)();
    for (const yaw of [-90, -30, -5, 0, 5, 30, 63, 90]) {
        for (const pitch of [-20, 0, 20]) {
            const to = page({ position: [0, 0, 0], rotation: [yaw, pitch, 0] });
            const want = motion.aimVector([yaw, pitch, 0]).map(v => v * 5);
            for (let i = 0; i < 3; i++) {
                assert.ok(Math.abs(to[i] - want[i]) < 1e-9,
                    `yaw ${yaw} pitch ${pitch}: previs looks [${to.map(v => v.toFixed(2))}], `
                    + `the library says [${want.map(v => v.toFixed(2))}]`);
            }
        }
    }
});

test('the loader reads the stored path, not just the movement column', () => {
    // A loader that returns the row without its path silently demotes every
    // blocked shot to its card's word — the stage is still consulted, so the
    // precedence test passes and the approved camera is quietly gone.
    const row = {
        shot_id: 'x', camera_json: JSON.stringify({ position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50, sensorId: 'super35' }),
        subject_json: '{"position":[0,0,0],"heightM":1.7}', subjects_json: '[]', stage_json: '{}',
        rig: 'dolly', movement: 'dolly-in', duration_ms: 4000, moves_json: '[]',
        path_json: JSON.stringify(samplePath('dolly-in', defaultBlocking(), { frames: 6 })),
    };
    const stub = { prepare: () => ({ get: () => row }) };
    const loaded = motion.blockingFor(stub, 'x');
    assert.equal(loaded.path.length, 6, 'the sampled path did not survive the read');
    // The timeline's bulk pass must not read the row a second way — the
    // per-shot loader and the player would then disagree about the same shot.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'shot-motion.js'), 'utf8');
    assert.equal((src.match(/path: parseJson\(row\.path_json/g) || []).length, 1,
        'film_previs_blocking is parsed in more than one place');
    assert.ok(/blocking\.set\(row\.shot_id, rowToBlocking\(row\)\)/.test(src),
        'the timeline pass does not go through the shared reading');
    assert.deepEqual(loaded.path[0].position, [0, 1.6, 3]);
    assert.equal(motion.blockingFor({ prepare: () => ({ get: () => undefined }) }, 'x'), null);
});

test('the framing plane is measured along the aim, not as a straight line', () => {
    /*
     * previs's own plate quad learned this: a figure's stored position is its
     * feet on the floor while the camera is at eye height, so the straight line
     * to it is longer than the distance to what is being framed — and on a
     * tilted camera it lands behind the subject entirely.
     */
    const level = motion.stagedDistance({
        camera: { position: [0, 1.6, 5], rotation: [0, 0, 0] },
        subject: { position: [0, 0, 0] }, subjects: [],
    });
    assert.ok(Math.abs(level - 5) < 1e-9,
        `a level camera 5m back frames a plane 5m away, not ${level} — that is the straight line to the floor`);

    // A camera up on a crane, still level: the plane it is FRAMING is five
    // metres ahead of it, while the straight line down to the subject's feet is
    // seven. Pointed at the subject the two agree, which is why a case where
    // they agree proves nothing.
    const high = motion.stagedDistance({
        camera: { position: [0, 5, 5], rotation: [0, 0, 0] },
        subject: { position: [0, 0, 0] }, subjects: [],
    });
    assert.ok(Math.abs(high - 5) < 1e-9 && Math.abs(high - Math.hypot(5, 5)) > 2,
        `a level camera frames the plane 5m ahead, not the ${Math.hypot(5, 5).toFixed(2)}m `
        + `straight line to the floor; got ${high}`);
});

// ── 15. It reaches the player ──────────────────────────────────────────────

test('playback applies the track to the still and can be turned off', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    assert.ok(/id="pbMotion"/.test(src), 'no control to turn the move off');
    const tick = src.match(/function pbApplyMotion\([\s\S]*?\n    \}/);
    assert.ok(tick, 'nothing applies a motion track to the still');
    assert.ok(/motionTransformAt/.test(tick[0]) && /motionCss/.test(tick[0]),
        'pbApplyMotion does not evaluate the track it was given');
    assert.ok(/pbStill/.test(tick[0]), 'pbApplyMotion does not touch the still');
    // Bound to something that runs every frame, not merely defined.
    const ticker = src.match(/function updatePlayhead\(\)[\s\S]*?\n    \}/);
    assert.ok(ticker && /pbApplyMotion\(/.test(ticker[0]),
        'pbApplyMotion is never called from the playhead — a defined function that nothing runs');
});

test('the player turns the move off, and never leaves one on the next shot', () => {
    /*
     * Executed rather than grepped. The checkbox EXISTING says nothing about
     * whether it is read, and a transform left on the element by the previous
     * shot crops the next one — both look exactly like a working page in the
     * source.
     */
    const src = fs.readFileSync(SRC, 'utf8');
    const grab = name => {
        const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n    \\}`));
        assert.ok(m, `src/index.html has no ${name}`);
        return m[0];
    };
    const body = ['motionTransformAt', 'motionCss', 'pbMovingTrack', 'pbApplyMotion'].map(grab).join('\n');

    const still = { style: { transform: '' }, classList: new Set() };
    still.classList.add = c => Set.prototype.add.call(still.classList, c);
    still.classList.remove = c => Set.prototype.delete.call(still.classList, c);
    still.classList.contains = c => Set.prototype.has.call(still.classList, c);
    const checkbox = { checked: true };
    let entry = null;
    const harness = new Function('document', 'pbEntry', 'pb', `${body}
        return { pbApplyMotion, pbMovingTrack };`)(
        { getElementById: id => (id === 'pbStill' ? still : id === 'pbMotion' ? checkbox : null) },
        () => entry, { localMs: 0 });

    const moving = track('pan-left');
    entry = { kind: 'still', duration_ms: 4000, motion: moving };
    harness.pbApplyMotion();
    assert.ok(/scale\(/.test(still.style.transform), 'a move on a still paints nothing');
    assert.ok(still.classList.contains('moving'));

    checkbox.checked = false;
    harness.pbApplyMotion();
    assert.equal(still.style.transform, '', 'turning the move off left it running');
    assert.equal(still.classList.contains('moving'), false);
    checkbox.checked = true;

    harness.pbApplyMotion();
    assert.ok(/scale\(/.test(still.style.transform));
    entry = { kind: 'still', duration_ms: 4000, motion: track('static') };
    harness.pbApplyMotion();
    assert.equal(still.style.transform, '',
        "the previous shot's crop was left on a shot that does not move");
    assert.equal(still.classList.contains('moving'), false);

    // A clip carries its own move; a second one must never be laid over it.
    entry = { kind: 'video', duration_ms: 4000, motion: moving };
    assert.equal(harness.pbMovingTrack(), null);
});

test('the timeline serves a motion track per entry', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'timeline.js'), 'utf8');
    assert.ok(/shot-motion/.test(route), 'the timeline never builds a track');
    assert.ok(/motion/.test(route));
    assert.ok(/film_previs_blocking/.test(route),
        'the timeline reads no blocking, so a staged move can never reach playback');
});
