/**
 * What a prop may be categorised as.
 *
 * There were THREE answers to this and no two agreed. The CHECK constraint on
 * `film_props.category` allows ten values; the SPA's picker offered nine, two
 * of which — `clothing` and `personal` — the constraint refuses, so choosing
 * either in the UI failed the insert; and the MCP tool typed it as a free
 * string, so an agent learned the legal set only by reading a constraint
 * violation.
 *
 * The migration is the authority because it is what actually rejects a value,
 * and it cannot be read at runtime — SQLite does not expose a CHECK's members
 * — so the list is stated once here and every consumer reads it. Anything else
 * is a fourth copy waiting to drift.
 *
 * Changing this list means writing a migration too. The test asserts the two
 * agree, so they cannot part company silently.
 */
const PROP_CATEGORIES = Object.freeze([
    'generic',
    'weapon',
    'vehicle',
    'technology',
    'food',
    'document',
    'furniture',
    'clothing-accessory',
    'musical-instrument',
    'other',
]);

/** Human labels for the picker. The value is what is stored. */
const PROP_CATEGORY_LABELS = Object.freeze({
    'generic': 'Generic',
    'weapon': 'Weapon',
    'vehicle': 'Vehicle',
    'technology': 'Technology',
    'food': 'Food / Drink',
    'document': 'Document',
    'furniture': 'Furniture',
    'clothing-accessory': 'Clothing / Accessory',
    'musical-instrument': 'Musical Instrument',
    'other': 'Other',
});

module.exports = { PROP_CATEGORIES, PROP_CATEGORY_LABELS };
