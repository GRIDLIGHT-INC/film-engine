/**
 * The character sheet: one place to look at a character.
 *
 * The card carried EIGHT buttons — Regen Image, Orbit Sheet, Views, Upload,
 * Gallery, Voice, Edit, Delete — and clicking the card itself did nothing.
 * Every one of those is something you do while LOOKING AT the character, so
 * they belong inside a view of them rather than crowded onto a 260px tile in a
 * grid of twelve. Two buttons on the card; the rest live in the sheet.
 *
 * The registries here are what the sheet is made of, so a region that stops
 * being rendered fails a test rather than quietly disappearing.
 */

/**
 * The four canonical views.
 *
 * Front, both profiles and back — a real turnaround. The existing VIEW_RANK
 * shipped with a single `side`, which is half a turnaround: it cannot say which
 * way the character is facing, so two shots from opposite sides both resolve to
 * the same plate. `degrees` is the orbit angle, so a generated turnaround and a
 * hand-generated single view land on the same names.
 */
const OFFICIAL_VIEWS = Object.freeze([
    { id: 'front', label: 'Front', caption: 'front plate', degrees: 0 },
    { id: 'side-left', label: 'Left', caption: 'left profile', degrees: 90 },
    { id: 'side-right', label: 'Right', caption: 'right profile', degrees: 270 },
    { id: 'back', label: 'Back', caption: 'back plate', degrees: 180 },
]);

const OFFICIAL_VIEW_IDS = OFFICIAL_VIEWS.map(v => v.id);

/**
 * Older plates, mapped onto the four.
 *
 * `side` shipped first and real projects hold plates under it. Introducing
 * side-left/side-right without a rule would leave those pictures ranked but
 * unreachable from the sheet — money spent, bytes on disk, and no way to see
 * them. A lone `side` is read as the LEFT profile because that is what a
 * 90-degree orbit produces, which is where every existing one came from.
 */
const LEGACY_VIEWS = Object.freeze({
    side: 'side-left',
    'three-quarter': 'front',
    'back-three-quarter': 'back',
});

/** Which official view this stored view name belongs to, or null. */
function canonicalView(view) {
    const v = String(view || '').trim().toLowerCase();
    if (!v) return null;
    if (OFFICIAL_VIEW_IDS.includes(v)) return v;
    return LEGACY_VIEWS[v] || null;
}

/**
 * What a generation run will produce.
 *
 * Refuses a view nobody declared rather than generating into a name the plate
 * system cannot select by: a plate stored as `diagonal` is a picture that cost
 * money and can never be attached to a shot.
 */
function viewPlan(views) {
    const wanted = (views && views.length) ? views : OFFICIAL_VIEW_IDS;
    for (const v of wanted) {
        if (!OFFICIAL_VIEW_IDS.includes(v)) {
            throw new Error(`'${v}' is not one of the official views: ${OFFICIAL_VIEW_IDS.join(', ')}`);
        }
    }
    return { views: [...wanted], count: wanted.length, all: wanted.length === OFFICIAL_VIEW_IDS.length };
}

/**
 * What a reference SHOWS — orthogonal to what it DOES.
 *
 * The gallery already answers "does this condition a frame" with
 * reference | concept | inspiration. This is the other axis, and collapsing
 * them would mean a costume study could not be starred, or a starred plate
 * could not also be a face study.
 */
const REFERENCE_CATEGORIES = Object.freeze([
    { id: 'sketch', label: 'Sketch', what: 'Silhouette passes, rough drawings, blocking of the shape.' },
    { id: 'costume', label: 'Costume', what: 'Wardrobe passes: layers, fabric, how it is worn.' },
    { id: 'face', label: 'Face', what: 'Head studies — the thing a viewer notices first when it changes.' },
    { id: 'mood', label: 'Mood', what: 'Light, grade and atmosphere this character is seen in.' },
]);

const CATEGORY_IDS = REFERENCE_CATEGORIES.map(c => c.id);

/** File a picture under a category without touching its role. */
function categoryMetadata(category, existing) {
    const meta = { ...(existing || {}) };
    if (CATEGORY_IDS.includes(category)) meta.ref_category = category;
    return meta;
}

/** Which category this picture is filed under, or null if it never was. */
function categoryOf(row) {
    let meta = row && row.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (_) { meta = {}; } }
    const c = (meta || {}).ref_category;
    return CATEGORY_IDS.includes(c) ? c : null;
}

/**
 * The six regions of the sheet.
 *
 * `anchor` is a string the renderer must contain, so a region that stops being
 * rendered fails rather than quietly disappearing — a sheet that draws the
 * plates and drops the palette looks finished in a screenshot.
 */
const SHEET_REGIONS = Object.freeze([
    { id: 'views', what: 'the four official plates, top left', anchor: 'cs-views' },
    { id: 'details', what: 'everything from the edit form, top right', anchor: 'cs-details' },
    { id: 'physical', what: 'the physical spec grid', anchor: 'cs-physical' },
    { id: 'wardrobe', what: 'wardrobe and props with thumbnails', anchor: 'cs-wardrobe' },
    { id: 'palette', what: 'the locked colour palette', anchor: 'cs-palette' },
    { id: 'references', what: 'the full-width concept art band', anchor: 'cs-refs' },
]);

/**
 * What came off the card, and must still be reachable.
 *
 * Removing a button is only a simplification if the thing it did still has a
 * home. Six actions moved into the sheet; this list is what a test holds them
 * to, so "simpler" cannot quietly mean "gone".
 */
const RELOCATED_ACTIONS = Object.freeze([
    { label: 'Regen Image', fn: 'generateCharacterImage' },
    { label: 'Orbit Sheet', fn: 'orbitRefsheet' },
    { label: 'Views', fn: 'showCharacterViews' },
    { label: 'Gallery', fn: 'openGallery' },
    { label: 'Voice', fn: 'castCharacterVoice' },
    { label: 'Upload', fn: 'uploadControl' },
]);

module.exports = {
    OFFICIAL_VIEWS, OFFICIAL_VIEW_IDS, LEGACY_VIEWS, canonicalView, viewPlan,
    REFERENCE_CATEGORIES, CATEGORY_IDS, categoryMetadata, categoryOf,
    SHEET_REGIONS, RELOCATED_ACTIONS,
};
