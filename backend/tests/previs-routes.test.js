/**
 * Phase 2 — the previs API and the viewer's structural guarantees.
 *
 * Exit criterion: a shot can be blocked, saved, reloaded and played back in the
 * SPA with no new build step, and index.html is still deployable as a single file.
 *
 * Two halves, and the second is the one that is easy to skip. The routes are
 * checked by calling them; the VIEWER is checked structurally, because the
 * things that would silently break it are not visible in a screenshot:
 * an external <script src> reintroduces a build step, and a hardcoded palette
 * lets the UI offer a movement the server would refuse. Phase 6 of the flows
 * work shipped a route that was declared and never dispatched, so every route
 * here is proven reachable rather than assumed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-previs-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handlePrevis } = require('../routes/previs');
const { VALID_SHOT_TYPES, VALID_CAMERA_MOVES } = require('../lib/scene-card-schema');
const { RIGS, MOVEMENTS, SHOT_TYPES } = require('../lib/previs-blocking');
const { SENSORS } = require('../lib/previs-camera');

const REPO_ROOT = path.join(__dirname, '..', '..');
const INDEX_HTML = path.join(REPO_ROOT, 'src', 'index.html');
const TAXONOMY = path.join(REPO_ROOT, 'docs', 'plans', 'previs-camera-taxonomy.json');

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeShot() {
    const projectId = generateId();
    const sceneId = generateId();
    const shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Previs Test');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, ?)').run(shotId, sceneId, 'SH01');
    return { projectId, sceneId, shotId };
}

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const req = { method, body: body || {} };

        // A real Writable, not an object with an end(). Routes that serve a
        // file stream it with pipe(), which needs a stream — a hand-rolled
        // stub throws "dest.on is not a function" and reads as a broken route.
        const { Writable } = require('stream');
        const chunks = [];
        const res = new Writable({
            write(chunk, _enc, next) { chunks.push(chunk); next(); },
        });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            const raw = Buffer.concat(chunks).toString();
            let parsed = raw;
            try { parsed = JSON.parse(raw); } catch (_) { /* binary or plain */ }
            resolve({ status: res.statusCode, body: parsed, bytes: Buffer.concat(chunks).length });
        });

        Promise.resolve(handlePrevis(req, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

const blockingFixture = () => ({
    camera: { position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50, sensorId: 'super35', fStop: 2.8, focusDistanceM: 3 },
    subject: { position: [0, 0, 0], heightM: 1.7 },
    stage: { widthM: 12, depthM: 12 },
    rig: 'dolly',
    movement: 'dolly-in',
});

// ── Migration ───────────────────────────────────────────────────────────────

test('the blocking table exists with the columns the routes write', () => {
    const columns = db.prepare('PRAGMA table_info(film_previs_blocking)').all().map(c => c.name);
    assert.ok(columns.length, 'migration 058 did not run');
    for (const required of ['id', 'shot_id', 'camera_json', 'subject_json', 'stage_json', 'rig', 'path_json']) {
        assert.ok(columns.includes(required), `film_previs_blocking is missing ${required}`);
    }
});

test('a shot can hold at most one blocking', () => {
    // UNIQUE(shot_id) is the decision that keeps "load this shot's blocking"
    // from becoming a "which one?" question.
    const indexes = db.prepare("PRAGMA index_list('film_previs_blocking')").all();
    const unique = indexes.filter(i => i.unique).flatMap(i =>
        db.prepare(`PRAGMA index_info('${i.name}')`).all().map(c => c.name));
    assert.ok(unique.includes('shot_id'), 'shot_id is not unique — a shot could hold two blockings');
});

// ── Routes ──────────────────────────────────────────────────────────────────

test('every phase-2 route dispatches rather than falling through', async () => {
    const { shotId } = makeShot();
    const routes = [
        ['GET', `/film/shots/${shotId}/previs`],
        ['PUT', `/film/shots/${shotId}/previs`],
        ['POST', `/film/shots/${shotId}/previs/solve`],
        ['GET', '/film/previs/taxonomy'],
        ['DELETE', `/film/shots/${shotId}/previs`],
    ];
    const unrouted = [];
    for (const [method, url] of routes) {
        const res = await call(method, url, method === 'PUT' ? blockingFixture() : { shot_type: 'close-up' });
        if (res.status === 404 && res.body && res.body.error === 'Not found') unrouted.push(`${method} ${url}`);
        if (res.status === 405) unrouted.push(`${method} ${url} (405)`);
    }
    assert.deepStrictEqual(unrouted, [], `routes declared but not dispatched: ${unrouted.join(', ')}`);
});

test('blocking survives a round trip through SQLite unchanged', async () => {
    const { shotId } = makeShot();
    const sent = blockingFixture();

    const saved = await call('PUT', `/film/shots/${shotId}/previs`, sent);
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));

    const read = await call('GET', `/film/shots/${shotId}/previs`);
    assert.strictEqual(read.status, 200);
    assert.deepStrictEqual(read.body.blocking.camera, sent.camera);
    assert.deepStrictEqual(read.body.blocking.subject, sent.subject);
    assert.deepStrictEqual(read.body.blocking.stage, sent.stage);
    assert.strictEqual(read.body.blocking.rig, sent.rig);
});

test('saving blocking stores the sampled path, not just the movement name', async () => {
    // Same reasoning as film_flow_runs.graph_snapshot: a path recomputed from an
    // enum silently changes meaning when that enum's defaults are retuned.
    const { shotId } = makeShot();
    await call('PUT', `/film/shots/${shotId}/previs`, blockingFixture());
    const read = await call('GET', `/film/shots/${shotId}/previs`);

    const path_ = read.body.blocking.path;
    assert.ok(Array.isArray(path_) && path_.length >= 2, 'no sampled path was stored');
    assert.deepStrictEqual(path_[0].position, [0, 1.6, 3]);
    assert.notDeepStrictEqual(path_[path_.length - 1].position, path_[0].position, 'the stored path does not move');
});

test('re-saving replaces rather than accumulating', async () => {
    const { shotId } = makeShot();
    await call('PUT', `/film/shots/${shotId}/previs`, blockingFixture());
    await call('PUT', `/film/shots/${shotId}/previs`, { ...blockingFixture(), rig: 'steadicam' });

    const rows = db.prepare('SELECT COUNT(*) n FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    assert.strictEqual(rows.n, 1);
    const read = await call('GET', `/film/shots/${shotId}/previs`);
    assert.strictEqual(read.body.blocking.rig, 'steadicam');
});

test('an unblocked shot reports that plainly instead of erroring', async () => {
    const { shotId } = makeShot();
    const read = await call('GET', `/film/shots/${shotId}/previs`);
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.body.blocking, null);
});

test('delete removes the blocking and is safe to repeat', async () => {
    const { shotId } = makeShot();
    await call('PUT', `/film/shots/${shotId}/previs`, blockingFixture());
    assert.strictEqual((await call('DELETE', `/film/shots/${shotId}/previs`)).status, 200);
    assert.strictEqual((await call('GET', `/film/shots/${shotId}/previs`)).body.blocking, null);
    assert.strictEqual((await call('DELETE', `/film/shots/${shotId}/previs`)).status, 200);
});

test('a shot that does not exist is refused, not silently created', async () => {
    const res = await call('PUT', `/film/shots/${generateId()}/previs`, blockingFixture());
    assert.strictEqual(res.status, 404);
});

test('invalid blocking is rejected with a reason', async () => {
    const { shotId } = makeShot();
    const cases = [
        [{ ...blockingFixture(), rig: 'hovercraft' }, /rig/i],
        [{ ...blockingFixture(), movement: 'barrel-roll' }, /movement/i],
        [{ ...blockingFixture(), camera: { ...blockingFixture().camera, sensorId: 'imaginary' } }, /sensor/i],
        [{ ...blockingFixture(), camera: { ...blockingFixture().camera, focalMm: 0 } }, /focal/i],
    ];
    for (const [body, pattern] of cases) {
        const res = await call('PUT', `/film/shots/${shotId}/previs`, body);
        assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(body).slice(0, 60)}`);
        assert.ok(pattern.test(JSON.stringify(res.body)), `unhelpful error: ${JSON.stringify(res.body)}`);
    }
});

test('a rig that cannot perform the move warns but still saves', async () => {
    // Telling a director the slider cannot do their crane move is useful.
    // Refusing to save it is not — previs is for thinking, not for enforcement.
    const { shotId } = makeShot();
    const res = await call('PUT', `/film/shots/${shotId}/previs`,
        { ...blockingFixture(), rig: 'slider', movement: 'crane-up' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.warnings && res.body.warnings.length, 'no warning for an impossible rig/move pair');
    assert.ok(/slider/i.test(JSON.stringify(res.body.warnings)));
});

// ── Solve ───────────────────────────────────────────────────────────────────

test('solve answers for every shot type the schema allows', async () => {
    const { shotId } = makeShot();
    const failures = [];
    for (const shotType of VALID_SHOT_TYPES) {
        const res = await call('POST', `/film/shots/${shotId}/previs/solve`, { shot_type: shotType, focal_mm: 50 });
        if (res.status !== 200) { failures.push(`${shotType}: ${res.status}`); continue; }
        const s = res.body.solution;
        if (!s || !Array.isArray(s.position) || !(s.distanceM > 0)) failures.push(`${shotType}: no usable solution`);
    }
    assert.deepStrictEqual(failures, [], failures.join('; '));
});

test('solve reports the depth of field the chosen stop actually gives', async () => {
    const { shotId } = makeShot();
    const res = await call('POST', `/film/shots/${shotId}/previs/solve`,
        { shot_type: 'close-up', focal_mm: 85, sensor_id: 'super35', f_stop: 2.8 });
    const dof = res.body.depthOfField;
    assert.ok(dof && dof.nearM < res.body.solution.distanceM && dof.farM > res.body.solution.distanceM,
        `focus distance outside its own depth of field: ${JSON.stringify(dof)}`);
    assert.ok(res.body.fieldOfView.hDeg > 0);
});

// ── Taxonomy endpoint ───────────────────────────────────────────────────────

test('the taxonomy endpoint serves the whole runtime vocabulary', async () => {
    // Served from the registries so the viewer cannot offer a movement, rig or
    // sensor the server would refuse — the same guarantee /flows/node-types gives.
    const res = await call('GET', '/film/previs/taxonomy');
    assert.strictEqual(res.status, 200);

    assert.deepStrictEqual(Object.keys(res.body.movements).sort(), VALID_CAMERA_MOVES.slice().sort());
    assert.deepStrictEqual(Object.keys(res.body.shotTypes).sort(), VALID_SHOT_TYPES.slice().sort());
    assert.deepStrictEqual(Object.keys(res.body.rigs).sort(), Object.keys(RIGS).sort());
    assert.deepStrictEqual(Object.keys(res.body.sensors).sort(), Object.keys(SENSORS).sort());
    assert.ok(Array.isArray(res.body.lensKit) && res.body.lensKit.length >= 10);
    assert.ok(Array.isArray(res.body.apertures) && res.body.apertures.length >= 5);
});

// ── The viewer's structural guarantees ──────────────────────────────────────

test('index.html is still a single deployable file with no build step', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const external = [...html.matchAll(/<(?:script[^>]*\bsrc|link[^>]*\bhref)\s*=\s*["']([^"']+)["']/gi)]
        .map(m => m[1])
        .filter(url => /^(https?:)?\/\//i.test(url));
    assert.deepStrictEqual(external, [],
        `external assets reintroduce a build/network dependency: ${external.join(', ')}`);
    assert.ok(!/\bimport\s+.*\bfrom\s+['"]/.test(html), 'ES module imports require a bundler');
});



test('the plan records phase 2 as built', () => {
    const t = JSON.parse(fs.readFileSync(TAXONOMY, 'utf8'));
    const phase2 = t.plan.modules.filter(m => m.phase === 2);
    const unbuilt = phase2.filter(m => m.status === 'new');
    assert.deepStrictEqual(unbuilt.map(m => m.path), [], 'phase 2 modules still marked unwritten');
});

// ── Handlers the markup promises actually exist ─────────────────────────────



test('the framing subject can stand somewhere other than the origin', async () => {
    // The pink box is the subject the camera is solved against, and it was
    // pinned at [0,0,0] by the client while the API happily stored anything.
    // Asserted here so a future client change cannot quietly re-pin it.
    const { shotId } = makeShot();
    const moved = { ...blockingFixture(), subject: { position: [2.5, 0, -1.25], heightM: 1.82 } };

    const saved = await call('PUT', `/film/shots/${shotId}/previs`, moved);
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));

    const read = await call('GET', `/film/shots/${shotId}/previs`);
    assert.deepStrictEqual(read.body.blocking.subject.position, [2.5, 0, -1.25]);
    assert.strictEqual(read.body.blocking.subject.heightM, 1.82);
});

test('a move sampled around a relocated subject orbits that subject', async () => {
    // Orbit is defined in subject space, so a subject stuck at the origin makes
    // every orbit wrong the moment the subject is somewhere else.
    const { shotId } = makeShot();
    await call('PUT', `/film/shots/${shotId}/previs`, {
        ...blockingFixture(),
        subject: { position: [3, 0, 0], heightM: 1.7 },
        movement: 'orbit', rig: 'crane',
    });
    const read = await call('GET', `/film/shots/${shotId}/previs`);
    const path_ = read.body.blocking.path;

    const radii = path_.map(k => Math.hypot(k.position[0] - 3, k.position[2] - 0));
    for (const r of radii) {
        assert.ok(Math.abs(r - radii[0]) < 1e-6, `orbit is not centred on the subject: ${r} vs ${radii[0]}`);
    }
});






test('the SPA script parses', () => {
    // A `const curve` defined in one sampler and used in another shipped a
    // ReferenceError that only fired when a particular movement was sampled.
    // Parsing cannot catch that one, but it does catch the whole class of
    // damage a bulk edit can do to an 18,000-line file that nothing compiles.
    const vm = require('vm');
    const html = fs.readFileSync(INDEX_HTML, 'utf8');

    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    assert.ok(scripts.length, 'no inline script found — the parse is wrong');

    const broken = [];
    scripts.forEach((code, i) => {
        if (!code.trim()) return;
        try { new vm.Script(code, { filename: `index.html#script${i}` }); }
        catch (err) { broken.push(`script ${i}: ${err.message}`); }
    });
    assert.deepStrictEqual(broken, [], broken.join('; '));
});


// ── Exporting the previs ────────────────────────────────────────────────────

// A 1x1 PNG, base64. Small enough to inline, real enough to decode.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_WEBM = 'data:video/webm;base64,GkXfo0AgQoaBAULygQRC84EIQoKEd2VibUKHgQRChoECGFOAZwEAAAAAAAHTEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggEXTbuMU6uEHFO7a1OsggG97AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

test('both previs exports round-trip to disk and to the registry', async () => {
    const kinds = [
        { kind: 'frame', data: TINY_PNG, ext: 'png' },
        { kind: 'move', data: TINY_WEBM, ext: 'webm' },
    ];
    const failures = [];

    for (const { kind, data, ext } of kinds) {
        const { shotId, projectId } = makeShot();
        const res = await call('POST', `/film/shots/${shotId}/previs/export`, { kind, data });
        if (res.status !== 200) { failures.push(`${kind}: ${res.status} ${JSON.stringify(res.body)}`); continue; }

        if (!res.body.file_name || !res.body.file_name.endsWith(`.${ext}`)) {
            failures.push(`${kind}: filename ${res.body.file_name}`);
        }
        if (!fs.existsSync(res.body.file_path)) failures.push(`${kind}: nothing written to disk`);

        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(res.body.asset_id);
        if (!asset) { failures.push(`${kind}: no asset registered`); continue; }
        if (asset.project_id !== projectId) failures.push(`${kind}: asset on the wrong project`);
        if (asset.shot_id !== shotId) failures.push(`${kind}: asset not linked to the shot`);

        // The registry's CHECK cannot be widened in place, so previs media is
        // typed 'other' with a metadata discriminator — the same shape the 3D
        // work uses. Anything else would fail the constraint at insert.
        let meta = {};
        try { meta = JSON.parse(asset.metadata || '{}'); } catch (_) { /* */ }
        if (meta.kind !== `previs_${kind}`) failures.push(`${kind}: metadata.kind is ${meta.kind}`);
    }
    assert.deepStrictEqual(failures, [], failures.join('; '));
});

test('re-exporting replaces rather than piling up versions', async () => {
    const { shotId } = makeShot();
    await call('POST', `/film/shots/${shotId}/previs/export`, { kind: 'frame', data: TINY_PNG });
    await call('POST', `/film/shots/${shotId}/previs/export`, { kind: 'frame', data: TINY_PNG });

    const rows = db.prepare(
        "SELECT COUNT(*) n FROM film_assets WHERE shot_id = ? AND asset_type = 'other'").get(shotId);
    assert.strictEqual(rows.n, 1, 'a second export left two rows for one frame');
});

test('an export names the blocking it came from', async () => {
    // A frame with no record of the lens and move that produced it is a picture
    // nobody can reproduce.
    const { shotId } = makeShot();
    await call('PUT', `/film/shots/${shotId}/previs`, { ...blockingFixture(), movement: 'push-in', rig: 'dolly' });
    const res = await call('POST', `/film/shots/${shotId}/previs/export`, { kind: 'frame', data: TINY_PNG });

    const asset = db.prepare('SELECT metadata FROM film_assets WHERE id = ?').get(res.body.asset_id);
    const meta = JSON.parse(asset.metadata || '{}');
    assert.strictEqual(meta.movement, 'push-in');
    assert.strictEqual(meta.rig, 'dolly');
    assert.ok(meta.focal_mm > 0, 'no lens recorded');
    assert.ok(meta.sensor_id, 'no sensor recorded');
});

test('rubbish is refused rather than written', async () => {
    const { shotId } = makeShot();
    const cases = [
        [{ kind: 'hologram', data: TINY_PNG }, /kind/i],
        [{ kind: 'frame', data: 'not-a-data-url' }, /data/i],
        [{ kind: 'frame', data: 'data:text/html;base64,PGh0bWw+' }, /image|video|type/i],
        [{ kind: 'frame' }, /data/i],
    ];
    for (const [body, pattern] of cases) {
        const res = await call('POST', `/film/shots/${shotId}/previs/export`, body);
        assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(body).slice(0, 50)}`);
        assert.ok(pattern.test(JSON.stringify(res.body)), `unhelpful error: ${JSON.stringify(res.body)}`);
    }
});

test('an oversized payload is refused before it is decoded', async () => {
    // A canvas recording can be tens of megabytes; the limit exists so a
    // runaway recording cannot fill the disk.
    const { shotId } = makeShot();
    const huge = 'data:image/png;base64,' + 'A'.repeat(80 * 1024 * 1024);
    const res = await call('POST', `/film/shots/${shotId}/previs/export`, { kind: 'frame', data: huge });
    assert.strictEqual(res.status, 413);
});

test('previs media is served, and cannot escape its project directory', async () => {
    const { shotId, projectId } = makeShot();
    const saved = await call('POST', `/film/shots/${shotId}/previs/export`, { kind: 'frame', data: TINY_PNG });

    const ok = await call('GET', `/film/previs/media/${projectId}/${saved.body.file_name}`);
    assert.notStrictEqual(ok.status, 404, 'the media route does not dispatch');

    const escape = await call('GET', `/film/previs/media/${projectId}/..%2F..%2Fetc%2Fpasswd`);
    assert.ok(escape.status === 400 || escape.status === 404,
        `path traversal returned ${escape.status}`);
});

/*
 * The old previs stage (inspector, grey-box canvas, toolbar) was removed from the
 * page; the Previs page is the World Engine console. Its UI tests went with it —
 * what remains here is the server half, which generation and the console use.
 */
