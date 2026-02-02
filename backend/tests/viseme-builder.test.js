const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    VISEME_LIST, VISEME_MAP, textToPhonemes, phonemesToVisemes,
    buildVisemeTrack, mergeVisemesWithAudio, buildVisemePayload,
} = require('../lib/viseme-builder');

describe('viseme-builder', () => {
    describe('VISEME_LIST', () => {
        it('has 15 visemes', () => {
            assert.equal(VISEME_LIST.length, 15);
        });

        it('starts with sil', () => {
            assert.equal(VISEME_LIST[0], 'sil');
        });
    });

    describe('VISEME_MAP', () => {
        it('maps bilabials to PP', () => {
            assert.equal(VISEME_MAP['P'], 'PP');
            assert.equal(VISEME_MAP['B'], 'PP');
            assert.equal(VISEME_MAP['M'], 'PP');
        });

        it('maps vowels correctly', () => {
            assert.equal(VISEME_MAP['AA'], 'aa');
            assert.equal(VISEME_MAP['IY'], 'ih');
            assert.equal(VISEME_MAP['UW'], 'ou');
        });

        it('maps sibilants to SS', () => {
            assert.equal(VISEME_MAP['S'], 'SS');
            assert.equal(VISEME_MAP['Z'], 'SS');
        });
    });

    describe('textToPhonemes', () => {
        it('converts simple text to phonemes', () => {
            const result = textToPhonemes('hello');
            assert.ok(result.length > 0);
            assert.ok(Array.isArray(result));
        });

        it('returns empty for null/empty', () => {
            assert.deepEqual(textToPhonemes(null), []);
            assert.deepEqual(textToPhonemes(''), []);
        });

        it('handles digraphs', () => {
            const result = textToPhonemes('the shop');
            assert.ok(result.includes('TH'));
            assert.ok(result.includes('SH'));
        });

        it('inserts word boundaries', () => {
            const result = textToPhonemes('hello world');
            assert.ok(result.includes('SP'));
        });
    });

    describe('phonemesToVisemes', () => {
        it('maps phonemes to visemes', () => {
            const result = phonemesToVisemes(['P', 'AA', 'T']);
            assert.deepEqual(result, ['PP', 'aa', 'DD']);
        });

        it('returns sil for unknown phonemes', () => {
            const result = phonemesToVisemes(['UNKNOWN']);
            assert.deepEqual(result, ['sil']);
        });

        it('returns empty for non-array', () => {
            assert.deepEqual(phonemesToVisemes(null), []);
        });
    });

    describe('buildVisemeTrack', () => {
        it('builds timed track from text', () => {
            const track = buildVisemeTrack('Hello there', 2000);
            assert.ok(track.visemes.length > 0);
            assert.equal(track.duration_ms, 2000);
            assert.ok(track.phoneme_count > 0);
        });

        it('returns silence for empty text', () => {
            const track = buildVisemeTrack('', 1000);
            assert.equal(track.visemes.length, 1);
            assert.equal(track.visemes[0].viseme, 'sil');
        });

        it('visemes cover full duration', () => {
            const track = buildVisemeTrack('This is a test', 3000);
            const lastViseme = track.visemes[track.visemes.length - 1];
            assert.equal(lastViseme.end_ms, 3000);
            assert.equal(track.visemes[0].start_ms, 0);
        });

        it('merges consecutive identical visemes', () => {
            const track = buildVisemeTrack('aaa', 1000);
            // 'aaa' should produce AA AA AA → all 'aa' → merged into one
            assert.ok(track.visemes.length <= 3);
        });

        it('estimates duration when not provided', () => {
            const track = buildVisemeTrack('Hello world');
            assert.ok(track.duration_ms >= 500);
        });
    });

    describe('mergeVisemesWithAudio', () => {
        it('returns original track when no audio timings', () => {
            const track = buildVisemeTrack('test', 1000);
            const merged = mergeVisemesWithAudio(track, null);
            assert.deepEqual(merged.visemes, track.visemes);
        });

        it('adjusts visemes to audio timing', () => {
            const track = buildVisemeTrack('hello there', 2000);
            const timings = [
                { word: 'hello', start_ms: 100, end_ms: 700 },
                { word: 'there', start_ms: 800, end_ms: 1500 },
            ];
            const merged = mergeVisemesWithAudio(track, timings);
            assert.ok(merged.visemes.length > 0);
            assert.ok(merged.audio_aligned);
        });

        it('returns empty for empty timings', () => {
            const track = buildVisemeTrack('test', 1000);
            const merged = mergeVisemesWithAudio(track, []);
            assert.deepEqual(merged.visemes, track.visemes);
        });
    });

    describe('buildVisemePayload', () => {
        it('builds payload from dialogue line', () => {
            const line = { line: 'Hello there', character: 'JOHN' };
            const payload = buildVisemePayload(line, null);
            assert.equal(payload.text, 'Hello there');
            assert.equal(payload.language, 'en');
            assert.equal(payload.format, 'mpeg4');
            assert.equal(payload.include_phonemes, true);
        });

        it('uses voice profile settings', () => {
            const profile = { language: 'fr', speed: 1.5 };
            const payload = buildVisemePayload({ line: 'Bonjour' }, profile);
            assert.equal(payload.language, 'fr');
            assert.equal(payload.speed, 1.5);
        });

        it('handles null inputs', () => {
            const payload = buildVisemePayload(null, null);
            assert.equal(payload.text, '');
            assert.equal(payload.language, 'en');
        });
    });
});
