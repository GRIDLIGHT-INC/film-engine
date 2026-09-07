/**
 * A CAPTURE IS THREE MEDIA UNDER ONE TARGET, AND THE BYTES SAY WHICH.
 *
 * Marble builds a world from a 360 panorama, from a short orbit clip, or from
 * multiple stills; a LiDAR scan arrives as a GLB. Those are an image, a video
 * and a model — three `kind`s that every other entry in MEDIA_IMPORTS has
 * exactly one of. Registering three separate targets would be the easy move and
 * the wrong one: they are one act by the director, land on one location, and
 * splitting them means three routes and three controls that will drift.
 *
 * So the entry declares a SET of kinds and the kind is resolved from the bytes.
 * That is not a convenience — a phone hands over `IMG_0431.MOV` for a clip and
 * `.HEIC`-shaped names for stills, and honouring the extension is how a video
 * gets stored as an image and never decodes again.
 *
 * Set-based over the target's OWN declared kinds, so a fourth medium is covered
 * by declaring it rather than by editing this file.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MEDIA_IMPORTS } = require('../lib/media-imports');
const UI = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

const TARGET = 'world-capture';
const spec = () => MEDIA_IMPORTS[TARGET];

test('the capture target is registered and declares every medium a capture arrives as', () => {
    const s = spec();
    assert.ok(s, `${TARGET} is not in MEDIA_IMPORTS — a capture has nowhere to land`);
    assert.ok(Array.isArray(s.kinds) && s.kinds.length >= 3,
        'the entry does not declare a set of kinds, so it can only ever accept one medium');
    for (const k of ['image', 'video', 'model']) {
        assert.ok(s.kinds.includes(k),
            `${k} is not accepted: a ${k === 'image' ? 'panorama' : k === 'video' ? 'orbit clip' : 'scan'} cannot be imported`);
    }
});

test('every declared kind names a subdir that is actually served', () => {
    /*
     * A file written somewhere with no serving route is an upload that succeeds
     * and a world input nobody can fetch.
     *
     * The served set is read from SERVER.JS, not from the registry. Deriving it
     * from the other entries is circular — a target declaring an unserved
     * subdir would make that subdir "served" by its own presence, and the
     * mutation proving this check showed exactly that: renaming a subdir to
     * `captures` passed.
     */
    const backend = path.join(__dirname, '..');
    const sources = [path.join(backend, 'server.js'),
        ...fs.readdirSync(path.join(backend, 'routes')).map((f) => path.join(backend, 'routes', f))]
        .filter((f) => f.endsWith('.js'));
    /*
     * Two serving idioms, both counted. Most domains call serveFile with the
     * subdir; threed.js instead dispatches on the URL segment
     * (`urlParts[1] === '3d' && urlParts[2] && urlParts[3]`). Scanning only the
     * first reported `3d` as unserved, which is wrong and would have pushed the
     * scan back towards reading the registry it is supposed to check.
     */
    const served = new Set();
    for (const f of sources) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/serveFile\(\s*res\s*,\s*[^,]+,\s*'([a-z0-9-]+)'/g)) served.add(m[1]);
        for (const m of src.matchAll(/[Pp]arts\[1\] === '([a-z0-9-]+)'\s*&&\s*\w+\[2\]\s*&&\s*\w+\[3\]/g)) served.add(m[1]);
    }
    assert.ok(served.size >= 5,
        `the served-subdir scan found ${served.size} across server.js and routes/ — it is broken, not the registry`);
    const s = spec();
    for (const k of s.kinds) {
        const dir = (s.subdirByKind && s.subdirByKind[k]) || s.subdir;
        assert.ok(dir, `${k}: the entry declares no subdir`);
        assert.ok(served.has(dir), `${k} would be written to '${dir}', which nothing serves`);
    }
});

test('the asset type and metadata kind come from the registry, not a call-site if-chain', () => {
    const s = spec();
    assert.ok(s.assetType, 'the entry does not declare its asset type, so importMedia must special-case it');
    assert.ok(s.metaKind, 'the entry does not declare its metadata kind');
    /*
     * The chain this replaces picked the asset type with
     * `target === 'storyboard-image' ? … : target === 'previs-image' ? …`.
     * Adding a fourth branch is how a registry becomes decorative, so the
     * derivation has to be real for the ENTRIES THAT ALREADY EXIST too.
     */
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media-imports.js'), 'utf8');
    const chain = /assetType\s*=\s*target ===/.test(src);
    assert.ok(!chain, 'importMedia still chooses the asset type by comparing target ids at the call site');
});

test('the kind is resolved from the bytes, never from the filename', () => {
    const { resolveImportKind } = require('../lib/media-imports');
    assert.strictEqual(typeof resolveImportKind, 'function',
        'nothing resolves a kind from bytes, so a multi-kind target cannot exist');
    const s = spec();
    const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64');
    const MP4 = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'),
        Buffer.from([0, 0, 0, 0]), Buffer.from('isomiso2'),
    ]);
    const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(8)]);

    // A phone names a clip IMG_0431.MOV and a still IMG_0430.HEIC; neither name
    // is consulted, because a video stored as an image never decodes again.
    assert.strictEqual(resolveImportKind(s, PNG, 'clip.mp4'), 'image');
    assert.strictEqual(resolveImportKind(s, MP4, 'photo.png'), 'video');
    assert.strictEqual(resolveImportKind(s, GLB, 'scan.jpg'), 'model');
});

test('bytes that are none of the declared kinds are refused', () => {
    const { resolveImportKind } = require('../lib/media-imports');
    const junk = Buffer.from('this is a text file pretending to be a panorama');
    /*
     * The pattern is the DOMAIN message, not /not a/. That matched
     * "resolveImportKind is not a function" and passed before the resolver
     * existed — the one assertion in this file that was green while nothing
     * was built.
     */
    assert.throws(() => resolveImportKind(spec(), junk, 'pano.png'), /not a recognised/i,
        'a file that is none of the accepted media was accepted');
});

test('a kind the target does not declare is refused even when the bytes are valid', () => {
    /*
     * The resolver must be bounded by the ENTRY, not by what it can recognise.
     * Otherwise every multi-kind target silently accepts every medium, and the
     * declaration stops meaning anything.
     */
    const { resolveImportKind } = require('../lib/media-imports');
    /*
     * A genuinely MULTI-kind spec, narrowed. An earlier version of this used
     * `kinds: ['image']`, which is a single-kind spec — and single-kind entries
     * deliberately defer to validateBytes, which knows about audio. Sniffing
     * them here would break every audio upload, because `ftyp` is the container
     * marker for M4A as well as MP4.
     */
    const imageOnly = { ...spec(), kinds: ['image', 'model'] };
    const MP4 = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'),
        Buffer.from([0, 0, 0, 0]), Buffer.from('isomiso2'),
    ]);
    assert.throws(() => resolveImportKind(imageOnly, MP4, 'x.mp4'), /not accepted|does not accept/i);
});

test('single-kind entries are unchanged by the multi-kind machinery', () => {
    /*
     * Seventeen entries predate this. If declaring `kinds` were required, every
     * one of them would have to be edited, and the ones nobody remembered would
     * break at run time rather than here.
     */
    const { resolveImportKind } = require('../lib/media-imports');
    const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64');
    for (const [id, s] of Object.entries(MEDIA_IMPORTS)) {
        if (s.kinds) continue;
        assert.strictEqual(resolveImportKind(s, PNG, 'x'), s.kind,
            `${id}: a single-kind entry no longer resolves to its own kind`);
    }
});

test('the capture has a way in from the page', () => {
    assert.match(UI, new RegExp(`data-import-target=["']${TARGET}["']`),
        'no file control targets the capture import, so it is reachable only by curl');
});
