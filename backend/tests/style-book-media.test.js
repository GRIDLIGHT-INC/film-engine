/**
 * A style-book entry holds pictures and videos, from a file or a link.
 *
 * "In the style book I can't add a picture/image upload or link or a video
 * link... local or youtube."
 *
 * Correct: the table and the route existed and there was no way in. The entry
 * card even linked to a serving route that was never written. A reference you
 * cannot attach is the whole feature missing — the entry is a shot you liked,
 * and what makes it legible later is the picture of it.
 *
 * Set-based over the ways a visual arrives, because they fail separately: an
 * upload needs storage and a serving route, a link needs neither and needs a
 * renderer that knows what it is pointing at.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-sbmedia-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleStyleBook } = require('../routes/style-book');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** Every way a visual can arrive. Each is a separate failure. */
const SOURCES = [
    { id: 'uploaded image', body: () => ({ media_kind: 'image', name: 'ref.png',
        data: `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}` }) },
    { id: 'uploaded video', body: () => ({ media_kind: 'video', name: 'move.mp4',
        data: `data:video/mp4;base64,${Buffer.from('0000001c667479706d703432', 'hex').toString('base64')}` }) },
    { id: 'youtube link', body: () => ({ source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }) },
    { id: 'vimeo link', body: () => ({ source_url: 'https://vimeo.com/12345678' }) },
    { id: 'direct image link', body: () => ({ source_url: 'https://example.com/a-frame.jpg' }) },
    { id: 'plain web link', body: () => ({ source_url: 'https://example.com/an-article' }) },
];

function call(method, urlParts, body) {
    return new Promise(resolve => {
        const res = {
            writeHead(s, headers) { this._s = s; this._h = headers || {}; },
            end(p) {
                // The file route answers with BYTES, not JSON. Parsing
                // everything as JSON made a working image look like a failure.
                let parsed = null;
                if (p) { try { parsed = JSON.parse(p); } catch (_) { parsed = { bytes: p.length }; } }
                resolve({ status: this._s, headers: this._h, body: parsed });
            },
        };
        handleStyleBook({ method, body }, res, urlParts, {});
    });
}

let ENTRY;
test.before(async () => {
    const r = await call('POST', ['film', 'style-book'], { name: 'with visuals', scope: 'library' });
    ENTRY = r.body.entry.id;
});

test('every way of adding a visual works', async () => {
    const failed = [];
    for (const s of SOURCES) {
        const r = await call('POST', ['film', 'style-book', ENTRY, 'media'], s.body());
        if (r.status !== 201) failed.push(`${s.id}: ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
    }
    assert.deepStrictEqual(failed, [], `\n  ${failed.join('\n  ')}`);

    const got = await call('GET', ['film', 'style-book', ENTRY]);
    assert.strictEqual(got.body.entry.media.length, SOURCES.length,
        'not every visual was kept — "multiple visuals" is the ask');
});

test('an uploaded file is stored and servable, a link is not stored', async () => {
    /*
     * The two are genuinely different and the row has to say which. An upload
     * has bytes on disk and needs a route; a link has neither and must not be
     * given a fake file path, or the serving route 404s on something that was
     * never a file.
     */
    const got = await call('GET', ['film', 'style-book', ENTRY]);
    for (const m of got.body.entry.media) {
        const isLink = !!m.source_url;
        if (isLink) {
            assert.ok(!m.file_path, `${m.source_url}: a link was given a file path`);
        } else {
            assert.ok(m.file_path, 'an uploaded visual has no file on disk');
            assert.ok(fs.existsSync(m.file_path), `the stored file is missing: ${m.file_path}`);
            assert.ok(m.url, 'an uploaded visual has no URL to render from');
        }
    }
});

test('an uploaded visual can actually be fetched', async () => {
    // Asserting a URL is non-null passes while it 404s — the mistake
    // servedUrlFor made once and media-imports made again.
    const got = await call('GET', ['film', 'style-book', ENTRY]);
    const uploaded = got.body.entry.media.find(m => !m.source_url);
    assert.ok(uploaded, 'nothing was uploaded to check');

    const r = await call('GET', ['film', 'style-book', 'media', uploaded.id, 'file']);
    assert.strictEqual(r.status, 200,
        'the entry card links to a serving route that does not answer');
    assert.ok(r.body && r.body.bytes > 0, 'the route answered 200 with no picture in it');
    assert.match(String(r.headers['Content-Type'] || ''), /^image\//,
        'the picture is served without an image content type, so a browser will not render it');
});

test('a link is classified so it can be rendered as what it is', async () => {
    /*
     * A YouTube URL and a JPEG URL are both "a link" and render completely
     * differently. Classified once on the server so the page does not have to
     * guess — and so an agent reading the entry knows too.
     */
    const got = await call('GET', ['film', 'style-book', ENTRY]);
    const byUrl = Object.fromEntries(got.body.entry.media.filter(m => m.source_url)
        .map(m => [m.source_url, m]));

    assert.strictEqual(byUrl['https://www.youtube.com/watch?v=dQw4w9WgXcQ'].link_kind, 'youtube');
    assert.strictEqual(byUrl['https://vimeo.com/12345678'].link_kind, 'vimeo');
    // A .jpg URL is a picture, not a bare link — it can be rendered inline.
    assert.strictEqual(byUrl['https://example.com/a-frame.jpg'].link_kind, 'image');
    assert.strictEqual(byUrl['https://example.com/an-article'].link_kind, 'link');

    // An embeddable link carries what is needed to embed it, rather than
    // making every reader re-parse the URL.
    assert.match(String(byUrl['https://www.youtube.com/watch?v=dQw4w9WgXcQ'].embed_url || ''),
        /youtube\.com\/embed\//, 'a YouTube link has no embed URL');
});

test('rubbish is refused rather than stored as a broken visual', async () => {
    const bad = [
        { case: 'neither file nor link', body: {} },
        { case: 'not a URL', body: { source_url: 'not a url at all' } },
        { case: 'a script URL', body: { source_url: 'javascript:alert(1)' } },
    ];
    for (const b of bad) {
        const r = await call('POST', ['film', 'style-book', ENTRY, 'media'], b.body);
        assert.strictEqual(r.status, 400, `${b.case} was accepted`);
    }
});

test('the page can add a visual — both ways', () => {
    // A capability with no control is indistinguishable from one that does not
    // exist, which is exactly what was reported.
    assert.match(SPA, /function addStyleBookMedia/, 'no way to add a visual');
    assert.match(SPA, /styleBookMediaUrl/, 'no field to paste a link into');
    assert.match(SPA, /styleBookMediaFile/, 'no file picker to upload with');
    assert.match(SPA, /function removeStyleBookMedia/, 'a visual can be added and never removed');
    // And rendered as what it is.
    assert.match(SPA, /link_kind/, 'the page renders every visual the same way');
});

test('a brand-new shot offers the visual fields, and saves itself to accept one', () => {
    /*
     * The section was hidden until the entry was saved, so pressing "+ Shot"
     * offered no way to add a picture at all — which reads as the feature not
     * existing, and was reported as exactly that.
     *
     * The invariant it protected is real: an upload needs an owner, or a
     * cancelled entry leaves an orphaned file. That is satisfied by CREATING
     * the owner rather than by refusing — "save it, re-open it, then attach"
     * is three steps to do one thing.
     */
    const at = SPA.indexOf('const mediaSection = document.getElementById');
    assert.notStrictEqual(at, -1, 'the visuals section is no longer wired at all');
    const region = SPA.slice(at, at + 900);

    assert.ok(!/mediaSection\.style\.display = 'none'/.test(region),
        'the visuals section is hidden on a new entry, so there is no field to use');
    assert.match(region, /mediaSection\.style\.display = ''/,
        'the visuals section is never shown');

    // And the add path creates the entry rather than refusing.
    const add = SPA.slice(SPA.indexOf('async function addStyleBookMedia'), SPA.indexOf('async function addStyleBookMedia') + 900);
    assert.match(add, /saveStyleBookEntry\(\{ keepOpen: true \}\)/,
        'adding a visual to an unsaved shot does not save it first');
    assert.match(add, /if \(!saved\) return;/,
        'a failed save is treated as success, and the upload would be attached to nothing');
});
