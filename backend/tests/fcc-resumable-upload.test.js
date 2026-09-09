/**
 * CHUNKED, RESUMABLE UPLOAD — GRD-3806 / FCC-010.
 *
 * "Resumable because a phone loses Wi-Fi mid-transfer and a restart from zero
 * on a multi-gigabyte file is a transfer that never completes."
 *
 * That sentence is the whole task, and it is arithmetic rather than opinion. A
 * 7GB ProRes take over a domestic connection is tens of minutes; the chance of
 * an uninterrupted window that long on a phone is not high, and every failure
 * costs the WHOLE transfer. Retrying from zero does not converge — it is a
 * transfer that never completes, however many times it is attempted.
 *
 * HALF OF THIS ALREADY EXISTED AND IS NOT THE POINT. `readBody` already takes
 * raw bytes when the content-type is media, so the base64 inflation is gone for
 * a single-shot upload. What is missing is the half the task is named for:
 * nothing can be RESUMED, so the ceiling is not the body limit but the length
 * of an uninterrupted connection.
 *
 * FOUR THINGS FAIL SILENTLY HERE, AND EACH GETS A TEST:
 *
 *   - A CLIENT RESUMING FROM THE WRONG OFFSET writes its bytes over the wrong
 *     part of the file. The upload completes, the size is right, and the file
 *     is corrupt in the middle. The only defence is refusing an offset that is
 *     not exactly what the server holds.
 *   - A TRUNCATED UPLOAD that is finalised anyway produces a short clip that
 *     plays. This codebase has already paid for that shape twice — a join that
 *     lost its audio, a lane that never arrived — and both times the file was
 *     perfectly valid.
 *   - AN UPLOAD THAT BYPASSES `importMedia` skips the magic-byte sniffing, the
 *     asset row and the duration measurement that every direct upload gets. It
 *     would look like a successful import and be a file nothing can find.
 *   - A PARTIAL UPLOAD NOBODY FINISHES is disk nothing will ever reclaim. On
 *     multi-gigabyte takes that fills a disk in a handful of abandoned
 *     attempts.
 *
 * SET-BASED OVER TWO REGISTRIES:
 *
 *   1. The SESSION OPERATIONS — create, append, status, complete, abandon.
 *      Five. Without `status` a client cannot ask where to resume FROM, which
 *      is the one question the whole feature exists to answer; without
 *      `abandon` the disk only grows.
 *   2. `MEDIA_IMPORTS` — 18 targets. A resumable upload that finishes into
 *      video and not into a 3D model leaves the largest mesh still unsendable,
 *      and the failure is invisible because video is what anybody would test.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

/*
 * ISOLATION BEFORE THE FIRST LOCAL REQUIRE, which `test-isolation.test.js`
 * enforces and caught here. `lib/media-imports` reaches the database at import,
 * so requiring it before this line would open the REAL one — the rule exists
 * because a test that writes to a director's install is worse than no test.
 */
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-upload-root-'));

const { MEDIA_IMPORTS } = require('../lib/media-imports');

/** A private data dir per test, so nothing touches the real install. */
function withDataDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-upload-'));
    const before = process.env.FILM_DATA_DIR;
    process.env.FILM_DATA_DIR = dir;
    for (const k of Object.keys(require.cache)) {
        if (/lib[/\\](uploads|file-storage)\.js$/.test(k)) delete require.cache[k];
    }
    try { return fn(require('../lib/uploads'), dir); } finally {
        if (before === undefined) delete process.env.FILM_DATA_DIR;
        else process.env.FILM_DATA_DIR = before;
    }
}

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments stripped — a mention is not a use. */
const code = (rel) => src(rel).split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/* ------------------------------------------------------------------ *
 * SET 1 — the five operations a resumable transfer needs              *
 * ------------------------------------------------------------------ */

const OPERATIONS = [
    {
        op: 'create',
        fn: 'beginUpload',
        why: 'nothing can start a transfer, so there is no session to resume into',
    },
    {
        op: 'append',
        fn: 'appendChunk',
        why: 'a transfer can be started and never fed — the whole point is sending it in pieces',
    },
    {
        op: 'status',
        fn: 'uploadStatus',
        why: 'a client cannot ask where to resume FROM. That is the one question this feature '
            + 'exists to answer, and without it every reconnection starts at zero again',
    },
    {
        op: 'complete',
        fn: 'completeUpload',
        why: 'the pieces never become a file',
    },
    {
        op: 'abandon',
        fn: 'abandonUpload',
        why: 'a partial upload nobody finishes is disk nothing reclaims, and on multi-gigabyte '
            + 'takes that fills a disk in a handful of attempts',
    },
];

test('EVERY operation a resumable transfer needs exists', () => {
    const uploads = require('../lib/uploads');
    const missing = OPERATIONS.filter((o) => typeof uploads[o.fn] !== 'function')
        .map((o) => `${o.op} (${o.fn}): ${o.why}`);
    assert.deepStrictEqual(missing, [], `the transfer is incomplete:\n  ${missing.join('\n  ')}`);
});

test('a transfer sent in pieces reassembles byte-for-byte', () => {
    withDataDir((uploads) => {
        const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
        const s = uploads.beginUpload({ total_bytes: payload.length, mime: 'video/mp4' });
        assert.ok(s.id, 'no session id');
        assert.strictEqual(s.received, 0, 'a new session already holds bytes');

        let at = 0;
        for (const size of [10, 10, 10, 6]) {
            const r = uploads.appendChunk(s.id, at, payload.subarray(at, at + size));
            at += size;
            assert.strictEqual(r.received, at, `after ${at} bytes the server says ${r.received}`);
        }
        const done = uploads.completeUpload(s.id);
        assert.ok(Buffer.isBuffer(done.bytes), 'completing did not hand back the bytes');
        assert.strictEqual(done.bytes.toString(), payload.toString(),
            'the pieces reassembled into something other than what was sent');
    });
});

test('a client that resumes from the WRONG offset is refused, with the true one', () => {
    /*
     * The silent corruption. Writing at the wrong offset produces a file of
     * exactly the right length whose middle is wrong — it completes, it
     * validates, and it is broken. The server holds the only authoritative
     * answer to "how much do you have", so it must refuse anything else.
     */
    withDataDir((uploads) => {
        const s = uploads.beginUpload({ total_bytes: 20, mime: 'video/mp4' });
        uploads.appendChunk(s.id, 0, Buffer.alloc(10, 1));

        assert.throws(() => uploads.appendChunk(s.id, 5, Buffer.alloc(5, 2)),
            /offset/i, 'a chunk was accepted at an offset behind what the server holds');
        assert.throws(() => uploads.appendChunk(s.id, 15, Buffer.alloc(5, 2)),
            /offset/i, 'a chunk was accepted at an offset beyond what the server holds — the gap '
            + 'is filled with nothing and the file is corrupt');

        const at = uploads.uploadStatus(s.id);
        assert.strictEqual(at.received, 10,
            'the refusals changed what the server holds, so a correct retry now fails too');
    });
});

test('resuming after a drop continues from exactly where it stopped', () => {
    withDataDir((uploads) => {
        const payload = Buffer.from('the quick brown fox jumps over the lazy dog');
        const s = uploads.beginUpload({ total_bytes: payload.length, mime: 'video/mp4' });
        uploads.appendChunk(s.id, 0, payload.subarray(0, 12));

        // ...the phone loses Wi-Fi. It comes back and asks where it got to.
        const at = uploads.uploadStatus(s.id);
        assert.strictEqual(at.received, 12, 'the server forgot what it had already taken');
        assert.strictEqual(at.total, payload.length, 'the server forgot how much was coming');

        uploads.appendChunk(s.id, at.received, payload.subarray(at.received));
        assert.strictEqual(uploads.completeUpload(s.id).bytes.toString(), payload.toString(),
            'the resumed half did not join the first');
    });
});

test('a TRUNCATED transfer is refused rather than finalised', () => {
    /*
     * The failure this codebase has paid for twice, in other shapes: a file
     * that is short and perfectly valid. It plays, it reports a duration, and
     * the missing end looks like a creative decision.
     */
    withDataDir((uploads) => {
        const s = uploads.beginUpload({ total_bytes: 100, mime: 'video/mp4' });
        uploads.appendChunk(s.id, 0, Buffer.alloc(40, 7));
        assert.throws(() => uploads.completeUpload(s.id), /incomplete|40|100/i,
            'a transfer 60 bytes short was finalised. The clip plays and ends early');
    });
});

test('a transfer that overruns what it declared is refused', () => {
    withDataDir((uploads) => {
        const s = uploads.beginUpload({ total_bytes: 10, mime: 'video/mp4' });
        assert.throws(() => uploads.appendChunk(s.id, 0, Buffer.alloc(25, 3)), /larger|declared|total/i,
            'more bytes were accepted than the client said it would send, so the declared total '
            + 'is not a contract and the completion check means nothing');
    });
});

test('abandoning a transfer reclaims the disk it was holding', () => {
    withDataDir((uploads, dir) => {
        const s = uploads.beginUpload({ total_bytes: 64, mime: 'video/mp4' });
        uploads.appendChunk(s.id, 0, Buffer.alloc(64, 9));
        const before = fs.readdirSync(path.join(dir, 'uploads'));
        assert.ok(before.length >= 1, 'the partial upload was never written anywhere');

        uploads.abandonUpload(s.id);
        const after = fs.readdirSync(path.join(dir, 'uploads'));
        assert.deepStrictEqual(after, [],
            `abandoning left ${after.join(', ')} behind. On multi-gigabyte takes that fills a disk `
            + 'in a handful of attempts');
        assert.throws(() => uploads.uploadStatus(s.id), /unknown|not found/i,
            'an abandoned session still answers, so a client can keep feeding a dead transfer');
    });
});

test('a stale transfer nobody finished can be swept', () => {
    withDataDir((uploads, dir) => {
        const s = uploads.beginUpload({ total_bytes: 64, mime: 'video/mp4' });
        uploads.appendChunk(s.id, 0, Buffer.alloc(10, 1));
        assert.strictEqual(typeof uploads.sweepUploads, 'function',
            'nothing sweeps abandoned transfers, so a phone that walks away leaves gigabytes '
            + 'behind for ever');

        // Nothing is stale yet — a sweep must not eat a transfer in progress.
        uploads.sweepUploads(60 * 60 * 1000);
        assert.strictEqual(uploads.uploadStatus(s.id).received, 10,
            'the sweep deleted a live transfer, which is worse than never sweeping');

        uploads.sweepUploads(-1);            // everything is older than -1ms
        assert.throws(() => uploads.uploadStatus(s.id), /unknown|not found/i,
            'the sweep left a stale transfer behind');
    });
});

/* ------------------------------------------------------------------ *
 * SET 2 — every import target, and the path they all share            *
 * ------------------------------------------------------------------ */

test('EVERY import target can be the destination of a resumable transfer', () => {
    /*
     * A transfer that finishes into video and not into a 3D model leaves the
     * largest mesh still unsendable — and the gap is invisible, because video
     * is what anybody would test.
     */
    const ids = Object.keys(MEDIA_IMPORTS);
    assert.ok(ids.length >= 18, `only ${ids.length} import targets; the registry read is broken`);

    withDataDir((uploads) => {
        const refused = [];
        for (const target of ids) {
            try { uploads.beginUpload({ total_bytes: 8, mime: 'video/mp4', target }); } catch (e) {
                refused.push(`${target}: ${e.message}`);
            }
        }
        assert.deepStrictEqual(refused, [],
            `these targets cannot receive a resumable transfer:\n  ${refused.join('\n  ')}`);
    });
});

test('a target the registry does not declare is REFUSED', () => {
    withDataDir((uploads) => {
        assert.throws(() => uploads.beginUpload({ total_bytes: 8, mime: 'video/mp4', target: 'nope' }),
            /target/i,
            'an unknown target was accepted. The transfer would complete and land nowhere, which '
            + 'reads as a successful upload of a file nothing can find');
    });
});

test('a completed transfer goes through the SAME import path as a direct upload', () => {
    /*
     * `importMedia` is where the magic-byte sniffing, the asset row and the
     * duration measurement happen. A chunked upload that wrote the file itself
     * would skip all of it — "the bytes decide, never the name" is a rule this
     * codebase paid for, and bypassing it would let a renamed file through on
     * the one path built for the largest files.
     */
    const route = code('backend/routes/media-import.js');
    assert.ok(/importMedia\s*\(/.test(route),
        'the import route no longer calls importMedia');
    const uploads = code('backend/lib/uploads.js');
    assert.ok(!/saveFile\s*\(|fs\.writeFileSync\s*\([^)]*refsheets|film_assets/.test(uploads),
        'lib/uploads writes the final file or the asset row itself, bypassing importMedia — and '
        + 'with it the magic-byte check that decides what a file actually is');
});

/* ------------------------------------------------------------------ *
 * SET 3 — the id is not a path, and the 413 rule still holds          *
 * ------------------------------------------------------------------ */

test('a session id cannot escape the uploads directory', () => {
    /*
     * This codebase has paid for a path-containment bug once already, and that
     * one turned a resource leak into a file-deletion primitive. An id arrives
     * from the request, so it is exactly the same shape of input.
     */
    withDataDir((uploads, dir) => {
        /*
         * A REAL FILE WHERE THE TRAVERSAL WOULD LAND, because the first version
         * of this proved nothing. It asserted that a traversing id throws
         * "unknown upload" — which it did, for the wrong reason entirely: the
         * file simply did not exist. Removing BOTH the id shape AND the
         * containment guard left it passing.
         *
         * Planting the file is what makes the difference between "refused" and
         * "happened to miss". This codebase has paid for a path-containment bug
         * once, and that one turned a resource leak into a file-deletion
         * primitive — an id arrives from a request, so it is the same class of
         * input.
         */
        const outside = path.join(dir, 'escape');
        fs.writeFileSync(`${outside}.json`, JSON.stringify({ total_bytes: 4, mime: 'video/mp4' }));
        fs.writeFileSync(`${outside}.part`, Buffer.from('leak'));

        for (const bad of ['../escape', '../../escape', 'a/b', '..%2fx', 'ESCAPE']) {
            let reached = null;
            try { reached = uploads.uploadStatus(bad); } catch { /* refused, which is the point */ }
            assert.strictEqual(reached, null,
                `"${bad}" was resolved as a session id and read ${JSON.stringify(reached)} from `
                + 'outside the uploads directory');
        }

        // And the planted file is untouched — a refusal must not delete either.
        assert.ok(fs.existsSync(`${outside}.part`), 'the traversal reached far enough to remove a file');
    });
});

test('the 413 still says so before it hangs up', () => {
    /*
     * Pinned rather than rebuilt. A destroyed request reaches the browser as a
     * network error, which api() reports as "Backend offline" — indistinguishable
     * from a dead server, on the one feature where large files are the point.
     * Order is the whole property.
     */
    const s = src('backend/server.js');
    const head = s.indexOf('res.writeHead(413');
    const destroy = s.indexOf('req.destroy()', head);
    assert.ok(head > 0, 'nothing answers 413');
    assert.ok(destroy > head, 'the socket is destroyed before the 413 is written');
});

test('a chunk has a ceiling of its own, derived from the URL shape', () => {
    /*
     * Found by reading what the shipped rule actually returns rather than by
     * assuming: an upload chunk inherited the 10MB JSON default, because
     * `carriesFile` looks for a last segment of `import` or `media` and a chunk
     * path ends in a session id. Ten megabytes is a perfectly sensible chunk —
     * but by ACCIDENT, and body-limit.js's own doctrine is that the ceiling is
     * derived from the shape rather than fallen into.
     *
     * It is deliberately NOT the 150MB file ceiling. A chunk is meant to be
     * small: losing one should cost seconds, and 150MB pieces would defeat the
     * granularity the whole feature exists for.
     */
    const b = require('../lib/body-limit');
    const chunk = ['film', 'uploads', 'deadbeefdeadbeefdeadbeefdeadbeef'];
    assert.ok(typeof b.CHUNK_LIMIT === 'number' && b.CHUNK_LIMIT > 0,
        'body-limit declares no chunk ceiling, so a chunk falls into whatever default it lands on');
    assert.strictEqual(b.limitForPath(chunk), b.CHUNK_LIMIT,
        `an upload chunk is held to ${b.limitForPath(chunk)} bytes, which is not the chunk `
        + 'ceiling. The rule has to name this path rather than let it fall through');
    assert.ok(b.CHUNK_LIMIT < b.FILE_LIMIT,
        'a chunk is allowed to be as large as a whole file, which defeats the granularity that '
        + 'makes losing one cheap');
});

test('the oversize refusal does not claim base64 inflation for a RAW body', () => {
    /*
     * The message says "uploads travel base64-encoded, which is a third larger
     * than the file itself" — true of a JSON body and false of a chunk, which
     * is raw. Telling a director their 12MB chunk is really 9MB of file sends
     * them to re-encode something that was never encoded. This task is the one
     * that removes the base64 body, so it is the one that owes the message.
     */
    /*
     * BOUND TO THE MESSAGE, never a character window. The first version looked
     * for `isRaw` within 2000 characters of the writeHead and passed — because
     * `isRaw` is DECLARED above the handler, nowhere near the sentence. That is
     * the fourth time this codebase has paid for a bounded window; the rule is
     * to bind to the thing itself.
     */
    const s = src('backend/server.js');
    const head = s.indexOf('writeHead(413');
    const base64 = s.indexOf('base64-encoded', head);
    assert.ok(head > 0, 'nothing answers 413');
    assert.ok(base64 > head,
        'the base64 sentence is gone entirely — it is still true of a JSON body and should stay '
        + 'for one');
    // Bounded by two real positions in the file, not by a character count.
    assert.ok(/\bisRaw\b/.test(s.slice(head, base64)),
        'the 413 says the same thing whatever the body is, so a raw chunk is told it was '
        + 'base64-encoded and a third larger than the file — which it was not, and the director '
        + 're-encodes something that was never encoded');
});

test('the chunk route is reachable, and the server dispatches it', () => {
    /*
     * A CALL, not a mention. The first version matched /uploads/ anywhere in
     * server.js and passed against a build with no route at all — because the
     * 413 error MESSAGE contains the word "uploads travel base64-encoded". A
     * mention is not a use, and this one reported a completely unreachable
     * library as wired up.
     */
    const server = code('backend/server.js');
    assert.ok(/require\(['"]\.\/routes\/uploads['"]\)/.test(server),
        'server.js never requires the upload route');
    assert.ok(/\bhandleUploads\s*\(/.test(server),
        'server.js never CALLS the upload route, so every function in lib/uploads is unreachable '
        + '— the shape this codebase calls "a capability with no control"');
});

test('EVERY session operation is reachable over HTTP', () => {
    /*
     * A library nobody can reach is one that does not exist. The phone is the
     * only caller this feature has, and it speaks HTTP.
     */
    const route = code('backend/routes/uploads.js');
    const uploads = require('../lib/uploads');
    const missing = OPERATIONS.filter((o) => !new RegExp(`\\b${o.fn}\\s*\\(`).test(route))
        .map((o) => `${o.op}: the route never calls ${o.fn}`);
    assert.deepStrictEqual(missing, [],
        `these are implemented and unreachable:\n  ${missing.join('\n  ')}`);
    assert.ok(typeof uploads.sweepUploads === 'function', 'the sweep is gone');
});
