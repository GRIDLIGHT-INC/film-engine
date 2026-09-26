/**
 * Audio Deliverables Library
 *
 * Professional audio delivery specifications for film production.
 * Includes channel layouts, deliverable types, and spec generation.
 */

const DELIVERABLE_TYPES = [
    { id: 'stereo_mix', label: 'Stereo Mix', channels: 2, layout: '2.0' },
    { id: 'surround_51', label: '5.1 Surround', channels: 6, layout: '5.1' },
    { id: 'surround_71', label: '7.1 Surround', channels: 8, layout: '7.1' },
    { id: 'atmos_bed', label: 'Dolby Atmos Bed', channels: 10, layout: '7.1.2' },
    { id: 'me_track', label: 'M&E (Music & Effects)', channels: 2, layout: '2.0' },
    { id: 'dialogue_stem', label: 'Dialogue Stem', channels: 2, layout: '2.0' },
    { id: 'music_stem', label: 'Music Stem', channels: 2, layout: '2.0' },
    { id: 'sfx_stem', label: 'SFX Stem', channels: 2, layout: '2.0' },
    { id: 'foley_stem', label: 'Foley Stem', channels: 2, layout: '2.0' },
    { id: 'ambient_stem', label: 'Ambient/Atmos Stem', channels: 2, layout: '2.0' },
];

const DELIVERABLE_TYPE_IDS = DELIVERABLE_TYPES.map(d => d.id);

const CHANNEL_LAYOUTS = {
    '2.0': { label: 'Stereo', channels: ['L', 'R'] },
    '5.1': { label: '5.1 Surround', channels: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'] },
    '7.1': { label: '7.1 Surround', channels: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lrs', 'Rrs'] },
    '7.1.2': { label: '7.1.2 Atmos', channels: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lrs', 'Rrs', 'Ltf', 'Rtf'] },
    'mono': { label: 'Mono', channels: ['C'] },
};

const SAMPLE_RATES = [44100, 48000, 96000];
const BIT_DEPTHS = [16, 24, 32];

const LUFS_TARGETS = {
    theatrical: -24,
    broadcast_us: -24,
    broadcast_eu: -23,
    streaming: -14,
    podcast: -16,
};

/**
 * Generate a 5.1 surround specification document.
 * @param {object} project - { title }
 * @param {object} [options] - { sample_rate, bit_depth, lufs_target }
 * @returns {object} Specification object
 */
function generate51Specification(project, options = {}) {
    const sr = options.sample_rate || 48000;
    const bd = options.bit_depth || 24;
    const lufs = options.lufs_target || -24;

    return {
        format: '5.1 Surround',
        project_title: project.title || 'Untitled',
        channel_layout: CHANNEL_LAYOUTS['5.1'],
        channels: [
            { position: 'L', label: 'Left Front', assignment: 'dialogue + music + sfx' },
            { position: 'R', label: 'Right Front', assignment: 'dialogue + music + sfx' },
            { position: 'C', label: 'Center', assignment: 'dialogue primary' },
            { position: 'LFE', label: 'Low Frequency Effects', assignment: 'bass extension' },
            { position: 'Ls', label: 'Left Surround', assignment: 'ambiance + sfx' },
            { position: 'Rs', label: 'Right Surround', assignment: 'ambiance + sfx' },
        ],
        sample_rate: sr,
        bit_depth: bd,
        codec: `pcm_s${bd}le`,
        file_format: 'wav',
        loudness: {
            target_lufs: lufs,
            true_peak_dbtp: -1.0,
            loudness_range_lu: 20,
        },
    };
}

/**
 * Generate M&E (Music & Effects) track specification.
 * @param {object} project
 * @returns {object}
 */
function generateMESpec(project) {
    return {
        format: 'M&E (Music & Effects)',
        project_title: project.title || 'Untitled',
        description: 'Complete mix minus dialogue for international versioning',
        channel_layout: CHANNEL_LAYOUTS['2.0'],
        includes: ['music', 'sfx', 'foley', 'ambiance'],
        excludes: ['dialogue', 'narration'],
        sample_rate: 48000,
        bit_depth: 24,
        codec: 'pcm_s24le',
        file_format: 'wav',
    };
}

/**
 * Generate stem manifest listing all deliverable stems.
 * @param {object} project
 * @returns {object}
 */
function generateStemManifest(project) {
    const stems = DELIVERABLE_TYPES.filter(d => d.id.endsWith('_stem'));
    return {
        project_title: project.title || 'Untitled',
        stems: stems.map(s => ({
            id: s.id,
            label: s.label,
            channels: s.channels,
            layout: s.layout,
            file_format: 'wav',
            sample_rate: 48000,
            bit_depth: 24,
        })),
        total_stems: stems.length,
    };
}

/**
 * Validate audio deliverable fields.
 * @param {object} fields
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAudioDeliverable(fields) {
    const errors = [];

    if (fields.type && !DELIVERABLE_TYPE_IDS.includes(fields.type)) {
        errors.push(`Invalid type: ${fields.type}. Valid: ${DELIVERABLE_TYPE_IDS.join(', ')}`);
    }

    if (fields.channel_layout && !CHANNEL_LAYOUTS[fields.channel_layout]) {
        errors.push(`Invalid channel_layout: ${fields.channel_layout}. Valid: ${Object.keys(CHANNEL_LAYOUTS).join(', ')}`);
    }

    if (fields.sample_rate !== undefined && !SAMPLE_RATES.includes(fields.sample_rate)) {
        errors.push(`Invalid sample_rate: ${fields.sample_rate}. Valid: ${SAMPLE_RATES.join(', ')}`);
    }

    if (fields.bit_depth !== undefined && !BIT_DEPTHS.includes(fields.bit_depth)) {
        errors.push(`Invalid bit_depth: ${fields.bit_depth}. Valid: ${BIT_DEPTHS.join(', ')}`);
    }

    if (fields.lufs_target !== undefined) {
        const lufs = Number(fields.lufs_target);
        if (isNaN(lufs) || lufs > 0 || lufs < -70) {
            errors.push('lufs_target must be between -70 and 0');
        }
    }

    return { valid: errors.length === 0, errors };
}

module.exports = {    DELIVERABLE_TYPES,
    LUFS_TARGETS,
    generate51Specification,
    generateMESpec,
    generateStemManifest,
    validateAudioDeliverable,};
