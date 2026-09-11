const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * A CONFORM THAT FAILS SAYS WHAT WAS TRIED, WHAT WAS NOT, AND WHY.
 *
 * SHIP-033. `lib/image-fallback.js` reports `_chain` on failure — every
 * provider, tried or skipped, with its reason — because a message quoting only
 * the first refusal sends the reader to the wrong fix. The conform has the
 * same shape one level down: two executors are probed (the local encoder, the
 * provider stitch) and a failure named only whichever one was reached. A
 * refused join said "cannot read 1B.mp4" and nothing about the provider path
 * sitting untried beside it; a no-executor refusal listed the probe but a
 * stitch failure did not; and the orchestrator dropped even that on the way
 * to the run row, so a failed project run recorded `assembly` in a list of
 * ids and nothing else.
 *
 * Set-based three ways: over every failure state the conform declares, over
 * the executors it probes, and over every call site a conform failure passes
 * through on its way to a person.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-conform-walk-' + crypto.randomUUID().slice(0, 8));
process.env.FILM_RETRY_BACKOFF_MS = '1';

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const conform = require('../lib/conform');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const pipeline = require('../routes/pipeline');
const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
const { CONFORM_STATES } = pipeline;

const CONFORM_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'conform.js'), 'utf8');
const FAILURE_STATES = Object.keys(CONFORM_STATES).filter(s => s !== 'produced');
const GENERATIVE = PIPELINE_STEPS.filter(s => s.scope !== 'project').map(s => s.id);

let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-walk-')); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

function clip(name) {
    const p = path.join(TMP, name);
    execFileSync(resolveFfmpeg().bin, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=1',
        '-c:v', 'libx264', '-r', '24', '-t', '1', '-pix_fmt', 'yuv420p', p], { stdio: 'pipe', timeout: 120000 });
    return p;
}

/**
 * `footage`: 'ok' a real clip, 'missing' a row pointing at nothing on disk,
 * 'garbage' a file that is not media, false no row at all.
 */
function makeFilm(specs) {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)').run(projectId, 'Walk');
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')").run(sceneId, projectId);
    const shots = [];
    specs.forEach((s, i) => {
        const shotId = generateId();
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, ?, '{}', 0, ?)`)
            .run(shotId, sceneId, s.code, i);
        let file = null;
        if (s.footage === 'ok') file = clip(`${projectId.slice(0, 6)}_${s.code}.mp4`);
        if (s.footage === 'missing') file = path.join(TMP, `${projectId.slice(0, 6)}_${s.code}_gone.mp4`);
        if (s.footage === 'garbage') { file = path.join(TMP, `${projectId.slice(0, 6)}_${s.code}_bad.mp4`); fs.writeFileSync(file, 'this is not a video'); }
        if (file) {
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms)
                        VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1000)`).run(generateId(), projectId, shotId, file, path.basename(file));
        }
        shots.push({ id: shotId, code: s.code });
    });
    return { projectId, sceneId, shots };
}

/** The failure states this suite can construct, and how. Each is real. */
const CONSTRUCT = {
    missing_shots: () => ({ film: makeFilm([{ code: '1A', footage: 'ok' }, { code: '1B', footage: false }]) }),
    missing_clip: () => ({ film: makeFilm([{ code: '1A', footage: 'missing' }]) }),
    invalid_clip: () => ({ film: makeFilm([{ code: '1A', footage: 'garbage' }]) }),
    // The rights policy refusing the score the master would carry (MUS-022): an approved session whose mix
    // a person marked blocked. Refused at the plan, like a missing shot — no executor is consulted.
    rights_blocked: () => {
        const film = makeFilm([{ code: '1A', footage: 'ok' }]);
        const mix = path.join(TMP, `${film.projectId.slice(0, 6)}_mix.wav`); fs.writeFileSync(mix, 'the mix bytes are never read');
        const assetId = generateId(), sessionId = generateId();
        db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, duration_ms, metadata) VALUES (?, ?, 'audio_mix', ?, 'mix.wav', 'wav', 1000, '{\"kind\":\"bounce_master\"}')").run(assetId, film.projectId, mix);
        db.prepare("INSERT INTO film_rights (id, project_id, entity_type, entity_id, subject, rights_type, status) VALUES (?, ?, 'music', ?, 'mix', 'music_license', 'blocked')").run(generateId(), film.projectId, assetId);
        db.prepare("INSERT INTO film_music_sessions (id, project_id, scene_id, name, status, approved_mix_asset_id, approved_at) VALUES (?, ?, ?, 'S', 'approved', ?, datetime('now'))").run(sessionId, film.projectId, film.sceneId, assetId);
        return { film };
    },
    no_executor: () => ({
        film: makeFilm([{ code: '1A', footage: 'ok' }]),
        opts: { probe: () => ({ any: false, executors: [
            { id: 'local-ffmpeg', available: false, reason: 'no encoder on this machine' },
            { id: 'provider-stitch', available: false, reason: 'no provider serves the post capability' },
        ] }) },
    }),
};

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const res = {
            statusCode: 200, writableEnded: false, socket: null,
            writeHead(c) { this.statusCode = c; return this; },
            setHeader() {}, on() {},
            write(p) { chunks.push(String(p)); return true; },
            end(p) {
                if (p) chunks.push(String(p));
                this.writableEnded = true;
                const raw = chunks.join('');
                if (raw.includes('data: ')) {
                    const events = raw.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
                    resolve({ status: this.statusCode, body: events.find(e => e.type === 'result') || {}, events });
                } else resolve({ status: this.statusCode, body: JSON.parse(raw || '{}'), events: [] });
            },
        };
        const parts = url.split('/').filter(Boolean);
        const handler = parts[1] === 'projects' && parts[3] === 'conform'
            ? require('../routes/production-reports').handleProductionReports
            : pipeline.handlePipeline;
        Promise.resolve(handler({ method, url, body: body || {} }, res, parts, {})).catch(reject);
    });
}

async function settle(runId) {
    const started = Date.now();
    while (Date.now() - started < 30000) {
        const r = (await call('GET', `/film/pipeline/${runId}`)).body;
        if (!['running', 'pending', 'paused'].includes(r.status)) return r;
        await new Promise(r2 => setTimeout(r2, 30));
    }
    throw new Error('run never settled');
}

function assertWalk(walk, label) {
    assert.ok(Array.isArray(walk), `${label}: no walk on the failure`);
    for (const w of walk) {
        assert.ok(w.executor, `${label}: a walk entry names no executor`);
        assert.strictEqual(typeof w.available, 'boolean', `${label}: ${w.executor} does not say whether it was available`);
        assert.strictEqual(typeof w.attempted, 'boolean', `${label}: ${w.executor} does not say whether it was tried`);
        if (!w.attempted) assert.ok(w.reason, `${label}: ${w.executor} was not tried and does not say why`);
        if (w.attempted) assert.ok(w.error, `${label}: ${w.executor} was tried, failed, and carries no error`);
    }
}

// ── Every failure state carries the walk ───────────────────────────────────

test('every failure the conform can return carries the walk, and the error names each executor', async () => {
    assert.ok(FAILURE_STATES.length >= 5, `only ${FAILURE_STATES} failure states known`);
    // Every constructible state is exercised; every state the registry knows
    // and this suite cannot construct is named, so a new one is not silently
    // untested.
    const unconstructed = FAILURE_STATES.filter(s => !CONSTRUCT[s]);
    assert.deepStrictEqual(unconstructed.sort(), ['failed', 'no_clips'],
        `states with no construction here: ${unconstructed} — add one, or record why it cannot be built`);

    for (const [state, build] of Object.entries(CONSTRUCT)) {
        const { film, opts } = build();
        const r = await conform.runConform(film.projectId, opts || {});
        assert.strictEqual(r.ok, false, `${state}: the fixture did not fail`);
        assert.strictEqual(r.state, state, `${state}: fixture produced '${r.state}' instead`);
        assertWalk(r.walk, state);

        if (state === 'missing_shots' || state === 'rights_blocked') {
            // Refused at the plan: no executor was consulted, and the walk
            // says so rather than pretending one was.
            assert.strictEqual(r.walk.length, 0, 'a plan refusal walked executors it never reached');
            assert.strictEqual(r.walk_stage, 'plan');
            continue;
        }
        assert.strictEqual(r.walk_stage, 'execute');
        // Every executor the probe knows is in the walk, in the probe's order.
        const probed = (opts && opts.probe ? opts.probe() : conform.availableExecutors()).executors.map(e => e.id);
        assert.deepStrictEqual(r.walk.map(w => w.executor), probed, `${state}: the walk does not cover every executor`);
        const attempted = r.walk.filter(w => w.attempted);
        assert.ok(attempted.length <= 1, `${state}: ${attempted.length} executors attempted — the conform runs one`);
        if (state !== 'no_executor') assert.strictEqual(attempted.length, 1, `${state}: nothing was attempted yet the join failed`);
        // The error a person reads names each executor and what became of it.
        for (const w of r.walk) assert.ok(r.error.includes(w.executor), `${state}: the error does not mention ${w.executor}: ${r.error}`);
    }
});

// ── Source: no failure return leaves without the walk ──────────────────────

test('no failure return in runConform leaves without a walk', () => {
    const body = CONFORM_SRC.slice(CONFORM_SRC.indexOf('async function runConform'), CONFORM_SRC.indexOf('module.exports'));
    const returns = body.match(/return \{[^}]*ok: false[\s\S]*?\};/g) || [];
    assert.ok(returns.length >= 3, `found only ${returns.length} failure returns`);
    for (const ret of returns) {
        assert.match(ret, /walk/, `a failure return carries no walk:\n${ret}`);
    }
});

// ── Every call site forwards it ────────────────────────────────────────────

test('every place a conform failure passes through forwards the walk', async () => {
    // Derived from the source: who calls runConform outside its own module.
    const callers = [];
    for (const dir of ['routes', 'lib']) {
        for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) {
            if (!f.endsWith('.js') || (dir === 'lib' && f === 'conform.js')) continue;
            const src = fs.readFileSync(path.join(__dirname, '..', dir, f), 'utf8');
            if (/\brunConform\(/.test(src)) callers.push(`${dir}/${f}`);
        }
    }
    assert.deepStrictEqual(callers.sort(), ['routes/pipeline.js', 'routes/production-reports.js'],
        'the set of conform callers drifted; each new one must forward the walk');

    // The route: the body a client reads.
    const viaRoute = makeFilm([{ code: '1A', footage: 'missing' }]);
    const res = await call('POST', `/film/projects/${viaRoute.projectId}/conform`, {});
    assert.strictEqual(res.status, 409);
    assertWalk(res.body.walk, 'route');
    assert.ok(res.body.walk.length >= 2, 'the route dropped the walk');

    // The orchestrator, streamed: the event a page reads.
    const viaStream = makeFilm([{ code: '1A', footage: 'missing' }]);
    const stream = await call('POST', `/film/shots/${viaStream.shots[0].id}/pipeline/run/stream`,
        { skip_steps: GENERATIVE, include_project_steps: true, ignore_preflight: true });
    const failed = stream.events.find(e => e.type === 'step_failed' && e.step_id === 'assembly');
    assert.ok(failed, 'no step_failed event for assembly');
    assert.ok(failed.error, 'the step_failed event carries no error');
    assertWalk(failed.walk, 'stream');
    assert.ok(failed.walk.length >= 2, 'the stream dropped the walk');

    // The orchestrator, JSON: the response a caller reads.
    const viaJson = makeFilm([{ code: '1A', footage: 'missing' }]);
    const json = await call('POST', `/film/shots/${viaJson.shots[0].id}/pipeline/run`,
        { skip_steps: GENERATIVE, include_project_steps: true, ignore_preflight: true });
    const failure = (json.body.failures || []).find(f => f.step === 'assembly');
    assert.ok(failure, `the JSON run reports no failure detail: ${JSON.stringify(json.body)}`);
    assertWalk(failure.walk, 'json');
    assert.ok(failure.walk.length >= 2, 'the JSON runner dropped the walk');

    // The orchestrator, background: the run row a person reads later.
    const viaRow = makeFilm([{ code: '1A', footage: 'missing' }]);
    const started = await call('POST', `/film/projects/${viaRow.projectId}/pipeline/run`,
        { skip_steps: GENERATIVE, ignore_preflight: true });
    assert.strictEqual(started.status, 202, JSON.stringify(started.body));
    const row = await settle(started.body.run_id);
    assert.strictEqual(row.status, 'failed');
    assert.ok(row.error_message && /assembly/.test(row.error_message), `the run row says nothing about what failed: ${row.error_message}`);
    for (const e of conform.availableExecutors().executors) {
        assert.ok(row.error_message.includes(e.id), `the run row's error does not name ${e.id}: ${row.error_message}`);
    }
    const failures = row.failures || [];
    assert.ok(failures.some(f => /assembly$/.test(f.step) && Array.isArray(f.walk) && f.walk.length >= 2),
        `the run row carries no structured walk: ${JSON.stringify(failures)}`);
});
