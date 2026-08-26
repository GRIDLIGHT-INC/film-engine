const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    MODEL_PROFILES, DEFAULT_VRAM_BUDGET_GB, STEP_MODELS,
    buildSchedule, groupByModel, estimateGPUMemory, suggestResidency,
} = require('../lib/scheduling-engine');

describe('scheduling-engine', () => {
    describe('MODEL_PROFILES', () => {
        it('has profiles for common models', () => {
            const models = ['image', 'video', 'musicgen-large', 'qwen3-tts', 'wav2lip', 'realesrgan-video'];
            for (const m of models) {
                assert.ok(MODEL_PROFILES[m], `Missing profile for ${m}`);
                assert.ok(typeof MODEL_PROFILES[m].vram_gb === 'number');
                assert.ok(typeof MODEL_PROFILES[m].load_time_s === 'number');
                assert.ok(MODEL_PROFILES[m].type);
            }
        });

        it('all vram values are positive', () => {
            for (const [name, profile] of Object.entries(MODEL_PROFILES)) {
                assert.ok(profile.vram_gb > 0, `${name} has non-positive vram`);
            }
        });
    });

    describe('STEP_MODELS', () => {
        it('maps all pipeline steps', () => {
            const steps = ['keyframe', 'video', 'voice', 'lipsync', 'music', 'sfx', 'ambient', 'post'];
            for (const s of steps) {
                assert.ok(STEP_MODELS[s], `Missing model for step ${s}`);
            }
        });
    });

    describe('buildSchedule', () => {
        const sampleShots = [
            { shot_id: 'a', shot_code: 'SC1A', steps: ['keyframe', 'video', 'voice'] },
            { shot_id: 'b', shot_code: 'SC1B', steps: ['keyframe', 'video', 'music'] },
        ];

        it('returns phases grouped by model', () => {
            const schedule = buildSchedule(sampleShots);
            assert.ok(schedule.phases.length > 0);
            // Should have fewer phases than total steps (due to batching)
            const totalSteps = sampleShots.reduce((s, shot) => s + shot.steps.length, 0);
            assert.ok(schedule.phases.length <= totalSteps);
        });

        it('estimates load time', () => {
            const schedule = buildSchedule(sampleShots);
            assert.ok(schedule.estimated_load_time_s > 0);
        });

        it('counts model swaps', () => {
            const schedule = buildSchedule(sampleShots);
            assert.ok(typeof schedule.estimated_swaps === 'number');
        });

        it('returns empty for no shots', () => {
            const schedule = buildSchedule([]);
            assert.equal(schedule.phases.length, 0);
            assert.equal(schedule.estimated_load_time_s, 0);
        });

        it('supports sequential mode (no batching)', () => {
            const schedule = buildSchedule(sampleShots, { batch_by_model: false });
            assert.ok(schedule.phases.length > 0);
        });

        it('respects priority shots', () => {
            const schedule = buildSchedule(sampleShots, { priority_shots: ['b'] });
            assert.ok(schedule.phases.length > 0);
        });
    });

    describe('groupByModel', () => {
        it('groups steps by model', () => {
            const steps = [
                { step: 'keyframe', model: 'image' },
                { step: 'video', model: 'video' },
                { step: 'keyframe', model: 'image' },
            ];
            const groups = groupByModel(steps);
            assert.equal(groups['image'].length, 2);
            assert.equal(groups['video'].length, 1);
        });
    });

    describe('estimateGPUMemory', () => {
        it('sums VRAM for unique models', () => {
            const mem = estimateGPUMemory(['image', 'qwen3-tts']);
            assert.equal(mem, MODEL_PROFILES['image'].vram_gb + MODEL_PROFILES['qwen3-tts'].vram_gb);
        });

        it('deduplicates models', () => {
            const mem = estimateGPUMemory(['image', 'image']);
            assert.equal(mem, MODEL_PROFILES['image'].vram_gb);
        });

        it('returns 0 for empty', () => {
            assert.equal(estimateGPUMemory([]), 0);
            assert.equal(estimateGPUMemory(null), 0);
        });
    });

    describe('suggestResidency', () => {
        it('suggests models to keep resident', () => {
            const shots = [
                { shot_id: 'a', shot_code: 'SC1A', steps: ['keyframe', 'video', 'voice'] },
            ];
            const schedule = buildSchedule(shots);
            const residency = suggestResidency(schedule);
            assert.ok(residency.resident.length > 0);
            assert.ok(residency.total_vram_gb > 0);
            assert.equal(residency.budget_gb, DEFAULT_VRAM_BUDGET_GB);
        });

        it('evicts models exceeding budget', () => {
            const shots = [
                { shot_id: 'a', shot_code: 'SC1A', steps: ['keyframe', 'video', 'voice', 'lipsync', 'music', 'post'] },
            ];
            const schedule = buildSchedule(shots);
            // Very small budget should force evictions
            const residency = suggestResidency(schedule, 4);
            assert.ok(residency.evict.length > 0);
            assert.ok(residency.total_vram_gb <= 4);
        });

        it('handles null schedule', () => {
            const residency = suggestResidency(null);
            assert.deepEqual(residency.resident, []);
            assert.deepEqual(residency.evict, []);
        });
    });
});
