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

/**
 * Every way something gets INTO the sheet.
 *
 * Three regions were read-only dead ends: the reference band could only be
 * filled from another modal, wardrobe said "no wardrobe recorded yet" with no
 * way to record any, and the palette pointed at a table with no UI. A region
 * that shows an empty state and offers no way out of it is a label, not a
 * feature.
 *
 * `source` is how the picture or the value arrives, and `spends` decides
 * whether a spinner and a confirmation are required — declared rather than
 * inferred from the function name, which is how one of them ends up spending
 * silently.
 */
const AUTHORING = Object.freeze([
    { id: 'ref-upload', region: 'references', source: 'upload', spends: false,
      fn: 'addSheetReference', what: 'A picture you already have, filed under a category.' },
    { id: 'ref-generate', region: 'references', source: 'generate', spends: true,
      fn: 'generateSheetReference', what: 'A reference generated from a prompt, filed under a category.' },
    { id: 'wardrobe-upload', region: 'wardrobe', source: 'upload', spends: false,
      fn: 'addWardrobeItem', what: 'A wardrobe or prop item: a title and a picture you have.' },
    { id: 'wardrobe-generate', region: 'wardrobe', source: 'generate', spends: true,
      fn: 'generateWardrobeItem', what: 'A wardrobe or prop item generated from its own description.' },
    { id: 'palette-manual', region: 'palette', source: 'manual', spends: false,
      fn: 'addPaletteSwatch', what: 'A colour typed in, with a name.' },
    { id: 'palette-from-image', region: 'palette', source: 'upload', spends: false,
      fn: 'paletteFromImage', what: 'Colours sampled from a picture already in the sheet.' },
]);

/**
 * The gender vocabulary the caster actually reads.
 *
 * It was free text, which is why `voiceGender()` has to match with a regex:
 * "F", "woman" and "female" were three values for one thing, and anything it
 * did not recognise silently disabled gender-matched voice suggestions. These
 * are the values, and every one of them must be readable by the caster — the
 * test asserts exactly that, so adding an option here that casting cannot use
 * fails rather than shipping.
 */
const GENDERS = Object.freeze([
    { id: 'female', label: 'Female' },
    { id: 'male', label: 'Male' },
    { id: 'non-binary', label: 'Non-binary' },
    { id: 'neutral', label: 'Neutral / not applicable' },
]);

/**
 * A palette swatch, or null.
 *
 * Hex only, expanded from shorthand so a stored value is always comparable and
 * always renderable. A CSS colour NAME is refused: the browser understands
 * `red`, and the print document, an export and anything that later computes a
 * contrast do not all agree about what it means.
 */
function normaliseSwatch(swatch) {
    if (!swatch || typeof swatch !== 'object') return null;
    let hex = String(swatch.hex || '').trim().toLowerCase();
    if (!hex.startsWith('#')) return null;
    if (/^#[0-9a-f]{3}$/.test(hex)) {
        hex = '#' + hex.slice(1).split('').map(c => c + c).join('');
    }
    if (!/^#[0-9a-f]{6}$/.test(hex)) return null;
    return { hex, name: String(swatch.name || '').trim() || hex };
}

/** A whole palette, dropping anything that is not a colour. */
function normalisePalette(list) {
    return (Array.isArray(list) ? list : []).map(normaliseSwatch).filter(Boolean).slice(0, 8);
}

module.exports = {
    OFFICIAL_VIEWS, OFFICIAL_VIEW_IDS, LEGACY_VIEWS, canonicalView, viewPlan,
    REFERENCE_CATEGORIES, CATEGORY_IDS, categoryMetadata, categoryOf,
    SHEET_REGIONS, RELOCATED_ACTIONS,
    AUTHORING, GENDERS, normaliseSwatch, normalisePalette,
};
