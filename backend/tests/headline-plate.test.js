/**
 * A compass side is an extra view, never the location's headline plate.
 *
 * Reported with the evidence: after a compass sweep wrote east then south, the
 * location's `reference_image_url` pointed at SOUTH — the last side written.
 * Had west completed it would have been west. The master plate on disk was
 * untouched; only the pointer moved.
 *
 * The list route picked `ORDER BY created_at DESC LIMIT 1` — the NEWEST row —
 * while `gatherShotReferences` explicitly falls back to the view-less default.
 * Two paths answering "which plate is this location's" with different rules,
 * which is the same shape as the storyboard-frame pointer and the character
 * turnaround before it.
 *
 * The generation path was already right, so no frame was mis-anchored. The
 * DISPLAY was wrong, and a director reading a card cannot tell those apart —
 * which is why it was reported as mis-anchoring.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-headline-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();

const { headlinePlate } = require('../lib/plate-views');

/** The order a compass sweep writes: the default first, then each side. */
const SWEEP = ['', 'east', 'south', 'west'];

function rows(views) {
    /*
     * NEWEST FIRST, which is what the query returns (`ORDER BY created_at
     * DESC`). The first version built them oldest-first, so `list[0]` happened
     * to be the master and a mutation replacing the whole rule with `list[0]`
     * passed — the fixture disagreed with reality in exactly the direction
     * that hid the bug.
     */
    return views.map((view, i) => ({
        file_name: `plate${view ? `__${view}` : ''}.png`,
        metadata: JSON.stringify(view ? { view } : {}),
        created_at: `2026-08-27 19:${50 + i}:00`,
    })).reverse();
}

test('the headline plate is the default, not the newest side', () => {
    /*
     * Set-based over the sweep as it actually happens: after each side is
     * added, the headline must still be the master. The bug only appeared
     * after the FIRST side, so a test with one side and one default would have
     * caught it — and a test that checked only the finished sweep would too.
     * Checking every prefix says the pointer never moves at any point.
     */
    for (let n = 1; n <= SWEEP.length; n++) {
        const so_far = SWEEP.slice(0, n);
        const chosen = headlinePlate(rows(so_far));
        assert.strictEqual(chosen.file_name, 'plate.png',
            `after writing ${so_far.filter(Boolean).join(', ') || 'the default'}, `
            + `the headline became ${chosen.file_name}`);
    }
});

test('a named view wins when one is asked for', () => {
    // That is the whole point of views: a shot pointed the other way asks for
    // the side it is looking at.
    const chosen = headlinePlate(rows(SWEEP), { view: 'south' });
    assert.strictEqual(chosen.file_name, 'plate__south.png');
});

test('an unknown view falls back to the default, not to nothing', () => {
    /*
     * A card naming a view somebody deleted must still get its location: a
     * silent gap replaces a wrong reference with NO reference, which is worse.
     */
    const chosen = headlinePlate(rows(SWEEP), { view: 'nowhere' });
    assert.strictEqual(chosen.file_name, 'plate.png');
});

test('with only sides and no default, something is still returned', () => {
    // A location whose master was deleted should not lose its plate entirely.
    const chosen = headlinePlate(rows(['east', 'south']));
    assert.ok(chosen, 'a location with sides but no master got no plate at all');
});

test('nothing at all returns nothing, rather than throwing', () => {
    assert.strictEqual(headlinePlate([]), null);
    assert.strictEqual(headlinePlate(null), null);
});

test('the display and the generation path use the SAME rule', () => {
    /*
     * The bug was two rules. Whatever the fix, there must be one function and
     * both callers must reach it — a shared rule that one caller reimplements
     * is not shared.
     */
    const gather = fs.readFileSync(path.join(__dirname, '..', 'lib', 'shot-references.js'), 'utf8');
    const list = fs.readFileSync(path.join(__dirname, '..', 'routes', 'locations.js'), 'utf8');

    /*
     * CALLED, not merely imported. Grepping the file for the name is satisfied
     * by the require line alone — the same vacuity that let a cache-buster
     * mutation pass twice today. A call has a bracket after it.
     */
    for (const [name, src] of [['shot-references', gather], ['locations route', list]]) {
        assert.match(src, /headlinePlate\(/,
            `${name} still decides for itself which plate is the location's`);
        const calls = (src.match(/headlinePlate\(/g) || []).length;
        assert.ok(calls >= 1, `${name}: imports the shared rule and never calls it`);
    }
    // The locations route answers this question in three places.
    assert.ok((list.match(/headlinePlate\(/g) || []).length >= 3,
        'not every place the locations route picks a plate uses the shared rule');

    /*
     * And the list route must not have gone back to taking the newest.
     *
     * COMMENTS STRIPPED FIRST. The comment explaining this fix quotes the
     * query it replaced, and the first version of this check counted that —
     * reporting the bug as still present in the file that fixed it. The clip
     * coverage test learned the same lesson by matching a word inside the
     * comment describing its removal.
     */
    const code = list.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    /*
     * SCOPED TO A PLATE SELECTION, not to the clause anywhere in the file.
     *
     * The bug this catches is a REFERENCE-PLATE query going back to
     * newest-wins. Counting the clause file-wide also catches every unrelated
     * latest-row lookup — and the orientation plan is exactly that: its query
     * asks for the most recently uploaded plan, which is correct, and the
     * broad pattern could not tell the two apart. A test that fires on correct
     * code is one people edit until it stops, and the real assertion goes with
     * it.
     *
     * Seams collapsed first: these queries are built by concatenating string
     * literals across lines, so `asset_type` and the ORDER BY sit in different
     * fragments and a line-wise read never sees them together.
     */
    const flat = code.replace(/['"`]\s*\+\s*['"`]/g, ' ').replace(/\s+/g, ' ');
    const offenders = [];
    for (const m of flat.matchAll(/ORDER BY created_at DESC LIMIT 1/g)) {
        const query = flat.slice(Math.max(0, m.index - 320), m.index);
        if (/reference_image|character_sheet/.test(query)) offenders.push(query.slice(-120));
    }
    assert.deepStrictEqual(offenders, [],
        'the locations route still takes the newest reference row as the headline plate:\n  '
        + offenders.join('\n  '));
});

test('the location plate URL is built one way, not two', () => {
    /*
     * Also reported: the field came back with a ?v= cache buster where it
     * previously had none — written by two paths with two conventions. One
     * builder, so a reader can trust the shape.
     */
    const list = fs.readFileSync(path.join(__dirname, '..', 'routes', 'locations.js'), 'utf8');
    const builders = [...list.matchAll(/reference_image_url\s*=/g)];
    assert.ok(builders.length >= 1, 'nothing sets reference_image_url any more');
    // Every one of them must bust the cache the same way.
    for (const m of builders) {
        const after = list.slice(m.index, m.index + 260);
        assert.match(after, /created_at/,
            'a reference_image_url is built without the cache buster the others carry');
    }
});
