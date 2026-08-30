/**
 * A shot is a strip, not a still.
 *
 * "Generate a frame every second of film based on the camera direction... this
 * way we send up to 10 images for 10 seconds of film and we still fine-tune the
 * sequence before sending it to the video generator."
 *
 * The failure this guards is the one video-sequence.js already names one level
 * up: a move that is DESCRIBED rather than SHOWN comes back as a different
 * street each time. Densifying the station list is only worth anything if the
 * poses come from the blocking, so these tests pin the strip to shot-motion's
 * own geometry rather than to numbers typed here — a push-in must read as
 * closer, a pan must read in the direction screenAt puts it, and a move that
 * shot-motion says will not read must buy no pictures at all.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    stationCount, deltaInstruction, planStations, expandShots, MAX_STATIONS_PER_SHOT,
} = require('../lib/inbetweens');
const { motionTrack, transformAt } = require('../lib/shot-motion');

/** A track shaped as motionTrack returns one, so transformAt reads it. */
function track(keys, crop) {
    return { keys, crop: crop || 1 };
}
const STILL = track([{ t: 0, scale: 1, x: 0, y: 0, rotate: 0 },
                     { t: 1, scale: 1, x: 0, y: 0, rotate: 0 }]);
const PUSH = track([{ t: 0, scale: 1, x: 0, y: 0, rotate: 0 },
                    { t: 1, scale: 1.4, x: 0, y: 0, rotate: 0 }]);
const PAN = track([{ t: 0, scale: 1, x: 0, y: 0, rotate: 0 },
                   { t: 1, scale: 1, x: 0.5, y: 0, rotate: 0 }]);

const moving = (t, extra) => Object.assign({ track: t, perceptible: true, reach: 0.4, carried: true }, extra);

// ── 1. A move that will not read buys nothing ───────────────────────────

test('an imperceptible move yields one station and no generations', () => {
    const strip = planStations({ id: 's', shot_code: '1A', duration_ms: 8000 },
        { track: STILL, perceptible: false, reach: 0.001, carried: true });
    assert.equal(strip.count, 1);
    assert.equal(strip.generations, 0);
    assert.match(strip.reason, /no move that reads/);
});

test('no motion at all is treated the same way, not as an error', () => {
    const strip = planStations({ id: 's', shot_code: '1A', duration_ms: 5000 }, null);
    assert.equal(strip.count, 1);
    assert.equal(strip.generations, 0);
});

// ── 2. Cadence follows the clock, and the cap has the last word ─────────

test('one station per second, plus the one that closes the last interval', () => {
    const d = stationCount(5000, moving(PUSH), {});
    assert.equal(d.count, 6);
});

test('a shot longer than the cap is thinned, and says so', () => {
    const d = stationCount(600000, moving(PUSH), { maxStations: 4 });
    assert.equal(d.count, 4);
    assert.equal(d.thinned, true);
    assert.ok(d.wanted > 4);
    assert.match(d.reason, /exceed the 4/);
});

test('the per-shot ceiling applies even when the provider allows more', () => {
    const d = stationCount(600000, moving(PUSH), { maxStations: 999 });
    assert.ok(d.count <= MAX_STATIONS_PER_SHOT);
});

test('a move a still cannot carry earns MORE stations, not fewer', () => {
    const carried = stationCount(5000, moving(PUSH, { carried: true }), {});
    const not = stationCount(5000, moving(PUSH, { carried: false }), {});
    assert.ok(not.count > carried.count,
        'carried:false is the argument for real frames, not against them');
});

// ── 3. The words match the geometry ─────────────────────────────────────

test('a push-in reads as closer and larger', () => {
    const s = deltaInstruction({ scale: 1, x: 0, y: 0, rotate: 0 }, { scale: 1.2, x: 0, y: 0, rotate: 0 });
    assert.match(s, /closer/);
    assert.match(s, /larger/);
});

test('a pull-back reads as drawn back and smaller', () => {
    const s = deltaInstruction({ scale: 1.2, x: 0, y: 0, rotate: 0 }, { scale: 1, x: 0, y: 0, rotate: 0 });
    assert.match(s, /drawn back/);
    assert.match(s, /smaller/);
});

/*
 * The direction is shot-motion's, not a convention invented here: screenAt
 * computes x as +dYaw/fov.hDeg, so a positive yaw is a positive x. If that
 * convention ever changes, this fails rather than the strip quietly describing
 * every pan backwards.
 */
test('positive x is described as travelling right, matching screenAt', () => {
    const s = deltaInstruction({ scale: 1, x: 0, y: 0, rotate: 0 }, { scale: 1, x: 0.1, y: 0, rotate: 0 });
    assert.match(s, /right/);
    assert.doesNotMatch(s, /left/);
});

test('an unchanged pose produces no instruction at all', () => {
    assert.equal(deltaInstruction({ scale: 1, x: 0, y: 0, rotate: 0 }, { scale: 1, x: 0, y: 0, rotate: 0 }), null);
});

test('every instruction is one sentence, because a refine takes one change', () => {
    const s = deltaInstruction({ scale: 1, x: 0, y: 0, rotate: 0 }, { scale: 1.3, x: 0.2, y: 0.1, rotate: 3 });
    assert.equal(s.trim().split('. ').length, 1, s);
});

// ── 4. The strip is anchored to the approved frame ──────────────────────

test('station 0 is the keyframe, carries no instruction, and is refined from nothing', () => {
    const strip = planStations({ id: 's', shot_code: '1A', duration_ms: 4000 }, moving(PUSH));
    assert.equal(strip.stations[0].source, 'keyframe');
    assert.equal(strip.stations[0].instruction, null);
    assert.equal(strip.stations[0].refined_from, null);
});

test('every later station names the frame it is refined from, in order', () => {
    const strip = planStations({ id: 's', shot_code: '1A', duration_ms: 4000 }, moving(PUSH));
    strip.stations.slice(1).forEach((s, i) => {
        assert.equal(s.source, 'refine');
        assert.equal(s.refined_from, i, 'the chain must walk one frame at a time');
        assert.ok(s.instruction, 'a bought station must say what changed');
    });
});

test('stations are ordered in time and land inside the shot', () => {
    const strip = planStations({ id: 's', shot_code: '1A', duration_ms: 5000 }, moving(PUSH));
    const times = strip.stations.map(s => s.at_ms);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.equal(times[0], 0);
    assert.equal(times[times.length - 1], 5000);
});

test('the pose at each station is transformAt, not a re-derivation', () => {
    const strip = planStations({ id: 's', shot_code: '1A', duration_ms: 4000 }, moving(PUSH));
    for (const s of strip.stations) {
        const expected = transformAt(PUSH, s.t);
        assert.ok(Math.abs(expected.scale - s.transform.scale) < 1e-4,
            `station ${s.index} drifted from the sampled track`);
    }
});

test('generations is one fewer than stations — the first is already bought', () => {
    const strip = planStations({ id: 's', shot_code: '1A', duration_ms: 6000 }, moving(PAN));
    assert.equal(strip.generations, strip.count - 1);
});

// ── 5. What planSequence receives ───────────────────────────────────────

const SHOTS = [
    { id: 'a', shot_code: '1A', description: 'the empty street', duration_ms: 4000, keyframe: '/a.png' },
    { id: 'b', shot_code: '1B', description: 'she looks up', duration_ms: 3000, keyframe: '/b.png' },
];

test('stations carry the shape planSequence already consumes', () => {
    const out = expandShots(SHOTS, () => moving(PUSH), {});
    for (const s of out.stations) {
        for (const key of ['id', 'shot_code', 'description', 'duration_ms']) {
            assert.ok(key in s, `a station is missing ${key}, which planSequence reads`);
        }
    }
});

test('a shot with no move contributes exactly one station — today behaviour', () => {
    const out = expandShots(SHOTS, () => ({ track: STILL, perceptible: false, reach: 0 }), {});
    assert.equal(out.stations.length, 2);
    assert.equal(out.images_needed, 0);
    assert.equal(out.segments, 1, 'two shots is still one segment');
});

test('only station 0 arrives with a picture; the rest must be generated first', () => {
    const out = expandShots(SHOTS, () => moving(PUSH), {});
    const withFrames = out.stations.filter(s => s.keyframe);
    assert.equal(withFrames.length, 2, 'one approved frame per shot, and no more');
    assert.ok(out.stations.some(s => !s.keyframe),
        'ungenerated stations must be visible so planSequence can refuse on them');
});

test('play order is preserved across the flatten', () => {
    const out = expandShots(SHOTS, () => moving(PUSH), {});
    const order = out.stations.map(s => s.shot_id);
    assert.deepEqual(order, [...order].sort((x, y) => (x === 'a' ? -1 : 1) - (y === 'a' ? -1 : 1)));
    assert.equal(out.stations[0].shot_id, 'a');
    assert.equal(out.stations[out.stations.length - 1].shot_id, 'b');
});

test('segments is one fewer than stations, the rule video-sequence already holds', () => {
    const out = expandShots(SHOTS, () => moving(PUSH), {});
    assert.equal(out.segments, out.stations.length - 1);
});

test('images_needed counts only what must be bought', () => {
    const out = expandShots(SHOTS, () => moving(PUSH), {});
    const bought = out.stations.filter(s => s.station.source === 'refine').length;
    assert.equal(out.images_needed, bought);
});

// ── 6. The provider's cap, not one chosen here ──────────────────────────

test('a 30-image contract and a 9-image contract plan different strips', () => {
    const wide = expandShots(SHOTS, () => moving(PUSH), { maxStations: 12 });
    const narrow = expandShots(SHOTS, () => moving(PUSH), { maxStations: 2 });
    assert.ok(wide.images_needed > narrow.images_needed,
        'the ceiling is the provider\'s and must change the plan');
});

test('a thinned strip reports what it wanted', () => {
    const out = expandShots([{ ...SHOTS[0], duration_ms: 60000 }], () => moving(PUSH), { maxStations: 3 });
    assert.equal(out.strips[0].thinned, true);
    assert.ok(out.strips[0].wanted > 3);
});
