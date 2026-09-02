/**
 * A reference you cannot see is an empty square
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Reported as: "in both the locations and props there are a bunch of empty
 * squares showing as reference with no images on it — is this a bug, or was the
 * design not applied? The pictures we've accumulated should still show in small
 * squares."
 *
 * It is a bug, and the pictures were there the whole time. Measured on the live
 * install: 7 gallery items on a prop, 1 on a location, every one with a real
 * file on disk — and `image_url: null` on all of them.
 *
 * TWO ROADS, ONE QUESTION, TWO ANSWERS. `loadGallery` returns STORAGE rows —
 * `file_name`, `file_path`, no URL. `routes/subject-gallery.js` maps them
 * through `present()` before answering, so the dedicated endpoint is renderable.
 * The two inline attachments in `routes/locations.js` do not, so the location
 * and prop sheets receive rows the page cannot draw. `ssRefs()` reads
 * `g.image_url`, finds undefined, and falls to its `<div class="cs-drop">`
 * branch — an empty square, once per accumulated picture.
 *
 * The character sheet escaped only because it fetches `/characters/:id/gallery`
 * instead of reading the payload it was handed, which is why this looked like a
 * location-and-prop problem rather than one loader missing one map.
 *
 * AND THE STRIP DUPLICATES THE TURNTABLE. `loadGallery` selects every
 * plate-type asset for the subject, canonical views included — so the prop's 7
 * "Concept art & references" ARE its 7 turntable views, the same rows rendered
 * twice on one sheet. The region's own registry entry calls it "Explorations
 * and gathered images", so the code disagrees with its declared contract, and
 * the redundancy was noticed before the missing pictures were.
 *
 * Set-based over both registries rather than over the two sheets that were
 * reported: the loader is shared, so a fix proven on props says nothing about
 * the road characters take, and a fourth subject kind must not arrive broken.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TEST_DIR = path.join(os.tmpdir(), 'film-galthumb-' + crypto.randomUUID().slice(0, 8));
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.FILM_DATA_DIR = TEST_DIR;

const G = require('../lib/subject-gallery');
const SHEETS = require('../lib/subject-sheets');

/** Kinds a gallery can be loaded for — the loader's own registry. */
const KINDS = Object.keys(G.SUBJECT_SPEC);

/** Sheets that render a turntable AND a references strip — the sheet registry. */
const REGION_SETS = { location: SHEETS.LOCATION_REGIONS, prop: SHEETS.PROP_REGIONS };
const BOTH_REGIONS = Object.entries(REGION_SETS)
    .filter(([, regs]) => {
        const ids = regs.map(r => r.id);
        return ids.includes('plates') && ids.includes('references');
    })
    .map(([kind]) => kind);

let db, projectId, subjects = {};

before(() => {
    ({ db } = require('../db/database'));
    require('../db/schema').ensureSchema();
    projectId = crypto.randomUUID();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Gallery thumbs');

    const mk = {
        character: () => { const id = crypto.randomUUID();
            db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?,?,?)').run(id, projectId, 'RAY'); return id; },
        location: () => { const id = crypto.randomUUID();
            db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?,?,?)').run(id, projectId, 'STREET'); return id; },
        prop: () => { const id = crypto.randomUUID();
            db.prepare('INSERT INTO film_props (id, project_id, name) VALUES (?,?,?)').run(id, projectId, 'RADIO'); return id; },
    };

    for (const kind of KINDS) {
        const id = mk[kind]();
        subjects[kind] = id;
        const col = G.SUBJECT_SPEC[kind].column;
        // A canonical turntable view, and a gathered image that is not one.
        for (const [view, name] of [['front', `${kind}_front.png`], [null, `${kind}_gathered.png`]]) {
            db.prepare(
                `INSERT INTO film_assets (id, project_id, ${col}, asset_type, file_name, file_path, metadata)
                 VALUES (?,?,?,?,?,?,?)`
            ).run(crypto.randomUUID(), projectId, id, 'reference_image', name,
                path.join(TEST_DIR, name), JSON.stringify(view ? { view } : { note: 'gathered' }));
        }
    }
});

after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {} });

describe('a gallery a surface receives is renderable', () => {
    it('the denominator is the loader registry, not the two kinds reported', () => {
        assert.ok(KINDS.length >= 3, `only ${KINDS.length} subject kinds — the registry is not being read`);
        assert.deepEqual(KINDS.sort(), ['character', 'location', 'prop']);
    });

    for (const kind of Object.keys(G.SUBJECT_SPEC)) {
        it(`${kind}: every item with a file carries an image_url`, () => {
            const items = G.loadGallery(db, kind, subjects[kind]);
            assert.ok(items.length, `${kind}: fixture produced no gallery`);
            for (const it of items) {
                assert.ok(Object.prototype.hasOwnProperty.call(it, 'image_url'),
                    `${kind}: loadGallery returns storage rows with no image_url — every accumulated `
                    + 'picture renders as an empty square on the sheet');
                assert.ok(it.image_url,
                    `${kind}: "${it.file_name}" has a file on disk and no URL to draw it from`);
            }
        });
    }
});

describe('the references strip is not the turntable again', () => {
    it('the denominator is the sheets declaring both regions', () => {
        assert.deepEqual(BOTH_REGIONS.sort(), ['location', 'prop'],
            'the region registry no longer says which sheets carry both');
    });

    for (const kind of ['location', 'prop']) {
        it(`${kind}: "Concept art & references" excludes canonical turntable views`, () => {
            const strip = G.galleryForStrip(db, kind, subjects[kind]);
            assert.ok(Array.isArray(strip), `${kind}: no strip loader`);
            assert.ok(!strip.some(i => i.view),
                `${kind}: the strip re-renders ${strip.filter(i => i.view).map(i => i.view).join(', ')} — `
                + 'the same rows the turntable already shows, larger, directly above it');
            assert.ok(strip.length,
                `${kind}: the strip dropped everything, including the gathered images it exists for`);
        });
    }
});
