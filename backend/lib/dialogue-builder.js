/**
 * FILM-022-028: Dialogue Builder
 *
 * Pure functions for extracting dialogue from scene cards and building
 * voice synthesis payloads. No DB dependency.
 */

const VALID_EMOTIONS = [
    'neutral', 'happy', 'sad', 'angry', 'surprised', 'fearful',
    'disgusted', 'contemptuous', 'excited', 'tender', 'whispered',
    'shouting', 'sarcastic', 'pleading',
];

/**
 * Extract dialogue entries from a parsed scene card.
 *
 * @param {object} sceneCard - Parsed scene_card_yaml
 * @returns {Array<{ character: string, line: string, emotion: string, index: number }>}
 */
function extractDialogue(sceneCard) {
    if (!sceneCard || !Array.isArray(sceneCard.dialogue)) return [];

    return sceneCard.dialogue
        .filter(dl => dl && dl.character && dl.line)
        .map((dl, index) => ({
            character: dl.character,
            line: dl.line,
            emotion: VALID_EMOTIONS.includes(dl.emotion) ? dl.emotion : 'neutral',
            // The writer's own delivery note, carried whole. What it MEANS is
            // decided by lib/dialogue-delivery.js, which refuses what it does
            // not recognise rather than inventing a tag the model would speak.
            direction: typeof dl.direction === 'string' ? dl.direction : null,
            index,
        }));
}

/**
 * Build a payload for the POST /voice endpoint.
 *
 * @param {object} dialogueLine - { character, line, emotion, index }
 * @param {object|null} voiceProfile - film_voice_profiles row
 * @param {object|null} character - film_characters row
 * @returns {object} Payload for POST /voice
 */
function buildVoicePayload(dialogueLine, voiceProfile, character) {
    const payload = {
        text: dialogueLine.line,
        model: 'qwen3-tts',
        language: 'en',
        /*
         * `emotion` is NOT sent — ElevenLabs has no such field, and it was set
         * here for four phases and dropped one function short of the request.
         * The direction now goes through applyDelivery below, which turns it
         * into what the provider actually reads: an audio tag on a model that
         * understands one, and the style and stability dials on every model.
         */
        speed: 1.0,
        output_format: 'wav',
        sample_rate: 24000,
        stream: true,
    };

    if (voiceProfile) {
        let voiceParams = {};
        try { voiceParams = JSON.parse(voiceProfile.voice_params || '{}'); } catch (_) { voiceParams = {}; }
        if (voiceProfile.voice_id) payload.voice_id = voiceProfile.voice_id;
        if (!payload.voice_id && voiceParams.voice_id) payload.voice_id = voiceParams.voice_id;
        if (voiceProfile.speaker_embedding) payload.speaker_embedding = voiceProfile.speaker_embedding;
        if (voiceProfile.model) payload.model = voiceProfile.model;
        if (voiceProfile.tts_model) payload.model = voiceProfile.tts_model;
        if (voiceParams.model) payload.model = voiceParams.model;
        if (voiceProfile.language) payload.language = voiceProfile.language;
        if (voiceProfile.speed) payload.speed = voiceProfile.speed;
        if (voiceParams.speed) payload.speed = voiceParams.speed;
        if (voiceParams.stability) payload.stability = voiceParams.stability;
        if (voiceParams.similarity_boost) payload.similarity_boost = voiceParams.similarity_boost;
    }

    /*
     * The writer's own direction, carried to something that uses it.
     *
     * `(quietly)` is the delivery note in the screenplay and the parser already
     * extracts it. Applied AFTER the voice profile, so a character's default
     * settings are the baseline and the line's own direction overrides them —
     * which is the right precedence: a cast voice is how they always sound, a
     * parenthetical is how they say THIS line.
     */
    const { applyDelivery } = require('./dialogue-delivery');

    /*
     * The character's standing delivery, then the line's own.
     *
     * A cast voice is how somebody ALWAYS sounds — RAY is weary in every scene
     * — and a parenthetical is how they say THIS line. So the profile's
     * delivery is the baseline and the line's direction overrides it, which is
     * the same precedence the camera facets follow: staged beats written beats
     * the film's default.
     */
    if (voiceProfile) {
        let vp = {};
        try { vp = JSON.parse(voiceProfile.voice_params || '{}') || {}; } catch (_) { vp = {}; }
        if (vp.delivery) Object.assign(payload, applyDelivery(payload, vp.delivery));
    }
    Object.assign(payload, applyDelivery(payload, dialogueLine.direction || dialogueLine.emotion));

    if (character && character.name) {
        payload.character_name = character.name;
    }

    return payload;
}

/**
 * Build a filename for a dialogue audio clip.
 *
 * @param {string} shotCode
 * @param {string} characterName
 * @param {number} lineIndex
 * @returns {string} e.g. '1A_JOHN_0.wav'
 */
function dialogueFilename(shotCode, characterName, lineIndex) {
    const safeName = characterName.replace(/[^a-zA-Z0-9_-]/g, '_').toUpperCase();
    return `${shotCode}_${safeName}_${lineIndex}.wav`;
}

/**
 * Calculate total expected dialogue duration based on text length.
 * Rough estimate: ~150 words per minute, ~5 chars per word.
 *
 * @param {string} text
 * @param {number} [speed=1.0]
 * @returns {number} Estimated duration in ms
 */
function estimateDialogueDuration(text, speed) {
    const s = speed || 1.0;
    const words = text.split(/\s+/).length;
    const durationSec = (words / 150) * 60 / s;
    return Math.max(500, Math.round(durationSec * 1000));
}

module.exports = {
    extractDialogue,
    buildVoicePayload,
    dialogueFilename,
    estimateDialogueDuration,
    VALID_EMOTIONS,
};
