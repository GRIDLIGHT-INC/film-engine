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
 * What a director drew on the frame, when their marks feed generation.
 *
 * Sized between the action and the location on purpose. Direction is the
 * director's own words about THIS frame, so it outranks a stock description of
 * a place; it is not the shot itself, so it must not be able to starve the
 * action the way an unbounded field already did once.
 *
 * It only binds when the prompt overruns — the two-pass wrapper assembles whole
 * first — so a board with three notes and a roomy provider loses nothing.
 */
const DIRECTION_ALLOWANCE = 220;

/**
 * Last-resort ceiling.
 *
 * The per-field allowances handle the normal case, but a long action line can
 * still push the total over. 1000 is Runway text_to_image's limit and the
 * strictest of the providers wired here; a degraded prompt beats eight failed
 * generations. Overridable per call for a provider with more room.
 */
const MAX_PROMPT_CHARS = 1000;

/**
 * The allowances as a share of the ceiling, not as fixed numbers.
 *
 * 240 for an appearance and 200 for a location were never facts about
 * appearances and locations — they were a carve-up of MAX_PROMPT_CHARS, which
 * was Runway's 1000. Held fixed, a provider with four times the room received
 * exactly as much of what the director wrote, and the extra went unused.
 *
 * The shares are the old numbers divided by the old ceiling, so at 1000 this
 * reproduces them exactly and no existing project's prompts change shape. The
 * remaining 12% is the fixed vocabulary — shot type, lens, movement, lighting,
 * quality tags — which does not grow with the ceiling because it is a phrase
 * list rather than prose.
 */
const ALLOWANCE_SHARE = {
    action: ACTION_ALLOWANCE / MAX_PROMPT_CHARS,
    appearance: APPEARANCE_ALLOWANCE / MAX_PROMPT_CHARS,
    location: LOCATION_ALLOWANCE / MAX_PROMPT_CHARS,
    style: STYLE_ALLOWANCE / MAX_PROMPT_CHARS,
    direction: DIRECTION_ALLOWANCE / MAX_PROMPT_CHARS,
};

/**
 * Scale sentences for the subjects a card names.
 *
 * `opts.props` carries the prop rows, because the builder has never been given
 * them — props reach the prompt through the consistency contract, which has no
 * dimensions on it. `opts.frameCoverageWidthM` is what the lens covers at the
 * camera's distance, available only when a shot has been blocked, and applies
 * to the FRAMED subject alone: everything else in the shot is at some other
 * distance, and pricing it at the subject's coverage said a five-metre car
 * fills most of a seven-metre frame.
 */
function scaleNotesFor(sceneCard, characters, opts) {
    const { scalePhrase } = require('./subject-scale');
    const notes = [];
    const framed = String((opts && opts.framedSubject) || '').trim().toLowerCase();
    const coverage = Number(opts && opts.frameCoverageWidthM) > 0
        ? Number(opts.frameCoverageWidthM) : null;

    const named = new Set((Array.isArray(sceneCard.characters) ? sceneCard.characters : [])
        .map(n => String(n || '').trim().toLowerCase()));

    for (const ch of characters || []) {
        const name = String((ch && ch.name) || '').trim();
        if (!name || !named.has(name.toLowerCase())) continue;
        const note = scalePhrase(name, 'character', ch,
            name.toLowerCase() === framed ? coverage : null);
        if (note) notes.push(note);
    }

    const cardProps = new Set((Array.isArray(sceneCard.props) ? sceneCard.props : [])
        .map(n => String(n || '').trim().toLowerCase()));
    for (const prop of (opts && opts.props) || []) {
        const name = String((prop && prop.name) || '').trim();
        if (!name || !cardProps.has(name.toLowerCase())) continue;
        const note = scalePhrase(name, 'prop', prop,
            name.toLowerCase() === framed ? coverage : null);
        if (note) notes.push(note);
    }
    return notes;
}

function allowancesFor(ceiling) {
    const c = Number(ceiling) > 0 ? Number(ceiling) : MAX_PROMPT_CHARS;
    const out = {};
    for (const [field, share] of Object.entries(ALLOWANCE_SHARE)) out[field] = Math.round(share * c);
    return out;
}

const { previsFacets, effectiveCamera } = require('./previs-blocking');

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

/**
 * Build the prompt, trimming only if it will not otherwise fit.
 *
 * The per-field allowances used to apply unconditionally, so a 570-character
 * style was cut to 560 inside a prompt totalling 2,085 against a ceiling of
 * 4,000 — throwing away the tail of a director's look with 1,900 characters of
 * headroom going unused. The clause that vanished was "wet reflective ground
 * with specular sheen", which is exactly what someone puts on a board
 * deliberately.
 *
 * An allowance is a rule for deciding WHAT TO CUT when something must be cut.
 * It was being read as a target to shrink every field to. So: assemble whole,
 * and only carve up if the result overruns.
 */
function buildStoryboardPrompt(sceneCard, characters, location, stylePreset, options) {
    const opts = options || {};
    const ceiling = opts.maxPromptChars || MAX_PROMPT_CHARS;

    // The first pass must not trim AT ALL — neither per field nor at the
    // ceiling. Leaving the ceiling trim in place made it cut the untrimmed
    // assembly back at a clause boundary, which came in under budget and meant
    // the second pass never ran: the prompt ended up as one enormous field and
    // nothing else.
    const whole = assemblePrompt(sceneCard, characters, location, stylePreset, {
        ...opts,
        maxPromptChars: Infinity,
        allow: { action: Infinity, appearance: Infinity, location: Infinity, style: Infinity, direction: Infinity },
    });
    if (whole.prompt.length <= ceiling) return whole;

    return assemblePrompt(sceneCard, characters, location, stylePreset,
        { ...opts, allow: allowancesFor(ceiling) });
}

function assemblePrompt(sceneCard, characters, location, stylePreset, options) {
    const opts = options || {};
    // Everything downstream measures against the ceiling actually in play, so a
    // roomier provider receives more of what was written rather than the same
    // truncation with headroom to spare.
    const ceiling = opts.maxPromptChars || MAX_PROMPT_CHARS;
    // Supplied by the two-pass wrapper: unlimited on the first pass, the real
    // carve-up on the second.
    const allow = opts.allow || allowancesFor(ceiling);
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
            parts.push(trimToAllowance(dbChar.appearance_prompt, opts.appearanceAllowance || allow.appearance));
        }
    }

    // 2. Subject / action description
    const subject = sceneCard.action || sceneCard.description || '';
    if (subject) {
        parts.push(trimToAllowance(subject, opts.actionAllowance || allow.action));
    }

    // 2b. How big everything is — AFTER the shot, never before it.
    //
    // These first led the prompt, on the reasoning that "who is here and how big
    // they are" reads as one statement. That was wrong, and expensively so: an
    // establishing wide down a cul-de-sac opened with "Sprinkler is roughly 1.4
    // times smaller than a car tyre… SEDAN is roughly 1.2 times the size of a
    // parked car", and the shot itself did not begin until character 178. The
    // model did exactly what it was told — it made the two measured objects the
    // subject and put both dead centre of the frame, a car parked in the middle
    // of the road and a sprinkler on the pavement.
    //
    // Whatever leads a prompt is what the image is OF. A measurement is a
    // qualifier on something already in the scene, so it goes after the scene.
    const scaleParts = scaleNotesFor(sceneCard, characters, opts);
    if (scaleParts.length) parts.push(`Scale: ${scaleParts.join('; ')}`);

    // 2c. What the director drew on the frame (PAR-026), when their marks feed
    // generation. Off unless a caller passes annotations, so a project that has
    // not opted in builds byte-identically to before.
    //
    // Placed HERE — after the shot, before the camera — for the reason the
    // scale notes were moved: whatever leads a prompt is what the image is of,
    // and "remove the sprinkler" at the head of a prompt makes the sprinkler the
    // subject of the frame it was asking to be rid of. It sits before the
    // camera rather than at the tail because a provider truncates the tail, and
    // a director's explicit instruction is the last thing that should be lost to
    // a ceiling.
    //
    // Only marks carrying a note contribute. A shape with no words says where
    // and not what; the caller reports those rather than dropping them quietly.
    if (Array.isArray(opts.annotations) && opts.annotations.length) {
        const { directionClause } = require('./annotation-prompt');
        const direction = directionClause(opts.annotations);
        if (direction.text) {
            parts.push(trimToAllowance(direction.text, opts.directionAllowance || allow.direction));
        }
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

    // One precedence rule, shared with the board. It used to live here alone,
    // and the board displayed the card's facets — so a blocked shot showed a
    // lens and a framing that generation was not going to use.
    const effective = effectiveCamera(cardCamera, opts.previs, opts.filmOptics,
        { framingIsUsable: f => !!SHOT_TYPE_MAP[f] });

    // 3. Camera shot type
    const shotType = effective.shot_type.value;
    if (shotType && SHOT_TYPE_MAP[shotType]) {
        parts.push(SHOT_TYPE_MAP[shotType]);
    }

    // 4. Lens — staged, else what the card called it, else what the production
    // shoots on. That last fallback is the whole point of choosing a lens on
    // the board: without it the choice only reached shots someone had opened
    // the 3D stage for.
    if (effective.lens.value) parts.push(`${effective.lens.value} lens`);

    // 4b. Camera height against a standing eyeline IS the angle. Derived rather
    // than stored, because the stage already knows where the camera is and a
    // separate field could disagree with it.
    const h = Number(facets.camera_height_m);
    if (Number.isFinite(h)) {
        if (h <= 0.9) parts.push('low angle, camera looking up');
        else if (h >= 2.2) parts.push('high angle, camera looking down');
    }

    // 5. Camera movement
    const movement = effective.movement.value;
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
            parts.push(trimToAllowance(location.description, opts.locationAllowance || allow.location));
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
        parts.push(trimToAllowance(stylePreset, opts.styleAllowance || allow.style));
    }

    // 8b. The frame this scene is measured against.
    //
    // Placed with the look because that is what it carries: light, palette and
    // grade. It says so explicitly rather than "matching the reference", which
    // a model reads as matching its COMPOSITION — and a scene of eight frames
    // that all copy the establishing shot's staging is a worse failure than the
    // drift this exists to fix. The negative names that failure directly.
    //
    // Tag-only. A provider that cannot address references from the prompt gets
    // an unexplained extra picture competing with the plates, with nothing to
    // say it is there for the light; the caller declines to attach it at all in
    // that case, and this stays silent to match.
    if (opts.anchorTag) {
        const { anchorPhrase } = require('./scene-anchor');
        const phrase = anchorPhrase(opts.anchorTag);
        if (phrase) parts.push(phrase);
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
    const prompt = assembled.length <= ceiling
        ? assembled
        : trimToAllowance(assembled, ceiling);

    // Build negative prompt
    const negParts = [DEFAULT_NEGATIVE_PROMPT];
    if (opts.anchorTag) negParts.push(require('./scene-anchor').ANCHOR_NEGATIVE);
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
    allowancesFor,
    scaleNotesFor,
    ALLOWANCE_SHARE,
    previsPromptParts,
    trimToAllowance,
    MAX_PROMPT_CHARS,
    ACTION_ALLOWANCE,
    APPEARANCE_ALLOWANCE,
    LOCATION_ALLOWANCE,
    STYLE_ALLOWANCE,
    DIRECTION_ALLOWANCE,
    buildStoryboardPrompt,
    applyStyleLock,
    SHOT_TYPE_MAP,
    MOVEMENT_MAP,
    LIGHTING_MAP,
    STYLE_PRESETS,
    DEFAULT_NEGATIVE_PROMPT,
};
