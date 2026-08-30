/**
 * The run plan — a stripboard for a crew made of providers.
 *
 * A shooting schedule minimises travel and cast idle time. The same document
 * here minimises MODEL SWAPS, PLATE RE-GENERATION and SPEND. The axis rotates;
 * the artefact does not.
 *
 * IT SITS ABOVE THE ORCHESTRATOR, NEVER REPLACING IT. This was the open
 * question the epic refused to assume, and the answer matters: PIPELINE_STEPS
 * orders steps within one shot, and the flows engine orders nodes within one
 * graph. Neither orders shots against each other — that is a genuinely empty
 * slot rather than a third sequencer. So the plan emits ordered (shot, step)
 * work items and hands each to the existing executeStep, unchanged. Nothing
 * here generates anything.
 *
 * The ordering is not tuned, it falls out. Strips are steps in topological
 * order, each covering every shot needing that step. Because STEP_MODELS is
 * keyed per step, one strip is one model — so the arrangement that satisfies
 * dependencies is the same one that minimises swaps. Two objectives, one
 * answer.
 *
 * Reads only. A plan you cannot build twice without side effects is a plan you
 * cannot show someone before committing to it.
 */

const { db } = require('../db/database');
const { PIPELINE_STEPS } = require('./pipeline-engine');
const { STEP_MODELS } = require('./scheduling-engine');
const { COST_PER_CALL, budgetStatus } = require('./flow-cost');
const { ARTEFACT_KINDS, fingerprintFor, isStale } = require('./artefact-fingerprint');

/** Steps that call a provider. `assembly` is local and costs nothing. */
const GENERATIVE_STEPS = PIPELINE_STEPS.filter(s => s.id !== 'assembly');

/** Step id → capability, for cost. Mirrors routes/pipeline.js STEP_CAPABILITY. */
const STEP_CAPABILITY = {
    keyframe: 'image', video: 'video', voice: 'voice', lipsync: 'lipsync',
    music: 'music', sfx: 'sfx', ambient: 'ambient', post: 'post',
};

/**
 * The two orders worth offering, and they are a real trade, not a preference.
 *
 * `model` loads each model once and is cheapest in swaps, but nothing is
 * finished until the last strip. `shot` walks one shot through every step
 * before starting the next, so a director sees a complete shot early and can
 * stop the run — at the cost of reloading every model per shot.
 */
const PLAN_ORDERS = {
    model: 'One strip per step: every model loads once. Fastest overall, nothing finished until the end.',
    shot: 'One strip per shot: a finished shot early, at the cost of reloading models per shot.',
};

/** Is this shot's artefact for this step already current? */
function alreadyFresh(step, shotId) {
    if (!ARTEFACT_KINDS[step]) return false;
    const rows = db.prepare(
        `SELECT input_fingerprint FROM film_assets
          WHERE artefact_kind = ? AND shot_id = ? AND input_fingerprint IS NOT NULL`).all(step, shotId);
    if (!rows.length) return false;
    let current = null;
    try { current = fingerprintFor(step, { shotId }); } catch (_) { return false; }
    if (!current) return false;
    // Fresh only if EVERY stamped asset for this kind still matches. One stale
    // copy is enough to need the work done again.
    return rows.every(r => !isStale(r, current));
}

/**
 * Steps the orchestrator would skip anyway.
 *
 * A plan that lists voice for a shot with no dialogue promises work that will
 * never happen, and its cost projection is wrong by exactly that much.
 */
function skipReason(step, shot) {
    let card = {};
    try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }
    const hasDialogue = Array.isArray(card.dialogue) && card.dialogue.length > 0;
    if ((step === 'voice' || step === 'lipsync') && !hasDialogue) return 'no dialogue in this shot';
    return null;
}

function buildRunPlan(projectId, options) {
    const opts = options || {};
    const order = PLAN_ORDERS[opts.order] ? opts.order : 'model';

    const shots = db.prepare(
        `SELECT sh.id, sh.shot_code, sh.scene_card_yaml, sh.scene_id
           FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id
          WHERE sc.project_id = ? ORDER BY sh.shot_code`).all(projectId);

    const skipped = [];
    const wanted = [];   // { step, shotId, shotCode }
    for (const step of GENERATIVE_STEPS) {
        for (const shot of shots) {
            const reason = skipReason(step.id, shot);
            if (reason) { skipped.push({ step: step.id, shot_code: shot.shot_code, reason }); continue; }
            if (alreadyFresh(step.id, shot.id)) {
                skipped.push({ step: step.id, shot_code: shot.shot_code, reason: 'already current' });
                continue;
            }
            wanted.push({ step: step.id, shotId: shot.id, shotCode: shot.shot_code });
        }
    }

    const strips = order === 'model' ? stripsByStep(wanted) : stripsByShot(wanted, shots);

    for (const strip of strips) {
        // Cost is summed PER ITEM from that item's own step, never from the
        // strip's. A step-major strip is one capability throughout, so the two
        // agree there — but a shot-major strip walks a shot through every step,
        // and pricing all of it at the first step's rate made the same work
        // cost different amounts depending on how it was ordered. An estimate
        // that moves when you reorder the plan is not an estimate.
        strip.projected_cost = Number(strip.items
            .reduce((n, item) => n + (COST_PER_CALL[STEP_CAPABILITY[item.step]] || 0), 0).toFixed(6));
        const models = [...new Set(strip.items.map(i => STEP_MODELS[i.step] || null))];
        strip.model = models.length === 1 ? models[0] : null;
        strip.models = models;
        const caps = [...new Set(strip.items.map(i => STEP_CAPABILITY[i.step] || null))];
        strip.capability = caps.length === 1 ? caps[0] : null;
    }

    const projected = Number(strips.reduce((n, s) => n + s.projected_cost, 0).toFixed(6));
    const budget = budgetStatus(db, projectId, projected);

    // A swap happens whenever consecutive strips need different models.
    // Counted over the flattened item sequence, not over strips: a shot-major
    // strip reloads a model per step inside itself, and counting only strip
    // boundaries would report that arrangement as cheaper in swaps than it is,
    // which is precisely the trade a director is choosing between.
    const sequence = strips.flatMap(s => s.items.map(i => STEP_MODELS[i.step] || null));
    let switches = 0;
    for (let i = 1; i < sequence.length; i++) if (sequence[i] !== sequence[i - 1]) switches++;

    /*
     * COMPLIANCE REFUSES BEFORE SPEND, never after.
     *
     * An automated pipeline can put "clinically proven" into a paid
     * advertisement in seconds, and after generation the money is gone and the
     * frames exist. So the gate lives here, in the FREE plan, beside the budget
     * refusal and for the same reason: a ceiling you discover on the ledger is
     * not a ceiling.
     *
     * ERRORS block; warnings do not. A warning that stops a run makes the check
     * something people switch off, and the real one goes with it.
     *
     * Passable with `ignore_compliance`, on the precedent every other gate here
     * follows -- a refusal you cannot get past is a reason never to record a
     * brand at all. And it never throws: this runs inside the surface that
     * exists to stop money being spent.
     */
    const compliance = complianceFor(projectId);
    const blockedByCompliance = !opts.ignore_compliance && compliance.blocks;

    return {
        project_id: projectId,
        order,
        order_rationale: PLAN_ORDERS[order],
        compliance: compliance.findings,
        blocked_by_compliance: blockedByCompliance,
        strips,
        total_items: wanted.length,
        projected_cost: projected,
        model_switches: switches,
        budget,
        // Refused BEFORE anything generates, which is the whole point of
        // projecting cost rather than discovering it on the ledger.
        refused: (!opts.ignore_budget && budget.wouldExceed) || blockedByCompliance,
        // Said out loud: work skipped is money saved, and a plan that hides it
        // looks more expensive than it is.
        skipped,
        alternates: Object.keys(PLAN_ORDERS).filter(o => o !== order),
    };
}

/**
 * The compliance findings for a project, gathered without ever throwing.
 *
 * A project with no brand and no claims -- every film in this tool -- produces
 * no errors and does not block. A gate that fires on those is one switched off
 * the day it ships, taking the real case with it.
 */
function complianceFor(projectId) {
    try {
        const { findingsFor, blocks } = require('./compliance');
        const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
        if (!project) return { findings: [], blocks: false };
        const brand = project.brand_id
            ? db.prepare('SELECT * FROM film_brands WHERE id = ?').get(project.brand_id) : null;
        const script = db.prepare(
            'SELECT content FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1')
            .get(projectId);
        const findings = findingsFor({
            script: (script && script.content) || '',
            brand,
            claims: db.prepare('SELECT * FROM film_claims WHERE project_id = ?').all(projectId),
            rights: db.prepare('SELECT * FROM film_rights WHERE project_id = ?').all(projectId),
            deliverables: db.prepare('SELECT * FROM film_deliverables WHERE project_id = ?').all(projectId),
        });
        return { findings, blocks: blocks(findings) };
    } catch (_) {
        return { findings: [], blocks: false };
    }
}

/** One strip per step, in the topological order PIPELINE_STEPS already declares. */
function stripsByStep(wanted) {
    const out = [];
    for (const step of GENERATIVE_STEPS) {
        const items = wanted.filter(w => w.step === step.id);
        if (items.length) out.push({ step: step.id, scope: 'step', items });
    }
    return out;
}

/**
 * One strip per shot, each walking that shot through its steps in dependency
 * order. Dependencies hold WITHIN a shot, which is the only place they apply.
 */
function stripsByShot(wanted, shots) {
    const stepOrder = new Map(GENERATIVE_STEPS.map((s, i) => [s.id, i]));
    const out = [];
    for (const shot of shots) {
        const items = wanted.filter(w => w.shotId === shot.id)
            .sort((a, b) => stepOrder.get(a.step) - stepOrder.get(b.step));
        // A per-shot strip spans several models; the step of its first item
        // names it, and model_switches counts the reloads that implies.
        if (items.length) out.push({ step: items[0].step, scope: 'shot', shot_code: shot.shot_code, items });
    }
    return out;
}

module.exports = {
    complianceFor, buildRunPlan, PLAN_ORDERS, GENERATIVE_STEPS, STEP_CAPABILITY };
