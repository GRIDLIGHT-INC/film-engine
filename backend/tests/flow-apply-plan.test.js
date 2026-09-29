/**
 * FOG-001 (GRD-4582) — the free combined plan for applying a flow to a
 * selection on the Production graph.
 *
 * `GET /film/flows/:id/apply-plan?targets=` takes graph node keys. A shot binds
 * the flow's subject and scene inputs; a sequence expands to its shots. The
 * plan prices each target from the flow's own projection (fan-out multiplied),
 * totals them, and answers the budget — and spends nothing.
 *
 * Set-based twice over, because the failure is partial by nature:
 *   - every node type the graph DRAWS (read out of lib/production-graph.js,
 *     never typed here) is either a target or refused with a reason;
 *   - every flow INPUT type (read out of NODE_TYPES) has a binding rule, and a
 *     shot either binds it or is refused naming the node that cannot bind.
 * A plan that handles shots and forgets sounds, or binds in.scene and forgets
 * in.subject, passes any test written against the case someone remembered.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog001-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { handleFlows, writeGraph } = require('../routes/flows');
const { NODE_TYPES } = require('../lib/flow-node-types');
const { projectedCost } = require('../lib/flow-cost');
const apply = require('../lib/flow-apply');

// ── http shim ──────────────────────────────────────────────────────────
function call(method, urlPath, query, body) {
    const parts = urlPath.split('/').filter(Boolean);
    const res = {
        statusCode: null, body: null,
        writeHead(code) { this.statusCode = code; },
        end(p) { try { this.body = JSON.parse(p); } catch (_) { this.body = p; } },
    };
    handleFlows({ method, body: body || {} }, res, parts, query || {});
    return res;
}
const plan = (flowId, keys, extra) => call('GET', `/film/flows/${flowId}/apply-plan`,
    Object.assign({ targets: keys.join(',') }, extra || {}));

// ── fixture ────────────────────────────────────────────────────────────
const P = generateId();
const SC = generateId();
const card = o => JSON.stringify(Object.assign({ action: 'She crosses the square', shot_type: 'wide', characters: ['MAYA'] }, o || {}));
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Apply plan')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'SQUARE')").run(SC, P);
const shot = {};
for (const [code, c] of [['1A', card()], ['1B', card({ characters: ['RAY'] })], ['1C', card()], ['1D', '{}']]) {
    shot[code] = generateId();
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)').run(shot[code], SC, code, c);
}
const SEQ = generateId();
db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Walk', ?)").run(SEQ, P, JSON.stringify([shot['1A'], shot['1B']]));
const EMPTY_SEQ = generateId();
db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Nothing', '[]')").run(EMPTY_SEQ, P);
const CUE = generateId();
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, title) VALUES (?, ?, ?, 'score', 'Theme')").run(CUE, P, SC);

function flow(nodes, edges, projectId) {
    const id = generateId();
    db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'f', 0, 1)").run(id, projectId === undefined ? P : projectId);
    writeGraph(id, { nodes, edges: edges || [] });
    return id;
}
// scene → image → asset: binds the shot's card, one image call per shot.
const sceneFlow = flow([
    { id: 'sc', type: 'in.scene', config: {} },
    { id: 'img', type: 'gen.image', config: {} },
    { id: 'out', type: 'out.asset', config: {} },
], [{ id: 'e1', from: 'sc', fromPort: 'text', to: 'img', toPort: 'text' },
    { id: 'e2', from: 'img', fromPort: 'image', to: 'out', toPort: 'image' }]);

const INPUT_TYPES = Object.keys(NODE_TYPES).filter(t => NODE_TYPES[t].kind === 'input');
const GRAPH_TYPES = (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'production-graph.js'), 'utf8');
    return [...new Set([...src.matchAll(/type: '([a-z]+)'/g)].map(m => m[1]))];
})();

// ── the graph's node types ─────────────────────────────────────────────
test('every node type the graph draws has a decision: a target, or refused with a reason', () => {
    assert.ok(GRAPH_TYPES.length >= 6, `read only ${GRAPH_TYPES.length} graph node types`);
    for (const t of GRAPH_TYPES) {
        assert.ok(apply.APPLY_TARGETS[t] !== undefined, `no apply decision for graph node type ${t}`);
        if (apply.APPLY_TARGETS[t] !== true) {
            assert.ok(typeof apply.APPLY_REFUSED[t] === 'string' && apply.APPLY_REFUSED[t].length > 20, `${t}: refused without a reason`);
        }
    }
    assert.equal(apply.APPLY_TARGETS.shot, true);
    assert.equal(apply.APPLY_TARGETS.sequence, true);
});

test('a real key of every refused type is refused in the plan with its reason, and prices nothing', () => {
    const pg = require('../lib/production-graph');
    const g = pg.buildGraph(db, P);
    const sample = {};
    for (const n of g.nodes) if (!sample[n.type]) sample[n.type] = n.key;
    // Give the refused types a node to point at when the fixture does not draw one.
    const keys = { ...sample, sound: sample.sound || `sound:${CUE}` };
    for (const t of GRAPH_TYPES.filter(x => apply.APPLY_TARGETS[x] !== true)) {
        const key = keys[t] || `${t}:synthetic`;
        const r = apply.planApply(db, { flowId: sceneFlow, projectId: P, targets: [key], graph: { nodes: [...g.nodes, { key, type: t }] } });
        const refused = r.targets.find(x => x.key === key);
        assert.equal(refused.status, 'refused', `${t} was not refused`);
        assert.equal(refused.reason, apply.APPLY_REFUSED[t]);
        assert.equal(r.runs, 0);
        assert.equal(r.total_cost, 0);
    }
});

// ── the flow's input types ─────────────────────────────────────────────
test('every flow input type has a binding rule', () => {
    assert.ok(INPUT_TYPES.length >= 4, `read only ${INPUT_TYPES.length} input types`);
    for (const t of INPUT_TYPES) assert.equal(typeof apply.INPUT_BINDINGS[t], 'function', `no binding rule for ${t}`);
});

test('each input type × a shot with a full card: bound, and says what it binds to', () => {
    for (const t of INPUT_TYPES) {
        const f = flow([{ id: 'in', type: t, config: t === 'in.prompt' ? { text: 'a street' } : {} }]);
        const r = apply.planApply(db, { flowId: f, projectId: P, targets: [`shot:${shot['1A']}`] });
        const s = r.shots[0];
        assert.equal(s.status, 'ok', `${t} refused a shot with a full card: ${JSON.stringify(s.reasons)}`);
        const b = s.bindings.find(x => x.node_id === 'in');
        assert.ok(b && typeof b.binds === 'string' && b.binds.length, `${t}: binding does not say what it binds to`);
    }
});

test('the shot-bound inputs refuse a shot with an empty card, naming the node; the config-bound ones do not', () => {
    const SHOT_BOUND = ['in.scene', 'in.subject'];
    for (const t of INPUT_TYPES) {
        const f = flow([{ id: 'in', type: t, config: {} }]);
        const s = apply.planApply(db, { flowId: f, projectId: P, targets: [`shot:${shot['1D']}`] }).shots[0];
        if (SHOT_BOUND.includes(t)) {
            assert.equal(s.status, 'refused', `${t} accepted a shot whose card says nothing`);
            assert.ok(s.reasons.some(x => x.includes(t) && x.includes('1D')), `${t}: the reason names neither the node nor the shot`);
        } else {
            assert.equal(s.status, 'ok', `${t} refused a shot although it binds from its own config`);
        }
    }
});

test('in.subject binds the shot\'s first character when its config names none — and the run does the same', async () => {
    const f = flow([{ id: 'in', type: 'in.subject', config: {} }]);
    const b1 = apply.planApply(db, { flowId: f, projectId: P, targets: [`shot:${shot['1B']}`] }).shots[0].bindings[0];
    assert.equal(b1.value, 'RAY');
    const named = flow([{ id: 'in', type: 'in.subject', config: { subject_name: 'DRAGON' } }]);
    assert.equal(apply.planApply(db, { flowId: named, projectId: P, targets: [`shot:${shot['1B']}`] }).shots[0].bindings[0].value, 'DRAGON');
    // The executor must agree with the plan, or the plan describes a run that does not happen.
    const { handlerFor } = require('../lib/node-handlers');
    const out = await handlerFor('in.subject').execute({ id: 'in', type: 'in.subject', config: {} }, {}, { sceneCard: { characters: ['RAY'] } });
    assert.equal(out.outputs.subject.value.name, 'RAY');
});

test('an unresolved prompt placeholder and an unchosen asset are warned, not refused', () => {
    const f = flow([{ id: 'p', type: 'in.prompt', config: { text: 'a {{mood}} street' } }, { id: 'a', type: 'in.asset', config: {} }]);
    const s = apply.planApply(db, { flowId: f, projectId: P, targets: [`shot:${shot['1A']}`] }).shots[0];
    assert.equal(s.status, 'ok');
    assert.ok(s.warnings.some(w => w.includes('{{mood}}')));
    assert.ok(s.warnings.some(w => /no asset/i.test(w)));
    const withVar = apply.planApply(db, { flowId: f, projectId: P, targets: [`shot:${shot['1A']}`], vars: { mood: 'wet' } }).shots[0];
    assert.ok(!withVar.warnings.some(w => w.includes('{{mood}}')));
});

// ── expansion, cost, budget ────────────────────────────────────────────
test('a sequence expands to its shots in order; a shot picked twice runs once', () => {
    const r = apply.planApply(db, { flowId: sceneFlow, projectId: P, targets: [`seq:${SEQ}`, `shot:${shot['1A']}`, `shot:${shot['1C']}`] });
    assert.deepEqual(r.shots.map(s => s.shot_code), ['1A', '1B', '1C']);
    assert.deepEqual(r.shots[0].from.sort(), [`seq:${SEQ}`, `shot:${shot['1A']}`].sort());
    assert.equal(r.runs, 3);
    const seqT = r.targets.find(t => t.key === `seq:${SEQ}`);
    assert.deepEqual(seqT.shot_ids, [shot['1A'], shot['1B']]);
    const empty = apply.planApply(db, { flowId: sceneFlow, projectId: P, targets: [`seq:${EMPTY_SEQ}`] });
    assert.equal(empty.targets[0].status, 'refused');
    assert.match(empty.targets[0].reason, /no shots/i);
});

test('cost: each shot is the flow\'s own projection, fan-out multiplied; the total is their sum', () => {
    const fan = flow([
        { id: 'sc', type: 'in.scene', config: {} },
        { id: 'fan', type: 'tf.fanout', config: { count: 3 } },
        { id: 'img', type: 'gen.image', config: {} },
    ], [{ id: 'e1', from: 'sc', fromPort: 'text', to: 'fan', toPort: 'any' },
        { id: 'e2', from: 'fan', fromPort: 'any', to: 'img', toPort: 'text' }]);
    const r = apply.planApply(db, { flowId: fan, projectId: P, targets: [`shot:${shot['1A']}`, `shot:${shot['1C']}`] });
    const { loadGraph } = require('../routes/flows');
    const g = loadGraph(fan);
    const per = projectedCost({ nodes: g.nodes, edges: g.edges });
    assert.equal(per.calls, 3, 'the fixture did not fan out');
    assert.equal(r.per_run.total, per.total);
    for (const s of r.shots) assert.equal(s.cost, per.total);
    assert.equal(r.total_cost, Number((per.total * 2).toFixed(6)));
    assert.equal(r.total_calls, 6);
    // A refused shot adds nothing.
    const withBad = apply.planApply(db, { flowId: fan, projectId: P, targets: [`shot:${shot['1A']}`, `shot:${shot['1D']}`] });
    assert.equal(withBad.total_cost, Number(per.total.toFixed(6)));
});

test('the budget answer covers the whole selection', () => {
    db.prepare('UPDATE film_projects SET budget_total = ? WHERE id = ?').run(0.05, P);
    try {
        const one = apply.planApply(db, { flowId: sceneFlow, projectId: P, targets: [`shot:${shot['1A']}`] });
        assert.equal(one.budget.wouldExceed, false, 'one image fits a $0.05 budget');
        const three = apply.planApply(db, { flowId: sceneFlow, projectId: P, targets: [`shot:${shot['1A']}`, `shot:${shot['1B']}`, `shot:${shot['1C']}`] });
        assert.equal(three.budget.wouldExceed, true, 'three images do not fit a $0.05 budget, and the plan must say so');
        assert.equal(three.budget.projected, three.total_cost);
    } finally {
        db.prepare('UPDATE film_projects SET budget_total = 0 WHERE id = ?').run(P);
    }
});

test('a held shot is named and left out of the runs and the total', () => {
    db.prepare("UPDATE film_shots SET held_at = datetime('now') WHERE id = ?").run(shot['1C']);
    try {
        const r = apply.planApply(db, { flowId: sceneFlow, projectId: P, targets: [`shot:${shot['1A']}`, `shot:${shot['1C']}`] });
        assert.equal(r.runs, 1);
        assert.deepEqual(r.held.map(h => h.shot_code), ['1C']);
        assert.ok(r.held[0].reason.length > 10);
    } finally {
        db.prepare('UPDATE film_shots SET held_at = NULL WHERE id = ?').run(shot['1C']);
    }
});

// ── spends nothing, and the fingerprint ────────────────────────────────
test('planning spends nothing: no run, no job, no cost entry, no asset is written', () => {
    const tables = ['film_flow_runs', 'film_flow_node_runs', 'film_generation_jobs', 'film_cost_entries', 'film_usage_events', 'film_assets'];
    const count = () => tables.map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    const before = count();
    plan(sceneFlow, [`seq:${SEQ}`, `shot:${shot['1C']}`, `sound:${CUE}`]);
    assert.deepEqual(count(), before);
});

test('the fingerprint is stable for the same plan and moves when the selection or the flow moves', () => {
    const a = apply.planApply(db, { flowId: sceneFlow, projectId: P, targets: [`shot:${shot['1A']}`] });
    const b = apply.planApply(db, { flowId: sceneFlow, projectId: P, targets: [`shot:${shot['1A']}`] });
    assert.equal(a.fingerprint, b.fingerprint);
    const c = apply.planApply(db, { flowId: sceneFlow, projectId: P, targets: [`shot:${shot['1A']}`, `shot:${shot['1C']}`] });
    assert.notEqual(a.fingerprint, c.fingerprint);
    const f2 = flow([{ id: 'sc', type: 'in.scene', config: {} }, { id: 'img', type: 'gen.video', config: {} }],
        [{ id: 'e1', from: 'sc', fromPort: 'text', to: 'img', toPort: 'text' }]);
    assert.notEqual(a.fingerprint, apply.planApply(db, { flowId: f2, projectId: P, targets: [`shot:${shot['1A']}`] }).fingerprint);
});

// ── the route ──────────────────────────────────────────────────────────
test('the route: 200 with the plan, 404 an unknown flow, 400 no targets, an unknown key refused by name', () => {
    const ok = plan(sceneFlow, [`shot:${shot['1A']}`, 'shot:nope']);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.spends, false);
    assert.equal(ok.body.runs, 1);
    assert.match(ok.body.targets.find(t => t.key === 'shot:nope').reason, /not on the graph/i);
    assert.equal(plan(generateId(), [`shot:${shot['1A']}`]).statusCode, 404);
    assert.equal(call('GET', `/film/flows/${sceneFlow}/apply-plan`, {}).statusCode, 400);
    assert.equal(call('POST', `/film/flows/${sceneFlow}/apply-plan`, { targets: `shot:${shot['1A']}` }).statusCode, 405);
});

test('a library flow needs a project to plan against; a flow of another project is refused', () => {
    const lib = flow([{ id: 'sc', type: 'in.scene', config: {} }], [], null);
    assert.equal(plan(lib, [`shot:${shot['1A']}`]).statusCode, 400);
    assert.equal(plan(lib, [`shot:${shot['1A']}`], { project_id: P }).statusCode, 200);
    const other = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Other')").run(other);
    const theirs = flow([{ id: 'sc', type: 'in.scene', config: {} }], [], other);
    const r = plan(theirs, [`shot:${shot['1A']}`], { project_id: P });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /another project/i);
});
