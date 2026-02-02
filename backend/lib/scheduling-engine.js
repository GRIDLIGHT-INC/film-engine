/**
 * FILM-072: Smart Scheduling & Model Residency
 *
 * Intelligently schedules pipeline steps based on:
 *  - Model residency (keep models loaded that are reused soon)
 *  - GPU memory constraints
 *  - Dependency ordering
 *  - Batch grouping (group by model to reduce swap overhead)
 *
 * Exports:
 *  - MODEL_PROFILES: known model memory/load profiles
 *  - buildSchedule(shots, options) → ordered execution plan
 *  - groupByModel(steps) → batched steps grouped by model
 *  - estimateGPUMemory(models) → total VRAM estimate
 *  - suggestResidency(schedule) → which models to keep loaded
 */

// Model profiles: estimated VRAM usage and load time
const MODEL_PROFILES = {
    'sdxl': { vram_gb: 6.5, load_time_s: 15, type: 'image' },
    'animatediff-sdxl': { vram_gb: 8.0, load_time_s: 20, type: 'video' },
    'musicgen-large': { vram_gb: 3.5, load_time_s: 10, type: 'audio' },
    'musicgen-small': { vram_gb: 1.5, load_time_s: 5, type: 'audio' },
    'qwen3-tts': { vram_gb: 2.0, load_time_s: 8, type: 'voice' },
    'wav2lip': { vram_gb: 2.5, load_time_s: 6, type: 'lipsync' },
    'realesrgan-video': { vram_gb: 2.0, load_time_s: 5, type: 'upscale' },
    'codeformer': { vram_gb: 1.5, load_time_s: 4, type: 'face' },
    'triposr': { vram_gb: 4.0, load_time_s: 12, type: '3d' },
    'phoneme-to-viseme-v1': { vram_gb: 0.5, load_time_s: 2, type: 'viseme' },
};

// Default GPU memory budget
const DEFAULT_VRAM_BUDGET_GB = 24;

// Pipeline step → model mapping
const STEP_MODELS = {
    keyframe: 'sdxl',
    video: 'animatediff-sdxl',
    voice: 'qwen3-tts',
    lipsync: 'wav2lip',
    music: 'musicgen-large',
    sfx: 'musicgen-large',
    ambient: 'musicgen-large',
    post: 'realesrgan-video',
};

/**
 * Build an optimized execution schedule for multiple shots.
 * Groups steps by model to minimize model loading/unloading.
 *
 * @param {Array<{shot_id: string, shot_code: string, steps: string[]}>} shots
 * @param {object} [options]
 * @param {number} [options.vram_budget_gb] - Available VRAM
 * @param {boolean} [options.batch_by_model] - Group by model (default true)
 * @param {string[]} [options.priority_shots] - Shot IDs to prioritize
 * @returns {{ phases: Array<{model: string, steps: Array}>, estimated_load_time_s: number, estimated_swaps: number }}
 */
function buildSchedule(shots, options) {
    const opts = options || {};
    const batchByModel = opts.batch_by_model !== false;

    if (!Array.isArray(shots) || shots.length === 0) {
        return { phases: [], estimated_load_time_s: 0, estimated_swaps: 0 };
    }

    // Flatten all steps
    const allSteps = [];
    for (const shot of shots) {
        for (const stepId of (shot.steps || [])) {
            allSteps.push({
                shot_id: shot.shot_id,
                shot_code: shot.shot_code,
                step: stepId,
                model: STEP_MODELS[stepId] || 'unknown',
                priority: opts.priority_shots && opts.priority_shots.includes(shot.shot_id) ? 0 : 1,
            });
        }
    }

    if (!batchByModel) {
        // Simple sequential: one phase per shot
        const phases = shots.map(shot => ({
            model: 'mixed',
            shot_id: shot.shot_id,
            shot_code: shot.shot_code,
            steps: shot.steps.map(s => ({ step: s, model: STEP_MODELS[s] || 'unknown' })),
        }));

        return {
            phases,
            estimated_load_time_s: calculateTotalLoadTime(shots.flatMap(s => s.steps)),
            estimated_swaps: countModelSwaps(allSteps.map(s => s.model)),
        };
    }

    // Group by model for batch execution
    const grouped = groupByModel(allSteps);

    // Order phases by pipeline dependency
    const phaseOrder = ['sdxl', 'animatediff-sdxl', 'qwen3-tts', 'wav2lip', 'musicgen-large', 'realesrgan-video'];
    const phases = [];

    for (const model of phaseOrder) {
        if (grouped[model] && grouped[model].length > 0) {
            // Sort by priority then shot code
            grouped[model].sort((a, b) => a.priority - b.priority || a.shot_code.localeCompare(b.shot_code));
            phases.push({
                model,
                vram_gb: (MODEL_PROFILES[model] || {}).vram_gb || 0,
                load_time_s: (MODEL_PROFILES[model] || {}).load_time_s || 0,
                steps: grouped[model],
            });
            delete grouped[model];
        }
    }

    // Add any remaining models not in the standard order
    for (const [model, steps] of Object.entries(grouped)) {
        if (steps.length > 0) {
            phases.push({
                model,
                vram_gb: (MODEL_PROFILES[model] || {}).vram_gb || 0,
                load_time_s: (MODEL_PROFILES[model] || {}).load_time_s || 0,
                steps,
            });
        }
    }

    return {
        phases,
        estimated_load_time_s: phases.reduce((sum, p) => sum + p.load_time_s, 0),
        estimated_swaps: phases.length,
    };
}

/**
 * Group pipeline steps by the model they use.
 */
function groupByModel(steps) {
    const groups = {};
    for (const step of steps) {
        const model = step.model || 'unknown';
        if (!groups[model]) groups[model] = [];
        groups[model].push(step);
    }
    return groups;
}

/**
 * Estimate total GPU VRAM needed to run given models concurrently.
 */
function estimateGPUMemory(modelIds) {
    if (!Array.isArray(modelIds)) return 0;
    const unique = [...new Set(modelIds)];
    return unique.reduce((sum, id) => sum + ((MODEL_PROFILES[id] || {}).vram_gb || 0), 0);
}

/**
 * Given a schedule, suggest which models to keep resident (loaded)
 * to minimize swap overhead.
 */
function suggestResidency(schedule, vramBudget) {
    const budget = vramBudget || DEFAULT_VRAM_BUDGET_GB;
    if (!schedule || !schedule.phases) return { resident: [], evict: [] };

    // Count usage frequency
    const modelUsage = {};
    for (const phase of schedule.phases) {
        const model = phase.model;
        if (!modelUsage[model]) modelUsage[model] = { count: 0, vram_gb: phase.vram_gb || 0 };
        modelUsage[model].count += phase.steps.length;
    }

    // Sort by usage frequency (most used first)
    const sorted = Object.entries(modelUsage).sort((a, b) => b[1].count - a[1].count);

    const resident = [];
    const evict = [];
    let usedVram = 0;

    for (const [model, info] of sorted) {
        if (usedVram + info.vram_gb <= budget) {
            resident.push({ model, vram_gb: info.vram_gb, usage_count: info.count });
            usedVram += info.vram_gb;
        } else {
            evict.push({ model, vram_gb: info.vram_gb, usage_count: info.count });
        }
    }

    return { resident, evict, total_vram_gb: usedVram, budget_gb: budget };
}

function calculateTotalLoadTime(stepIds) {
    const models = [...new Set(stepIds.map(s => STEP_MODELS[s]).filter(Boolean))];
    return models.reduce((sum, m) => sum + ((MODEL_PROFILES[m] || {}).load_time_s || 0), 0);
}

function countModelSwaps(modelSequence) {
    let swaps = 0;
    for (let i = 1; i < modelSequence.length; i++) {
        if (modelSequence[i] !== modelSequence[i - 1]) swaps++;
    }
    return swaps;
}

module.exports = {
    MODEL_PROFILES,
    DEFAULT_VRAM_BUDGET_GB,
    STEP_MODELS,
    buildSchedule,
    groupByModel,
    estimateGPUMemory,
    suggestResidency,
};
