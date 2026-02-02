/**
 * FILM-033: Multi-Clip Stitching for Long Videos
 *
 * Handles videos longer than a single generation clip (typically >5s).
 * Splits long shots into overlapping sub-clips, generates each, then
 * stitches with cross-dissolve transitions.
 *
 * Exports:
 *  - MAX_CLIP_DURATION_S: maximum single clip length (default 5)
 *  - OVERLAP_S: overlap between clips for dissolve (default 0.5)
 *  - needsStitching(durationMs) → boolean
 *  - planClips(durationMs, options) → [{ index, start_ms, end_ms, duration_ms, overlap_ms }]
 *  - buildStitchPayload(clips, projectId, shotCode) → payload for stitching endpoint
 *  - calculateTransitions(clips, transitionType) → [{ from_clip, to_clip, type, duration_ms, start_ms }]
 */

const MAX_CLIP_DURATION_S = 5;
const MAX_CLIP_DURATION_MS = MAX_CLIP_DURATION_S * 1000;
const OVERLAP_S = 0.5;
const OVERLAP_MS = OVERLAP_S * 1000;

const TRANSITION_TYPES = ['cross-dissolve', 'cut', 'fade-through-black', 'wipe'];

/**
 * Check if a shot duration exceeds single-clip generation limit.
 */
function needsStitching(durationMs) {
    return typeof durationMs === 'number' && durationMs > MAX_CLIP_DURATION_MS;
}

/**
 * Plan how to split a long shot into clips.
 *
 * @param {number} durationMs - Total shot duration in ms
 * @param {object} [options]
 * @param {number} [options.max_clip_ms] - Max clip duration (default 5000)
 * @param {number} [options.overlap_ms] - Overlap for transitions (default 500)
 * @returns {Array<{index: number, start_ms: number, end_ms: number, duration_ms: number, overlap_before_ms: number, overlap_after_ms: number}>}
 */
function planClips(durationMs, options) {
    const opts = options || {};
    const maxClip = opts.max_clip_ms || MAX_CLIP_DURATION_MS;
    const overlap = opts.overlap_ms || OVERLAP_MS;

    if (!durationMs || durationMs <= 0) return [];
    if (durationMs <= maxClip) {
        return [{
            index: 0, start_ms: 0, end_ms: durationMs, duration_ms: durationMs,
            overlap_before_ms: 0, overlap_after_ms: 0,
        }];
    }

    // Effective content per clip (minus overlap)
    const effectiveClip = maxClip - overlap;
    const numClips = Math.ceil((durationMs - overlap) / effectiveClip);
    const clips = [];

    for (let i = 0; i < numClips; i++) {
        const startMs = i * effectiveClip;
        const endMs = Math.min(startMs + maxClip, durationMs);
        const isFirst = i === 0;
        const isLast = i === numClips - 1;

        clips.push({
            index: i,
            start_ms: startMs,
            end_ms: endMs,
            duration_ms: endMs - startMs,
            overlap_before_ms: isFirst ? 0 : overlap,
            overlap_after_ms: isLast ? 0 : overlap,
        });
    }

    return clips;
}

/**
 * Build payload for the stitching/assembly endpoint.
 */
function buildStitchPayload(clips, projectId, shotCode, options) {
    const opts = options || {};

    return {
        type: 'stitch',
        project_id: projectId,
        shot_code: shotCode,
        clips: clips.map(c => ({
            index: c.index,
            clip_url: c.clip_url || `${shotCode}_clip_${c.index}.mp4`,
            start_ms: c.start_ms,
            end_ms: c.end_ms,
            duration_ms: c.duration_ms,
        })),
        transition: opts.transition || 'cross-dissolve',
        transition_duration_ms: opts.transition_duration_ms || OVERLAP_MS,
        output_format: opts.output_format || 'mp4',
        output_filename: `${shotCode}_stitched.mp4`,
        target_fps: opts.target_fps || 24,
        codec: opts.codec || 'h264',
    };
}

/**
 * Calculate transition points between clips.
 */
function calculateTransitions(clips, transitionType) {
    const type = transitionType || 'cross-dissolve';
    const transitions = [];

    for (let i = 0; i < clips.length - 1; i++) {
        const current = clips[i];
        const next = clips[i + 1];
        const overlapMs = current.overlap_after_ms || OVERLAP_MS;

        transitions.push({
            from_clip: current.index,
            to_clip: next.index,
            type,
            duration_ms: overlapMs,
            start_ms: current.end_ms - overlapMs,
        });
    }

    return transitions;
}

module.exports = {
    MAX_CLIP_DURATION_S,
    MAX_CLIP_DURATION_MS,
    OVERLAP_S,
    OVERLAP_MS,
    TRANSITION_TYPES,
    needsStitching,
    planClips,
    buildStitchPayload,
    calculateTransitions,
};
