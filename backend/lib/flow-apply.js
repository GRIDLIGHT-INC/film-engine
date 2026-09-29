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
});
const APPLY_REFUSED = Object.freeze({
    video: 'A clip version is an output of its shot or sequence; apply the flow to that shot or sequence instead.',
    audio: 'A sound version is an output of its sound cue; a flow run binds one shot, so apply it to the shots of that scene instead.',
    sound: 'A sound cue belongs to a scene, and a flow run binds one shot\'s context; apply the flow to the scene\'s shots instead.',
    link: 'A borrowed frame is a reference between sequences, not a shot; apply the flow to the sequence that uses it instead.',
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
            binds: 'the text written on the node',
            value: text,
            warnings: unresolved.map(k => `${nodeName(node)}: {{${k}}} has no value, and the run leaves it visible in the prompt`),
        };
    },
    'in.asset'(node, shot, vars, db) {
        const id = (node.config || {}).asset_id;
        if (!id) return { binds: 'the asset chosen on the node', value: null, warnings: [`${nodeName(node)}: no asset chosen, so the node skips on every shot`] };
        const asset = db.prepare('SELECT id, file_name FROM film_assets WHERE id = ?').get(id);
        if (!asset) return { binds: 'the asset chosen on the node', value: id, warnings: [`${nodeName(node)}: asset ${id} no longer exists, so the node skips`] };
        return { binds: 'the asset chosen on the node', value: asset.file_name || asset.id, warnings: [] };
    },
    'in.subject'(node, shot) {
        const named = String((node.config || {}).subject_name || '');
        const fromCard = cardCharacter(shot.card);
        if (named) return { binds: 'the subject named on the node', value: named, warnings: [] };
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
    const flow = loadGraph(flowId);
    if (!flow) return { error: 'Flow not found', status: 404 };
    if (flow.project_id && projectId && flow.project_id !== projectId) {
        return { error: 'This flow belongs to another project; apply it from that project, or make it a library flow.', status: 400 };
    }
    const pid = projectId || flow.project_id;
    if (!pid) return { error: 'A library flow is applied within a project: name one with project_id.', status: 400 };

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
    const cardOf = new Map();
    for (const id of [...from.keys()].sort((a, b) => order.get(a) - order.get(b))) {
        const node = byKey.get(`shot:${id}`);
        const row = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(id) || {};
        cardOf.set(id, row.scene_card_yaml || '');
        if (node.held) { held.push({ shot_id: id, shot_code: node.shot_code, from: from.get(id), reason: HELD_REASON }); continue; }
        const shot = { shot_code: node.shot_code, card: parseJson(row.scene_card_yaml, {}) || {} };
        const bindings = [], reasons = [], warnings = [];
        for (const n of inputs) {
            const b = INPUT_BINDINGS[n.type](n, shot, vars, db);
            bindings.push({ node_id: n.id, type: n.type, label: n.label || '', binds: b.binds, value: b.value, ok: !b.refused });
            if (b.refused) reasons.push(b.refused);
            warnings.push(...(b.warnings || []));
        }
        const ok = !reasons.length;
        shots.push({
            shot_id: id, shot_code: node.shot_code, from: from.get(id), status: ok ? 'ok' : 'refused',
            bindings, reasons, warnings, cost: ok ? per.total : 0, calls: ok ? per.calls : 0,
        });
    }

    const runnable = shots.filter(s => s.status === 'ok');
    const total = Number((per.total * runnable.length).toFixed(6));
    const budget = budgetStatus(db, pid, total);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        flow: flow.id, graph: flow.fingerprint, project: pid, vars,
        shots: runnable.map(s => [s.shot_id, crypto.createHash('sha256').update(cardOf.get(s.shot_id)).digest('hex')]),
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
        budget, fingerprint, spends: false, summary,
    };
}

module.exports = { APPLY_TARGETS, APPLY_REFUSED, INPUT_BINDINGS, planApply };
