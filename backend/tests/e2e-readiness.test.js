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

const { ensureSchema } = require('../db/schema');
ensureSchema();

const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
const { STEP_CAPABILITY } = require('../routes/pipeline');
const { CAPABILITIES } = require('../lib/providers/base');
const providers = require('../lib/providers');
const { preflight, stages, checkCapability } = require('../lib/e2e-preflight');

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
    // Not a redundant check: it is the reason the preflight cannot simply trust
    // that resolution succeeded.
    const adapter = providers.resolveGenerator('image', { image: 'a-provider-that-was-deleted' });
    assert.ok(adapter, 'resolution threw or returned nothing');
    assert.strictEqual(adapter.id, 'gridlight', 'fallback target changed; the preflight message needs updating');
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
