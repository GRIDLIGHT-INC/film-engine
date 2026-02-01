/**
 * FILM-007: Scene Card YAML Schema & Validator
 *
 * Canonical scene card schema for shot descriptions.
 * Scene cards are YAML objects that define camera, lighting, characters,
 * dialogue, style, duration, and generation mode for each shot.
 */

const VALID_SHOT_TYPES = [
    'wide', 'medium', 'close-up', 'extreme-close-up', 'over-the-shoulder',
    'two-shot', 'establishing', 'aerial', 'low-angle', 'high-angle',
    'dutch-angle', 'pov', 'tracking', 'dolly', 'steadicam', 'handheld',
    'crane', 'insert'
];

const VALID_CAMERA_MOVES = [
    'static', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down',
    'dolly-in', 'dolly-out', 'zoom-in', 'zoom-out',
    'tracking-left', 'tracking-right', 'tracking-forward', 'tracking-back',
    'crane-up', 'crane-down', 'orbit', 'push-in', 'pull-out'
];

const VALID_LIGHTING = [
    'natural', 'golden-hour', 'blue-hour', 'overcast', 'night',
    'studio', 'high-key', 'low-key', 'silhouette', 'rim-light',
    'practical', 'neon', 'candlelight', 'moonlight', 'fluorescent',
    'dramatic', 'soft', 'hard'
];

const VALID_GEN_MODES = ['creative', 'locked'];

/**
 * Validate a single scene card object.
 * Returns { valid: true } or { valid: false, errors: [...] }
 */
function validateSceneCard(card) {
    const errors = [];

    if (!card || typeof card !== 'object') {
        return { valid: false, errors: ['Scene card must be an object'] };
    }

    // Required: shot_code
    if (!card.shot_code || typeof card.shot_code !== 'string') {
        errors.push('shot_code is required and must be a string (e.g. "1A", "12B")');
    }

    // Optional: description (string, max 2000)
    if (card.description !== undefined) {
        if (typeof card.description !== 'string') {
            errors.push('description must be a string');
        } else if (card.description.length > 2000) {
            errors.push('description must be 2000 characters or less');
        }
    }

    // Optional: camera object
    if (card.camera !== undefined) {
        if (typeof card.camera !== 'object') {
            errors.push('camera must be an object');
        } else {
            if (card.camera.shot_type && !VALID_SHOT_TYPES.includes(card.camera.shot_type)) {
                errors.push(`camera.shot_type must be one of: ${VALID_SHOT_TYPES.join(', ')}`);
            }
            if (card.camera.movement && !VALID_CAMERA_MOVES.includes(card.camera.movement)) {
                errors.push(`camera.movement must be one of: ${VALID_CAMERA_MOVES.join(', ')}`);
            }
            if (card.camera.lens !== undefined && typeof card.camera.lens !== 'string') {
                errors.push('camera.lens must be a string (e.g. "35mm", "85mm")');
            }
        }
    }

    // Optional: lighting object
    if (card.lighting !== undefined) {
        if (typeof card.lighting !== 'object') {
            errors.push('lighting must be an object');
        } else {
            if (card.lighting.type && !VALID_LIGHTING.includes(card.lighting.type)) {
                errors.push(`lighting.type must be one of: ${VALID_LIGHTING.join(', ')}`);
            }
            if (card.lighting.notes !== undefined && typeof card.lighting.notes !== 'string') {
                errors.push('lighting.notes must be a string');
            }
        }
    }

    // Optional: characters array
    if (card.characters !== undefined) {
        if (!Array.isArray(card.characters)) {
            errors.push('characters must be an array');
        } else {
            card.characters.forEach((ch, i) => {
                if (typeof ch === 'string') return; // Simple name reference
                if (typeof ch !== 'object') {
                    errors.push(`characters[${i}] must be a string or object`);
                    return;
                }
                if (!ch.name || typeof ch.name !== 'string') {
                    errors.push(`characters[${i}].name is required`);
                }
            });
        }
    }

    // Optional: dialogue array
    if (card.dialogue !== undefined) {
        if (!Array.isArray(card.dialogue)) {
            errors.push('dialogue must be an array');
        } else {
            card.dialogue.forEach((dl, i) => {
                if (typeof dl !== 'object') {
                    errors.push(`dialogue[${i}] must be an object`);
                    return;
                }
                if (!dl.character || typeof dl.character !== 'string') {
                    errors.push(`dialogue[${i}].character is required`);
                }
                if (!dl.line || typeof dl.line !== 'string') {
                    errors.push(`dialogue[${i}].line is required`);
                }
            });
        }
    }

    // Optional: style object
    if (card.style !== undefined && typeof card.style !== 'object') {
        errors.push('style must be an object');
    }

    // Optional: duration_ms (positive integer)
    if (card.duration_ms !== undefined) {
        if (typeof card.duration_ms !== 'number' || card.duration_ms < 0 || !Number.isInteger(card.duration_ms)) {
            errors.push('duration_ms must be a positive integer (milliseconds)');
        }
    }

    // Optional: generation mode
    if (card.generation_mode !== undefined && !VALID_GEN_MODES.includes(card.generation_mode)) {
        errors.push(`generation_mode must be one of: ${VALID_GEN_MODES.join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate an array of scene cards.
 */
function validateSceneCards(cards) {
    if (!Array.isArray(cards)) {
        return { valid: false, errors: ['Input must be an array of scene cards'] };
    }
    if (cards.length === 0) {
        return { valid: false, errors: ['At least one scene card is required'] };
    }

    const allErrors = [];
    cards.forEach((card, i) => {
        const result = validateSceneCard(card);
        if (!result.valid) {
            result.errors.forEach(err => allErrors.push(`Card ${i}: ${err}`));
        }
    });

    return { valid: allErrors.length === 0, errors: allErrors };
}

module.exports = {
    validateSceneCard,
    validateSceneCards,
    VALID_SHOT_TYPES,
    VALID_CAMERA_MOVES,
    VALID_LIGHTING,
    VALID_GEN_MODES
};
