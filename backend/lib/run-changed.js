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

module.exports = { buildRunChangedPlan, planRunChanged, PERSON_STAGES };
