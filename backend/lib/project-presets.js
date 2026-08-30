/**
 * Project Settings Presets
 *
 * Constants and validation for project-level technical settings:
 * aspect ratios, resolutions, color spaces, frame rates, and delivery presets.
 */

// ── Aspect Ratios ───────────────────────────────────────────────────
const ASPECT_RATIOS = [
    { id: '16:9',    label: '16:9 — Standard HD/UHD',            ratio: '16:9',    decimal: 1.778 },
    { id: '2.39:1',  label: '2.39:1 — Anamorphic Scope',         ratio: '2.39:1',  decimal: 2.39  },
    { id: '2.35:1',  label: '2.35:1 — Panavision Scope',         ratio: '2.35:1',  decimal: 2.35  },
    { id: '1.85:1',  label: '1.85:1 — Flat Widescreen',          ratio: '1.85:1',  decimal: 1.85  },
    { id: '1.43:1',  label: '1.43:1 — IMAX Full Frame (15/70mm)',ratio: '1.43:1',  decimal: 1.43  },
    { id: '1.90:1',  label: '1.90:1 — IMAX Digital',             ratio: '1.90:1',  decimal: 1.90  },
    { id: '4:3',     label: '4:3 — Academy',                     ratio: '4:3',     decimal: 1.333 },
    { id: '9:16',    label: '9:16 — Vertical/Mobile',            ratio: '9:16',    decimal: 0.5625},
    { id: '1:1',     label: '1:1 — Square',                      ratio: '1:1',     decimal: 1.0   },
    // Meta feed. Added for commercial delivery, where it is not a stylistic
    // choice: a 4:5 placement derived from a 16:9 master keeps 45% of its width,
    // so the frame has to be generated at it or the product leaves the shot.
    { id: '4:5',     label: '4:5 — Meta feed (vertical)',        ratio: '4:5',     decimal: 0.8   },
    { id: '2:1',     label: '2:1 — Univisium (Netflix)',         ratio: '2:1',     decimal: 2.0   },
    { id: '2.76:1',  label: '2.76:1 — Ultra Panavision 70',     ratio: '2.76:1',  decimal: 2.76  },
    { id: 'custom',  label: 'Custom',                             ratio: 'custom',  decimal: null  },
];

const ASPECT_RATIO_IDS = ASPECT_RATIOS.map(a => a.id);

// ── Resolutions ─────────────────────────────────────────────────────
const RESOLUTIONS = [
    { id: '720p',      label: '720p HD',           width: 1280,  height: 720   },
    { id: '1080p',     label: '1080p Full HD',     width: 1920,  height: 1080  },
    { id: '2k',        label: '2K',                width: 2048,  height: 1080  },
    { id: '4k_uhd',    label: '4K UHD',            width: 3840,  height: 2160  },
    { id: '4k_dci',    label: '4K DCI',            width: 4096,  height: 2160  },
    { id: '8k',        label: '8K UHD',            width: 7680,  height: 4320  },
    { id: 'imax_5.6k', label: 'IMAX 5.6K',        width: 5616,  height: 4096  },
    { id: 'imax_12k',  label: 'IMAX 12K',         width: 12288, height: 8640  },
    /*
     * Vertical rasters. Not a stylistic option: a social-first campaign is
     * GENERATED at 9:16 and the 16:9 derived from it, because the reverse keeps
     * 32% of the width and loses the product. Listed as their own entries
     * rather than left to "custom" so a preset can name one.
     */
    { id: '1080p_vertical', label: '1080x1920 — vertical HD',  width: 1080, height: 1920 },
    { id: '4k_vertical',    label: '2160x3840 — vertical UHD', width: 2160, height: 3840 },
];

const RESOLUTION_IDS = RESOLUTIONS.map(r => r.id);

// ── Color Spaces ────────────────────────────────────────────────────
const COLOR_SPACES = [
    { id: 'sRGB',     label: 'sRGB',     description: 'Standard web/monitor color space' },
    { id: 'Rec.709',  label: 'Rec.709',  description: 'HD broadcast standard' },
    { id: 'DCI-P3',   label: 'DCI-P3',   description: 'Digital cinema projection' },
    { id: 'Rec.2020', label: 'Rec.2020', description: 'UHD/HDR wide gamut' },
    { id: 'ACES',     label: 'ACES',     description: 'Academy Color Encoding System' },
];

const COLOR_SPACE_IDS = COLOR_SPACES.map(c => c.id);

// ── Frame Rates ─────────────────────────────────────────────────────
const FRAME_RATES = [
    { id: '23.976', fps: 23.976, label: '23.976 fps — NTSC Film',       dropFrame: true  },
    { id: '24',     fps: 24,     label: '24 fps — Cinema',              dropFrame: false },
    { id: '25',     fps: 25,     label: '25 fps — PAL',                 dropFrame: false },
    { id: '29.97',  fps: 29.97,  label: '29.97 fps — NTSC Broadcast',  dropFrame: true  },
    { id: '30',     fps: 30,     label: '30 fps',                       dropFrame: false },
    { id: '48',     fps: 48,     label: '48 fps — HFR Cinema',          dropFrame: false },
    { id: '60',     fps: 60,     label: '60 fps — Smooth Motion',       dropFrame: false },
    { id: '120',    fps: 120,    label: '120 fps — Ultra HFR',          dropFrame: false },
];

const FRAME_RATE_VALUES = FRAME_RATES.map(f => f.fps);

// ── Delivery Presets ────────────────────────────────────────────────
// Each preset bundles resolution + aspect ratio + codec + color space
const DELIVERY_PRESETS = [
    /*
     * The three spot presets. A commercial's frame rate is chosen at
     * GENERATION and never conformed afterwards — conforming 24p footage to
     * 29.97 for a CTV buy is the one mistake that cannot be fixed in the grade —
     * so the preset exists to set the rate before a single frame is bought.
     */
    {
        id: 'spot_broadcast_na',
        label: 'Spot — NA broadcast / CTV',
        description: 'US & Canada air and connected TV: 29.97 drop-frame, 1920x1080',
        resolution: '1080p',
        target_resolution: '1920x1080',
        aspect_ratio: '16:9',
        target_fps: 29.97,
        color_space: 'Rec.709',
        codec: 'prores_422_hq',
        audio_channels: 'stereo',
    },
    {
        id: 'spot_broadcast_uk',
        label: 'Spot — UK/AU broadcast',
        description: 'PAL territories: 25fps, 1920x1080',
        resolution: '1080p',
        target_resolution: '1920x1080',
        aspect_ratio: '16:9',
        target_fps: 25,
        color_space: 'Rec.709',
        codec: 'prores_422_hq',
        audio_channels: 'stereo',
    },
    {
        id: 'spot_social',
        label: 'Spot — social first (vertical)',
        description: 'Generated VERTICAL and cropped outward. A 9:16 placement '
            + 'cut from a 16:9 master keeps 32% of its width, so a social-first '
            + 'campaign is generated at 9:16 and the 16:9 is derived, never the '
            + 'other way round.',
        resolution: '1080p_vertical',
        target_resolution: '1080x1920',
        aspect_ratio: '9:16',
        target_fps: 30,
        color_space: 'Rec.709',
        codec: 'h264',
        audio_channels: 'stereo',
    },
    {
        id: 'theatrical_dcp',
        label: 'Theatrical DCP',
        description: 'Digital Cinema Package for theatrical release',
        resolution: '4k_dci',
        target_resolution: '4096x2160',
        aspect_ratio: '2.39:1',
        target_fps: 24,
        color_space: 'DCI-P3',
        codec: 'jpeg2000',
        audio_channels: '5.1',
    },
    {
        id: 'imax',
        label: 'IMAX',
        description: 'IMAX digital or film presentation',
        resolution: 'imax_5.6k',
        target_resolution: '5616x4096',
        aspect_ratio: '1.43:1',
        target_fps: 24,
        color_space: 'DCI-P3',
        codec: 'prores_4444',
        audio_channels: '12.0',
    },
    {
        id: 'streaming_hd',
        label: 'Streaming HD',
        description: 'HD streaming (Netflix, YouTube, etc.)',
        resolution: '1080p',
        target_resolution: '1920x1080',
        aspect_ratio: '16:9',
        target_fps: 24,
        color_space: 'Rec.709',
        codec: 'h264',
        audio_channels: 'stereo',
    },
    {
        id: 'streaming_4k',
        label: 'Streaming 4K',
        description: '4K UHD streaming with HDR',
        resolution: '4k_uhd',
        target_resolution: '3840x2160',
        aspect_ratio: '16:9',
        target_fps: 24,
        color_space: 'Rec.2020',
        codec: 'h265',
        audio_channels: '5.1',
    },
    {
        id: 'social_media',
        label: 'Social Media',
        description: 'Vertical format for Instagram/TikTok/Shorts',
        resolution: '1080p',
        target_resolution: '1080x1920',
        aspect_ratio: '9:16',
        target_fps: 30,
        color_space: 'sRGB',
        codec: 'h264',
        audio_channels: 'stereo',
    },
    {
        id: 'broadcast',
        label: 'Broadcast',
        description: 'HD broadcast television',
        resolution: '1080p',
        target_resolution: '1920x1080',
        aspect_ratio: '16:9',
        target_fps: 25,
        color_space: 'Rec.709',
        codec: 'prores_422',
        audio_channels: 'stereo',
    },
];

const DELIVERY_PRESET_IDS = DELIVERY_PRESETS.map(d => d.id);

// ── Validation ──────────────────────────────────────────────────────

const RESOLUTION_RE = /^\d{3,5}x\d{3,5}$/;
const CUSTOM_RATIO_RE = /^(\d+(\.\d+)?):(\d+(\.\d+)?)$/;
const TIMECODE_RE = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Validate project settings object.
 * @param {object} settings
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateProjectSettings(settings) {
    const errors = [];

    if (settings.target_resolution !== undefined) {
        if (typeof settings.target_resolution !== 'string' || !RESOLUTION_RE.test(settings.target_resolution)) {
            errors.push(`Invalid target_resolution "${settings.target_resolution}". Expected format: WIDTHxHEIGHT (e.g. "1920x1080")`);
        }
    }

    if (settings.target_fps !== undefined) {
        const fps = Number(settings.target_fps);
        if (isNaN(fps) || fps <= 0 || fps > 240) {
            errors.push(`Invalid target_fps "${settings.target_fps}". Must be a positive number <= 240`);
        }
    }

    if (settings.aspect_ratio !== undefined) {
        if (!ASPECT_RATIO_IDS.includes(settings.aspect_ratio)) {
            errors.push(`Invalid aspect_ratio "${settings.aspect_ratio}". Valid: ${ASPECT_RATIO_IDS.join(', ')}`);
        }
    }

    if (settings.aspect_ratio === 'custom' && settings.aspect_ratio_custom) {
        if (!CUSTOM_RATIO_RE.test(settings.aspect_ratio_custom)) {
            errors.push(`Invalid aspect_ratio_custom "${settings.aspect_ratio_custom}". Expected format: "N:M" or "N.NN:1"`);
        }
    }

    if (settings.color_space !== undefined) {
        if (!COLOR_SPACE_IDS.includes(settings.color_space)) {
            errors.push(`Invalid color_space "${settings.color_space}". Valid: ${COLOR_SPACE_IDS.join(', ')}`);
        }
    }

    if (settings.delivery_format !== undefined && settings.delivery_format !== '') {
        if (!DELIVERY_PRESET_IDS.includes(settings.delivery_format)) {
            errors.push(`Invalid delivery_format "${settings.delivery_format}". Valid: ${DELIVERY_PRESET_IDS.join(', ')}`);
        }
    }

    if (settings.timecode_start !== undefined) {
        if (!TIMECODE_RE.test(settings.timecode_start)) {
            errors.push(`Invalid timecode_start "${settings.timecode_start}". Expected SMPTE format: HH:MM:SS:FF`);
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Resolve a delivery preset name to its full settings.
 * @param {string} presetId
 * @returns {object|null}
 */
function resolveDeliveryPreset(presetId) {
    return DELIVERY_PRESETS.find(p => p.id === presetId) || null;
}

/**
 * Compute resolution width from aspect ratio and target height.
 * @param {string} ratioStr - e.g. "16:9", "2.39:1", "1.43:1"
 * @param {number} height
 * @returns {number} width (rounded to nearest even number for codec compatibility)
 */
function computeResolution(ratioStr, height) {
    const match = ratioStr.match(CUSTOM_RATIO_RE);
    if (!match) return null;
    const num = parseFloat(match[1]);
    const den = parseFloat(match[3]);
    if (den === 0) return null;
    const decimal = num / den;
    const width = Math.round((height * decimal) / 2) * 2; // round to even
    return width;
}

/**
 * Parse a resolution string into width and height.
 * @param {string} resStr - e.g. "1920x1080"
 * @returns {{ width: number, height: number }|null}
 */
function parseResolution(resStr) {
    if (!resStr || !RESOLUTION_RE.test(resStr)) return null;
    const [w, h] = resStr.split('x').map(Number);
    return { width: w, height: h };
}


/**
 * A ratio written as a string, as a number.
 *
 * "16:9" also arrives as "16x9" and "16/9" depending on which surface wrote it,
 * and the reading was inline in the image budget — which was fine while the
 * frame's shape only decided the size of a picture. It decides how far a move
 * has to travel now too, and one string read two ways is how a board and a
 * playhead come to disagree about the shape of the same frame.
 */
function aspectValue(aspect, fallback) {
    const m = String(aspect || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i);
    if (!m) return fallback === undefined ? null : fallback;
    const ratio = Number(m[1]) / Number(m[2]);
    if (!Number.isFinite(ratio) || ratio <= 0) return fallback === undefined ? null : fallback;
    return ratio;
}

module.exports = {
    ASPECT_RATIOS,
    ASPECT_RATIO_IDS,
    RESOLUTIONS,
    RESOLUTION_IDS,
    COLOR_SPACES,
    COLOR_SPACE_IDS,
    FRAME_RATES,
    FRAME_RATE_VALUES,
    DELIVERY_PRESETS,
    DELIVERY_PRESET_IDS,
    aspectValue,
    validateProjectSettings,
    resolveDeliveryPreset,
    computeResolution,
    parseResolution,
};
