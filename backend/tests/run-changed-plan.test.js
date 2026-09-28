/**
 * PGN-006 — "Run what changed": the free plan.
 *
 * The impact report already says what is behind. This turns its "redo now"
 * rows into a plan: in dependency order, each item priced from its own step
 * through the same table the run plan uses, a total, and the budget verdict.
 * Everything NOT in the plan is listed with why — waiting on something above,
 * a card only a person can rewrite, a locked board, a held node — because a
 * plan that hides its exclusions looks cheaper than the work it describes.
 *
 * Set-based over the impact chain: every stage that can be behind is either
 * priced and runnable or excluded by name. Nothing here spends.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-rcp-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const rc = require('../lib/run-changed');
const { chain } = require('../lib/impact');
const { COST_PER_CALL } = require('../lib/flow-cost');

const STAGES = chain().map(s => s.id);

/** A report row for a stage in a given state, shaped like lib/impact.js emits. */
const row = (stage, state) => ({ stage, state, why: 'why ' + stage, action: 'act ' + stage });
const shot = (id, code, stages) => ({ shot_id: id, shot_code: code, scene_number: '1', stages });

test('every stage the impact chain walks is either runnable with a price, or excluded by name', () => {
    const missing = [];
    for (const stage of STAGES) {
        const plan = rc.buildRunChangedPlan({ report: { shots: [shot('s1', '1A', [row(stage, 'redo')])] }, scenes: {} });
        const item = plan.items.find(i => i.stage === stage);
        const skip = plan.skipped.find(s => s.stage === stage);
        if (item) {
            if (!(item.cost >= 0) || item.capability === undefined) missing.push(`${stage}: runnable but unpriced`);
            else if (item.cost !== COST_PER_CALL[item.capability]) missing.push(`${stage}: priced ${item.cost}, table says ${COST_PER_CALL[item.capability]}`);
        } else if (!skip || !skip.reason) missing.push(`${stage}: neither planned nor excluded with a reason`);
    }
    assert.deepEqual(missing, []);
});

test('the card is never "run": a behind card is excluded, because only a person can rewrite it', () => {
    const plan = rc.buildRunChangedPlan({ report: { shots: [shot('s1', '1A', [row('scene_card', 'redo'), row('keyframe', 'waiting')])] }, scenes: {} });
    assert.equal(plan.items.length, 0);
    assert.match(plan.skipped.find(s => s.stage === 'scene_card').reason, /person|edit|card/i);
    assert.match(plan.skipped.find(s => s.stage === 'keyframe').reason, /waiting/i);
});

test('items come in dependency order, across shots, and total their own prices', () => {
    const plan = rc.buildRunChangedPlan({
        report: { shots: [
            shot('s2', '1B', [row('video', 'redo')]),
            shot('s1', '1A', [row('keyframe', 'redo'), row('voice', 'redo')]),
        ] }, scenes: {},
    });
    const order = plan.items.map(i => i.stage);
    const idx = s => STAGES.indexOf(s);
    for (let i = 1; i < order.length; i++) assert.ok(idx(order[i - 1]) <= idx(order[i]), `out of order: ${order.join(', ')}`);
    const sum = plan.items.reduce((n, i) => n + i.cost, 0);
    assert.equal(plan.total_cost, Number(sum.toFixed(6)));
    assert.ok(plan.items.every(i => i.key && i.why), 'every item names its node and why');
});

test('a locked board keeps frames out and says so; a held shot is excluded; scene sound is planned', () => {
    const plan = rc.buildRunChangedPlan({
        report: { shots: [shot('s1', '1A', [row('keyframe', 'redo')]), shot('s2', '1B', [row('voice', 'redo')])] },
        scenes: { sc1: { music: 'redo', ambient: 'waiting' } },
        boardLocked: true,
        held: new Set(['s2']),
    });
    assert.match(plan.skipped.find(s => s.stage === 'keyframe').reason, /locked/i);
    assert.match(plan.skipped.find(s => s.stage === 'voice').reason, /held/i);
    const music = plan.items.find(i => i.stage === 'music');
    assert.ok(music && music.scene_id === 'sc1' && music.cost === COST_PER_CALL.music);
    assert.match(plan.skipped.find(s => s.stage === 'ambient').reason, /waiting/i);
});

test('nothing behind is an empty plan that says so, not an error', () => {
    const plan = rc.buildRunChangedPlan({ report: { shots: [] }, scenes: {} });
    assert.deepEqual(plan.items, []);
    assert.equal(plan.total_cost, 0);
    assert.match(plan.summary, /nothing/i);
});

// ---- through the real database and the route ------------------------------

const P = generateId(), SC = generateId(), SH = generateId();
db.prepare("INSERT INTO film_projects (id, title, budget_total) VALUES (?, 'Run changed', 0.01)").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, description) VALUES (?, ?, 1, 'A street.')").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', ?)").run(SH, SC, JSON.stringify({ description: 'A woman waits.' }));
db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_name, file_path, version, input_fingerprint, artefact_kind)
    VALUES (?, ?, ?, ?, 'storyboard', 'f.png', '/tmp/f.png', 1, 'an-old-fingerprint', 'keyframe')`).run(generateId(), P, SH, SC);

test('planRunChanged reads the real walk, prices it, and applies the budget verdict', () => {
    const plan = rc.planRunChanged(P);
    const kf = plan.items.find(i => i.stage === 'keyframe');
    assert.ok(kf, 'the stale keyframe is planned');
    assert.equal(kf.key, 'shot:' + SH);
    assert.ok(plan.budget && plan.budget.limit === 0.01);
    assert.equal(plan.refused, true, 'a plan over the project budget is refused before anything runs');
});

test('GET /projects/:id/production-graph/run-changed/plan returns it, and spends nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM film_generation_jobs').get().n;
    const { handleProductionGraph } = require('../routes/production-graph');
    let status = 0, out = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { out = JSON.parse(b); } };
    await handleProductionGraph({ method: 'GET' }, res, ['film', 'projects', P, 'production-graph', 'run-changed', 'plan'], {});
    assert.equal(status, 200);
    assert.ok(out.items.some(i => i.stage === 'keyframe'));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM film_generation_jobs').get().n, before, 'the plan started a generation');
    await handleProductionGraph({ method: 'GET' }, res, ['film', 'projects', generateId(), 'production-graph', 'run-changed', 'plan'], {});
    assert.equal(status, 404);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
