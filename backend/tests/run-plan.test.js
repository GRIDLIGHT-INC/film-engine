/**
 * Phase 2 — the run plan.
 *
 * A stripboard minimises travel and cast idle time. Here the crew is a set of
 * providers, so the same document minimises MODEL SWAPS, PLATE RE-GENERATION
 * and SPEND. The axis rotates; the artefact does not.
 *
 * It sits ABOVE the orchestrator rather than replacing it, which was the open
 * question the epic refused to assume. PIPELINE_STEPS orders steps within one
 * shot and the flows engine orders nodes within one graph; neither orders shots
 * against each other. That is a genuinely empty slot, not a third sequencer,
 * and the plan emits ordered (shot, step) work items that the existing
 * executeStep consumes unchanged.
 *
 * The ordering falls out of that decision rather than being invented: strips
 * are steps in topological order, each strip covering every shot that needs
 * that step. Because STEP_MODELS is keyed per step, one strip is one model —
 * so the arrangement that satisfies dependencies is also the one that minimises
 * swaps. Two objectives, one answer, no tuning.
 *
 * Set-based over PIPELINE_STEPS because a plan that handles keyframes and drops
 * ambient is indistinguishable from a working one until the run finishes short.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-runplan-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { buildRunPlan, PLAN_ORDERS } = require('../lib/run-plan');
const { PIPELINE_STEPS } = require('../lib/pipeline-engine');
const fp = require('../lib/artefact-fingerprint');

/** Steps that actually call a provider. `assembly` is local and free. */
const GENERATIVE = PIPELINE_STEPS.filter(s => s.id !== 'assembly');

function makeProduction(shotCount = 3) {
    const projectId = generateId(), sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, budget_total) VALUES (?, ?, ?)')
        .run(projectId, 'Run Plan Test', 0);
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, location, time_of_day, characters_present)
                VALUES (?, ?, '1', 'STREET', 'DUSK', ?)`).run(sceneId, projectId, JSON.stringify(['MAYA']));
    const shotIds = [];
    for (let i = 0; i < shotCount; i++) {
        const id = generateId();
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, 4000)')
            .run(id, sceneId, `1${String.fromCharCode(65 + i)}`, JSON.stringify({
                shot_code: `1${String.fromCharCode(65 + i)}`,
                description: 'Something happens.',
                camera: { shot_type: 'medium', lens: '35mm' },
                dialogue: [{ character: 'MAYA', line: 'A line.' }],
            }));
        shotIds.push(id);
    }
    return { projectId, sceneId, shotIds };
}

test('the plan covers every generative step, for every shot that needs it', () => {
    const { projectId, shotIds } = makeProduction(3);
    const plan = buildRunPlan(projectId);
    const covered = new Set(plan.strips.map(s => s.step));
    const missing = GENERATIVE.filter(s => !covered.has(s.id)).map(s => s.id);
    assert.deepStrictEqual(missing, [],
        `steps absent from the plan — a run following it would finish short: ${missing.join(', ')}`);
    assert.strictEqual(plan.total_items, GENERATIVE.length * shotIds.length,
        `expected ${GENERATIVE.length} steps x ${shotIds.length} shots, got ${plan.total_items}`);
});

test('a step never precedes something it depends on', () => {
    // The constraint that makes the plan runnable at all. Checked over the
    // whole ordering rather than per strip, because the failure is positional.
    const { projectId } = makeProduction(2);
    const plan = buildRunPlan(projectId);
    const positionOf = {};
    plan.strips.forEach((strip, i) => { positionOf[strip.step] = i; });
    const violations = [];
    for (const step of GENERATIVE) {
        for (const dep of step.depends) {
            if (positionOf[dep] === undefined || positionOf[step.id] === undefined) continue;
            if (positionOf[dep] > positionOf[step.id]) {
                violations.push(`${step.id} is planned before its input ${dep}`);
            }
        }
    }
    assert.deepStrictEqual(violations, [], `\n  ${violations.join('\n  ')}`);
});

test('one strip is one model, so the plan minimises swaps by construction', () => {
    const { projectId } = makeProduction(4);
    const plan = buildRunPlan(projectId);
    const mixed = plan.strips.filter(s => !s.model).map(s => s.step);
    assert.deepStrictEqual(mixed, [], `strips with no model attributed: ${mixed.join(', ')}`);
    // A swap per strip is the floor: you cannot do fewer than one load per
    // distinct model in the plan.
    const distinctModels = new Set(plan.strips.map(s => s.model)).size;
    assert.ok(plan.model_switches >= distinctModels - 1,
        'reported fewer switches than distinct models requires');
    assert.ok(plan.model_switches <= plan.strips.length,
        'more switches than strips means the grouping did nothing');
});

test('work already fresh is not planned again', () => {
    // The reason Phase 1 came first. A plan that cannot tell what is current
    // re-generates everything or nothing.
    const { projectId, shotIds } = makeProduction(2);
    const before = buildRunPlan(projectId).total_items;

    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name)
                VALUES (?, ?, ?, 'keyframe', '/tmp/x.png', 'x.png')`)
        .run(assetId, projectId, shotIds[0]);
    fp.stampAsset(assetId, 'keyframe', { shotId: shotIds[0] });

    const after = buildRunPlan(projectId);
    assert.strictEqual(after.total_items, before - 1,
        'a freshly generated keyframe was planned for regeneration anyway');
    assert.ok(after.skipped.some(s => s.step === 'keyframe'),
        'the plan does not say what it skipped, so the saving is invisible');
});

test('a stale artefact IS planned again', () => {
    const { projectId, shotIds } = makeProduction(1);
    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name)
                VALUES (?, ?, ?, 'keyframe', '/tmp/x.png', 'x.png')`)
        .run(assetId, projectId, shotIds[0]);
    fp.stampAsset(assetId, 'keyframe', { shotId: shotIds[0] });

    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify({ shot_code: '1A', description: 'Rewritten.', camera: {} }), shotIds[0]);

    const plan = buildRunPlan(projectId);
    const keyframe = plan.strips.find(s => s.step === 'keyframe');
    assert.ok(keyframe && keyframe.items.length === 1,
        'the card changed and the keyframe was treated as current');
});

test('every strip carries a projected cost, and the plan carries the total', () => {
    const { projectId } = makeProduction(3);
    const plan = buildRunPlan(projectId);
    const free = plan.strips.filter(s => typeof s.projected_cost !== 'number');
    assert.deepStrictEqual(free.map(s => s.step), [], 'strips with no cost projection');
    const summed = plan.strips.reduce((n, s) => n + s.projected_cost, 0);
    assert.ok(Math.abs(summed - plan.projected_cost) < 1e-9,
        `strip costs sum to ${summed} but the plan claims ${plan.projected_cost}`);
    assert.ok(plan.projected_cost > 0, 'a plan that generates something cannot cost nothing');
});

test('a plan over budget is refused before anything generates', () => {
    const { projectId } = makeProduction(3);
    db.prepare('UPDATE film_projects SET budget_total = ? WHERE id = ?').run(0.01, projectId);
    const plan = buildRunPlan(projectId);
    assert.strictEqual(plan.budget.wouldExceed, true, 'a 1-cent budget accepted a full run');
    assert.strictEqual(plan.refused, true, 'the plan was not refused despite exceeding budget');
    const forced = buildRunPlan(projectId, { ignore_budget: true });
    assert.strictEqual(forced.refused, false, 'the refusal cannot be overridden, so a wrong estimate is fatal');
});

test('an unset budget is unlimited, never an accidental ceiling of zero', () => {
    const { projectId } = makeProduction(2);
    db.prepare('UPDATE film_projects SET budget_total = NULL WHERE id = ?').run(projectId);
    const plan = buildRunPlan(projectId);
    assert.strictEqual(plan.refused, false, 'an unset budget refused the run');
});

test('alternate orders are genuinely different, and both are runnable', () => {
    // Not a fake choice: model-major is cheapest in swaps, shot-major delivers
    // one finished shot soonest. A director choosing between them is choosing
    // between throughput and feedback.
    const { projectId } = makeProduction(3);
    const orders = Object.keys(PLAN_ORDERS);
    assert.ok(orders.length >= 2, `expected alternates, found ${orders.join(', ')}`);

    const plans = orders.map(o => buildRunPlan(projectId, { order: o }));
    for (const p of plans) {
        assert.strictEqual(p.total_items, plans[0].total_items, 'alternates plan different amounts of work');
        assert.ok(Math.abs(p.projected_cost - plans[0].projected_cost) < 1e-9,
            'alternates disagree on cost for identical work');
    }
    const shapes = new Set(plans.map(p => p.strips.map(s => `${s.step}:${s.items.length}`).join('|')));
    assert.ok(shapes.size > 1, 'the alternates produce identical plans, so the choice is decorative');
});
