/**
 * The style book's unproven half — the 21 cases docs/plans/style-book-qa.md
 * marked GAP.
 *
 * Set-based over the registries that fail PARTIALLY, which is the whole reason
 * an example is not enough here: `NEVER_WRITES` has four fields and a rule that
 * catches three of them is indistinguishable from one that works; there are
 * seven row lookups in the router and a 404 on six of them teaches a caller to
 * trust the seventh.
 *
 * Writing these found four real defects rather than four missing tests, each
 * recorded on its own test.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-sbgaps-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();

const styleBook = require('../lib/style-book');
const { handleStyleBook } = require('../routes/style-book');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '../routes/style-book.js'), 'utf8');
const LIB_SRC = fs.readFileSync(path.join(__dirname, '../lib/style-book.js'), 'utf8');
const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

function call(method, urlParts, body, query) {
    return new Promise(resolve => {
        const res = {
            writeHead(status) { this._status = status; },
            end(payload) { resolve({ status: this._status, body: payload ? JSON.parse(payload) : null }); },
        };
        handleStyleBook({ method, body }, res, urlParts, query || {});
    });
}

const PROJECT = 'sg000000-0000-4000-8000-000000000001';
const SCENE = 'sg000000-0000-4000-8000-000000000010';
const SHOT = 'sg000000-0000-4000-8000-000000000020';
const MISSING = 'sg000000-0000-4000-8000-0000000000ff';

test.before(() => {
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'p', datetime('now'), datetime('now'))`).run(PROJECT);
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, created_at)
                VALUES (?, ?, '1', datetime('now'))`).run(SCENE, PROJECT);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, created_at)
                VALUES (?, ?, '1A', ?, datetime('now'))`)
        .run(SHOT, SCENE, JSON.stringify({ shot_code: '1A', camera: { lens: '35mm' } }));
});

async function makeEntry(over) {
    const r = await call('POST', ['film', 'style-book'], {
        name: 'Hero low', description: 'the one I keep coming back to',
        tags: 'low,wide', camera: { lens: '85mm', shot_type: 'close-up' }, ...over,
    });
    assert.strictEqual(r.status, 201, 'fixture entry was not created: ' + JSON.stringify(r.body));
    return r.body.entry || r.body;
}

/* ── SB-APPLY-05 — the delivery specs an entry must never write ───────── */

test('NEVER_WRITES is CONSUMED, not merely declared', () => {
    // Declared-and-never-consumed is this codebase's recurring failure. The
    // fields happen to be excluded today because mergeableFacets() does not
    // list them — an accident that ends the moment a facet is added to the
    // scene card, at which point the constant named to prevent it does nothing.
    assert.ok(/NEVER_WRITES/.test(LIB_SRC.slice(LIB_SRC.indexOf('function applyEntryToShot'),
        LIB_SRC.indexOf('const NEVER_WRITES'))),
        'applyEntryToShot never consults NEVER_WRITES — the protection is incidental');
});

test('every delivery spec is refused by apply, and reported', () => {
    assert.strictEqual(styleBook.NEVER_WRITES.length, 4);
    for (const field of styleBook.NEVER_WRITES) {
        const entry = { camera: { lens: '85mm', [field]: '2.39:1' } };
        const out = styleBook.applyEntryToShot(entry, { shot_code: '1A', camera: {} });
        assert.ok(!(field in out.card.camera), `${field} was written onto the card`);
        assert.ok(out.skipped.includes(field), `${field} was dropped silently, not reported`);
        assert.ok(out.applied.includes('lens'), 'the legitimate facet stopped travelling');
    }
});

/* ── SB-VAL-04/05/06 — the limits ─────────────────────────────────────── */

test('an entry with no usable name is refused', async () => {
    for (const name of [undefined, '', '   ']) {
        const r = await call('POST', ['film', 'style-book'], { name, camera: { lens: '85mm' } });
        assert.strictEqual(r.status, 400, `name ${JSON.stringify(name)} was accepted`);
    }
});

test('every length-limited field is enforced, at the boundary', async () => {
    const LIMITS = [['name', styleBook.NAME_MAX], ['description', styleBook.DESCRIPTION_MAX],
        ['tags', styleBook.TAGS_MAX]];
    assert.deepStrictEqual(LIMITS.map(l => l[1]), [200, 2000, 500]);
    for (const [field, max] of LIMITS) {
        const ok = await call('POST', ['film', 'style-book'],
            { name: 'x', camera: {}, [field]: 'a'.repeat(max) });
        assert.strictEqual(ok.status, 201, `${field} at exactly ${max} was refused`);
        const over = await call('POST', ['film', 'style-book'],
            { name: 'x', camera: {}, [field]: 'a'.repeat(max + 1) });
        assert.strictEqual(over.status, 400, `${field} at ${max + 1} was accepted`);
        assert.ok(String(JSON.stringify(over.body)).includes(String(max)),
            `the refusal for ${field} does not say what the limit is`);
    }
});

/* ── SB-CRUD-06, SB-APPLY-08/09, SB-MEDIA (404s) ─────────────────────── */

test('every row lookup in the router answers 404, not 200-with-null', async () => {
    // Derived: each handler that SELECTs a row before acting.
    const LOOKUPS = [
        ['GET', ['film', 'style-book', MISSING], null],
        ['PUT', ['film', 'style-book', MISSING], { name: 'x' }],
        ['DELETE', ['film', 'style-book', MISSING], null],
        ['POST', ['film', 'style-book', MISSING, 'media'], { source_url: 'https://e.com/a.png' }],
        ['DELETE', ['film', 'style-book', 'media', MISSING], null],
        ['POST', ['film', 'shots', SHOT, 'style-book', MISSING], null],
        ['POST', ['film', 'shots', MISSING, 'style-book', MISSING], null],
    ];
    const handlers = (ROUTE_SRC.match(/WHERE id = \?'\)\.get\(/g) || []).length;
    assert.ok(handlers >= 5, `expected several row lookups in the router, found ${handlers}`);
    for (const [method, parts, body] of LOOKUPS) {
        const r = await call(method, parts, body);
        assert.strictEqual(r.status, 404,
            `${method} /${parts.join('/')} returned ${r.status}, not 404`);
    }
});

/* ── SB-CRUD-07/08/09/10/11 — the PUT nobody had exercised ───────────── */

test('PUT merges: renaming an entry keeps everything it was not asked about', async () => {
    const e = await makeEntry();
    const r = await call('PUT', ['film', 'style-book', e.id], { name: 'Renamed' });
    assert.strictEqual(r.status, 200);
    const after = (await call('GET', ['film', 'style-book', e.id])).body.entry;
    assert.strictEqual(after.name, 'Renamed');
    assert.strictEqual(after.description, 'the one I keep coming back to',
        'the description was cleared by a rename');
    assert.strictEqual(after.camera.lens, '85mm', 'the camera facets were cleared by a rename');
    assert.strictEqual(after.camera.shot_type, 'close-up');
});

test('an explicit null CLEARS one facet and leaves the rest', async () => {
    const e = await makeEntry();
    await call('PUT', ['film', 'style-book', e.id], { camera: { lens: null } });
    const after = (await call('GET', ['film', 'style-book', e.id])).body.entry;
    assert.ok(!('lens' in after.camera), 'a facet set to null was not cleared');
    assert.strictEqual(after.camera.shot_type, 'close-up', 'clearing one facet cleared another');
});

test('a merge that would be invalid is refused whole, leaving the row untouched', async () => {
    const e = await makeEntry();
    const r = await call('PUT', ['film', 'style-book', e.id], { camera: { shot_type: 'worm-cam' } });
    assert.strictEqual(r.status, 400);
    const after = (await call('GET', ['film', 'style-book', e.id])).body.entry;
    assert.strictEqual(after.camera.shot_type, 'close-up', 'a refused update wrote anyway');
});

test('scope moves both ways — into the library and back', async () => {
    const e = await makeEntry();
    await call('PUT', ['film', 'style-book', e.id], { scope: 'library' });
    assert.strictEqual(db.prepare('SELECT project_id FROM film_style_book WHERE id = ?')
        .get(e.id).project_id, null, 'promotion to the library did not clear project_id');
    await call('PUT', ['film', 'style-book', e.id], { scope: 'project', project_id: PROJECT });
    assert.strictEqual(db.prepare('SELECT project_id FROM film_style_book WHERE id = ?')
        .get(e.id).project_id, PROJECT, 'demotion back to a project did not set project_id');
});

test('sort_order is honoured when finite and ignored when not', async () => {
    const e = await makeEntry();
    await call('PUT', ['film', 'style-book', e.id], { sort_order: 3 });
    const read = () => db.prepare('SELECT sort_order FROM film_style_book WHERE id = ?').get(e.id).sort_order;
    assert.strictEqual(read(), 3);
    await call('PUT', ['film', 'style-book', e.id], { sort_order: 'x' });
    assert.strictEqual(read(), 3, 'a non-numeric sort_order overwrote a good one');
});

/* ── SB-CRUD-13 / SB-MEDIA-12 — a delete has to take the bytes ───────── */

async function entryWithUpload() {
    const e = await makeEntry();
    const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154'
        + '789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
    const r = await call('POST', ['film', 'style-book', e.id, 'media'],
        { media_kind: 'image', name: 'grab.png', data: 'data:image/png;base64,' + png.toString('base64') });
    assert.strictEqual(r.status, 201, 'upload fixture failed: ' + JSON.stringify(r.body));
    const row = db.prepare('SELECT id, file_path FROM film_style_book_media WHERE entry_id = ?').get(e.id);
    assert.ok(row && row.file_path && fs.existsSync(row.file_path),
        'the upload fixture did not put bytes on disk');
    return { entry: e, media: row };
}

test('deleting an entry takes its media rows AND its files', async () => {
    const { entry, media } = await entryWithUpload();
    await call('DELETE', ['film', 'style-book', entry.id]);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM film_style_book_media WHERE entry_id = ?')
        .get(entry.id).c, 0, 'media rows survived the entry');
    assert.ok(!fs.existsSync(media.file_path),
        'the uploaded file was orphaned on disk — a row nobody has, bytes nobody can find');
});

test('deleting one visual takes its file and leaves the entry', async () => {
    const { entry, media } = await entryWithUpload();
    const r = await call('DELETE', ['film', 'style-book', 'media', media.id]);
    assert.strictEqual(r.status, 200);
    assert.ok(!fs.existsSync(media.file_path), 'the visual\'s file was orphaned on disk');
    assert.ok(db.prepare('SELECT id FROM film_style_book WHERE id = ?').get(entry.id),
        'deleting a visual deleted its entry');
});

/* ── SB-MEDIA-13 — the upload ceiling ────────────────────────────────── */

test('a style-book visual is not held to the 10MB default', () => {
    const limits = require('../lib/body-limit');
    const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(serverSrc, /bodyLimit\.bodyLimitFor\(parts\)/,
        'server.js must size bodies through the shared rule, not a private branch');
    const TEN = 10 * 1024 * 1024;
    // A frame grab is the normal case here, and a 4K PNG base64-encodes well
    // past 10MB. Refused, it arrives as a destroyed connection, which api()
    // reports as "Backend offline" — the same misdiagnosis the plate uploads
    // and the media imports each paid for once.
    assert.ok(limits.bodyLimitFor(['film', 'style-book', 'x', 'media']) > TEN,
        'attaching a visual is capped at the 10MB JSON default');
    // ...and the default still holds for an ordinary write.
    assert.strictEqual(limits.bodyLimitFor(['film', 'projects', 'x']), TEN);
    // every file-carrying shape gets it, so a new target inherits it
    assert.ok(limits.bodyLimitFor(['film', 'props', 'x', 'plate', 'import']) > TEN);
});

/* ── SB-MCP-04 — the agent path must merge identically ───────────────── */

test('stylebook_update merges over MCP too, not only over HTTP', async () => {
    const mcp = require('../lib/mcp-tools');
    const tool = (mcp.ALL_ROUTE_TOOLS || mcp.PRODUCTION_TOOLS || [])
        .find(t => t.name === 'stylebook_update');
    assert.ok(tool, 'stylebook_update is missing from the route registry');
    assert.strictEqual(tool.method, 'PUT',
        'stylebook_update must dispatch through the same PUT the page uses — '
        + 'a private write path is how the two come to disagree about merging');
    assert.ok(mcp.listTools().some(t => t.name === 'stylebook_update'), 'the tool is not listed');
    assert.match(String(tool.description), /merge/i,
        'the tool must state that it merges — an agent that assumes replace will clear the camera');
});

/* ── SB-MEDIA-14 — the reference-slot reality, at runtime ────────────── */

test('the reference-slot reality reaches both surfaces, from ONE source', () => {
    const { MEDIA_NOTE } = require('../routes/style-book');
    assert.match(MEDIA_NOTE, /lowest-ranked/i, 'the served note stopped saying it');
    // The modal carried a hand-typed copy of this sentence. Two literals is
    // exactly how a page and its API come to disagree about what a visual does.
    const literal = MEDIA_NOTE.slice(0, 40);
    assert.ok(!SPA.includes(literal),
        'the page hardcodes the note instead of rendering the served one');
    assert.match(SPA, /function styleBookNoteInto\s*\(/,
        'no single place renders the note');
    // ...and it is painted where visuals are ADDED, not only under the grid.
    const open = SPA.slice(SPA.search(/function openStyleBookModal\(/), SPA.search(/function openStyleBookModal\(/) + 900);
    assert.match(open, /styleBookNoteInto/,
        'opening the visual editor does not paint the note — a 260px card is not where this is read');
});

/* ── SB-SCOPE-02 / SB-INT-07 — what a project delete really does ─────── */

test('deleting a project keeps the entries and their visuals, as the library', async () => {
    // ON DELETE SET NULL, deliberately: an angle recorded while a film was open
    // must outlive that film. So a project-scoped entry is PROMOTED, never
    // destroyed — the opposite of what a cascade would do, and the reason the
    // film_refsheet_jobs trap is not repeated here.
    const victim = 'sg000000-0000-4000-8000-0000000000aa';
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'doomed', datetime('now'), datetime('now'))`).run(victim);
    const e = (await call('POST', ['film', 'projects', victim, 'style-book'],
        { name: 'Variant', camera: { lens: '40mm' } })).body.entry;
    await call('POST', ['film', 'style-book', e.id, 'media'], { source_url: 'https://e.com/a.png' });

    db.prepare('DELETE FROM film_projects WHERE id = ?').run(victim);

    const row = db.prepare('SELECT project_id FROM film_style_book WHERE id = ?').get(e.id);
    assert.ok(row, 'the entry was destroyed with its project — a director\'s library must outlive a film');
    assert.strictEqual(row.project_id, null, 'the entry did not become a library entry');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM film_style_book_media WHERE entry_id = ?')
        .get(e.id).c, 1, 'the entry survived and its visuals did not');
});

/* ── SB-INT-08 — the entry card's action row ─────────────────────────── */

test('the style-book entry card is in the wrapping-row denominator', () => {
    const i = SPA.indexOf('function renderStyleBook');
    const card = SPA.slice(i, i + 2600);
    assert.match(card, /class="entity-card"/, 'the entry card is not an .entity-card');
    assert.match(card, /class="card-actions"/,
        'the entry card writes its own button row, opting out of the wrap rule silently');
});
