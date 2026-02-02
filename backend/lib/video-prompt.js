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
function buildVideoPrompt(sceneCard, characters, location, stylePreset) {
    // Reuse storyboard prompt for text prompt
    const { prompt, negative_prompt } = buildStoryboardPrompt(
        sceneCard, characters, location, stylePreset
    );

    // Map camera movement
    const movement = sceneCard.camera && sceneCard.camera.movement;
    const camera_control = (movement && CAMERA_CONTROL_MAP[movement])
        ? { ...CAMERA_CONTROL_MAP[movement] }
        : { type: 'static', intensity: 0.0 };

    return { prompt, negative_prompt, camera_control };
}

/**
 * Calculate video generation parameters from a scene card.
 *
 * @param {object} sceneCard - Parsed scene_card_yaml
 * @returns {{ num_frames: number, fps: number, duration_s: number, width: number, height: number }}
 */
function calculateVideoParams(sceneCard) {
    const durationMs = sceneCard.duration_ms || 4000;
    const durationS = durationMs / 1000;

    return {
        num_frames: DEFAULT_NUM_FRAMES,
        fps: DEFAULT_GEN_FPS,
        target_fps: DEFAULT_FPS,
        duration_s: durationS,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
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
    const { prompt, negative_prompt, camera_control } = buildVideoPrompt(
        sceneCard, characters, location, stylePreset
    );
    const params = calculateVideoParams(sceneCard);

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

    // Include LoRA IDs from characters
    const loraIds = (characters || [])
        .filter(c => c.lora_id)
        .map(c => `${c.lora_id}:0.8`);
    if (loraIds.length > 0) {
        payload.lora_ids = loraIds;
    }

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
