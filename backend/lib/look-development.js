/**
 * Look development: deciding how a film looks, and catching a style that
 * quietly describes a subject.
 *
 * The defect this exists for shipped. A project's style_preset read
 * "…teal/amber, wet streets, mist, ANATOMICAL BEAST, anamorphic, grain", and
 * that string is appended to every image prompt in the production. So the
 * establishing shot — scene card: "Empty, ordinary, still." — came back with a
 * flayed quadruped standing in the road, and the sprinkler insert came back
 * with a gargoyle at its base. Nobody wrote those shots; the style did.
 *
 * A style preset is a free-text column, applied everywhere, validated nowhere,
 * and there was no surface on which a look was ever assembled — so there was
 * no moment at which anyone could have noticed. This module is that moment.
 *
 * It WARNS, never blocks. Previs set the precedent: errors stop a save,
 * warnings do not. A creature film may legitimately want a creature in every
 * frame, and a tool that refuses to save that is overruling its author.
 */

/**
 * Words that name a THING rather than a quality of light.
 *
 * Deliberately concrete and deliberately short. The asymmetry matters: a
 * validator that rejects real cinematographic vocabulary gets switched off
 * within a day and then protects nothing, so the list covers subjects that
 * plausibly appear in a style string — creatures, people, animals, objects —
 * and stops well short of guessing.
 */
const SUBJECT_WORDS = [
    // Creatures and figures — the category that actually bit us.
    'beast', 'creature', 'monster', 'dragon', 'gargoyle', 'demon', 'ghost', 'zombie',
    'alien', 'robot', 'android', 'skeleton', 'corpse', 'body',
    // People.
    'man', 'woman', 'child', 'girl', 'boy', 'person', 'people', 'crowd', 'figure',
    'soldier', 'knight', 'priest', 'dancer',
    // Animals.
    'horse', 'dog', 'cat', 'bird', 'wolf', 'snake', 'insect', 'spider',
    // Objects that get drawn.
    'car', 'sword', 'gun', 'castle', 'ship', 'train', 'house', 'tree', 'flower',
];

/**
 * Words that look like subjects but are established cinematographic vocabulary.
 *
 * Without this, "body" in "body of light" and the "grain" in "film grain" start
 * failing real styles — and a false positive here is more expensive than a
 * miss, because it teaches the director to ignore the warning.
 */
const LOOK_EXCEPTIONS = new Set([
    'bodycam', 'bodies',      // "bodies of light" reads as a look
    'housing', 'household',
    'carbon', 'cartoon',
    'birdseye', 'birdlike',
]);

const WORD_RE = /[a-z][a-z'-]*/gi;

/**
 * Does this style preset describe a subject as well as a look?
 *
 * @returns {{ ok: boolean, severity: string, subjects: string[], detail: string }}
 */
function validateStylePreset(style) {
    const text = String(style || '').trim();
    // No style at all is normal and must never be an error — plenty of projects
    // have none, and failing them would block project creation for no reason.
    if (!text) return { ok: true, severity: 'ok', subjects: [], detail: '' };

    const words = (text.toLowerCase().match(WORD_RE) || []);
    const found = [];
    for (const raw of words) {
        const word = raw.replace(/[^a-z]/g, '');
        if (!word || LOOK_EXCEPTIONS.has(word)) continue;
        // Match the bare word and its simple plural only. Substring matching
        // turns "grainy" into "rain" and every style into a failure.
        const hit = SUBJECT_WORDS.find(sw => word === sw || word === sw + 's' || word === sw + 'es');
        if (hit && !found.includes(hit)) found.push(hit);
    }

    if (!found.length) return { ok: true, severity: 'ok', subjects: [], detail: '' };

    return {
        ok: false,
        severity: 'warning',
        subjects: found,
        detail: `A style preset is applied to EVERY image prompt in the production, so a subject named here `
            + `is drawn into frames nobody wrote it into — this is how an establishing shot described as `
            + `"empty, ordinary, still" came back with a creature standing in the road. `
            + `Move ${found.map(w => `"${w}"`).join(', ')} onto the character or prop it belongs to, `
            + `and keep the style to light, palette, lens and grain. Saved either way.`,
    };
}

// ── Specs: picked from the engine's own registries, applied to real settings ──
//
// Every technical choice on the board used to be free text, which meant a lens
// you picked could reach a prompt string and nothing else — not previs, which
// solves framing from a real focal length, and not the project settings, which
// decide what is actually delivered. A spec that lands nowhere is the thing
// this replaces.
//
// The registries are REFERENCED, never copied. A local list of focal lengths
// would drift from LENS_KIT the first time a lens was added, and the drift
// would show up as a lens the board offers and previs refuses.

const { LENS_KIT, SENSORS, APERTURES } = require('./previs-camera');
const presets = require('./project-presets');

/**
 * What a spec is, where its legal values come from, and where it lands.
 *
 *   project  written to a film_projects column that affects delivery
 *   previs   seeds a stage so blocking starts from the film's own optics
 *   prompt   reaches the words, because some looks genuinely are words
 */
const SPEC_KINDS = {
    lens:         { target: 'previs',  field: 'focalMm',  label: 'Focal length (mm)' },
    sensor:       { target: 'previs',  field: 'sensorId', label: 'Sensor' },
    aperture:     { target: 'previs',  field: 'fStop',    label: 'Aperture (T-stop)' },
    aspect_ratio: { target: 'project', column: 'aspect_ratio',     label: 'Aspect ratio' },
    resolution:   { target: 'project', column: 'target_resolution', label: 'Resolution' },
    frame_rate:   { target: 'project', column: 'target_fps',        label: 'Frame rate' },
    color_space:  { target: 'project', column: 'color_space',       label: 'Colour space' },
    style_preset: { target: 'prompt',  label: 'Style preset' },
};

/** The legal values for a spec, straight off the registry that owns them. */
function allowedSpecValues(kind) {
    switch (kind) {
        case 'lens': return LENS_KIT;
        case 'sensor': return Object.keys(SENSORS);
        case 'aperture': return APERTURES;
        case 'aspect_ratio': return presets.ASPECT_RATIO_IDS;
        case 'resolution': return presets.RESOLUTION_IDS;
        case 'frame_rate': return presets.FRAME_RATE_VALUES;
        case 'color_space': return presets.COLOR_SPACE_IDS;
        case 'style_preset': return Object.keys(STYLE_PRESET_IDS);
        default: return [];
    }
}

// The prompt-level style vocabulary, from the prompt builder that consumes it.
// Required lazily: storyboard-prompt requires this module back for the subject
// check, and a top-level require in both directions leaves one of them empty.
const STYLE_PRESET_IDS = new Proxy({}, {
    ownKeys() { return Object.keys(require('./storyboard-prompt').STYLE_PRESETS || {}); },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
});

/** Is this a value the engine will actually accept for this spec? */
function validateSpec(kind, value) {
    const spec = SPEC_KINDS[kind];
    if (!spec) return { ok: false, error: `unknown spec '${kind}'` };
    const allowed = allowedSpecValues(kind);
    const ok = allowed.some(v => String(v) === String(value));
    return ok
        ? { ok: true }
        : { ok: false, error: `${kind} must be one of: ${allowed.slice(0, 12).join(', ')}${allowed.length > 12 ? '…' : ''}` };
}

/**
 * A spec's value as the project column stores it.
 *
 * `resolution` is the one that differs: the registry offers ids a human picks
 * ("1080p") while target_resolution holds the dimensions every exporter parses
 * ("1920x1080"). Writing the id would pass validation and break the export.
 */
function columnValueFor(kind, value) {
    if (kind === 'resolution') {
        const preset = (presets.RESOLUTIONS || []).find(r => r.id === String(value));
        return preset ? `${preset.width}x${preset.height}` : String(value);
    }
    return String(value);
}

/**
 * Write the project-targeted specs onto the project.
 *
 * Applied through the same columns the settings UI writes, so a look decided on
 * the board and one typed into settings cannot disagree about what is delivered.
 */
function applyProjectSpecs(db, projectId, specs) {
    const applied = [];
    for (const { kind, value } of (specs || [])) {
        const spec = SPEC_KINDS[kind];
        if (!spec || spec.target !== 'project') continue;
        if (!validateSpec(kind, value).ok) continue;
        // The registry id and the column value are different vocabularies, and
        // conflating them writes "1080p" into a column every export parses as
        // WIDTHxHEIGHT. Translated here, once, where both are in view.
        const stored = columnValueFor(kind, value);
        db.prepare(`UPDATE film_projects SET ${spec.column} = ? WHERE id = ?`).run(stored, projectId);
        applied.push({ kind, value, column: spec.column, stored });
    }
    return applied;
}

/**
 * The camera a stage should be seeded with.
 *
 * previs/from-card falls back to a 50mm on super35 when a card says nothing;
 * these are the film's own defaults, so a shot nobody has specified still opens
 * on the lens the production actually shoots.
 */
function previsDefaults(specs) {
    const out = {};
    for (const { kind, value } of (specs || [])) {
        const spec = SPEC_KINDS[kind];
        if (!spec || spec.target !== 'previs') continue;
        if (!validateSpec(kind, value).ok) continue;
        out[spec.field] = kind === 'sensor' ? String(value) : Number(value);
    }
    return out;
}

/**
 * The board's images, as style references for generation.
 *
 * lib/reference-images has had a `style: 3` rank since it was written and
 * nothing has ever put anything in it — so a picture pinned to the board
 * changed no output anywhere, which makes it decoration rather than a
 * reference. Ranked below character and location deliberately: with three
 * reference slots, a look plate displacing the actor would be the wrong trade
 * every time, because a viewer notices a different face long before a different
 * grade.
 */
function styleReferences(db, projectId, limit) {
    const rows = db.prepare(
        `SELECT id, note, asset_id, image_path FROM film_mood_board
          WHERE project_id = ? AND (image_path <> '' OR asset_id IS NOT NULL)
       ORDER BY sort_order, created_at`).all(projectId);

    const out = [];
    for (const row of rows) {
        let filePath = row.image_path || '';
        if (!filePath && row.asset_id) {
            const asset = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(row.asset_id);
            filePath = (asset && asset.file_path) || '';
        }
        if (!filePath) continue;
        out.push({
            // Named so the prompt can address it where a provider supports tags.
            name: String(row.note || 'look').trim() || 'look',
            kind: 'style',
            file_path: filePath,
        });
        if (limit && out.length >= limit) break;
    }
    return out;
}

/**
 * The optics this production shoots on, from the board.
 *
 * These were only ever read by previs/from-card, so they applied to whichever
 * shots someone had opened the 3D stage for — one of eight, in practice — and
 * the other seven generated on a generic 50mm super35 default belonging to no
 * production. A spec a director deliberately chose was decoration.
 *
 * Blocking is optional; the lens the film shoots on is not. Returns {} when
 * nothing is chosen, never an invented default: a made-up lens here would be
 * indistinguishable from a deliberate one and would override the scene card.
 */
function filmOptics(db, projectId) {
    let rows = [];
    try {
        rows = db.prepare(
            'SELECT spec_kind, spec_value FROM film_mood_board WHERE project_id = ? AND spec_kind IS NOT NULL')
            .all(projectId);
    } catch (_) { return {}; }
    return previsDefaults(rows.map(r => ({ kind: r.spec_kind, value: r.spec_value })));
}

module.exports = {    validateStylePreset,
    SPEC_KINDS, allowedSpecValues, validateSpec,
    applyProjectSpecs, previsDefaults, styleReferences, filmOptics,};
