/**
 * FILM-018: Storyboard Prompt Engineering
 * FILM-021: Style Consistency (seed lock)
 *
 * Pure functions that transform scene cards into SDXL-optimized image prompts.
 * Maps scene card metadata to camera terms, lighting descriptions, and
 * character/style modifiers. No DB dependency.
 */

const { VALID_SHOT_TYPES, VALID_CAMERA_MOVES, VALID_LIGHTING } = require('./scene-card-schema');

// ── Shot Type → Camera Description ──────────────────────────────────

const SHOT_TYPE_MAP = {
    'wide': 'wide angle shot',
    'medium': 'medium shot',
    'close-up': 'close-up shot, detailed face',
    'extreme-close-up': 'extreme close-up, macro detail',
    'over-the-shoulder': 'over-the-shoulder shot',
    'two-shot': 'two-shot, two people in frame',
    'establishing': 'wide establishing shot, scenic',
    'aerial': 'aerial shot, bird\'s eye view, drone perspective',
    'low-angle': 'low angle shot, looking up',
    'high-angle': 'high angle shot, looking down',
    'dutch-angle': 'dutch angle, tilted frame',
    'pov': 'point of view shot, first person',
    'tracking': 'tracking shot',
    'dolly': 'dolly shot, smooth movement',
    'steadicam': 'steadicam shot, smooth handheld',
    'handheld': 'handheld camera, slight shake',
    'crane': 'crane shot, elevated camera movement',
    'insert': 'insert shot, close detail',
};

// ── Camera Movement → Motion Description ────────────────────────────

const MOVEMENT_MAP = {
    'static': '',
    'pan-left': 'camera panning left',
    'pan-right': 'camera panning right',
    'tilt-up': 'camera tilting up',
    'tilt-down': 'camera tilting down',
    'dolly-in': 'camera moving closer',
    'dolly-out': 'camera pulling away',
    'zoom-in': 'zooming in',
    'zoom-out': 'zooming out',
    'tracking-left': 'tracking left',
    'tracking-right': 'tracking right',
    'tracking-forward': 'tracking forward',
    'tracking-back': 'tracking backward',
    'crane-up': 'crane moving up',
    'crane-down': 'crane moving down',
    'orbit': 'orbiting around subject',
    'push-in': 'pushing in toward subject',
    'pull-out': 'pulling out from subject',
};

// ── Lighting Type → Lighting Description ────────────────────────────

const LIGHTING_MAP = {
    'natural': 'natural lighting',
    'golden-hour': 'warm golden hour sunlight',
    'blue-hour': 'cool blue hour ambient light',
    'overcast': 'overcast diffused lighting',
    'night': 'nighttime, dark atmosphere',
    'studio': 'studio lighting, controlled',
    'high-key': 'high-key bright even lighting',
    'low-key': 'low-key dramatic lighting, deep shadows',
    'silhouette': 'silhouette, backlit',
    'rim-light': 'rim lighting, edge-lit subject',
    'practical': 'practical lighting, visible light sources',
    'neon': 'neon lighting, vibrant colors',
    'candlelight': 'candlelight, warm flickering',
    'moonlight': 'moonlight, cool silver tone',
    'fluorescent': 'fluorescent lighting, cool white',
    'dramatic': 'dramatic lighting, strong shadows',
    'soft': 'soft diffused lighting',
    'hard': 'hard directional lighting, sharp shadows',
};

// ── Style Presets ───────────────────────────────────────────────────

const STYLE_PRESETS = {
    'cinematic': {
        suffix: 'cinematic, film grain, shallow depth of field, anamorphic',
        negative: 'cartoon, anime, watercolor, sketch, drawing, painting, cgi, 3d render',
    },
    'noir': {
        suffix: 'film noir, black and white, high contrast, dramatic shadows',
        negative: 'color, vibrant, cartoon, anime, cheerful',
    },
    'anime': {
        suffix: 'anime style, cel-shaded, vibrant colors, detailed illustration',
        negative: 'photorealistic, photo, 3d render, ugly, deformed',
    },
    'documentary': {
        suffix: 'documentary style, naturalistic, handheld feel, raw',
        negative: 'cartoon, anime, stylized, fantasy, unrealistic',
    },
    'horror': {
        suffix: 'horror atmosphere, unsettling, dark tones, high contrast',
        negative: 'bright, cheerful, cartoon, anime, colorful',
    },
    'fantasy': {
        suffix: 'epic fantasy, magical atmosphere, rich colors, detailed',
        negative: 'modern, urban, mundane, photorealistic',
    },
};

const DEFAULT_NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, ugly, bad anatomy, bad hands, watermark, text, logo';

// ── Prompt Builder ──────────────────────────────────────────────────

/**
 * Build an SDXL-optimized image prompt from a scene card.
 *
 * @param {object} sceneCard - Parsed scene card (from scene_card_yaml JSON)
 * @param {object[]} characters - Array of film_characters rows for this shot
 * @param {object|null} location - film_locations row or null
 * @param {string} [stylePreset] - Style preset name (cinematic, noir, etc.)
 * @returns {{ prompt: string, negative_prompt: string }}
 */
function buildStoryboardPrompt(sceneCard, characters, location, stylePreset) {
    const parts = [];
    const loraParts = [];

    // 1. Character LoRA/TI tokens and appearance
    const cardChars = sceneCard.characters || [];
    for (const cardChar of cardChars) {
        const charName = typeof cardChar === 'string' ? cardChar : cardChar.name;
        if (!charName) continue;

        const dbChar = (characters || []).find(
            c => c.name && c.name.toUpperCase() === charName.toUpperCase()
        );
        if (!dbChar) continue;

        if (dbChar.lora_id) {
            loraParts.push(`<lora:${dbChar.lora_id}:0.8>`);
        }
        if (dbChar.ti_token) {
            loraParts.push(dbChar.ti_token);
        }
        if (dbChar.appearance_prompt) {
            parts.push(dbChar.appearance_prompt);
        }
    }

    // 2. Subject / action description
    const subject = sceneCard.action || sceneCard.description || '';
    if (subject) {
        parts.push(subject);
    }

    // 3. Camera shot type
    const shotType = sceneCard.camera && sceneCard.camera.shot_type;
    if (shotType && SHOT_TYPE_MAP[shotType]) {
        parts.push(SHOT_TYPE_MAP[shotType]);
    }

    // 4. Lens
    const lens = sceneCard.camera && sceneCard.camera.lens;
    if (lens) {
        parts.push(`${lens} lens`);
    }

    // 5. Camera movement
    const movement = sceneCard.camera && sceneCard.camera.movement;
    if (movement && MOVEMENT_MAP[movement]) {
        parts.push(MOVEMENT_MAP[movement]);
    }

    // 6. Lighting
    const lightType = sceneCard.lighting && sceneCard.lighting.type;
    if (lightType && LIGHTING_MAP[lightType]) {
        parts.push(LIGHTING_MAP[lightType]);
    }
    const lightNotes = sceneCard.lighting && sceneCard.lighting.notes;
    if (lightNotes) {
        parts.push(lightNotes);
    }

    // 7. Location context
    if (location) {
        if (location.description) {
            parts.push(location.description);
        }
        if (location.lighting_default && !lightType) {
            parts.push(`${location.lighting_default} lighting`);
        }
    }

    // 8. Style preset
    const preset = stylePreset && STYLE_PRESETS[stylePreset];
    if (preset) {
        parts.push(preset.suffix);
    }

    // 9. Scene card style overrides
    if (sceneCard.style) {
        if (sceneCard.style.mood) parts.push(`${sceneCard.style.mood} mood`);
        if (sceneCard.style.color_palette) parts.push(`${sceneCard.style.color_palette} color palette`);
        if (sceneCard.style.film_grain) parts.push(`${sceneCard.style.film_grain} film grain`);
    }

    // 10. Quality tags
    parts.push('masterpiece, high quality');

    // Assemble prompt
    const loraPrefix = loraParts.length > 0 ? loraParts.join(' ') + ', ' : '';
    const prompt = loraPrefix + parts.filter(Boolean).join(', ');

    // Build negative prompt
    const negParts = [DEFAULT_NEGATIVE_PROMPT];
    if (preset && preset.negative) {
        negParts.push(preset.negative);
    }
    if (sceneCard.generation && sceneCard.generation.negative_prompt) {
        negParts.push(sceneCard.generation.negative_prompt);
    }
    const negative_prompt = negParts.join(', ');

    return { prompt, negative_prompt };
}

// ── Style Lock (FILM-021) ──────────────────────────────────────────

/**
 * Apply style lock for visual consistency within a scene.
 * Uses deterministic seed variation so shots within a scene share a visual style.
 *
 * @param {number} baseSeed - Scene-level base seed
 * @param {number} shotIndex - 0-based position of this shot within the scene
 * @param {object} [options]
 * @param {boolean} [options.styleLock=true] - Whether to enforce style lock
 * @param {number} [options.consistencyWeight=0.7] - IP-Adapter influence (0.0-1.0)
 * @param {string|null} [options.ipAdapterImage=null] - Path to reference image for IP-Adapter
 * @returns {{ seed: number|null, ip_adapter_image: string|null, ip_adapter_weight: number|null }}
 */
function applyStyleLock(baseSeed, shotIndex, options) {
    const opts = options || {};
    const styleLock = opts.styleLock !== false; // default true
    const consistencyWeight = typeof opts.consistencyWeight === 'number' ? opts.consistencyWeight : 0.7;
    const ipAdapterImage = opts.ipAdapterImage || null;

    if (!styleLock) {
        return { seed: null, ip_adapter_image: null, ip_adapter_weight: null };
    }

    const seed = baseSeed + shotIndex;

    if (ipAdapterImage && consistencyWeight > 0) {
        return {
            seed,
            ip_adapter_image: ipAdapterImage,
            ip_adapter_weight: consistencyWeight,
        };
    }

    return { seed, ip_adapter_image: null, ip_adapter_weight: null };
}

module.exports = {
    buildStoryboardPrompt,
    applyStyleLock,
    SHOT_TYPE_MAP,
    MOVEMENT_MAP,
    LIGHTING_MAP,
    STYLE_PRESETS,
    DEFAULT_NEGATIVE_PROMPT,
};
