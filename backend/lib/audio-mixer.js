/**
 * FILM-093: Per-Shot Audio Mix
 *
 * Mixes dialogue, score, SFX, and ambient audio tracks for a shot.
 * Supports LUFS normalization, ducking, and stem output.
 *
 * Exports:
 *  - DEFAULT_LEVELS: default gain levels per track type
 *  - LUFS_TARGETS: standard LUFS targets for different deliverables
 *  - buildMixPayload(tracks, options) → payload for mix endpoint
 *  - calculateDucking(dialogueTracks, musicTracks) → ducking automation
 *  - buildStemExport(tracks) → stem packaging payload
 *  - generateSRT(dialogueLines, options) → SRT subtitle content string
 */

// Default gain levels (dB) per track type
const DEFAULT_LEVELS = {
    dialogue: 0,        // Reference level
    music: -6,          // Music sits under dialogue
    sfx: -3,            // SFX slightly under dialogue
    ambient: -12,       // Ambient well below
};

// LUFS normalization targets for different deliverables
const LUFS_TARGETS = {
    broadcast: -24,     // EBU R128
    streaming: -14,     // Spotify/YouTube
    cinema: -27,        // SMPTE RP 200
    podcast: -16,       // Apple Podcasts
};

const DUCKING_DEFAULTS = {
    threshold_db: -20,      // When dialogue exceeds this, duck music
    reduction_db: -8,       // How much to reduce music
    attack_ms: 100,         // How fast ducking engages
    release_ms: 500,        // How fast ducking releases
    hold_ms: 200,           // Hold ducking after dialogue ends
};

/**
 * Build payload for the audio mix endpoint.
 *
 * @param {Array<{type: string, url: string, start_ms: number, duration_ms: number, gain_db?: number}>} tracks
 * @param {object} [options]
 * @returns {object} Mix payload
 */
function buildMixPayload(tracks, options) {
    const opts = options || {};

    const mixTracks = (tracks || []).map((t, i) => ({
        index: i,
        type: t.type || 'sfx',
        url: t.url || t.file_path || '',
        start_ms: t.start_ms || 0,
        duration_ms: t.duration_ms || 0,
        gain_db: t.gain_db !== undefined ? t.gain_db : (DEFAULT_LEVELS[t.type] || 0),
        pan: t.pan || 0,           // -1 (left) to 1 (right)
        fade_in_ms: t.fade_in_ms || 0,
        fade_out_ms: t.fade_out_ms || 0,
    }));

    return {
        type: 'mix',
        tracks: mixTracks,
        master: {
            lufs_target: opts.lufs_target || LUFS_TARGETS.streaming,
            limiter: opts.limiter !== false,
            sample_rate: opts.sample_rate || 48000,
            bit_depth: opts.bit_depth || 24,
            channels: opts.channels || 2,
        },
        ducking: opts.ducking !== false ? {
            enabled: true,
            ...DUCKING_DEFAULTS,
            ...(opts.ducking_params || {}),
        } : { enabled: false },
        output_format: opts.output_format || 'wav',
        output_filename: opts.output_filename || 'mix.wav',
    };
}

/**
 * Calculate ducking automation from dialogue and music tracks.
 * Returns time-based gain reduction events for the music track.
 *
 * @param {Array<{start_ms: number, end_ms: number}>} dialogueRegions
 * @param {object} [params] - Ducking parameters
 * @returns {Array<{start_ms: number, end_ms: number, gain_reduction_db: number}>}
 */
function calculateDucking(dialogueRegions, params) {
    const p = { ...DUCKING_DEFAULTS, ...(params || {}) };
    if (!Array.isArray(dialogueRegions) || dialogueRegions.length === 0) return [];

    const events = [];
    for (const region of dialogueRegions) {
        if (!region.start_ms && region.start_ms !== 0) continue;
        const endMs = region.end_ms || (region.start_ms + (region.duration_ms || 0));

        events.push({
            start_ms: Math.max(0, region.start_ms - p.attack_ms),
            end_ms: endMs + p.hold_ms + p.release_ms,
            gain_reduction_db: p.reduction_db,
            attack_ms: p.attack_ms,
            release_ms: p.release_ms,
        });
    }

    // Merge overlapping events
    events.sort((a, b) => a.start_ms - b.start_ms);
    const merged = [];
    for (const ev of events) {
        if (merged.length > 0 && ev.start_ms <= merged[merged.length - 1].end_ms) {
            merged[merged.length - 1].end_ms = Math.max(merged[merged.length - 1].end_ms, ev.end_ms);
        } else {
            merged.push({ ...ev });
        }
    }

    return merged;
}

/**
 * Build stem export payload (separate files for each track type).
 */
function buildStemExport(tracks, options) {
    const opts = options || {};
    const stems = {};

    for (const t of (tracks || [])) {
        const type = t.type || 'other';
        if (!stems[type]) stems[type] = [];
        stems[type].push({
            url: t.url || t.file_path || '',
            start_ms: t.start_ms || 0,
            duration_ms: t.duration_ms || 0,
            gain_db: t.gain_db !== undefined ? t.gain_db : (DEFAULT_LEVELS[type] || 0),
        });
    }

    return {
        type: 'stem_export',
        stems: Object.entries(stems).map(([type, tracks]) => ({
            stem_name: type,
            tracks,
            output_filename: `stem_${type}.wav`,
        })),
        master_mix: opts.include_master !== false,
        output_format: opts.output_format || 'wav',
        sample_rate: opts.sample_rate || 48000,
    };
}

/**
 * Generate SRT subtitle content from dialogue lines.
 *
 * @param {Array<{character: string, line: string, start_ms: number, end_ms: number}>} dialogueLines
 * @param {object} [options]
 * @param {boolean} [options.include_character] - Prefix with character name
 * @returns {string} SRT formatted string
 */
function generateSRT(dialogueLines, options) {
    const opts = options || {};
    if (!Array.isArray(dialogueLines) || dialogueLines.length === 0) return '';

    const lines = [];
    for (let i = 0; i < dialogueLines.length; i++) {
        const dl = dialogueLines[i];
        const startMs = dl.start_ms || 0;
        const endMs = dl.end_ms || (startMs + 3000);
        const text = opts.include_character && dl.character
            ? `${dl.character}: ${dl.line}`
            : dl.line || '';

        lines.push(`${i + 1}`);
        lines.push(`${formatSRTTime(startMs)} --> ${formatSRTTime(endMs)}`);
        lines.push(text);
        lines.push('');
    }

    return lines.join('\n');
}

function formatSRTTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const millis = ms % 1000;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

module.exports = {
    DEFAULT_LEVELS,
    LUFS_TARGETS,
    DUCKING_DEFAULTS,
    buildMixPayload,
    calculateDucking,
    buildStemExport,
    generateSRT,
    formatSRTTime,
};
