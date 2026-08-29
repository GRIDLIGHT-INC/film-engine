/**
 * A scene's score is not a property of one shot.
 *
 * Every entry in PIPELINE_STEPS declares a `scope`, and `routes/pipeline.js`
 * contained zero occurrences of the word. The scene and project runners looped
 * shots and ran the whole plan on each one, so `music` and `ambient` — both
 * declared scene-scoped, both built from ctx.scene and identical for every shot
 * in it — were generated once PER SHOT. Measured on a real 13-shot project
 * before the fix: 13 music payloads and 13 ambient payloads for 3 scenes.
 * Nothing failed; you were simply billed 4.3x and the extra rows accumulated.
 *
 * The same reading found something worse sitting beside it: runScenePipeline
 * and runProjectPipeline inserted a run row, answered 202 "running", and
 * executed NOTHING. The row stayed at 'running' forever. So the scope defect
 * lived in a path that also never ran, and fixing one without the other would
 * have been fixing a bug in dead code.
 *
 * This suite is behavioural on purpose. Counting the ASSETS a run registers is
 * the only evidence that survives every way of getting it wrong: a source check
 * for the word `scope` passes against a runner that reads it and ignores it,
 * and counting gateway requests cannot separate music from ambient because the
 * Gridlight adapter posts all three audio capabilities to /music.
 *
 * The scene-scoped set is DERIVED from PIPELINE_STEPS, never typed here: a
 * tenth step declared scene-scoped later is covered with nothing to remember,
 * which is exactly what the first version of this failed to be.
 */
const { describe, it, before, after } = require('node:test');

// The local gateway is off unless switched on. Set before anything requires the
// provider registry, which caches the answer.
process.env.GRIDLIGHT_ENABLED = '1';

const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
const { ASSET_TYPE } = require('../lib/media-kinds');
const { STEP_CAPABILITY } = require('../routes/pipeline');

const TEST_DIR = path.join(os.tmpdir(), 'film-engine-scope-' + crypto.randomUUID().slice(0, 8));
const TEST_PORT = 18400 + Math.floor(Math.random() * 500);
const BASE_URL = `http://localhost:${TEST_PORT}`;
let serverProcess, mockGateway;

/**
 * The asset a step registers, resolved step -> capability -> asset_type.
 *
 * ASSET_TYPE is keyed by CAPABILITY. `music` and `ambient` are spelled the same
 * on both sides and `keyframe` is not — it is the `image` capability — so
 * indexing ASSET_TYPE with a step id works for exactly the steps this suite is
 * about and silently returns undefined for the control case. A count of
 * `undefined` is 0, which reads as "the step did not run" for a step that ran
 * perfectly: the assertion would fail, be believed, and send someone looking
 * for a bug in the fix.
 */
function assetTypeOfStep(stepId) {
    const capability = STEP_CAPABILITY[stepId];
    return capability ? ASSET_TYPE[capability] : null;
}

/** Steps whose product belongs to the SCENE, read from the registry itself. */
const SCENE_STEPS = PIPELINE_STEPS.filter(s => s.scope === 'scene').map(s => s.id);
/** Generation steps that belong to one shot (assembly makes the film, not a shot artefact). */
const SHOT_STEPS = PIPELINE_STEPS
    .filter(s => s.scope === 'shot' && s.id !== 'assembly')
    .map(s => s.id);

function request(urlPath, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.stringify(opts.body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request(`${BASE_URL}${urlPath}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { let p; try { p = JSON.parse(data); } catch { p = data; } resolve({ status: res.statusCode, data: p }); });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function waitForServer(n = 40) {
    for (let i = 0; i < n; i++) {
        try { const r = await request('/api/health'); if (r.status === 200) return; } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Server did not start');
}

/**
 * A run that never finishes is the defect, so waiting forever would hide it.
 * A bounded wait that reports the last status it saw is what distinguishes
 * "still working" from "stuck at running because nothing executes".
 */
async function waitForRun(runId, timeoutMs = 150000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        const r = await request(`/film/pipeline/${runId}`);
        last = r.data;
        if (['complete', 'completed_with_errors', 'failed', 'cancelled'].includes(last.status)) return last;
        await new Promise(r2 => setTimeout(r2, 250));
    }
    return last;
}

/** How many assets of each type this project holds, keyed by asset_type. */
async function assetCounts(projectId) {
    const res = await request(`/film/projects/${projectId}/assets`);
    const counts = {};
    for (const a of (res.data.assets || [])) {
        counts[a.asset_type] = (counts[a.asset_type] || 0) + 1;
    }
    return counts;
}

describe('scene-scoped steps run once per scene, not once per shot', () => {
    let projectId, sceneId, shotIds = [];

    before(async () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        mockGateway = http.createServer((req, res) => {
            let raw = ''; req.on('data', c => raw += c);
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, url: 'mock' }));
            });
        });
        await new Promise(r => mockGateway.listen(0, '127.0.0.1', r));

        serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(TEST_PORT),
                FILM_DATA_DIR: TEST_DIR,
                GRIDLIGHT_URL: `http://127.0.0.1:${mockGateway.address().port}`,
                GRIDLIGHT_API_KEY: 'test',
                RATE_LIMIT_MAX_GENERATION: '1000',
            },
            stdio: 'pipe',
        });
        serverProcess.stderr.on('data', () => {});
        serverProcess.stdout.on('data', () => {});
        await waitForServer();

        const proj = await request('/film/projects', { method: 'POST', body: { title: 'Scope Film', logline: 'x' } });
        projectId = proj.data.id;
        await request(`/film/projects/${projectId}/script`, {
            method: 'POST',
            body: { content: 'Title: Scope\n\nINT. KITCHEN - DAY\n\nJax speaks.\n\nJAX\nHello there.\n', format: 'fountain' },
        });
        const scenes = await request(`/film/projects/${projectId}/scenes`);
        sceneId = (scenes.data.scenes || [])[0].id;

        // THREE shots in ONE scene — the whole point. With one shot the bug is
        // invisible: 1 == 1 whether the runner honours scope or not.
        const shots = await request('/film/shots', {
            method: 'POST',
            body: {
                scene_id: sceneId,
                cards: ['1A', '1B', '1C'].map(code => ({
                    shot_code: code,
                    camera: { shot_type: 'medium' },
                    dialogue: [{ character: 'JAX', line: 'Hello there.' }],
                    sfx: ['footsteps'],
                })),
            },
        });
        shotIds = (shots.data.shots || shots.data.created || []).map(s => s.id);
        assert.equal(shotIds.length, 3, 'fixture must have three shots in one scene');
    });

    after(() => {
        if (serverProcess) serverProcess.kill('SIGTERM');
        if (mockGateway) mockGateway.close();
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('the registry declares scene-scoped steps, and the runner reads it', () => {
        assert.ok(SCENE_STEPS.length > 0,
            'PIPELINE_STEPS declares no scene-scoped step — this suite would be vacuous');
        for (const step of SCENE_STEPS) {
            assert.ok(assetTypeOfStep(step),
                `scene-scoped step '${step}' resolves to no asset type: every count in this `
                + 'suite would compare 0 with 0 and pass whatever the runner did');
        }
        const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8');
        assert.ok(/scope/.test(src),
            'routes/pipeline.js never mentions scope: a declared field consumed by nobody');
    });

    it('a scene run actually executes, and reaches a terminal status', async () => {
        const res = await request(`/film/scenes/${sceneId}/pipeline/run`, { method: 'POST', body: {} });
        assert.ok([200, 202].includes(res.status), `scene run refused: ${JSON.stringify(res.data)}`);
        const run = await waitForRun(res.data.run_id);
        assert.ok(run, 'no run row');
        assert.notEqual(run.status, 'running',
            'the run never left "running" — the scene runner answers 202 and executes nothing');
        assert.ok(['complete', 'completed_with_errors'].includes(run.status),
            `scene run ended ${run.status}`);
        console.error('   [run]', run.status, '| completed:', (run.steps_completed||[]).length,
            '| failed:', (run.steps_failed||[]).length);
    });

    it('one music cue and one ambient bed for a three-shot scene', async () => {
        const counts = await assetCounts(projectId);
        for (const step of SCENE_STEPS) {
            const type = assetTypeOfStep(step);
            assert.ok(type, `no asset type known for scene-scoped step '${step}'`);
            assert.equal(counts[type] || 0, 1,
                `'${step}' is scene-scoped and produced ${counts[type] || 0} artefact(s) for ONE scene `
                + 'of three shots — it is being run per shot');
        }
    });

    it('shot-scoped steps still run for every shot', async () => {
        // The failure this guards against is over-correcting: a runner that
        // dedupes everything would produce one keyframe for a three-shot scene
        // and pass the assertion above.
        const counts = await assetCounts(projectId);
        const keyframes = counts[assetTypeOfStep('keyframe')] || 0;
        assert.equal(keyframes, 3,
            `three shots produced ${keyframes} keyframe(s) — shot-scoped work is being deduped too`);
        assert.ok(SHOT_STEPS.includes('keyframe'), 'keyframe should be shot-scoped');
    });

    it('a single-shot run does not buy the whole scene its score', async () => {
        const before = await assetCounts(projectId);
        const res = await request(`/film/shots/${shotIds[0]}/pipeline/run`, { method: 'POST', body: {} });
        assert.equal(res.status, 200);
        const after = await assetCounts(projectId);
        for (const step of SCENE_STEPS) {
            const type = assetTypeOfStep(step);
            assert.equal((after[type] || 0), (before[type] || 0),
                `running ONE shot generated a new '${step}' artefact — you asked for a shot, `
                + 'and were charged for the scene');
            assert.ok(!(res.data.steps_completed || []).includes(step),
                `'${step}' is scene-scoped and reported as completed work on a shot run`);
        }
        // And it must still do the shot's own work, or the skip has eaten the run.
        assert.ok((res.data.steps_completed || []).includes('keyframe'),
            'a shot run stopped doing the shot');
    });

    it('a shot run can opt in to the scene steps, and says so', async () => {
        const before = await assetCounts(projectId);
        const res = await request(`/film/shots/${shotIds[0]}/pipeline/run`, {
            method: 'POST', body: { include_scene_steps: true },
        });
        assert.equal(res.status, 200);
        const after = await assetCounts(projectId);
        const grew = SCENE_STEPS.some(step => (after[assetTypeOfStep(step)] || 0) > (before[assetTypeOfStep(step)] || 0));
        assert.ok(grew,
            'include_scene_steps generated nothing — an opt-in that opts into nothing is worse '
            + 'than not offering it');
    });
});
