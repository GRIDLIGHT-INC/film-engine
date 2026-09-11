const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * THE FILM IS MADE ONCE, AT THE END — AND A RUN WITHOUT A FILM IS FAILED.
 *
 * SHIP-003. `assembly` stopped returning a hardcoded success and started
 * calling the conform. That closed the lie in the step and opened three more
 * one level up, all of them from one fact: the registry declared assembly
 * `scope: 'shot'`, and the runner does what the registry says.
 *
 *   1. A project run conformed the WHOLE FILM once per shot. On a fresh run
 *      the first N-1 attempts necessarily refused (later shots had no footage
 *      yet), each was retried three times with backoff, and the run ended
 *      `completed_with_errors` even when the last conform made the film.
 *   2. A single-shot run conformed the whole film too, and refused, so every
 *      shot run during production reported errors about a film nobody had
 *      asked for yet — the warning you learn to ignore.
 *   3. A refusal was retried as if it were a provider hiccup. The conform is
 *      local and deterministic: the same files give the same answer.
 *
 * The rule is the one scene scope already established: a step runs by default
 * on runs AT OR ABOVE its scope, once, and is skipped WITH A REASON below it
 * unless the caller opts in. Assembly's product is the film, so its scope is
 * the project.
 *
 * Set-based three ways, because each failure was partial:
 *  - over the PROJECT-SCOPED steps, read from the registry;
 *  - over the RUN ENTRY POINTS, read from the router's own dispatch;
 *  - over every OUTCOME STATE the conform can return, read from its source.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-assembly-' + crypto.randomUUID().slice(0, 8));
// A refusal is not retried at all now; for anything that IS, do not sleep.
process.env.FILM_RETRY_BACKOFF_MS = '1';

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
const pipeline = require('../routes/pipeline');
const { resolveFfmpeg } = require('../lib/ffmpeg');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8');

/** What runs once for the whole film, from the registry. */
const PROJECT_SCOPED = PIPELINE_STEPS.filter(s => s.scope === 'project').map(s => s.id);
/** Everything that spends at a provider — skipped in every run here. */
const GENERATIVE = PIPELINE_STEPS.filter(s => s.scope !== 'project').map(s => s.id);

/**
 * The ways a run can be started, DERIVED from the router rather than listed:
 * a fifth entry point added later must obey the same rule or fail here.
 */
function entryPoints() {
    const out = [];
    const re = /urlParts\[1\] === '(shots|scenes|projects)'[\s\S]*?urlParts\[4\] === 'run'[\s\S]*?\n\s*\}/g;
    let m;
    while ((m = re.exec(ROUTE_SRC))) {
        const owner = m[1];
        out.push({ owner, stream: false });
        if (/urlParts\[5\] === 'stream'/.test(m[0])) out.push({ owner, stream: true });
    }
    return out;
}

const bin = () => resolveFfmpeg().bin;
let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-assembly-clips-')); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

function clip(name, secs) {
    const p = path.join(TMP, name);
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=160x120:d=${secs}`,
        '-c:v', 'libx264', '-r', '24', '-t', String(secs), '-pix_fmt', 'yuv420p', p], { stdio: 'pipe', timeout: 120000 });
    return p;
}

/** A film of N shots in one scene; `footage: false` leaves a shot with no clip. */
function makeFilm(specs) {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps) VALUES (?, ?, 24)').run(projectId, 'Once');
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    const shots = [];
    specs.forEach((s, i) => {
        const shotId = generateId();
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order)
                    VALUES (?, ?, ?, ?, 0, ?)`)
            .run(shotId, sceneId, s.code, JSON.stringify({ shot_code: s.code, camera: {} }), i);
        if (s.footage !== false) {
            const file = clip(`${projectId.slice(0, 6)}_${s.code}.mp4`, 1);
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms)
                        VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1000)`)
                .run(generateId(), projectId, shotId, file, path.basename(file));
        }
        shots.push({ id: shotId, code: s.code });
    });
    return { projectId, sceneId, shots };
}

const masters = projectId => db.prepare(
    `SELECT * FROM film_assets WHERE project_id = ? AND metadata LIKE '%"kind":"project_master"%' ORDER BY version`)
    .all(projectId);

/** Call the router in-process, capturing a JSON answer or an SSE stream. */
function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const res = {
            statusCode: 200, writableEnded: false, socket: null,
            writeHead(s) { this.statusCode = s; return this; },
            setHeader() {}, on() {},
            write(p) { chunks.push(String(p)); return true; },
            end(p) {
                if (p) chunks.push(String(p));
                this.writableEnded = true;
                const raw = chunks.join('');
                if (raw.includes('data: ')) {
                    const events = raw.split('\n\n').filter(l => l.startsWith('data: '))
                        .map(l => JSON.parse(l.slice(6)));
                    resolve({ status: this.statusCode, events, body: events.find(e => e.type === 'result') || {} });
                } else {
                    resolve({ status: this.statusCode, body: JSON.parse(raw || '{}'), events: [] });
                }
            },
        };
        const parts = url.split('/').filter(Boolean);
        Promise.resolve(pipeline.handlePipeline({ method, url, body: body || {} }, res, parts, {}))
            .catch(reject);
    });
}

/** Background runs answer 202; wait for the row to settle, boundedly. */
async function settle(runId, timeoutMs = 60000) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
        last = (await call('GET', `/film/pipeline/${runId}`)).body;
        if (!['running', 'pending', 'paused'].includes(last.status)) return last;
        await new Promise(r => setTimeout(r, 40));
    }
    throw new Error(`run ${runId} never settled: last status ${last && last.status}`);
}

/** Start a run through one entry point and return its settled outcome. */
async function run(entry, film, body) {
    const owner = { shots: film.shots[0].id, scenes: film.sceneId, projects: film.projectId }[entry.owner];
    const url = `/film/${entry.owner}/${owner}/pipeline/run${entry.stream ? '/stream' : ''}`;
    const res = await call('POST', url, { skip_steps: GENERATIVE, ...(body || {}) });
    if (res.status === 202) return { ...(await settle(res.body.run_id)), events: [] };
    return { ...res.body, events: res.events };
}

const stepOf = entry => entry.replace(/^.*:/, '');
const tally = (list, stepId) => (list || []).filter(e => stepOf(e) === stepId).length;

// ── The registry ───────────────────────────────────────────────────────────

test('the deliverable step is project-scoped in the registry, and there is one', () => {
    assert.ok(PROJECT_SCOPED.includes('assembly'),
        `assembly is scoped '${PIPELINE_STEPS.find(s => s.id === 'assembly').scope}' — the film is not a property of one shot`);
    assert.ok(PROJECT_SCOPED.length >= 1);
    assert.ok(GENERATIVE.length >= 8, 'the generative set lost steps; the skip list would be wrong');
});

test('the router exposes exactly the entry points this suite derives', () => {
    const found = entryPoints().map(e => `${e.owner}${e.stream ? '/stream' : ''}`).sort();
    assert.deepStrictEqual(found, ['projects', 'scenes', 'shots', 'shots/stream'],
        'the entry-point scan drifted from the router; every assertion below runs over it');
});

// ── Once, at the end, on a project run ─────────────────────────────────────

test('a project run makes the film exactly once, after every shot, and is complete', async () => {
    assert.ok(PROJECT_SCOPED.length, 'no project-scoped step in the registry: this test would pass over an empty set');
    for (const stepId of PROJECT_SCOPED) {
        const film = makeFilm([{ code: '1A' }, { code: '1B' }, { code: '1C' }]);
        const out = await run({ owner: 'projects', stream: false }, film);
        assert.strictEqual(tally(out.steps_completed, stepId), 1,
            `${stepId} completed ${tally(out.steps_completed, stepId)} times on a 3-shot run: ${JSON.stringify(out.steps_completed)}`);
        assert.strictEqual(tally(out.steps_failed, stepId), 0, `${stepId} failed on a film that has every clip`);
        const rows = masters(film.projectId);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].version, 1,
            `the master is at version ${rows[0].version}: the conform ran once per shot, not once per film`);
        assert.strictEqual(out.status, 'complete', JSON.stringify(out));
    }
});

// ── Below its scope: skipped with a reason, unless asked ───────────────────

test('shot and scene runs do not make the film unless asked, and say so', async () => {
    assert.ok(PROJECT_SCOPED.length, 'no project-scoped step in the registry: this test would pass over an empty set');
    for (const entry of entryPoints().filter(e => e.owner !== 'projects')) {
        for (const stepId of PROJECT_SCOPED) {
            const film = makeFilm([{ code: '1A' }, { code: '1B' }]);
            const out = await run(entry, film);
            const label = `${entry.owner}${entry.stream ? '/stream' : ''}`;
            assert.strictEqual(tally(out.steps_completed, stepId), 0, `${label}: ${stepId} ran uninvited`);
            assert.strictEqual(tally(out.steps_failed, stepId), 0, `${label}: ${stepId} failed uninvited`);
            assert.strictEqual(masters(film.projectId).length, 0, `${label}: a master was made by a ${entry.owner} run`);
            assert.strictEqual(out.status, 'complete', `${label}: ${JSON.stringify(out)}`);

            // Reported, never silent — and the reason names the way in.
            const skipped = entry.stream
                ? out.events.filter(e => e.type === 'step_skipped' && e.step_id === stepId).map(e => e.reason)
                : (out.steps_skipped || []).filter(sk => stepOf(sk.step_id || sk) === stepId).map(sk => sk.reason || '');
            assert.strictEqual(skipped.length, 1, `${label}: ${stepId} skipped ${skipped.length} times (once expected)`);
            assert.match(skipped[0], /include_project_steps/, `${label}: the skip does not say how to opt in`);

            // Opting in makes the film, once.
            const asked = await run(entry, film, { include_project_steps: true });
            assert.strictEqual(tally(asked.steps_completed, stepId), 1, `${label}: opted in and ${stepId} ran ${tally(asked.steps_completed, stepId)} times`);
            assert.strictEqual(masters(film.projectId).length, 1);
            assert.strictEqual(masters(film.projectId)[0].version, 1, `${label}: opted in and the conform ran per shot`);
        }
    }
});

// ── A refusal fails the run and is not retried ─────────────────────────────

test('a conform that cannot make the film fails the run, once, with no retry', async () => {
    assert.ok(PROJECT_SCOPED.length, 'no project-scoped step in the registry: this test would pass over an empty set');
    for (const stepId of PROJECT_SCOPED) {
        const film = makeFilm([{ code: '1A' }, { code: '1B', footage: false }]);

        const streamed = await run({ owner: 'shots', stream: true }, film, { include_project_steps: true });
        assert.strictEqual(tally(streamed.steps_failed, stepId), 1, `stream: ${JSON.stringify(streamed)}`);
        const retries = streamed.events.filter(e => e.type === 'step_retry' && e.step_id === stepId);
        assert.strictEqual(retries.length, 0,
            `${stepId} was retried ${retries.length} times for a refusal that names a missing shot — the same files give the same answer`);
        assert.strictEqual(streamed.status, 'failed',
            `a run with no film reported ${streamed.status}; a complete run with no output is the worse outcome`);

        const project = await run({ owner: 'projects', stream: false }, film);
        assert.strictEqual(tally(project.steps_failed, stepId), 1, JSON.stringify(project));
        assert.strictEqual(project.status, 'failed', `project run with no film reported ${project.status}`);
        assert.strictEqual(masters(film.projectId).length, 0, 'a refused conform registered a master');
    }
});

// ── Every outcome the conform can return is classified ─────────────────────

test('every state the conform can return says whether a second attempt could change it', () => {
    const conformSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'conform.js'), 'utf8');
    const ffmpegSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ffmpeg.js'), 'utf8');
    const stitch = ffmpegSrc.slice(ffmpegSrc.indexOf('async function stitchClips'));
    const states = new Set();
    for (const src of [conformSrc, stitch]) {
        for (const m of src.matchAll(/state: '([a-z_]+)'/g)) states.add(m[1]);
    }
    assert.ok(states.size >= 6, `the state scan found only ${[...states]}`);

    const { CONFORM_STATES } = pipeline;
    assert.ok(CONFORM_STATES && typeof CONFORM_STATES === 'object', 'routes/pipeline.js exports no CONFORM_STATES');
    for (const s of states) {
        assert.ok(s in CONFORM_STATES, `conform can return '${s}' and the orchestrator has not decided whether to retry it`);
        assert.strictEqual(typeof CONFORM_STATES[s].permanent, 'boolean', `'${s}' is classified without a verdict`);
    }
    // The conform is local and deterministic; only the encoder itself can
    // fail transiently. A missing shot does not appear on the second try.
    assert.strictEqual(CONFORM_STATES.missing_shots.permanent, true);
    assert.strictEqual(CONFORM_STATES.no_executor.permanent, true);
    assert.strictEqual(CONFORM_STATES.failed.permanent, false);
    for (const s of Object.keys(CONFORM_STATES)) {
        assert.ok(states.has(s), `CONFORM_STATES names '${s}', which nothing returns any more`);
    }
});

// ── One rule for the run's status, and every runner reads it ───────────────

test('a failed deliverable step fails the run; a failed shot step does not', () => {
    const { runStatus } = pipeline;
    assert.strictEqual(typeof runStatus, 'function', 'routes/pipeline.js exports no runStatus');
    assert.strictEqual(runStatus({ failed: [], projectFailed: [] }), 'complete');
    assert.strictEqual(runStatus({ failed: ['1A:sfx'], projectFailed: [] }), 'completed_with_errors');
    for (const stepId of PROJECT_SCOPED) {
        assert.strictEqual(runStatus({ failed: [], projectFailed: [stepId] }), 'failed');
        assert.strictEqual(runStatus({ failed: ['1A:sfx'], projectFailed: [stepId] }), 'failed');
    }
    // No runner decides on its own: the ternary that used to live in each is
    // gone, and the only one left is inside runStatus. Bounded by that
    // function's own braces, never by a character window.
    const at = ROUTE_SRC.indexOf('function runStatus(');
    assert.ok(at >= 0);
    let depth = 0, close = -1;
    // The body's brace, not the destructured parameter's.
    for (let k = ROUTE_SRC.indexOf(') {', at) + 2; k < ROUTE_SRC.length; k++) {
        if (ROUTE_SRC[k] === '{') depth++;
        else if (ROUTE_SRC[k] === '}' && --depth === 0) { close = k; break; }
    }
    const outside = ROUTE_SRC.slice(0, at) + ROUTE_SRC.slice(close + 1);
    const own = outside.match(/\? 'completed_with_errors' : 'complete'/g) || [];
    assert.strictEqual(own.length, 0, `${own.length} runner(s) still decide the status inline instead of through runStatus`);
    const attempts = ROUTE_SRC.match(/for \(let attempt = 0; attempt < MAX_RETRIES/g) || [];
    assert.strictEqual(attempts.length, 1, `${attempts.length} retry loops — the no-retry rule has to hold in every one`);
});
