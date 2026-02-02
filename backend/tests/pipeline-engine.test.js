const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    PIPELINE_STEPS, STEP_IDS, MAX_RETRIES, RETRY_BACKOFF_MS,
    getNextSteps, canRunStep, buildStepPlan, retryDelay,
    hasDialogue, autoSkipSteps,
} = require('../lib/pipeline-engine');

describe('pipeline-engine', () => {
    describe('PIPELINE_STEPS', () => {
        it('has 9 steps', () => {
            assert.equal(PIPELINE_STEPS.length, 9);
        });

        it('has correct step IDs', () => {
            const ids = PIPELINE_STEPS.map(s => s.id);
            assert.deepEqual(ids, ['keyframe', 'video', 'voice', 'lipsync', 'music', 'sfx', 'ambient', 'post', 'assembly']);
        });

        it('all steps have required fields', () => {
            for (const step of PIPELINE_STEPS) {
                assert.ok(step.id, `Missing id`);
                assert.ok(step.name, `Missing name for ${step.id}`);
                assert.ok(Array.isArray(step.depends), `Missing depends for ${step.id}`);
                assert.ok(step.scope, `Missing scope for ${step.id}`);
                assert.ok(step.handler, `Missing handler for ${step.id}`);
            }
        });

        it('dependencies reference valid step IDs', () => {
            for (const step of PIPELINE_STEPS) {
                for (const dep of step.depends) {
                    assert.ok(STEP_IDS.includes(dep), `${step.id} depends on unknown step ${dep}`);
                }
            }
        });
    });

    describe('getNextSteps', () => {
        it('returns steps with no dependencies when nothing completed', () => {
            const next = getNextSteps([]);
            const ids = next.map(s => s.id);
            assert.ok(ids.includes('keyframe'));
            assert.ok(ids.includes('voice'));
            assert.ok(ids.includes('music'));
            assert.ok(ids.includes('sfx'));
            assert.ok(ids.includes('ambient'));
            assert.ok(!ids.includes('video')); // depends on keyframe
            assert.ok(!ids.includes('lipsync')); // depends on video + voice
        });

        it('unlocks video after keyframe', () => {
            const next = getNextSteps(['keyframe']);
            const ids = next.map(s => s.id);
            assert.ok(ids.includes('video'));
        });

        it('unlocks lipsync after video + voice', () => {
            const next = getNextSteps(['keyframe', 'video', 'voice']);
            const ids = next.map(s => s.id);
            assert.ok(ids.includes('lipsync'));
        });

        it('unlocks post after lipsync', () => {
            const next = getNextSteps(['keyframe', 'video', 'voice', 'lipsync']);
            const ids = next.map(s => s.id);
            assert.ok(ids.includes('post'));
        });

        it('unlocks assembly after post + music + sfx + ambient', () => {
            const next = getNextSteps(['keyframe', 'video', 'voice', 'lipsync', 'post', 'music', 'sfx', 'ambient']);
            const ids = next.map(s => s.id);
            assert.ok(ids.includes('assembly'));
        });

        it('excludes skipped steps', () => {
            const next = getNextSteps([], ['voice', 'music']);
            const ids = next.map(s => s.id);
            assert.ok(!ids.includes('voice'));
            assert.ok(!ids.includes('music'));
        });

        it('treats skipped dependencies as satisfied', () => {
            const next = getNextSteps(['keyframe', 'video'], ['voice']);
            const ids = next.map(s => s.id);
            assert.ok(ids.includes('lipsync')); // voice is skipped, so lipsync can run
        });
    });

    describe('canRunStep', () => {
        it('returns true for steps with satisfied deps', () => {
            assert.equal(canRunStep('keyframe', []), true);
            assert.equal(canRunStep('video', ['keyframe']), true);
            assert.equal(canRunStep('lipsync', ['keyframe', 'video', 'voice']), true);
        });

        it('returns false for steps with unsatisfied deps', () => {
            assert.equal(canRunStep('video', []), false);
            assert.equal(canRunStep('lipsync', ['video']), false);
        });

        it('returns false for unknown step', () => {
            assert.equal(canRunStep('nonexistent', []), false);
        });

        it('treats skipped deps as satisfied', () => {
            assert.equal(canRunStep('lipsync', ['video'], ['voice']), true);
        });
    });

    describe('buildStepPlan', () => {
        it('returns all steps with no options', () => {
            const plan = buildStepPlan();
            assert.equal(plan.length, 9);
            assert.equal(plan[0].id, 'keyframe');
            assert.equal(plan[8].id, 'assembly');
        });

        it('skips specified steps', () => {
            const plan = buildStepPlan({ skip_steps: ['voice', 'lipsync'] });
            const ids = plan.map(s => s.id);
            assert.ok(!ids.includes('voice'));
            assert.ok(!ids.includes('lipsync'));
            assert.equal(plan.length, 7);
        });

        it('starts from a specific step', () => {
            const plan = buildStepPlan({ start_from: 'music' });
            assert.equal(plan[0].id, 'music');
            assert.ok(plan.length < 9);
        });

        it('filters to only specified steps', () => {
            const plan = buildStepPlan({ only_steps: ['keyframe', 'video'] });
            assert.equal(plan.length, 2);
            assert.equal(plan[0].id, 'keyframe');
            assert.equal(plan[1].id, 'video');
        });

        it('each step has id, name, scope, handler', () => {
            const plan = buildStepPlan();
            for (const step of plan) {
                assert.ok(step.id);
                assert.ok(step.name);
                assert.ok(step.scope);
                assert.ok(step.handler);
            }
        });
    });

    describe('retryDelay', () => {
        it('uses exponential backoff', () => {
            assert.equal(retryDelay(0), RETRY_BACKOFF_MS);
            assert.equal(retryDelay(1), RETRY_BACKOFF_MS * 2);
            assert.equal(retryDelay(2), RETRY_BACKOFF_MS * 4);
        });
    });

    describe('hasDialogue', () => {
        it('returns true when dialogue exists', () => {
            assert.equal(hasDialogue({ dialogue: [{ character: 'A', line: 'Hi' }] }), true);
        });

        it('returns false when no dialogue', () => {
            assert.ok(!hasDialogue({}));
            assert.ok(!hasDialogue(null));
            assert.ok(!hasDialogue({ dialogue: [] }));
        });
    });

    describe('autoSkipSteps', () => {
        it('skips voice + lipsync when no dialogue', () => {
            const skips = autoSkipSteps({});
            assert.ok(skips.includes('voice'));
            assert.ok(skips.includes('lipsync'));
        });

        it('does not skip voice when dialogue exists', () => {
            const skips = autoSkipSteps({ dialogue: [{ character: 'A', line: 'Hi' }] });
            assert.ok(!skips.includes('voice'));
            assert.ok(!skips.includes('lipsync'));
        });

        it('merges with user-specified skips', () => {
            const skips = autoSkipSteps({}, { skip_steps: ['music'] });
            assert.ok(skips.includes('music'));
            assert.ok(skips.includes('voice'));
            assert.ok(skips.includes('lipsync'));
        });
    });
});
