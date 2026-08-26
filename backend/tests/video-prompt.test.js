const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildVideoPrompt, calculateVideoParams, buildVideoPayload,
    CAMERA_CONTROL_MAP, DEFAULT_FPS, DEFAULT_GEN_FPS, DEFAULT_NUM_FRAMES,
    DEFAULT_WIDTH, DEFAULT_HEIGHT,
} = require('../lib/video-prompt');

describe('video-prompt', () => {
    const minCard = {
        shot_type: 'medium',
        camera: { movement: 'dolly-in' },
        lighting: { style: 'natural' },
        action: 'Character walks forward',
        duration_ms: 4000,
    };

    describe('CAMERA_CONTROL_MAP', () => {
        it('has entries for all common camera movements', () => {
            const movements = [
                'static', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down',
                'dolly-in', 'dolly-out', 'zoom-in', 'zoom-out',
                'crane-up', 'crane-down', 'orbit', 'push-in', 'pull-out',
            ];
            for (const m of movements) {
                assert.ok(CAMERA_CONTROL_MAP[m], `Missing camera control for ${m}`);
                assert.ok(CAMERA_CONTROL_MAP[m].type);
                assert.ok(typeof CAMERA_CONTROL_MAP[m].intensity === 'number');
            }
        });
    });

    describe('buildVideoPrompt', () => {
        it('returns prompt, negative_prompt, and camera_control', () => {
            const result = buildVideoPrompt(minCard, [], null, null);
            assert.ok(result.prompt);
            assert.ok(result.negative_prompt);
            assert.ok(result.camera_control);
        });

        it('maps camera movement to camera_control', () => {
            const result = buildVideoPrompt(minCard, [], null, null);
            assert.equal(result.camera_control.type, 'dolly-in');
            assert.equal(result.camera_control.intensity, 0.5);
        });

        it('defaults to static when no camera movement', () => {
            const card = { ...minCard, camera: {} };
            const result = buildVideoPrompt(card, [], null, null);
            assert.equal(result.camera_control.type, 'static');
            assert.equal(result.camera_control.intensity, 0.0);
        });

        it('defaults to static when camera is missing', () => {
            const card = { shot_type: 'wide', action: 'test' };
            const result = buildVideoPrompt(card, [], null, null);
            assert.equal(result.camera_control.type, 'static');
        });
    });

    describe('calculateVideoParams', () => {
        it('returns correct default parameters', () => {
            const params = calculateVideoParams(minCard);
            assert.equal(params.num_frames, DEFAULT_NUM_FRAMES);
            assert.equal(params.fps, DEFAULT_GEN_FPS);
            assert.equal(params.target_fps, DEFAULT_FPS);
            assert.equal(params.width, DEFAULT_WIDTH);
            assert.equal(params.height, DEFAULT_HEIGHT);
            assert.equal(params.duration_s, 4.0);
        });

        it('uses duration_ms from scene card', () => {
            const card = { duration_ms: 6000 };
            const params = calculateVideoParams(card);
            assert.equal(params.duration_s, 6.0);
        });

        it('defaults to 4s when no duration', () => {
            const params = calculateVideoParams({});
            assert.equal(params.duration_s, 4.0);
        });
    });

    describe('buildVideoPayload', () => {
        it('returns a full payload object', () => {
            const payload = buildVideoPayload(minCard, [], null, null);
            assert.ok(payload.prompt);
            assert.ok(payload.negative_prompt);
            // No model. This builder is shared by every provider, so any name
            // it emits is wrong for all but one of them — `animatediff-sdxl` is
            // Gridlight's, and it made every Runway preview report a
            // substitution for a request nobody made. The provider names its
            // own model now; an explicitly requested one still travels.
            assert.ok(!('model' in payload),
                `the shared payload named ${payload.model}, which only one provider can honour`);
            assert.equal(payload.width, DEFAULT_WIDTH);
            assert.equal(payload.height, DEFAULT_HEIGHT);
            assert.equal(payload.output_format, 'mp4');
            assert.ok(payload.camera_control);
            assert.ok(payload.interpolation);
            assert.equal(payload.interpolation.enabled, true);
            assert.equal(payload.interpolation.method, 'rife');
        });

        it('includes LoRA IDs from characters', () => {
            const chars = [
                { name: 'John', lora_id: 'john_lora' },
                { name: 'Jane', lora_id: 'jane_lora' },
                { name: 'Bob' },
            ];
            const payload = buildVideoPayload(minCard, chars, null, null);
            assert.equal(payload.lora_ids.length, 2);
            assert.ok(payload.lora_ids[0].includes('john_lora'));
        });

        it('respects options for seed and model', () => {
            const payload = buildVideoPayload(minCard, [], null, null, { seed: 42, model: 'custom-model' });
            assert.equal(payload.seed, 42);
            assert.equal(payload.model, 'custom-model');
        });

        it('includes init_image when provided', () => {
            const payload = buildVideoPayload(minCard, [], null, null, { init_image: 'base64data' });
            assert.equal(payload.init_image, 'base64data');
        });

        it('carries consistency references and prompt contracts', () => {
            const payload = buildVideoPayload(minCard, [], null, null, {
                prompt_additions: ['locked face and wardrobe'],
                negative_additions: ['different actor'],
                reference_images: [{ asset_id: 'asset-1', file_path: '/ref.png', weight: 0.8 }],
                input_refs: ['asset-1'],
            });
            assert.match(payload.prompt, /locked face and wardrobe/);
            assert.match(payload.negative_prompt, /different actor/);
            assert.deepEqual(payload.reference_images, [{ asset_id: 'asset-1', file_path: '/ref.png', weight: 0.8 }]);
            assert.deepEqual(payload.input_refs, ['asset-1']);
        });
    });
});
