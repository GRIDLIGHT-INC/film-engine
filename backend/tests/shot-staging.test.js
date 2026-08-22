/**
 * Blocking reaches the prompt, and says the same thing the picture does.
 *
 * Previs could stage a scene in 3D and generation was blind to it: `previsFacets`
 * carried `objects` through untouched, and every phrase the prompt builder
 * emitted — framing, focal length, angle, movement, distance — was a fact about
 * the CAMERA. So a director could put the dragon in the near foreground with its
 * back to us and MAYA across the road facing camera, and the image prompt said
 * nothing about where either one was.
 *
 * The test that matters most here is not "does it produce words". It is whether
 * the words agree with the render. A mirrored `right` vector produces perfectly
 * fluent prose describing the opposite of what the director staged, and nothing
 * in a string test would catch it — so the lateral claim is checked against
 * `projectPoint`, the function that actually draws the previs frame.
 */

const test = require('node:test');
const assert = require('node:assert');

const { stagingFacts, stagingPhrase, forwardOf, LATERAL_BANDS, DEPTH_BANDS, FACING_BANDS }
    = require('../lib/shot-staging');
const { projectPoint } = require('../lib/previs-pick');
const { rotateOffset } = require('../lib/previs-primitives');

const VIEW = { x: 0, y: 0, w: 1000, h: 562 };

function previsWith(subjects, camera) {
    return {
        camera: Object.assign({ position: [0, 1.6, 0], sensor: 'super35', focal_mm: 35 }, camera || {}),
        target: { position: [0, 1.6, 12] },
        subjects,
    };
}

test('every kind used in this file is a real primitive', () => {
    // The seeder invented `figure` and `box`; these fixtures inherited the
    // same guess, and a test written in a vocabulary the code does not speak
    // passes while the feature is broken for every real object.
    const { PRIMITIVES } = require('../lib/previs-primitives');
    const used = [...require('fs').readFileSync(__filename, 'utf8')
        .matchAll(/kind: '(\w+)'/g)].map(m => m[1]);
    for (const k of new Set(used)) {
        assert.ok(PRIMITIVES[k], `this test stages kind '${k}', which is not a primitive`);
    }
});

test('a thing on the right of the render is described as frame right', () => {
    // The one failure that fluent prose cannot reveal. Checked over a spread of
    // positions rather than one, because a mirror is correct at dead centre.
    const cam = [0, 1.6, 0], aim = [0, 1.6, 12];
    for (const x of [-6, -3, -1, 1, 3, 6]) {
        const pos = [x, 0, 12];
        const p = projectPoint(pos, cam, aim, 35, VIEW, 1.78);
        const facts = stagingFacts(previsWith([{ kind: 'human', name: 'X', position: pos }]));
        assert.strictEqual(facts.said.length, 1, `nothing said for x=${x}`);
        const said = facts.said[0];

        const screenRight = p.x > VIEW.w / 2;
        const wordsSayRight = /frame right|right edge/.test(said.phrase);
        const wordsSayLeft = /frame left|left edge/.test(said.phrase);

        if (wordsSayRight || wordsSayLeft) {
            assert.strictEqual(wordsSayRight, screenRight,
                `world x=${x} projects to screen x=${Math.round(p.x)} of ${VIEW.w} `
                + `(${screenRight ? 'RIGHT' : 'LEFT'} half) but the prompt says "${said.phrase}" `
                + '— the words and the picture disagree, which is a mirrored basis');
        }
    }
});

test('frame_x agrees in sign with the projection, over every quadrant', () => {
    const cam = [2, 2.0, -3], aim = [1, 1.2, 9];
    const previs = {
        camera: { position: cam, sensor: 'super35', focal_mm: 50 },
        target: { position: aim },
        subjects: [],
    };
    for (const pos of [[5, 0, 6], [-5, 0, 6], [4, 0, 14], [-4, 0, 14], [0, 0, 20]]) {
        previs.subjects = [{ kind: 'human', name: 'X', position: pos }];
        const f = stagingFacts(previs).said[0];
        const p = projectPoint(pos, cam, aim, 50, VIEW, 1.78);
        const projSign = Math.sign(p.x - VIEW.w / 2);
        if (projSign === 0) continue;
        assert.strictEqual(Math.sign(f.frame_x), projSign,
            `frame_x ${f.frame_x} disagrees with projected screen x ${Math.round(p.x)} for ${pos}`);
    }
});

test('facing is read off the same rotation the renderer applies', () => {
    // A sign error on yaw reads as "facing camera" for something with its back
    // to us — the exact mistake 2B spent eleven attempts on. Derived from
    // rotateOffset rather than asserted from a convention written down twice.
    for (const yaw of [0, 45, 90, 135, 180, 225, 270]) {
        const fromModule = forwardOf([yaw, 0, 0]);
        const fromRenderer = rotateOffset([0, 0, 1], [yaw, 0, 0]);
        for (let i = 0; i < 3; i++) {
            assert.ok(Math.abs(fromModule[i] - fromRenderer[i]) < 1e-9,
                `forward at yaw ${yaw} disagrees with rotateOffset on axis ${i}`);
        }
    }
});

test('a figure turned away has its back to camera, one facing us does not', () => {
    // Camera at origin looking down +Z. A figure at +Z with yaw 180 has its
    // forward pointing back at the camera.
    const toward = stagingFacts(previsWith([
        { kind: 'human', name: 'MAYA', position: [0, 0, 12], rotationDeg: [180, 0, 0] }])).said[0];
    assert.strictEqual(toward.facing, 'facing camera', toward.phrase);

    const away = stagingFacts(previsWith([
        { kind: 'human', name: 'DRAGON', position: [0, 0, 12], rotationDeg: [0, 0, 0] }])).said[0];
    assert.strictEqual(away.facing, 'facing away from camera', away.phrase);
});

test('an unnamed object is reported unsaid, never described', () => {
    // Describing a nameless proxy would put a literal box in the frame — worse
    // than silence. Reported rather than dropped, because a director who staged
    // five things and sees three needs to know which two were scaffolding.
    const facts = stagingFacts(previsWith([
        { kind: 'cube', position: [1, 0, 8] },
        { kind: 'human', name: 'MAYA', position: [0, 0, 12] },
    ]));
    assert.strictEqual(facts.said.length, 1);
    assert.strictEqual(facts.unsaid.length, 1);
    assert.match(facts.unsaid[0].reason, /no name/);
    assert.ok(!/cube|box/i.test(stagingPhrase(previsWith([{ kind: 'cube', position: [1, 0, 8] }])) || ''),
        'an unnamed box reached the prompt');
});

test('something behind the camera is staged but not shown', () => {
    const facts = stagingFacts(previsWith([
        { kind: 'human', name: 'GHOST', position: [0, 0, -8] }]));
    assert.strictEqual(facts.said.length, 0);
    assert.match(facts.unsaid[0].reason, /behind the camera/);
});

test('nothing staged says nothing at all', () => {
    // null, not '' — a caller appending emptiness leaves a dangling separator
    // in a prompt already fighting for room.
    assert.strictEqual(stagingPhrase(null), null);
    assert.strictEqual(stagingPhrase(previsWith([])), null);
    assert.strictEqual(stagingPhrase(previsWith([{ kind: 'cube', position: [0, 0, 5] }])), null);
});

test('nearest to camera is said first', () => {
    const facts = stagingFacts(previsWith([
        { kind: 'human', name: 'FAR', position: [0, 0, 20] },
        { kind: 'human', name: 'NEAR', position: [1, 0, 4] },
    ]));
    assert.deepStrictEqual(facts.said.map(f => f.name), ['NEAR', 'FAR'],
        'a model weights what it reads first, so what dominates the frame leads');
});

test('the same blocking read from a new camera says something different', () => {
    // The point of the feature: blocking did not change, what the shot SHOWS
    // did. If moving the camera left the prose identical, it would be world
    // coordinates wearing frame language.
    const subjects = [{ kind: 'human', name: 'MAYA', position: [3, 0, 12], rotationDeg: [180, 0, 0] }];
    const front = stagingPhrase(previsWith(subjects));
    const other = stagingPhrase({
        camera: { position: [0, 1.6, 24], sensor: 'super35', focal_mm: 35 },
        target: { position: [0, 1.6, 12] },
        subjects,
    });
    assert.notStrictEqual(front, other,
        'the camera moved to the far side and the staging description did not change');
});

test('every band table is total — no gap can produce an undefined phrase', () => {
    // Set-based over the three tables, because a value falling through any of
    // them yields `undefined` inside a template literal and ships the string
    // "undefined" to an image model.
    for (const [name, bands, probes] of [
        ['lateral', LATERAL_BANDS, [-99, -1.5, -1, -0.4, -0.33, 0, 0.33, 0.9, 1, 99]],
        ['depth', DEPTH_BANDS, [0, 0.1, 0.45, 0.8, 1.25, 2.5, 999]],
        ['facing', FACING_BANDS, [0, 45, 90, 115, 180]],
    ]) {
        for (const v of probes) {
            const hit = bands.find(b => v <= b.max);
            assert.ok(hit && typeof hit.phrase === 'string' && hit.phrase.length,
                `${name} band table has no phrase for ${v}`);
        }
    }
});

test('staging never throws, whatever the blocking looks like', () => {
    // By the time a prompt is assembled the director is committed to the shot.
    // An enhancement that can fail the whole generation is worse than one that
    // is absent — the rule stampAsset already documents, and the defect this
    // caught for real: the blocking stores `sensorId`, a hand-built context may
    // say `sensor`, and sensorFor THROWS on an unknown one.
    const malformed = [
        null, undefined, {}, { camera: {} }, { camera: { position: 'nope' } },
        { camera: { position: [0, 0, 0] } },
        { camera: { position: [0, 0, 0], sensor: 'no-such-sensor' }, subjects: [{ kind: 'human', name: 'A', position: [0, 0, 5] }] },
        { camera: { position: [0, 0, 0], sensorId: 'no-such-sensor' }, subjects: [{ kind: 'human', name: 'A', position: [0, 0, 5] }] },
        { camera: { position: [0, 0, 0], focal_mm: 0 }, subjects: [{ kind: 'human', name: 'A', position: [0, 0, 5] }] },
        { camera: { position: [0, 0, 0] }, subjects: [{ name: 'A' }] },
        { camera: { position: [0, 0, 0] }, subjects: [null, 3, 'x'] },
        { camera: { position: [0, 0, 0] }, subjects: [{ kind: 'human', name: 'A', position: [0, 0, 0] }] }, // at the camera
        { camera: { position: [0, 5, 0] }, target: { position: [0, 0, 0] }, subjects: [{ kind: 'human', name: 'A', position: [1, 0, 0] }] }, // straight down
    ];
    for (const previs of malformed) {
        assert.doesNotThrow(() => stagingFacts(previs), `stagingFacts threw on ${JSON.stringify(previs)}`);
        assert.doesNotThrow(() => stagingPhrase(previs), `stagingPhrase threw on ${JSON.stringify(previs)}`);
        const p = stagingPhrase(previs);
        assert.ok(p === null || (typeof p === 'string' && !/undefined|NaN/.test(p)),
            `staging emitted "${p}" — "undefined" or "NaN" would be sent verbatim to an image model`);
    }
});
