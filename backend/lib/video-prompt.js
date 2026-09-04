/**
 * FILM-029-035: Video Prompt Builder
 *
 * Pure functions for building video generation payloads from scene cards.
 * Maps camera movements to video-specific camera_control params and
 * calculates frame/duration parameters.
 */

const { buildStoryboardPrompt, MOVEMENT_MAP } = require('./storyboard-prompt');
const { VALID_CAMERA_MOVES } = require('./scene-card-schema');

// ── Camera Control Map ──────────────────────────────────────────────
// Maps scene card camera.movement to video generation camera_control payload

const CAMERA_CONTROL_MAP = {
    'static': { type: 'static', intensity: 0.0 },
    'pan-left': { type: 'pan-left', intensity: 0.5 },
    'pan-right': { type: 'pan-right', intensity: 0.5 },
    'tilt-up': { type: 'tilt-up', intensity: 0.5 },
    'tilt-down': { type: 'tilt-down', intensity: 0.5 },
    'dolly-in': { type: 'dolly-in', intensity: 0.5 },
    'dolly-out': { type: 'dolly-out', intensity: 0.5 },
    'zoom-in': { type: 'zoom-in', intensity: 0.6 },
    'zoom-out': { type: 'zoom-out', intensity: 0.6 },
    'tracking-left': { type: 'tracking-left', intensity: 0.5 },
    'tracking-right': { type: 'tracking-right', intensity: 0.5 },
    'tracking-forward': { type: 'tracking-forward', intensity: 0.5 },
    'tracking-back': { type: 'tracking-back', intensity: 0.5 },
    'crane-up': { type: 'crane-up', intensity: 0.6 },
    'crane-down': { type: 'crane-down', intensity: 0.6 },
    'orbit': { type: 'orbit', intensity: 0.7 },
    'push-in': { type: 'push-in', intensity: 0.5 },
    'pull-out': { type: 'pull-out', intensity: 0.5 },
};

// Default video parameters
const DEFAULT_FPS = 24;
const DEFAULT_GEN_FPS = 8;     // AnimateDiff native generation fps
const DEFAULT_NUM_FRAMES = 16; // AnimateDiff native frame count
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 576;    // 16:9 at 1024 wide
const DEFAULT_STEPS = 25;
const DEFAULT_GUIDANCE = 7.5;

/**
 * Build a video generation payload from a scene card.
 * Reuses the storyboard prompt builder for the text prompt,
 * then adds video-specific parameters.
 *
 * @param {object} sceneCard - Parsed scene_card_yaml
 * @param {object[]} characters - film_characters rows
 * @param {object|null} location - film_locations row
 * @param {string} [stylePreset] - Style preset name
 * @returns {{ prompt: string, negative_prompt: string, camera_control: object }}
 */
function buildVideoPrompt(sceneCard, characters, location, stylePreset, options) {
    const opts = options || {};
    // Keep the director-owned card fields explicit at the hand-off. The video
    // prompt reuses the storyboard builder, so direction, lighting and the
    // chosen location_view must cross this boundary together with staged
    // camera/blocking context rather than relying on an opaque whole object.
    const promptedCard = {
        ...sceneCard,
        direction: sceneCard && sceneCard.direction,
        lighting: sceneCard && sceneCard.lighting,
        location_view: sceneCard && sceneCard.location_view,
    };
    // Reuse storyboard prompt for text prompt
    const { prompt, negative_prompt } = buildStoryboardPrompt(
        promptedCard, characters, location, stylePreset, {
            prompt_additions: opts.prompt_additions,
            negative_additions: opts.negative_additions,
            // The markup a director drew on the board. It reaches the clip for
            // the reason it cannot reach much of the frame: an arrow is about
            // what happens NEXT, and a clip is the only artefact with room for
            // that. Undefined unless the project opted in, so an unmarked shot
            // builds byte-identically.
            annotations: opts.annotations,
            previs: opts.previs,
            filmOptics: opts.filmOptics,
            props: opts.props,
        }
    );

    // Map camera movement
    const pathAnalysis = opts.previs && Array.isArray(opts.previs.cameraKeys) && opts.previs.cameraKeys.length > 1
        ? require('./previs-blocking').analyzePath(opts.previs.path || opts.previs.cameraKeys) : null;
    const movement = (pathAnalysis && pathAnalysis.dominantMovement)
        || (sceneCard.camera && sceneCard.camera.movement);
    const camera_control = (movement && CAMERA_CONTROL_MAP[movement])
        ? { ...CAMERA_CONTROL_MAP[movement] }
        : { type: 'static', intensity: 0.0 };

    // Previs, when the shot has been blocked in 3D. STRICTLY ADDITIVE: `type`
    // and `intensity` are left exactly as the movement enum defines them, so a
    // blocked shot generates what an unblocked one would plus a path — blocking
    // a shot must not quietly change its look for reasons nobody asked for.
    //
    // A STORED path always wins. It is what was seen and approved in the
    // viewer, and recomputing it would let a later change to a movement's
    // default intensity silently re-tune an already-approved shot. Sampling
    // here is only the fallback for blocking assembled in code that has never
    // been through the viewer.
    if (opts.previs) {
        const stored = opts.previs.path;
        const path = (Array.isArray(stored) && stored.length)
            ? stored
            : require('./previs-blocking').samplePath(movement || 'static', opts.previs, { frames: 24 });
        if (path.length) {
            camera_control.path = path;
            if (opts.previs.rig) camera_control.rig = opts.previs.rig;
        }
    }

    const action = sceneCard && (sceneCard.action || sceneCard.description || sceneCard.direction);
    const environment = sceneCard && (sceneCard.environment_motion || sceneCard.atmosphere_motion);
    /*
     * THE COMPILED MOTION PROMPT — what a video model is actually told.
     *
     * The `prompt` above is the STORYBOARD prompt: it describes appearance,
     * location, style and lens, because it exists to paint a frame from
     * nothing. For image-to-video that frame is already attached, so 81% of it
     * re-describes the picture the model was handed — measured at 347 of 429
     * characters on a real shot — while `environment_motion` reached nothing.
     *
     * `motion_prompt` is motion plus the spatial locks, compiled per provider.
     * The old `prompt` stays on the payload: a provider that has no compiler
     * and no keyframe still needs something to generate from, and removing it
     * would break text-to-video.
     */
    let motion_prompt = '';
    try {
        motion_prompt = require('./motion-prompt').buildMotionPrompt({
            card: sceneCard, previs: opts.previs, durationS: opts.duration_s || opts.durationS,
            limit: opts.promptLimit,
        }).prompt;
    } catch (_) { motion_prompt = ''; }   // never fail a generation over a prompt shape

    return {
        prompt, negative_prompt, camera_control, motion_prompt,
        /*
         * WHOLE. Trimmed only if it does not fit, and by whoever knows the
         * ceiling.
         *
         * These were cut to 500 and 300 unconditionally, and the adapter then
         * assembled them and applied the REAL limit of 1000 — so a real shot
         * sent 503 characters against a 1000-character ceiling, with 497
         * characters of the director's own motion description discarded and
         * half the budget unused.
         *
         * The image prompt had exactly this and it was fixed there once
         * already: an allowance is a rule for deciding what to cut WHEN
         * something must be cut, not a target to shrink every field to. The
         * ceiling belongs to the provider, so the provider applies it.
         */
        motion: {
            ...(action ? { subject: String(action) } : {}),
            ...(environment ? { environment: String(environment) } : {}),
        },
    };
}

/**
 * Calculate video generation parameters from a scene card.
 *
 * @param {object} sceneCard - Parsed scene_card_yaml
 * @returns {{ num_frames: number, fps: number, duration_s: number, width: number, height: number }}
 */
/**
 * The frame a generation is asked for: the delivery raster, reshaped.
 *
 * ONE place, exported, because the image payload and the video payload must not
 * compute this differently — which is exactly what happened once, when the
 * board derived its shape from `aspect_ratio` and the footage from
 * `target_resolution`, and ten of the eleven ratios the settings offer produced
 * a storyboard in one format and footage in another with nothing said.
 *
 * `override` is a SHOT's own ratio, and it is a different question from the
 * project's. The project's aspect is FITTED INSIDE the delivery raster: 2.39:1
 * in a 1920x1080 delivery is 1920x804, because the operator chose that raster
 * and a wider frame is not a size anyone asked for.
 *
 * A shot override is not a crop of the delivery frame, it is a SEPARATE
 * DELIVERABLE — a vertical hero shot exists because a 9:16 crop of the master
 * would keep 32% of its width. So it keeps the delivery raster's SHORT edge and
 * derives the other from the ratio, which lands exactly on the rasters the
 * delivery profiles ask for: 1080x1920 for Reels, 1080x1350 for a Meta feed,
 * 1080x1080 for square. Fitting it inside the landscape frame instead would
 * generate 608x1080 — a vertical picture at a third of the resolution it is
 * delivered at.
 */
function buildVideoFrame(project, override) {
    const proj = project || {};
    let width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT;
    const m = String(proj.target_resolution || '').match(/^(\d+)\s*x\s*(\d+)$/i);
    if (m) { width = Number(m[1]); height = Number(m[2]); }

    // Even dimensions: h.264 rejects odd ones, and a rejection there is a paid
    // generation that fails at the provider.
    const even = n => Math.max(2, Math.round(n / 2) * 2);
    const parse = v => {
        const ar = String(v || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/);
        if (!ar) return null;
        const r = Number(ar[1]) / Number(ar[2]);
        return Number.isFinite(r) && r > 0 ? r : null;
    };

    const shotRatio = parse(override);
    if (shotRatio) {
        const shortEdge = Math.min(width, height);
        return shotRatio < 1
            ? { width: even(shortEdge), height: even(shortEdge / shotRatio) }
            : { width: even(shortEdge * shotRatio), height: even(shortEdge) };
    }

    /*
     * THE BOARD AND THE FOOTAGE ARE THE SAME SHAPE. The aspect ratio is the
     * CREATIVE decision and the resolution is the DELIVERY SIZE, so the frame is
     * the aspect FITTED INSIDE the delivery raster. Fitted rather than
     * area-preserved, because area-preserving gives 2226x932 for scope — wider
     * than the delivery frame the operator chose.
     *
     * An absent or unparseable aspect reshapes nothing: absent means "use what
     * is delivered", which is what every project had before a mood board could
     * set one, and a guess here would silently reframe existing work.
     */
    const ratio = parse(proj.aspect_ratio);
    if (ratio) {
        const byWidth = { w: width, h: even(width / ratio) };
        const byHeight = { w: even(height * ratio), h: height };
        const fitted = byWidth.h <= height ? byWidth : byHeight;
        width = fitted.w; height = fitted.h;
    }
    return { width, height };
}

function calculateVideoParams(sceneCard, project) {
    const durationMs = sceneCard.duration_ms || 4000;
    const durationS = durationMs / 1000;
    const proj = project || {};

    // The DELIVERY frame rate and size come from the project, not from
    // constants. They were hardcoded at 24fps and 1024x576, so a production set
    // to 25fps generated clips targeting 24 and was only relabelled at NLE
    // export — a mismatch that shows up as drift in a cut, long after the
    // frames were paid for. `fps` stays the generator's native rate, which is a
    // fact about the model rather than a choice about the film.
    const targetFps = Number(proj.target_fps) > 0 ? Number(proj.target_fps) : DEFAULT_FPS;

    let width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT;
    const res = String(proj.target_resolution || '');
    const m = res.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (m) { width = Number(m[1]); height = Number(m[2]); }

    /*
     * THE BOARD AND THE FOOTAGE ARE THE SAME SHAPE.
     *
     * The image payload derived its shape from film_projects.aspect_ratio and
     * this derived its shape from target_resolution — two independent columns
     * with nothing reconciling them. They agreed only because 16:9 and
     * 1920x1080 happen to be the same shape; every other aspect the settings
     * offer produced a storyboard in one format and footage in another, with
     * nothing said. Ten of the eleven ratios were wrong and none of them had
     * been used yet.
     *
     * The aspect ratio is the CREATIVE decision and the resolution is the
     * DELIVERY SIZE, so the frame is the aspect FITTED INSIDE the delivery
     * raster: 2.39:1 in a 1920x1080 delivery is 1920x804, and 9:16 is
     * 608x1080. Fitted rather than area-preserved, because area-preserving
     * gives 2226x932 for scope — wider than the delivery frame the operator
     * chose, which is not a size anyone asked for.
     *
     * An absent or unparseable aspect reshapes nothing: absent means "use what
     * is delivered", which is what every project had before a mood board could
     * set one, and a guess here would silently reframe existing work.
     */
    const frame = buildVideoFrame(proj, sceneCard.aspect_ratio);
    width = frame.width; height = frame.height;

    return {
        num_frames: DEFAULT_NUM_FRAMES,
        fps: DEFAULT_GEN_FPS,
        target_fps: targetFps,
        duration_s: durationS,
        width,
        height,
        steps: DEFAULT_STEPS,
        guidance_scale: DEFAULT_GUIDANCE,
    };
}

/**
 * Build the full video generation request payload.
 *
 * @param {object} sceneCard
 * @param {object[]} characters
 * @param {object|null} location
 * @param {string} [stylePreset]
 * @param {object} [options] - { seed, init_image, strength, model }
 * @returns {object} Full payload for POST /video
 */
function buildVideoPayload(sceneCard, characters, location, stylePreset, options) {
    const opts = options || {};
    const { prompt, negative_prompt, camera_control, motion, motion_prompt } = buildVideoPrompt(
        sceneCard, characters, location, stylePreset, opts
    );
    const params = calculateVideoParams(sceneCard, opts.project);

    const payload = {
        prompt,
        // Compiled motion, which is what an image-to-video provider should read.
        motion_prompt,
        negative_prompt,
        /*
         * NO DEFAULT MODEL.
         *
         * This named a local Gridlight checkpoint, hardcoded in a builder
         * shared by every provider. Runway has never heard of it, so every
         * single video preview carried "you asked for a model this provider
         * does not offer", and the substitution notice that
         * exists to catch a REAL mismatch was firing on a request nobody made.
         * A warning that goes off every time is one people learn to scroll past,
         * and then the real one goes past with it.
         *
         * A model name is a fact about a provider, so the provider names it: the
         * Runway adapter picks gen4.5, Seedance's is in its route, Gridlight
         * defaults to its own. An explicitly requested model still travels.
         */
        ...(opts.model ? { model: opts.model } : {}),
        width: params.width,
        height: params.height,
        num_frames: params.num_frames,
        fps: params.fps,
        duration_s: params.duration_s,
        steps: params.steps,
        guidance_scale: params.guidance_scale,
        seed: opts.seed || null,
        strength: opts.strength || 0.75,
        camera_control,
        interpolation: {
            enabled: true,
            target_fps: params.target_fps,
            method: 'rife',
        },
        output_format: 'mp4',
        stream: true,
    };

    if (opts.init_image) {
        payload.init_image = opts.init_image;
    }

    if (Array.isArray(opts.reference_images) && opts.reference_images.length > 0) {
        payload.reference_images = opts.reference_images;
    }

    if (Array.isArray(opts.input_refs) && opts.input_refs.length > 0) {
        payload.input_refs = opts.input_refs;
    }

    // Include LoRA IDs from characters
    const loraIds = (characters || [])
        .filter(c => c.lora_id)
        .map(c => `${c.lora_id}:0.8`);
    if (loraIds.length > 0) {
        payload.lora_ids = loraIds;
    }

    // Provider-specific guidance without changing the provider-neutral wire
    // contract or its golden fixture. Runway can read this in-process; JSON
    // adapters continue to receive the exact payload they received before.
    Object.defineProperty(payload, 'motion', { value: motion, enumerable: false });

    return payload;
}

module.exports = {
    buildVideoPrompt,
    calculateVideoParams,
    buildVideoFrame,
    buildVideoPayload,
    CAMERA_CONTROL_MAP,
    DEFAULT_FPS,
    DEFAULT_GEN_FPS,
    DEFAULT_NUM_FRAMES,
    DEFAULT_WIDTH,
    DEFAULT_HEIGHT,
};
