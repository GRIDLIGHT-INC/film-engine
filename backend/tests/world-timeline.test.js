/**
 * World Engine — Phase 4 (MVP 4): the camera move.
 *
 * Implements test-spec §6, WE-4.1 through WE-4.6.
 *
 * THE POINT OF THIS PHASE IS THAT ALMOST NOTHING IS NEW. `previs-blocking`
 * already samples compound moves, composes concurrent legs, interpolates a pose
 * at any moment and stores authored keys in degrees. What was missing is a
 * surface. So the assertions here are mostly about the timeline driving THAT
 * model rather than growing a second one — two answers to "what move does this
 * shot have" is the failure this codebase keeps paying for.
 *
 * `hold` is the one genuinely new thing, and it is deliberately NOT a curve:
 * EASINGS is the set of ways a value can travel between two poses, and holding
 * is the absence of travel. A parity test already pins the page's curve set to
 * the library's four, and adding a fifth that is not a curve would break the
 * one guarantee that keeps the preview and the stored path describing the same
 * move.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pb = require('../lib/previs-blocking');
const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

/** Extract one page function by brace depth — never a character window. */
function fn(name) {
    const at = UI.indexOf(`function ${name}(`);
    assert.notStrictEqual(at, -1, `${name} is not in the page`);
    let depth = 0;
    for (let i = UI.indexOf('{', at); i < UI.length; i++) {
        if (UI[i] === '{') depth++;
        else if (UI[i] === '}' && --depth === 0) return UI.slice(at, i + 1);
    }
    throw new Error(`${name} does not close`);
}

function build(names, call, preamble) {
    return new Function(`${preamble || ''}\n${names.map(fn).join('\n')}\nreturn (${call});`)();
}

const BLOCKING = {
    camera: { position: [0, 1.6, 8], rotation: [0, 0, 0], focalMm: 35, sensorId: 'super35' },
    subject: { position: [0, 0, 0], heightM: 1.7 },
    stage: { widthM: 12, depthM: 12 },
    rig: 'dolly',
};

// ══ WE-4.1 · easings ════════════════════════════════════════════════════════

test('WE-4.1 every easing plus hold is offered, and each changes the move', () => {
    const offered = build(['worldEases'], 'worldEases()');
    const want = [...Object.keys(pb.EASINGS), 'hold'];

    assert.deepStrictEqual(offered.map(e => e.id).sort(), want.sort(),
        `the timeline offers ${offered.map(e => e.id).join(',')} — the model has ${want.join(',')}`);
    for (const e of offered) assert.ok(e.label, `${e.id} has no label`);

    /*
     * Each must actually change the sampled path. An easing chip that is
     * selectable and reaches nothing is the "capability with no control"
     * failure pointed the other way — a control with no capability.
     */
    const paths = {};
    for (const id of Object.keys(pb.EASINGS)) {
        paths[id] = pb.samplePath('dolly-in', BLOCKING, { frames: 8, ease: id });
    }
    const mid = (p) => p[4].position[2];
    assert.notStrictEqual(mid(paths['ease-in']), mid(paths['ease-out']),
        'ease-in and ease-out produce the same path — the easing reaches nothing');
    assert.notStrictEqual(mid(paths.linear), mid(paths['ease-in-out']));
});

test('WE-4.1b hold is the ABSENCE of travel, not a curve', () => {
    /*
     * EASINGS is the set of ways a value travels between two poses; holding is
     * not one of them. Keeping it out is what lets previs-routes go on pinning
     * the page's curve set to the library's four — the guarantee that stops the
     * preview and the stored path describing different moves.
     */
    assert.ok(!Object.keys(pb.EASINGS).includes('hold'),
        'hold was added to EASINGS — it is not a curve, and the viewer/library parity pin now fails');

    for (const t of [0, 0.25, 0.5, 0.9, 1]) {
        assert.strictEqual(pb.easeT('hold', t), 0, `hold advanced to ${pb.easeT('hold', t)} at t=${t}`);
    }
    // A held leg does not move the camera at all.
    const held = pb.samplePath('dolly-in', BLOCKING, { frames: 6, ease: 'hold' });
    const z = held.map(k => k.position[2]);
    assert.ok(z.every(v => Math.abs(v - z[0]) < 1e-9), `a held leg moved: ${z.join(', ')}`);

    // And an UNKNOWN easing still falls back to linear rather than holding —
    // silently freezing a move would be worse than ignoring the typo.
    assert.ok(pb.easeT('not-an-easing', 0.5) > 0, 'an unknown easing now freezes the camera');
});

test('WE-4.1c a lane shows only the legs that affect it', () => {
    /*
     * Both lanes rendered every leg, so ROTATION announced "DOLLY IN" — a
     * translation. The panel stated something false about the move, which is
     * worse than an empty lane. Derived from the movement taxonomy the server
     * serves, so a movement added later lands correctly with nothing to
     * remember.
     */
    const html = build(['worldTimelineHtml', 'worldEases'], 'worldTimelineHtml()',
        'const PREVIS = { taxonomy: { movements: '
        + JSON.stringify({
            'dolly-in':  { translate: [0, 0, -2], rotate: [0, 0, 0], focalScale: 1, space: 'camera' },
            'pan-right': { translate: [0, 0, 0], rotate: [-30, 0, 0], focalScale: 1, space: 'camera' },
        }) + ' } };\n'
        + 'const WORLD = { moves: [{ movement: "dolly-in", weight: 1 }], keys: [], t: 0, '
        + 'ease: "ease-out", durationMs: 4000 };\n'
        + 'const esc = (v) => String(v == null ? "" : v);');

    const pos = html.slice(html.indexOf('POSITION'), html.indexOf('ROTATION'));
    const rot = html.slice(html.indexOf('ROTATION'));
    assert.match(pos, /DOLLY IN/, 'the position lane lost its dolly');
    assert.ok(!/DOLLY IN/.test(rot),
        'the ROTATION lane announces a translation — the panel is stating something false');
    assert.match(rot, /HOLD/, 'a lane with nothing in it does not say so');
});

// ══ WE-4.2 · one model, not two ═════════════════════════════════════════════

test('WE-4.2 the timeline writes the existing columns and creates no second store', () => {
    const save = fn('worldTimelineSave');
    for (const col of ['moves_json', 'camera_keys_json']) {
        assert.ok(save.includes(col) || save.includes('previs'),
            `the timeline does not write ${col} — where is the move stored?`);
    }
    /*
     * Derived over the migrations: no table has appeared for camera moves. The
     * model is film_previs_blocking, and a second one would be two answers to
     * "what move does this shot have".
     */
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const schema = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
    const rogue = [...schema.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w*(?:camera_move|timeline|keyframe)\w*)/gi)]
        .map(m => m[1]);
    assert.deepStrictEqual(rogue, [], `a second move store exists: ${rogue.join(', ')}`);
});

// ══ WE-4.3 · authored keys ══════════════════════════════════════════════════

test('WE-4.3 authored keys round-trip, and rotations stay in degrees', () => {
    const keys = [
        { t: 0,   position: [0, 1.6, 8], rotation: [0, 0, 0],   focalMm: 35, rotationUnit: 'degrees' },
        { t: 0.5, position: [0, 1.2, 5], rotation: [12, -4, 0], focalMm: 50, rotationUnit: 'degrees' },
        { t: 1,   position: [0, 0.4, 2], rotation: [30, -9, 3], focalMm: 85, rotationUnit: 'degrees' },
    ];
    const back = pb.normalizeCameraKeys(keys);
    assert.strictEqual(back.length, 3);
    for (let i = 0; i < keys.length; i++) {
        assert.deepStrictEqual(back[i].position, keys[i].position, `key ${i} moved`);
        assert.deepStrictEqual(back[i].rotation, keys[i].rotation,
            `key ${i} rotation changed — a radian/degree confusion silently rewrites every authored move`);
        assert.strictEqual(back[i].rotationUnit, 'degrees',
            `key ${i} does not declare its unit, so a reader has to guess`);
        assert.strictEqual(back[i].focalMm, keys[i].focalMm);
    }

    // Radians on the wire are converted, not stored as-is.
    const rad = pb.normalizeCameraKeys([{ t: 0, position: [0, 0, 0], rotation: [Math.PI / 2, 0, 0], rotationUnit: 'radians' }]);
    assert.ok(Math.abs(rad[0].rotation[0] - 90) < 1e-6,
        `radians were not converted on the way in: stored ${rad[0].rotation[0]}`);
    assert.strictEqual(rad[0].rotationUnit, 'degrees', 'the stored unit is not degrees');
});

// ══ WE-4.4 · the path ═══════════════════════════════════════════════════════

test('WE-4.4 the path is drawn, and a keyframe click seeks', () => {
    const draw = fn('worldDrawPath');
    assert.match(draw, /moveTo|lineTo|arc\(/, 'the path renderer draws nothing');
    assert.match(draw, /keys|path/, 'the path renderer reads no keys');

    const seek = fn('worldSeekTo');
    assert.match(seek, /playhead|WORLD\.t\b/, 'seeking does not move the playhead');

    // The marker has to be clickable, or the path is a picture.
    const html = build(['worldTimelineHtml', 'worldEases'], 'worldTimelineHtml()',
        'const PREVIS = { taxonomy: null };\n'
        + 'const WORLD = { moves: [{ movement: "dolly-in", weight: 1 }], '
        + 'keys: [{ t: 0, position: [0,1.6,8] }, { t: 1, position: [0,0.4,2] }], '
        + 't: 0, ease: "ease-out", durationMs: 4000 };\n'
        + 'const esc = (v) => String(v == null ? "" : v);');
    assert.match(html, /worldSeekTo\(/, 'nothing on the timeline seeks');
});

// ══ WE-4.5 · playback ═══════════════════════════════════════════════════════

test('WE-4.5 the move plays interpolated, not snapped to keys', () => {
    /*
     * The bug previsPose already records: rounding to the nearest key made a
     * 24-key path repainted at 60fps move 24 times and stand still between.
     * How densely a path was sampled is a storage decision and must not be
     * visible in the shot.
     */
    const path4 = pb.samplePath('dolly-in', BLOCKING, { frames: 3 });
    const a = pb.poseAt(path4, 0.25);
    const b = pb.poseAt(path4, 0.30);
    assert.notDeepStrictEqual(a.position, b.position,
        'two moments between the same pair of keys gave the identical pose — playback is snapping');

    // The endpoints are exact.
    assert.deepStrictEqual(pb.poseAt(path4, 0).position, path4[0].position);
    assert.deepStrictEqual(pb.poseAt(path4, 1).position, path4[path4.length - 1].position);

    const play = fn('worldPlayMove');
    assert.match(play, /requestAnimationFrame|poseAt|worldSeekTo/, 'play does not animate anything');

    /*
     * And it must STOP rather than stall when the tab is hidden.
     * requestAnimationFrame does not fire in a background tab, so switching
     * away mid-move left `playing` true forever — and the next press of Play
     * read as the toggle and turned it off. Measured in a real browser:
     * visibilityState "hidden", zero frames, playhead frozen at 0%.
     */
    assert.match(play, /document\.hidden/,
        'playback stalls in a hidden tab and cannot be restarted with one press');
});

// ══ WE-4.6 · concurrent legs ════════════════════════════════════════════════

test('WE-4.6 concurrent legs compose deltas rather than chaining', () => {
    /*
     * Chaining would zoom a camera that had already moved, which is a different
     * shot. previs-blocking composes; this pins that the timeline's own legs go
     * through the same path and do not re-implement it.
     */
    const legs = [
        { movement: 'dolly-in', amount: 2, weight: 1 },
        { movement: 'pan-right', amount: 20, weight: 1, with: true },
    ];
    const together = pb.sampleSequence(legs, BLOCKING, { frames: 12 });
    const dollyOnly = pb.sampleSequence([legs[0]], BLOCKING, { frames: 12 });
    const panOnly = pb.sampleSequence([legs[1]], BLOCKING, { frames: 12 });

    const end = together[together.length - 1];
    // Both axes moved in the SAME time slice — the mark of composition.
    assert.ok(Math.abs(end.position[2] - dollyOnly[dollyOnly.length - 1].position[2]) < 0.5,
        'the concurrent dolly did not travel its full distance — the legs were chained');
    assert.ok(Math.abs(end.rotation[0] - panOnly[panOnly.length - 1].rotation[0]) < 1,
        'the concurrent pan did not complete — the legs were chained');

    // And the page uses the library rather than its own sampler.
    const save = fn('worldTimelineSave');
    assert.ok(!/function\s+worldSampleLeg|worldComposeGroup/.test(UI),
        'the timeline re-implements leg sampling — a second answer to what the move is');
    assert.ok(save.length > 40, 'the save is a stub');
});
