/**
 * The preflight must cover the whole road, not the part someone remembered.
 *
 * A readiness check that silently omits a stage is worse than none: it returns
 * "ready" and the run dies at the omitted step, which is exactly the outcome it
 * was added to prevent. So the coverage assertions here are set-based over
 * PIPELINE_STEPS and STEP_CAPABILITY — add a tenth pipeline step and this fails
 * until the preflight sees it.
 *
 * Also pins the finding that motivated the check: a project pointing at a
 * provider that no longer exists resolves to the fallback WITHOUT error, so
 * "it resolved" is not evidence that anything works.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-e2e-' + crypto.randomUUID().slice(0, 8));
// A refused run retries nothing; a refused conform is permanent. Do not sleep.
process.env.FILM_RETRY_BACKOFF_MS = '1';

const { ensureSchema } = require('../db/schema');
ensureSchema();

const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
const { STEP_CAPABILITY } = require('../routes/pipeline');
const { CAPABILITIES } = require('../lib/providers/base');
const providers = require('../lib/providers');
const {
    preflight, stages, checkCapability, checkDependency, checkStageDependency, DEPENDENCY_CHECKS,
} = require('../lib/e2e-preflight');
const fs = require('fs');
const { db, generateId } = require('../db/database');
const pipeline = require('../routes/pipeline');

const STAGES = stages();
const byId = new Map(STAGES.map(s => [s.id, s]));

// ── Coverage ────────────────────────────────────────────────────────────────

test('every pipeline step is a preflight stage', () => {
    const missing = PIPELINE_STEPS.map(s => s.id).filter(id => !byId.has(id));
    assert.deepStrictEqual(missing, [], `pipeline steps the preflight never checks: ${missing.join(', ')}`);
});

test('every generating step carries the capability it will resolve', () => {
    const wrong = [];
    for (const [stepId, capability] of Object.entries(STEP_CAPABILITY)) {
        const stage = byId.get(stepId);
        if (!stage) { wrong.push({ stepId, why: 'no stage' }); continue; }
        if (stage.capability !== capability) wrong.push({ stepId, expected: capability, got: stage.capability });
    }
    assert.deepStrictEqual(wrong, [], JSON.stringify(wrong));
});

test('the step with no capability is assembly, which runs locally', () => {
    const local = PIPELINE_STEPS.map(s => s.id).filter(id => !STEP_CAPABILITY[id]);
    assert.deepStrictEqual(local, ['assembly'],
        'a step lost its capability mapping, or a new local step appeared unreviewed');
    assert.strictEqual(byId.get('assembly').capability, null);
});

test('the stages either side of the pipeline are present', () => {
    // Getting to a shot and getting out of one both have to work for an
    // end-to-end test to mean anything.
    for (const id of ['project', 'script', 'breakdown', 'shots', 'mix', 'export']) {
        assert.ok(byId.has(id), `preflight is missing the '${id}' stage`);
    }
    assert.strictEqual(byId.get('breakdown').capability, 'llm');
});

test('stages are ordered so nothing is checked before what it depends on', () => {
    const position = new Map(STAGES.map((s, i) => [s.id, i]));
    for (const step of PIPELINE_STEPS) {
        for (const dep of step.depends) {
            assert.ok(position.get(dep) < position.get(step.id),
                `${step.id} is checked before its dependency ${dep}`);
        }
    }
});

// ── The finding this exists to catch ────────────────────────────────────────

test('a configured provider that is not registered is reported, not silently swapped', async () => {
    const ghost = 'a-provider-that-was-deleted';
    assert.ok(!providers.get(ghost), 'test fixture is no longer a ghost');

    const result = await checkCapability('image', { image: ghost }, {});
    assert.strictEqual(result.verdict, 'blocked');
    assert.ok(result.reasons.some(r => r.includes(ghost)), 'the dead provider is not named in the reason');
    assert.notStrictEqual(result.effective, ghost, 'effective should name what would really run');
});

test('resolveGenerator really does swap silently — the behaviour being guarded', () => {
    /*
     * Not a redundant check: it is the reason the preflight cannot simply trust
     * that resolution succeeded.
     *
     * The swap target CHANGED. It used to be the local gateway — a service that
     * may not be running, reached silently — and with the gateway off it is a
     * refusing adapter that answers every generate with what is missing. Still
     * a silent swap at resolution time, which is what the preflight exists to
     * catch; the difference is that spending against it now fails in words
     * rather than at a socket.
     */
    const adapter = providers.resolveGenerator('image', { image: 'a-provider-that-was-deleted' });
    assert.ok(adapter, 'resolution threw or returned nothing');
    assert.notStrictEqual(adapter.id, 'a-provider-that-was-deleted',
        'a dead provider resolved to itself, so the preflight has nothing to catch');
    assert.ok(adapter.unavailable || adapter.id === 'gridlight',
        `swapped to "${adapter.id}" — neither the gateway nor a refusal, so the preflight `
        + 'message needs updating');
});

test('a capability whose provider does not serve it is blocked', async () => {
    // meshy is model3d-only. Pointing video at it must not read as ready.
    const result = await checkCapability('video', { video: 'meshy' }, {});
    assert.strictEqual(result.verdict, 'blocked');
});

// ── Whole-report behaviour ──────────────────────────────────────────────────

test('preflight returns a verdict for every stage and never invents one', async () => {
    const report = await preflight({ projectConfig: {}, hasDialogue: true });
    assert.strictEqual(report.stages.length, STAGES.length);
    assert.deepStrictEqual(report.stages.map(s => s.id), STAGES.map(s => s.id));

    const legal = new Set(['go', 'skipped', 'handoff', 'blocked']);
    const odd = report.stages.filter(s => !legal.has(s.verdict));
    assert.deepStrictEqual(odd, []);

    const { go, skipped, handoff, blocked, total } = report.summary;
    assert.strictEqual(go + skipped + handoff + blocked, total,
        'the summary does not add up — a verdict is uncounted, which would hide stages');
    assert.strictEqual(report.ready, blocked === 0);
});

test('a silent screenplay demotes voice and lipsync from blockers to skips', async () => {
    // autoSkipSteps drops both when a scene card has no dialogue, so reporting
    // them as blockers would send someone chasing a provider they never use.
    // inEngine, because lipsync is otherwise handed to the NLE before the
    // dialogue question is even reached — this asserts the auto-skip itself.
    const config = { voice: 'a-provider-that-was-deleted', lipsync: 'a-provider-that-was-deleted' };

    const speaking = await preflight({ projectConfig: config, hasDialogue: true, inEngine: true });
    const silent = await preflight({ projectConfig: config, hasDialogue: false, inEngine: true });

    for (const id of ['voice', 'lipsync']) {
        assert.strictEqual(speaking.stages.find(s => s.id === id).verdict, 'blocked');
        assert.strictEqual(silent.stages.find(s => s.id === id).verdict, 'skipped');
    }
    assert.ok(silent.summary.blocked < speaking.summary.blocked);
});

test('every capability the E2E path needs is one the provider layer knows', () => {
    // Guards a typo in STEP_CAPABILITY that would resolve to the default
    // provider for a capability nothing actually serves.
    const needed = [...new Set([...Object.values(STEP_CAPABILITY), 'llm'])];
    const unknown = needed.filter(c => !CAPABILITIES.includes(c));
    assert.deepStrictEqual(unknown, [], `capabilities unknown to the provider layer: ${unknown.join(', ')}`);
    assert.strictEqual(needed.length, 9, 'the E2E path needs 9 capabilities; that changed');
});

// ── Finishing in the NLE ────────────────────────────────────────────────────

const { HANDOFF } = require('../lib/e2e-preflight');
const { AUDIO_LANES } = require('../lib/nle-export');

test('the handed-off stages are exactly the three with no in-engine provider', () => {
    // lipsync and post are served by no adapter but gridlight, and the mix POSTs
    // to gridlight too. If an adapter ever serves one of them, this list should
    // shrink rather than quietly keep excusing it.
    assert.deepStrictEqual(Object.keys(HANDOFF).sort(), ['lipsync', 'mix', 'post']);
    for (const id of Object.keys(HANDOFF)) {
        assert.ok(byId.has(id), `handoff names '${id}', which is not a stage`);
    }
});

test('handed-off stages do not count as blocked, and say where they happen', async () => {
    const report = await preflight({ projectConfig: {}, hasDialogue: true });
    for (const id of Object.keys(HANDOFF)) {
        const stage = report.stages.find(s => s.id === id);
        assert.strictEqual(stage.verdict, 'handoff', `${id} should be handed off`);
        assert.ok(stage.reasons.length, `${id} is handed off without saying where`);
    }
    assert.ok(!report.blocked.some(b => HANDOFF[b.id]));
});

test('--in-engine still holds the handed-off stages to a real provider', async () => {
    // The handoff must be a choice, not a way of never checking again.
    const report = await preflight({ projectConfig: {}, hasDialogue: true, inEngine: true });
    for (const id of Object.keys(HANDOFF)) {
        assert.notStrictEqual(report.stages.find(s => s.id === id).verdict, 'handoff');
    }
});

test('the handoff is only honest if every audio element reaches the timeline', () => {
    // The three handed-off stages are all finished against the exported lanes,
    // so a missing lane makes the handoff a lie. Pinned here as well as in
    // nle-export.test.js because this is the file that grants the exemption.
    assert.deepStrictEqual(
        AUDIO_LANES.map(l => l.type).sort(),
        ['audio_ambient', 'audio_dialogue', 'audio_music', 'audio_sfx'],
    );
});

// ── A declared dependency blocks a run, before the run ──────────────────────

/**
 * SHIP-005. `assembly` declares `ffmpeg` and the preflight probes it — through
 * a resolver nothing could inject, so the one branch that turns "no encoder"
 * into a blocked stage was never exercised: replacing its verdict with 'go'
 * failed no test. And the preflight is a CLI a person may not run; the runner
 * itself happily spent every generation step and found out at the END that
 * the film could not be joined. Set-based over the stages that declare a
 * dependency, and over the ways a run can be started.
 */
const DEPENDENT = STAGES.filter(s => s.externalDependency);
const unavailable = () => ({ available: false, reason: 'no encoder anywhere on this machine' });
const available = () => ({ available: true, bin: '/opt/x/ffmpeg', source: 'path' });

test('every stage that declares a dependency has a checker, and an undeclared one is blocked', () => {
    assert.ok(DEPENDENT.length, 'no stage declares an external dependency: the rest of this file would pass over nothing');
    for (const stage of DEPENDENT) {
        assert.ok(DEPENDENCY_CHECKS[stage.externalDependency],
            `${stage.id} declares '${stage.externalDependency}' and nothing knows how to check it`);
    }
    // A dependency nobody registered a checker for must not read as ready.
    const v = checkDependency('nothing-registered-here');
    assert.strictEqual(v.verdict, 'blocked');
    assert.match(v.reasons.join(' '), /nothing-registered-here/);
    assert.strictEqual(checkStageDependency('keyframe'), null, 'a stage with no dependency has no verdict to give');
});

test('a missing dependency blocks its stage in the report, with the remedies; a present one is go', async () => {
    assert.ok(DEPENDENT.length);
    for (const stage of DEPENDENT) {
        const dep = stage.externalDependency;
        const blocked = await preflight({ projectConfig: {}, hasDialogue: true, resolvers: { [dep]: unavailable } });
        const row = blocked.stages.find(s => s.id === stage.id);
        assert.strictEqual(row.verdict, 'blocked', `${stage.id} not blocked with no ${dep}`);
        assert.match(row.reasons.join(' '), /no encoder anywhere/, `${stage.id}: the probe's own reason is not reported`);
        for (const remedy of ['FFMPEG_PATH', 'system PATH', 'ffmpeg-static']) {
            assert.match(row.fixes.join(' '), new RegExp(remedy), `${stage.id}: blocked without naming the ${remedy} remedy`);
        }
        assert.strictEqual(blocked.ready, false, 'the report says ready while a stage is blocked');
        assert.ok(blocked.blocked.some(b => b.id === stage.id));

        const ok = await preflight({ projectConfig: {}, hasDialogue: true, resolvers: { [dep]: available } });
        assert.strictEqual(ok.stages.find(s => s.id === stage.id).verdict, 'go');
    }
});

/** The ways a run can be started, from the router's own dispatch. */
function entryPoints() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8');
    const out = [];
    const re = /urlParts\[1\] === '(shots|scenes|projects)'[\s\S]*?urlParts\[4\] === 'run'[\s\S]*?\n\s*\}/g;
    let m;
    while ((m = re.exec(src))) {
        out.push({ owner: m[1], stream: false });
        if (/urlParts\[5\] === 'stream'/.test(m[0])) out.push({ owner: m[1], stream: true });
    }
    return out;
}

function makeFilm() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Gate');
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')").run(sceneId, projectId);
    const shotId = generateId();
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, '1A', '{}', 0, 0)`)
        .run(shotId, sceneId);
    return { projectId, sceneId, shotId };
}

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
        Promise.resolve(pipeline.handlePipeline({ method, url, body: body || {} }, res, url.split('/').filter(Boolean), {}))
            .catch(reject);
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

const GENERATIVE = PIPELINE_STEPS.filter(s => s.scope !== 'project').map(s => s.id);
const runsCount = projectId => db.prepare('SELECT COUNT(*) AS n FROM film_pipeline_runs WHERE project_id = ?').get(projectId).n;

test('a run that would make the film is refused before it starts when the dependency is missing', async () => {
    const points = entryPoints();
    assert.deepStrictEqual(points.map(e => `${e.owner}${e.stream ? '/stream' : ''}`).sort(),
        ['projects', 'scenes', 'shots', 'shots/stream']);
    assert.ok(DEPENDENT.length);
    const saved = {};
    for (const stage of DEPENDENT) {
        saved[stage.externalDependency] = DEPENDENCY_CHECKS[stage.externalDependency].resolve;
        DEPENDENCY_CHECKS[stage.externalDependency].resolve = unavailable;
    }
    try {
        for (const entry of points) {
            const label = `${entry.owner}${entry.stream ? '/stream' : ''}`;
            const film = makeFilm();
            const owner = { shots: film.shotId, scenes: film.sceneId, projects: film.projectId }[entry.owner];
            const url = `/film/${entry.owner}/${owner}/pipeline/run${entry.stream ? '/stream' : ''}`;
            // Asked for the film (a project run asks by default).
            const asked = entry.owner === 'projects' ? {} : { include_project_steps: true };

            const refused = await call('POST', url, { skip_steps: GENERATIVE, ...asked });
            assert.strictEqual(refused.status, 409, `${label}: ${refused.status} ${JSON.stringify(refused.body)}`);
            assert.strictEqual(refused.body.code, 'PREFLIGHT_BLOCKED', label);
            assert.match(refused.body.error, /no encoder anywhere/, `${label}: the refusal does not carry the probe's reason`);
            for (const remedy of ['FFMPEG_PATH', 'system PATH', 'ffmpeg-static']) {
                assert.match((refused.body.fixes || []).join(' '), new RegExp(remedy), `${label}: refused without naming the ${remedy} remedy`);
            }
            assert.strictEqual(runsCount(film.projectId), 0, `${label}: a refused run left a run row`);

            // Not asked for the film: nothing to preflight, the run starts.
            if (entry.owner !== 'projects') {
                const quiet = await call('POST', url, { skip_steps: GENERATIVE });
                assert.notStrictEqual(quiet.status, 409, `${label}: refused a run that would not make the film`);
                if (quiet.status === 202) await settle(quiet.body.run_id);
            }

            // Overridable, the way every other gate here is — and the refusal
            // then arrives from the step itself, honestly, at the end.
            const forced = await call('POST', url, { skip_steps: GENERATIVE, ...asked, ignore_preflight: true });
            assert.notStrictEqual(forced.status, 409, `${label}: ignore_preflight did not get past the gate`);
            const outcome = forced.status === 202 ? await settle(forced.body.run_id) : forced.body;
            assert.strictEqual(outcome.status, 'failed', `${label}: forced run reported ${outcome.status}`);
        }
    } finally {
        for (const [dep, fn] of Object.entries(saved)) DEPENDENCY_CHECKS[dep].resolve = fn;
    }
});

test('with the dependency present the same runs are not refused', async () => {
    assert.ok(DEPENDENT.length);
    const saved = {};
    for (const stage of DEPENDENT) {
        saved[stage.externalDependency] = DEPENDENCY_CHECKS[stage.externalDependency].resolve;
        DEPENDENCY_CHECKS[stage.externalDependency].resolve = available;
    }
    try {
        const film = makeFilm();
        const res = await call('POST', `/film/projects/${film.projectId}/pipeline/run`, { skip_steps: GENERATIVE });
        assert.notStrictEqual(res.status, 409, JSON.stringify(res.body));
        if (res.status === 202) await settle(res.body.run_id);
    } finally {
        for (const [dep, fn] of Object.entries(saved)) DEPENDENCY_CHECKS[dep].resolve = fn;
    }
});
