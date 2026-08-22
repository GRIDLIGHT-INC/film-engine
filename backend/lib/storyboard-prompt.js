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


/**
 * Who gets the prompt when there is not enough of it.
 *
 * Prompt assembly was an automatic negotiation between a dozen contributors
 * with no stated order, and the outcome flipped on lengths nobody was watching.
 * On one real shot the director's 1,253-character direction was cut to 156 while
 * 3,217 characters of subject prose survived; on the same shot a week later the
 * base prompt filled the ceiling and NO locked contract fitted at all. Neither
 * result was chosen by anyone.
 *
 * So the contributors are ranked, and trimming walks this list backwards.
 *
 * The ordering principle: **the shot is what you asked for; the subjects are
 * what happen to be in it.** A prompt that describes subjects at length and the
 * shot briefly produces a picture of the subjects — which is exactly what
 * happened when a request for a wide shot of a dragon's back came back as a
 * portrait, because the prompt opened with "Woman in her mid-thirties…".
 *
 * `protected` means never trimmed. That is affordable only because every
 * protected contributor is SHORT by construction — a camera note is capped by
 * the card validator, and the camera facets are a phrase list. The direction is
 * the one long protected field, and it is protected because it is the only text
 * in the prompt that a person deliberately wrote about this shot.
 */
const PROMPT_PRIORITY = [
    { id: 'camera_note', protected: true,
      why: 'a short, deliberate instruction about where the camera is — the last thing that should be lost' },
    { id: 'anchor', protected: true,
      why: 'names the scene being re-shot; without it the attached frame is an unexplained picture' },
    { id: 'direction', protected: true,
      why: 'the shot itself. The only text in the prompt a person wrote about THIS frame' },
    /*
     * Where the subjects stand. Ranked with the shot rather than with the
     * subjects, because "the dragon is in the near foreground with its back to
     * us" is not a fact about dragons — it is what this frame IS, and it is the
     * half of directing that had no way to reach a prompt at all. Protected and
     * naturally short: it is bounded by the number of NAMED staged objects,
     * which is a handful, so it cannot do what an unbounded field did to the
     * budget once already.
     */
    { id: 'staging', protected: true,
        why: 'where the subjects stand, said from this camera. Blocking, not decoration' },
    { id: 'camera', protected: true,
      why: 'framing, lens, angle and movement — a phrase list, cheap to keep and the shot without it is a guess' },
    { id: 'annotations', protected: true, cap: 0.25,
      why: 'marks the director drew on the frame — deliberate, so never cut, but capped: forty notes '
         + 'would otherwise eat the prompt, which is the unbounded-field failure this codebase has '
         + 'already paid for once' },
    { id: 'lighting', protected: false,
      why: 'sets the hour; recoverable from the anchor or the look when it has to go' },
    { id: 'style', protected: false,
      why: 'the film\'s look. Cut before the shot, kept before the subjects' },
    { id: 'scale', protected: false,
      why: 'how big things are — matters most when a subject has no plate, which is when the prose is long anyway' },
    { id: 'appearance', protected: false,
      why: 'what a subject looks like. Cut before the shot: the frame can survive an approximate face, not an absent camera' },
    { id: 'location', protected: false,
      why: 'the place in the abstract, and the anchor or the plate says it better' },
    { id: 'contracts', protected: false,
      why: 'locked profile prose. Longest, most duplicated by the attached plates, cut first' },
    { id: 'quality', protected: false,
      why: 'fixed tags. Last in and first out, because they add nothing a model cannot infer' },
];

/*
 * `cap` is a share of the ceiling applied BEFORE assembly, and it is what makes
 * `protected` safe. Protection with no bound is how an unbounded field ate the
 * budget and amputated the location and the style — so the two contributors that
 * a person can make arbitrarily long are bounded: `camera_note` by the card
 * validator at 400 characters, `annotations` here at a quarter of the ceiling.
 *
 * `direction` is deliberately uncapped. It is the shot, it is why the frame
 * exists, and cutting it is the defect all of this was written to fix.
 */

/**
 * What a director is doing to this shot right now.
 *
 * Two different jobs wearing one button. Blocking the ACTION means saying what
 * happens; blocking the CAMERA means keeping everything and moving where you
 * stand. Asking one prompt shape to serve both is why "put the camera on the
 * other side" kept producing a different scene.
 */
const DIRECTION_MODES = {
    action: {
        label: 'Direct the action',
        description: 'What happens in the shot. The scene is built from the card, and every subject '
            + 'is described so the model can construct it.',
    },
    camera: {
        label: 'Direct the camera',
        description: 'The scene is LOCKED — same location, same people, same props, same light — and '
            + 'only the camera changes. Requires a frame to keep: the anchor is attached and the '
            + 'subjects in it shorten to their names, so the whole prompt is about where the camera '
            + 'stands and what faces it.',
        requires_anchor: true,
    },
};

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

    /*
     * Collected BY CONTRIBUTOR rather than into one flat list, so that when the
     * prompt overruns it is possible to say who gives way. A flat array can
     * only be cut from the end, which is why the director's shot description
     * used to be lost while a paragraph about a car's chrome survived.
     */
    const collected = new Map();
    const add = (id, text) => {
        const t = String(text || '').trim();
        if (!t) return;
        if (!collected.has(id)) collected.set(id, []);
        collected.get(id).push(t);
    };
    const loraParts = [];

    // A short, deliberate instruction about where the camera is. Leads, because
    // it is a statement about the SHOT rather than about a subject — and the
    // rule this codebase learned expensively is that whatever leads a prompt is
    // what the image is of. Capped by the card validator, which is what makes
    // "never trimmed" affordable.
    if (sceneCard.camera && sceneCard.camera.note) add('camera_note', sceneCard.camera.note);

    // 0. The scene this shot is being taken OF, when one is attached.
    //
    // Leads deliberately. "Whatever leads a prompt is what the image is of" is
    // the rule that moved the scale notes out of first position, and here the
    // leading statement is true: the image IS of that location with those
    // things in those places. What follows is the new camera on it.
    //
    // Present only when the caller attached the frame AND can address it, so a
    // project with no anchor builds byte-identically.
    if (opts.anchorAttached) {
        add('anchor', require('./shot-anchor').anchorLeadPhrase(opts.anchorTag));
    }

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
        // In camera mode the scene is locked and its frame is attached, so a
        // subject in that frame needs NAMING rather than describing — the same
        // rule the anchor already uses, and safe here for the same reason: the
        // picture is definitely in the payload, because camera mode refuses to
        // run without it.
        const covered = (opts.anchorCovers || []).some(
            n => String(n).toUpperCase() === String(charName).toUpperCase());
        if (charTag) {
            add('appearance', `@${charTag}`);
        } else if (covered && opts.directionMode === 'camera') {
            add('appearance', String(charName).toUpperCase());
        } else if (dbChar.appearance_prompt) {
            add('appearance', dbChar.appearance_prompt);
        }
    }

    /*
     * 2. What the shot IS: the screenplay, then what the director added.
     *
     * These are two different things and they are kept two different things.
     * `description` is the writing — the source, re-derivable from the script.
     * `direction` is what a director asked for ON TOP of it while looking at a
     * frame that came back wrong. Joining them here rather than storing one
     * blended string is what keeps a screenplay revision able to replace its
     * own half without discarding the direction, and lets the board show the
     * writing rather than a paraphrase of it.
     *
     * The screenplay leads, because it is what the shot is; the direction
     * follows, because it is a modification of that.
     */
    const written = sceneCard.action || sceneCard.description || '';
    const directed = String(sceneCard.direction || '').trim();
    const subject = [written, directed].filter(Boolean).join('. ').replace(/\.\.\s/g, '. ');
    if (subject) {
        add('direction', subject);
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
    if (scaleParts.length) add('scale', `Scale: ${scaleParts.join('; ')}`);

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
            add('annotations', direction.text);
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

    /*
     * Blocking reaches the prompt. Emitted from the RAW blocking rather than
     * from `facets`, because the staging phrases are computed against the
     * camera pose and the object rotations, neither of which survives the
     * flattening into prompt facets.
     */
    {
        const { stagingPhrase } = require('./shot-staging');
        const staged = stagingPhrase(opts.previs);
        if (staged) add('staging', staged);
    }
    const cardCamera = sceneCard.camera || {};

    // One precedence rule, shared with the board. It used to live here alone,
    // and the board displayed the card's facets — so a blocked shot showed a
    // lens and a framing that generation was not going to use.
    const effective = effectiveCamera(cardCamera, opts.previs, opts.filmOptics,
        { framingIsUsable: f => !!SHOT_TYPE_MAP[f] });

    // 3. Camera shot type
    const shotType = effective.shot_type.value;
    if (shotType && SHOT_TYPE_MAP[shotType]) {
        add('camera', SHOT_TYPE_MAP[shotType]);
    }

    // 4. Lens — staged, else what the card called it, else what the production
    // shoots on. That last fallback is the whole point of choosing a lens on
    // the board: without it the choice only reached shots someone had opened
    // the 3D stage for.
    if (effective.lens.value) add('camera', `${effective.lens.value} lens`);

    // 4b. Camera height against a standing eyeline IS the angle.
    //
    // Read from the blocking when a shot is staged, and OTHERWISE FROM THE CARD
    // — which it was not, and the gap was invisible because `camera.height_m`
    // is a validated field. A director could write it, the card would save, and
    // it reached nothing unless somebody had also opened the 3D stage. That is
    // the same defect class as the mood-board specs that validated and were
    // consumed nowhere.
    //
    // It matters more than it looks, because VALID_SHOT_TYPES mixes three
    // independent axes: framing (wide, medium, close-up), angle (low-angle,
    // high-angle, dutch-angle) and rig (tracking, dolly, handheld). `shot_type`
    // holds exactly one, so "a low-angle wide" is unsayable there — you pick
    // the framing or the angle and lose the other. Height is the second axis,
    // and reading it from the card is what makes the pair sayable without
    // blocking the shot in 3D.
    const h = Number.isFinite(Number(facets.camera_height_m))
        ? Number(facets.camera_height_m)
        : Number(cardCamera.height_m);
    if (Number.isFinite(h)) {
        if (h <= 0.9) add('camera', 'low angle, camera looking up');
        else if (h >= 2.2) add('camera', 'high angle, camera looking down');
    }

    // 5. Camera movement — the whole move when a sequence was blocked.
    //
    // A still can only ever show the START of a move, so this is a phrase
    // naming what the camera does rather than an attempt to depict motion. But
    // naming only the first leg, or only the dominant one, describes a
    // different shot from the one that was staged: "moving closer" and "moving
    // closer, then panning right" end in different places.
    const legs = Array.isArray(facets.moves) ? facets.moves : null;
    const movement = effective.movement.value;
    if (legs && legs.length > 1) {
        const phrases = legs.map(m => MOVEMENT_MAP[m]).filter(Boolean);
        if (phrases.length > 1) add('camera', phrases.join(', then '));
        else if (phrases.length === 1) add('camera', phrases[0]);
    } else if (movement && MOVEMENT_MAP[movement]) {
        add('camera', MOVEMENT_MAP[movement]);
    }

    // 5b. A solved distance is what makes framing a measurement rather than a
    // word. Blocking only — a card has never held one.
    const d = Number(facets.distance_m);
    if (Number.isFinite(d) && d > 0) add('camera', `camera ${d.toFixed(1)}m from subject`);

    // 6. Lighting
    const lightType = sceneCard.lighting && sceneCard.lighting.type;
    if (lightType && LIGHTING_MAP[lightType]) {
        add('lighting', LIGHTING_MAP[lightType]);
    }
    const lightNotes = sceneCard.lighting && sceneCard.lighting.notes;
    if (lightNotes) {
        add('lighting', lightNotes);
    }

    // 7. Location context
    if (location) {
        const locTag = location.name && tagFor.get(String(location.name).toUpperCase());
        if (locTag) {
            add('location', `@${locTag}`);
        } else if (location.description) {
            add('location', location.description);
        }
        if (location.lighting_default && !lightType) {
            add('lighting', `${location.lighting_default} lighting`);
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
        add('style', preset.suffix);
    } else if (typeof stylePreset === 'string' && stylePreset.trim()) {
        add('style', stylePreset);
    }

    // 8b. Continuity of light, restated beside the look.
    //
    // The lead phrase above establishes the world; this sits with the style
    // because grade is the part of continuity the style preset can otherwise
    // overwrite — a look appended after the scene has been described will
    // happily regrade it.
    if (opts.anchorAttached) {
        const phrase = require('./shot-anchor').anchorPhrase(opts.anchorTag);
        if (phrase) add('style', phrase);
    }

    // 9. Scene card style overrides
    if (sceneCard.style) {
        if (sceneCard.style.mood) add('style', `${sceneCard.style.mood} mood`);
        if (sceneCard.style.color_palette) add('style', `${sceneCard.style.color_palette} color palette`);
        if (sceneCard.style.film_grain) add('style', `${sceneCard.style.film_grain} film grain`);
    }

    // 10. Locked consistency profile prompt contracts
    if (Array.isArray(opts.prompt_additions)) {
        for (const addition of opts.prompt_additions) {
            if (addition) add('contracts', addition);
        }
    }

    // 11. Quality tags
    add('quality', 'masterpiece, high quality');

    // Assemble prompt
    /*
     * Assemble in priority order, and trim from the BOTTOM of it.
     *
     * The old scheme gave every field a fixed share of the ceiling and cut each
     * one to fit, which meant a long direction was cut even when there was room,
     * and — worse — cut at all while lower-ranked prose survived untouched.
     * Walking the ranking backwards means the things that give way are the ones
     * the plates and the anchor already carry.
     */
    const loraPrefix = loraParts.length > 0 ? loraParts.join(' ') + ', ' : '';
    const ordered = PROMPT_PRIORITY
        .map(c => {
            let text = (collected.get(c.id) || []).join(', ');
            // Capped before anything else sees it, so a protected contributor
            // cannot claim more of the ceiling than it was ever meant to have.
            if (c.cap && text.length > ceiling * c.cap) {
                text = trimToAllowance(text, Math.floor(ceiling * c.cap));
            }
            return { ...c, text };
        })
        .filter(c => c.text);

    const join = list => loraPrefix + list.map(c => c.text).filter(Boolean).join(', ');

    /*
     * The protected set is kept whole; what is left is shared out among the
     * rest, in rank order.
     *
     * An earlier version of this loop dropped whole contributors from the bottom
     * before shortening anything above them, which starved the lowest rank: a
     * long appearance survived at length while the location vanished entirely,
     * so the frame knew who but not where. That is the failure the per-field
     * allowances were originally written to prevent, and losing it while fixing
     * a different problem would have traded one defect for another.
     *
     * So: an even split of what remains, in rank order, with anything a
     * contributor does not use inherited by the ones after it — the same
     * algorithm `fitAdditions` uses for locked contracts, for the same reason.
     * Rank decides who is served first, not who is served alone.
     */
    const held = ordered.filter(c => c.protected);
    const flexible = ordered.filter(c => !c.protected);
    let room = ceiling - join(held).length - (flexible.length * 2);

    const fitted = [];
    for (let i = 0; i < flexible.length; i++) {
        const share = Math.floor(room / (flexible.length - i));
        if (share <= 40) break;              // too little to say anything true
        const text = flexible[i].text.length <= share
            ? flexible[i].text
            : trimToAllowance(flexible[i].text, share);
        if (!text) continue;
        fitted.push({ ...flexible[i], text });
        room -= text.length + 2;
    }

    // Back into rank order, so the prompt still reads shot-first.
    const byId = new Map([...held, ...fitted].map(c => [c.id, c]));
    const kept = ordered.map(c => byId.get(c.id)).filter(Boolean);

    const assembled = join(kept);
    const prompt = assembled.length <= ceiling ? assembled : trimToAllowance(assembled, ceiling);

    /*
     * Who got what, so a director can SEE the negotiation.
     *
     * "It does a lot without my control in the background" is the real
     * complaint, and the answer to it is not a better default — it is being able
     * to look. Every contributor reports what it wanted, what it got, and
     * whether it could have been cut.
     */
    const budget = ordered.map(c => {
        const survivor = kept.find(k => k.id === c.id);
        return {
            contributor: c.id,
            protected: c.protected,
            wanted: c.text.length,
            chars: survivor ? survivor.text.length : 0,
            cut: c.text.length - (survivor ? survivor.text.length : 0),
            why: c.why,
        };
    });

    // Build negative prompt
    const negParts = [DEFAULT_NEGATIVE_PROMPT];
    if (opts.anchorAttached) negParts.push(require('./shot-anchor').ANCHOR_NEGATIVE);
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

    return { prompt, negative_prompt, budget, ceiling };
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
    PROMPT_PRIORITY,
    DIRECTION_MODES,
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
