/**
 * FOG-009 (GRD-4590) — a form view of a flow.
 *
 * A flow's input nodes can be marked EXPOSED. Applying the flow from the
 * Production graph then shows those inputs as a form — a text box for a
 * prompt, an asset picker for an asset, a subject picker for a subject — and
 * the values go through the FOG-001/002 plan and confirmation: they change
 * what the plan says each shot binds, they are part of the plan's fingerprint,
 * and the runs receive them. Only exposed nodes can be filled in, and a value
 * that could not be honoured is refused before anything starts.
 *
 * Set-based over the input node types in NODE_TYPES: each is a form control,
 * or refused with the reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog009-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { NODE_TYPES } = require('../lib/flow-node-types');
const { handleFlows, writeGraph } = require('../routes/flows');
const form = require('../lib/flow-form');

const INPUT_TYPES = Object.keys(NODE_TYPES).filter(t => NODE_TYPES[t].kind === 'input');

async function call(method, urlPath, query, body) {
    let done; const finished = new Promise(r => { done = r; });
    const res = { statusCode: null, body: null, writeHead(c) { this.statusCode = c; }, end(p) { try { this.body = JSON.parse(p); } catch (_) { this.body = p; } done(); } };
    await handleFlows({ method, body: body || {} }, res, urlPath.split('/').filter(Boolean), query || {});
    await finished;
    return res;
}

// ── fixture ────────────────────────────────────────────────────────────
const P = generateId(), SC = generateId(), SH = generateId(), OTHER = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Form')").run(P);
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Elsewhere')").run(OTHER);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'SQUARE')").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', ?)").run(SH, SC, JSON.stringify({ action: 'She crosses', characters: ['MAYA'] }));
db.prepare("INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, 'MAYA')").run(generateId(), P);
db.prepare("INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, 'RAY')").run(generateId(), P);
const ASSET = generateId(), FOREIGN = generateId();
db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, version) VALUES (?, ?, 'reference_image', '/x/ref.png', 'ref.png', 1)").run(ASSET, P);
db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, version) VALUES (?, ?, 'reference_image', '/x/far.png', 'far.png', 1)").run(FOREIGN, OTHER);

const nodeFor = (type, exposed) => ({ id: type.replace('.', '_'), type, label: `the ${type}`, config: {
    ...(type === 'in.prompt' ? { text: 'default text' } : {}), ...(exposed ? { exposed: true } : {}) } });
const FLOW = generateId();
db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'Form flow', 0, 1)").run(FLOW, P);
writeGraph(FLOW, { nodes: [...INPUT_TYPES.map(t => nodeFor(t, true)), { id: 'hidden', type: 'in.prompt', config: { text: 'kept' } }], edges: [] });

test('every input node type is a form control or refused with a reason', () => {
    assert.ok(INPUT_TYPES.length >= 4, `read only ${INPUT_TYPES.length} input types`);
    assert.deepEqual(Object.keys(form.FORM_INPUTS).sort(), [...INPUT_TYPES].sort(), 'the form registry and the node registry disagree');
    for (const t of INPUT_TYPES) {
        const f = form.FORM_INPUTS[t];
        if (f.control) assert.ok(['text', 'asset', 'subject'].includes(f.control) && f.field, `${t}: control ${f.control} with no field`);
        else assert.ok((f.why || '').length > 20, `${t} is not a form control and does not say why`);
    }
    for (const c of ['text', 'asset', 'subject']) assert.ok(INPUT_TYPES.some(t => form.FORM_INPUTS[t].control === c), `no input type renders as a ${c}`);
});

test('the form lists every exposed input that can be filled in, with its options, and names the rest', async () => {
    const r = await call('GET', `/film/flows/${FLOW}/form`, { project_id: P });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const f = r.body;
    for (const t of INPUT_TYPES) {
        const id = t.replace('.', '_');
        const field = f.fields.find(x => x.node_id === id);
        if (form.FORM_INPUTS[t].control) {
            assert.ok(field, `${t}: exposed and missing from the form`);
            assert.equal(field.control, form.FORM_INPUTS[t].control);
            assert.equal(field.label, `the ${t}`);
        } else {
            assert.ok(!field, `${t}: offered as a form field`);
            assert.ok(f.not_fillable.some(x => x.node_id === id && x.why), `${t}: exposed, not fillable, and not said`);
        }
    }
    assert.ok(!f.fields.some(x => x.node_id === 'hidden'), 'an input nobody exposed is on the form');
    const prompt = f.fields.find(x => x.control === 'text');
    assert.equal(prompt.default, 'default text');
    const asset = f.fields.find(x => x.control === 'asset');
    assert.ok(asset.options.some(o => o.id === ASSET) && !asset.options.some(o => o.id === FOREIGN), 'the asset picker offers the wrong assets');
    const subject = f.fields.find(x => x.control === 'subject');
    assert.deepEqual(subject.options.map(o => o.name).sort(), ['MAYA', 'RAY']);
});

const VALUES = { in_prompt: 'form text', in_asset: ASSET, in_subject: 'RAY' };
const valueFor = t => VALUES[t.replace('.', '_')];

test('the values change what the plan binds, and they are part of its fingerprint', async () => {
    const plain = await call('GET', `/film/flows/${FLOW}/apply-plan`, { project_id: P, targets: `shot:${SH}` });
    assert.equal(plain.statusCode, 200, JSON.stringify(plain.body));
    const filled = await call('GET', `/film/flows/${FLOW}/apply-plan`, { project_id: P, targets: `shot:${SH}`, inputs: JSON.stringify(VALUES) });
    assert.equal(filled.statusCode, 200, JSON.stringify(filled.body));
    assert.notEqual(filled.body.fingerprint, plain.body.fingerprint, 'the form values are not in the fingerprint');
    const bindings = filled.body.shots[0].bindings;
    for (const t of INPUT_TYPES.filter(x => form.FORM_INPUTS[x].control)) {
        const b = bindings.find(x => x.node_id === t.replace('.', '_'));
        assert.ok(b, `${t}: no binding`);
        assert.match(String(b.binds), /form/i, `${t}: the plan does not say the form supplied it`);
        if (t !== 'in.asset') assert.equal(b.value, valueFor(t), `${t}: the plan binds ${b.value}`);
    }
    assert.equal(bindings.find(x => x.node_id === 'hidden').value, 'kept', 'an unexposed input changed');
});

test('the runs receive the values: an apply with the form fills every exposed input', async () => {
    const plan = await call('GET', `/film/flows/${FLOW}/apply-plan`, { project_id: P, targets: `shot:${SH}`, inputs: JSON.stringify(VALUES) });
    const r = await call('POST', `/film/flows/${FLOW}/apply`, {}, { project_id: P, targets: [`shot:${SH}`], fingerprint: plan.body.fingerprint, inputs: VALUES });
    assert.equal(r.statusCode, 202, JSON.stringify(r.body));
    const runId = r.body.runs[0].run_id;
    for (let i = 0; i < 100; i++) {
        const s = db.prepare('SELECT status FROM film_flow_runs WHERE id = ?').get(runId);
        if (s && !['pending', 'running'].includes(s.status)) break;
        await new Promise(res => setTimeout(res, 20));
    }
    const out = id => { const row = db.prepare('SELECT outputs FROM film_flow_node_runs WHERE run_id = ? AND node_id = ?').get(runId, id); return row ? JSON.parse(row.outputs) : {}; };
    assert.equal(out('in_prompt').text.value, 'form text');
    assert.equal(out('in_subject').subject.value.name, 'RAY');
    assert.equal(Object.values(out('in_asset'))[0].value.assetId, ASSET);
    assert.equal(out('hidden').text.value, 'kept');
    // Applying with different values than the plan was read for is a moved plan.
    const moved = await call('POST', `/film/flows/${FLOW}/apply`, {}, { project_id: P, targets: [`shot:${SH}`], fingerprint: plan.body.fingerprint, inputs: { in_prompt: 'something else' } });
    assert.equal(moved.statusCode, 409);
});

test('a value that could not be honoured is refused before anything is planned or started', async () => {
    const hidden = generateId();
    db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'Nothing exposed', 0, 1)").run(hidden, P);
    writeGraph(hidden, { nodes: INPUT_TYPES.map(t => nodeFor(t, false)), edges: [] });
    const cases = [
        [FLOW, { nowhere: 'x' }, /no input node/i],
        [hidden, { in_prompt: 'x' }, /not exposed/i],
        [FLOW, { in_scene: 'x' }, /scene|cannot be filled/i],
        [FLOW, { in_asset: FOREIGN }, /asset/i],
        [FLOW, { in_asset: 'no-such-asset' }, /asset/i],
    ];
    for (const [flowId, inputs, why] of cases) {
        const p = await call('GET', `/film/flows/${flowId}/apply-plan`, { project_id: P, targets: `shot:${SH}`, inputs: JSON.stringify(inputs) });
        assert.equal(p.statusCode, 400, `${JSON.stringify(inputs)} was planned`);
        assert.match(p.body.error, why);
        const before = db.prepare('SELECT COUNT(*) AS n FROM film_flow_applies').get().n;
        const a = await call('POST', `/film/flows/${flowId}/apply`, {}, { project_id: P, targets: [`shot:${SH}`], fingerprint: 'x', inputs });
        assert.equal(a.statusCode, 400, `${JSON.stringify(inputs)} was applied`);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM film_flow_applies').get().n, before, 'a refused apply wrote a record');
    }
});

test('an agent reaches the form: flow_form, and inputs on the plan and the apply tools', () => {
    const { buildTools } = require('../lib/mcp-tools');
    const tools = (typeof buildTools === 'function' ? buildTools() : require('../lib/mcp-tools').TOOLS || []);
    const list = Array.isArray(tools) ? tools : (tools.tools || []);
    const byName = n => list.find(t => t.name === n);
    assert.ok(byName('flow_form'), 'no flow_form tool');
    assert.match(byName('flow_form').description, /free/i);
    for (const n of ['flow_apply_plan', 'flow_apply']) {
        const schema = byName(n).inputSchema || byName(n).schema || {};
        const props = schema.properties || schema;
        assert.ok(props.inputs, `${n} does not take the form's inputs`);
    }
});

// ── the page ───────────────────────────────────────────────────────────
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    assert.ok(m, `no ${name} on the page`);
    let i = SPA.indexOf('(', m.index), d = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') d++; else if (SPA[i] === ')' && --d === 0) break; }
    i = SPA.indexOf('{', i); d = 0;
    for (let j = i; j < SPA.length; j++) { if (SPA[j] === '{') d++; else if (SPA[j] === '}' && --d === 0) return SPA.slice(m.index, j + 1); }
}

test('the drawer renders the form, every control, and the plan it confirms carries the values', async () => {
    const r = await call('GET', `/film/flows/${FLOW}/form`, { project_id: P });
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const { pgFlowFormHtml } = new Function('esc', `${fnSource('pgFlowFormHtml')}; return { pgFlowFormHtml };`)(esc);
    const html = pgFlowFormHtml(r.body);
    for (const f of r.body.fields) {
        assert.ok(html.includes(`data-form-node="${f.node_id}"`), `${f.node_id}: no control`);
        if (f.control === 'text') assert.match(html, new RegExp(`<textarea[^>]*data-form-node="${f.node_id}"`));
        else assert.match(html, new RegExp(`<select[^>]*data-form-node="${f.node_id}"`), `${f.node_id}: a ${f.control} is not a picker`);
        for (const o of f.options || []) assert.ok(html.includes(esc(o.id || o.name)), `${f.node_id}: option ${o.id || o.name} missing`);
    }
    for (const n of r.body.not_fillable) assert.ok(html.includes(esc(n.why)), 'a not-fillable input is not explained');
    assert.match(html, /pgFlowFormSubmit\(/);

    // The confirmation's plan read carries the values.
    const calls = [];
    const apply = new Function('state', 'confirmPaidImage', 'document', 'setStatus', 'api', 'PG', 'pgPollRunning', 'pgApplyArmable', 'pgApplyPlanDescribe',
        `${fnSource('pgApplyFlow')}; return pgApplyFlow;`)(
        { currentProject: { id: P } }, async o => calls.push(o.previewUrl), { getElementById: () => null }, () => {}, async () => ({}),
        { picked: new Set() }, () => {}, () => true, () => '');
    await apply(FLOW, [`shot:${SH}`], VALUES);
    assert.ok(calls[0].includes('inputs='), 'the plan read does not carry the form values');
    assert.ok(decodeURIComponent(calls[0]).includes('form text'));

    assert.match(fnSource('renderFlowInspector'), /flowNodeSetConfig\('exposed'/, 'the canvas has no way to expose an input');
    assert.match(fnSource('pgApplyChoose'), /\/form/, 'choosing a flow never reads its form');
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA, 'the iOS bundle was not re-synced');
});
