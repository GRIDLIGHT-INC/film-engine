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
        'sound_notes', 'location_type', 'continuity_notes'],
    prop: ['description', 'visual_prompt', 'category', 'notes', 'height_m', 'width_m', 'length_m',
        'materials', 'period', 'quantity', 'practical', 'constraints', 'continuity_states'],
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
        fn: 'saveSheetField', what: 'Type it. Reaches every frame shot here.' },
    { subject: 'location', id: 'loc-lighting', region: 'lighting', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type it.' },
    { subject: 'location', id: 'loc-atmos', region: 'atmosphere', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type it.' },
    { subject: 'location', id: 'loc-sound', region: 'sound', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type it. Reaches the ambient bed.' },
    { subject: 'location', id: 'loc-ref', region: 'references', source: 'upload', spends: false,
        fn: 'openSubjectGallery', what: 'The gallery: reference, concept, inspiration.' },
    { subject: 'location', id: 'loc-continuity', region: 'continuity', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type what must stay true across every shot here.' },

    // ── prop ────────────────────────────────────────────────────────────────
    { subject: 'prop', id: 'prop-plate-generate', region: 'plates', source: 'generate', spends: true,
        fn: 'generatePropPlateFor', what: 'Generate the plate for this object.' },
    { subject: 'prop', id: 'prop-plate-upload', region: 'plates', source: 'upload', spends: false,
        fn: 'uploadReferenceImage', what: 'A photograph you already have, through the same control a card used.' },
    { subject: 'prop', id: 'prop-text', region: 'description', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type it. Reaches every frame it appears in.' },
    { subject: 'prop', id: 'prop-materials', region: 'materials', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type the materials and the finish.' },
    { subject: 'prop', id: 'prop-spec', region: 'spec', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Period, category, quantity, practical.' },
    { subject: 'prop', id: 'prop-scale', region: 'scale', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Height, width, length in metres.' },
    { subject: 'prop', id: 'prop-state', region: 'states', source: 'manual', spends: false,
        fn: 'addPropState', what: 'Add a continuity state — clean, chipped, burnt.' },
    { subject: 'prop', id: 'prop-ref', region: 'references', source: 'upload', spends: false,
        fn: 'openSubjectGallery', what: 'The gallery: reference, concept, inspiration.' },
    { subject: 'prop', id: 'prop-constraints', region: 'constraints', source: 'manual', spends: false,
        fn: 'saveSheetField', what: 'Type what it must never be or do.' },
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

module.exports = {
    LOCATION_REGIONS, PROP_REGIONS, FIELDS, AUTHORING, RELOCATED, parseStates,
};
