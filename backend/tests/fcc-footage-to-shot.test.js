/**
 * FOOTAGE ATTACHES TO A SHOT — GRD-3810 / FCC-014.
 *
 * "`video-media` records to a shot as `video_raw`, so the timeline, the conform
 * and the NLE export pick it up with nothing else to change."
 *
 * THIS IS THE TASK FCC-012 DELIBERATELY LEFT A HOLE FOR. Footage is
 * photographed in the world and qualifies for the controlled camera under the
 * epic's own rule — and that surface was left on the OS picker, marked
 * `camera_pending`, because the controlled camera recorded a take and nothing
 * delivered it. Routing it then would have traded a working path for a
 * better-looking one that loses the walk. The marker names this task, and this
 * task removes it.
 *
 * WHAT IS ACTUALLY IN THE WAY IS THE ROUTE. `importMedia` has accepted either
 * form since it was written — a base64 data URI from a browser's FileReader, or
 * RAW BYTES from a native client, which cost a third less because nothing
 * inflates. Its own comment says accepting both there rather than at each route
 * is "what stops one import path learning the cheaper form and the other five
 * not". Thirteen routes call it and exactly ONE passes raw bytes: the world
 * capture. `importForCapability` — the single route serving all seven media
 * capabilities, the one built for the LARGEST files — opens with
 * `if (!body.data) return 400 'no file supplied'`, so a take posted as bytes is
 * refused before it is read.
 *
 * SET-BASED OVER THREE REGISTRIES, because every one of these fails partially:
 *
 *   1. The targets a RECORDING session delivers to — derived as photographed
 *      AND accepting video, which is 2. Wiring `video-media` and leaving the
 *      world capture on a different mechanism is how the two come to disagree
 *      about what a finished take does.
 *   2. The capabilities `importForCapability` serves — 7. A raw path that works
 *      for video and refuses a voice recording is the same gap one medium over,
 *      and it is invisible until somebody records dialogue on the phone.
 *   3. The assemblies — 5. "picks it up with nothing else to change" is the
 *      claim, and it is only true if the timeline, the conform and all THREE
 *      NLE exports see the clip. This codebase has already shipped a fix that
 *      reached two of five, where playback was right and Premiere received a
 *      three-second film with two gaps.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-footage-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const SWIFT = fs.readFileSync(path.join(ROOT, 'ios', 'FilmEngine', 'PlateCamera.swift'), 'utf8');

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const mediaImports = require('../lib/media-imports');
const { MEDIA_IMPORTS, shootsWithCamera } = mediaImports;
const { MEDIA_KINDS } = require('../lib/media-kinds');

/** Comments stripped — a mention is not a use. */
const swift = () => SWIFT.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/**
 * The targets a RECORDING session delivers a finished take to.
 *
 * DERIVED, never listed: what the camera can point at (photographed) crossed
 * with what the target will accept as a moving picture. `lipsync-media` and
 * `post-media` also accept video and are GENERATED, so they are excluded by the
 * first clause rather than by being remembered.
 */
const TAKE_TARGETS = Object.entries(MEDIA_IMPORTS)
    .filter(([, s]) => s.photographed && (s.kind === 'video' || (s.kinds || []).includes('video')))
    .map(([k]) => k);

/** The capabilities `importForCapability` serves: everything but the frame. */
const IMPORT_CAPABILITIES = Object.entries(MEDIA_KINDS)
    .filter(([, s]) => (s.media || s.kind) !== 'image')
    .map(([cap, s]) => ({ cap, media: s.media || s.kind, scope: s.scope }));

/* ------------------------------------------------------------------ *
 * fixtures                                                            *
 * ------------------------------------------------------------------ */

/** A real, short, cheap clip — a container with a real duration. */
function realClip(file, seconds = 2) {
    const { resolveFfmpeg } = require('../lib/ffmpeg');
    const found = resolveFfmpeg();
    assert.ok(found.available, `no encoder: ${found.reason}`);
    const built = require('child_process').spawnSync(found.bin, [
        '-f', 'lavfi', '-i', `color=c=black:size=16x16:rate=5:duration=${seconds}`,
        '-c:v', 'mpeg4', '-y', file,
    ], { timeout: 120000, encoding: 'utf8' });
    /*
     * The ENCODER's status, never `existsSync`. ffmpeg creates the output
     * before it writes the header, so under the parallel load of the full suite
     * a killed build leaves a truncated file that exists and measures zero —
     * which then reads as a defect in the import rather than a failed fixture.
     */
    assert.strictEqual(built.status, 0,
        `could not build a clip: ${String(built.stderr || built.error).slice(-300)}`);
    return fs.readFileSync(file);
}

/** The smallest thing that is genuinely a WAV, for the audio capabilities. */
function realWav() {
    const data = Buffer.alloc(64);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVE', 8);
    head.write('fmt ', 12);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);            // PCM
    head.writeUInt16LE(1, 22);            // mono
    head.writeUInt32LE(8000, 24);
    head.writeUInt32LE(8000, 28);
    head.writeUInt16LE(1, 32);
    head.writeUInt16LE(8, 34);
    head.write('data', 36);
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
}

/** A project with one scene and one shot, ready to receive footage. */
function fixture() {
    const projectId = generateId();
    const sceneId = generateId();
    const shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)')
        .run(projectId, 'Footage');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, sort_order, duration_ms, scene_card_yaml)
                VALUES (?, ?, '1A', 0, 3000, ?)`)
        .run(shotId, sceneId, JSON.stringify({ shot_code: '1A', description: 'a shot' }));
    return { projectId, sceneId, shotId };
}

/** Drive the import route directly, with whichever body shape is being tested. */
function post(urlParts, body, method = 'POST') {
    const { handleMediaImport } = require('../routes/media-import');
    let status = 0;
    let payload = null;
    const res = {
        writeHead(s) { status = s; return res; },
        setHeader() { return res; },
        end(text) { try { payload = JSON.parse(text); } catch (_) { payload = text; } },
    };
    handleMediaImport({ method, body, headers: {} }, res, urlParts);
    return { status, body: payload };
}

/* ------------------------------------------------------------------ *
 * SET 1 — the surface FCC-012 left behind                             *
 * ------------------------------------------------------------------ */

test('footage now reaches the CONTROLLED camera, and the marker is gone', () => {
    const spec = MEDIA_IMPORTS['video-media'];
    assert.ok(spec, 'video-media is not a target');
    assert.strictEqual(spec.photographed, true,
        'footage stopped being photographed in the world, which would make this whole task moot');
    assert.ok(!spec.camera_pending,
        `video-media still says it is waiting: "${spec.camera_pending}". This IS that task — the `
        + 'marker must go with the delivery, or a gap that is closed goes on reading as open');
    assert.strictEqual(shootsWithCamera('video-media'), true,
        'footage still opens the OS picker: one clip, no exposure or focus lock, no format, no '
        + 'budget — while nine tasks of this epic built a camera that does all of it');
});

test('the page agrees, over every target the registry declares', () => {
    /*
     * The page cannot require a node module (build.target: single-html), so the
     * rule exists twice and the two are held equal by ASKING the page's own
     * predicate — comparing literals proves the lists match and says nothing
     * about what the page answers, which is what decides the camera.
     */
    const at = UI.indexOf('function shootsWithCamera(');
    assert.notStrictEqual(at, -1, 'the page has no camera rule');
    let d = 0;
    let end = at;
    for (let i = UI.indexOf('{', at); i < UI.length; i++) {
        if (UI[i] === '{') d++;
        else if (UI[i] === '}' && --d === 0) { end = i + 1; break; }
    }
    // eslint-disable-next-line no-new-func
    const page = new Function(`${UI.slice(at, end)} return shootsWithCamera;`)();

    const wrong = Object.keys(MEDIA_IMPORTS)
        .filter((t) => page(t) !== shootsWithCamera(t))
        .map((t) => `${t}: the page says ${page(t)} and the registry says ${shootsWithCamera(t)}`);
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 2 — every target a take is delivered to                         *
 * ------------------------------------------------------------------ */

test('the take-delivering set is real, and is exactly what the rule derives', () => {
    assert.deepStrictEqual(TAKE_TARGETS.sort(), ['video-media', 'world-capture'],
        'the set of targets a recording session delivers to has changed. It is derived as '
        + 'photographed AND accepting video — a generated clip (lipsync, post) is excluded by the '
        + 'first clause, and if that stopped being true the camera would be offered on an '
        + 'artefact nothing can point a lens at');
});

test('the camera is told WHICH MEDIA a session can produce, not merely where it goes', () => {
    /*
     * `destination` answers which CEILING binds (FCC-013). It cannot answer
     * whether a take is wanted: footage and a plate share the destination
     * `footage`, and a world capture takes both a panorama and a walkthrough.
     * Two different questions, and conflating them is why FCC-013 wired the
     * delivery to `forWorld` — correct for the one case it had, wrong the
     * moment a second recording surface exists.
     */
    const s = swift();
    assert.match(s, /let media: \[String\]\?/,
        'PlateCaptureRequest cannot be told which media this session may produce, so a footage '
        + 'session opens the stills shutter and a take is never delivered');
    assert.match(s, /recordsTakes|shootsStills/,
        'the request never turns that into a decision the view can act on');

    // withBase() rebuilds the request field by field; a field it forgets is
    // dropped on every request, because the page always sends apiBase empty.
    const bridge = fs.readFileSync(path.join(ROOT, 'ios', 'FilmEngine', 'ContentView.swift'), 'utf8');
    const at = bridge.indexOf('func withBase(');
    assert.notStrictEqual(at, -1, 'withBase is gone');
    assert.match(bridge.slice(at, bridge.indexOf('\n    }', at)), /media:\s*media\b/,
        'withBase() rebuilds the request without carrying the media through, so it is dropped on '
        + 'every request and every session falls back to stills');
});

test('the delivery is wired to RECORDING, not to one destination', () => {
    const s = swift();
    assert.match(s, /onTake:\s*request\.recordsTakes/,
        'the finished take is handed on only for the case FCC-013 happened to build. A footage '
        + 'session records and the URL that exists solely in stopRecording’s completion is '
        + 'dropped, which is the silent loss FCC-012 refused to ship');
    assert.ok(!/onTake:\s*request\.forWorld/.test(s),
        'the delivery still keys on the world destination — that is the CEILING question, and '
        + 'using it here means a second recording surface silently delivers nothing');
});

test('EVERY take target sends the page a route the camera can post to', () => {
    /*
     * The page builds every import URL and native constructs none, so a target
     * whose control does not reach `shootPlate` cannot deliver whatever the
     * camera records.
     */
    const wrong = [];
    for (const target of TAKE_TARGETS) {
        if (!shootsWithCamera(target)) {
            wrong.push(`${target}: delivers a take and does not reach the controlled camera`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 3 — the route accepts what the camera actually sends            *
 * ------------------------------------------------------------------ */

test('the capability set is real, or every route assertion passes over nothing', () => {
    assert.ok(IMPORT_CAPABILITIES.length >= 6,
        `only ${IMPORT_CAPABILITIES.length} capabilities; the registry read is broken`);
});

test('EVERY capability import accepts RAW BYTES, not only a base64 data URI', () => {
    /*
     * `importMedia` has taken either form since it was written, and its own
     * comment says accepting both there rather than at each route is what stops
     * one path learning the cheaper form and the others not. Thirteen routes
     * call it and one passes bytes. This is the route built for the LARGEST
     * files, and it refuses them with "no file supplied" before reading a byte.
     */
    const { projectId, sceneId, shotId } = fixture();
    const dir = path.join(process.env.FILM_DATA_DIR, 'raw-src');
    fs.mkdirSync(dir, { recursive: true });
    const clip = realClip(path.join(dir, 'take.mp4'));
    const wav = realWav();

    const wrong = [];
    for (const { cap, media, scope } of IMPORT_CAPABILITIES) {
        const owner = scope === 'scene' ? sceneId : shotId;
        const parts = ['film', scope === 'scene' ? 'scenes' : 'shots', owner, 'media', cap, 'import'];
        const bytes = media === 'video' ? clip : wav;
        const mime = media === 'video' ? 'video/mp4' : 'audio/wav';
        const r = post(parts, { __raw: bytes, __mime: mime, name: `take.${media === 'video' ? 'mp4' : 'wav'}` });
        if (r.status !== 201) {
            wrong.push(`${cap}: raw bytes were refused with ${r.status} `
                + `"${(r.body && r.body.error) || ''}"`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the one route built for the largest files takes only the form that inflates them by a '
        + `third:\n  ${wrong.join('\n  ')}`);
    // Not a vacuous pass over an empty owner set.
    assert.ok(projectId);
});

test('exactly ONE site decodes an upload, or the cheaper form is learned unevenly again', () => {
    /*
     * `bytesFrom` exists to state "either form" once, and its own comment says
     * accepting both there rather than at each site is what stops one path
     * learning the cheaper form and the others not. THREE sites decoded an
     * upload and two of them called `decodeDataUri` directly — so footage,
     * sound and plates could arrive only base64-encoded, a third larger than
     * the file, which is what stood between a take on the phone and its shot.
     */
    const lib = fs.readFileSync(path.join(ROOT, 'backend', 'lib', 'media-imports.js'), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const callers = [...lib.matchAll(/decodeDataUri\(/g)];
    assert.strictEqual(callers.length, 2,
        `decodeDataUri is reached from ${callers.length - 1} place(s) besides its own `
        + 'declaration. It must have exactly one caller — bytesFrom — or a site that decodes '
        + 'directly cannot accept raw bytes and nobody finds out until a native client posts one');
});

test('a base64 data URI still works, because that is how the page posts', () => {
    const { shotId } = fixture();
    const dir = path.join(process.env.FILM_DATA_DIR, 'b64-src');
    fs.mkdirSync(dir, { recursive: true });
    const clip = realClip(path.join(dir, 'take.mp4'));
    const r = post(['film', 'shots', shotId, 'media', 'video', 'import'], {
        data: `data:video/mp4;base64,${clip.toString('base64')}`, name: 'browser.mp4',
    });
    assert.strictEqual(r.status, 201,
        `the browser's own upload broke: ${(r.body && r.body.error) || ''}`);
});

test('an empty body is still refused, and says what is missing', () => {
    const { shotId } = fixture();
    const r = post(['film', 'shots', shotId, 'media', 'video', 'import'], {});
    assert.strictEqual(r.status, 400, 'a request carrying no file at all was accepted');
    assert.match(String(r.body.error), /file/i, 'the refusal does not say what is missing');
});

test('bytes that are not what the route is for are REFUSED by the bytes', () => {
    /*
     * The rule this codebase paid for: the bytes decide, never the name. A
     * renamed file passes any extension check, and a clip that cannot be
     * decoded is a shot that plays black in the cut with no error anywhere.
     */
    const { shotId } = fixture();
    const r = post(['film', 'shots', shotId, 'media', 'video', 'import'], {
        __raw: realWav(), __mime: 'video/mp4', name: 'lying.mp4',
    });
    assert.strictEqual(r.status, 400,
        'an audio file announced as video was accepted as footage, so a shot would play silence '
        + 'over black in the cut');
});

/* ------------------------------------------------------------------ *
 * SET 4 — nothing else to change                                      *
 * ------------------------------------------------------------------ */

test('an imported take lands as video_raw, measured, on the shot', () => {
    const { shotId } = fixture();
    const dir = path.join(process.env.FILM_DATA_DIR, 'land-src');
    fs.mkdirSync(dir, { recursive: true });
    const clip = realClip(path.join(dir, 'take.mp4'), 2);

    const r = post(['film', 'shots', shotId, 'media', 'video', 'import'], {
        __raw: clip, __mime: 'video/quicktime', name: 'take.mov',
    });
    assert.strictEqual(r.status, 201, `the take was refused: ${(r.body && r.body.error) || ''}`);

    const row = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(r.body.asset_id);
    assert.ok(row, 'the take produced no asset row');
    assert.strictEqual(row.asset_type, 'video_raw',
        `the take landed as ${row.asset_type}. Every assembly selects video_raw, so anything else `
        + 'is a file on disk that no cut will ever pick up');
    assert.strictEqual(row.shot_id, shotId, 'the take is not on the shot it was posted to');
    assert.ok(row.duration_ms > 1500 && row.duration_ms < 2600,
        `the take measured ${row.duration_ms}ms for a 2s clip — the timeline holds a clip for the `
        + "card's guess when nothing measured it");
});

test('EVERY assembly picks the take up, with nothing else to change', () => {
    /*
     * The claim in the task's own sentence, and the one this codebase has
     * already shipped half of once: playback was right while the conform
     * refused to build a master and Premiere received a three-second film with
     * two gaps. Five surfaces walk the shots independently, so a take that
     * reaches four of them is a delivery nobody notices is broken until the
     * editor opens the fifth.
     */
    const { projectId, shotId } = fixture();
    const dir = path.join(process.env.FILM_DATA_DIR, 'asm-src');
    fs.mkdirSync(dir, { recursive: true });
    const clip = realClip(path.join(dir, 'take.mp4'), 2);
    const r = post(['film', 'shots', shotId, 'media', 'video', 'import'], {
        __raw: clip, __mime: 'video/mp4', name: 'take.mp4',
    });
    assert.strictEqual(r.status, 201, `the take was refused: ${(r.body && r.body.error) || ''}`);
    const stored = db.prepare('SELECT file_name FROM film_assets WHERE id = ?').get(r.body.asset_id);

    const seen = {};
    /*
     * Assembled the way the ROUTE assembles it. `buildTimeline` takes shots and
     * their assets rather than a project id — handed a string it iterated the
     * UUID's characters and returned one empty entry per character, which reads
     * as the take being missing rather than as the caller being wrong.
     */
    const shotRows = db.prepare(`
        SELECT s.*, sc.scene_number FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id WHERE sc.project_id = ?`).all(projectId);
    const shotAssets = db.prepare(`
        SELECT a.* FROM film_assets a WHERE a.project_id = ? AND a.shot_id IS NOT NULL`).all(projectId);
    const byShot = {};
    for (const a of shotAssets) (byShot[a.shot_id] ||= []).push(a);
    const { buildTimeline } = require('../lib/timeline');
    const entries = buildTimeline(shotRows, byShot, { fps: 24 }).entries || [];
    assert.ok(entries.length >= 1, 'the timeline produced no entries at all — the fixture is wrong');
    seen.timeline = entries.some((e) => JSON.stringify(e).includes(stored.file_name));

    const { planConform } = require('../lib/conform');
    const plan = planConform(projectId);
    seen.conform = JSON.stringify(plan).includes(stored.file_name);

    const nle = require('../lib/nle-export');
    const shots = db.prepare(`SELECT sh.*, s.scene_number FROM film_shots sh
                              JOIN film_scenes s ON s.id = sh.scene_id
                              WHERE s.project_id = ?`).all(projectId);
    const assets = db.prepare('SELECT * FROM film_assets WHERE project_id = ?').all(projectId);
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    for (const name of Object.keys(nle).filter((k) => /^generate(EDL|FCPXML|PremiereXML)$/.test(k))) {
        let out = '';
        try { out = String(nle[name](project, shots, assets) || ''); } catch (err) { out = `THREW ${err.message}`; }
        seen[name] = out.includes(stored.file_name)
            // An EDL names REELS rather than files — carrying no media is its
            // documented contract, so it counts when the shot is in the list.
            || (/EDL/.test(name) && /1A/.test(out));
    }

    const missing = Object.entries(seen).filter(([, ok]) => !ok).map(([k]) => k);
    assert.ok(Object.keys(seen).length >= 5,
        `only ${Object.keys(seen).length} assemblies were exercised; the derivation is broken`);
    assert.deepStrictEqual(missing, [],
        'a take that reaches some assemblies and not others is a delivery nobody notices is '
        + `broken until an editor opens the one that missed it: ${missing.join(', ')}`);
});

test('the iOS bundle is re-synced, or the phone runs a page without the change', () => {
    const bundled = fs.readFileSync(path.join(ROOT, 'ios/FilmEngine/Web/index.html'), 'utf8');
    assert.strictEqual(bundled, UI,
        'ios/FilmEngine/Web/index.html has drifted from src/index.html — '
        + '`cp src/index.html ios/FilmEngine/Web/index.html`');
});
