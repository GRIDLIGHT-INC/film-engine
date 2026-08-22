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

// Sensor formats a scene card may name, taken from the previs optics registry
// rather than retyped: a card that validates against a sensor the maths does not
// know is a card that cannot be blocked.
const VALID_SENSORS = Object.keys(require('./previs-camera').SENSORS);

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

    /*
     * Optional: direction — what the DIRECTOR adds on top of the screenplay.
     *
     * `description` is the writing: what the screenplay says this shot is. It
     * is the source, and a board that shows something else is showing a
     * paraphrase of the film. So a director's contribution is a SEPARATE,
     * ADDITIVE field rather than an edit to the description — which keeps the
     * screenplay half re-derivable when the script is revised, and makes
     * "what was written" and "what I asked for on top" two answerable
     * questions instead of one blended string nobody can unpick.
     */
    if (card.direction !== undefined && card.direction !== null) {
        if (typeof card.direction !== 'string') {
            errors.push('direction must be a string');
        } else if (card.direction.length > 2000) {
            errors.push('direction must be 2000 characters or less');
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
            /*
             * A short, deliberate instruction about where the camera is — the
             * one contributor that is never trimmed, which is affordable only
             * because it is capped here. Uncapped, "never trimmed" would let a
             * thousand-word note push every subject out of the prompt, and the
             * protection would become the defect.
             *
             * 400 is two or three sentences: "Camera on the far side of the
             * street looking back; dragon's back to camera; MAYA faces us."
             * Anything longer is the shot description, which has its own field
             * and is also protected.
             */
            if (card.camera.note !== undefined) {
                if (typeof card.camera.note !== 'string') {
                    errors.push('camera.note must be a string');
                } else if (card.camera.note.length > 400) {
                    errors.push(`camera.note must be 400 characters or fewer (got ${card.camera.note.length}) `
                        + '— it is never trimmed, so it has to stay short. Put the rest in the description.');
                }
            }
            if (card.camera.lens !== undefined && typeof card.camera.lens !== 'string') {
                errors.push('camera.lens must be a string (e.g. "35mm", "85mm")');
            }

            // Optical fields for 3D previs. All optional, and `lens` stays the
            // free string it has always been: every scene card written before
            // previs existed must keep validating, so these are added beside it
            // rather than replacing it. Parsing "35mm" into a number would be
            // lossy ("35mm anamorphic"), and a card can carry both.
            if (card.camera.sensor !== undefined && !VALID_SENSORS.includes(card.camera.sensor)) {
                errors.push(`camera.sensor must be one of: ${VALID_SENSORS.join(', ')}`);
            }
            if (card.camera.aperture !== undefined
                && (typeof card.camera.aperture !== 'number' || !(card.camera.aperture > 0))) {
                errors.push('camera.aperture must be a positive number (the f-number, e.g. 2.8)');
            }
            if (card.camera.focus_distance_m !== undefined
                && (typeof card.camera.focus_distance_m !== 'number' || !(card.camera.focus_distance_m > 0))) {
                errors.push('camera.focus_distance_m must be a positive number of metres');
            }
            if (card.camera.height_m !== undefined
                && (typeof card.camera.height_m !== 'number' || !Number.isFinite(card.camera.height_m))) {
                errors.push('camera.height_m must be a number of metres above the floor');
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
    VALID_GEN_MODES,
    VALID_SENSORS
};
