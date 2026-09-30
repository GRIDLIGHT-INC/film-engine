/**
 * What a video model lets you choose, per generation: length, ratio,
 * resolution, sound, the frame it ends on, output format, seed.
 *
 * "Seedance 2.5 takes a first and last frame and I can change the video length
 * to up to 30 seconds, resolution quality, screen ratio and HDR — those options
 * should appear in the modal."
 *
 * THE PROVIDER'S OWN STATEMENT, NEVER A LIST TYPED HERE. Every option is read
 * from `providers/video-model-fields.json`: Runway's per-model schemas from its
 * published OpenAPI spec, MuAPI's from the fields its endpoints accept (read
 * from a free 422). The hand-kept table in runway.js had already drifted from
 * the spec in five places — a Gen-4.5 ratio Runway refuses, Seedance 2.0 at 30s
 * where Runway allows 15, Hailuo 3 sent pixel ratios where it takes aspect
 * names — so a second hand-kept list would drift the same way.
 *
 * AN OPTION IS OFFERED ONLY WHERE IT REACHES THE REQUEST. Each control names
 * the payload field it sets, and each adapter sends that field only when its
 * own snapshot says the model takes it. A control that reaches nothing is the
 * failure this codebase keeps paying for, so what a model does NOT take is said
 * in `notes` rather than offered and dropped: MuAPI accepts no sound switch and
 * no HDR on Seedance 2.5, and HDR on Runway is an output format of Gen-4.5.
 *
 * Unset means "as the project would have it": the shot's own length, a ratio
 * matched to the project's frame, the provider's own default. So a generation
 * with no options chosen builds exactly the request it always did.
 */

const FIELDS = require('./providers/video-model-fields.json');

const RUNWAY = (FIELDS.runway && FIELDS.runway.models) || {};
const MUAPI = (FIELDS.muapi && FIELDS.muapi.endpoints) || {};

/** A pixel ratio reads better with its shape beside it. */
function ratioLabel(r) {
    const m = /^(\d+):(\d+)$/.exec(String(r));
    if (!m) return r === 'adaptive' ? 'Adaptive (follows the picture)'
        : /^auto_/.test(r) ? `Auto, ${r.slice(5)}` : r;
    const w = Number(m[1]), h = Number(m[2]);
    if (w < 100 && h < 100) return r;          // already an aspect name, e.g. 16:9
    const g = (a, b) => (b ? g(b, a % b) : a);
    const shapes = { '1.78': '16:9', '0.56': '9:16', '1.33': '4:3', '0.75': '3:4', '1.00': '1:1',
        '2.33': '21:9', '2.35': '2.35:1', '2.37': '21:9', '0.43': '9:21', '1.30': '4:3', '0.77': '3:4',
        '1.43': '1.43:1' };
    const shape = shapes[(w / h).toFixed(2)] || `${w / g(w, h)}:${h / g(w, h)}`;
    return `${w}×${h} · ${shape}`;
}

const FORMAT_LABEL = {
    mp4: 'MP4 (default)', prores: 'ProRes', png_sequence: 'PNG sequence',
    hdr10: 'HDR10', hlg: 'HLG (HDR)', sdr_rec709_10bit: 'SDR Rec.709 10-bit',
    hdr_pq_12bit_master: 'HDR PQ 12-bit master', hdr_prores: 'HDR ProRes',
    hdr_png_sequence: 'HDR PNG sequence', hdr_exr_sequence: 'HDR EXR sequence',
    hdr_exr_acescg_sequence_1_3: 'HDR EXR ACEScg (1.3)', hdr_exr_acescg_sequence_2_0: 'HDR EXR ACEScg (2.0)',
};

/** Runway: one schema per model, read straight out of the spec. */
function runwayControls(model) {
    const f = RUNWAY[model];
    if (!f) {
        return { controls: [], notes: [`${model} is not in Runway's image-to-video schema `
            + '(a video-to-video model takes its length from the source clip), so it has no options here.'] };
    }
    const controls = [];
    const notes = [];
    const d = f.duration || {};
    if (Array.isArray(d.enum)) {
        controls.push({ key: 'duration', label: 'Length', type: 'choice', field: 'duration_s',
            choices: d.enum.map(n => ({ id: n, label: `${n}s` })), note: 'Unset: the shot\'s own length, fitted to what this model takes.' });
    } else if (d.minimum !== undefined) {
        controls.push({ key: 'duration', label: 'Length', type: 'range', field: 'duration_s',
            min: d.minimum, max: d.maximum, step: 1, unit: 's', allow_auto: !!d.auto,
            note: 'Unset: the shot\'s own length, fitted to what this model takes.'
                + (d.auto ? ' Auto lets the model choose.' : '') });
    }
    if (f.ratio && Array.isArray(f.ratio.enum)) {
        controls.push({ key: 'ratio', label: 'Frame', type: 'choice', field: 'ratio',
            choices: f.ratio.enum.map(r => ({ id: r, label: ratioLabel(r) })),
            note: 'Unset: the size closest to the project\'s frame.' });
    }
    if (f.resolution && Array.isArray(f.resolution.enum)) {
        const seen = new Set();
        const choices = f.resolution.enum.filter(r => {
            const k = String(r).toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k); return true;
        }).map(r => ({ id: r, label: String(r).toUpperCase().replace('P', 'p') }));
        controls.push({ key: 'resolution', label: 'Resolution', type: 'choice', field: 'resolution', choices,
            note: 'Unset: the model\'s own default.' });
    }
    if (f.audio) {
        controls.push({ key: 'audio', label: 'Generate sound', type: 'toggle', field: 'audio',
            default: f.audio.default === undefined ? null : !!f.audio.default,
            note: f.audio.default === true
                ? 'On by default at Runway. Film Engine scores the film separately; off keeps the clip silent.'
                : 'The model\'s own sound. Film Engine scores the film separately.' });
    }
    const positions = (f.promptImage && f.promptImage.positions) || [];
    if (positions.includes('last')) {
        controls.push({ key: 'last_frame', label: 'Ends on', type: 'frame', field: 'last_frame',
            note: 'The board frame is the first frame. Pick a shot whose frame this clip should arrive at.' });
    } else {
        notes.push(`${model} takes one keyframe: the board frame. It cannot be given an ending frame.`);
    }
    if (f.outputFormat && Array.isArray(f.outputFormat.enum)) {
        controls.push({ key: 'output_format', label: 'Output format', type: 'choice', field: 'output_format',
            choices: f.outputFormat.enum.map(x => ({ id: x, label: FORMAT_LABEL[x] || x })),
            note: 'HDR and ProRes are delivered as this model\'s output formats.' });
    }
    if (f.negativePrompt) {
        controls.push({ key: 'negative_prompt', label: 'Avoid', type: 'text', field: 'video_negative_prompt',
            max: 1000, note: 'What should not appear in the clip.' });
    }
    if (f.seed) controls.push({ key: 'seed', label: 'Seed', type: 'number', field: 'seed',
        min: f.seed.minimum || 0, max: f.seed.maximum || 4294967295, note: 'Same seed, same inputs: the closest this model gets to repeating a take.' });
    if (!f.audio) notes.push(`${model} has no sound switch.`);
    return { controls, notes };
}

/** MuAPI Seedance 2.5: the resolution is the model picked; the rest per endpoint. */
function seedanceControls(model) {
    const i2v = MUAPI['seedance-2.5-image-to-video'] || {};
    const flf = MUAPI['seedance-2.5-first-last-frame'];
    const { MIN_DURATION, MAX_DURATION } = require('./providers/seedance');
    const controls = [
        { key: 'duration', label: 'Length', type: 'range', field: 'duration_s', min: MIN_DURATION, max: MAX_DURATION,
            step: 1, unit: 's', note: 'Unset: the shot\'s own length. Billed per second.' },
    ];
    if (i2v.aspect_ratio && i2v.aspect_ratio.enum) {
        controls.push({ key: 'ratio', label: 'Frame', type: 'choice', field: 'aspect_ratio',
            choices: i2v.aspect_ratio.enum.map(r => ({ id: r, label: ratioLabel(r) })),
            note: 'Unset: the shape closest to the project\'s frame.' });
    }
    if (flf) {
        controls.push({ key: 'last_frame', label: 'Ends on', type: 'frame', field: 'last_frame',
            note: 'The board frame is the first frame. With an ending frame this runs on Seedance\'s first-last-frame endpoint.' });
    }
    if (i2v.seed) controls.push({ key: 'seed', label: 'Seed', type: 'number', field: 'seed', min: 0, max: 2147483647 });
    if (i2v.draft) controls.push({ key: 'draft', label: 'MuAPI draft', type: 'toggle', field: 'muapi_draft', default: false,
        note: 'MuAPI accepts a draft switch on this endpoint and documents nothing more about it.' });
    return {
        controls,
        notes: [
            `The resolution is the model you picked (${model || 'Seedance 2.5'}): pick another Seedance model for 480p, 720p, 1080p or 4K.`,
            'MuAPI accepts no sound switch on Seedance 2.5 (probed 2026-09-30), so whether the clip carries Seedance\'s own sound is MuAPI\'s default.',
            'No HDR: MuAPI offers none for Seedance 2.5. Runway\'s Gen-4.5 has HDR output formats.',
        ],
    };
}

/**
 * The options a model takes, or null when this provider declares none here.
 * @returns {{provider, model, controls, notes, source, checked}|null}
 */
function optionsFor(providerId, model) {
    const id = String(providerId || '');
    let out = null;
    if (id === 'runway') out = runwayControls(String(model || require('./providers/runway').adapter.defaultModel || 'gen4.5'));
    else if (id === 'seedance') out = seedanceControls(model);
    if (!out) return null;
    return {
        provider: id, model: model || null,
        controls: out.controls, notes: out.notes,
        source: id === 'runway' ? FIELDS.runway.source : FIELDS.muapi.source,
        checked: FIELDS.checked,
    };
}

/**
 * Keep what the model takes, refuse the rest by name.
 * @returns {{values: object, refused: string[]}}
 */
function readOptions(providerId, model, raw) {
    const opts = optionsFor(providerId, model);
    const values = {};
    const refused = [];
    const src = raw && typeof raw === 'object' ? raw : {};
    const byKey = new Map(((opts && opts.controls) || []).map(c => [c.key, c]));
    for (const [key, v] of Object.entries(src)) {
        if (v === null || v === undefined || v === '') continue;
        const c = byKey.get(key);
        if (!c) { refused.push(`${key}: ${model || providerId} does not take this`); continue; }
        if (c.type === 'choice') {
            const hit = c.choices.find(x => String(x.id) === String(v));
            if (!hit) { refused.push(`${key}: ${v} is not one of ${c.choices.map(x => x.id).join(', ')}`); continue; }
            values[key] = hit.id;
        } else if (c.type === 'range') {
            if (c.allow_auto && v === 'auto') { values[key] = 'auto'; continue; }
            const n = Number(v);
            if (!Number.isFinite(n) || n < c.min || n > c.max) { refused.push(`${key}: ${v} is outside ${c.min}–${c.max}${c.unit || ''}`); continue; }
            values[key] = Math.round(n);
        } else if (c.type === 'number') {
            const n = Number(v);
            if (!Number.isInteger(n) || n < c.min || n > c.max) { refused.push(`${key}: ${v} is not a whole number from ${c.min} to ${c.max}`); continue; }
            values[key] = n;
        } else if (c.type === 'toggle') {
            values[key] = v === true || v === 'true' || v === 1 || v === '1';
        } else if (c.type === 'text') {
            values[key] = String(v).slice(0, c.max || 1000);
        } else if (c.type === 'frame') {
            values[key] = String(v);               // a shot id; the route resolves and checks it
        }
    }
    return { values, refused };
}

/** Parse `options` as it arrives: an object in a body, JSON in a query string. */
function optionsParam(src) {
    const o = src && src.options;
    if (!o) return {};
    if (typeof o === 'object') return o;
    try { const parsed = JSON.parse(String(o)); return parsed && typeof parsed === 'object' ? parsed : {}; }
    catch (_) { return {}; }
}

/**
 * Write the chosen values onto a built video payload. `lastFrameUri` is the
 * resolved picture for `last_frame` (the route owns reading another shot).
 */
function applyVideoOptions(payload, values, { lastFrameUri } = {}) {
    const p = payload;
    const v = values || {};
    if (v.duration === 'auto') p.duration_auto = true;
    else if (v.duration !== undefined) {
        p.duration_s = v.duration;
        if (Number(p.fps) > 0) p.num_frames = Math.round(v.duration * Number(p.fps));
    }
    if (v.ratio !== undefined) { p.ratio = v.ratio; p.aspect_ratio = v.ratio; }
    if (v.resolution !== undefined) p.resolution = v.resolution;
    if (v.audio !== undefined) { p.audio = v.audio; p.generate_audio = v.audio; }
    if (v.output_format !== undefined) p.output_format = v.output_format;
    if (v.negative_prompt !== undefined) p.video_negative_prompt = v.negative_prompt;
    if (v.seed !== undefined) p.seed = v.seed;
    // `draft` on the payload is already this engine's own draft-mode record.
    if (v.draft !== undefined) p.muapi_draft = v.draft;
    if (lastFrameUri) {
        p.last_frame = lastFrameUri;
        if (p.init_image) p.keyframes = [{ uri: p.init_image }, { uri: lastFrameUri }];
    }
    return p;
}

module.exports = { optionsFor, readOptions, optionsParam, applyVideoOptions, ratioLabel, FIELDS };
