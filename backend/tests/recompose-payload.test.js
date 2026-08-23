/**
 * What the provider actually receives, in order.
 *
 * Everything else about recompose is a source scan. This is the acceptance
 * contract: the FIRST reference must be the chosen version's bytes and the
 * SECOND must be the chosen background plate's bytes, in that order — because
 * roles are POSITIONAL. Only Runway preserves `@tags`; Meshy and Gridlight
 * flatten the array and OpenAI's edit input has no tag syntax, and this project
 * runs Meshy. Get the order wrong and the model keeps the street and replaces
 * the actor, which is a plausible picture and completely wrong.
 *
 * A capturing adapter is registered and made the project's image provider, so
 * the assertion is on the real payload the real route built — not on the text
 * of the function that builds it.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-recompose-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const providers = require('../lib/providers');
const { handleStoryboard } = require('../routes/storyboard');

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

/** Records the payload it is handed, and returns a frame. */
const CAPTURED = [];
providers.register({
    id: 'capture',
    label: 'Capture (test)',
    capabilities: ['image'],
    supportsReferenceImages: true,
    supportsReferenceTags: false,
    maxReferenceImages: 5,
    promptLimit: 4000,
    supports(cap) { return cap === 'image'; },
    async generate(capability, payload) {
        CAPTURED.push(payload);
        return { ok: true, data: PNG, model: 'capture-1' };
    },
});

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const [p, qs] = urlPath.split('?');
        const parts = p.split('/').filter(Boolean);
        const query = {};
        for (const kv of (qs || '').split('&').filter(Boolean)) {
            const [k, v] = kv.split('=');
            query[decodeURIComponent(k)] = decodeURIComponent(v || '');
        }
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (c) { this.statusCode = c; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let out = Buffer.concat(chunks).toString();
            try { out = JSON.parse(out); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: out });
        });
        Promise.resolve(handleStoryboard({ method, body: body || {} }, res, parts, query))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

/** A shot with two kept versions, and a location with two views. */
function scene(opts = {}) {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId(), locId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)")
        .run(projectId, 'Recompose', JSON.stringify({ image: 'capture' }));
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '2', 'STREET')")
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)')
        .run(locId, projectId, 'STREET');
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms)
                VALUES (?, ?, '2AA', ?, 4000)`)
        .run(shotId, sceneId, JSON.stringify({ shot_code: '2AA', description: 'close on her' }));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
    const bytes = tag => Buffer.concat([PNG, Buffer.from(tag)]);

    /*
     * v1 and v2 archived, in the REAL layout:
     * {FILM_DATA_DIR}/storyboards/{project}/versions/2AA_v{n}.png
     *
     * The first fixture wrote them to a temp directory, so it never exercised
     * the path shape the serving URL is derived from — and the derivation bug
     * for archived frames sailed straight through it.
     */
    const versionsDir = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId, 'versions');
    fs.mkdirSync(versionsDir, { recursive: true });
    const versions = {};
    for (const v of [1, 2]) {
        const f = path.join(versionsDir, `2AA_v${v}.png`);
        fs.writeFileSync(f, bytes(`frame${v}`));
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                    VALUES (?, ?, ?, 'storyboard', ?, ?, ?)`)
            .run(generateId(), projectId, shotId, `2AA_v${v}.png`, f, v);
        versions[v] = f;
    }

    // v3 is the LIVE frame: its row names {code}.png, which is the state a
    // freshly generated frame is in until something archives it.
    const storyDir = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId);
    fs.mkdirSync(storyDir, { recursive: true });
    const live = path.join(storyDir, '2AA.png');
    fs.writeFileSync(live, bytes('frame3-live'));
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                VALUES (?, ?, ?, 'storyboard', '2AA.png', ?, 3)`)
        .run(generateId(), projectId, shotId, live);

    // Two views of the location.
    const plates = {};
    for (const [name, view] of [['default.png', null], ['reverse.png', 'from the far kerb']]) {
        const f = path.join(dir, name);
        fs.writeFileSync(f, bytes(view || 'default-plate'));
        const id = generateId();
        db.prepare(`INSERT INTO film_assets (id, project_id, location_id, asset_type, file_name, file_path, version, metadata)
                    VALUES (?, ?, ?, 'reference_image', ?, ?, 1, ?)`)
            .run(id, projectId, locId, name, f, JSON.stringify(view ? { view } : {}));
        plates[view || 'default'] = { id, file: f };
    }
    return { projectId, sceneId, shotId, locId, versions, live, plates };
}

test('the provider receives exactly [chosen version, chosen background] in order', async () => {
    CAPTURED.length = 0;
    const s = scene();
    const r = await call('POST', `/film/shots/${s.shotId}/storyboard/recompose`, {
        from_version: 2,
        background_asset_id: s.plates['from the far kerb'].id,
    });
    assert.ok(r.status < 400, JSON.stringify(r.body));
    assert.strictEqual(CAPTURED.length, 1, 'the provider was not called exactly once');

    const refs = CAPTURED[0].reference_images || [];
    assert.strictEqual(refs.length, 2,
        `expected exactly two references, got ${refs.length} — a third competes for the roles`);

    const uriOf = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
    assert.strictEqual(refs[0].uri, uriOf(s.versions[2]),
        'the FIRST reference is not the chosen version — the performance would come from the wrong picture');
    assert.strictEqual(refs[1].uri, uriOf(s.plates['from the far kerb'].file),
        'the SECOND reference is not the chosen background');

    // Order is the contract, so the reverse must NOT hold.
    assert.notStrictEqual(refs[0].uri, refs[1].uri, 'both references are the same picture');
});

test('a plate from another location is refused', async () => {
    CAPTURED.length = 0;
    const a = scene();
    const b = scene();
    const r = await call('POST', `/film/shots/${a.shotId}/storyboard/recompose`, {
        from_version: 2,
        background_asset_id: b.plates['from the far kerb'].id,
    });
    assert.ok(r.status >= 400, 'a plate from a different location was accepted');
    assert.strictEqual(CAPTURED.length, 0, 'money was spent before the plate was validated');
});

test('the newest version resolves even when its row names the live frame', async () => {
    /*
     * A freshly generated frame lives only at {code}.png until something
     * archives it. Naming that version by number was refused while OMITTING the
     * version used the same picture and succeeded — the same picture giving two
     * answers depending on how it was named. Four shots on the live project
     * were in that state.
     */
    CAPTURED.length = 0;
    const s = scene();
    const byNumber = await call('POST', `/film/shots/${s.shotId}/storyboard/recompose`, {
        from_version: 3, background_asset_id: s.plates['from the far kerb'].id,
    });
    assert.ok(byNumber.status < 400,
        `naming the current version was refused: ${JSON.stringify(byNumber.body)}`);
    const named = CAPTURED[CAPTURED.length - 1].reference_images[0].uri;

    CAPTURED.length = 0;
    const s2 = scene();
    await call('POST', `/film/shots/${s2.shotId}/storyboard/recompose`, {
        background_asset_id: s2.plates['from the far kerb'].id,
    });
    const omitted = CAPTURED[CAPTURED.length - 1].reference_images[0].uri;
    assert.strictEqual(named, omitted,
        'naming the current version and omitting it send different pictures');
});

test('an overwritten older version is still refused', async () => {
    // A NON-current row naming the live file is a genuinely lost attempt: the
    // file there is some later frame. Accepting it would silently send the
    // wrong performance.
    CAPTURED.length = 0;
    const s = scene();
    db.prepare("UPDATE film_assets SET file_path = ? WHERE shot_id = ? AND version = 1")
        .run(s.live, s.shotId);
    const r = await call('POST', `/film/shots/${s.shotId}/storyboard/recompose`, {
        from_version: 1, background_asset_id: s.plates['from the far kerb'].id,
    });
    assert.ok(r.status >= 400, 'an overwritten version was accepted as a source');
    assert.strictEqual(CAPTURED.length, 0, 'money was spent on a lost attempt');
});

test('the recomposed frame records its true sources and is deliberately unstamped', async () => {
    /*
     * A recomposed frame was not generated from the card's image payload, so
     * hashing that payload would describe inputs it never had. It is left
     * UNSTAMPED — which this codebase already reads as "outside the workflow"
     * rather than stale — and the real provenance is recorded instead.
     */
    CAPTURED.length = 0;
    const s = scene();
    const r = await call('POST', `/film/shots/${s.shotId}/storyboard/recompose`, {
        from_version: 2, background_asset_id: s.plates['from the far kerb'].id,
    });
    assert.ok(r.status < 400, JSON.stringify(r.body));

    const row = db.prepare(
        `SELECT metadata, input_refs, input_fingerprint FROM film_assets
          WHERE shot_id = ? AND asset_type = 'storyboard' ORDER BY version DESC LIMIT 1`).get(s.shotId);
    const meta = JSON.parse(row.metadata || '{}');
    assert.ok(meta.recomposed_from, 'the frame does not record which version it kept');
    assert.ok(meta.recomposed_background, 'the frame does not record which background it took');

    const refs = JSON.parse(row.input_refs || 'null');
    assert.ok(refs, 'input_refs is empty, so the true provenance was never recorded');
    assert.ok(JSON.stringify(refs).includes(s.plates['from the far kerb'].id),
        'input_refs does not name the background asset');
    assert.ok(!JSON.stringify(refs).includes('data:image'),
        'input_refs carries data URIs — provenance must be identifiers, not megabytes of base64');

    assert.ok(!row.input_fingerprint,
        'the frame was fingerprinted against the card payload it was never generated from');
});

test('the preview links a source URL that actually serves', async () => {
    /*
     * The first version derived the serving subdir positionally: two hops up
     * from the file. That is right for a plate at `…/refsheets/<project>/x.png`
     * and WRONG for an archived frame at `…/storyboards/<project>/versions/x.png`,
     * which is three — so it returned the project id as the directory and built
     * `/film/<project>/<project>/x.png`.
     *
     * The behavioural payload test could not catch it, because it proves the
     * BYTES that reach the provider and says nothing about the thumbnail a
     * director looks at. Asserting non-null would not have caught it either:
     * the broken URL was a perfectly good string.
     */
    const s = scene();
    const q = `from_version=2&background_asset_id=${s.plates['from the far kerb'].id}`;
    const r = await call('GET', `/film/shots/${s.shotId}/storyboard/recompose-preview?${q}`);
    assert.ok(r.status < 400, JSON.stringify(r.body));

    const src = r.body.keeping.image_url;
    assert.ok(src, 'the preview does not link the source frame at all');
    assert.match(src, new RegExp(`^/film/storyboards/${s.projectId}/`),
        `the source URL is not the storyboard serving shape: ${src}`);
    assert.ok(!src.includes(`${s.projectId}/${s.projectId}`),
        `the URL repeats the project id, which is the positional-derivation bug: ${src}`);

    const bg = r.body.background.image_url;
    assert.ok(bg, 'the preview does not link the background');
    assert.ok(!bg.includes(`${s.projectId}/${s.projectId}`),
        `the background URL repeats the project id: ${bg}`);

    // The serving route resolves it: it looks in the project root AND versions/.
    const { handleStoryboard: h } = require('../routes/storyboard');
    const parts = src.split('?')[0].split('/').filter(Boolean);
    const served = await new Promise(resolve => {
        const chunks = [];
        const res = new (require('stream').Writable)({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (c) { this.statusCode = c; return this; };
        res.setHeader = function () {};
        res.on('finish', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks).length }));
        Promise.resolve(h({ method: 'GET', body: {} }, res, parts, {}))
            .catch(() => resolve({ status: 500, bytes: 0 }));
    });
    assert.strictEqual(served.status, 200,
        `the source URL the confirmation renders returns ${served.status} — a broken thumbnail in the `
        + 'one dialog whose job is showing the director what they are buying');
    assert.ok(served.bytes > 0, 'the source URL served no bytes');
});
