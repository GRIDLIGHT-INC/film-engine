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
    return {
        prompt, negative_prompt, camera_control,
        motion: {
            ...(action ? { subject: String(action).slice(0, 500) } : {}),
            ...(environment ? { environment: String(environment).slice(0, 300) } : {}),
        },
    };
}

/**
 * Calculate video generation parameters from a scene card.
 *
 * @param {object} sceneCard - Parsed scene_card_yaml
 * @returns {{ num_frames: number, fps: number, duration_s: number, width: number, height: number }}
 */
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
    const ar = String(proj.aspect_ratio || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/);
    if (ar) {
        const ratio = Number(ar[1]) / Number(ar[2]);
        if (Number.isFinite(ratio) && ratio > 0) {
            // Even dimensions: h.264 rejects odd ones, and a rejection here is
            // a paid generation that fails at the provider.
            const even = n => Math.max(2, Math.round(n / 2) * 2);
            const byWidth = { w: width, h: even(width / ratio) };
            const byHeight = { w: even(height * ratio), h: height };
            const fitted = byWidth.h <= height ? byWidth : byHeight;
            width = fitted.w; height = fitted.h;
        }
    }

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
    const { prompt, negative_prompt, camera_control, motion } = buildVideoPrompt(
        sceneCard, characters, location, stylePreset, opts
    );
    const params = calculateVideoParams(sceneCard, opts.project);

    const payload = {
        prompt,
        negative_prompt,
        model: opts.model || 'animatediff-sdxl',
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
    buildVideoPayload,
    CAMERA_CONTROL_MAP,
    DEFAULT_FPS,
    DEFAULT_GEN_FPS,
    DEFAULT_NUM_FRAMES,
    DEFAULT_WIDTH,
    DEFAULT_HEIGHT,
};
