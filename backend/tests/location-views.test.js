/**
 * A location has views, and a shot picks one.
 *
 * A location had exactly ONE plate, selected with `ORDER BY version DESC LIMIT
 * 1`, with no record of which way it faced. On Wingfall that plate looks from
 * the entrance INTO the cul-de-sac — so 1A and 2A had a photograph, and 2B and
 * 2AA, which shoot back the other way, were handed a picture of what was BEHIND
 * the camera and invented the rest. Every wrong road, missing kerb and
 * misplaced car traces to that.
 *
 * Which view a shot needs is a property of the SHOT, not the location: the
 * location owns a growing set of views, and the card says which one it is
 * looking at.
 *
 * Set-based over the nine things a view must survive, because each is
 * independently silent. A view that generates but overwrites the last one loses
 * the set; one that stores but is not selectable is invisible; one that is
 * selected but not sent leaves the prompt naming a view the model never saw.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-views-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..');
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

// ── 1. Two views of one location can coexist ────────────────────────────

test('a second view does not overwrite the first', () => {
    /*
     * Plates are named `location_<name>.png`, one file per subject — so
     * generating a second view wrote over the first and the set could never
     * grow beyond one. The view has to be part of the identity.
     */
    const { plateFileName } = require('../lib/reference-plates');
    assert.ok(typeof plateFileName === 'function',
        'nothing derives a plate filename, so views cannot be told apart on disk');
    const a = plateFileName('location', 'SUBURBAN STREET', 'from the entrance looking in');
    const b = plateFileName('location', 'SUBURBAN STREET', 'from the far kerb looking back');
    assert.notStrictEqual(a, b, 'two views of one location resolve to the same file');
    assert.ok(/\.png$/.test(a) && !/[\\/]/.test(a), `unsafe filename: ${a}`);

    // The original, view-less plate keeps its name, or every existing project
    // loses the plate it already has.
    assert.strictEqual(plateFileName('location', 'SUBURBAN STREET', null),
        plateFileName('location', 'SUBURBAN STREET', undefined),
        'the default view is not stable');
});

// ── 2. The card carries which view this shot sees ───────────────────────

test('the scene card validates a location_view', () => {
    const { validateSceneCard } = require('../lib/scene-card-schema');
    assert.ok(validateSceneCard({ shot_code: '2B', description: 'x', location_view: 'from the far kerb' }).valid,
        'a card cannot say which view of its location the shot sees');
    assert.ok(!validateSceneCard({ shot_code: '2B', description: 'x', location_view: 42 }).valid,
        'a non-string view is accepted');
});

test('location_view can be saved through the shot route', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'shots.js'), 'utf8');
    assert.ok(/'location_view'/.test(src), 'PUT /shots/:id cannot set the view');
});

// ── 3. The gatherer sends the view the shot asked for ───────────────────

test('the gatherer selects a plate by view, not by "latest"', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'shot-references.js'), 'utf8');
    const at = src.indexOf('matchedLocation && matchedLocation.id');
    assert.ok(at > 0, 'the location branch is gone');
    const branch = src.slice(at, at + 900);
    assert.ok(/locationView|location_view/.test(branch),
        'the gatherer still takes whichever location plate is newest, so a shot cannot choose '
        + 'the view it is actually looking at');
});

test('selection is by view, with the default as a fallback', () => {
    /*
     * Behavioural, not a grep. The first version of this test looked for the
     * word "fallback" in the source and failed while the fallback was right
     * there as `|| all.find(...)` — a test reading source text is testing how
     * the code is phrased.
     */
    const { gatherShotReferences } = require('../lib/shot-references');
    const projectId = generateId(), locId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Views');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)')
        .run(locId, projectId, 'SUBURBAN STREET');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'views-'));
    const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');
    /*
     * Distinct BYTES per view. gatherShotReferences inlines each plate as a
     * data URI and drops file_path, so two identical fixture files come back
     * as the same string and the test cannot tell which was chosen — it would
     * pass whichever plate the code picked.
     */
    const add = (name, view) => {
        const f = path.join(dir, name);
        fs.writeFileSync(f, Buffer.concat([PNG, Buffer.from(name)]));
        db.prepare(`INSERT INTO film_assets (id, project_id, location_id, asset_type, file_name, file_path, version, metadata)
                    VALUES (?, ?, ?, 'reference_image', ?, ?, 1, ?)`)
            .run(generateId(), projectId, locId, name, f,
                JSON.stringify(view ? { kind: 'location_plate', view } : { kind: 'location_plate' }));
        return f;
    };
    const dflt = add('location_S.png', null);
    const back = add('location_S__back.png', 'from the far kerb looking back');

    const loc = { id: locId, name: 'SUBURBAN STREET' };
    const uriOf = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
    const pick = view => {
        const refs = gatherShotReferences(projectId, [], loc, [], null, { limit: 5, locationView: view });
        const r = refs.find(x => x.kind === 'location');
        return r && r.uri;
    };

    assert.strictEqual(pick('from the far kerb looking back'), uriOf(back),
        'the named view was not the one selected');
    assert.strictEqual(pick(''), uriOf(dflt), 'no view asked for did not fall back to the default plate');
    assert.strictEqual(pick('a view nobody ever made'), uriOf(dflt),
        'a card naming a view that does not exist got NO location plate — a silent gap is worse '
        + 'than the wrong reference');
});

// ── 4. Generating one, and listing them for the picker ──────────────────

test('views can be listed for a location', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'locations.js'), 'utf8');
    assert.ok(/plate\/views|\/views/.test(src),
        'nothing lists a location\'s views, so a dropdown has nothing to offer');
});

test('a new view is generated anchored on an existing one', () => {
    /*
     * Generated independently, four views produce four different cul-de-sacs.
     * Each new view has to be anchored on one that already exists, with the
     * move stated, or the set does not agree with itself — which is the whole
     * reason for having a set.
     */
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'reference-plates.js'), 'utf8');
    assert.ok(/same location as the reference image|Same houses|anchored/i.test(src),
        'a new view is generated from scratch, so the set will not agree with itself');
});

// ── 5. It is choosable and visible ──────────────────────────────────────

test('the Blocking panel offers the views as a dropdown', () => {
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    assert.ok(/LocationView/.test(html), 'there is no view selector');
    assert.ok(/<select[^>]*id="\$\{p\}LocationView"/.test(html),
        'the view is typed as prose rather than chosen from what exists');
    assert.ok(/generate a new view|new view/i.test(html),
        'a view can only be chosen, never created, so the set can never grow from the board');
});

test('the confirmation names the view that is travelling', () => {
    // "SUBURBAN STREET" is not enough once a location has four views: the whole
    // point is knowing WHICH half of the street the model was shown.
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    const at = html.indexOf('async function confirmGeneration(');
    let i = html.indexOf('{', at), d = 0, end = -1;
    for (let j = i; j < html.length; j++) {
        if (html[j] === '{') d++;
        else if (html[j] === '}') { d--; if (d === 0) { end = j + 1; break; } }
    }
    assert.ok(/r\.view|view/.test(html.slice(at, end)),
        'the confirmation shows the location name but not which view of it is being sent');
});
