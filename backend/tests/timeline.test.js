const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
    buildTimeline, resolveShotMedia, orderShots, shotDuration,
    entryAtMs, toShotRelative, msToTimecode, timecodeToMs, DEFAULT_SHOT_MS,
} = require('../lib/timeline');

describe('timeline', () => {
    describe('resolveShotMedia', () => {
        test('prefers a finished video over synced and raw', () => {
            const media = resolveShotMedia([
                { asset_type: 'video_raw', file_path: '/raw.mp4' },
                { asset_type: 'video_final', file_path: '/final.mp4' },
                { asset_type: 'video_synced', file_path: '/synced.mp4' },
            ]);
            assert.equal(media.kind, 'video');
            assert.equal(media.video.path, '/final.mp4');
        });

        test('prefers synced over raw when no final exists', () => {
            const media = resolveShotMedia([
                { asset_type: 'video_raw', file_path: '/raw.mp4' },
                { asset_type: 'video_synced', file_path: '/synced.mp4' },
            ]);
            assert.equal(media.video.path, '/synced.mp4');
        });

        test('falls back to a still when no video exists', () => {
            const media = resolveShotMedia([
                { asset_type: 'keyframe', file_path: '/key.png' },
            ]);
            assert.equal(media.kind, 'still');
            assert.equal(media.still.path, '/key.png');
            assert.equal(media.missing, false);
        });

        test('reports a shot with nothing as missing rather than hiding it', () => {
            const media = resolveShotMedia([]);
            assert.equal(media.kind, 'empty');
            assert.equal(media.missing, true);
        });

        test('ignores assets with an empty file path', () => {
            const media = resolveShotMedia([{ asset_type: 'video_final', file_path: '' }]);
            assert.equal(media.kind, 'empty');
        });
    });

    describe('orderShots', () => {
        test('scene number dominates sort_order', () => {
            const ordered = orderShots([
                { id: 'b', scene_number: 2, sort_order: 0, shot_code: 'SC02-SH01' },
                { id: 'a', scene_number: 1, sort_order: 9, shot_code: 'SC01-SH01' },
            ]);
            assert.deepEqual(ordered.map(s => s.id), ['a', 'b']);
        });

        test('sort_order breaks ties within a scene', () => {
            const ordered = orderShots([
                { id: 'second', scene_number: 1, sort_order: 2, shot_code: 'x' },
                { id: 'first', scene_number: 1, sort_order: 1, shot_code: 'y' },
            ]);
            assert.deepEqual(ordered.map(s => s.id), ['first', 'second']);
        });

        test('shot_code is the final stable tiebreak', () => {
            const ordered = orderShots([
                { id: 'b', scene_number: 1, sort_order: 0, shot_code: 'SC01-SH02' },
                { id: 'a', scene_number: 1, sort_order: 0, shot_code: 'SC01-SH01' },
            ]);
            assert.deepEqual(ordered.map(s => s.id), ['a', 'b']);
        });

        test('does not mutate its input', () => {
            const input = [
                { id: 'b', scene_number: 2, sort_order: 0, shot_code: 'b' },
                { id: 'a', scene_number: 1, sort_order: 0, shot_code: 'a' },
            ];
            orderShots(input);
            assert.equal(input[0].id, 'b');
        });
    });

    describe('shotDuration', () => {
        test('uses the measured duration', () => {
            assert.equal(shotDuration({ duration_ms: 3200 }), 3200);
        });

        test('falls back for zero, missing, or negative durations', () => {
            assert.equal(shotDuration({ duration_ms: 0 }), DEFAULT_SHOT_MS);
            assert.equal(shotDuration({}), DEFAULT_SHOT_MS);
            assert.equal(shotDuration({ duration_ms: -5 }), DEFAULT_SHOT_MS);
            assert.equal(shotDuration(null), DEFAULT_SHOT_MS);
        });
    });

    describe('buildTimeline', () => {
        const shots = [
            { id: 's1', shot_code: 'SC01-SH01', scene_id: 'sc1', scene_number: 1, sort_order: 1, duration_ms: 2000 },
            { id: 's2', shot_code: 'SC01-SH02', scene_id: 'sc1', scene_number: 1, sort_order: 2, duration_ms: 3000 },
        ];
        const assets = {
            s1: [{ asset_type: 'video_final', file_path: '/a.mp4' }],
            s2: [],
        };

        test('lays shots end to end with no gaps', () => {
            const tl = buildTimeline(shots, assets);
            assert.equal(tl.entries[0].start_ms, 0);
            assert.equal(tl.entries[0].end_ms, 2000);
            assert.equal(tl.entries[1].start_ms, 2000);
            assert.equal(tl.entries[1].end_ms, 5000);
            assert.equal(tl.total_duration_ms, 5000);
        });

        test('counts playable versus missing shots', () => {
            const tl = buildTimeline(shots, assets);
            assert.equal(tl.shot_count, 2);
            assert.equal(tl.playable_count, 1);
            assert.equal(tl.missing_count, 1);
        });

        test('an empty project produces a valid empty timeline', () => {
            const tl = buildTimeline([], {});
            assert.deepEqual(tl.entries, []);
            assert.equal(tl.total_duration_ms, 0);
            assert.equal(tl.shot_count, 0);
        });

        test('honours project fps in timecodes', () => {
            const tl = buildTimeline(shots, assets, { fps: 30 });
            assert.equal(tl.fps, 30);
        });

        test('falls back to 24fps for an invalid fps', () => {
            assert.equal(buildTimeline(shots, assets, { fps: 0 }).fps, 24);
            assert.equal(buildTimeline(shots, assets, { fps: null }).fps, 24);
        });
    });

    describe('entryAtMs / toShotRelative', () => {
        const tl = buildTimeline([
            { id: 's1', shot_code: 'A', scene_number: 1, sort_order: 1, duration_ms: 2000 },
            { id: 's2', shot_code: 'B', scene_number: 1, sort_order: 2, duration_ms: 2000 },
        ], {});

        test('finds the shot playing at a position', () => {
            assert.equal(entryAtMs(tl, 0).shot_id, 's1');
            assert.equal(entryAtMs(tl, 1999).shot_id, 's1');
            assert.equal(entryAtMs(tl, 2000).shot_id, 's2');
        });

        test('boundary belongs to the incoming shot, not the outgoing one', () => {
            assert.equal(entryAtMs(tl, 2000).shot_id, 's2');
        });

        test('returns null past the end and for bad input', () => {
            assert.equal(entryAtMs(tl, 4000), null);
            assert.equal(entryAtMs(tl, -1), null);
            assert.equal(entryAtMs(tl, NaN), null);
            assert.equal(entryAtMs(null, 0), null);
        });

        test('converts an absolute position to a shot-relative offset', () => {
            const rel = toShotRelative(tl, 2500);
            assert.equal(rel.shot_id, 's2');
            assert.equal(rel.timecode_ms, 500);
        });

        test('returns null when the position is off the timeline', () => {
            assert.equal(toShotRelative(tl, 99999), null);
        });
    });

    describe('msToTimecode / timecodeToMs', () => {
        test('formats SMPTE-style timecode', () => {
            assert.equal(msToTimecode(0, 24), '00:00:00:00');
            assert.equal(msToTimecode(1000, 24), '00:00:01:00');
            assert.equal(msToTimecode(61000, 24), '00:01:01:00');
            assert.equal(msToTimecode(3661000, 24), '01:01:01:00');
        });

        test('rounds frames down so it never shows a frame that has not started', () => {
            // 500ms at 24fps is frame 12 exactly; 499ms must not round up to 12.
            assert.equal(msToTimecode(500, 24), '00:00:00:12');
            assert.equal(msToTimecode(499, 24), '00:00:00:11');
        });

        test('clamps negative input to zero', () => {
            assert.equal(msToTimecode(-500, 24), '00:00:00:00');
        });

        test('round-trips through timecodeToMs', () => {
            for (const ms of [0, 1000, 61000, 3661000]) {
                assert.equal(timecodeToMs(msToTimecode(ms, 24), 24), ms);
            }
        });

        test('rejects malformed or out-of-range timecodes', () => {
            assert.equal(timecodeToMs('nonsense', 24), null);
            assert.equal(timecodeToMs('00:99:00:00', 24), null, 'minutes > 59');
            assert.equal(timecodeToMs('00:00:99:00', 24), null, 'seconds > 59');
            assert.equal(timecodeToMs('00:00:00:30', 24), null, 'frame >= fps');
            assert.equal(timecodeToMs(null, 24), null);
            assert.equal(timecodeToMs(12345, 24), null);
        });

        test('accepts drop-frame separator on input', () => {
            assert.equal(timecodeToMs('00:00:01;00', 24), 1000);
        });
    });
});
