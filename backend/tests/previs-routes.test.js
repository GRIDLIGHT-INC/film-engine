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
        const res = {
            statusCode: 200,
            writeHead(code) { this.statusCode = code; return this; },
            end(payload) {
                let parsed = payload;
                try { parsed = JSON.parse(payload); } catch (_) { /* keep raw */ }
                resolve({ status: this.statusCode, body: parsed });
            },
        };
        Promise.resolve(handlePrevis(req, res, parts, {})).catch(err => resolve({ status: 500, body: { error: err.message } }));
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

test('the previs page and both viewports exist in the SPA', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    for (const marker of [
        'id="page-previs"', 'data-page="previs"',
        'id="previsStage"',      // the 3D stage view
        'id="previsCamera"',     // what the camera sees
        'previsSave(', 'previsPlay(', 'previsSolve(',
    ]) {
        assert.ok(html.includes(marker), `the viewer is missing ${marker}`);
    }
});

test('the viewer reads its vocabulary from the server, not from a copy', () => {
    // A hardcoded movement list in the SPA is a second registry, and two
    // registries drift. The flows canvas made the same call for its palette.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.ok(html.includes('/previs/taxonomy'), 'the viewer never fetches the taxonomy');

    // No inline copy of the movement enum: finding many of them in one literal
    // means somebody pasted the list rather than fetching it.
    const previsSection = html.slice(html.indexOf('Previs canvas'));
    const inlineMoves = VALID_CAMERA_MOVES.filter(m => previsSection.includes(`'${m}'`));
    assert.ok(inlineMoves.length < 5,
        `the viewer hardcodes ${inlineMoves.length} movement names: ${inlineMoves.join(', ')}`);
});

test('the plan records phase 2 as built', () => {
    const t = JSON.parse(fs.readFileSync(TAXONOMY, 'utf8'));
    const phase2 = t.plan.modules.filter(m => m.phase === 2);
    const unbuilt = phase2.filter(m => m.status === 'new');
    assert.deepStrictEqual(unbuilt.map(m => m.path), [], 'phase 2 modules still marked unwritten');
});

// ── Handlers the markup promises actually exist ─────────────────────────────

test('every previs control calls a function that is declared', () => {
    // previsRemoveObject was referenced by the delete button on every staged
    // object and never defined: the button did nothing, and a patch aimed at
    // the missing function silently matched nothing. Server-side tests cannot
    // see an inline handler, so the wiring is checked structurally instead.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const declared = new Set([...html.matchAll(/function\s+(previs[A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]));

    const called = new Set([...html.matchAll(/\b(previs[A-Za-z0-9_]*)\s*\(/g)]
        .map(m => m[1])
        .filter(name => !declared.has(name)));

    // PREVIS is the state object, not a call.
    called.delete('PREVIS');
    assert.deepStrictEqual([...called], [],
        `previs functions called but never declared: ${[...called].join(', ')}`);
});

test('every inline on* handler in the previs page resolves to a declaration', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const page = html.slice(html.indexOf('id="page-previs"'), html.indexOf('id="page-pipeline"'));
    const declared = new Set([...html.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map(m => m[1]));

    const handlers = [...page.matchAll(/on[a-z]+="([A-Za-z0-9_]+)\(/g)].map(m => m[1]);
    assert.ok(handlers.length >= 8, `only found ${handlers.length} handlers — the parse is wrong`);

    const dangling = [...new Set(handlers)].filter(name => !declared.has(name));
    assert.deepStrictEqual(dangling, [], `dead buttons: ${dangling.join(', ')}`);
});

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

test('no control in the stage list sits under a handler that rebuilds the list', () => {
    // The bug this pins: every row called previsRenderObjects() on mousedown,
    // which replaced the markup while the browser was opening the <select>
    // underneath the cursor. The dropdown died mid-click, so the kind picker
    // and the image picker were unusable — visible, focusable, and inert.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const list = html.slice(html.indexOf('function previsRenderObjects'), html.indexOf('function previsAddObject'));

    assert.ok(!/onmousedown="[^"]*previsRenderObjects\(\)/.test(list),
        'a row handler re-renders the list on mousedown, which destroys the control being clicked');
    assert.ok(/previsSelectRow\(event,/.test(list),
        'rows do not route selection through the guard that leaves controls alone');

    // And the guard must actually check what was clicked.
    const guard = html.slice(html.indexOf('function previsSelectRow'), html.indexOf('function previsRenderObjects'));
    assert.ok(/SELECT|INPUT/.test(guard), 'previsSelectRow does not exempt form controls');
});

test('every image asset type the picker offers is served from the right directory', () => {
    // Sending character sheets to /storyboards/ left the card blank with no
    // clue why: a 404 on an <img> is silent.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const block = html.slice(html.indexOf('const SERVED_FROM'), html.indexOf('PREVIS.images = (data.assets'));
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    const dirs = [...new Set([...block.matchAll(/:\s*'([a-z]+)'/g)].map(m => m[1]))];
    assert.ok(dirs.length >= 2, `only found ${dirs.length} serving directories`);
    for (const dir of dirs) {
        assert.ok(server.includes(`parts[1] === '${dir}'`), `nothing serves /film/${dir}/`);
    }
});

test('the stage renderer, picker and unprojector all aim at the same point', () => {
    // Reframe moves what the orbit looks at. When each of the three decided
    // that for itself, pressing it left the picker aiming at the subject and
    // the renderer at the scene centre, so every click landed off-target.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const block = html.slice(html.indexOf('function previsStageFocus'), html.indexOf('function previsRefresh'));

    const rogue = [...block.matchAll(/const focus = (?!previsStageFocus)([^;]+);/g)].map(m => m[1].trim());
    assert.deepStrictEqual(rogue, [],
        `something decides the stage focus for itself instead of asking: ${rogue.join(', ')}`);
    assert.ok(/function previsStageFocus/.test(html), 'no single definition of what the stage looks at');
});

test('the viewer interpolates playback rather than snapping to a keyframe', () => {
    // The reported jank. Math.round() picked the NEAREST key, so a 24-key path
    // repainted at 60fps moved 24 times and held still in between — every
    // movement stepped, not just the short ones.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const pose = html.slice(html.indexOf('function previsPose'), html.indexOf('function previsAim'));

    assert.ok(!/Math\.round\(PREVIS\.playhead/.test(pose),
        'playback still snaps to the nearest keyframe');
    assert.ok(/Math\.floor\(span\)/.test(pose) && /mix\(/.test(pose),
        'playback does not interpolate between bracketing keys');
});

test('the viewer and the library agree on the easing curves', () => {
    // Two definitions of ease-in-out would make the preview and the stored path
    // describe different moves.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const { EASINGS } = require('../lib/previs-blocking');
    const block = html.slice(html.indexOf('const PREVIS_EASINGS'), html.indexOf('function previsSampleLeg'));

    for (const name of Object.keys(EASINGS)) {
        assert.ok(block.includes(`'${name}'`), `the viewer has no '${name}' curve`);
    }
    const inViewer = [...block.matchAll(/'([a-z-]+)':\s*t\s*=>/g)].map(m => m[1]).sort();
    assert.deepStrictEqual(inViewer, Object.keys(EASINGS).sort(),
        'the viewer offers a different set of curves from the library');
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
