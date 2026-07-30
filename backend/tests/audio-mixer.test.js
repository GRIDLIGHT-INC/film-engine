const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    DEFAULT_LEVELS, LUFS_TARGETS, DUCKING_DEFAULTS,
    buildMixPayload, calculateDucking, buildStemExport, generateSRT, formatSRTTime,
} = require('../lib/audio-mixer');

describe('audio-mixer', () => {
    describe('constants', () => {
        it('has default levels for all track types', () => {
            assert.equal(typeof DEFAULT_LEVELS.dialogue, 'number');
            assert.equal(typeof DEFAULT_LEVELS.music, 'number');
            assert.equal(typeof DEFAULT_LEVELS.sfx, 'number');
            assert.equal(typeof DEFAULT_LEVELS.ambient, 'number');
        });

        it('dialogue is reference level (0 dB)', () => {
            assert.equal(DEFAULT_LEVELS.dialogue, 0);
        });

        it('music is below dialogue', () => {
            assert.ok(DEFAULT_LEVELS.music < DEFAULT_LEVELS.dialogue);
        });

        it('has LUFS targets for common formats', () => {
            assert.equal(LUFS_TARGETS.broadcast, -24);
            assert.equal(LUFS_TARGETS.streaming, -14);
            assert.equal(LUFS_TARGETS.cinema, -27);
        });
    });

    describe('buildMixPayload', () => {
        const sampleTracks = [
            { type: 'dialogue', url: '/audio/dialogue.wav', start_ms: 0, duration_ms: 3000 },
            { type: 'music', url: '/audio/score.wav', start_ms: 0, duration_ms: 30000 },
        ];

        it('builds valid payload', () => {
            const payload = buildMixPayload(sampleTracks);
            assert.equal(payload.type, 'mix');
            assert.equal(payload.tracks.length, 2);
            assert.ok(payload.master);
            assert.equal(payload.master.lufs_target, LUFS_TARGETS.streaming);
            assert.equal(payload.output_format, 'wav');
        });

        it('tiles a looping bed across the slot it has to fill', () => {
            // A 30s ambient loop under a 90s shot must be repeated, not padded
            // with 60s of silence.
            const payload = buildMixPayload([
                { type: 'ambient', url: '/audio/room.wav', start_ms: 0, duration_ms: 30000, loop: true, loop_until_ms: 90000, crossfade_ms: 5000 },
            ]);
            const bed = payload.tracks[0];
            assert.equal(bed.loop, true);
            assert.equal(bed.loop_until_ms, 90000);
            assert.equal(bed.loop_crossfade_ms, 5000);
        });

        it('never loops a track that did not ask for it', () => {
            // Guards against looping dialogue, which would repeat a line.
            const payload = buildMixPayload(sampleTracks);
            for (const t of payload.tracks) {
                assert.equal(t.loop, false, `${t.type} was looped`);
                assert.equal(t.loop_until_ms, 0);
            }
        });

        it('does not loop a bed that already covers its slot', () => {
            const payload = buildMixPayload([
                { type: 'ambient', url: '/a.wav', start_ms: 0, duration_ms: 90000, loop: true, loop_until_ms: 90000 },
            ]);
            assert.equal(payload.tracks[0].loop, false);
        });

        it('ignores a loop request with no target length', () => {
            // Without a slot to fill, looping forever is worse than not looping.
            const payload = buildMixPayload([
                { type: 'ambient', url: '/a.wav', start_ms: 0, duration_ms: 30000, loop: true },
            ]);
            assert.equal(payload.tracks[0].loop, false);
        });

        it('applies default gain levels per type', () => {
            const payload = buildMixPayload(sampleTracks);
            assert.equal(payload.tracks[0].gain_db, DEFAULT_LEVELS.dialogue);
            assert.equal(payload.tracks[1].gain_db, DEFAULT_LEVELS.music);
        });

        it('enables ducking by default', () => {
            const payload = buildMixPayload(sampleTracks);
            assert.equal(payload.ducking.enabled, true);
        });

        it('can disable ducking', () => {
            const payload = buildMixPayload(sampleTracks, { ducking: false });
            assert.equal(payload.ducking.enabled, false);
        });

        it('handles empty tracks', () => {
            const payload = buildMixPayload([]);
            assert.equal(payload.tracks.length, 0);
        });

        it('respects custom LUFS target', () => {
            const payload = buildMixPayload(sampleTracks, { lufs_target: -24 });
            assert.equal(payload.master.lufs_target, -24);
        });
    });

    describe('calculateDucking', () => {
        it('returns ducking events for dialogue regions', () => {
            const regions = [
                { start_ms: 1000, end_ms: 3000 },
                { start_ms: 5000, end_ms: 7000 },
            ];
            const events = calculateDucking(regions);
            assert.equal(events.length, 2);
            assert.ok(events[0].start_ms < 1000); // attack time before dialogue
            assert.ok(events[0].end_ms > 3000);   // release after dialogue
        });

        it('merges overlapping regions', () => {
            const regions = [
                { start_ms: 1000, end_ms: 2500 },
                { start_ms: 2000, end_ms: 4000 },
            ];
            const events = calculateDucking(regions);
            assert.equal(events.length, 1);
        });

        it('returns empty for no regions', () => {
            assert.deepEqual(calculateDucking([]), []);
            assert.deepEqual(calculateDucking(null), []);
        });

        it('applies gain reduction', () => {
            const events = calculateDucking([{ start_ms: 0, end_ms: 1000 }]);
            assert.ok(events[0].gain_reduction_db < 0);
        });
    });

    describe('buildStemExport', () => {
        it('groups tracks by type', () => {
            const tracks = [
                { type: 'dialogue', url: 'a.wav' },
                { type: 'music', url: 'b.wav' },
                { type: 'dialogue', url: 'c.wav' },
            ];
            const result = buildStemExport(tracks);
            assert.equal(result.type, 'stem_export');
            assert.equal(result.stems.length, 2); // dialogue and music
            const dialogueStem = result.stems.find(s => s.stem_name === 'dialogue');
            assert.equal(dialogueStem.tracks.length, 2);
        });

        it('handles empty tracks', () => {
            const result = buildStemExport([]);
            assert.equal(result.stems.length, 0);
        });
    });

    describe('generateSRT', () => {
        it('generates valid SRT format', () => {
            const lines = [
                { character: 'JOHN', line: 'Hello there.', start_ms: 0, end_ms: 2000 },
                { character: 'JANE', line: 'Hi John.', start_ms: 2500, end_ms: 4000 },
            ];
            const srt = generateSRT(lines, { include_character: true });
            assert.ok(srt.includes('1'));
            assert.ok(srt.includes('JOHN: Hello there.'));
            assert.ok(srt.includes('00:00:00,000 --> 00:00:02,000'));
            assert.ok(srt.includes('JANE: Hi John.'));
        });

        it('excludes character name when option is false', () => {
            const lines = [{ character: 'JOHN', line: 'Test', start_ms: 0, end_ms: 1000 }];
            const srt = generateSRT(lines, { include_character: false });
            assert.ok(!srt.includes('JOHN:'));
            assert.ok(srt.includes('Test'));
        });

        it('returns empty for no lines', () => {
            assert.equal(generateSRT([]), '');
            assert.equal(generateSRT(null), '');
        });
    });

    describe('formatSRTTime', () => {
        it('formats milliseconds to SRT time', () => {
            assert.equal(formatSRTTime(0), '00:00:00,000');
            assert.equal(formatSRTTime(1500), '00:00:01,500');
            assert.equal(formatSRTTime(3661500), '01:01:01,500');
        });
    });
});
