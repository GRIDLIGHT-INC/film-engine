const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

/**
 * THE PROJECT MASTER: ORDERED SHOT MASTERS + THE MIX → ONE FILE, REGISTERED.
 *
 * SHIP-002. `lib/conform.test.js` proves the PLAN — which clip, in what order,
 * with what audio, and what is missing. Nothing proved the FILE: `runConform`
 * had never been executed in a test, and reading it found three things a plan
 * check cannot see.
 *
 *   1. It wrote the master to `data/video/<project>` relative to the process
 *      cwd, via a `getProjectDir` that does not exist, while the serving route
 *      reads `DATA_DIR/video/<project>`. Without FILM_DATA_DIR set those are
 *      different directories: the conform succeeds and `/film/video/...` 404s.
 *   2. Every conform INSERTED a new row at version 1 pointing at the same
 *      overwritten path, so after two runs the project had two masters, one of
 *      whose metadata described bytes that no longer existed.
 *   3. The row recorded no measured length or size, so a master registered
 *      from a broken encode looked identical to a good one.
 *
 * Everything here is asserted from the FILE or the ROW, never from the source.
 * Volume, not stream presence, decides whether audio arrived — a synthesised
 * silent track passes every "is there audio" check, which is how every join
 * in this engine was silent for months.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-master-' + crypto.randomUUID().slice(0, 8));
const { lavfiSource } = require('./helpers');

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const conform = require('../lib/conform');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
const { DATA_DIR, getFilePath } = require('../lib/file-storage');
const { buildTimeline } = require('../lib/timeline');

const bin = () => resolveFfmpeg().bin;
let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-master-clips-')); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

function sh(args) {
    execFileSync(bin(), ['-nostdin', '-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
}
/** A clip that makes a sound, so silence in the master means something. */
function toneClip(name, secs, colour = 'red') {
    const p = path.join(TMP, name);
    sh([...lavfiSource(`color=c=${colour}:s=320x240:d=${secs}`, `sine=frequency=440:duration=${secs}`),
        '-c:v', 'libx264', '-c:a', 'aac', '-r', '24', '-t', String(secs), '-pix_fmt', 'yuv420p', p]);
    return p;
}
/** A clip with no audio at all — what a generated clip really is here. */
function silentClip(name, secs, colour = 'blue') {
    const p = path.join(TMP, name);
    sh(['-f', 'lavfi', '-i', `color=c=${colour}:s=320x240:d=${secs}`,
        '-c:v', 'libx264', '-r', '24', '-t', String(secs), '-pix_fmt', 'yuv420p', p]);
    return p;
}
function toneAudio(name, secs) {
    const p = path.join(TMP, name);
    sh(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-c:a', 'aac', '-t', String(secs), p]);
    return p;
}
/** -91 dB is digital silence; a 440Hz tone lands around -25 to -35. */
function meanVolumeDb(file) {
    const r = spawnSync(bin(), ['-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000 });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(r.stderr || '') + String(r.stdout || ''));
    return m ? Number(m[1]) : null;
}

/**
 * A film: shots with REAL clips. `insert` is the order rows are written in,
 * deliberately not the running order, because insertion order is the one the
 * planner must not follow.
 */
function makeFilm(specs, opts = {}) {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)').run(projectId, 'Master');
    const scenes = {};
    const sceneId = n => {
        if (!scenes[n]) {
            scenes[n] = generateId();
            db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, 'STREET')")
                .run(scenes[n], projectId, String(n));
        }
        return scenes[n];
    };
    const rows = specs.map((s, i) => ({ ...s, insert: s.insert === undefined ? i : s.insert }))
        .sort((a, b) => a.insert - b.insert);
    const shots = {};
    for (const s of rows) {
        const shotId = generateId();
        shots[s.code] = shotId;
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order)
                    VALUES (?, ?, ?, ?, 0, ?)`)
            .run(shotId, sceneId(s.scene || 1), s.code, JSON.stringify({ shot_code: s.code, camera: {} }), s.sort_order || 0);
        if (s.clip) {
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms)
                        VALUES (?, ?, ?, ?, ?, ?, 'mp4', ?)`)
                .run(generateId(), projectId, shotId, s.type || 'video_raw', s.clip, path.basename(s.clip),
                    Math.round((inspectMedia(s.clip).durationSeconds || 0) * 1000));
        }
    }
    if (opts.mix) {
        db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format)
                    VALUES (?, ?, 'audio_mix', ?, ?, 'm4a')`)
            .run(generateId(), projectId, opts.mix, path.basename(opts.mix));
    }
    return { projectId, shots };
}

const masters = projectId => db.prepare(
    `SELECT * FROM film_assets WHERE project_id = ? AND metadata LIKE '%"kind":"project_master"%' ORDER BY version`)
    .all(projectId);

const call = (handler, method, url, body) => new Promise(resolve => {
    const out = [];
    const res = {
        writeHead(s) { this.statusCode = s; return this; },
        end(p) { out.push(p || ''); resolve({ status: this.statusCode || 200, body: JSON.parse(out.join('') || '{}') }); },
    };
    Promise.resolve(handler({ method, url, body: body || {} }, res,
        url.split('?')[0].split('/').filter(Boolean), {}))
        .then(r => { if (r === false) resolve({ status: 404, body: {} }); })
        .catch(err => resolve({ status: 500, body: { error: err.message } }));
});
const route = () => require('../routes/production-reports').handleProductionReports;

// ── One file, where the serving route can find it ──────────────────────────

test('every cut a shot can ship as conforms to a real, servable, measured master', async () => {
    // Set-based over the precedence list: a conform that works from a raw clip
    // and silently fails from a graded one would ship the wrong cut of every
    // finished shot.
    for (const type of conform.VIDEO_PRECEDENCE) {
        const { projectId } = makeFilm([{ code: '1A', clip: toneClip(`${type}_1A.mp4`, 2), type }]);
        const r = await conform.runConform(projectId);
        assert.strictEqual(r.ok, true, `${type}: ${r.error}`);
        assert.ok(fs.existsSync(r.output), `${type}: no file at ${r.output}`);

        // Where /film/video/:project/:file will look — DATA_DIR, not the cwd.
        const served = getFilePath(projectId, 'video', path.basename(r.output));
        assert.strictEqual(path.resolve(r.output), path.resolve(served),
            `${type}: master written to ${r.output}, served from ${served}`);
        assert.ok(r.url && r.url.startsWith(`/film/video/${projectId}/`), `${type}: no serving url in the result`);

        const rows = masters(projectId);
        assert.strictEqual(rows.length, 1, `${type}: ${rows.length} master rows`);
        const row = rows[0];
        assert.strictEqual(row.id, r.asset_id);
        assert.strictEqual(row.shot_id, null, 'a project master belongs to no shot');
        const info = inspectMedia(r.output);
        assert.ok(info.ok, `${type}: the master does not decode: ${info.reason}`);
        assert.ok(Math.abs(row.duration_ms - info.durationSeconds * 1000) < 150,
            `${type}: row says ${row.duration_ms}ms, file is ${info.durationSeconds}s`);
        assert.strictEqual(row.size_bytes, fs.statSync(r.output).size, `${type}: size not recorded from the file`);
        assert.strictEqual(row.width, info.width);
        assert.strictEqual(row.height, info.height);
    }
});

// ── Ordering is the timeline's, not the insertion order ────────────────────

test('the master plays in the running order, however the rows were inserted', async () => {
    // Inserted 2A, 1B, 1A; sort_order says 1B before 1A within scene 1 is
    // FALSE (1A has the lower sort_order) — so insertion order, id order and
    // even code order all disagree with the running order somewhere.
    const film = makeFilm([
        { code: '2A', scene: 2, sort_order: 0, insert: 0, clip: silentClip('o_2A.mp4', 3, 'green') },
        { code: '1B', scene: 1, sort_order: 1, insert: 1, clip: silentClip('o_1B.mp4', 2, 'blue') },
        { code: '1A', scene: 1, sort_order: 0, insert: 2, clip: silentClip('o_1A.mp4', 1, 'red') },
    ]);
    const plan = conform.planConform(film.projectId);
    const shots = db.prepare(
        `SELECT sh.*, s.scene_number, s.project_id FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id WHERE s.project_id = ?`)
        .all(film.projectId);
    const timeline = buildTimeline(shots, {}).entries.map(e => e.shot_code);
    assert.deepStrictEqual(plan.clips.map(c => c.shot_code), timeline,
        'the conform and the timeline disagree about the order the film plays in');
    assert.deepStrictEqual(timeline, ['1A', '1B', '2A']);

    const r = await conform.runConform(film.projectId);
    assert.strictEqual(r.ok, true, r.error);
    const info = inspectMedia(r.output);
    assert.ok(Math.abs(info.durationSeconds - 6) < 0.3, `master is ${info.durationSeconds}s, clips total 6s`);
    // The first second is 1A (red), the last is 2A (green): sample a frame
    // from each end and read its dominant channel.
    const rgb = (t) => {
        const r2 = spawnSync(bin(), ['-nostdin', '-ss', String(t), '-i', r.output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '2x2', '-'],
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1 << 20 });
        const b = r2.stdout; return [b[0], b[1], b[2]];
    };
    const first = rgb(0.4), last = rgb(5.6);
    assert.ok(first[0] > 150 && first[1] < 100, `the film does not open on 1A (red): ${first}`);
    assert.ok(last[1] > 100 && last[0] < 100, `the film does not end on 2A (green): ${last}`);
});

// ── The mix is the master's audio; without one the clips keep theirs ───────

test('a project audio mix becomes the audio of the master', async () => {
    const { projectId } = makeFilm([
        { code: '1A', clip: silentClip('m_1A.mp4', 2) },
        { code: '1B', clip: silentClip('m_1B.mp4', 2) },
    ], { mix: toneAudio('mix.m4a', 4) });
    const r = await conform.runConform(projectId);
    assert.strictEqual(r.ok, true, r.error);
    const vol = meanVolumeDb(r.output);
    assert.ok(vol !== null && vol > -60, `the master is silent (${vol} dB) although a mix exists`);
});

test('without a mix the clips keep their own audio rather than going silent', async () => {
    const { projectId } = makeFilm([
        { code: '1A', clip: toneClip('k_1A.mp4', 2) },
        { code: '1B', clip: toneClip('k_1B.mp4', 2) },
    ]);
    const r = await conform.runConform(projectId);
    assert.strictEqual(r.ok, true, r.error);
    const vol = meanVolumeDb(r.output);
    assert.ok(vol !== null && vol > -60, `the master lost the clips' audio (${vol} dB)`);
});

// ── Registration replaces, never accumulates ───────────────────────────────

test('conforming again replaces the master: one row, a higher version, true metadata', async () => {
    const { projectId, shots } = makeFilm([{ code: '1A', clip: silentClip('r_1A.mp4', 1) }]);
    const first = await conform.runConform(projectId);
    assert.strictEqual(first.ok, true, first.error);

    // The cut changes: a second shot arrives.
    const shotId = generateId();
    const sceneId = db.prepare('SELECT scene_id FROM film_shots WHERE id = ?').get(shots['1A']).scene_id;
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, '1B', '{}', 0, 1)`)
        .run(shotId, sceneId);
    const clip = silentClip('r_1B.mp4', 2);
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms)
                VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 2000)`).run(generateId(), projectId, shotId, clip, 'r_1B.mp4');

    const second = await conform.runConform(projectId);
    assert.strictEqual(second.ok, true, second.error);
    const rows = masters(projectId);
    assert.strictEqual(rows.length, 1, `${rows.length} master rows after two conforms — a folder of near-identical masters is how the wrong one gets delivered`);
    assert.strictEqual(rows[0].version, 2, 'the replacement did not move the version');
    assert.strictEqual(rows[0].id, second.asset_id);
    const meta = JSON.parse(rows[0].metadata);
    assert.strictEqual(meta.clips, 2, 'the row still describes the previous cut');
    assert.ok(Math.abs(rows[0].duration_ms - 3000) < 150, `duration ${rows[0].duration_ms} is not the new cut's`);
});

// ── The route ──────────────────────────────────────────────────────────────

test('POST /projects/:id/conform produces the master and answers 201 with where it is', async () => {
    const { projectId } = makeFilm([{ code: '1A', clip: silentClip('p_1A.mp4', 1) }]);
    const res = await call(route(), 'POST', `/film/projects/${projectId}/conform`, {});
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.asset_id, 'no asset id');
    assert.ok(res.body.url, 'no serving url');
    assert.strictEqual(masters(projectId).length, 1);
});

test('a missing shot refuses at the route with 409, and writes nothing', async () => {
    const { projectId } = makeFilm([
        { code: '1A', clip: silentClip('x_1A.mp4', 1) },
        { code: '1B' },
    ]);
    const res = await call(route(), 'POST', `/film/projects/${projectId}/conform`, {});
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error, /1B/, 'the refusal does not name the missing shot');
    assert.strictEqual(masters(projectId).length, 0, 'a refused conform registered a master');
    assert.ok(!fs.existsSync(path.join(DATA_DIR, 'video', projectId, 'film_master.mp4')), 'a refused conform wrote a file');
});

// ── An agent can conform the film ──────────────────────────────────────────

test('the conform is reachable over MCP: plan for free, then run', () => {
    // SHIP-024 drives the whole film from an agent host; a master nothing but
    // curl can produce is the last step happening outside Film Engine.
    const { listTools, ALL_ROUTE_TOOLS } = require('../lib/mcp-tools');
    const listed = new Set(listTools().map(t => t.name));
    const expected = { conform_plan: 'GET', conform_run: 'POST' };
    for (const [name, method] of Object.entries(expected)) {
        // The registry entry carries the dispatch; the wire listing carries
        // the schema. Both have to hold — a registered tool nobody lists is
        // one an agent cannot call.
        const t = ALL_ROUTE_TOOLS.find(x => x.name === name);
        assert.ok(t, `no ${name} tool`);
        assert.ok(listed.has(name), `${name} is registered and not served`);
        assert.strictEqual(t.method, method, `${name} uses ${t.method}`);
        assert.match(t.path({ project_id: 'P' }), /^\/film\/projects\/P\/conform$/, `${name} does not reach the conform route`);
        assert.ok(t.description.length > 80, `${name} has no useful description`);
    }
    assert.match(ALL_ROUTE_TOOLS.find(x => x.name === 'conform_plan').description, /free/i,
        'the plan spends nothing and must say so');
});
