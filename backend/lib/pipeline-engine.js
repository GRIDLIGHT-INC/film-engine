/**
 * FILM-070-072: Pipeline Engine
 *
 * Pure logic for orchestrating the 9-step shot production pipeline.
 * Defines step ordering, dependency resolution, and execution planning.
 * No DB dependency — used by routes/pipeline.js for the actual execution.
 */

// ── Pipeline Step Definitions ───────────────────────────────────────

const PIPELINE_STEPS = [
    { id: 'keyframe', name: 'Storyboard Keyframe', depends: [], scope: 'shot', handler: 'storyboard' },
    { id: 'video', name: 'Video Generation', depends: ['keyframe'], scope: 'shot', handler: 'video-gen' },
    { id: 'voice', name: 'Dialogue Synthesis', depends: [], scope: 'shot', handler: 'voice' },
    { id: 'lipsync', name: 'Lip-Sync', depends: ['video', 'voice'], scope: 'shot', handler: 'lipsync' },
    { id: 'music', name: 'Scene Music', depends: [], scope: 'scene', handler: 'music-gen' },
    { id: 'sfx', name: 'Sound Effects', depends: [], scope: 'shot', handler: 'music-gen' },
    { id: 'ambient', name: 'Ambient Audio', depends: [], scope: 'scene', handler: 'music-gen' },
    { id: 'post', name: 'Post-Production', depends: ['lipsync'], scope: 'shot', handler: 'post-production' },
    { id: 'assembly', name: 'Final Assembly', depends: ['post', 'music', 'sfx', 'ambient'], scope: 'shot', handler: 'nle-export' },
];

const STEP_IDS = PIPELINE_STEPS.map(s => s.id);

const MAX_RETRIES = 3;
/*
 * Five seconds, doubling — 5s, 10s, 20s. Right in production: a provider that
 * just refused is not ready again immediately, and hammering it earns a 429.
 *
 * Overridable because a TEST should not be dominated by real sleeping. A run
 * with three legitimately-failing steps spent 35 of its 46 seconds asleep, and
 * a 46-second test is what made this file reset connections under the full
 * suite's parallelism — reporting a scope gate that works perfectly in
 * isolation as four separate product failures.
 */
const RETRY_BACKOFF_MS = Number(process.env.FILM_RETRY_BACKOFF_MS || 5000);

/**
 * Get the list of steps that can execute next given what's already completed.
 *
 * @param {string[]} completedSteps - IDs of completed steps
 * @param {string[]} [skipSteps=[]] - IDs of steps to skip
 * @returns {Array<{ id: string, name: string }>}
 */
function getNextSteps(completedSteps, skipSteps) {
    const completed = new Set(completedSteps || []);
    const skip = new Set(skipSteps || []);

    return PIPELINE_STEPS.filter(step => {
        if (completed.has(step.id)) return false;
        if (skip.has(step.id)) return false;

        // All dependencies must be completed or skipped
        return step.depends.every(dep => completed.has(dep) || skip.has(dep));
    });
}

/**
 * Check if a specific step can run given completed steps.
 *
 * @param {string} stepId
 * @param {string[]} completedSteps
 * @param {string[]} [skipSteps=[]]
 * @returns {boolean}
 */
function canRunStep(stepId, completedSteps, skipSteps) {
    const step = PIPELINE_STEPS.find(s => s.id === stepId);
    if (!step) return false;

    const completed = new Set(completedSteps || []);
    const skip = new Set(skipSteps || []);

    return step.depends.every(dep => completed.has(dep) || skip.has(dep));
}

/**
 * Build an ordered execution plan for a shot.
 * Returns steps in dependency-safe order.
 *
 * @param {object} [options]
 * @param {string[]} [options.skip_steps] - Step IDs to skip
 * @param {string} [options.start_from] - Resume from this step
 * @param {string[]} [options.only_steps] - Run only these steps
 * @returns {Array<{ id: string, name: string, scope: string, handler: string }>}
 */
function buildStepPlan(options) {
    const opts = options || {};
    const skip = new Set(opts.skip_steps || []);
    const startFrom = opts.start_from || null;
    const onlySteps = opts.only_steps ? new Set(opts.only_steps) : null;

    let steps = PIPELINE_STEPS.filter(s => {
        if (skip.has(s.id)) return false;
        if (onlySteps && !onlySteps.has(s.id)) return false;
        return true;
    });

    // If starting from a specific step, drop everything before it
    if (startFrom) {
        const startIdx = steps.findIndex(s => s.id === startFrom);
        if (startIdx > 0) {
            steps = steps.slice(startIdx);
        }
    }

    return steps.map(s => ({
        id: s.id,
        name: s.name,
        scope: s.scope,
        handler: s.handler,
    }));
}

/**
 * Calculate retry delay with exponential backoff.
 *
 * @param {number} attempt - 0-based attempt number
 * @returns {number} Delay in ms
 */
function retryDelay(attempt) {
    return RETRY_BACKOFF_MS * Math.pow(2, attempt);
}

/**
 * Check if a shot has dialogue (needs voice + lipsync steps).
 *
 * @param {object} sceneCard - Parsed scene_card_yaml
 * @returns {boolean}
 */
function hasDialogue(sceneCard) {
    return sceneCard && Array.isArray(sceneCard.dialogue) && sceneCard.dialogue.length > 0;
}

/**
 * Determine which steps to skip for a shot based on its content.
 *
 * @param {object} sceneCard - Parsed scene_card_yaml
 * @param {object} [options]
 * @param {string[]} [options.skip_steps] - User-specified skips
 * @returns {string[]} Combined skip list
 */
function autoSkipSteps(sceneCard, options) {
    const skips = new Set(options && options.skip_steps ? options.skip_steps : []);

    // Skip voice + lipsync if no dialogue
    if (!hasDialogue(sceneCard)) {
        skips.add('voice');
        skips.add('lipsync');
        // If lipsync is skipped, post depends on video directly
    }

    return Array.from(skips);
}

module.exports = {
    PIPELINE_STEPS,
    STEP_IDS,
    MAX_RETRIES,
    RETRY_BACKOFF_MS,
    getNextSteps,
    canRunStep,
    buildStepPlan,
    retryDelay,
    hasDialogue,
    autoSkipSteps,
};
