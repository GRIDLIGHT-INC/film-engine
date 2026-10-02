/**
 * Applying a flow to a selection on the Production graph — the free plan
 * (FOG-001, GRD-4582).
 *
 * A flow run binds ONE shot (`runContext` in routes/flows.js); applying a flow
 * to a selection is one run per shot. This plans those runs and spends nothing:
 * which graph nodes are targets, what each shot binds each of the flow's input
 * nodes to, what each run costs from the flow's own projection (fan-out
 * multiplied, the same `projectedCost` the run's own budget gate uses), the
 * total, and the budget answer for the whole selection. FOG-002's apply reads
 * this plan's fingerprint, so a selection or a flow that moved after the plan
 * was read is refused rather than bought.
 *
 * Targets are graph node KEYS, resolved against `buildGraph` — the graph the
 * canvas draws — so the plan cannot disagree with what the director selected.
 */

const crypto = require('crypto');
const { projectedCost, budgetStatus } = require('./flow-cost');

/**
 * Which graph node types a flow can be applied to. Every type the graph draws
 * has an answer here, and a refused one says why and where to go instead.
 */
const APPLY_TARGETS = Object.freeze({
    shot: true,
    sequence: true,
    video: false,
    audio: false,
    sound: false,
    link: false,
    inbetween: false,
});
const APPLY_REFUSED = Object.freeze({
    video: 'A clip version is an output of its shot or sequence; apply the flow to that shot or sequence instead.',
    audio: 'A sound version is an output of its sound cue; a flow run binds one shot, so apply it to the shots of that scene instead.',
    sound: 'A sound cue belongs to a scene, and a flow run binds one shot\'s context; apply the flow to the scene\'s shots instead.',
    link: 'A borrowed frame is a reference between sequences, not a shot; apply the flow to the sequence that uses it instead.',
    inbetween: 'In-betweens are frames between two shots, made by their own node; apply the flow to either of the two shots instead.',
});

const parseJson = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } };
const nodeName = n => `${n.type} "${n.label || n.id}"`;

/** The first character a shot's card names — what an unnamed in.subject binds to. */
function cardCharacter(card) {
    return Array.isArray(card && card.characters) && card.characters.length ? String(card.characters[0]) : '';
}

/**
 * How each flow INPUT type binds on a shot. Every input kind in NODE_TYPES has
 * a rule, and each rule says what it binds to (`binds`), the value, and either
 * a refusal (the run would be missing what the node exists to supply) or a
 * warning (the run proceeds exactly as the executor would run it).
 */
const INPUT_BINDINGS = Object.freeze({
    'in.prompt'(node, shot, vars) {
        const cfg = node.config || {};
        const text = String(cfg.text || '');
        const unresolved = [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
            .map(m => m[1]).filter(k => cfg[k] === undefined && (vars || {})[k] === undefined);
        return {
            binds: cfg.from_form ? 'the text given in the form' : 'the text written on the node',
            value: text,
            warnings: unresolved.map(k => `${nodeName(node)}: {{${k}}} has no value, and the run leaves it visible in the prompt`),
        };
    },
    'in.asset'(node, shot, vars, db) {
        const id = (node.config || {}).asset_id;
        const where = (node.config || {}).from_form ? 'the asset chosen in the form' : 'the asset chosen on the node';
        if (!id) return { binds: where, value: null, warnings: [`${nodeName(node)}: no asset chosen, so the node skips on every shot`] };
        const asset = db.prepare('SELECT id, file_name FROM film_assets WHERE id = ?').get(id);
        if (!asset) return { binds: where, value: id, warnings: [`${nodeName(node)}: asset ${id} no longer exists, so the node skips`] };
        return { binds: where, value: asset.file_name || asset.id, warnings: [] };
    },
    'in.subject'(node, shot) {
        const named = String((node.config || {}).subject_name || '');
        const fromCard = cardCharacter(shot.card);
        if (named) return { binds: (node.config || {}).from_form ? 'the subject chosen in the form' : 'the subject named on the node', value: named, warnings: [] };
        if (fromCard) return { binds: `shot ${shot.shot_code}'s first character`, value: fromCard, warnings: [] };
        return { binds: 'the shot\'s first character', value: null, refused: `${nodeName(node)} names no subject, and shot ${shot.shot_code}'s card names no character` };
    },
    'in.scene'(node, shot) {
        const c = shot.card || {};
        const parts = [c.action, c.shot_type, c.lighting].filter(Boolean);
        if (!parts.length && !cardCharacter(c)) {
            return { binds: 'the shot\'s scene card', value: null, refused: `${nodeName(node)} binds the shot's scene card, and shot ${shot.shot_code}'s card is empty` };
        }
        return { binds: `shot ${shot.shot_code}'s scene card`, value: parts.join(', '), warnings: [] };
    },
});

/**
 * Resolve the selection, bind each shot, price it.
 *
 * @param {object} db
 * @param {{flowId:string, projectId:string, targets:string[], vars?:object, graph?:object}} args
 *        `graph` lets a caller hand in the Production graph it already built.
 */
function planApply(db, args) {
    const { flowId, projectId } = args;
    const { loadGraph } = require('../routes/flows');
    let flow = loadGraph(flowId);
    if (!flow) return { error: 'Flow not found', status: 404 };
    if (flow.project_id && projectId && flow.project_id !== projectId) {
        return { error: 'This flow belongs to another project; apply it from that project, or make it a library flow.', status: 400 };
    }
    const pid = projectId || flow.project_id;
    if (!pid) return { error: 'A library flow is applied within a project: name one with project_id.', status: 400 };

    // The form's values (FOG-009): checked, then written into the exposed nodes for this plan only.
    const formValues = args.inputs && typeof args.inputs === 'object' ? args.inputs : {};
    const formCheck = require('./flow-form').checkInputs(db, flow, formValues, pid);
    if (!formCheck.ok) return { error: formCheck.error, status: 400 };
    flow = { ...flow, ...require('./flow-form').withInputs(flow, formValues) };

    const graph = args.graph || require('./production-graph').buildGraph(db, pid);
    if (!graph) return { error: 'Project not found', status: 404 };
    const vars = args.vars || {};
    const byKey = new Map(graph.nodes.map(n => [n.key, n]));
    const shotNodes = graph.nodes.filter(n => n.type === 'shot');
    const order = new Map(shotNodes.map((n, i) => [n.id, i]));

    // ── targets → shots ──
    const targets = [];
    const from = new Map();   // shot id → the selected keys that brought it in
    const want = (id, key) => { if (!from.has(id)) from.set(id, []); if (!from.get(id).includes(key)) from.get(id).push(key); };
    for (const key of args.targets) {
        const n = byKey.get(key);
        if (!n) { targets.push({ key, type: null, status: 'refused', reason: `${key} is not on the graph — it was deleted, or belongs to another project` }); continue; }
        if (APPLY_TARGETS[n.type] !== true) {
            targets.push({ key, type: n.type, status: 'refused', reason: APPLY_REFUSED[n.type] || `A ${n.type} node cannot be applied to.` });
            continue;
        }
        if (n.type === 'shot') { want(n.id, key); targets.push({ key, type: 'shot', status: 'ok', shot_ids: [n.id] }); continue; }
        const ids = (n.shot_ids || []).filter(id => order.has(id));
        if (!ids.length) { targets.push({ key, type: 'sequence', status: 'refused', reason: `${n.name || key} has no shots to apply the flow to` }); continue; }
        ids.forEach(id => want(id, key));
        targets.push({ key, type: 'sequence', status: 'ok', shot_ids: ids });
    }

    // ── bind each shot ──
    const per = projectedCost({ nodes: flow.nodes, edges: flow.edges });
    const inputs = flow.nodes.filter(n => INPUT_BINDINGS[n.type]);
    const { HELD_REASON } = require('./graph-hold');
    const shots = [];
    const held = [];
    const revisions = new Map();
    const inputAssets = flow.nodes.map(n => (n.config || {}).asset_id).filter(Boolean);
    for (const id of [...from.keys()].sort((a, b) => order.get(a) - order.get(b))) {
        const node = byKey.get(`shot:${id}`);
        const row = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(id) || {};
        if (node.held) { held.push({ shot_id: id, shot_code: node.shot_code, from: from.get(id), reason: HELD_REASON }); continue; }
        const shot = { shot_code: node.shot_code, card: parseJson(row.scene_card_yaml, {}) || {} };
        const bindings = [], reasons = [], warnings = [];
        for (const n of inputs) {
            const b = INPUT_BINDINGS[n.type](n, shot, vars, db);
            bindings.push({ node_id: n.id, type: n.type, label: n.label || '', binds: b.binds, value: b.value, ok: !b.refused });
            if (b.refused) reasons.push(b.refused);
            warnings.push(...(b.warnings || []));
        }
        const revision = require('./generation-revision').generationRevision(db, id, inputAssets);
        revisions.set(id, revision);
        const ctx = require('./capability-payloads').loadShotContext(id);
        if (ctx && ctx.previsApplication && !ctx.previsApplication.applied
            && flow.nodes.some(n => ['gen.image', 'gen.video'].includes(n.type))) {
            reasons.push('Apply or re-seed staged Previs before generating this shot.');
        }
        warnings.push(...((ctx && ctx.referenceDiagnostics) || []).map(d => `${d.code}: ${d.name || ''} ${d.action || ''}`));
        const ok = !reasons.length;
        shots.push({
            shot_id: id, shot_code: node.shot_code, from: from.get(id), status: ok ? 'ok' : 'refused',
            bindings, reasons, warnings, revision, cost: ok ? per.total : 0, calls: ok ? per.calls : 0,
        });
    }

    const runnable = shots.filter(s => s.status === 'ok');
    const total = Number((per.total * runnable.length).toFixed(6));
    const budget = budgetStatus(db, pid, total);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        flow: flow.id, graph: flow.fingerprint, project: pid, vars, inputs: formValues,
        shots: runnable.map(s => [s.shot_id, revisions.get(s.shot_id).fingerprint]),
    })).digest('hex').slice(0, 32);

    const refusedTargets = targets.filter(t => t.status === 'refused').length;
    const refusedShots = shots.length - runnable.length;
    const summary = [
        `${runnable.length} run${runnable.length === 1 ? '' : 's'} of "${flow.name}", $${total.toFixed(2)} projected`,
        refusedTargets ? `${refusedTargets} selected node${refusedTargets === 1 ? '' : 's'} cannot take a flow` : '',
        refusedShots ? `${refusedShots} shot${refusedShots === 1 ? '' : 's'} cannot bind its inputs` : '',
        held.length ? `${held.length} held` : '',
        budget.wouldExceed ? 'over budget' : '',
    ].filter(Boolean).join(' · ');

    return {
        flow_id: flow.id, flow_name: flow.name, project_id: pid,
        targets, shots, held,
        per_run: per, runs: runnable.length,
        total_cost: total, total_calls: per.calls * runnable.length,
        budget, fingerprint, spends: false, summary, inputs: formValues,
    };
}

// ── Applying: one run per runnable shot (FOG-002, GRD-4583) ─────────────

/**
 * The apply's status, derived from its runs so it cannot disagree with them.
 * A paused run is waiting for a pick; it is not finished and not failed.
 */
function deriveApplyStatus(states) {
    const s = states || [];
    if (!s.length) return 'failed';
    if (s.some(x => x === 'pending' || x === 'running')) return 'running';
    if (s.some(x => x === 'paused')) return 'paused';
    if (s.every(x => x === 'complete')) return 'complete';
    if (s.every(x => x === 'failed')) return 'failed';
    if (s.every(x => x === 'cancelled')) return 'cancelled';
    return 'completed_with_errors';
}

/** Applies whose runner is alive in THIS process. A pending run of any other apply was abandoned. */
const live = new Set();

let holdGate = null;
/** Test hook: the runner waits before its first run until released. */
function _testHold() {
    let release;
    holdGate = new Promise(r => { release = r; });
    return { release() { if (release) { release(); release = null; holdGate = null; } } };
}

const refuse = (status, code, error, extra) => ({ status, body: Object.assign({ error, code }, extra || {}) });

/**
 * Start an apply. Everything that can refuse is checked BEFORE anything is
 * written, so a refusal starts nothing: no apply record, no run row.
 *
 * @returns {{status:number, body:object}}
 */
function startApply(db, args) {
    const targets = [...new Set((args.targets || []).map(String).map(s => s.trim()).filter(Boolean))];
    if (!targets.length) return refuse(400, 'TARGETS_REQUIRED', 'targets is required: the graph node keys the plan was read for');
    if (!args.fingerprint) return refuse(400, 'FINGERPRINT_REQUIRED', 'fingerprint is required: read the plan (flow_apply_plan) first and pass its fingerprint, so what runs is what you approved');

    const plan = planApply(db, { flowId: args.flowId, projectId: args.projectId, targets, vars: args.vars || {}, inputs: args.inputs || {} });
    if (plan.error) return refuse(plan.status || 400, null, plan.error);
    if (plan.fingerprint !== args.fingerprint) {
        return refuse(409, 'PLAN_MOVED', 'The plan changed since it was read — the flow, the selection or a shot\'s card moved. Nothing was started; review the current plan and apply that.', { plan });
    }
    const running = db.prepare("SELECT id FROM film_flow_applies WHERE fingerprint = ? AND status = 'running' ORDER BY created_at DESC").all(plan.fingerprint)
        .find(r => live.has(r.id));
    if (running) return refuse(409, 'APPLY_IN_PROGRESS', 'This exact plan is already being applied. Nothing new was started.', { apply_id: running.id });
    if (!plan.runs) return refuse(422, 'NOTHING_TO_RUN', `Nothing in the selection can run: ${plan.summary}.`, { plan });
    if (plan.budget.wouldExceed && !args.ignoreBudget) {
        return refuse(402, 'BUDGET_EXCEEDED',
            `This apply projects $${plan.total_cost.toFixed(2)} across ${plan.runs} run(s); $${plan.budget.spent.toFixed(2)} of the $${plan.budget.limit.toFixed(2)} budget is already spent. Nothing was started; pass ignore_budget to go ahead deliberately.`,
            { plan, budget: plan.budget });
    }

    const { loadGraph } = require('../routes/flows');
    // The graph the plan priced: the flow with the form's values in its exposed nodes.
    const graph = require('./flow-form').withInputs(loadGraph(plan.flow_id), args.inputs || {});
    const applyId = require('../db/database').generateId();
    const runnable = plan.shots.filter(s => s.status === 'ok');
    const runs = runnable.map(s => ({ run_id: require('../db/database').generateId(), shot_id: s.shot_id, shot_code: s.shot_code }));

    db.transaction(() => {
        db.prepare(`INSERT INTO film_flow_applies (id, flow_id, project_id, fingerprint, targets_json, vars_json, status, total_cost, ignore_budget)
                    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
            .run(applyId, plan.flow_id, plan.project_id, plan.fingerprint, JSON.stringify(targets), JSON.stringify(args.vars || {}), plan.total_cost, args.ignoreBudget ? 1 : 0);
        const ins = db.prepare(`INSERT INTO film_flow_runs (id, flow_id, project_id, shot_id, status, params, apply_id)
                                VALUES (?, ?, ?, ?, 'pending', ?, ?)`);
        for (const r of runs) ins.run(r.run_id, plan.flow_id, plan.project_id, r.shot_id, JSON.stringify({ apply_id: applyId, shot_id: r.shot_id, revision: plan.shots.find(s => s.shot_id === r.shot_id).revision }), applyId);
    })();

    live.add(applyId);
    // One at a time: concurrent generations against one provider is how a
    // queue earns a 429, and the retry costs more than the wait.
    (async () => {
        try {
            if (holdGate) await holdGate;
            const { runFlow } = require('./flow-executor');
            const { runContext } = require('../routes/flows');
            for (const r of runs) {
                try {
                    const approved = plan.shots.find(s => s.shot_id === r.shot_id).revision;
                    const current = require('./generation-revision').generationRevision(db, r.shot_id,
                        graph.nodes.map(n => (n.config || {}).asset_id).filter(Boolean));
                    if (!current || current.fingerprint !== approved.fingerprint) {
                        throw new Error('GENERATION_REVISION_MOVED: design, references, selected frames or Previs changed after approval. Review and apply a fresh plan.');
                    }
                    const resolved = runContext({ shot_id: r.shot_id, vars: args.vars || {} });
                    if (resolved.error) {
                        db.prepare("UPDATE film_flow_runs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?").run(resolved.error, r.run_id);
                        continue;
                    }
                    resolved.ctx.approvedGenerationRevision = approved;
                    resolved.ctx.approvedInputAssets = graph.nodes.map(n => (n.config || {}).asset_id).filter(Boolean);
                    await runFlow({ nodes: graph.nodes, edges: graph.edges }, resolved.ctx, {
                        runId: r.run_id, applyId, flowId: plan.flow_id,
                        params: { apply_id: applyId, shot_id: r.shot_id, revision: approved, vars: args.vars || {} },
                        ignoreBudget: !!args.ignoreBudget,
                    });
                } catch (err) {
                    db.prepare("UPDATE film_flow_runs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?").run(String(err.message || err), r.run_id);
                }
            }
        } finally {
            const states = db.prepare('SELECT status FROM film_flow_runs WHERE apply_id = ?').all(applyId).map(x => x.status);
            db.prepare("UPDATE film_flow_applies SET status = ?, completed_at = datetime('now') WHERE id = ?").run(deriveApplyStatus(states), applyId);
            live.delete(applyId);
        }
    })();

    return { status: 202, body: { apply_id: applyId, flow_id: plan.flow_id, project_id: plan.project_id, fingerprint: plan.fingerprint,
        runs, total_cost: plan.total_cost, ignore_budget: !!args.ignoreBudget, summary: plan.summary, spends: true } };
}

/**
 * An apply and its runs, with the status derived from the runs. A run still
 * pending or running whose apply has no live runner here was abandoned by a
 * process that died: it is reported interrupted, never "running" for ever.
 */
function readApply(db, applyId) {
    const a = db.prepare('SELECT * FROM film_flow_applies WHERE id = ?').get(applyId);
    if (!a) return null;
    const alive = live.has(a.id);
    const runs = db.prepare(`SELECT r.id AS run_id, r.shot_id, sh.shot_code, r.status, r.error_message, r.started_at, r.completed_at
                               FROM film_flow_runs r LEFT JOIN film_shots sh ON sh.id = r.shot_id
                              WHERE r.apply_id = ? ORDER BY r.rowid`).all(a.id)
        .map(r => (!alive && (r.status === 'pending' || r.status === 'running')) ? { ...r, status: 'interrupted' } : r);
    const status = runs.some(r => r.status === 'interrupted') ? 'interrupted' : deriveApplyStatus(runs.map(r => r.status));
    return {
        apply_id: a.id, flow_id: a.flow_id, project_id: a.project_id, fingerprint: a.fingerprint,
        targets: parseJson(a.targets_json, []), vars: parseJson(a.vars_json, {}),
        status, total_cost: a.total_cost, ignore_budget: !!a.ignore_budget,
        created_at: a.created_at, completed_at: a.completed_at, runs,
    };
}

/** Is this apply's runner alive in THIS process? A pending run of any other is abandoned. */
const isApplyLive = applyId => live.has(applyId);

module.exports = { APPLY_TARGETS, APPLY_REFUSED, INPUT_BINDINGS, planApply, deriveApplyStatus, startApply, readApply, isApplyLive, _testHold };
