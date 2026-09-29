/**
 * FOG-003 (GRD-4584) — "Apply flow…" on the Production graph.
 *
 * Shift+click picks shots AND sequences; the node menu offers "Apply flow…";
 * a picker lists the project's flows and every ready-made template; the free
 * plan (FOG-001) renders in the ONE shared confirmation, and nothing can be
 * confirmed until that plan has loaded and says something can run. The apply
 * (FOG-002) is sent with the fingerprint of the plan the director read.
 *
 * The renderers are EXECUTED, set-based over the graph's own node types (read
 * out of lib/production-graph.js, never typed here) and over real plans the
 * backend produced — a template naming `reason` and one showing it look the
 * same in the source.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog003-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { writeGraph } = require('../routes/flows');
const apply = require('../lib/flow-apply');
const { listTemplates } = require('../lib/flow-templates');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    // Skip the parameter list by paren depth: a default `{}` is not the body.
    let i = SPA.indexOf('(', m.index), depth = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') depth++; else if (SPA[i] === ')' && --depth === 0) break; }
    i = SPA.indexOf('{', i); depth = 0;
    for (let j = i; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}
function constSource(name) {
    const m = new RegExp(`const ${name} = Object\\.freeze\\(\\[[^\\]]*\\]\\);`).exec(SPA);
    return m ? m[0] : null;
}
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A sandbox holding the page's apply functions, with the page's own esc. */
function sandbox(extra) {
    const names = ['pgApplyTargets', 'pgApplyMenuItem', 'pgApplyPickerHtml', 'pgApplyPlanDescribe', 'pgApplyArmable', 'pgApplyFlow'];
    const src = [constSource('PG_APPLY_TYPES'), ...names.map(n => {
        const s = fnSource(n); assert.ok(s, `no ${n} on the page`); return s;
    })].join('\n');
    const ctx = vm.createContext(Object.assign({ esc, encodeURIComponent, JSON, Number, Set, Object, Array, String, Promise, console }, extra || {}));
    vm.runInContext(src + '\n;this.PG_APPLY_TYPES = PG_APPLY_TYPES;' + names.map(n => `this.${n} = ${n};`).join(''), ctx);
    return ctx;
}

const GRAPH_TYPES = (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'production-graph.js'), 'utf8');
    return [...new Set([...src.matchAll(/type: '([a-z]+)'/g)].map(m => m[1]))];
})();
const TARGET_TYPES = Object.keys(apply.APPLY_TARGETS).filter(t => apply.APPLY_TARGETS[t] === true);

// ── fixture: a project with a shot, a sequence and a held shot ─────────────
const P = generateId();
const SC = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Apply flow UI')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'SQUARE')").run(SC, P);
const shot = {};
for (const code of ['1A', '1B', '1C']) {
    shot[code] = generateId();
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shot[code], SC, code, JSON.stringify({ action: 'She crosses', characters: ['MAYA'] }));
}
db.prepare("UPDATE film_shots SET held_at = datetime('now') WHERE id = ?").run(shot['1C']);
const SEQ = generateId();
db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Walk', ?)").run(SEQ, P, JSON.stringify([shot['1A'], shot['1B']]));
const FLOW = generateId();
db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'Scene still', 0, 1)").run(FLOW, P);
writeGraph(FLOW, {
    nodes: [{ id: 'sc', type: 'in.scene', config: {} }, { id: 'img', type: 'gen.image', config: {} }, { id: 'out', type: 'out.asset', config: {} }],
    edges: [{ id: 'e1', from: 'sc', fromPort: 'text', to: 'img', toPort: 'text' }, { id: 'e2', from: 'img', fromPort: 'image', to: 'out', toPort: 'image' }],
});

// ── the page's target set is the server's ─────────────────────────────────
test('the page offers "Apply flow…" on exactly the node types the server can apply a flow to', () => {
    const { PG_APPLY_TYPES } = sandbox();
    assert.deepEqual([...PG_APPLY_TYPES].sort(), [...TARGET_TYPES].sort());
});

test('every node type the graph draws gets an "Apply flow…" item: enabled on a target, disabled with the server\'s reason otherwise', () => {
    assert.ok(GRAPH_TYPES.length >= 6, `read only ${GRAPH_TYPES.length} graph node types`);
    const { pgApplyMenuItem } = sandbox();
    for (const type of GRAPH_TYPES) {
        const html = pgApplyMenuItem({ type, key: `${type}:x` }, 0);
        assert.match(html, /Apply flow/, `${type}: no Apply flow item`);
        if (apply.APPLY_TARGETS[type] === true) {
            assert.doesNotMatch(html, /disabled/, `${type} is a target and its item is disabled`);
            assert.match(html, /pgMenuDo\('apply'\)/, `${type}: the item reaches nothing`);
        } else {
            assert.match(html, /disabled/, `${type} cannot take a flow and its item is enabled`);
            assert.ok(html.includes(esc(apply.APPLY_REFUSED[type])), `${type}: the disabled item does not say why`);
        }
    }
    // With picks, the item says how many it applies to.
    assert.match(pgApplyMenuItem({ type: 'shot', key: 'shot:x' }, 3), /3/);
});

test('shift+click picks sequences as well as shots, and the targets are the picks plus the node clicked, applyable ones only', () => {
    const body = fnSource('pgRender') + SPA.slice(SPA.indexOf('Shift+click picks'), SPA.indexOf('Shift+click picks') + 400);
    assert.match(body, /g\.key\.startsWith\('seq:'\)/, 'shift+click still picks shots only');
    const { pgApplyTargets } = sandbox();
    const byKey = new Map([['shot:a', { type: 'shot' }], ['seq:q', { type: 'sequence' }], ['vid:v', { type: 'video' }]]);
    assert.deepEqual([...pgApplyTargets(['shot:a', 'seq:q'], 'shot:a', byKey)], ['shot:a', 'seq:q']);
    assert.deepEqual([...pgApplyTargets(['shot:a'], 'seq:q', byKey)], ['shot:a', 'seq:q']);
    assert.deepEqual([...pgApplyTargets([], 'seq:q', byKey)], ['seq:q']);
    assert.deepEqual([...pgApplyTargets(['vid:v'], 'shot:a', byKey)], ['shot:a'], 'a picked node that cannot take a flow was sent');
    assert.deepEqual([...pgApplyTargets([], 'vid:v', byKey)], []);
});

test('the picker lists every flow the project can see and every ready-made template', () => {
    const { pgApplyPickerHtml } = sandbox();
    const templates = listTemplates();
    assert.ok(templates.length >= 1);
    const flows = [{ id: FLOW, name: 'Scene still', scope: 'project', node_count: 3 }, { id: 'lib-1', name: 'Library look', scope: 'library', node_count: 5 }];
    const html = pgApplyPickerHtml(flows, templates, ['shot:a', 'seq:q']);
    for (const f of flows) {
        assert.ok(html.includes(esc(f.name)), `flow ${f.name} not listed`);
        assert.ok(html.includes(`pgApplyChoose('flow','${f.id}')`), `flow ${f.name} cannot be picked`);
    }
    for (const t of templates) {
        assert.ok(html.includes(esc(t.name)), `template ${t.id} not listed`);
        assert.ok(html.includes(`pgApplyChoose('template','${t.id}')`), `template ${t.id} cannot be picked`);
    }
    assert.match(html, /2 selected/);
    assert.match(pgApplyPickerHtml([], [], ['shot:a']), /no flows/i, 'an empty picker says nothing');
});

// ── the plan, rendered, for each target kind ──────────────────────────────
test('the plan renders every target kind the graph draws: runs with their cost, refusals with their reason, held shots named', () => {
    const { pgApplyPlanDescribe } = sandbox();
    const keys = GRAPH_TYPES.map(t => t === 'shot' ? `shot:${shot['1A']}` : t === 'sequence' ? `seq:${SEQ}` : `${t}:nope`);
    keys.push(`shot:${shot['1C']}`);
    const plan = apply.planApply(db, { flowId: FLOW, projectId: P, targets: keys });
    assert.ok(!plan.error, plan.error);
    const html = pgApplyPlanDescribe(plan);
    for (const t of plan.targets) {
        if (t.status === 'refused') assert.ok(html.includes(esc(t.reason)), `refused target ${t.key} (${t.type}) not explained`);
    }
    for (const s of plan.shots) {
        assert.ok(html.includes(esc(s.shot_code)), `shot ${s.shot_code} missing from the plan`);
    }
    for (const h of plan.held) assert.ok(html.includes(esc(h.shot_code)), `held shot ${h.shot_code} not named`);
    assert.ok(html.includes(esc(plan.flow_name)), 'the plan does not name the flow');
    assert.ok(html.includes('$' + plan.total_cost.toFixed(2)), 'the total is not shown');
    assert.equal(plan.runs, 2, 'fixture: 1A and 1B should run');
});

test('nothing can be confirmed until the plan loads, and not when it has nothing to run or is over budget', () => {
    const { pgApplyArmable, pgApplyPlanDescribe } = sandbox();
    assert.equal(pgApplyArmable(null), false);
    assert.equal(pgApplyArmable({ runs: 0, budget: { wouldExceed: false } }), false);
    assert.equal(pgApplyArmable({ runs: 2, budget: { wouldExceed: true, limit: 1, spent: 0 } }), false);
    assert.equal(pgApplyArmable({ runs: 2, budget: { wouldExceed: false } }), true);
    const over = pgApplyPlanDescribe({ flow_name: 'f', runs: 1, total_cost: 5, targets: [], shots: [], held: [], budget: { wouldExceed: true, limit: 1, spent: 0 } });
    assert.match(over, /pgApplyIgnoreBudget/, 'over budget offers no deliberate way past');
    // The shared confirmation honours the caller's armable, in the describe branch.
    const conf = fnSource('confirmPaidImage');
    assert.match(conf, /o\.armable \? !!o\.armable\(d\) : true/, 'confirmPaidImage arms without asking the plan');
});

test('the apply is sent with the fingerprint of the plan that was read, and the targets it was read for', async () => {
    const calls = [];
    const plan = apply.planApply(db, { flowId: FLOW, projectId: P, targets: [`seq:${SEQ}`] });
    const ctx = sandbox({
        state: { currentProject: { id: P } },
        PG: { byKey: new Map() },
        document: { getElementById: () => null },
        setStatus: () => {},
        pgPollRunning: () => {},
        api: async (url, opts) => { calls.push({ url, opts }); return { apply_id: 'a', runs: [{}, {}], summary: 's' }; },
        confirmPaidImage: async o => {
            calls.push({ preview: o.previewUrl, armed: o.armable(plan) });
            o.describe(plan);
            return o.send({});
        },
    });
    await ctx.pgApplyFlow(FLOW, [`seq:${SEQ}`]);
    assert.match(calls[0].preview, new RegExp(`/flows/${FLOW}/apply-plan\\?`));
    assert.ok(calls[0].preview.includes(`project_id=${P}`));
    assert.ok(calls[0].preview.includes(encodeURIComponent(`seq:${SEQ}`)));
    assert.equal(calls[0].armed, true);
    const post = calls.find(c => c.opts && c.opts.method === 'POST');
    assert.ok(post, 'nothing was applied');
    assert.equal(post.url, `/flows/${FLOW}/apply`);
    const body = JSON.parse(post.opts.body);
    assert.equal(body.fingerprint, plan.fingerprint);
    assert.deepEqual(body.targets, [`seq:${SEQ}`]);
    assert.equal(body.project_id, P);
    assert.equal(body.ignore_budget, false);
});
