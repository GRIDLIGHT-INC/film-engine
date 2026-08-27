/**
 * The style book: a director's library of shots, reusable across films.
 *
 * A named shot — description, camera details, reference visuals — that can be
 * applied to any shot in any project. The value is not the notes; it is that
 * applying an entry fills in the scene card, and the card is already what both
 * prompt builders read.
 *
 * Set-based over three registries, because each fails partially:
 *  - the 10 camera facets: an entry that carries a lens and drops the height
 *    cannot express a low-angle, which is half of what a signature angle IS
 *  - the two scopes: library entries are the whole point, and a list that
 *    returns only the project's own looks identical to an empty library
 *  - the six MCP tools: this pipeline is driven by an agent composing shots
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-stylebook-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();

const styleBook = require('../lib/style-book');
const { handleStyleBook } = require('../routes/style-book');
const { validateSceneCard } = require('../lib/scene-card-schema');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** Every camera facet a scene card carries — derived, never listed. */
function cardFacets() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scene-card-schema.js'), 'utf8');
    return [...new Set([...src.matchAll(/card\.camera\.([a-z_]+)/g)].map(m => m[1]))];
}

function call(method, urlParts, body, query) {
    return new Promise(resolve => {
        const res = {
            writeHead(status) { this._status = status; },
            end(payload) { resolve({ status: this._status, body: payload ? JSON.parse(payload) : null }); },
        };
        handleStyleBook({ method, body }, res, urlParts, query || {});
    });
}

const PROJECT = 'sb000000-0000-4000-8000-000000000001';
const OTHER = 'sb000000-0000-4000-8000-000000000002';
test.before(() => {
    for (const id of [PROJECT, OTHER]) {
        db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
                    VALUES (?, 'p', datetime('now'), datetime('now'))`).run(id);
    }
});

// ── the facets ────────────────────────────────────────────────────────────

test('every camera facet is either carried or explicitly skipped', () => {
    /*
     * The whole set, split. A facet in neither list is one nobody decided
     * about, which is how an entry ends up unable to express the thing it was
     * created for.
     */
    const decided = new Set([...styleBook.mergeableFacets(), ...styleBook.POSE_FACETS]);
    const undecided = cardFacets().filter(f => !decided.has(f));
    assert.deepStrictEqual(undecided, [],
        `these card facets have no disposition in the style book: ${undecided.join(', ')}`);
    assert.ok(styleBook.mergeableFacets().length >= 8,
        'fewer than eight facets are carried — an entry cannot describe a shot');
});

test('a pose is not carried, and says so rather than vanishing', () => {
    // position/rotation are a 6-DOF pose in one previs stage's coordinates.
    // The same numbers put the camera somewhere else in another scene.
    const entry = { name: 'x', camera: { lens: '40mm', position: [1, 2, 3], rotation: [0, 0, 0] } };
    const out = styleBook.applyEntryToShot(entry, { shot_code: '1A' });
    assert.ok(!('position' in out.card.camera), 'a stage pose was written onto a card');
    assert.deepStrictEqual(out.skipped.sort(), [...styleBook.POSE_FACETS].sort(),
        'the skipped facets are not reported, so the omission looks like a bug');
});

test('applying merges onto the card and never replaces it', () => {
    /*
     * A card carries dialogue, characters and a description an entry knows
     * nothing about. PUT /shots/:id merges for exactly this reason, and an
     * apply that replaced would drop the writing every time someone reached
     * for a favourite angle.
     */
    const card = {
        shot_code: '1A',
        description: 'MAYA crosses the road.',
        dialogue: [{ character: 'MAYA', line: 'Not here.' }],
        characters: ['MAYA'],
        camera: { shot_type: 'wide', lens: '24mm' },
    };
    const entry = { name: 'tatami', camera: { shot_type: 'medium', height_m: 0.4, movement: 'static' } };
    const out = styleBook.applyEntryToShot(entry, card);

    assert.strictEqual(out.card.description, 'MAYA crosses the road.', 'the writing was lost');
    assert.deepStrictEqual(out.card.dialogue, card.dialogue, 'the dialogue was lost');
    assert.strictEqual(out.card.camera.shot_type, 'medium', 'the entry did not win where it has an opinion');
    assert.strictEqual(out.card.camera.height_m, 0.4);
    assert.strictEqual(out.card.camera.lens, '24mm',
        'a facet the entry says nothing about was cleared');
    assert.ok(out.applied.includes('height_m'), 'applied facets are not reported');

    // The original must be untouched — callers read it afterwards.
    assert.strictEqual(card.camera.shot_type, 'wide', 'applyEntryToShot mutated its input');
});

test('an entry is validated by the card, not by a private copy of the vocabulary', () => {
    /*
     * A style book that accepts a shot type the card refuses produces an entry
     * that cannot be applied, and the failure surfaces later on a shot the
     * director cares about.
     */
    const bad = styleBook.validateEntry({ name: 'x', camera: { shot_type: 'not-a-shot-type' } });
    assert.strictEqual(bad.valid, false, 'an invalid shot type was accepted');

    const good = styleBook.validateEntry({ name: 'x', camera: { shot_type: 'close-up', aperture: 2.8 } });
    assert.strictEqual(good.valid, true, `a valid entry was refused: ${good.errors.join('; ')}`);

    // And what it accepts, a card accepts.
    const merged = styleBook.applyEntryToShot(
        { name: 'x', camera: { shot_type: 'close-up', aperture: 2.8 } }, { shot_code: '1A' });
    assert.strictEqual(validateSceneCard(merged.card).valid, true,
        'applying a VALID entry produced a card the schema refuses');

    assert.strictEqual(styleBook.validateEntry({ camera: {} }).valid, false, 'an unnamed entry was accepted');
});

test('an entry may carry only what it knows', () => {
    // "85mm, that's all I know" is a legitimate entry. Requiring a sensor
    // would stop it being written down at all.
    const out = styleBook.validateEntry({ name: 'the 85', camera: { lens: '85mm' } });
    assert.strictEqual(out.valid, true, `a partial entry was refused: ${out.errors.join('; ')}`);
});

// ── the scopes ────────────────────────────────────────────────────────────

test('a library entry is visible from every project; a project entry is not', async () => {
    const lib = await call('POST', ['film', 'projects', PROJECT, 'style-book'],
        { name: 'Ozu low-angle', scope: 'library', camera: { height_m: 0.4, shot_type: 'medium' } });
    assert.strictEqual(lib.status, 201, JSON.stringify(lib.body));
    assert.strictEqual(lib.body.entry.scope, 'library');

    const own = await call('POST', ['film', 'projects', PROJECT, 'style-book'],
        { name: 'Wingfall push', scope: 'project', camera: { movement: 'push-in' } });
    assert.strictEqual(own.body.entry.scope, 'project');

    const here = await call('GET', ['film', 'projects', PROJECT, 'style-book']);
    const names = here.body.entries.map(e => e.name);
    assert.ok(names.includes('Ozu low-angle') && names.includes('Wingfall push'),
        'a project does not see its own entries plus the library');

    const there = await call('GET', ['film', 'projects', OTHER, 'style-book']);
    const thereNames = there.body.entries.map(e => e.name);
    assert.ok(thereNames.includes('Ozu low-angle'), 'the library is not visible from another project');
    assert.ok(!thereNames.includes('Wingfall push'),
        "another project sees this project's own entries");
});

test('deleting a project does not delete the library', () => {
    /*
     * ON DELETE SET NULL, never CASCADE. A library entry authored while a
     * project was open must outlive it — the film_refsheet_jobs trap from
     * migration 067, which made deleting a worked-on project fail outright.
     */
    const doomed = 'sb000000-0000-4000-8000-0000000000ff';
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'doomed', datetime('now'), datetime('now'))`).run(doomed);
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO film_style_book (id, project_id, name, created_at, updated_at)
                VALUES (?, ?, 'made here', datetime('now'), datetime('now'))`).run(id, doomed);

    db.prepare('DELETE FROM film_projects WHERE id = ?').run(doomed);

    const row = db.prepare('SELECT project_id FROM film_style_book WHERE id = ?').get(id);
    assert.ok(row, 'deleting a project deleted the entry authored in it');
    assert.strictEqual(row.project_id, null, 'the entry should fall back to the library');
});

// ── applying, over HTTP ───────────────────────────────────────────────────

test('applying an entry to a shot writes its facets onto that shot', async () => {
    const scene = crypto.randomUUID();
    const shot = crypto.randomUUID();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, location, created_at)
                VALUES (?, ?, 1, 'STREET', datetime('now'))`).run(scene, PROJECT);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, created_at)
                VALUES (?, ?, '1A', ?, datetime('now'))`)
        .run(shot, scene, JSON.stringify({ shot_code: '1A', description: 'she crosses' }));

    const created = await call('POST', ['film', 'projects', PROJECT, 'style-book'],
        { name: 'apply me', scope: 'library', camera: { shot_type: 'close-up', height_m: 0.4 } });

    const res = await call('POST',
        ['film', 'shots', shot, 'style-book', created.body.entry.id], {});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.applied.includes('shot_type'), 'the response does not say what it changed');

    const after = JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shot).scene_card_yaml);
    assert.strictEqual(after.camera.shot_type, 'close-up', 'the card was not updated');
    assert.strictEqual(after.camera.height_m, 0.4);
    assert.strictEqual(after.description, 'she crosses', 'applying an entry destroyed the writing');
});

// ── visuals ───────────────────────────────────────────────────────────────

test('an entry holds several visuals, and video is stored as reference-only', async () => {
    const created = await call('POST', ['film', 'projects', PROJECT, 'style-book'],
        { name: 'with pictures', scope: 'library' });
    const id = created.body.entry.id;

    for (const kind of ['image', 'image', 'video']) {
        const r = await call('POST', ['film', 'style-book', id, 'media'],
            { media_kind: kind, file_path: `/tmp/${kind}-${crypto.randomUUID()}.bin`, note: kind });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    }
    const got = await call('GET', ['film', 'style-book', id]);
    assert.strictEqual(got.body.entry.media.length, 3, 'multiple visuals per entry is the ask');
    assert.ok(got.body.entry.media.some(m => m.media_kind === 'video'),
        'a reference clip cannot be stored');

    // Honest about what reaches a model. KIND_RANK puts style last of five
    // against a budget of three, so a still is dropped on any shot with a cast
    // and a location — and a clip reaches no generator at all.
    assert.match(String(got.body.note || ''), /reference/i,
        'the response does not say the visuals are reference-only');
});

// ── the surfaces ──────────────────────────────────────────────────────────

test('every route verb an agent needs has a tool', () => {
    const { listTools } = require('../lib/mcp-tools');
    const names = new Set(listTools().map(t => t.name));
    const expected = ['stylebook_list', 'stylebook_get', 'stylebook_create',
                      'stylebook_update', 'stylebook_delete', 'stylebook_apply'];
    const missing = expected.filter(n => !names.has(n));
    assert.deepStrictEqual(missing, [],
        `an agent composing a shot cannot reach: ${missing.join(', ')}`);
});

test('the page exists and is reachable from the rail', () => {
    // A capability with no control is indistinguishable from one that does not
    // exist — the lesson camera mode cost once already.
    assert.match(SPA, /id:'stylebook'/, 'no rail entry');
    assert.match(SPA, /id="page-stylebook"/, 'no page');
    assert.match(SPA, /function loadStyleBook/, 'no loader');
    assert.match(SPA, /'stylebook'/, 'the page id is not registered');

    // And the apply control, where a shot is directed.
    assert.match(SPA, /applyStyleBookEntry/, 'no way to apply an entry to a shot');
});

test('a cross-project page is always available, not stuck in one phase', () => {
    // PROJECT_PHASES are the nine stages of making a film. A library that
    // outlives every project does not belong inside the workflow of one.
    const { ALWAYS_AVAILABLE, phaseOf } = require('../lib/nav-flow');
    assert.ok(ALWAYS_AVAILABLE.includes('stylebook'),
        'the style book is filed under a production phase');
    assert.ok(!phaseOf || phaseOf('stylebook') === null || ALWAYS_AVAILABLE.includes('stylebook'));
});

/**
 * A regenerated plate has to LOOK regenerated.
 *
 * Reported as "I had to hard refresh to see the picture of a character plate,
 * generated through MCP" — and it is not a DOM problem. A plate is written to
 * the same per-view filename and overwrites, so the URL never changes and the
 * browser serves the copy it already has. A successful, paid-for regeneration
 * leaves the page byte-identical, which reads as nothing having happened and
 * invites pressing the button again.
 *
 * The storyboard frame learned this once and busts on `asset_version`; every
 * plate URL was built with no buster at all, so the same bug lived on one
 * subsystem over.
 */
test('a plate URL carries a cache buster, so a regeneration is visible', () => {
    const { getFileUrl } = require('../lib/file-storage');

    // Unversioned callers keep the old URL exactly — nothing else changes.
    assert.strictEqual(getFileUrl('refsheets', 'p1', 'MAYA_front.png'),
        '/film/refsheets/p1/MAYA_front.png');

    // With a version, the URL differs — which is the entire mechanism.
    const a = getFileUrl('refsheets', 'p1', 'MAYA_front.png', 1);
    const b = getFileUrl('refsheets', 'p1', 'MAYA_front.png', 2);
    assert.notStrictEqual(a, b, 'two versions produce the same URL, so the browser reuses the picture');
    assert.match(a, /\?v=1$/);

    // A timestamp with spaces and colons must not break the URL.
    const stamped = getFileUrl('refsheets', 'p1', 'x.png', '2026-08-27 14:39:44');
    assert.ok(!/\s/.test(stamped), `the buster leaked whitespace into a URL: ${stamped}`);
});

test('a plate URL buster is keyed to something that actually changes', () => {
    /*
     * `?v=1` on every plate forever.
     *
     * The first version read `version || created_at`, and every plate row is
     * written with version 1 — a constant. So the URL gained a query string,
     * looked busted, and was byte-identical from one generation to the next.
     * The browser served the cached picture exactly as before.
     *
     * Checked against the ROW SHAPE rather than by reading the expression: the
     * claim is "this key moves when a plate is regenerated", and version does
     * not.
     */
    /*
     * UNGATED. The first version asked the database whether `version` was
     * constant — and the test database is empty, so the query returned nothing,
     * the guard was skipped and the whole assertion passed against the bug it
     * was written for. A check that only runs when there happens to be data is
     * a check that does not run.
     *
     * Every plate INSERT in this repo writes `version` 1 as a literal, which is
     * the real claim and is checkable in the source.
     */
    for (const file of ['routes/locations.js', 'routes/characters.js', 'lib/reference-plates.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        const wrongWayRound = /\.version \|\| \w+\.created_at/.exec(src);
        assert.strictEqual(wrongWayRound, null,
            `${file}: keys the cache buster on version, which every plate insert writes `
            + 'as a literal 1 — so the URL would be ?v=1 forever and never change');
    }
});

test('a plate query selects the columns its URL builder reads', () => {
    /*
     * THE GAP THE PREVIOUS TEST MISSED.
     *
     * It checked the CALL had four arguments. It did — and the fourth resolved
     * to `undefined`, because the query feeding it selected only file_name and
     * project_id. A four-argument call that silently degrades to three, and a
     * location plate regenerated through MCP went on serving the cached
     * picture.
     *
     * So: any query whose row is handed to getFileUrl must select the columns
     * the buster reads.
     */
    /*
     * The column list is read up to FROM, and the rest of the statement up to
     * the end of the line. The first version bounded the match with
     * [^"'`] — which cannot cross the quotes in `asset_type = 'reference_image'`,
     * so it matched nothing at all and passed while the query was wrong.
     */
    const gaps = [];
    for (const file of ['routes/locations.js', 'routes/characters.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        for (const m of src.matchAll(/SELECT ([\w\s,.*]+?) FROM film_assets(.*)/g)) {
            const [columns, rest] = [m[1], m[2]];
            if (!/file_name/.test(columns)) continue;             // not a URL-building query
            if (!/reference_image|character_sheet/.test(rest)) continue;   // not a plate query
            if (!/created_at/.test(columns)) {
                gaps.push(`${file}: SELECT ${columns.trim().slice(0, 60)} — no created_at, `
                    + 'so getFileUrl receives undefined and the buster is silently dropped');
            }
        }
    }
    assert.deepStrictEqual(gaps, [], `\n  ${gaps.join('\n  ')}`);
});

test('every plate URL a browser renders is busted', () => {
    /*
     * Set-based over the call sites, because the failure is partial: the board
     * was fixed and the plates were not, and the symptom in each case is the
     * same silent stale picture.
     *
     * Payload paths are exempt BY NAME — capability-payloads builds a URL for
     * a provider, not a browser, and a query string there would be sent to a
     * generator.
     */
    const files = ['routes/characters.js', 'routes/locations.js', 'lib/reference-plates.js'];
    const offenders = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        for (const m of src.matchAll(/getFileUrl\(([^;]{0,140}?)\)/g)) {
            const args = m[1];
            if (args.split(',').length < 4) offenders.push(`${f}: getFileUrl(${args.trim().slice(0, 70)})`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        `these build a plate URL with no cache buster, so a regeneration shows the old picture:\n  `
        + offenders.join('\n  '));
});
