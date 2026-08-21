/**
 * Every referenceable subject can produce a plate — and that plate can reach a shot.
 *
 * lib/reference-images.js ranks four kinds. Only CHARACTERS ever got a
 * generator, so a director could anchor who is in frame and nothing else: the
 * street fell back to prose, props could not be referenced at all, and the
 * continuity the reference system exists to provide stopped at the actor.
 *
 * Set-based over the kinds themselves rather than a list written here. Three
 * things have to line up per kind, and any one missing breaks the chain
 * silently — a plate with no FK column is unfindable, a plate nothing gathers
 * is unused, and a kind with no generator has no plate to begin with. An
 * example-based test ("locations have a generator") passes while props are
 * still unreferenceable.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-plates-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();
const { db } = require('../db/database');
const { KIND_RANK, KIND_SOURCE } = require('../lib/reference-images');

const ROUTES = path.join(__dirname, '..', 'routes');

/**
 * The entity-backed kinds, derived from the registry rather than listed.
 *
 * Which kinds those are is declared at the source as KIND_SOURCE, not guessed
 * here by excluding the ones we happen to know about. `style` lives as free
 * text on film_projects and as board images; `anchor` is a keyframe already
 * generated for another shot — it IS a plate's output rather than a subject
 * that has one. Demanding a table or a generator for either would assert a
 * design nobody chose, and excluding them by name is how a fifth kind gets
 * silently skipped.
 */
const TABLE_FOR = {
    character: { table: 'film_characters', route: 'characters.js', fk: 'character_id' },
    location: { table: 'film_locations', route: 'locations.js', fk: 'location_id' },
    // Props are served by locations.js — there is no props.js, and asserting
    // one would be testing a file layout nobody chose rather than a capability.
    prop: { table: 'film_props', route: 'locations.js', fk: 'prop_id' },
};

const ENTITY_KINDS = Object.keys(KIND_RANK).filter(k => KIND_SOURCE[k] === 'entity');

test('every reference kind declares where it comes from, and entity kinds are mapped', () => {
    // Guards the derivation itself, in both directions: a kind added to
    // KIND_RANK with no declared source would be silently skipped by every test
    // below, and an entity kind with no table mapping would be skipped too.
    const undeclared = Object.keys(KIND_RANK).filter(k => !KIND_SOURCE[k]);
    assert.deepStrictEqual(undeclared, [],
        `KIND_RANK kinds with no declared source: ${undeclared.join(', ')}`);
    const unmapped = ENTITY_KINDS.filter(k => !TABLE_FOR[k]);
    assert.deepStrictEqual(unmapped, [], `entity kinds with no table mapping: ${unmapped.join(', ')}`);
    assert.strictEqual(ENTITY_KINDS.length, 3, `expected 3 entity kinds, found ${ENTITY_KINDS.length}`);
});

test('every subject kind has a table that exists', () => {
    const missing = ENTITY_KINDS.filter(k => {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .get(TABLE_FOR[k].table);
        return !row;
    });
    assert.deepStrictEqual(missing, [], `no such table: ${missing.join(', ')}`);
});

test('every subject kind has a plate generator route', () => {
    // Characters have POST /characters/:id/refsheet/generate. Without an
    // equivalent, a location or prop can never become a reference image, so the
    // shot falls back to prose and the 1000-char prompt ceiling comes back.
    const missing = [];
    for (const kind of ENTITY_KINDS) {
        const file = path.join(ROUTES, TABLE_FOR[kind].route);
        if (!fs.existsSync(file)) { missing.push(`${kind}: no ${TABLE_FOR[kind].route}`); continue; }
        const src = fs.readFileSync(file, 'utf8');
        if (!/refsheet|reference\/generate|\bplate\b/i.test(src)) {
            missing.push(`${kind}: ${TABLE_FOR[kind].route} has no plate generator`);
        }
    }
    assert.deepStrictEqual(missing, [], missing.join('\n  '));
});

test('every subject kind has a film_assets column to link its plate to', () => {
    // A plate with no FK is unfindable: the gather query filters on it. This is
    // exactly how character sheets sat with character_id NULL and nothing could
    // locate them.
    const cols = new Set(db.prepare('PRAGMA table_info(film_assets)').all().map(c => c.name));
    const missing = ENTITY_KINDS.filter(k => !cols.has(TABLE_FOR[k].fk));
    assert.deepStrictEqual(missing, [],
        `film_assets cannot link a plate for: ${missing.map(k => TABLE_FOR[k].fk).join(', ')}`);
});

test('the storyboard route gathers a plate for every subject kind', () => {
    // A generator plus a column is still useless if nothing looks the plate up
    // when building a shot.
    const src = fs.readFileSync(path.join(ROUTES, 'storyboard.js'), 'utf8');
    const gather = src.slice(src.indexOf('function gatherShotReferences'));
    assert.ok(gather.length > 100, 'gatherShotReferences is missing');

    const missing = ENTITY_KINDS.filter(k => !gather.includes(TABLE_FOR[k].fk));
    assert.deepStrictEqual(missing, [],
        `gatherShotReferences never looks up: ${missing.map(k => TABLE_FOR[k].fk).join(', ')}`);
});

test('every subject kind is reachable as a selectable reference candidate', () => {
    // The selector must actually rank the kind; an unranked kind sorts last and
    // is squeezed out by the 3-reference cap without anyone deciding that.
    const { selectReferences } = require('../lib/reference-images');
    const png = path.join(process.env.FILM_DATA_DIR, 'probe.png');
    fs.mkdirSync(path.dirname(png), { recursive: true });
    fs.writeFileSync(png, Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'));

    for (const kind of ENTITY_KINDS) {
        const picked = selectReferences([{ name: `probe-${kind}`, kind, file_path: png }]);
        assert.strictEqual(picked.length, 1, `kind '${kind}' produced no selectable reference`);
        assert.strictEqual(picked[0].kind, kind);
    }
});
