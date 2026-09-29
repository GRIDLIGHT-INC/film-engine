/**
 * FOG-008 (GRD-4589) — flow provenance in the recipe panel.
 *
 * "How was this made" read a flow's output as a row with no provider, no model
 * and no prompt: every fact about it lived in the flow run, and the recipe never
 * looked there. Now a flow output — and a frame PICKED from one (FOG-005) —
 * carries a `flow` block: the flow and its version, the node that saved it,
 * the generating node upstream of it with that node's provider and model, the
 * run, and the apply. Anything that cannot be found is named in
 * `flow.unknown`, never guessed. "Make another like this" re-applies the same
 * flow to that shot through FOG-003's apply.
 *
 * Set-based over FLOW_RECIPE_FIELDS: each is present or named unknown, in every
 * case the test builds (a direct run, an applied run, a deleted flow, a deleted
 * run, a picked frame).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog008-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { runFlow } = require('../lib/flow-executor');
const { writeGraph } = require('../routes/flows');
const recipe = require('../lib/asset-recipe');

const P = generateId(), SC = generateId(), SH = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Provenance')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'SQUARE')").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', '{}')").run(SH, SC);

const GRAPH = {
    nodes: [
        { id: 'p', type: 'in.prompt', config: { text: 'a square at dusk' } },
        { id: 'img', type: 'gen.image', config: { model: 'flux2-dev' } },
        { id: 'save', type: 'out.asset' },
    ],
    edges: [
        { from: 'p', fromPort: 'text', to: 'img', toPort: 'text' },
        { from: 'img', fromPort: 'image', to: 'save', toPort: 'image' },
    ],
};
function makeFlow(version) {
    const id = generateId();
    db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'Dusk look', 0, ?)").run(id, P, version || 3);
    writeGraph(id, GRAPH);
    return id;
}
const ctx = () => ({
    project: { id: P, provider_config: '{}' }, scene: { id: SC, project_id: P }, shot: { id: SH, shot_code: '1A' },
    sceneCard: { action: 'a square' }, characters: [], location: null, voiceProfiles: [],
    providerFor: () => ({ id: 'gridlight', async generate() { return { ok: true, data: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(8)]) }; } }),
});
async function flowOutput(flowId, applyId) {
    const runId = generateId();
    if (applyId) db.prepare("INSERT INTO film_flow_runs (id, flow_id, project_id, shot_id, status, apply_id) VALUES (?, ?, ?, ?, 'pending', ?)").run(runId, flowId, P, SH, applyId);
    const r = await runFlow(GRAPH, ctx(), { runId, flowId, applyId });
    assert.equal(r.status, 'complete', JSON.stringify(r.failed));
    const row = db.prepare("SELECT id FROM film_assets WHERE json_valid(metadata) AND json_extract(metadata, '$.run_id') = ?").get(runId);
    assert.ok(row, 'the run saved nothing');
    return { runId, assetId: row.id };
}
function everyFieldAccounted(r, label) {
    assert.ok(r.flow, `${label}: no flow block`);
    for (const f of recipe.FLOW_RECIPE_FIELDS) {
        const present = r.flow[f] !== null && r.flow[f] !== undefined;
        const named = (r.flow.unknown || []).includes(f);
        assert.ok(present !== named, `${label}: ${f} is ${present ? 'present AND named unknown' : 'neither present nor named unknown'}`);
    }
}

test('the flow fields are declared once', () => {
    assert.deepEqual([...recipe.FLOW_RECIPE_FIELDS].sort(), ['apply', 'flow', 'flow_version', 'generated_by', 'model', 'node', 'provider', 'run'].sort());
});

test('a direct run: the flow, its version, the saving node, the generating node, its provider and model, the run — and the apply named unknown', async () => {
    const F = makeFlow(3);
    const { runId, assetId } = await flowOutput(F);
    const r = recipe.assetRecipe(db, assetId);
    everyFieldAccounted(r, 'direct run');
    assert.deepEqual(r.flow.flow, { id: F, name: 'Dusk look' });
    assert.equal(r.flow.flow_version, 3);
    assert.equal(r.flow.node, 'save');
    assert.deepEqual(r.flow.generated_by, { id: 'img', type: 'gen.image' });
    assert.equal(r.flow.provider, 'gridlight');
    assert.equal(r.flow.model, 'flux2-dev');
    assert.equal(r.flow.run.id, runId);
    assert.equal(r.flow.run.status, 'complete');
    assert.equal(r.flow.apply, null);
    assert.ok(r.flow.unknown.includes('apply'), 'a run with no apply does not say so');
    assert.equal(r.provider, 'gridlight', 'the recipe\'s own generator is still unknown when the flow knows it');
    assert.equal(r.model, 'flux2-dev');
    assert.equal(r.shot_id, SH);
});

test('an applied run names its apply', async () => {
    const F = makeFlow(1);
    const A = generateId();
    db.prepare("INSERT INTO film_flow_applies (id, flow_id, project_id, fingerprint, targets_json, status) VALUES (?, ?, ?, 'fp', '[]', 'complete')").run(A, F, P);
    const { assetId } = await flowOutput(F, A);
    const r = recipe.assetRecipe(db, assetId);
    everyFieldAccounted(r, 'applied run');
    assert.equal(r.flow.apply.id, A);
    assert.ok(!r.flow.unknown.includes('apply'));
});

test('a deleted flow and a deleted run are named unknown, never guessed', async () => {
    const F = makeFlow(2);
    const { runId, assetId } = await flowOutput(F);
    db.prepare('DELETE FROM film_flow_runs WHERE id = ?').run(runId);
    db.prepare('DELETE FROM film_flows WHERE id = ?').run(F);
    const r = recipe.assetRecipe(db, assetId);
    everyFieldAccounted(r, 'deleted flow and run');
    for (const f of ['flow', 'flow_version', 'run', 'generated_by', 'provider', 'model']) {
        assert.ok(r.flow.unknown.includes(f), `${f}: not named unknown once its source is gone`);
    }
    assert.equal(r.flow.node, 'save', 'what the asset itself records must survive');
});

test('a frame picked from a flow carries where it came from', async () => {
    const F = makeFlow(4);
    const { runId, assetId } = await flowOutput(F);
    const picked = require('../lib/flow-pick').promoteCandidate(db, assetId, {});
    assert.equal(picked.ok, true, picked.error);
    const frame = db.prepare("SELECT id FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard' ORDER BY version DESC LIMIT 1").get(SH);
    const r = recipe.assetRecipe(db, frame.id);
    everyFieldAccounted(r, 'picked frame');
    assert.equal(r.flow.run.id, runId);
    assert.equal(r.flow.flow.id, F);
    assert.equal(r.flow.provider, 'gridlight');
});

test('an asset no flow made has no flow block', () => {
    const id = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, version, provider) VALUES (?, ?, ?, 'keyframe', '/x.png', 'x.png', 1, 'muapi')").run(id, P, SH);
    assert.equal(recipe.assetRecipe(db, id).flow, null);
});

// ── the panel ──────────────────────────────────────────────────────────
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    assert.ok(m, `no ${name} on the page`);
    let i = SPA.indexOf('(', m.index), d = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') d++; else if (SPA[i] === ')' && --d === 0) break; }
    i = SPA.indexOf('{', i); d = 0;
    for (let j = i; j < SPA.length; j++) { if (SPA[j] === '{') d++; else if (SPA[j] === '}' && --d === 0) return SPA.slice(m.index, j + 1); }
}

test('the panel names the flow, and "make another" re-applies that flow to the shot through the apply', async () => {
    const F = makeFlow(5);
    const { assetId } = await flowOutput(F);
    const r = recipe.assetRecipe(db, assetId);
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const page = new Function('esc', 'pgThumb', 'pgApplyFlow', 'setStatus', 'PG', 'pgNode', 'confirmPaidImage',
        `${fnSource('pgRecipeHtml')} ${fnSource('pgRecipeFlowHtml')} ${fnSource('pgMakeAnotherPlan')} ${fnSource('pgMakeAnother')}; return { pgRecipeHtml, pgMakeAnotherPlan, pgMakeAnother };`);
    const applied = [];
    const shotNode = { type: 'shot', id: SH, key: `shot:${SH}` };
    const p = page(esc, u => u, async (flowId, targets) => applied.push({ flowId, targets }), () => {},
        { drawerCache: { howMade: { kind: 'image', parentKey: shotNode.key }, recipes: { [assetId]: r } } },
        () => shotNode, async () => { throw new Error('a flow output went to the image confirmation'); });
    const html = p.pgRecipeHtml(r);
    for (const want of ['Dusk look', 'v5', 'save', 'gen.image', 'gridlight', 'flux2-dev', r.flow.run.id.slice(0, 8)]) {
        assert.ok(html.includes(want), `the panel does not show ${want}`);
    }
    assert.match(html, /apply/i, 'the missing apply is not named');
    const plan = p.pgMakeAnotherPlan(r, 'image', shotNode);
    assert.equal(plan.flowId, F);
    assert.deepEqual(plan.targets, [`shot:${SH}`]);
    await p.pgMakeAnother(assetId);
    assert.deepEqual(applied, [{ flowId: F, targets: [`shot:${SH}`] }], 'make another did not go through the apply');

    // A flow that is gone cannot be applied again, and says so.
    const gone = { ...r, flow: { ...r.flow, flow: null, unknown: [...r.flow.unknown, 'flow'] } };
    assert.match(p.pgMakeAnotherPlan(gone, 'image', shotNode).refused || '', /flow/i);
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA, 'the iOS bundle was not re-synced');
});
