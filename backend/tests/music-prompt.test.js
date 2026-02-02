const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildMusicPrompt, buildSFXPrompts, buildAmbientPrompt,
    MOOD_TO_MUSIC, LOCATION_TO_AMBIENT, TIME_AMBIENT_MODIFIER,
} = require('../lib/music-prompt');

describe('music-prompt', () => {
    describe('MOOD_TO_MUSIC', () => {
        it('has entries for common moods', () => {
            const moods = ['tense', 'joyful', 'melancholic', 'epic', 'calm', 'dark', 'action', 'horror'];
            for (const m of moods) {
                assert.ok(MOOD_TO_MUSIC[m], `Missing mood: ${m}`);
                assert.ok(Array.isArray(MOOD_TO_MUSIC[m].tempo_range));
                assert.ok(Array.isArray(MOOD_TO_MUSIC[m].instruments));
                assert.ok(typeof MOOD_TO_MUSIC[m].energy === 'number');
                assert.ok(MOOD_TO_MUSIC[m].genre_hint);
            }
        });

        it('has valid tempo ranges (low < high)', () => {
            for (const [mood, config] of Object.entries(MOOD_TO_MUSIC)) {
                assert.ok(config.tempo_range[0] < config.tempo_range[1], `${mood} tempo range invalid`);
            }
        });

        it('has energy values between 0 and 1', () => {
            for (const [mood, config] of Object.entries(MOOD_TO_MUSIC)) {
                assert.ok(config.energy >= 0 && config.energy <= 1, `${mood} energy out of range`);
            }
        });
    });

    describe('LOCATION_TO_AMBIENT', () => {
        it('has entries for common locations', () => {
            const locations = ['office', 'street', 'forest', 'beach', 'restaurant', 'hospital'];
            for (const loc of locations) {
                assert.ok(LOCATION_TO_AMBIENT[loc], `Missing location: ${loc}`);
                assert.ok(typeof LOCATION_TO_AMBIENT[loc] === 'string');
            }
        });
    });

    describe('buildMusicPrompt', () => {
        it('builds payload from music cue', () => {
            const cue = { mood: 'tense', genre: 'jazz-noir', description: 'Dark jazz score' };
            const scene = { estimated_duration: 30000 };
            const project = { genre: 'thriller' };
            const payload = buildMusicPrompt(cue, scene, project);

            assert.equal(payload.type, 'score');
            assert.ok(payload.prompt.includes('Dark jazz score'));
            assert.equal(payload.duration_s, 30);
            assert.equal(payload.model, 'musicgen-large');
            assert.equal(payload.mood, 'tense');
            assert.equal(payload.output_format, 'wav');
        });

        it('auto-generates prompt when no description', () => {
            const cue = { mood: 'epic' };
            const payload = buildMusicPrompt(cue, {}, null);
            assert.ok(payload.prompt.includes('epic'));
            assert.ok(payload.prompt.includes('orchestral'));
        });

        it('uses default calm when mood unknown', () => {
            const payload = buildMusicPrompt({ mood: 'nonexistent' }, {}, null);
            assert.equal(payload.mood, 'nonexistent');
            // Should still produce a valid payload
            assert.ok(payload.prompt);
            assert.ok(payload.tempo_bpm > 0);
        });

        it('handles null inputs gracefully', () => {
            const payload = buildMusicPrompt(null, null, null);
            assert.equal(payload.type, 'score');
            assert.ok(payload.prompt);
        });

        it('uses cue instruments when available', () => {
            const cue = { mood: 'calm', instruments: ['harp', 'flute'] };
            const payload = buildMusicPrompt(cue, {}, null);
            assert.ok(payload.prompt.includes('harp'));
            assert.ok(payload.prompt.includes('flute'));
            assert.deepEqual(payload.instruments, ['harp', 'flute']);
        });

        it('calculates tempo from mood when not specified', () => {
            const cue = { mood: 'action' };
            const payload = buildMusicPrompt(cue, {}, null);
            const actionConfig = MOOD_TO_MUSIC['action'];
            const expectedTempo = Math.round((actionConfig.tempo_range[0] + actionConfig.tempo_range[1]) / 2);
            assert.equal(payload.tempo_bpm, expectedTempo);
        });
    });

    describe('buildSFXPrompts', () => {
        it('extracts SFX from scene card', () => {
            const card = {
                sfx_cues: [
                    { description: 'Door slam', duration_s: 1.5, category: 'foley' },
                    { sound: 'Gunshot', duration_s: 0.5 },
                ],
            };
            const result = buildSFXPrompts(card, {});
            assert.equal(result.length, 2);
            assert.equal(result[0].type, 'sfx');
            assert.equal(result[0].prompt, 'Door slam');
            assert.equal(result[0].duration_s, 1.5);
            assert.equal(result[1].prompt, 'Gunshot');
        });

        it('returns empty when no sfx_cues', () => {
            assert.deepEqual(buildSFXPrompts({}, {}), []);
            assert.deepEqual(buildSFXPrompts({ sfx_cues: [] }, {}), []);
        });
    });

    describe('buildAmbientPrompt', () => {
        it('matches known location', () => {
            const scene = { location: 'Downtown Office', int_ext: 'INT', time_of_day: 'day' };
            const payload = buildAmbientPrompt(scene, null);
            assert.equal(payload.type, 'ambient');
            assert.ok(payload.prompt.includes('office'));
            assert.equal(payload.loopable, true);
        });

        it('uses location description when no match', () => {
            const scene = { location: 'Alien spaceship' };
            const location = { description: 'vast metallic corridor with humming engines' };
            const payload = buildAmbientPrompt(scene, location);
            assert.ok(payload.prompt.includes('vast metallic corridor'));
        });

        it('adds outdoor modifier for EXT scenes', () => {
            const scene = { location: 'Park', int_ext: 'EXT', time_of_day: 'day' };
            const payload = buildAmbientPrompt(scene, null);
            assert.ok(payload.prompt.includes('outdoor'));
        });

        it('adds time of day modifier', () => {
            const scene = { location: 'Street', time_of_day: 'night' };
            const payload = buildAmbientPrompt(scene, null);
            assert.ok(payload.prompt.includes('nighttime'));
        });

        it('defaults to quiet room for missing location', () => {
            const payload = buildAmbientPrompt({}, null);
            assert.ok(payload.prompt.includes('quiet room'));
        });
    });
});
