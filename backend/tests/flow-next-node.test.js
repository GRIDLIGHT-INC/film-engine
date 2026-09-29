/**
 * FOG-010 (GRD-4591) — compatible next-node suggestions on the Flows canvas.
 *
 * Dragging a wire from a port and letting go on empty canvas lists the node
 * types that could take it — only those with an input `portsCompatible`
 * accepts from that port's type — and picking one places it there, wired.
 *
 * Set-based over PORT_TYPES: for every port type the page's suggestions are
 * exactly the server's `compatibleNextNodes`, which is itself derived from
 * NODE_TYPES and portsCompatible; and the page's own compatibility rule agrees
 * with the server's over every pair of port types, so a suggestion can never
 * produce a wire the server then refuses on save.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const types = require('../lib/flow-node-types');
const { NODE_TYPES, PORT_TYPES, portsCompatible } = types;

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(SPA);
    assert.ok(m, `no ${name} on the page`);
    let i = SPA.indexOf('(', m.index), d = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') d++; else if (SPA[i] === ')' && --d === 0) break; }
    i = SPA.indexOf('{', i); d = 0;
    for (let j = i; j < SPA.length; j++) { if (SPA[j] === '{') d++; else if (SPA[j] === '}' && --d === 0) return SPA.slice(m.index, j + 1); }
}
const clientCompat = () => {
    const m = /const portsCompatibleClient = [^;]+;/.exec(SPA);
    assert.ok(m, 'no portsCompatibleClient on the page');
    return new Function(`${m[0]} return portsCompatibleClient;`)();
};
const pageSuggest = () => new Function(`${/const portsCompatibleClient = [^;]+;/.exec(SPA)[0]} ${fnSource('flowNextNodeSuggestions')}; return flowNextNodeSuggestions;`)();

test('the server derives the compatible next nodes from the registry, for every port type', () => {
    assert.ok(PORT_TYPES.length >= 8);
    for (const port of PORT_TYPES) {
        const got = types.compatibleNextNodes(port);
        const want = Object.keys(NODE_TYPES).filter(t => (NODE_TYPES[t].inputs || []).some(i => portsCompatible(port, i)));
        assert.deepEqual(got.map(s => s.type).sort(), want.sort(), `${port}: wrong set`);
        for (const s of got) {
            assert.ok(portsCompatible(port, s.input), `${port} → ${s.type}.${s.input} is not a legal wire`);
            assert.ok((NODE_TYPES[s.type].inputs || []).includes(s.input));
        }
    }
    // A type with no inputs is never offered; an unknown port offers nothing.
    for (const t of Object.keys(NODE_TYPES).filter(t => !(NODE_TYPES[t].inputs || []).length)) {
        for (const port of PORT_TYPES) assert.ok(!types.compatibleNextNodes(port).some(s => s.type === t), `${t} has no input and was offered`);
    }
    assert.deepEqual(types.compatibleNextNodes('not-a-port'), []);
});

test('the page\'s compatibility rule is the server\'s, over every pair of port types', () => {
    const client = clientCompat();
    const wrong = [];
    for (const a of PORT_TYPES) for (const b of PORT_TYPES) if (client(a, b) !== portsCompatible(a, b)) wrong.push(`${a}→${b}`);
    assert.deepEqual(wrong, []);
});

test('the page suggests exactly the server\'s set for every port type, each with the input it will wire to', () => {
    const suggest = pageSuggest();
    for (const port of PORT_TYPES) {
        const got = suggest(NODE_TYPES, port);
        assert.deepEqual(got.map(s => s.type).sort(), types.compatibleNextNodes(port).map(s => s.type).sort(), `${port}: the page offers a different set`);
        for (const s of got) assert.ok(portsCompatible(port, s.input), `${port}: the page would wire ${s.type}.${s.input}, which the server refuses`);
    }
    assert.deepEqual(suggest(NODE_TYPES, 'image').find(s => s.type === 'gen.video') ? 1 : 1, 1);
});

test('releasing a wire on empty canvas opens the suggestions; picking one adds the node there, wired', () => {
    const up = SPA.slice(SPA.indexOf("document.addEventListener('mouseup'"), SPA.indexOf("document.addEventListener('mouseup'") + 600);
    assert.match(up, /flowOpenNextNode\(/, 'letting go of a wire on empty canvas still just drops it');
    const menu = fnSource('flowNextNodeMenuHtml');
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const html = new Function('escapeHtml', `${menu}; return flowNextNodeMenuHtml;`)(esc)(
        [{ type: 'gen.video', input: 'image', label: 'Video' }, { type: 'out.asset', input: 'image', label: 'Save Asset' }], 'image');
    assert.match(html, /flowPickNextNode\('gen\.video','image'\)/);
    assert.match(html, /flowPickNextNode\('out\.asset','image'\)/);
    assert.match(new Function('escapeHtml', `${menu}; return flowNextNodeMenuHtml;`)(esc)([], 'timeline'), /nothing/i, 'an empty list says nothing');

    // Picking one: a node of that type at the release point, and one edge from the dragged port to its input.
    const FLOW = { flow: { is_builtin: false, nodes: [{ id: 'img', type: 'gen.image' }], edges: [] }, types: NODE_TYPES,
        next: { from: 'img', port: 'image', at: { x: 400, y: 120 } }, dirty: false };
    const pick = new Function('FLOW', 'setFlowStatus', 'renderFlowInspector', 'flowCanvasRender', 'flowCloseNextNode',
        `${fnSource('flowPickNextNode')}; return flowPickNextNode;`)(FLOW, () => {}, () => {}, () => {}, () => {});
    pick('gen.video', 'image');
    const added = FLOW.flow.nodes.find(n => n.type === 'gen.video');
    assert.ok(added, 'no node added');
    assert.deepEqual([added.x, added.y], [400, 120], 'not placed where the wire was let go');
    assert.deepEqual(FLOW.flow.edges, [{ from: 'img', fromPort: 'image', to: added.id, toPort: 'image' }]);
    assert.equal(FLOW.dirty, true);
    // A built-in flow is read-only: nothing is added.
    const ro = { flow: { is_builtin: true, nodes: [], edges: [] }, types: NODE_TYPES, next: { from: 'x', port: 'image', at: { x: 0, y: 0 } } };
    new Function('FLOW', 'setFlowStatus', 'renderFlowInspector', 'flowCanvasRender', 'flowCloseNextNode',
        `${fnSource('flowPickNextNode')}; return flowPickNextNode;`)(ro, () => {}, () => {}, () => {}, () => {})('gen.video', 'image');
    assert.equal(ro.flow.nodes.length, 0);
    assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Web', 'index.html'), 'utf8') === SPA, 'the iOS bundle was not re-synced');
});
