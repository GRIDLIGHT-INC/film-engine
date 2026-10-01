/**
 * What each provider lets you choose for THIS generation, for every
 * capability that is not video (video's options live in lib/model-options.js,
 * read from Runway's and MuAPI's own schemas, and are applied by the video
 * routes).
 *
 * "On the modal I should be able to select any provider who has been
 * connected, and then on this modal the options for that provider would show.
 * And once I click generate these options along with the prompt would be
 * passed in the payload to the endpoint. This is what I'm looking for for any
 * generate button."
 *
 * THE ADAPTER'S OWN VOCABULARY, NEVER A LIST TYPED HERE. Every choice is read
 * from the constant the adapter already validates its request against: MuAPI's
 * aspect ratios from the fields its endpoints accept (tests/fixtures/
 * muapi-contract.json, read from a free 422), Meshy's and Runway's ratio lists
 * from their adapters, OpenAI's sizes and qualities from its own VALID_*
 * lists, ElevenLabs' bounds from the constants its builder clamps to. A second
 * list here would drift from the adapter the way the hand-kept Runway video
 * table drifted from Runway's spec.
 *
 * AN OPTION IS OFFERED ONLY WHERE IT REACHES THE REQUEST. Each control names
 * the payload field it sets, and the adapter already reads that field. What a
 * provider does NOT take is said in `notes` rather than offered and dropped:
 * MuAPI, Google and Meshy accept no seed; boards are stored as PNG, so MuAPI's
 * jpg/png switch is not offered.
 *
 * APPLIED AT ONE PLACE. `applyChosen` is called from resolve()'s wrapper, the
 * funnel every generation passes through, and only when the adapter about to
 * run is the provider the options were chosen for: a fallback chain that walks
 * to another vendor after a refusal must not carry one vendor's switches to
 * another. Unset means "as the project would have it", so a generation with no
 * options chosen builds exactly the request it always did.
 */

const SOURCES = {
    muapi: 'the fields MuAPI\'s endpoints accept (tests/fixtures/muapi-contract.json)',
    adapter: 'the adapter\'s own request vocabulary',
    elevenlabs: 'ElevenLabs\' documented voice settings and sound-generation bounds',
    meshy: 'Meshy\'s text-to-mesh request (art_style, should_remesh, negative_prompt, seed)',
};

const NEGATIVE = {
    key: 'negative_prompt', label: 'Avoid', type: 'text', field: 'negative_prompt', max: 600,
    note: 'Added to what the shot already avoids. Folded into the prompt on providers with no negative field.',
};

function ratioChoices(list) {
    const { ratioLabel } = require('./model-options');
    return list.map(r => ({ id: r, label: ratioLabel(r) }));
}

/**
 * The ratios a MuAPI image model takes: the adapter's own ACCEPTED_RATIOS,
 * which is what every Nano Banana endpoint there reports, text and edit alike.
 * Whether references ride along decides the endpoint, so a ratio both accept is
 * one that cannot be refused; "Auto" leaves the shape to MuAPI, the opposite of
 * choosing one.
 */
function muapiRatios() {
    return require('./providers/muapi-image').ACCEPTED_RATIOS.slice();
}

function imageControls(providerId, model) {
    const controls = [];
    const notes = [];
    let source = SOURCES.adapter;
    if (providerId === 'muapi') {
        source = SOURCES.muapi;
        const ratios = muapiRatios();
        if (ratios.length) {
            controls.push({ key: 'frame', label: 'Frame', type: 'choice', field: 'aspect_ratio',
                choices: ratioChoices(ratios), note: 'Unset: the shot\'s own shape.' });
        }
        // No Avoid: MuAPI has no negative field, and folding one into the
        // prompt names each excluded thing to the model (muapi-image.js).
        notes.push('MuAPI accepts no seed and no negative on any Nano Banana endpoint, so there is no Avoid list here.');
        notes.push('The size is the "Size for this one" choice: MuAPI sells 1K, 2K and 4K on the same model.');
    } else if (providerId === 'google') {
        const { ASPECTS } = require('./providers/google-image');
        controls.push({ key: 'frame', label: 'Frame', type: 'choice', field: 'aspect_ratio',
            choices: ratioChoices(ASPECTS), note: 'Unset: the shot\'s own shape, snapped to Google\'s ratios.' });
        controls.push(NEGATIVE);
        notes.push('Google\'s image API takes no seed and no negative field: the negative is folded into the prompt.');
    } else if (providerId === 'meshy') {
        const { IMAGE_RATIOS } = require('./providers/meshy');
        const list = IMAGE_RATIOS[model] || IMAGE_RATIOS._default;
        controls.push({ key: 'frame', label: 'Frame', type: 'choice', field: 'aspect_ratio',
            choices: ratioChoices(list), note: 'Unset: the shot\'s own shape, snapped to what this model takes.' });
        controls.push(NEGATIVE);
        notes.push('Meshy returns about one megapixel whatever size is asked for, and takes no seed.');
    } else if (providerId === 'runway') {
        const { IMAGE_RATIOS } = require('./providers/runway');
        controls.push({ key: 'frame', label: 'Frame', type: 'choice', field: 'ratio',
            choices: ratioChoices(IMAGE_RATIOS), note: 'Unset: the size closest to the shot\'s own shape.' });
        controls.push(NEGATIVE);
        notes.push('Runway\'s text_to_image takes no seed.');
    } else if (providerId === 'openai') {
        const { VALID_SIZES, VALID_QUALITY } = require('./providers/openai-image');
        controls.push({ key: 'frame', label: 'Size', type: 'choice', field: 'size',
            choices: VALID_SIZES.filter(s => s !== 'auto').map(s => ({ id: s, label: s.replace('x', '×') })),
            note: 'The Images API offers three sizes. Unset: the one closest to the shot\'s shape.' });
        controls.push({ key: 'quality', label: 'Quality', type: 'choice', field: 'quality',
            choices: VALID_QUALITY.map(q => ({ id: q, label: q[0].toUpperCase() + q.slice(1) })),
            note: 'OpenAI prices by this. Unset: high.' });
        controls.push(NEGATIVE);
        notes.push('The Images API takes no seed.');
    } else if (providerId === 'gridlight') {
        controls.push({ key: 'seed', label: 'Seed', type: 'number', field: 'seed', min: 0, max: 2147483647,
            note: 'Same seed, same inputs: the local gateway repeats a picture.' });
        controls.push(NEGATIVE);
    } else {
        return null;
    }
    return { controls, notes, source };
}

function audioControls(capability, providerId) {
    if (providerId !== 'elevenlabs') return null;
    const unit = (min, max, note) => ({ type: 'decimal', min, max, step: 0.05, note });
    if (capability === 'voice') {
        return {
            source: SOURCES.elevenlabs,
            controls: [
                { key: 'stability', label: 'Stability', field: 'stability',
                    ...unit(0, 1, 'Lower is more varied, higher is steadier. Unset: the character\'s own, else 0.5.') },
                { key: 'similarity_boost', label: 'Similarity', field: 'similarity_boost',
                    ...unit(0, 1, 'How closely it holds to the cast voice. Unset: 0.75.') },
                { key: 'style', label: 'Style', field: 'style',
                    ...unit(0, 1, 'Exaggeration. Unset: the line\'s own direction.') },
                { key: 'speed', label: 'Speed', field: 'speed',
                    ...unit(0.7, 1.2, 'ElevenLabs takes 0.7 to 1.2. Unset: normal.') },
                { key: 'use_speaker_boost', label: 'Speaker boost', type: 'toggle', field: 'use_speaker_boost',
                    default: null, note: 'Unset: ElevenLabs\' default.' },
            ],
            notes: ['Every line in this generation uses these. The casting and the lines are unchanged.'],
        };
    }
    const { SFX_MIN_SECONDS, SFX_MAX_SECONDS } = require('./providers/elevenlabs');
    if (capability === 'sfx') {
        return {
            source: SOURCES.elevenlabs,
            controls: [
                { key: 'duration', label: 'Length', type: 'decimal', field: 'duration_s', min: SFX_MIN_SECONDS,
                    max: SFX_MAX_SECONDS, step: 0.5, unit: 's', note: 'Unset: what the card asks for.' },
                { key: 'prompt_influence', label: 'Follow the prompt', field: 'prompt_influence',
                    ...unit(0, 1, 'Higher sticks to the words. Unset: 0.3.') },
            ],
            notes: [],
        };
    }
    if (capability === 'ambient') {
        return {
            source: SOURCES.elevenlabs,
            controls: [
                { key: 'prompt_influence', label: 'Follow the prompt', field: 'prompt_influence',
                    ...unit(0, 1, 'Higher sticks to the words. Unset: 0.3.') },
            ],
            notes: ['The bed\'s length is the scene\'s: it is generated as a loop and laid across the cut.'],
        };
    }
    if (capability === 'music') {
        return {
            source: SOURCES.elevenlabs,
            controls: [
                { key: 'vocals', label: 'Vocals', type: 'toggle', field: 'vocals', default: false,
                    note: 'Off by default: film cues are underscore, and sung words fight dialogue.' },
            ],
            notes: ['The length is the cue\'s or the measured cut\'s. Sections, when written, replace the vocal switch.'],
        };
    }
    return null;
}

function meshControls(providerId) {
    if (providerId !== 'meshy') return null;
    return {
        source: SOURCES.meshy,
        controls: [
            { key: 'art_style', label: 'Art style', type: 'choice', field: 'art_style',
                choices: [{ id: 'realistic', label: 'Realistic' }, { id: 'sculpture', label: 'Sculpture' }],
                note: 'Unset: realistic.' },
            { key: 'should_remesh', label: 'Remesh', type: 'toggle', field: 'should_remesh', default: true,
                note: 'On: a clean, lighter mesh. Off: the raw topology.' },
            { ...NEGATIVE, note: 'Sent to Meshy as its own negative_prompt, on a text-to-mesh.' },
            { key: 'seed', label: 'Seed', type: 'number', field: 'seed', min: 0, max: 2147483647,
                note: 'Same seed, same prompt: Meshy\'s closest thing to repeating a mesh.' },
        ],
        notes: ['These apply to a mesh from words. A mesh from a picture takes only Remesh.'],
    };
}

/**
 * The options a provider (and model) takes for a capability, or null when it
 * declares none here.
 */
function controlsFor(capability, providerId, model) {
    const cap = String(capability || '');
    const id = String(providerId || '');
    if (!cap || !id) return null;
    if (cap === 'video') return require('./model-options').optionsFor(id, model);
    let out = null;
    if (cap === 'image') out = imageControls(id, model);
    else if (['voice', 'sfx', 'ambient', 'music'].includes(cap)) out = audioControls(cap, id);
    else if (cap === 'model3d') out = meshControls(id);
    if (!out) return null;
    return { provider: id, model: model || null, capability: cap,
        controls: out.controls, notes: out.notes, source: out.source };
}

/**
 * Keep what the provider takes, refuse the rest by name.
 * @returns {{values: object, refused: string[]}}
 */
function readChosen(capability, providerId, model, raw) {
    const spec = controlsFor(capability, providerId, model);
    const values = {};
    const refused = [];
    const src = raw && typeof raw === 'object' ? raw : {};
    const byKey = new Map(((spec && spec.controls) || []).map(c => [c.key, c]));
    for (const [key, v] of Object.entries(src)) {
        if (v === null || v === undefined || v === '') continue;
        const c = byKey.get(key);
        if (!c) { refused.push(`${key}: ${model || providerId} does not take this`); continue; }
        if (c.type === 'choice') {
            const hit = c.choices.find(x => String(x.id) === String(v));
            if (!hit) { refused.push(`${key}: ${v} is not one of ${c.choices.map(x => x.id).join(', ')}`); continue; }
            values[key] = hit.id;
        } else if (c.type === 'decimal') {
            const n = Number(v);
            if (!Number.isFinite(n) || n < c.min || n > c.max) { refused.push(`${key}: ${v} is outside ${c.min}–${c.max}${c.unit || ''}`); continue; }
            values[key] = n;
        } else if (c.type === 'number') {
            const n = Number(v);
            if (!Number.isInteger(n) || n < c.min || n > c.max) { refused.push(`${key}: ${v} is not a whole number from ${c.min} to ${c.max}`); continue; }
            values[key] = n;
        } else if (c.type === 'toggle') {
            values[key] = v === true || v === 'true' || v === 1 || v === '1';
        } else if (c.type === 'text') {
            values[key] = String(v).slice(0, c.max || 1000);
        }
    }
    return { values, refused };
}

/** "16:9" → the payload's own long edge in that shape, kept even. */
function reshape(p, ratio) {
    const m = String(ratio).match(/^\s*(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)\s*$/i);
    if (!m) return;
    const a = Number(m[1]), b = Number(m[2]);
    if (!(a > 0 && b > 0)) return;
    // A pixel pair (Runway, OpenAI) IS the size; an aspect keeps the long edge.
    if (a >= 256 && b >= 256) { p.width = a; p.height = b; return; }
    const long = Math.max(Number(p.width) || 0, Number(p.height) || 0) || 2048;
    const even = n => Math.max(256, Math.round(n / 2) * 2);
    if (a >= b) { p.width = long; p.height = even(long * b / a); }
    else { p.height = long; p.width = even(long * a / b); }
}

/** Write chosen values onto a built payload for that provider. */
function applyValues(capability, providerId, payload, values) {
    const p = payload;
    const v = values || {};
    const spec = controlsFor(capability, providerId, p.model);
    if (!spec) return p;
    for (const c of spec.controls) {
        if (v[c.key] === undefined) continue;
        const val = v[c.key];
        if (c.key === 'frame') {
            reshape(p, val);
            p[c.field] = val;
        } else if (c.key === 'negative_prompt') {
            p.negative_prompt = [p.negative_prompt, val].filter(Boolean).join(', ');
        } else {
            p[c.field] = val;
        }
    }
    return p;
}

/**
 * A size chosen for this one image: the payload keeps its shape and takes the
 * chosen raster's long edge. Every image adapter derives its own size field
 * (a MuAPI or Google tier, a Runway ratio, an OpenAI size) from the width and
 * height, so this is the one place the choice has to land.
 */
function applySize(cfg, payload) {
    const want = cfg && cfg.image_target_resolution;
    const m = String(want || '').match(/^(\d+)x(\d+)$/);
    if (!m || !payload) return payload;
    const long = Math.max(Number(m[1]), Number(m[2]));
    const w = Number(payload.width) || 0, h = Number(payload.height) || 0;
    if (!w || !h) { payload.width = Number(m[1]); payload.height = Number(m[2]); return payload; }
    const even = n => Math.max(256, Math.round(n / 2) * 2);
    if (w >= h) { payload.width = long; payload.height = even(long * h / w); }
    else { payload.height = long; payload.width = even(long * w / h); }
    payload.target_resolution = `${m[1]}x${m[2]}`;
    return payload;
}

/**
 * Everything a director chose for this generation, applied to the payload the
 * adapter is about to send. Called from resolve()'s wrapper. Never throws: a
 * choice that cannot be applied must not fail a generation that was paid for.
 */
function applyChosen(capability, cfg, providerId, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const cap = String(capability || '');
    if (cap === 'video') return payload;          // the video routes apply their own
    try {
        if (cap === 'image') applySize(cfg, payload);
        const chosen = cfg && cfg[`${cap}_options`];
        if (chosen && chosen.values && chosen.provider === providerId) {
            const { values } = readChosen(cap, providerId, payload.model, chosen.values);
            applyValues(cap, providerId, payload, values);
        }
    } catch (err) {
        console.error('[generation-options] a chosen option could not be applied:', err.message);
    }
    return payload;
}

/**
 * The raster a finished image should be conformed to, when the size or frame
 * were chosen for this one. The storyboard crops a returned picture to what was
 * asked; asked must mean what was actually sent.
 */
function finalRaster(cfg, providerId, width, height) {
    const p = { width, height };
    applyChosen('image', cfg, providerId, p);
    return { width: p.width, height: p.height };
}

module.exports = { controlsFor, readChosen, applyValues, applyChosen, applySize, finalRaster, SOURCES };
