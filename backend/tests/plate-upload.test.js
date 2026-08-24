/**
 * Anywhere a reference image can be GENERATED, one can be uploaded.
 *
 * "Everywhere I can generate plates or boards, I should be able to upload one
 * too, say I'm working outside of film engine."
 *
 * A director who shot the location on a phone, or built a character in
 * Midjourney, or was handed key art by an art department, had no way in. Every
 * reference in this pipeline could only be born inside it — which is a strange
 * constraint for a tool whose whole job is to keep a film consistent with
 * itself, since the most authoritative picture of a place is usually a
 * photograph of it.
 *
 * The set is DERIVED from lib/reference-images.js KIND_SOURCE, the registry of
 * what can be a reference at all. Three of its five kinds already had an import
 * (the storyboard frame, the previs image, the GLB); none of the reference
 * kinds did. Deriving it here is what makes a sixth kind fail this test rather
 * than arrive silently generate-only.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-upload-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..');
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { KIND_SOURCE } = require('../lib/reference-images');

/** A real 1×1 PNG and a real 1×1 JPEG, so the validators are exercised. */
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
const JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64');

const uri = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;

/** Run a route handler the way the HTTP server does, and read its answer. */
function call(handler, method, url, body) {
    return new Promise(resolve => {
        const out = [];
        const res = {
            writeHead(status) { this.statusCode = status; return this; },
            end(payload) {
                out.push(payload || '');
                resolve({ status: this.statusCode || 200, body: JSON.parse(out.join('') || '{}') });
            },
        };
        const parts = url.split('?')[0].split('/').filter(Boolean);
        handler({ method, url, body: body || {} }, res, parts);
    });
}

function fixture() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Upload');
    const ids = { projectId };
    ids.character = generateId();
    db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)')
        .run(ids.character, projectId, 'MAYA');
    ids.location = generateId();
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)')
        .run(ids.location, projectId, 'STREET');
    ids.prop = generateId();
    db.prepare('INSERT INTO film_props (id, project_id, name) VALUES (?, ?, ?)')
        .run(ids.prop, projectId, 'SEDAN');
    return ids;
}

/**
 * Every kind of reference, and how a picture gets into it from outside.
 *
 * `anchor` is the storyboard frame and already had an import; it is here so
 * that the denominator is the whole registry rather than the part that was
 * missing, which is what makes the count meaningful.
 */
const IMPORTS = {
    character: { target: 'character-plate', handler: 'characters', url: i => `/film/characters/${i.character}/refsheet/import`, extra: { view: 'front' } },
    location: { target: 'location-plate', handler: 'locations', url: i => `/film/locations/${i.location}/plate/import`, extra: {} },
    prop: { target: 'prop-plate', handler: 'locations', url: i => `/film/props/${i.prop}/plate/import`, extra: {} },
    style: { target: 'mood-board-image', handler: 'moodBoard', url: i => `/film/projects/${i.projectId}/mood-board/import`, extra: {} },
    anchor: { target: 'storyboard-image', handler: null, url: null, extra: {} },
};

const HANDLERS = () => ({
    characters: require('../routes/characters').handleCharacters,
    locations: require('../routes/locations').handleLocations,
    moodBoard: require('../routes/mood-board').handleMoodBoard,
});

// ── 1. Nothing in the registry is generate-only ─────────────────────────

test('every kind of reference can be uploaded, not only generated', () => {
    const { MEDIA_IMPORTS } = require('../lib/media-imports');
    const kinds = Object.keys(KIND_SOURCE);
    assert.ok(kinds.length >= 5, `the reference kind registry collapsed (${kinds.length})`);

    const missing = [];
    for (const kind of kinds) {
        const spec = IMPORTS[kind];
        // A kind this test does not know about is a gap in the TEST, and must
        // fail loudly rather than be skipped into a false pass.
        assert.ok(spec, `${kind} is a reference kind with no import declared in this test — `
            + 'add it here and build the route, or it ships generate-only');
        if (!MEDIA_IMPORTS[spec.target]) missing.push(`${kind} (${spec.target})`);
    }
    assert.deepStrictEqual(missing, [],
        `these can be generated and not uploaded: ${missing.join(', ')}`);
});

// ── 2. Both formats a person actually has ───────────────────────────────

test('a JPEG is accepted, or the target states why it cannot be', () => {
    const { validateBytes, MEDIA_IMPORTS, decodeDataUri } = require('../lib/media-imports');
    for (const kind of Object.keys(KIND_SOURCE)) {
        const spec = MEDIA_IMPORTS[IMPORTS[kind].target];
        if (!spec || spec.kind !== 'image') continue;
        /*
         * A target may be PNG-only, but it has to SAY SO with a reason — the
         * same rule the decision contract applies to a single-surface decision.
         * Without it, "we never got round to JPEG here" and "JPEG is impossible
         * here" are indistinguishable, and the gap gets re-labelled a design
         * decision the moment closing it turns out to be work.
         */
        if (spec.pngOnly) {
            assert.ok(typeof spec.pngOnly === 'string' && spec.pngOnly.length > 20,
                `${IMPORTS[kind].target} is PNG-only with no stated reason`);
            assert.deepStrictEqual(spec.mimes, ['image/png'],
                `${IMPORTS[kind].target} claims PNG-only and accepts more`);
            continue;
        }
        for (const [name, buf, mime] of [['png', PNG, 'image/png'], ['jpeg', JPEG, 'image/jpeg']]) {
            const decoded = decodeDataUri(uri(buf, mime));
            assert.doesNotThrow(() => validateBytes(spec, decoded.mime, decoded.bytes),
                `${IMPORTS[kind].target} refuses a ${name} — "working outside Film Engine" means `
                + 'Midjourney exports and phone photographs, which are JPEG');
        }
        // Still a real check, not an open door.
        assert.throws(() => validateBytes(spec, 'image/png', Buffer.from('not an image')),
            `${IMPORTS[kind].target} accepts arbitrary bytes as an image`);
    }
});

// ── 3. An upload is indistinguishable in USE ────────────────────────────

test('an uploaded plate is selected exactly as a generated one would be', async () => {
    const { gatherShotReferences } = require('../lib/shot-references');
    const ids = fixture();
    const handlers = HANDLERS();

    for (const kind of ['character', 'location', 'prop']) {
        const spec = IMPORTS[kind];
        const res = await call(handlers[spec.handler], 'POST', spec.url(ids),
            { data: uri(PNG, 'image/png'), name: `${kind}.png`, ...spec.extra });
        assert.strictEqual(res.status, 201,
            `${kind} upload returned ${res.status}: ${JSON.stringify(res.body)}`);
        assert.ok(res.body.asset_id, `${kind}: upload registered no asset`);
        assert.ok(fs.existsSync(res.body.file_path || ''), `${kind}: no file on disk`);
        // The name must not lie about the bytes.
        assert.ok(/\.png$/i.test(res.body.file_name), `${kind}: a PNG was not stored as .png`);
    }

    /*
     * The real test: does the gatherer attach it? A plate that lists and never
     * reaches a payload is a picture in a folder. This runs the actual selector
     * rather than asserting the row shape, because the row shape is the thing
     * that would be wrong.
     */
    const gathered = gatherShotReferences(ids.projectId,
        [{ id: ids.character, name: 'MAYA' }],
        { id: ids.location, name: 'STREET' },
        ['SEDAN'], null, {});
    for (const kind of ['character', 'location', 'prop']) {
        assert.ok(gathered.some(c => c.kind === kind),
            `an uploaded ${kind} plate is not gathered — it lists and never reaches a prompt`);
    }
});

// ── 4. An upload is not stale the moment a description is edited ────────

test('an uploaded plate is not fingerprinted as though it were generated', async () => {
    const ids = fixture();
    const handlers = HANDLERS();
    const res = await call(handlers.locations, 'POST', IMPORTS.location.url(ids),
        { data: uri(PNG, 'image/png'), name: 'street.png' });
    assert.strictEqual(res.status, 201);

    const row = db.prepare('SELECT input_fingerprint, metadata FROM film_assets WHERE id = ?')
        .get(res.body.asset_id);
    /*
     * A fingerprint says "this was generated from that payload". An uploaded
     * plate was not generated from anything, so stamping it would mark it stale
     * the moment someone edits the location description — asking the director
     * to regenerate over their own photograph. NULL means "outside the
     * workflow", which is exactly what this is.
     */
    assert.strictEqual(row.input_fingerprint, null,
        'an uploaded plate is fingerprinted, so editing the description will tell the director to '
        + 'regenerate over the picture they supplied');
    assert.ok(/"imported":\s*true/.test(row.metadata || ''),
        'nothing records that this plate came from outside, so it looks generated forever');
});

// ── 5. Replacement is scoped to the same view ───────────────────────────

test('uploading a view replaces that view and leaves the others alone', async () => {
    const ids = fixture();
    const handlers = HANDLERS();
    const post = (view, name) => call(handlers.locations, 'POST', IMPORTS.location.url(ids),
        { data: uri(PNG, 'image/png'), name, ...(view ? { view } : {}) });

    await post('', 'default.png');
    await post('south', 'south.png');
    const count = () => db.prepare(
        "SELECT COUNT(*) c FROM film_assets WHERE location_id = ? AND asset_type = 'reference_image'")
        .get(ids.location).c;
    assert.strictEqual(count(), 2, 'a second view overwrote the first');

    await post('south', 'south-again.png');
    assert.strictEqual(count(), 2,
        're-uploading a view either duplicated it or destroyed the other view');

    /*
     * And across formats. plateFileName always ends .png, so an uploaded JPEG
     * would land BESIDE the PNG of the same view rather than replacing it, and
     * the gather would pick whichever row came back first — a subject with two
     * current plates and no way to tell which one a shot used.
     */
    const jpegPost = await call(handlers.locations, 'POST', IMPORTS.location.url(ids),
        { data: uri(JPEG, 'image/jpeg'), name: 'south.jpg', view: 'south' });
    assert.strictEqual(jpegPost.status, 201, JSON.stringify(jpegPost.body));
    assert.ok(/\.jpe?g$/i.test(jpegPost.body.file_name),
        `a JPEG was stored as ${jpegPost.body.file_name} — the name lies about the bytes`);
    assert.strictEqual(count(), 2,
        'a JPEG upload landed beside the PNG of the same view instead of replacing it');
});

// ── 6. Every generate control has an upload beside it ───────────────────

test('the page offers an upload wherever it offers a generate', () => {
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');

    /*
     * The control is BUILT, not written out, so the literal
     * `data-import-target="character-plate"` appears nowhere in the source —
     * a grep would report a working page as broken. Same trap the blocking
     * panels documented: run the builder and read what it produces.
     */
    const src = html.slice(html.indexOf('function uploadControl('));
    const body = src.slice(0, src.indexOf('\n    /**', 1));
    assert.ok(/function uploadControl\(/.test(body), 'nothing builds an upload control at all');
    // eslint-disable-next-line no-new-func
    const uploadControl = new Function('esc', `${body}; return uploadControl;`)(x => String(x));

    for (const kind of Object.keys(KIND_SOURCE)) {
        const target = IMPORTS[kind].target;
        const built = uploadControl(target, '/x', {});
        assert.ok(built.includes(`data-import-target="${target}"`),
            `the builder cannot produce a control for ${target}`);

        // And it has to be CALLED somewhere, with something clickable. A
        // builder nothing invokes looks identical to a working page.
        const invoked = new RegExp(`uploadControl\\(\\s*'${target}'`).test(html)
            || html.includes(`data-import-target="${target}"`);
        assert.ok(invoked,
            `no upload control anywhere on the page for ${kind} (${target}) — the route exists and `
            + 'nothing can reach it, which is indistinguishable from it not existing');

        // Both formats a person actually has, offered by the file picker
        // itself, or they cannot even select the file.
        assert.ok(/accept="[^"]*image\/jpeg/.test(built) || MEDIA_PNG_ONLY.has(target),
            `${target}: the picker will not let a JPEG be selected`);
    }

    // The upload must SAY something on failure, where the control is. The GLB
    // importer already paid for this: a refusal one line high at the bottom of
    // the screen is indistinguishable from nothing having happened.
    const runner = html.slice(html.indexOf('async function uploadReferenceImage('));
    assert.ok(/catch\s*\(\s*err\s*\)/.test(runner.slice(0, 2500))
        && /was not uploaded/.test(runner.slice(0, 2500)),
        'an upload that fails says nothing the person can see');
});

const MEDIA_PNG_ONLY = new Set(
    Object.entries(require('../lib/media-imports').MEDIA_IMPORTS)
        .filter(([, spec]) => spec.pngOnly).map(([name]) => name));
