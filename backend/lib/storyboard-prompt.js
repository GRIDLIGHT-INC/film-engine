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
/**
 * Providers cap the prompt. Runway's text_to_image rejects anything over ~1000
 * characters, and a well-described character plus a well-described location
 * plus an auteur style runs past 2,000 before the shot action is added -- so
 * every frame failed, and the fields that caused it were the ones a director
 * had just spent care writing.
 *
 * Trimming the assembled string would cut whatever happened to land last.
 * Instead each long descriptive field gets an allowance, cut on a sentence or
 * clause boundary so it degrades into a shorter description rather than a
 * severed phrase. Short structural parts (framing, lens, movement) are never
 * touched: they cost little and carry the shot.
 */
function trimToAllowance(text, allowance) {
    const t = String(text || '').trim();
    if (!allowance || t.length <= allowance) return t;

    const cut = t.slice(0, allowance);
    // Prefer a sentence end, then a clause, then a word.
    for (const boundary of [/[.!?]\s[^.!?]*$/, /,\s[^,]*$/, /\s\S*$/]) {
        const m = cut.match(boundary);
        if (m && m.index > allowance * 0.5) {
            return cut.slice(0, m.index + (boundary === /[.!?]\s[^.!?]*$/ ? 1 : 0)).trim().replace(/[,;]$/, '');
        }
    }
    return cut.trim();
}

// Character continuity outranks location continuity: a viewer notices a
// different face before a different porch. Both are generous enough to carry
// wardrobe and palette, and together they leave room for action and style.
// These sum to 880. With framing, lens, movement, lighting and the quality
// tail (~90) that leaves headroom under a 1000-char ceiling, so the final
// trim is a backstop rather than the thing that decides what survives. Sized
// so no single field can starve the rest: an unbounded action line was eating
// the budget and amputating location and style entirely.
const ACTION_ALLOWANCE = 300;
const APPEARANCE_ALLOWANCE = 240;
const LOCATION_ALLOWANCE = 200;
const STYLE_ALLOWANCE = 140;

/**
 * Last-resort ceiling.
 *
 * The per-field allowances handle the normal case, but a long action line can
 * still push the total over. 1000 is Runway text_to_image's limit and the
 * strictest of the providers wired here; a degraded prompt beats eight failed
 * generations. Overridable per call for a provider with more room.
 */
const MAX_PROMPT_CHARS = 1000;

const { previsFacets } = require('./previs-blocking');

/**
 * Blocking, expressed in the prompt's own vocabulary.
 *
 * Previs already reaches the VIDEO payload as camera_control. It did not reach
 * the image at all, so a director could solve a close-up on a 50 — a camera
 * 1.21m from the subject — and then generate a keyframe from the scene card's
 * text as though none of that had happened. The frame they approved was not the
 * frame they blocked, and the difference only surfaced in the video pass.
 */
function previsPromptParts(rawPrevis) {
    const previs = previsFacets(rawPrevis);
    if (!previs) return null;
    const parts = [];

    const framing = previs.shot_type || previs.framing;
    if (framing && SHOT_TYPE_MAP[framing]) parts.push(SHOT_TYPE_MAP[framing]);

    const focal = Number(previs.focal_mm);
    if (Number.isFinite(focal) && focal > 0) parts.push(`${Math.round(focal)}mm lens`);

    // Camera height against a standing eyeline IS the angle. Derived rather
    // than stored, because the stage already knows where the camera is and a
    // separate field could disagree with it.
    const h = Number(previs.camera_height_m);
    if (Number.isFinite(h)) {
        if (h <= 0.9) parts.push('low angle, camera looking up');
        else if (h >= 2.2) parts.push('high angle, camera looking down');
    }

    if (previs.movement && MOVEMENT_MAP[previs.movement]) parts.push(MOVEMENT_MAP[previs.movement]);

    // A solved distance is what makes framing a measurement rather than a word.
    const d = Number(previs.distance_m);
    if (Number.isFinite(d) && d > 0) parts.push(`camera ${d.toFixed(1)}m from subject`);

    return parts.length ? parts : null;
}

function buildStoryboardPrompt(sceneCard, characters, location, stylePreset, options) {
    const opts = options || {};
    // Subjects the caller has attached a reference image for. Empty map when
    // there are none, so the prose path below is unchanged for every project
    // that has not generated plates yet.
    // Two different questions. `references` means pictures are attached;
    // `tagged` means the provider lets the PROMPT address them as @tag. Meshy
    // conditions on a plain array with no names, so its prompt must keep
    // describing the subject — emitting "@maya" there replaced 240 characters
    // of appearance with a token meaning nothing to the model.
    const tagFor = (opts.references && opts.tagged !== false)
        ? require('./reference-images').taggedNames(opts.references)
        : new Map();

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
        // A reference image beats a paragraph: `@maya` IS the wardrobe, where
        // 240 characters of prose only approximates it. Carrying both would
        // spend the character budget describing what the picture already shows,
        // and the two can disagree — at which point the model is being asked to
        // reconcile them.
        const charTag = tagFor.get(String(charName).toUpperCase());
        if (charTag) {
            parts.push(`@${charTag}`);
        } else if (dbChar.appearance_prompt) {
            parts.push(trimToAllowance(dbChar.appearance_prompt, opts.appearanceAllowance || APPEARANCE_ALLOWANCE));
        }
    }

    // 2. Subject / action description
    const subject = sceneCard.action || sceneCard.description || '';
    if (subject) {
        parts.push(trimToAllowance(subject, opts.actionAllowance || ACTION_ALLOWANCE));
    }

    // 3-5. Camera: the blocking when the shot has been staged, otherwise the
    // scene card. Blocking WINS — the card is what was written, the blocking is
    // what was staged and approved, and generating the card's version would
    // show the director the shot they already moved past.
    // Merged PER FACET, not all-or-nothing. Blocking wins wherever it has an
    // opinion; the card fills the rest. Swapping the whole group looks
    // equivalent and is not: stored blocking knows its movement long before it
    // can derive a framing, so an all-or-nothing swap on a shot that was merely
    // staged dropped the card's framing AND lens and described the shot by its
    // movement alone — a blocked shot generated a vaguer frame than an
    // unblocked one, which is the exact opposite of the feature.
    const facets = previsFacets(opts.previs) || {};
    const cardCamera = sceneCard.camera || {};

    // 3. Camera shot type
    const blockedFraming = facets.shot_type || facets.framing;
    const shotType = (blockedFraming && SHOT_TYPE_MAP[blockedFraming])
        ? blockedFraming : cardCamera.shot_type;
    if (shotType && SHOT_TYPE_MAP[shotType]) {
        parts.push(SHOT_TYPE_MAP[shotType]);
    }

    // 4. Lens — the staged focal length, else whatever the card called it.
    const blockedFocal = Number(facets.focal_mm);
    if (Number.isFinite(blockedFocal) && blockedFocal > 0) {
        parts.push(`${Math.round(blockedFocal)}mm lens`);
    } else if (cardCamera.lens) {
        parts.push(`${cardCamera.lens} lens`);
    }

    // 4b. Camera height against a standing eyeline IS the angle. Derived rather
    // than stored, because the stage already knows where the camera is and a
    // separate field could disagree with it.
    const h = Number(facets.camera_height_m);
    if (Number.isFinite(h)) {
        if (h <= 0.9) parts.push('low angle, camera looking up');
        else if (h >= 2.2) parts.push('high angle, camera looking down');
    }

    // 5. Camera movement
    const movement = facets.movement || cardCamera.movement;
    if (movement && MOVEMENT_MAP[movement]) {
        parts.push(MOVEMENT_MAP[movement]);
    }

    // 5b. A solved distance is what makes framing a measurement rather than a
    // word. Blocking only — a card has never held one.
    const d = Number(facets.distance_m);
    if (Number.isFinite(d) && d > 0) parts.push(`camera ${d.toFixed(1)}m from subject`);

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
        const locTag = location.name && tagFor.get(String(location.name).toUpperCase());
        if (locTag) {
            parts.push(`@${locTag}`);
        } else if (location.description) {
            parts.push(trimToAllowance(location.description, opts.locationAllowance || LOCATION_ALLOWANCE));
        }
        if (location.lighting_default && !lightType) {
            parts.push(`${location.lighting_default} lighting`);
        }
    }

    // 8. Style preset
    //
    // STYLE_PRESETS is a six-key lookup, and film_projects.style_preset is a
    // free-text column. Anything outside those six -- "Guillermo del Toro
    // gothic: teal/amber, wet streets, anamorphic" -- missed the lookup and was
    // SILENTLY DROPPED: no error, no warning, just a prompt with no look in it.
    // A named preset still wins (it carries a matched negative prompt too);
    // anything else is passed through verbatim, because a director describing
    // their own film is the more useful case and the column already allowed it.
    const preset = stylePreset && STYLE_PRESETS[stylePreset];
    if (preset) {
        parts.push(preset.suffix);
    } else if (typeof stylePreset === 'string' && stylePreset.trim()) {
        parts.push(trimToAllowance(stylePreset, opts.styleAllowance || STYLE_ALLOWANCE));
    }

    // 9. Scene card style overrides
    if (sceneCard.style) {
        if (sceneCard.style.mood) parts.push(`${sceneCard.style.mood} mood`);
        if (sceneCard.style.color_palette) parts.push(`${sceneCard.style.color_palette} color palette`);
        if (sceneCard.style.film_grain) parts.push(`${sceneCard.style.film_grain} film grain`);
    }

    // 10. Locked consistency profile prompt contracts
    if (Array.isArray(opts.prompt_additions)) {
        for (const addition of opts.prompt_additions) {
            if (addition) parts.push(addition);
        }
    }

    // 11. Quality tags
    parts.push('masterpiece, high quality');

    // Assemble prompt
    const loraPrefix = loraParts.length > 0 ? loraParts.join(' ') + ', ' : '';
    const assembled = loraPrefix + parts.filter(Boolean).join(', ');
    const ceiling = opts.maxPromptChars || MAX_PROMPT_CHARS;
    const prompt = assembled.length <= ceiling
        ? assembled
        : trimToAllowance(assembled, ceiling);

    // Build negative prompt
    const negParts = [DEFAULT_NEGATIVE_PROMPT];
    if (preset && preset.negative) {
        negParts.push(preset.negative);
    }
    if (sceneCard.generation && sceneCard.generation.negative_prompt) {
        negParts.push(sceneCard.generation.negative_prompt);
    }
    if (Array.isArray(opts.negative_additions)) {
        for (const addition of opts.negative_additions) {
            if (addition) negParts.push(addition);
        }
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
    previsPromptParts,
    trimToAllowance,
    MAX_PROMPT_CHARS,
    ACTION_ALLOWANCE,
    APPEARANCE_ALLOWANCE,
    LOCATION_ALLOWANCE,
    STYLE_ALLOWANCE,
    buildStoryboardPrompt,
    applyStyleLock,
    SHOT_TYPE_MAP,
    MOVEMENT_MAP,
    LIGHTING_MAP,
    STYLE_PRESETS,
    DEFAULT_NEGATIVE_PROMPT,
};
