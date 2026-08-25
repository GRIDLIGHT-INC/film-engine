const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runway = require('../lib/providers/runway');
const { planSequence } = require('../lib/video-sequence');

const OFFICIAL_IMAGE_TO_VIDEO = [
    'gen4.5', 'gen4_turbo', 'veo3.1', 'veo3.1_fast', 'happyhorse_1_0',
    'seedance2', 'seedance2_fast', 'seedance2_mini', 'gemini_omni_flash',
];

test('every currently documented Runway video model has an explicit safe policy', () => {
    assert.deepEqual(Object.keys(runway.RUNWAY_VIDEO_MODELS).sort(), OFFICIAL_IMAGE_TO_VIDEO.sort());
    for (const [id, policy] of Object.entries(runway.RUNWAY_VIDEO_MODELS)) {
        assert.equal(policy.endpoint, 'image_to_video', `${id}: wrong operation`);
        assert.ok(policy.duration && policy.duration.min > 0 && policy.duration.max >= policy.duration.min,
            `${id}: no duration policy`);
        assert.ok(Array.isArray(policy.ratios) && policy.ratios.length, `${id}: no ratio policy`);
        assert.ok(Number(policy.creditsPerSecond) > 0, `${id}: no cost policy`);
        assert.ok(policy.status && policy.source, `${id}: deprecation/evidence is unstated`);
    }
});

test('a Runway motion prompt translates an approved path instead of redescribing the frame', () => {
    const prompt = runway.buildRunwayMotionPrompt({
        prompt: 'MAYA wears a red coat in a blue-grey street under cinematic dusk lighting.',
        motion: { subject: 'MAYA runs toward the dragon', environment: 'rain blows left to right' },
        camera_control: {
            type: 'dolly-in',
            path: [
                { t: 0, position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50 },
                { t: .5, position: [0, 1.6, 1.5], rotation: [0, 20, 0], focalMm: 50 },
                { t: 1, position: [1, 1.6, 1], rotation: [0, 40, 0], focalMm: 50 },
            ],
        },
        duration_s: 6,
    });
    assert.match(prompt, /MAYA runs toward the dragon/i);
    assert.match(prompt, /rain blows left to right/i);
    assert.match(prompt, /doll|arc|pan|camera/i);
    assert.doesNotMatch(prompt, /wears a red coat|cinematic dusk/i,
        'image appearance was needlessly re-described beside an approved frame');
    assert.ok(prompt.length <= 1000);
});

test('the Runway request and preview share one sanitized outbound body and exact cost', () => {
    const payload = {
        prompt: 'image-oriented fallback', motion_prompt: 'MAYA turns, then the camera slowly pushes in.',
        model: 'gen4.5', duration_s: 5, width: 1920, height: 1080,
        init_image: 'data:image/png;base64,SECRET', camera_control: { type: 'dolly-in', path: [{ t: 0 }, { t: 1 }] },
    };
    const request = runway.buildVideoRequest(payload);
    const preview = runway.describeVideoRequest(payload);
    assert.equal(request.body.promptText, payload.motion_prompt);
    assert.equal(request.body.camera_control, undefined, 'custom coordinates leaked into the Runway schema');
    assert.deepEqual(preview.outbound, {
        ...request.body,
        promptImage: { kind: 'image', count: 1, positions: ['first'] },
    });
    assert.equal(preview.estimated_credits, 60);
    assert.equal(preview.estimated_usd, 0.60);
    assert.ok(preview.notes.some(n => /text/i.test(n) && /path/i.test(n)));
});

test('sequence legs use director timing and can be purchased one at a time', () => {
    const shots = [
        { id: 'a', shot_code: '3A', keyframe: 'a.png', duration_ms: 3000 },
        { id: 'b', shot_code: '3B', keyframe: 'b.png', duration_ms: 7000 },
        { id: 'c', shot_code: '3C', keyframe: 'c.png', duration_ms: 4000 },
    ];
    const plan = planSequence(shots, { maxKeyframes: 2, modelPolicy: runway.RUNWAY_VIDEO_MODELS['gen4.5'] });
    assert.deepEqual(plan.segments.map(s => s.duration_s), [3, 7]);
    assert.ok(plan.segments.every(s => Number(s.estimated_credits) > 0));

    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sequences.js'), 'utf8');
    assert.match(source, /segment_index/, 'the route can only buy the whole sequence unattended');
});

test('native multi-shot is a separate exact Runway recipe, not fake keyframe interpolation', () => {
    const built = runway.buildMultiShotRequest({
        mode: 'custom', ratio: '1280:720',
        shots: [
            { prompt: 'Wide shot: Maya sees the dragon.', duration: 3 },
            { prompt: 'Close-up: Maya decides to run.', duration: 3 },
            { prompt: 'Low angle: the dragon crosses overhead.', duration: 4 },
        ],
    });
    assert.match(built.url, /recipes\/multi_shot_video$/);
    assert.equal(built.body.version, '2026-06');
    assert.equal(built.body.mode, 'custom');
    assert.equal(built.body.duration, 10);
    assert.equal(built.body.shots.length, 3);
    assert.equal(built.estimatedCredits, 130);
});
