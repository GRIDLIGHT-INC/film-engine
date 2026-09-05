const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * RBF-011 — a frame the provider can actually fetch.
 *
 * RBF-001 was asked one question and answered two. The verdict was
 * `style-references`; the other finding was that the request cannot be made at
 * all without this: `images_list` refuses data URIs — `URL scheme should be
 * 'http' or 'https'` — and Film Engine serves media on localhost. Every other
 * reference in this codebase travels as a base64 data URI, and that road is
 * closed here.
 *
 * THIS HANDS LOCAL FILES TO AN EXTERNAL SERVICE, so most of this file is about
 * what must NOT be reachable. The precedent is close and expensive: `addMedia`
 * once took a `file_path` from a request body verbatim, and adding a delete
 * turned an unvalidated input into a file-deletion primitive. The lesson
 * recorded there is that closing a "nothing happens" bug can promote an
 * unvalidated input into an action.
 *
 * So the handle is an OPAQUE ID resolved against a server-side map, never a
 * signed or encoded path. A caller cannot express a path at all, which removes
 * traversal as a category rather than defending against it.
 */

/*
 * FILM_DATA_DIR IS SET BEFORE ANYTHING IS REQUIRED. `file-storage` captures
 * DATA_DIR at import time, so setting it inside a before() hook would leave
 * every mint pointed at the operator's REAL media tree — this test creates and
 * deletes directories, and doing that under ~/.gridlight while a live server is
 * running is exactly the isolation `tests/test-isolation.test.js` exists to
 * prevent.
 */
process.env.FILM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-handles-data-'));

const handles = require('../lib/frame-handles');
const { DATA_DIR } = require('../lib/file-storage');

let TMP, INSIDE;
const BASE = 'https://example.test';

test.before(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-handles-'));
    // A real file inside the data tree, which is the only thing mintable.
    const dir = path.join(DATA_DIR, 'storyboards', '__handle_test__');
    fs.mkdirSync(dir, { recursive: true });
    INSIDE = path.join(dir, 'frame.png');
    fs.writeFileSync(INSIDE, Buffer.from('89504e470d0a1a0a', 'hex'));
});
test.after(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* temp */ }
});

const withBase = (extra) => ({ publicBase: BASE, ...(extra || {}) });

/* ── the happy path ────────────────────────────────────────────────────── */

test('a frame inside the data tree mints a fetchable http URL', () => {
    const r = handles.mintHandle(INSIDE, withBase({ scope: 'plan-1' }));
    assert.strictEqual(r.ok, true, r.reason);
    assert.match(r.url, /^https?:\/\//, `not a fetchable URL: ${r.url}`);
    assert.ok(r.url.startsWith(BASE), 'the URL does not sit under the configured public address');
    assert.ok(r.expiresAt > Date.now(), 'the handle is already expired');
    const back = handles.resolveHandle(r.id);
    assert.strictEqual(back.ok, true, back.reason);
    assert.strictEqual(back.path, INSIDE);
});

test('the handle is opaque — the path cannot be read out of it or put into it', () => {
    /*
     * THE PROPERTY THAT REMOVES TRAVERSAL AS A CATEGORY. A signed path, or a
     * base64 one, means the route eventually decodes something a caller
     * supplied. An opaque id resolved against a server-side map means a caller
     * cannot express a path at all.
     */
    const r = handles.mintHandle(INSIDE, withBase());
    assert.strictEqual(r.ok, true, r.reason);
    for (const fragment of ['frame.png', 'storyboards', '__handle_test__', DATA_DIR]) {
        assert.ok(!r.id.includes(fragment), `the id leaks part of the path: ${fragment}`);
    }
    let decoded = '';
    try { decoded = Buffer.from(r.id, 'base64').toString('utf8'); } catch (_) { decoded = ''; }
    assert.ok(!decoded.includes('/') || !decoded.includes('frame'),
        'the id decodes to something path-shaped');
    // And a path offered AS an id resolves to nothing.
    for (const attempt of [INSIDE, '../../etc/passwd', '/etc/passwd', 'storyboards/x/frame.png']) {
        const bad = handles.resolveHandle(attempt);
        assert.strictEqual(bad.ok, false, `a path was accepted as a handle: ${attempt}`);
    }
});

test('a handle stops working when it expires', () => {
    const r = handles.mintHandle(INSIDE, withBase({ ttlMs: 20 }));
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(handles.resolveHandle(r.id).ok, true, 'expired before it was used');
    const until = Date.now() + 60;
    while (Date.now() < until) { /* the TTL is 20ms; this is a real wait, not a mock clock */ }
    const after = handles.resolveHandle(r.id);
    assert.strictEqual(after.ok, false, 'an expired handle still resolves');
    assert.strictEqual(after.code, 'handle_expired');
});

test('a scope can be revoked, and takes only its own handles', () => {
    /*
     * "The frames of one plan, not the media tree" — so when a repair finishes
     * or is abandoned, its handles stop working without waiting out the TTL.
     * Revoking must not touch another plan's, or one director's cancel would
     * break another's running repair.
     */
    const mine = handles.mintHandle(INSIDE, withBase({ scope: 'plan-A' }));
    const other = handles.mintHandle(INSIDE, withBase({ scope: 'plan-B' }));
    const n = handles.revokeScope('plan-A');
    assert.ok(n >= 1, 'revoking a scope removed nothing');
    assert.strictEqual(handles.resolveHandle(mine.id).ok, false, 'a revoked handle still resolves');
    assert.strictEqual(handles.resolveHandle(other.id).ok, true, 'revoking one scope took another\'s');
});

/* ── what must not be reachable ────────────────────────────────────────── */

test('every declared refusal fires on the input that should trigger it', () => {
    assert.ok(handles.HANDLE_REFUSALS.length >= 5,
        `only ${handles.HANDLE_REFUSALS.length} refusals declared; this is not the real set`);
    const outside = path.join(TMP, 'outside.png');
    fs.writeFileSync(outside, 'x');
    const PROBES = {
        no_public_base: () => handles.mintHandle(INSIDE, { publicBase: '' }),
        path_outside_data: () => handles.mintHandle(outside, withBase()),
        no_file: () => handles.mintHandle(path.join(DATA_DIR, 'storyboards', '__handle_test__', 'gone.png'), withBase()),
        bad_public_base: () => handles.mintHandle(INSIDE, { publicBase: 'file:///etc' }),
        handle_unknown: () => handles.resolveHandle('deadbeefdeadbeefdeadbeefdeadbeef'),
        handle_expired: () => {
            const h = handles.mintHandle(INSIDE, withBase({ ttlMs: 1 }));
            const until = Date.now() + 20; while (Date.now() < until) { /* wait out the TTL */ }
            return handles.resolveHandle(h.id);
        },
    };
    const unreachable = [];
    for (const r of handles.HANDLE_REFUSALS) {
        const probe = PROBES[r.code];
        if (!probe) { unreachable.push(`${r.code} (no probe: ${r.why})`); continue; }
        const got = probe();
        if (got.ok !== false || got.code !== r.code) {
            unreachable.push(`${r.code} → ${got.ok ? 'ACCEPTED' : got.code}`);
        } else {
            assert.ok(typeof got.reason === 'string' && got.reason.length > 20,
                `${r.code} refuses without a usable reason: ${got.reason}`);
        }
    }
    assert.deepStrictEqual(unreachable, [], `refusals that do not fire: ${unreachable.join(', ')}`);
});

test('a file outside the data tree cannot be minted, however it is spelled', () => {
    /*
     * REAL-PATHED ON BOTH SIDES. On macOS /var is a symlink to /private/var, so
     * comparing a resolved target against an unresolved root refuses every
     * legitimate file — and, worse, makes the check appear to work while doing
     * nothing, because everything looks outside. That exact mistake is recorded
     * in this codebase's style-book path work.
     */
    const attempts = [
        path.join(TMP, 'elsewhere.png'),
        path.join(DATA_DIR, '..', 'secret.png'),
        path.join(DATA_DIR, 'storyboards', '__handle_test__', '..', '..', '..', 'secret.png'),
        `${DATA_DIR}-sibling/frame.png`,          // prefix match, different directory
    ];
    for (const p of attempts) {
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); }
        catch (_) { /* some of these are not creatable, which is fine */ }
        const r = handles.mintHandle(p, withBase());
        assert.strictEqual(r.ok, false, `minted a handle for ${p}`);
        assert.strictEqual(r.code, 'path_outside_data', `${p} refused as ${r.code}`);
    }
    try { fs.rmSync(`${DATA_DIR}-sibling`, { recursive: true, force: true }); } catch (_) { /* temp */ }
});

test('with no public address it refuses and names the remedy, rather than handing out a localhost URL', () => {
    /*
     * THE ACCEPTANCE CRITERION MOST WORTH GETTING RIGHT. A localhost URL sent
     * to a provider comes back as a fetch failure at THEIR end, which reads
     * like a credential or a service fault — the same misdiagnosis that made a
     * 413 look like "Backend offline". The operator has to be told it is their
     * address that is missing, and what to do.
     */
    const r = handles.mintHandle(INSIDE, { publicBase: '' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'no_public_base');
    assert.ok(!/localhost|127\.0\.0\.1/.test(String(r.url || '')), 'a localhost URL was handed out anyway');
    assert.match(r.reason, /FILM_ENGINE_PUBLIC_URL/,
        `the reason does not name the setting to change: ${r.reason}`);
    assert.match(r.reason, /reach|tunnel|proxy|internet|outside/i,
        `the reason does not explain what kind of address is needed: ${r.reason}`);
});

test('the public base must itself be http or https', () => {
    for (const bad of ['file:///etc', 'ftp://x.test', 'javascript:alert(1)', 'not a url']) {
        const r = handles.mintHandle(INSIDE, { publicBase: bad });
        assert.strictEqual(r.ok, false, `accepted a public base of ${bad}`);
        assert.strictEqual(r.code, 'bad_public_base');
    }
});

/* ── the route ─────────────────────────────────────────────────────────── */

test('the serving route resolves handles and never a path from the URL', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /frame-handle|frameHandle/,
        'server.js never dispatches the frame handle route');
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'frame-handles.js'), 'utf8');
    const stripped = route.split('\n').map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
    assert.match(stripped, /resolveHandle/, 'the route does not resolve through the handle map');
    /*
     * Nothing in the route may join a request value onto a directory. That is
     * the shape that turned an unvalidated file_path into a deletion primitive
     * one feature over.
     */
    assert.ok(!/path\.join\([^)]*(?:urlParts|query|req\.|q\.)/.test(stripped),
        'the route builds a filesystem path out of something from the request');
    assert.ok(!/DATA_DIR/.test(stripped) || /resolveHandle/.test(stripped),
        'the route reaches into the data directory directly');
});

test('the route really serves the bytes, and really refuses a bad handle', async () => {
    /*
     * DRIVEN OVER HTTP, not asserted from the source. A route that answers 200
     * with the wrong body is not a route — the lesson `servedUrlFor` cost once,
     * where a perfectly good URL string resolved to a 404. Here it matters more
     * than usual: the consumer is a provider's fetcher, and if this serves
     * anything other than the frame the repair generates against the wrong
     * picture and bills for it.
     */
    const http = require('http');
    const { handleFrameHandles } = require('../routes/frame-handles');
    const server = http.createServer((req, res) => {
        const parts = req.url.split('?')[0].split('/').filter(Boolean);
        handleFrameHandles(req, res, parts);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const get = (p) => new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: p }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks) }));
        });
    });

    try {
        const h = handles.mintHandle(INSIDE, withBase({ scope: 'http-test' }));
        assert.strictEqual(h.ok, true, h.reason);

        const good = await get(`/film/frame-handle/${h.id}`);
        assert.strictEqual(good.status, 200, `the handle did not serve: ${good.status}`);
        assert.ok(good.body.equals(fs.readFileSync(INSIDE)),
            'the route served something other than the file the handle names');
        assert.strictEqual(good.headers['content-type'], 'image/png');
        assert.strictEqual(Number(good.headers['content-length']), fs.statSync(INSIDE).size,
            'no length was sent, so a fetcher cannot size what it is receiving');
        assert.match(String(good.headers['cache-control']), /no-store/,
            'a cached copy would outlive the expiry this design rests on');

        // An id nobody minted, and a path offered as one.
        for (const bad of ['0'.repeat(32), '..%2f..%2fetc%2fpasswd', 'storyboards']) {
            const r = await get(`/film/frame-handle/${bad}`);
            assert.strictEqual(r.status, 404, `${bad} was served with ${r.status}`);
        }

        // And revoking really closes it.
        handles.revokeScope('http-test');
        const after = await get(`/film/frame-handle/${h.id}`);
        assert.strictEqual(after.status, 404, 'a revoked handle still serves over HTTP');
    } finally {
        await new Promise(r => server.close(r));
    }
});

test('nothing here can delete or write', () => {
    /*
     * The handle store is READ-ONLY over the media tree by construction. This
     * feature exists to hand a file out; a write or an unlink reachable from it
     * would be the promotion this codebase has already paid for once.
     */
    for (const f of ['lib/frame-handles.js', 'routes/frame-handles.js']) {
        const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
            .split('\n').map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
        assert.ok(!/unlink|rmSync|writeFile|createWriteStream|renameSync/.test(s),
            `${f} can modify the filesystem; this feature only ever hands a file out`);
    }
});
