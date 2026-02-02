const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    extractDialogue, buildVoicePayload, dialogueFilename,
    estimateDialogueDuration, VALID_EMOTIONS,
} = require('../lib/dialogue-builder');

describe('dialogue-builder', () => {
    describe('extractDialogue', () => {
        it('extracts dialogue lines from scene card', () => {
            const card = {
                dialogue: [
                    { character: 'JOHN', line: 'Hello there.', emotion: 'happy' },
                    { character: 'JANE', line: 'Hi John.', emotion: 'neutral' },
                ],
            };
            const result = extractDialogue(card);
            assert.equal(result.length, 2);
            assert.equal(result[0].character, 'JOHN');
            assert.equal(result[0].line, 'Hello there.');
            assert.equal(result[0].emotion, 'happy');
            assert.equal(result[0].index, 0);
            assert.equal(result[1].index, 1);
        });

        it('returns empty array for no dialogue', () => {
            assert.deepEqual(extractDialogue({}), []);
            assert.deepEqual(extractDialogue(null), []);
            assert.deepEqual(extractDialogue({ dialogue: [] }), []);
        });

        it('filters out invalid dialogue entries', () => {
            const card = {
                dialogue: [
                    { character: 'JOHN', line: 'Valid.' },
                    { character: '', line: 'No character' },
                    { line: 'Missing character field' },
                    { character: 'JANE' },
                    null,
                ],
            };
            const result = extractDialogue(card);
            assert.equal(result.length, 1);
            assert.equal(result[0].character, 'JOHN');
        });

        it('defaults invalid emotion to neutral', () => {
            const card = { dialogue: [{ character: 'A', line: 'Hi', emotion: 'made_up' }] };
            const result = extractDialogue(card);
            assert.equal(result[0].emotion, 'neutral');
        });

        it('preserves valid emotions', () => {
            for (const emotion of VALID_EMOTIONS) {
                const card = { dialogue: [{ character: 'A', line: 'Test', emotion }] };
                const result = extractDialogue(card);
                assert.equal(result[0].emotion, emotion);
            }
        });
    });

    describe('buildVoicePayload', () => {
        it('builds basic payload without voice profile', () => {
            const line = { character: 'JOHN', line: 'Hello.', emotion: 'happy', index: 0 };
            const payload = buildVoicePayload(line, null, null);
            assert.equal(payload.text, 'Hello.');
            assert.equal(payload.emotion, 'happy');
            assert.equal(payload.model, 'qwen3-tts');
            assert.equal(payload.output_format, 'wav');
        });

        it('uses voice profile settings when available', () => {
            const line = { character: 'JOHN', line: 'Hello.', emotion: 'neutral', index: 0 };
            const profile = { voice_id: 'john_v1', model: 'custom-tts', language: 'fr', speed: 1.2 };
            const payload = buildVoicePayload(line, profile, null);
            assert.equal(payload.voice_id, 'john_v1');
            assert.equal(payload.model, 'custom-tts');
            assert.equal(payload.language, 'fr');
            assert.equal(payload.speed, 1.2);
        });

        it('includes character name when provided', () => {
            const line = { character: 'JOHN', line: 'Test', emotion: 'neutral', index: 0 };
            const character = { name: 'John Smith' };
            const payload = buildVoicePayload(line, null, character);
            assert.equal(payload.character_name, 'John Smith');
        });
    });

    describe('dialogueFilename', () => {
        it('generates correct filename', () => {
            assert.equal(dialogueFilename('1A', 'John', 0), '1A_JOHN_0.wav');
            assert.equal(dialogueFilename('3B', 'Jane Doe', 2), '3B_JANE_DOE_2.wav');
        });

        it('sanitizes special characters', () => {
            const name = dialogueFilename('1A', "O'Brien", 0);
            assert.ok(!name.includes("'"));
        });
    });

    describe('estimateDialogueDuration', () => {
        it('estimates duration from text length', () => {
            const short = estimateDialogueDuration('Hello', 1.0);
            const long = estimateDialogueDuration('This is a much longer sentence with many more words in it', 1.0);
            assert.ok(short < long);
            assert.ok(short >= 500); // Minimum 500ms
        });

        it('adjusts for speed', () => {
            const normal = estimateDialogueDuration('Hello world how are you', 1.0);
            const fast = estimateDialogueDuration('Hello world how are you', 2.0);
            assert.ok(fast < normal);
        });
    });
});
