/**
 * FOG-012 (GRD-4593) — MCP: flow_apply_plan and flow_apply.
 *
 * The apply family is what lets an agent put a flow on the Production graph:
 * plan it for free, fill its form, apply it, read it back. Each tool must
 * dispatch THROUGH its route (one validator, one budget gate), the free ones
 * must say they are free and write nothing, the apply must say it spends and
 * refuse without the plan's fingerprint, and none may reach a server-side LLM.
 *
 * Set-based over the router: the family is every handler handleFlows dispatches
 * for an `apply-plan`, `form`, `apply` or `flow-applies` path, read from the
 * source, so a fifth handler added to the family arrives covered or fails.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fog012-' + crypto.randomUUID().slice(0, 8));
for (const k of Object.keys(process.env)) {
    if (/_API_KEY$|_API_SECRET$|^RUNWAYML_/.test(k)) delete process.env[k];
}
process.env.GRIDLIGHT_ENABLED = '0';
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const mcp = require('../lib/mcp-tools');
const { handleFlows, writeGraph } = require('../routes/flows');

const ROUTER = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flows.js'), 'utf8');

/** handler name → { method, segment } for every dispatch in the apply family, read from the router. */
function applyFamily() {
    const body = ROUTER.slice(ROUTER.indexOf('function handleFlows'));
    const out = new Map();
    const re = /if \(([^\n]*?)\) return (\w+)\(req, res/g;
    let m;
    while ((m = re.exec(body))) {
        const cond = m[1];
        const seg = /urlParts\[3\] === '(apply-plan|form|apply)'/.exec(cond);
        const applies = /flow-applies/.test(body.slice(Math.max(0, m.index - 400), m.index)) && /!urlParts\[3\]/.test(cond)
            && body.lastIndexOf("'flow-applies'", m.index) > body.lastIndexOf("'flow-runs'", m.index);
        if (!seg && !applies) continue;
        const method = (/req\.method === '(\w+)'/.exec(cond) || [])[1];
        out.set(m[2], { method, segment: seg ? seg[1] : 'flow-applies' });
    }
    return out;
}
function fnSource(name) {
    const i = ROUTER.indexOf(`function ${name}(`);
    let d = 0;
    for (let j = ROUTER.indexOf('{', ROUTER.indexOf(')', i)); j < ROUTER.length; j++) {
        if (ROUTER[j] === '{') d++;
        else if (ROUTER[j] === '}' && --d === 0) return ROUTER.slice(i, j + 1);
    }
}
/** The request fields a handler reads: body.x, q.x and query.x. */
function fieldsRead(name) {
    const src = fnSource(name);
    return [...new Set([...src.matchAll(/\b(?:body|q|query)\.(\w+)/g)].map(m => m[1]))];
}
const toolFor = handler => mcp.ROUTE_TOOLS.filter(t => t.route === handler);

test('the family is read from the router, and each handler has exactly one tool, listed, with its method', () => {
    const fam = applyFamily();
    assert.deepEqual([...fam.keys()].sort(), ['applyPlanRoute', 'applyRoute', 'formRoute', 'getApplyRoute'].sort(),
        `the router's apply family changed: ${[...fam.keys()]}`);
    const listed = new Set(mcp.listTools().map(t => t.name));
    for (const [handler, d] of fam) {
        const tools = toolFor(handler);
        assert.equal(tools.length, 1, `${handler}: ${tools.length} tools route to it`);
        assert.ok(listed.has(tools[0].name), `${tools[0].name} is not in tools/list`);
        assert.equal(tools[0].method, d.method, `${tools[0].name} is ${tools[0].method}, the route is ${d.method}`);
    }
});

test('every field a handler reads reaches it through its tool, and every schema field is one the handler reads', () => {
    for (const [handler, d] of applyFamily()) {
        const tool = toolFor(handler)[0];
        const read = fieldsRead(handler);
        const schemaKeys = Object.keys(tool.schema || {});
        const idKey = handler === 'getApplyRoute' ? 'apply_id' : 'flow_id';
        for (const f of read) assert.ok(schemaKeys.includes(f), `${tool.name}: the route reads ${f} and the tool cannot send it`);
        for (const k of schemaKeys) {
            if (k === idKey) continue;
            assert.ok(read.includes(k), `${tool.name}: its schema offers ${k}, which ${handler} never reads`);
            // …and it actually travels: in the body for a POST, in the query for a GET.
            if (d.method === 'POST') assert.ok((tool.bodyKeys || []).includes(k), `${tool.name}: ${k} is not forwarded in the body`);
            else {
                const probe = { [idKey]: 'x', targets: ['shot:a'], [k]: k === 'targets' ? ['shot:a'] : (k === 'vars' || k === 'inputs' ? { n: 'v' } : 'v') };
                assert.ok(new URL('http://h' + tool.path(probe)).searchParams.has(k), `${tool.name}: ${k} never reaches the query`);
            }
        }
    }
});

test('the free tools say FREE and nothing about spending; the apply says it spends and needs the plan fingerprint', () => {
    for (const [handler, d] of applyFamily()) {
        const tool = toolFor(handler)[0];
        if (d.method === 'GET') {
            assert.match(tool.description, /\bFREE\b/, `${tool.name} does not say it is free`);
            assert.doesNotMatch(tool.description, /SPENDS MONEY/, `${tool.name} is free and says it spends`);
        } else {
            assert.match(tool.description, /SPENDS MONEY/, `${tool.name} spends and does not say so`);
            assert.ok((tool.required || []).includes('fingerprint'), `${tool.name} does not require the plan fingerprint`);
            assert.match(tool.description, /flow_apply_plan/, `${tool.name} does not say to read the plan first`);
        }
    }
});

test('no tool in the family reaches a server-side LLM', () => {
    const modules = ['routes/flows.js', 'lib/flow-apply.js', 'lib/flow-form.js'];
    for (const m of modules) {
        const src = fs.readFileSync(path.join(__dirname, '..', m), 'utf8');
        assert.doesNotMatch(src, /require\([^)]*llm-client[^)]*\)/, `${m} requires the LLM client`);
    }
    for (const handler of applyFamily().keys()) {
        assert.doesNotMatch(fnSource(handler), /llm|anthropic|callLLM/i, `${handler} talks to a model`);
    }
});

// ── through the tools, for real ────────────────────────────────────────
const P = generateId(), SC = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Apply over MCP')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'SQUARE')").run(SC, P);
const S = {};
for (const code of ['1A', '1B']) {
    S[code] = generateId();
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(S[code], SC, code, JSON.stringify({ action: 'She crosses', characters: ['MAYA'] }));
}
const FLOW = generateId();
db.prepare("INSERT INTO film_flows (id, project_id, name, is_builtin, version) VALUES (?, ?, 'Free binder', 0, 1)").run(FLOW, P);
// Binds the card and a subject, calls no provider: an apply of it spends nothing.
writeGraph(FLOW, { nodes: [{ id: 'sc', type: 'in.scene', config: {} }, { id: 'su', type: 'in.subject', config: { exposed: true } }], edges: [] });

const count = t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const targets = [`shot:${S['1A']}`, `shot:${S['1B']}`];
async function direct(method, urlPath, query, body) {
    const res = { statusCode: null, body: null, writeHead(c) { this.statusCode = c; }, end(p) { this.body = JSON.parse(p); } };
    await handleFlows({ method, body: body || {} }, res, urlPath.split('/').filter(Boolean), query || {});
    return res;
}

test('plan through the tool: the route\'s own answer, and nothing written', async () => {
    const before = [count('film_flow_applies'), count('film_flow_runs'), count('film_cost_entries')];
    const viaTool = mcp.presentResult(await mcp.callTool('flow_apply_plan', { flow_id: FLOW, targets }));
    const viaRoute = await direct('GET', `/film/flows/${FLOW}/apply-plan`, { targets: targets.join(',') });
    assert.equal(viaRoute.statusCode, 200);
    assert.deepEqual(viaTool, viaRoute.body, 'the tool answered something other than the route');
    assert.equal(viaTool.runs, 2);
    assert.ok(viaTool.fingerprint);
    assert.deepEqual([count('film_flow_applies'), count('film_flow_runs'), count('film_cost_entries')], before, 'a free plan wrote something');
    const form = mcp.presentResult(await mcp.callTool('flow_form', { flow_id: FLOW }));
    assert.deepEqual(form.fields.map(f => f.node_id), ['su'], 'the form lost its exposed input');
});

test('apply through the tool: refused without the plan\'s fingerprint, one run per shot with it, readable back', async () => {
    const runs0 = count('film_flow_runs');
    const stale = await mcp.callTool('flow_apply', { flow_id: FLOW, targets, fingerprint: 'not-the-plan' });
    assert.ok(mcp.isFailure(stale));
    assert.equal(mcp.presentResult(stale).status, 409);
    assert.equal(count('film_flow_runs'), runs0, 'a refused apply started a run');

    const plan = mcp.presentResult(await mcp.callTool('flow_apply_plan', { flow_id: FLOW, targets }));
    const applied = mcp.presentResult(await mcp.callTool('flow_apply', { flow_id: FLOW, targets, fingerprint: plan.fingerprint }));
    assert.ok(applied.apply_id, JSON.stringify(applied));
    assert.equal(count('film_flow_runs'), runs0 + 2, 'not one run per shot');
    let got;
    for (let i = 0; i < 200; i++) {
        got = mcp.presentResult(await mcp.callTool('flow_apply_get', { apply_id: applied.apply_id }));
        if (got.status && !['running', 'pending'].includes(got.status)) break;
        await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(got.runs.length, 2);
    assert.deepEqual(got.runs.map(r => r.shot_id).sort(), [S['1A'], S['1B']].sort());
});
