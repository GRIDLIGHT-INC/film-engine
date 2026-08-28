/**
 * A turnaround from ONE orbit, not three separate generations.
 *
 * "The 360 Video Character Trick" (Theoretically Media, "The 'Secret' to AI
 * Character Sheets", chapter 04:07): generate a short clip that orbits the
 * character, then take the frames as the character sheet.
 *
 * It is better here for a reason that is structural rather than stylistic. A
 * three-view turnaround today is THREE INDEPENDENT generations — front, side
 * and back, each a fresh roll of the dice — so they can disagree about the
 * face, the wardrobe and the build, and this codebase has already paid for
 * that: the newest row was the BACK view, and it was the picture attached to
 * every frame the character appeared in.
 *
 * Frames of one continuous motion cannot disagree with each other. And it is
 * cheaper: a 5-second Gen-4 Turbo orbit is 25 credits, against three image
 * generations at about 15 credits each.
 *
 * Set-based over the views the orbit yields, because the failure would be
 * partial — an orbit that produces a good front and a mislabelled back is
 * exactly the state the old path was already in.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const orbit = require('../lib/character-orbit');
const { VIEW_RANK } = require('../lib/plate-views');

test('the views an orbit yields are the vocabulary plates already use', () => {
    assert.ok(Array.isArray(orbit.ORBIT_VIEWS) && orbit.ORBIT_VIEWS.length >= 3,
        `an orbit should yield several views, got ${orbit.ORBIT_VIEWS && orbit.ORBIT_VIEWS.length}`);
    for (const v of orbit.ORBIT_VIEWS) {
        assert.ok(Object.prototype.hasOwnProperty.call(VIEW_RANK, v.view),
            `"${v.view}" is not a view plate selection knows about — headlinePlate would not rank it`);
    }
});

test('front is at the start, because that is the frame identity is judged on', () => {
    const first = orbit.ORBIT_VIEWS[0];
    assert.strictEqual(first.view, 'front');
    assert.strictEqual(first.degrees, 0,
        'the orbit must BEGIN on the front: it is seeded from the approved front plate, '
        + 'and it is the view that attaches to every shot');
});

test('every view sits at the angle its name claims', () => {
    const expected = { front: 0, 'three-quarter': 45, side: 90, back: 180 };
    for (const v of orbit.ORBIT_VIEWS) {
        if (expected[v.view] === undefined) continue;
        assert.strictEqual(v.degrees, expected[v.view],
            `${v.view} is planned at ${v.degrees}°, which is not what that word means`);
    }
});

test('the plan places each view at a real moment in the clip', () => {
    const plan = orbit.orbitPlan({ seconds: 5 });
    assert.strictEqual(plan.frames.length, orbit.ORBIT_VIEWS.length);
    let last = -1;
    for (const f of plan.frames) {
        assert.ok(f.atSeconds >= 0 && f.atSeconds <= 5, `${f.view} sampled at ${f.atSeconds}s of a 5s clip`);
        assert.ok(f.atSeconds > last, 'frames must advance through the clip, not repeat a moment');
        last = f.atSeconds;
        assert.ok(f.view, 'a sampled frame with no view is a picture nothing can select');
    }
    assert.strictEqual(plan.frames[0].atSeconds, 0, 'the front should be the first frame of the clip');
});

test('a longer clip spreads the same views further apart, not more views', () => {
    const short = orbit.orbitPlan({ seconds: 5 });
    const long = orbit.orbitPlan({ seconds: 10 });
    assert.strictEqual(long.frames.length, short.frames.length);
    assert.ok(long.frames[long.frames.length - 1].atSeconds > short.frames[short.frames.length - 1].atSeconds);
});

test('the orbit is cheaper than the turnaround it replaces, and says so', () => {
    const plan = orbit.orbitPlan({ seconds: 5 });
    assert.strictEqual(typeof plan.credits, 'number');
    assert.ok(plan.credits > 0);
    // three image generations at ~15 credits each is the thing being replaced
    assert.ok(plan.credits < 45,
        `an orbit costing ${plan.credits} credits is no cheaper than three separate plates`);
    assert.ok(plan.comparedTo && plan.comparedTo.credits >= 45,
        'the plan does not state what it is cheaper THAN, so the saving cannot be checked');
});

test('the prompt asks for an orbit, and refuses the things that ruin a plate', () => {
    const p = orbit.orbitPrompt({ name: 'MAYA', appearance_prompt: 'mid 30s, dark coat' }, 'photoreal');
    assert.match(p.prompt, /orbit|turntable|rotat/i, 'the motion is not described as an orbit');
    assert.match(p.prompt, /MAYA/, 'the subject is not named');
    // The camera moves; the SUBJECT must not, or the frames are different poses
    // rather than different angles.
    assert.match(p.prompt, /still|stationary|does not move|holds/i,
        'nothing tells the subject to hold still — a walking character gives you poses, not views');
    assert.match(String(p.negative_prompt || ''), /background|scene|room/i,
        'the plate isolation rule is not applied — a turnaround with a room in it '
        + 'drags that room into every frame the character appears in');
});

test('the orbit is seeded from the approved front plate when there is one', () => {
    const withPlate = orbit.orbitPrompt({ name: 'MAYA' }, '', { frontPlateUri: 'data:image/png;base64,AAA' });
    assert.strictEqual(withPlate.init_image, 'data:image/png;base64,AAA',
        'the orbit must start from the plate that was already approved, or it invents a new person');
    const without = orbit.orbitPrompt({ name: 'MAYA' }, '');
    assert.strictEqual(without.init_image, undefined);
});
