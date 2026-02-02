const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    MAX_CLIP_DURATION_S, MAX_CLIP_DURATION_MS, OVERLAP_S, OVERLAP_MS,
    TRANSITION_TYPES, needsStitching, planClips, buildStitchPayload, calculateTransitions,
} = require('../lib/video-stitcher');

describe('video-stitcher', () => {
    describe('constants', () => {
        it('has correct defaults', () => {
            assert.equal(MAX_CLIP_DURATION_S, 5);
            assert.equal(MAX_CLIP_DURATION_MS, 5000);
            assert.equal(OVERLAP_S, 0.5);
            assert.equal(OVERLAP_MS, 500);
        });

        it('has valid transition types', () => {
            assert.ok(TRANSITION_TYPES.includes('cross-dissolve'));
            assert.ok(TRANSITION_TYPES.includes('cut'));
        });
    });

    describe('needsStitching', () => {
        it('returns false for short clips', () => {
            assert.equal(needsStitching(3000), false);
            assert.equal(needsStitching(5000), false);
        });

        it('returns true for long clips', () => {
            assert.equal(needsStitching(6000), true);
            assert.equal(needsStitching(15000), true);
        });

        it('returns false for invalid inputs', () => {
            assert.equal(needsStitching(null), false);
            assert.equal(needsStitching(undefined), false);
            assert.equal(needsStitching(-1), false);
        });
    });

    describe('planClips', () => {
        it('returns single clip for short duration', () => {
            const clips = planClips(3000);
            assert.equal(clips.length, 1);
            assert.equal(clips[0].start_ms, 0);
            assert.equal(clips[0].end_ms, 3000);
            assert.equal(clips[0].overlap_before_ms, 0);
            assert.equal(clips[0].overlap_after_ms, 0);
        });

        it('splits long duration into multiple clips', () => {
            const clips = planClips(12000);
            assert.ok(clips.length > 1);
            assert.equal(clips[0].start_ms, 0);
            assert.ok(clips[clips.length - 1].end_ms === 12000);
        });

        it('first clip has no overlap_before', () => {
            const clips = planClips(12000);
            assert.equal(clips[0].overlap_before_ms, 0);
        });

        it('last clip has no overlap_after', () => {
            const clips = planClips(12000);
            assert.equal(clips[clips.length - 1].overlap_after_ms, 0);
        });

        it('middle clips have overlaps', () => {
            const clips = planClips(15000);
            if (clips.length >= 3) {
                assert.ok(clips[1].overlap_before_ms > 0);
                assert.ok(clips[1].overlap_after_ms > 0);
            }
        });

        it('returns empty for zero or negative', () => {
            assert.deepEqual(planClips(0), []);
            assert.deepEqual(planClips(-1), []);
            assert.deepEqual(planClips(null), []);
        });

        it('respects custom max_clip_ms', () => {
            const clips = planClips(8000, { max_clip_ms: 3000 });
            assert.ok(clips.length >= 3);
        });
    });

    describe('buildStitchPayload', () => {
        it('builds valid payload', () => {
            const clips = planClips(12000);
            const payload = buildStitchPayload(clips, 'proj1', 'SC1A');
            assert.equal(payload.type, 'stitch');
            assert.equal(payload.project_id, 'proj1');
            assert.equal(payload.shot_code, 'SC1A');
            assert.ok(payload.clips.length > 0);
            assert.equal(payload.transition, 'cross-dissolve');
            assert.equal(payload.output_format, 'mp4');
        });

        it('respects custom transition', () => {
            const clips = planClips(12000);
            const payload = buildStitchPayload(clips, 'p', 's', { transition: 'fade-through-black' });
            assert.equal(payload.transition, 'fade-through-black');
        });
    });

    describe('calculateTransitions', () => {
        it('returns empty for single clip', () => {
            const clips = planClips(3000);
            assert.deepEqual(calculateTransitions(clips), []);
        });

        it('returns transitions between clips', () => {
            const clips = planClips(12000);
            const transitions = calculateTransitions(clips);
            assert.equal(transitions.length, clips.length - 1);
            assert.equal(transitions[0].from_clip, 0);
            assert.equal(transitions[0].to_clip, 1);
            assert.equal(transitions[0].type, 'cross-dissolve');
        });

        it('uses custom transition type', () => {
            const clips = planClips(12000);
            const transitions = calculateTransitions(clips, 'cut');
            assert.ok(transitions.every(t => t.type === 'cut'));
        });
    });
});
