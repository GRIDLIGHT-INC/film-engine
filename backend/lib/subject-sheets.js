/**
 * ── A location and a prop are workspaces too ────────────────────────────────
 *
 * `reads` is the payload fields a region DISPLAYS, and it exists because the
 * first build shipped four regions fed by nothing: the prop sheet asked for
 * `views` from a route that answered a different shape and reported "No plate
 * yet" for a prop that had one; "Appears in" read a count the single GET never
 * served and said 0 shots for a prop in two; "Scenes here" did the same. Every
 * one of them RENDERED, which is all the test checked. A number nothing feeds
 * is worse than no number, because it reads as a fact about the film.
 *
 * The character card became a sheet — official views, everything written,
 * wardrobe, palette, a concept band — and locations and props stayed a form in
 * a modal. Same gap, two other subjects, and the design handoffs in
 * design_handoff_character_card/ describe what they should be instead.
 *
 * Regions are DECLARED here and the sheet is held to drawing every one, on the
 * rule lib/character-sheet.js already set: a sheet that renders the plates and
 * silently drops the continuity states looks finished in a screenshot, which is
 * how a half-built sheet ships.
 *
 * `anchor` is the string the renderer must contain, so a region cannot be
 * declared and then quietly not drawn. `readonly` regions state what they are
 * derived FROM — an omission that is stated is a decision, one that is silent
 * is a bug.
 */

const LOCATION_REGIONS = Object.freeze([
    {
        id: 'plates', title: 'Master plates', anchor: 'ls-plates', reads: ['views'],
        what: 'The views this location has been photographed from, and which one a shot gets by default.',
    },
    {
        id: 'orientation', title: 'Orientation', anchor: 'ls-orientation', reads: ['views'],
        what: 'Which way each plate looks, as a compass. The set of views, not a survey of the real place.',
        readonly: true, derived_from: 'the plate views already generated for this location',
    },
    {
        id: 'variants', title: 'Time of day', anchor: 'ls-variants', reads: ['views'],
        what: 'The same place at another hour — dusk, night — kept as its own plates rather than regraded.',
    },
    {
        id: 'description', title: 'The place', anchor: 'ls-description', reads: ['description', 'location_type'],
        what: 'What it is, in the words that reach every frame shot here.',
    },
    {
        id: 'lighting', title: 'Lighting default', anchor: 'ls-lighting', reads: ['lighting_default', 'time_of_day_default'],
        what: 'How it is lit unless a shot says otherwise.',
    },
    {
        id: 'atmosphere', title: 'Atmosphere', anchor: 'ls-atmosphere', reads: ['atmosphere_notes'],
        what: 'Weather, haze, season — the standing conditions of the place.',
    },
    {
        id: 'sound', title: 'Sound notes', anchor: 'ls-sound', reads: ['sound_notes'],
        what: 'How the place SOUNDS. Reaches the ambient bed generated for every scene here.',
    },
    {
        id: 'references', title: 'Concept art & references', anchor: 'ls-references', reads: [], shows_nothing: 'a way through to the gallery, which holds and renders its own images',
        what: 'Everything gathered or explored, and which of it is approved to condition a frame.',
    },
    {
        id: 'scenes', title: 'Scenes here', anchor: 'ls-scenes', reads: ['scene_count', 'scenes'],
        what: 'Which scenes shoot in this location, and how many shots that is.',
        readonly: true, derived_from: 'the scene headings that name this location',
    },
    {
        id: 'continuity', title: 'Continuity flags', anchor: 'ls-continuity', reads: ['continuity_notes'],
        what: 'What must stay true across every shot here — the thing that was moved, broken or repainted.',
    },
]);

const PROP_REGIONS = Object.freeze([
    {
        id: 'plates', title: 'Master views', anchor: 'ps-plates', reads: ['views'],
        what: 'The views this object has been photographed from, and which one conditions a frame.',
    },
    {
        id: 'description', title: 'Object description', anchor: 'ps-description', reads: ['description', 'visual_prompt'],
        what: 'What it is, in the words that reach every frame it appears in.',
    },
    {
        id: 'materials', title: 'Materials & finish', anchor: 'ps-materials', reads: ['materials'],
        what: 'What it is made of and how it catches light — chrome, amber acrylic, bakelite.',
    },
    {
        id: 'spec', title: 'Spec', anchor: 'ps-spec', reads: ['period', 'category', 'quantity', 'practical'],
        what: 'Period, category, how many there are, and whether it has to work on camera.',
    },
    {
        id: 'scale', title: 'Scale', anchor: 'ps-scale', reads: ['height_m', 'width_m', 'length_m'],
        what: 'How big it is. Without this an image model reproduces whatever it was shown, at any size.',
    },
    {
        id: 'states', title: 'Continuity states', anchor: 'ps-states', reads: ['continuity_states'],
        what: 'Clean, chipped, burnt — the versions of the same object, and which scene each belongs to.',
    },
    {
        id: 'references', title: 'Concept art & references', anchor: 'ps-references', reads: [], shows_nothing: 'a way through to the gallery, which holds and renders its own images',
        what: 'Everything gathered or explored, and which of it is approved to condition a frame.',
    },
    {
        id: 'appears', title: 'Appears in', anchor: 'ps-appears', reads: ['shot_count', 'shots'],
        what: 'Which shots name this prop, so a change here is a change to a known list of frames.',
        readonly: true, derived_from: 'the scene cards that name this prop',
    },
    {
        id: 'constraints', title: 'Constraints', anchor: 'ps-constraints', reads: ['constraints', 'notes'],
        what: 'What it must never be or do — a note for the art department and for the prompt.',
    },
]);

/* ── The structure the designs ask for ──────────────────────────────────── */

/**
 * A location's description, as SIX named sections.
 *
 * The design gives each its own label, its own kind and its own character
 * count, and collapses them independently — because a set description is six
 * different documents, and "3855 chars" in one textarea is unreadable and
 * un-editable. The template lives here and the TEXT lives in the column keyed
 * by section id, so renaming a label never orphans what was written under it.
 */
const DESCRIPTION_SECTIONS = Object.freeze([
    { id: 'layout', label: 'Room layout', kind: 'geography',
      what: 'Where everything is, by compass edge. The section that keeps four plates describing one room.' },
    { id: 'place', label: 'The place', kind: 'tone',
      what: 'What kind of room this is, and what it means that the scene happens here.' },
    { id: 'architecture', label: 'Architecture', kind: 'surfaces',
      what: 'The shell and its materials — what the room is MADE of.' },
    { id: 'decoration', label: 'Set decoration', kind: 'items linked to props',
      what: 'What is on the surfaces. Anything named here should exist as a prop.' },
    { id: 'constraint', label: 'The north window', kind: 'hard constraint',
      what: 'The one thing about this room that a frame must never get wrong.' },
    { id: 'background', label: 'Outside that window', kind: 'background plate',
      what: 'What is visible beyond the room, and in what depth.' },
]);

/**
 * A prop's turntable — five views, at stated angles.
 *
 * A constant rather than a column, like a character's OFFICIAL_VIEWS: which
 * angles a turnaround needs is a fact about turnarounds, not about this object.
 */
const PROP_VIEWS = Object.freeze([
    { id: 'front', label: 'Front', angle: '0°', caption: 'the face it is read from' },
    { id: 'three-quarter', label: 'Three-quarter', angle: '45°', caption: 'hero angle' },
    { id: 'side', label: 'Side', angle: '90°', caption: 'depth and mounting' },
    { id: 'back', label: 'Back', angle: '180°', caption: 'what is never seen, and must still exist' },
    { id: 'macro', label: 'Macro', angle: 'close', caption: 'the detail a close-up will land on' },
]);

/** The hours a location is kept as its own plate rather than regraded. */
const TIME_VARIANTS = Object.freeze(['dawn', 'day', 'late afternoon', 'dusk', 'night']);

/** The compass edges an orientation plan names. */
const PLAN_EDGES = Object.freeze(['north', 'east', 'south', 'west']);

/**
 * Everything the designs ask for that is not a heading.
 *
 * `from` is the phrase in the handoff it comes from, checked against the file
 * by test — a feature with a stale citation is one nobody can argue about.
 * `reach` marks what is fed to the generator and what is not, which is the
 * whole difference between a sheet and a form.
 */
const DESIGN_FEATURES = Object.freeze([
    // ── header ──────────────────────────────────────────────────────────
    { id: 'loc-id-chip', subject: 'location', anchor: 'ss-chip-id',
      from: 'LOC-0031 · INT/EXT', reads: ['id', 'location_type'],
      what: 'A short stable id and whether it is interior or exterior, at a glance.' },
    { id: 'loc-plates-locked', subject: 'location', anchor: 'ss-chip-plates',
      from: 'Plates locked 3/4', reads: ['plate_plan', 'views'],
      what: 'How many of the planned plates exist — the sheet\'s one progress number.' },
    { id: 'loc-used-in', subject: 'location', anchor: 'ss-chip-scenes',
      from: 'Used in 6 scenes', reads: ['scene_count'],
      what: 'How much of the film depends on this place being right.' },
    { id: 'prop-id-chip', subject: 'prop', anchor: 'ss-chip-id',
      from: 'PRP-004 · hero prop', reads: ['id', 'category'],
      what: 'A short stable id and what kind of prop it is.' },
    { id: 'prop-turntable-locked', subject: 'prop', anchor: 'ss-chip-plates',
      from: 'Turntable locked 5/5', reads: ['views'],
      what: 'How many of the five official views exist.' },
    { id: 'prop-handled', subject: 'prop', anchor: 'ss-chip-handled',
      from: 'Handled on camera', reads: ['practical'],
      what: 'Whether it is touched or worked on camera, which changes how it is built.' },
    { id: 'prop-states-chip', subject: 'prop', anchor: 'ss-chip-states',
      from: '2 states', reads: ['continuity_states'],
      what: 'How many versions of this object exist.' },

    // ── plates ──────────────────────────────────────────────────────────
    { id: 'canonical-note', subject: 'both', anchor: 'canonical · fed to generation',
      from: 'canonical · fed to generation', reach: 'prompt',
      what: 'Says outright that these plates are what conditions every frame.' },
    { id: 'loc-plate-slots', subject: 'location', anchor: 'ss-slot',
      from: '01 · Master wide — south to north', reads: ['plate_plan', 'views'],
      what: 'Numbered, named slots — so a view that has not been generated is a labelled gap.' },
    { id: 'loc-plate-empty', subject: 'location', anchor: 'generate &rarr;',
      from: 'generate →',
      what: 'An empty slot offers to fill itself, rather than being blank.' },
    { id: 'plate-provenance', subject: 'both', anchor: 'ss-plate-meta',
      from: '2048 × 1152 · png', reads: ['views'],
      what: 'The size and format actually produced, under the plates.' },
    { id: 'prop-turntable', subject: 'prop', anchor: 'ss-view-angle',
      from: '45° · hero angle', reads: ['views'],
      what: 'Each official view with the angle it is taken at.' },

    // ── location structure ──────────────────────────────────────────────
    { id: 'orientation-why', subject: 'location', anchor: 'keeps geography consistent across plates',
      from: 'keeps geography consistent across plates',
      what: 'Why the plan exists, said where the plan is.' },
    { id: 'orientation-plan', subject: 'location', anchor: 'ss-plan',
      from: 'North · harbour window + door', reads: ['orientation_plan'],
      what: 'A plan of the room by compass edge, not four pills.' },
    { id: 'orientation-marker', subject: 'location', anchor: 'ss-plan-marker',
      from: 'corner booth in use', reads: ['orientation_plan'],
      what: 'Where the action sits inside the plan.' },
    { id: 'time-variants', subject: 'location', anchor: 'ss-variant',
      from: 'Late aft ✓', reads: ['views'],
      what: 'The hours this place has been photographed at, and which are missing.' },
    { id: 'desc-sections', subject: 'location', anchor: 'ss-section',
      from: 'geography · 780 chars', reads: ['description_sections'],
      what: 'Six named sections, each with its own kind and its own length.' },
    { id: 'desc-total', subject: 'location', anchor: 'ss-desc-total',
      from: '3855 chars · 6 sections · prompt source', reach: 'prompt', reads: ['description_sections'],
      what: 'What the whole description weighs, and that it is the prompt source.' },
    { id: 'desc-collapse', subject: 'location', anchor: 'ssToggleSection',
      from: 'Collapse all',
      what: 'Sections fold, because six of them open at once is unreadable.' },
    { id: 'desc-copy', subject: 'location', anchor: 'ssCopyDescription',
      from: 'Copy all',
      what: 'Take the assembled description out, to paste somewhere else.' },
    { id: 'linked-props', subject: 'location', anchor: 'ss-linked-prop',
      from: 'jukebox selector · PRP-004', reads: ['linked_props'],
      what: 'The props this set names, linked — and how many it names that do not exist yet.' },
    { id: 'loc-flags', subject: 'location', anchor: 'ss-flag',
      from: 'Chalkboard must stay blank in every plate', reads: ['continuity_flags'],
      what: 'Continuity as a list of things to hold true, not a paragraph.' },
    { id: 'loc-scenes', subject: 'location', anchor: 'ss-scene-row',
      from: 'Sc. 31 — After close', reads: ['scenes'],
      what: 'Which scenes shoot here, and whether the hour they need has a plate.' },
    { id: 'loc-scene-noplate', subject: 'location', anchor: 'no plate',
      from: 'night · no plate', reads: ['scenes'],
      what: 'A scene whose hour has no plate is named as such — that is the work.' },

    // ── prop structure ──────────────────────────────────────────────────
    { id: 'prop-keywords', subject: 'prop', anchor: 'ss-keyword',
      from: 'no modern elements', reads: ['keywords'],
      what: 'The few words that must survive into every frame.' },
    { id: 'prop-materials', subject: 'prop', anchor: 'ss-material',
      from: 'panel · backlit #F0A828', reads: ['materials_json'],
      what: 'Materials as rows — what it is, where it is, and its colour.' },
    { id: 'prop-swatch', subject: 'prop', anchor: 'ss-mat-swatch',
      from: '#EFE9DC', reads: ['materials_json'],
      what: 'The colour, shown as colour. A hex nobody can see is a string.' },
    { id: 'prop-states-note', subject: 'prop', anchor: 'each state generates its own plate set',
      from: 'each state generates its own plate set', reads: ['continuity_states'],
      what: 'Says what a state costs before anyone adds four.' },
    { id: 'prop-scale-compare', subject: 'prop', anchor: 'ss-scale-bar',
      from: 'two-hand object', reads: ['height_m', 'width_m', 'length_m'],
      what: 'The size against a hand, so a number becomes a size.' },
    { id: 'prop-spec-rows', subject: 'prop', anchor: 'ss-spec-row',
      from: 'Quantity', reads: ['period', 'category', 'quantity', 'practical'],
      what: 'Period, category, quantity and practical as a spec block.' },
    { id: 'prop-appears-state', subject: 'prop', anchor: 'ss-appear-row',
      from: 'state A · macro', reads: ['shots'],
      what: 'Which shots name it, and in which state.' },
    { id: 'prop-open-set', subject: 'prop', anchor: 'ss-open-set',
      from: 'Open set →', reads: ['locations'],
      what: 'A way through to the set this object lives on.' },
    { id: 'prop-constraints', subject: 'prop', anchor: 'ss-constraint',
      from: 'Bolted, never handheld or moved', reads: ['constraints_json'],
      what: 'What it must never be or do, as a list.' },

    // ── references, and what reaches the prompt ─────────────────────────
    { id: 'ref-filters', subject: 'both', anchor: 'ss-ref-filter',
      from: 'starred refs are attached to the prompt', reads: ['gallery'],
      what: 'References filtered by category, with counts.' },
    { id: 'ref-starred', subject: 'both', anchor: 'ss-ref-star',
      from: 'starred refs are attached to the prompt', reach: 'prompt', reads: ['gallery'],
      what: 'Which references actually condition a frame, marked.' },
    { id: 'prompt-source', subject: 'both', anchor: 'prompt source',
      from: 'prompt source', reach: 'prompt',
      what: 'The description is marked as the text the generator receives.' },
    { id: 'to-prompt', subject: 'location', anchor: '&rarr; prompt',
      from: '→ prompt', reach: 'prompt',
      what: 'Lighting and atmosphere are marked as reaching the prompt.' },
    { id: 'not-sent', subject: 'location', anchor: 'not sent',
      from: 'not sent', reach: 'not-sent',
      what: 'Sound notes are marked as NOT reaching the image prompt — the mark that matters most.' },
]);

/*
 * The columns each sheet WRITES.
 *
 * Held against the schema by test, because a sheet that stores a field nothing
 * persists looks like it works until the modal is reopened — and held against
 * the update tools, because a field on a page that no tool can set is a
 * capability that exists on one surface only.
 */
const FIELDS = Object.freeze({
    location: ['description', 'lighting_default', 'time_of_day_default', 'atmosphere_notes',
        'sound_notes', 'location_type',
        'description_sections', 'continuity_flags', 'plate_plan', 'orientation_plan'],
    prop: ['description', 'visual_prompt', 'category', 'notes', 'height_m', 'width_m', 'length_m',
        'materials', 'period', 'quantity', 'practical', 'constraints', 'continuity_states',
        'materials_json', 'constraints_json', 'keywords'],
});

/** Every way something gets into a region. A region with none is a label. */
const AUTHORING = Object.freeze([
    // ── location ────────────────────────────────────────────────────────────
    { subject: 'location', id: 'loc-plate-generate', region: 'plates', source: 'generate', spends: true,
        fn: 'generateLocationPlateFor', what: 'Generate the default plate for this location.' },
    { subject: 'location', id: 'loc-plate-upload', region: 'plates', source: 'upload', spends: false,
        fn: 'uploadReferenceImage', what: 'A photograph you already have, through the same control and the same registered import target a card used.' },
    { subject: 'location', id: 'loc-variant', region: 'variants', source: 'generate', spends: true,
        fn: 'generateLocationVariant', what: 'The same place at another hour, as its own view.' },
    { subject: 'location', id: 'loc-text', region: 'description', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'The fields beside the sections — what kind of place it is.' },
    { subject: 'location', id: 'loc-lighting', region: 'lighting', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type it.' },
    { subject: 'location', id: 'loc-atmos', region: 'atmosphere', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type it.' },
    { subject: 'location', id: 'loc-sound', region: 'sound', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type it. Reaches the ambient bed.' },
    { subject: 'location', id: 'loc-ref', region: 'references', source: 'upload', spends: false,
        fn: 'openSubjectGallery', what: 'The gallery: reference, concept, inspiration.' },
    { subject: 'location', id: 'loc-continuity', region: 'continuity', source: 'manual', spends: false,
        fn: 'ssAddFlag', what: 'Add a flag — one thing that must stay true in every plate.' },
    { subject: 'location', id: 'loc-sections', region: 'description', source: 'manual', spends: false,
        fn: 'saveSheetSection', what: 'Write one of the six named sections. They compose into the description the generator reads.' },
    { subject: 'location', id: 'loc-plan', region: 'orientation', source: 'manual', spends: false,
        fn: 'ssEditPlan', what: 'Say what is on each compass edge, and where the action sits.' },
    { subject: 'location', id: 'loc-plate-plan', region: 'plates', source: 'manual', spends: false,
        fn: 'ssEditPlatePlan', what: 'Name the views this location needs, so an ungenerated one is a labelled gap.' },

    // ── prop ────────────────────────────────────────────────────────────────
    { subject: 'prop', id: 'prop-plate-generate', region: 'plates', source: 'generate', spends: true,
        fn: 'generatePropPlateFor', what: 'Generate the plate for this object.' },
    { subject: 'prop', id: 'prop-plate-upload', region: 'plates', source: 'upload', spends: false,
        fn: 'uploadReferenceImage', what: 'A photograph you already have, through the same control a card used.' },
    { subject: 'prop', id: 'prop-text', region: 'description', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type it. Reaches every frame it appears in.' },
    { subject: 'prop', id: 'prop-materials', region: 'materials', source: 'manual', spends: false,
        fn: 'ssAddMaterial', what: 'Add a material row: what it is, where it is, and its colour.' },
    { subject: 'prop', id: 'prop-keywords', region: 'description', source: 'manual', spends: false,
        fn: 'ssAddKeyword', what: 'A word that must survive into every frame.' },
    { subject: 'prop', id: 'prop-spec', region: 'spec', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Period, category, quantity, practical.' },
    { subject: 'prop', id: 'prop-scale', region: 'scale', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Height, width, length in metres.' },
    { subject: 'prop', id: 'prop-state', region: 'states', source: 'manual', spends: false,
        fn: 'addPropState', what: 'Add a continuity state — clean, chipped, burnt.' },
    { subject: 'prop', id: 'prop-ref', region: 'references', source: 'upload', spends: false,
        fn: 'openSubjectGallery', what: 'The gallery: reference, concept, inspiration.' },
    { subject: 'prop', id: 'prop-constraints', region: 'constraints', source: 'manual', spends: false,
        fn: 'ssAddConstraint', what: 'Add a constraint — one thing it must never be or do.' },
]);

/**
 * What came off the card, and where it went.
 *
 * Removing a button is only a simplification if the thing it did still has a
 * home — otherwise "simpler" quietly means "gone", which is what the character
 * card learned.
 */
const RELOCATED = Object.freeze([
    { subject: 'location', action: 'Regen Image', now: 'generateLocationPlateFor' },
    { subject: 'location', action: 'Upload', now: "uploadControl('location-plate'" },
    { subject: 'location', action: 'Views', now: 'ls-orientation' },
    { subject: 'location', action: 'Gallery', now: 'openSubjectGallery' },
    { subject: 'prop', action: 'Regen Image', now: 'generatePropPlateFor' },
    { subject: 'prop', action: 'Upload', now: "uploadControl('prop-plate'" },
    { subject: 'prop', action: 'Gallery', now: 'openSubjectGallery' },
]);

/** A prop's continuity states, stored as JSON and read back safely. */
function parseStates(json) {
    try {
        const v = JSON.parse(json || '[]');
        return Array.isArray(v) ? v.filter(s => s && typeof s === 'object' && s.name) : [];
    } catch (_) { return []; }
}

/**
 * The six sections, as the one paragraph the generator reads.
 *
 * THE SECTIONS ARE NOT A SECOND PLACE TO WRITE — they are how `description` is
 * written. buildPlatePrompt reads `film_locations.description` and nothing
 * else, so a sheet that stored six sections and left that column alone would
 * take a director's whole set description and send none of it: the fields would
 * fill, the plate would be generated from an empty string, and nothing would
 * say so.
 *
 * Composed in the ORDER of the template, because the order is the argument:
 * where things are, then what kind of room it is, then what it is made of.
 * A location with no sections is left exactly as it was — this must not rewrite
 * a description somebody typed before the sections existed.
 */
function composeDescription(sections) {
    const written = DESCRIPTION_SECTIONS
        .map(sec => String((sections || {})[sec.id] || '').trim())
        .filter(Boolean);
    return written.length ? written.join('\n\n') : null;
}

/** Parse a JSON column without letting a bad row take a page down. */
function parseJson(text, fallback) {
    try { const v = JSON.parse(text); return v === null ? fallback : v; } catch (_) { return fallback; }
}

/** Material rows, however they were written. A plain string becomes one row. */
function parseMaterials(json, legacyText) {
    const rows = parseJson(json, null);
    if (Array.isArray(rows) && rows.length) {
        return rows.filter(r => r && r.name).map(r => ({
            name: String(r.name).slice(0, 120),
            role: String(r.role || '').slice(0, 160),
            hex: /^#[0-9a-f]{6}$/i.test(String(r.hex || '')) ? String(r.hex).toUpperCase() : '',
        }));
    }
    // The flat column this replaced: kept and read, so nothing already typed is
    // lost the day the structured one arrives.
    return String(legacyText || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean)
        .map(name => ({ name: name.slice(0, 120), role: '', hex: '' }));
}

/** A list column, or the paragraph it replaced split into lines. */
function parseList(json, legacyText) {
    const list = parseJson(json, null);
    if (Array.isArray(list) && list.length) {
        return list.map(x => String(x).trim()).filter(Boolean).slice(0, 40);
    }
    return String(legacyText || '').split(/\n|;/).map(x => x.trim()).filter(Boolean);
}

module.exports = {
    LOCATION_REGIONS, PROP_REGIONS, FIELDS, AUTHORING, RELOCATED, parseStates,
    DESCRIPTION_SECTIONS, PROP_VIEWS, TIME_VARIANTS, PLAN_EDGES, DESIGN_FEATURES,
    parseJson, parseMaterials, parseList, composeDescription,
};
