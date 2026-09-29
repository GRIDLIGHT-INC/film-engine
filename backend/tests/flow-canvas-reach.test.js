/**
 * FOG-011 (GRD-4592) — reach the Flows canvas from Production.
 *
 * With the Production graph on, the Flows page left the menu, so every flow
 * surface on the graph (the apply picker, a flow's frames on a shot, a flow
 * version's drawer, the "how was this made" panel) named a flow that could not
 * be opened. Now each one carries an "Edit flow" control that opens the canvas
 * on THAT flow, the Flows page stays reachable by address, and Back returns to
 * the graph: browser Back (a history entry is pushed for the graph) and the
 * page's own "Back to the graph" button.
 *
 * Set-based over FLOW_SURFACES: every surface that names a flow renders the way
 * in, and none is a dead end. The functions are EXECUTED over fakes; a grep
 * cannot tell a control that is rendered from one that is only written down.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    assert.ok(m, `no ${name} on the page`);
    let i = SPA.indexOf('(', m.index), d = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') d++; else if (SPA[i] === ')' && --d === 0) break; }
    i = SPA.indexOf('{', i); d = 0;
    for (let j = i; j < SPA.length; j++) { if (SPA[j] === '{') d++; else if (SPA[j] === '}' && --d === 0) return SPA.slice(m.index, j + 1); }
}
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const F = 'flow-7c1e';
const PID = '1b148030-ff97-4dc0-96c1-c0fe8f3b8e92';

function pageFns(names) {
    const c = vm.createContext({ esc, pgSrc: u => u, String, Number });
    vm.runInContext(names.map(fnSource).join('\n') + `;this.fns={${names.join(',')}};`, c);
    return c.fns;
}

// Every graph surface that names a flow, with how it is rendered for flow F.
const FLOW_SURFACES = {
    'apply picker': () => pageFns(['pgApplyPickerHtml']).pgApplyPickerHtml([{ id: F, name: 'Three looks', scope: 'project', node_count: 4 }], [], ['shot:a']),
    'flow frames on a shot': () => pageFns(['pgFlowPickControls', 'pgFlowFramesHtml']).pgFlowFramesHtml({ flow_frames: [
        { asset_id: 'a1', url: '/u1', run_id: 'R1', branch: 'root', awaiting_pick: false, flow_id: F }] }),
    'flow version drawer': () => pageFns(['pgFlowPickControls']).pgFlowPickControls({ source: 'flow', flow_id: F, run_id: 'R1', branch: 'root', awaiting_pick: false }),
    'flow version drawer, paused': () => pageFns(['pgFlowPickControls']).pgFlowPickControls({ source: 'flow', flow_id: F, run_id: 'R1', branch: 'fan#1', awaiting_pick: true }),
    'queue strip flow run': () => {
        const labels = /const PG_QUEUE_LABELS = Object\.freeze\(\{[\s\S]*?\}\);/.exec(SPA)[0];
        const c = vm.createContext({ esc, pgSrc: u => u, String, Number, Object, Math });
        vm.runInContext(`${labels} ${fnSource('pgThumb')} ${fnSource('pgQueueHtml')}; this.f = pgQueueHtml;`, c);
        const q = Object.fromEntries(Object.keys(c.PG_QUEUE_LABELS || {}).map(b => [b, []]));
        for (const b of ['running', 'waiting', 'paused', 'done_today', 'awaiting_collection', 'failed']) q[b] = q[b] || [];
        q.done_today.push({ kind: 'flow_run', run_id: 'R9', flow_id: F, flow_name: 'Three looks', key: 'shot:S', cancel: null });
        return c.f(q, true, () => '1A');
    },
    'flow form': () => pageFns(['pgFlowFormHtml']).pgFlowFormHtml({ flow_id: F, flow_name: 'Three looks', fields: [], not_fillable: [] }),
    'recipe panel': () => pageFns(['pgRecipeFlowHtml']).pgRecipeFlowHtml({ flow: { id: F, name: 'Three looks' }, flow_version: 2, node: 'save', unknown: [] }),
};

// The one flow surface deliberately without the button: the apply plan's paid
// confirmation. Leaving it for the canvas would abandon an armed confirmation;
// the picker and the form in front of it both offer Edit flow.
const NOT_A_WAY_OUT = { pgApplyPlanDescribe: 'the paid confirmation — the picker and the form before it carry Edit flow' };

test('every graph surface that names a flow carries an Edit flow control for that flow', () => {
    assert.ok(Object.keys(FLOW_SURFACES).length >= 4);
    const dead = [];
    for (const [name, render] of Object.entries(FLOW_SURFACES)) {
        if (!render().includes(`pgEditFlow('${F}')`)) dead.push(name);
    }
    assert.deepEqual(dead, [], 'these name a flow and give no way to open it');
    // The set is complete: every graph renderer that shows a flow's name is a surface above or named here.
    const named = [...SPA.slice(SPA.indexOf('let PRODUCTION_GRAPH_ON')).matchAll(/function\s+(pg\w+)\s*\(/g)].map(m => m[1])
        .filter(n => /flow_name|f\.flow\.name|\.flow_id\b/.test(fnSource(n)) && /return\s*`/.test(fnSource(n)));
    const covered = ['pgApplyPickerHtml', 'pgFlowFramesHtml', 'pgFlowPickControls', 'pgQueueHtml', 'pgFlowFormHtml', 'pgRecipeFlowHtml', ...Object.keys(NOT_A_WAY_OUT)];
    assert.ok(named.length >= 4, `found only ${named}`);
    assert.deepEqual(named.filter(n => !covered.includes(n)), [], 'a graph renderer names a flow and is neither a surface nor a named exception');
    // The version drawer still renders its controls through pgFlowPickControls.
    assert.match(fnSource('pgDrawerVersion'), /pgFlowPickControls\(n\)/);
    // No flow id, no button: a deleted flow is never offered as editable.
    const fns = pageFns(['pgFlowPickControls', 'pgRecipeFlowHtml']);
    assert.equal(fns.pgFlowPickControls({ source: 'flow', awaiting_pick: false, run_id: 'R', branch: 'b' }), '');
    assert.doesNotMatch(fns.pgRecipeFlowHtml({ flow: null, unknown: ['flow'] }), /pgEditFlow/);
});

/** pgEditFlow, the router and loadFlowsPage over a fake browser. */
function browser() {
    const calls = { navigateTo: [], opened: [], closed: [] };
    const c = vm.createContext({
        PID, calls, String, JSON, Promise,
        location: { hash: `#/${PID}/productiongraph` },
        state: { currentProject: { id: PID }, currentPage: 'productiongraph' },
        FLOW: { types: null },
        PRODUCTION_GRAPH_ON: true,
        document: { getElementById: id => (c.els[id] = c.els[id] || { innerHTML: '', style: {}, hidden: true }) },
        els: {},
        api: async (u) => u.endsWith('/node-types') ? {} : { flows: [{ id: 'first', name: 'First', node_count: 1 }, { id: F, name: 'Three looks', node_count: 4 }] },
        renderFlowPalette() {}, setFlowStatus() {}, escapeHtml: esc,
        closeModal: id => calls.closed.push(id),
        flowCanvasOpen: async id => { calls.opened.push(id); c.FLOW.flow = { id }; },
    });
    c.history = {
        stack: [c.location.hash],
        pushState(a, b, url) { this.stack.push(url); c.location.hash = url; },
        replaceState(a, b, url) { this.stack[this.stack.length - 1] = url; c.location.hash = url; },
        back() { this.stack.pop(); c.location.hash = this.stack[this.stack.length - 1]; c.applyRoute(); },
    };
    vm.runInContext(`
        const ROUTE = { writing: false };
        ${fnSource('writeRoute')} ${fnSource('readRoute')} ${fnSource('applyRoute')}
        function navigateTo(page) { calls.navigateTo.push(page); state.currentPage = page; writeRoute(); if (page === 'flows') this.loading = loadFlowsPage(); }
        function openProject() { throw new Error('the project did not change'); }
        function backToProjectList() { throw new Error('left the project'); }
        ${fnSource('loadFlowsPage')} ${fnSource('pgEditFlow')} ${fnSource('flowBackToGraph')}
        this.applyRoute = applyRoute; this.pgEditFlow = pgEditFlow; this.flowBackToGraph = flowBackToGraph;
        this.navigateTo = navigateTo; this.loadFlowsPage = loadFlowsPage;`, c);
    return c;
}

test('Edit flow opens the canvas on that flow, not the first one, and closes the picker', async () => {
    const b = browser();
    await b.pgEditFlow(F);
    await b.loading;
    assert.equal(b.state.currentPage, 'flows');
    assert.equal(b.location.hash, `#/${PID}/flows`);
    assert.deepEqual(b.calls.opened, [F], 'opened a different flow');
    assert.ok(b.calls.closed.includes('pgApplyModal'), 'the picker stayed open over the canvas');
    const back = b.els.flowBackToGraph;
    assert.ok(back && !back.hidden, 'no Back to the graph on the Flows page');
    // A later refresh of the page keeps the flow being edited and the way back.
    b.calls.opened.length = 0;
    await b.loadFlowsPage();
    assert.deepEqual(b.calls.opened, [F], 'a refresh jumped to the first flow');
    assert.ok(!b.els.flowBackToGraph.hidden);
});

test('browser Back and the page\'s own Back both return to the graph', async () => {
    const b = browser();
    await b.pgEditFlow(F);
    await b.loading;
    b.history.back();
    assert.equal(b.state.currentPage, 'productiongraph', 'browser Back did not return to the graph');

    const b2 = browser();
    await b2.pgEditFlow(F);
    await b2.loading;
    b2.flowBackToGraph();
    assert.equal(b2.state.currentPage, 'productiongraph', 'Back to the graph did not return to it');
    assert.equal(b2.location.hash, `#/${PID}/productiongraph`);
});

test('with the graph on, the Flows page is reachable by address, with no back button when not arriving from the graph', async () => {
    const b = browser();
    b.location.hash = `#/${PID}/flows`;
    b.history.stack = [`#/${PID}/flows`];
    b.applyRoute();
    await b.loading;
    assert.equal(b.state.currentPage, 'flows');
    assert.deepEqual(b.calls.opened, ['first'], 'the plain address should open the first flow');
    assert.ok(b.els.flowBackToGraph.hidden, 'offered a way back to somewhere nobody came from');
    // The page carries the button, hidden until needed.
    assert.match(SPA, /id="flowBackToGraph"[^>]*hidden/);
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA, 'the iOS bundle was not re-synced');
});
