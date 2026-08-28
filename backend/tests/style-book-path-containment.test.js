/**
 * A path out of the database is not a path you may act on.
 *
 * `addMedia` accepts `file_path` from the request body verbatim, and
 * `dropMediaFile` unlinked whatever the row held. Two unauthenticated calls —
 * register the path, delete the visual — removed any file the server process
 * could write to. The API binds every interface and answers
 * `Access-Control-Allow-Origin: *`, so that was reachable from the network and
 * cross-origin.
 *
 * `serveMedia` had the containment check and the delete did not, which is the
 * shape this codebase keeps paying for: one rule written twice, and only one
 * copy correct. There is now ONE `stylebookPath()`, and this test is set-based
 * over every filesystem call in the module — derived from the source, so a
 * fifth added later is in the denominator with nothing to remember.
 *
 * `file-storage.getFilePath()` is the established precedent: it "enforces that
 * a DB-sourced file_name cannot resolve outside its project directory, and
 * THROWS rather than silently correcting".
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-sbpath-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleStyleBook } = require('../routes/style-book');

const SRC = fs.readFileSync(path.join(__dirname, '../routes/style-book.js'), 'utf8');

function call(method, urlParts, body) {
    return new Promise(resolve => {
        const res = {
            writeHead(status) { this._status = status; },
            end(payload) {
                let parsed = null;
                try { parsed = payload ? JSON.parse(payload) : null; } catch (_) { parsed = '<binary>'; }
                resolve({ status: this._status, body: parsed });
            },
        };
        handleStyleBook({ method, body }, res, urlParts, {});
    });
}

async function newEntry() {
    const r = await call('POST', ['film', 'style-book'], { name: 'x', camera: {} });
    assert.strictEqual(r.status, 201);
    return r.body.entry || r.body;
}

/** Somewhere the style book has no business touching. */
function outsideFile(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-outside-'));
    const p = path.join(dir, `${label}.txt`);
    fs.writeFileSync(p, 'not the style book\n');
    return p;
}

/* ── the denominator, derived from the source ────────────────────────── */

/** Every filesystem call in the module, with the function it sits in. */
function fsCallSites() {
    const sites = [];
    const fnRe = /function (\w+)\s*\(/g;
    const bounds = [];
    let m;
    while ((m = fnRe.exec(SRC))) bounds.push({ name: m[1], start: m.index });
    for (let i = 0; i < bounds.length; i++) {
        const body = SRC.slice(bounds[i].start, i + 1 < bounds.length ? bounds[i + 1].start : SRC.length);
        const OPS = 'readFileSync|writeFileSync|unlinkSync|mkdirSync|rmSync|renameSync|copyFileSync';
        const re = new RegExp(`(?:\\bfsx?|require\\(['"]fs['"]\\))\\.(${OPS})\\(`, 'g');
        for (const c of body.matchAll(re)) {
            sites.push({ fn: bounds[i].name, op: c[1] });
        }
    }
    return sites;
}

test('the module still touches the filesystem, so this test has a denominator', () => {
    const sites = fsCallSites();
    assert.ok(sites.length >= 3,
        `expected several filesystem calls in routes/style-book.js, found ${sites.length}`);
    const ops = new Set(sites.map(s => s.op));
    assert.ok(ops.has('unlinkSync'), 'the delete no longer removes files — has the leak come back?');
    assert.ok(ops.has('readFileSync'), 'nothing serves a visual any more');
});

test('every filesystem call goes through the ONE containment helper', () => {
    // Not "a check exists somewhere in the file" — the check must be in the
    // function that does the operation. serveMedia had one and dropMediaFile
    // did not, and the file read as safe.
    for (const { fn, op } of fsCallSites()) {
        const start = SRC.indexOf(`function ${fn}(`);
        let depth = 0, i = SRC.indexOf('{', start), end = i;
        for (; i < SRC.length; i++) {
            if (SRC[i] === '{') depth++;
            else if (SRC[i] === '}') { depth--; if (!depth) { end = i; break; } }
        }
        const body = SRC.slice(start, end);
        assert.match(body, /stylebookPath\s*\(/,
            `${fn}() calls ${op} on a path it never passed through stylebookPath()`);
    }
});

/* ── behaviour: the boundary, and defence in depth behind it ─────────── */

test('a file_path outside the style book is refused at the boundary', async () => {
    const entry = await newEntry();
    const victim = outsideFile('boundary');
    const r = await call('POST', ['film', 'style-book', entry.id, 'media'], { file_path: victim });
    assert.strictEqual(r.status, 400,
        'an arbitrary absolute path was accepted into the database');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM film_style_book_media WHERE entry_id = ?')
        .get(entry.id).c, 0, 'the row was stored anyway');
    assert.ok(fs.existsSync(victim), 'the file was touched by a request that should have been refused');
});

test('traversal is refused however it is spelled', async () => {
    const entry = await newEntry();
    const root = path.join(process.env.FILM_DATA_DIR, 'stylebook');
    /*
     * BOTH sides must exist on disk or this test passes for the wrong reason.
     * On macOS /var is a symlink to /private/var: if the root has never been
     * created it stays unresolved while every candidate resolves through
     * realpath, so EVERYTHING looks outside and the check appears to work
     * even when it does not. Create the root and the sibling first.
     */
    fs.mkdirSync(root, { recursive: true });
    const sibling = `${root}-elsewhere`;
    fs.mkdirSync(sibling, { recursive: true });
    const nextDoor = path.join(sibling, 'next-door.txt');
    fs.writeFileSync(nextDoor, 'not ours\n');

    for (const attempt of [
        '/etc/hosts',
        path.join(root, '..', '..', 'film-engine.db'),
        path.join(root, 'a', '..', '..', '..', 'escape.txt'),
        nextDoor,                                  // shares the prefix, different directory
    ]) {
        const r = await call('POST', ['film', 'style-book', entry.id, 'media'], { file_path: attempt });
        assert.strictEqual(r.status, 400, `accepted ${attempt}`);
    }
    assert.ok(fs.existsSync(nextDoor), 'a refused path was touched anyway');
});

test('a row that already holds an outside path is NOT deleted from disk', async () => {
    // Defence in depth: rows written before the boundary check existed, or by
    // any other writer, must not become a delete primitive.
    const entry = await newEntry();
    const victim = outsideFile('legacy');
    const id = 'sbp-' + crypto.randomUUID().slice(0, 8);
    db.prepare(`INSERT INTO film_style_book_media (id, entry_id, media_kind, file_path, created_at)
                VALUES (?, ?, 'image', ?, datetime('now'))`).run(id, entry.id, victim);

    const r = await call('DELETE', ['film', 'style-book', 'media', id]);
    assert.ok(fs.existsSync(victim),
        'deleting a visual unlinked a file outside the style book');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM film_style_book_media WHERE id = ?').get(id).c,
        0, 'the row must still go — it is ours to remove even when the bytes are not');
    assert.strictEqual(r.status, 200);
});

test('deleting an ENTRY does not unlink outside paths either', async () => {
    // The entry delete walks its media and drops each file; it must be held to
    // the same rule as deleting one visual.
    const entry = await newEntry();
    const victim = outsideFile('via-entry');
    db.prepare(`INSERT INTO film_style_book_media (id, entry_id, media_kind, file_path, created_at)
                VALUES (?, ?, 'image', ?, datetime('now'))`)
        .run('sbp-' + crypto.randomUUID().slice(0, 8), entry.id, victim);

    await call('DELETE', ['film', 'style-book', entry.id]);
    assert.ok(fs.existsSync(victim), 'deleting an entry unlinked a file outside the style book');
});

test('an outside path is not SERVED either', async () => {
    const entry = await newEntry();
    const victim = outsideFile('served');
    const id = 'sbp-' + crypto.randomUUID().slice(0, 8);
    db.prepare(`INSERT INTO film_style_book_media (id, entry_id, media_kind, file_path, created_at)
                VALUES (?, ?, 'image', ?, datetime('now'))`).run(id, entry.id, victim);
    const r = await call('GET', ['film', 'style-book', 'media', id, 'file']);
    assert.ok(r.status === 403 || r.status === 404,
        `an arbitrary file was served with status ${r.status}`);
});

test('a legitimate upload still round-trips', async () => {
    // The containment must not be so tight that the feature stops working —
    // a guard that breaks the happy path gets removed within a day.
    const entry = await newEntry();
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const up = await call('POST', ['film', 'style-book', entry.id, 'media'],
        { media_kind: 'image', name: 'grab.png', data: 'data:image/png;base64,' + png.toString('base64') });
    assert.strictEqual(up.status, 201, 'a normal upload was refused: ' + JSON.stringify(up.body));
    const row = db.prepare('SELECT id, file_path FROM film_style_book_media WHERE entry_id = ?').get(entry.id);
    assert.ok(fs.existsSync(row.file_path), 'the upload did not land on disk');
    const served = await call('GET', ['film', 'style-book', 'media', row.id, 'file']);
    assert.strictEqual(served.status, 200, 'a legitimate visual is no longer servable');
    const del = await call('DELETE', ['film', 'style-book', 'media', row.id]);
    assert.strictEqual(del.status, 200);
    assert.ok(!fs.existsSync(row.file_path), 'a legitimate delete no longer removes its own file');
});
