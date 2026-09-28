/**
 * "Run what changed" — the free plan (PGN-006).
 *
 * The impact report already knows what is behind and in what order; this is
 * that list turned into work: only the "redo now" rows, in dependency order,
 * each priced from its OWN step through the same table the run plan uses
 * (lib/run-plan STEP_CAPABILITY × lib/flow-cost COST_PER_CALL), summed, and
 * checked against the project budget before anything runs.
 *
 * Everything left out is listed with why — waiting on something above it, a
 * card only a person can rewrite, a locked board, a held node — because a
 * plan that hides its exclusions reads cheaper than the work it describes.
 *
 * Reads only. It never resolves a provider, so it can never spend.
 */

const { COST_PER_CALL, budgetStatus } = require('./flow-cost');
const { STEP_CAPABILITY } = require('./run-plan');
const { chain } = require('./impact');

/** Stages a person does rather than a provider: a card is written, not generated. */
const PERSON_STAGES = Object.freeze({
    scene_card: 'The screenplay changed after this card was written; a person must edit the card before anything under it can be redone.',
});

/**
 * The pure planner. Input is what lib/impact.js reports plus the project's
 * facts, so every branch can be exercised without a database.
 *
 * @param {object} input
 * @param {object} input.report      impact() output (shots[].stages[])
 * @param {object} input.scenes      graphStates().scenes: { sceneId: { music, ambient } }
 * @param {boolean} [input.boardLocked]
 * @param {Set<string>} [input.held] shot or scene ids that batch runs skip
 */
function buildRunChangedPlan(input) {
    const i = input || {};
    const order = chain().map(s => s.id);
    const rank = s => { const r = order.indexOf(s); return r < 0 ? order.length : r; };
    const held = i.held instanceof Set ? i.held : new Set();
    const items = [];
    const skipped = [];

    (i.report && i.report.shots || []).forEach((sh, shotIndex) => {
        for (const r of sh.stages || []) {
            const base = { stage: r.stage, shot_id: sh.shot_id, shot_code: sh.shot_code, key: 'shot:' + sh.shot_id };
            if (r.state === 'waiting') {
                skipped.push({ ...base, reason: `waiting: ${r.why || 'something it is built from is being redone'}` });
                continue;
            }
            if (r.state !== 'redo') continue;
            if (PERSON_STAGES[r.stage]) { skipped.push({ ...base, reason: PERSON_STAGES[r.stage] }); continue; }
            const capability = STEP_CAPABILITY[r.stage];
            if (!capability) { skipped.push({ ...base, reason: `${r.stage} is not a step Film Engine generates` }); continue; }
            if (held.has(sh.shot_id)) { skipped.push({ ...base, reason: 'held: batch runs skip this shot until it is released' }); continue; }
            if (i.boardLocked && r.stage === 'keyframe') {
                skipped.push({ ...base, reason: 'the board is locked: frames are not replaced until it is unlocked' });
                continue;
            }
            items.push({ ...base, capability, cost: COST_PER_CALL[capability] || 0, why: r.why || '', action: r.action || '', _shot: shotIndex });
        }
    });

    for (const [sceneId, kinds] of Object.entries(i.scenes || {})) {
        for (const [stage, state] of Object.entries(kinds || {})) {
            const base = { stage, scene_id: sceneId, key: 'scene:' + sceneId };
            if (state === 'waiting') { skipped.push({ ...base, reason: "waiting: the scene's screenplay changed; fix its cards first" }); continue; }
            if (state !== 'redo') continue;
            if (held.has(sceneId)) { skipped.push({ ...base, reason: 'held: batch runs skip this until it is released' }); continue; }
            const capability = STEP_CAPABILITY[stage];
            if (!capability) { skipped.push({ ...base, reason: `${stage} is not a step Film Engine generates` }); continue; }
            items.push({ ...base, capability, cost: COST_PER_CALL[capability] || 0,
                why: 'What it was generated from has changed.', action: 'Regenerate this now.', _shot: Infinity });
        }
    }

    // Dependency order first (a frame before the clip built on it), then the
    // running order of the shots, so one stage runs across the film together.
    items.sort((a, b) => rank(a.stage) - rank(b.stage) || a._shot - b._shot);
    for (const it of items) delete it._shot;
    const total = Number(items.reduce((n, it) => n + it.cost, 0).toFixed(6));
    return {
        items,
        skipped,
        total_cost: total,
        summary: items.length
            ? `${items.length} thing${items.length === 1 ? '' : 's'} to redo, about $${total.toFixed(2)}`
                + (skipped.length ? `; ${skipped.length} left out (see why)` : '')
            : (skipped.length ? `Nothing can be redone yet; ${skipped.length} left out (see why)` : 'Nothing is behind.'),
    };
}

/** Shots and scenes marked held, once the hold exists (PGN-016); none before. */
function heldIds(db, projectId) {
    const out = new Set();
    try {
        const cols = new Set(db.prepare('PRAGMA table_info(film_shots)').all().map(c => c.name));
        if (cols.has('held_at')) {
            for (const r of db.prepare(`SELECT sh.id FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id
                WHERE sc.project_id = ? AND sh.held_at IS NOT NULL`).all(projectId)) out.add(r.id);
        }
    } catch (_) { /* no hold yet */ }
    return out;
}

/** The plan for a real project: the impact walk, the board lock, the hold and the budget. */
function planRunChanged(projectId) {
    const { db } = require('../db/database');
    const project = db.prepare('SELECT id, board_locked_at FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return null;
    const impact = require('./impact');
    const plan = buildRunChangedPlan({
        report: impact.impact(projectId),
        scenes: impact.graphStates(projectId).scenes,
        boardLocked: !!project.board_locked_at,
        held: heldIds(db, projectId),
    });
    const budget = budgetStatus(db, projectId, plan.total_cost);
    return { project_id: projectId, ...plan, budget, refused: !!budget.wouldExceed };
}

/**
 * RUN WHAT CHANGED (PGN-007).
 *
 * One item at a time, through the pipeline's own executeStep — the path that
 * already applies the stale-input gate, persists the result and stamps its
 * fingerprint. The plan is re-read before every item, because the report
 * moves as work lands: a clip "waiting" on its frame becomes "redo" once the
 * frame is regenerated, and runs next.
 *
 * Stops at the first refusal and names what was not attempted. Checks the
 * budget before the first item and before each one after (spend accumulates).
 * Never runs one item twice: something that ran and is still behind is
 * reported as still behind, never bought again in a loop.
 */
const MAX_STEPS = 500;

function isCancelled(runId) {
    try {
        const r = runId && require('../db/database').db.prepare('SELECT status FROM film_pipeline_runs WHERE id = ?').get(runId);
        return !!(r && r.status === 'cancelled');
    } catch (_) { return false; }
}
const itemId = it => `${it.stage}|${it.key}`;

async function executeItem(item) {
    const { db } = require('../db/database');
    const { executeStep } = require('../routes/pipeline');
    let shot = null, scene = null;
    if (item.shot_id) {
        shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(item.shot_id);
        if (shot) scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    } else if (item.scene_id) {
        scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(item.scene_id);
        // A scene-scoped step runs in the context of one of the scene's shots,
        // exactly as the orchestrator runs it.
        if (scene) shot = db.prepare('SELECT * FROM film_shots WHERE scene_id = ? ORDER BY sort_order, shot_code LIMIT 1').get(scene.id);
    }
    if (!shot || !scene) return { ok: false, error: `${item.stage}: the ${item.shot_id ? 'shot' : 'scene'} no longer exists` };
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
    return executeStep(item.stage, shot, scene, project);
}

let deps = null;
/** Test seam: the planner and executor, so every branch is provable without spending. */
function _setDeps(d) { deps = d || null; }

function recordRun(projectId, patch, runId) {
    try {
        const { db, generateId } = require('../db/database');
        if (!runId) {
            const id = generateId();
            db.prepare(`INSERT INTO film_pipeline_runs (id, project_id, run_type, status, started_at, params, total_steps)
                VALUES (?, ?, 'project', 'running', datetime('now'), ?, ?)`)
                .run(id, projectId, JSON.stringify(patch.params || { kind: 'run_changed' }), patch.total || 0);
            return id;
        }
        db.prepare(`UPDATE film_pipeline_runs SET status = ?, current_step = ?, steps_completed = ?, steps_failed = ?,
            steps_remaining = ?, error_message = ?, completed_at = CASE WHEN ? IN ('complete','failed','cancelled') THEN datetime('now') END
            WHERE id = ?`).run(patch.status, patch.current || '', JSON.stringify(patch.completed || []),
            JSON.stringify(patch.failed ? [patch.failed] : []), JSON.stringify(patch.remaining || []),
            patch.error || '', patch.status, runId);
        return runId;
    } catch (_) { return runId || null; }
}

async function runChanged(projectId, opts, injected) {
    const o = opts || {};
    const d = injected || deps || {};
    const plan = d.plan || (() => planRunChanged(projectId));
    const execute = d.execute || executeItem;

    if (!projectExists(projectId)) return { ok: false, status: 404, error: 'Project not found' };
    const first = plan();
    if (!first) return { ok: false, status: 404, error: 'Project not found' };
    if (first.refused && !o.ignore_budget) {
        return { ok: false, status: 402, refused: true, budget: first.budget || null,
            error: 'This would take the project over its budget. Nothing was run.', plan: first };
    }
    const runId = o.run_id || recordRun(projectId, { total: first.items.length,
        params: { kind: o.kind || 'run_changed', ...(o.target ? { target: o.target } : {}) } });
    const attempted = new Set();
    const completed = [];
    let failed = null, stopped = null, current = first, stillBehind = [];

    for (let step = 0; step < MAX_STEPS; step++) {
        // Cancelled from anywhere (the page, another process): stop before the next step (PGN-012).
        if (isCancelled(runId)) { stopped = 'cancelled by the director'; break; }
        if (step > 0) {
            current = plan();
            if (!current) break;
            if (current.refused && !o.ignore_budget) { stopped = 'budget: the next item would take the project over its budget'; break; }
        }
        const next = (current.items || []).find(it => !attempted.has(itemId(it)));
        if (!next) { stillBehind = (current.items || []).filter(it => attempted.has(itemId(it))); break; }
        attempted.add(itemId(next));
        // What is still to come, recorded while running, so the queue can show
        // it as waiting (PGN-010).
        const ahead = (current.items || []).filter(it => !attempted.has(itemId(it)))
            .map(it => ({ stage: it.stage, key: it.key, shot_code: it.shot_code || null }));
        recordRun(projectId, { status: 'running', current: itemId(next), completed, remaining: ahead }, runId);
        let result;
        try { result = await execute(next); } catch (err) { result = { ok: false, error: err && err.message || String(err) }; }
        if (result && result.ok) { completed.push({ stage: next.stage, key: next.key, shot_code: next.shot_code || null }); continue; }
        failed = { stage: next.stage, key: next.key, shot_code: next.shot_code || null,
            code: (result && result.code) || null, error: (result && result.error) || 'the step did not complete' };
        stopped = 'refused';
        break;
    }

    const remaining = failed || stopped
        ? ((plan() || current || {}).items || []).filter(it => !attempted.has(itemId(it)))
            .map(it => ({ stage: it.stage, key: it.key, shot_code: it.shot_code || null }))
        : [];
    const ok = !failed && !stopped;
    const cancelled = stopped === 'cancelled by the director';
    recordRun(projectId, { status: ok ? 'complete' : (cancelled ? 'cancelled' : 'failed'), completed, failed, remaining,
        error: failed ? `${failed.stage} ${failed.shot_code || failed.key}: ${failed.error}` : (stopped || '') }, runId);
    return { ok, run_id: runId, completed, failed, stopped, not_attempted: remaining,
        still_behind: stillBehind.map(it => ({ stage: it.stage, key: it.key, shot_code: it.shot_code || null })) };
}

/**
 * Start a run and answer at once. A run of several generations outlasts any
 * request; its progress shows on the nodes (PGN-003) and in its run row.
 */
let last = null;
function projectExists(projectId) {
    try { return !!require('../db/database').db.prepare('SELECT 1 FROM film_projects WHERE id = ?').get(projectId); }
    catch (_) { return false; }
}

function startRunChanged(projectId, opts) {
    if (!projectExists(projectId)) return { status: 404, body: { error: 'Project not found' } };
    const d = deps || {};
    const plan = (d.plan || (() => planRunChanged(projectId)))();
    if (!plan) return { status: 404, body: { error: 'Project not found' } };
    if (plan.refused && !(opts && opts.ignore_budget)) {
        return { status: 402, body: { refused: true, budget: plan.budget || null, plan,
            error: 'This would take the project over its budget. Nothing was run.' } };
    }
    if (!(plan.items || []).length) return { status: 200, body: { run_id: null, plan, message: plan.summary || 'Nothing is behind.' } };
    const runId = recordRun(projectId, { total: plan.items.length });
    last = runChanged(projectId, Object.assign({}, opts, { run_id: runId })).catch(err => ({ ok: false, error: err.message }));
    return { status: 202, body: { run_id: runId, plan } };
}
/** Test seam: the promise of the last started run. */
function _lastRun() { return last; }

function getRun(projectId, runId) {
    const { db } = require('../db/database');
    const r = db.prepare('SELECT * FROM film_pipeline_runs WHERE id = ? AND project_id = ?').get(runId, projectId);
    if (!r) return null;
    const j = (v, dflt) => { try { return JSON.parse(v); } catch (_) { return dflt; } };
    return { run_id: r.id, status: r.status, current: r.current_step, completed: j(r.steps_completed, []),
        failed: j(r.steps_failed, [])[0] || null, not_attempted: j(r.steps_remaining, []),
        error: r.error_message || null, started_at: r.started_at, completed_at: r.completed_at };
}

module.exports = { buildRunChangedPlan, planRunChanged, runChanged, startRunChanged, getRun, executeItem,
    PERSON_STAGES, _setDeps, _lastRun, _recordRun: recordRun, projectExists };
