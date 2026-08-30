/**
 * A subject needs a sketchbook, not just a plate.
 *
 * Today every stored image of a character, location or prop IS a candidate
 * reference: `gatherShotReferences` selects `asset_type IN ('reference_image',
 * 'character_sheet')` and `headlinePlate` picks one. There is nowhere to put an
 * image that INFORMS the work without BEING the work — a film still you are
 * chasing, a photograph of the real street, four versions of a face you are
 * choosing between. So a concept artist has one slot per view and every
 * exploration overwrites the approved plate.
 *
 * Three roles, and the distinction is what the whole feature turns on:
 *
 *   reference   — approved. This is what conditions every frame the subject
 *                 appears in. One per (subject, view), which is what
 *                 headlinePlate already assumes.
 *   concept     — an exploration. Kept, comparable, promotable, and reaching
 *                 no prompt until someone promotes it.
 *   inspiration — gathered rather than made. Often a frame from someone else's
 *                 film, which is why it is excluded from generation by default
 *                 rather than merely ranked low: looking at a still and sending
 *                 it to a provider as conditioning are different acts.
 *
 * THE invariant, and the reason this suite leads with it: adding a gallery must
 * not silently start conditioning shots on sketches. Every existing row is
 * today's plate and must stay a reference; every new exploration must be inert
 * until promoted. Get that backwards and every board in every project quietly
 * re-generates against whatever someone was doodling.
 *
 * Set-based over the three subject kinds, because the failure is per-kind:
 * characters have a turnaround and locations have compass views and props have
 * neither, so a gallery that works for one is not evidence for the others.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/*
 * The temp database is chosen HERE, at the top of the file, before a single
 * require runs.
 *
 * `db/database.js` resolves its path from FILM_DATA_DIR at IMPORT time, so
 * setting it inside a before() hook is too late the moment any earlier describe
 * block requires a module that pulls the database in transitively. That is
 * exactly what happened: an earlier block requires lib/reference-plates, the
 * real database opened, and this suite wrote 26 projects and 222 assets into
 * the working film library before anybody noticed.
 */
const TEST_DIR = path.join(os.tmpdir(), 'film-gallery-' + crypto.randomUUID().slice(0, 8));
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.FILM_DATA_DIR = TEST_DIR;

const G = require('../lib/subject-gallery');

/* ── the vocabulary ────────────────────────────────────────────────────── */

describe('roles', () => {
    it('names exactly the three roles, and says which reaches a prompt', () => {
        assert.deepEqual(G.ROLES.map(r => r.id), ['reference', 'concept', 'inspiration'],
            'the roles are not the three the design names, in order of commitment');
        for (const role of G.ROLES) {
            assert.ok(role.what && role.what.length > 20, `${role.id}: no description`);
            assert.equal(typeof role.reaches_generation, 'boolean',
                `${role.id}: does not declare whether it conditions a frame — the one thing a `
                + 'director needs to know about an image in this list');
            assert.ok(role.why && role.why.length > 15,
                `${role.id}: no reason for that answer`);
        }
        const sending = G.ROLES.filter(r => r.reaches_generation).map(r => r.id);
        assert.deepEqual(sending, ['reference'],
            `${sending.join(', ')} would be sent to a provider; only an approved reference should be`);
    });

    it('an unlabelled image is a reference, because every existing one is a plate', () => {
        // NULL cannot mean "unknown" here. Every row that exists today IS the
        // subject's plate, and reading NULL as anything else would take the
        // reference off every subject in every project the day this ships.
        assert.equal(G.roleOf({}), 'reference');
        assert.equal(G.roleOf({ metadata: null }), 'reference');
        assert.equal(G.roleOf({ metadata: '{"plate_role":"concept"}' }), 'concept');
        assert.equal(G.roleOf({ metadata: { plate_role: 'inspiration' } }), 'inspiration');
        /*
         * A DECLARED but unrecognised role is not folded into the default.
         *
         * Absent means "written before roles existed", which is a plate.
         * Declared-but-unknown means somebody wrote an intent this version does
         * not understand, and reading that as "approved for sending" is the
         * wrong direction. It comes back verbatim and is NOT sendable — which
         * is also what the SQL rule says, and the two are held to each other
         * below. This assertion was originally the other way round, and the
         * agreement test is what caught it.
         */
        assert.equal(G.roleOf({ metadata: { plate_role: 'whatever' } }), 'whatever');
        assert.equal(G.isSendable({ metadata: { plate_role: 'whatever' } }), false,
            'a role nobody declared was trusted into the send list');
    });

    it('only a reference is sendable, asked the way the gather asks it', () => {
        for (const role of G.ROLES) {
            assert.equal(G.isSendable({ metadata: { plate_role: role.id } }), role.reaches_generation,
                `isSendable disagrees with the role table about '${role.id}'`);
        }
    });
});

/* ── promotion ─────────────────────────────────────────────────────────── */

describe('promotion', () => {
    it('promoting demotes whoever held that view', () => {
        // headlinePlate assumes ONE reference per view. Two would make "the
        // plate" whichever row the query returned first — the exact defect the
        // compass sweep already cost once.
        const rows = [
            { id: 'a', metadata: { plate_role: 'reference', view: 'front' } },
            { id: 'b', metadata: { plate_role: 'concept', view: 'front' } },
            { id: 'c', metadata: { plate_role: 'reference', view: 'side' } },
        ];
        const plan = G.planPromotion(rows, 'b');
        assert.equal(plan.promote, 'b');
        assert.deepEqual(plan.demote, ['a'],
            'the previous front reference was not demoted, so the view has two');
        assert.ok(!plan.demote.includes('c'),
            'a reference for a DIFFERENT view was demoted — each view keeps its own');
    });

    it('promoting the image that already holds the view is a no-op, not a shuffle', () => {
        const rows = [{ id: 'a', metadata: { plate_role: 'reference', view: 'front' } }];
        const plan = G.planPromotion(rows, 'a');
        assert.deepEqual(plan.demote, [], 'it demoted itself');
        assert.equal(plan.changed, false, '"did that apply?" should be a free question');
    });

    it('an inspiration cannot be promoted without saying so', () => {
        /*
         * An inspiration is usually somebody else's frame. Promoting it makes
         * it conditioning input sent to a provider, which is a different act
         * from looking at it — so it is refused unless the caller states the
         * intent, on the precedent every other override here follows.
         */
        const rows = [{ id: 'a', metadata: { plate_role: 'inspiration', view: '' } }];
        assert.throws(() => G.planPromotion(rows, 'a'),
            /inspiration/i,
            'an inspiration was promoted to a conditioning reference with no acknowledgement');
        const forced = G.planPromotion(rows, 'a', { allow_inspiration: true });
        assert.equal(forced.promote, 'a');
    });

    it('promoting an id that is not in the gallery is refused', () => {
        assert.throws(() => G.planPromotion([{ id: 'a', metadata: {} }], 'zz'), /not/i);
    });
});

/* ── exploration must not touch the approved plate ─────────────────────── */

describe('exploration', () => {
    it('an exploration is written to its own file, never the plate name', () => {
        // The plate is stored at a per-view filename and OVERWRITES. If an
        // exploration used that name it would replace the approved plate on
        // disk the moment it was generated — the picture every frame of that
        // subject is conditioned on, gone, with nothing said.
        const { plateFileName } = require('../lib/reference-plates');
        const plate = plateFileName('character', 'MAYA', 'front');
        for (let i = 0; i < 3; i++) {
            const explore = G.explorationFileName('character', 'MAYA', 'front', 'abc123' + i);
            assert.notEqual(explore, plate,
                'an exploration would overwrite the approved plate on disk');
        }
        // ...and two explorations must not overwrite each other either, or
        // "try three looks" keeps one.
        const names = new Set([0, 1, 2].map(i =>
            G.explorationFileName('character', 'MAYA', 'front', 'seed' + i)));
        assert.equal(names.size, 3, 'explorations collide with each other');
    });

    it('an exploration is born a concept', () => {
        assert.equal(G.explorationMetadata({ view: 'front' }).plate_role, 'concept',
            'a fresh exploration would immediately condition every frame of this subject');
    });
});

/* ── the gather must never see a sketch ────────────────────────────────── */

describe('what reaches a prompt', () => {
    it('the reference gatherer filters on role, not merely on asset type', () => {
        /*
         * Derived from the SOURCE, because this is the invariant that makes the
         * feature safe to ship. The gather selects by asset_type; adding rows
         * of that type WITHOUT a role filter is what would start conditioning
         * shots on concept art, silently, in every project at once.
         */
        const src = fs.readFileSync(path.join(__dirname, '../lib/shot-references.js'), 'utf8');
        const calls = src.match(/asset_type IN \('[^)]*'\)/g) || [];
        assert.ok(calls.length >= 3, 'the plate queries moved; this check is not reading them');
        assert.ok(/isSendable|plate_role|sendableOnly/.test(src),
            'shot-references never consults the role: a concept or an inspiration would be '
            + 'attached to a real generation');
    });

    it('headlinePlate is only ever offered sendable rows', () => {
        const rows = [
            { id: 'ref', metadata: { plate_role: 'reference' } },
            { id: 'con', metadata: { plate_role: 'concept' } },
            { id: 'ins', metadata: { plate_role: 'inspiration' } },
        ];
        const kept = rows.filter(G.isSendable).map(r => r.id);
        assert.deepEqual(kept, ['ref']);
    });
});

/* ── against a real database ───────────────────────────────────────────── */

describe('the gallery, over a real database', () => {
    let db;

    before(() => {
        // The path was already fixed at the top of this file; this only opens
        // it. Requiring the database here and choosing the directory here would
        // be the same mistake in a smaller scope.
        db = require('../db/database').db;
        assert.ok(db.name.startsWith(TEST_DIR),
            `this suite is about to write to ${db.name}, which is not the temp database`);
        require('../db/schema').ensureSchema();
    });

    after(() => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {} });

    it('the SQL rule and the JS rule agree, including on the rows that break them', () => {
        /*
         * `roleOf` decides in JavaScript and `sendableSql` decides in SQLite,
         * and both answer "may this picture be sent to a provider". Two
         * implementations of one rule is precisely what this codebase keeps
         * paying for — the headline plate, the running order, the nav — so they
         * are run against the same rows here.
         *
         * The interesting rows are the ones that break a naive version: absent
         * metadata, metadata that is not JSON at all (json_extract THROWS on
         * it, which would take down the query deciding what a paid generation
         * is conditioned on), and a role nobody declared.
         */
        const { generateId } = require('../db/database');
        const projectId = generateId();
        db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Agreement');
        const subjectId = generateId();
        db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)')
            .run(subjectId, projectId, 'AGREE');

        const cases = [
            ['null metadata', null],
            ['empty object', '{}'],
            ['not json at all', 'this is not json'],
            ['explicit reference', JSON.stringify({ plate_role: 'reference' })],
            ['concept', JSON.stringify({ plate_role: 'concept' })],
            ['inspiration', JSON.stringify({ plate_role: 'inspiration' })],
            ['role nobody declared', JSON.stringify({ plate_role: 'sketch' })],
            ['other metadata, no role', JSON.stringify({ kind: 'location_plate' })],
        ];
        const ids = {};
        for (const [label, meta] of cases) {
            const id = generateId();
            ids[id] = label;
            db.prepare(
                `INSERT INTO film_assets (id, project_id, character_id, asset_type, file_path, file_name, metadata)
                 VALUES (?, ?, ?, 'reference_image', ?, ?, ?)`
            ).run(id, projectId, subjectId, `/tmp/${id}.png`, `${id}.png`, meta);
        }

        const sqlSays = new Set(db.prepare(
            `SELECT id FROM film_assets WHERE character_id = ? AND ${G.sendableSql()}`
        ).all(subjectId).map(r => r.id));

        const rows = db.prepare('SELECT * FROM film_assets WHERE character_id = ?').all(subjectId);
        for (const row of rows) {
            assert.equal(sqlSays.has(row.id), G.isSendable(row),
                `'${ids[row.id]}': SQL says ${sqlSays.has(row.id)}, JS says ${G.isSendable(row)}`);
        }
        // And the answer itself must be right, not merely consistent: five of
        // these eight are pre-existing-plate shapes and must all still send.
        // Right, not merely consistent: the five pre-existing-plate shapes must
        // all still send (null, {}, unparseable, explicit reference, other
        // metadata with no role), and the three declared non-references must
        // not — concept, inspiration, and the role nobody declared.
        assert.equal(sqlSays.size, 5,
            `${sqlSays.size} of 8 rows are sendable; five plate shapes should send and three declared roles should not`);
    });

    it('every subject kind can hold all three roles', () => {
        // Per kind, because the columns differ: character_id, location_id and
        // prop_id are three separate foreign keys and a gallery wired to one
        // is no evidence for the others.
        const { generateId } = require('../db/database');
        const projectId = generateId();
        db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Gallery');

        for (const kind of G.SUBJECT_KINDS) {
            const spec = G.SUBJECT_SPEC[kind];
            const subjectId = generateId();
            db.prepare(`INSERT INTO ${spec.table} (id, project_id, name) VALUES (?, ?, ?)`)
                .run(subjectId, projectId, kind.toUpperCase() + ' ONE');

            for (const role of G.ROLES) {
                const assetId = generateId();
                db.prepare(
                    `INSERT INTO film_assets (id, project_id, ${spec.column}, asset_type, file_path, file_name, metadata)
                     VALUES (?, ?, ?, 'reference_image', ?, ?, ?)`
                ).run(assetId, projectId, subjectId, `/tmp/${assetId}.png`, `${assetId}.png`,
                    JSON.stringify({ plate_role: role.id, view: '' }));
            }

            const gallery = G.loadGallery(db, kind, subjectId);
            assert.equal(gallery.length, 3, `${kind}: the gallery does not hold all three roles`);
            const byRole = Object.fromEntries(gallery.map(g => [g.role, g]));
            for (const role of G.ROLES) {
                assert.ok(byRole[role.id], `${kind}: '${role.id}' did not come back`);
            }
            assert.equal(gallery.filter(g => g.sendable).length, 1,
                `${kind}: more than one image is marked as reaching generation`);
        }
    });
});

/* ── the surface ───────────────────────────────────────────────────────── */

describe('the workspace', () => {
    const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

    it('a served path is made absolute against the API, not the page', () => {
        /*
         * The page is served from one port and the API from another, so a bare
         * `/film/refsheets/…` in an <img src> resolves against the PAGE and
         * 404s. What you see is a broken-image icon where the approved plate
         * should be, which reads as the plate having been lost.
         *
         * Caught by loading a real gallery in a browser: every source check
         * passed, because the string was present and correct — it was simply
         * relative to the wrong origin. An absolute inspiration link must be
         * left alone, or it becomes localhost:3100https://example.com/…
         */
        const i = SPA.indexOf('function galCardHtml(');
        assert.ok(i > -1, 'galCardHtml is gone');
        let depth = 0, j = SPA.indexOf('{', i), end = j;
        for (; j < SPA.length; j++) {
            if (SPA[j] === '{') depth++;
            else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
        }
        const body = SPA.slice(i, end);
        assert.ok(/API_BASE\s*\+/.test(body),
            'the gallery renders a served path relative to the page, which 404s');
        assert.ok(/\^https\?:/.test(body),
            'an absolute link would be prefixed with the API base as well');
    });

    it('every subject kind opens the same workspace', () => {
        // Three near-identical panels is how one of them ends up with the
        // promote rule and the others do not.
        for (const kind of G.SUBJECT_KINDS) {
            assert.ok(new RegExp(`openGallery\\(\\s*'${kind}'`).test(SPA),
                `no Gallery control for a ${kind}`);
        }
        assert.equal((SPA.match(/function galCardHtml\(/g) || []).length, 1,
            'more than one gallery renderer');
    });

    it('nothing spends without showing what it will send', () => {
        /*
         * Updated when the standard moved. This required a literal `confirm(`,
         * which enshrined the BARE browser confirm as the bar -- a sentence and
         * a count, with no prompt to read, nothing to edit, and no way to pick
         * the generator, model, quality or size. Explore now goes through the
         * one shared gate like every other paid button, which is strictly
         * stronger, and a test demanding the weaker thing would have to be
         * broken to get there.
         */
        const i = SPA.indexOf('async function exploreSubject(');
        assert.ok(i > -1, 'exploreSubject is gone');
        const body = SPA.slice(i, i + 3000);

        assert.ok(/confirmPaidImage\s*\(/.test(body),
            'Explore spends without the shared confirmation, so the prompt cannot be read or '
            + 'edited and the generator cannot be chosen');
        assert.ok(/explore\/preview/.test(body),
            'Explore does not hand the gate its FREE preview, so the dialog has nothing to show');

        // The paid call belongs INSIDE send, after the decision.
        const sendAt = body.indexOf('send:');
        const spendAt = body.indexOf("method: 'POST'");
        assert.ok(sendAt > -1 && spendAt > sendAt,
            'the paid POST is not inside the gate\'s send callback, so it runs regardless of '
            + 'what the director decides');
    });
});
