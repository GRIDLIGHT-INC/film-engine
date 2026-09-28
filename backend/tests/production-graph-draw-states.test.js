/**
 * PGN-005 — the out-of-date states are drawn on the graph.
 *
 * PGN-004 put `impact = {state, why, action, badges}` on every node. This holds
 * the page to showing it: a border and a pill per state, edges coloured by the
 * node they lead into, a legend with counts, the why and the action in the
 * tooltip and the drawer, and a filter for "only what's behind".
 *
 * Set-based: the page's look table must name exactly the server's states, and
 * every page helper is EXECUTED over every state rather than grepped.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pg = require('../lib/production-graph');
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), parens = 0;
    for (; i < SPA.length; i++) {
        if (SPA[i] === '(') parens++;
        else if (SPA[i] === ')' && --parens === 0) { i++; break; }
    }
    let depth = 0;
    for (let j = SPA.indexOf('{', i); j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}
function constSource(name) {
    const m = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(SPA);
    if (!m) return null;
    let depth = 0;
    for (let j = m.index; j < SPA.length; j++) {
        const ch = SPA[j];
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (ch === ';' && depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}
function load(names, extra = '') {
    for (const n of names) assert.ok(fnSource(n) || constSource(n), `the page has no ${n}`);
    const src = names.map(n => fnSource(n) || constSource(n)).join('\n');
    return new Function(`const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
        ${extra}
        ${src}
        return { ${names.join(', ')} };`)();
}
const node = (state, extra) => Object.assign({ key: 'shot:1', type: 'shot', impact: { state, why: 'why-' + state, action: 'act-' + state, badges: [] } }, extra);

test('the page draws exactly the server\'s states, and every non-current state says what to do', () => {
    const { PG_IMPACT_LOOK } = load(['PG_IMPACT_LOOK']);
    assert.deepEqual(Object.keys(PG_IMPACT_LOOK).sort(), [...pg.IMPACT_STATES].sort());
    for (const s of pg.IMPACT_STATES) {
        assert.ok(PG_IMPACT_LOOK[s].label, `${s}: no label`);
        assert.match(PG_IMPACT_LOOK[s].color || '', /^#[0-9a-f]{6}$/i, `${s}: no colour`);
        if (s === 'current') continue;
        const r = pg.NODE_IMPACT.link({ type: 'link', stale: s === 'redo' }, {});
        assert.ok(r.action !== undefined, 'impact carries an action');
    }
    for (const s of pg.IMPACT_STATES.filter(x => x !== 'current')) {
        assert.ok(pg.IMPACT_ACTION[s], `server: no action text for ${s}`);
    }
});

test('every state decorates the node: a class, and a pill with the why and the action, except current', () => {
    const { pgImpactDecorate } = load(['PG_IMPACT_LOOK', 'pgImpactPill', 'pgImpactDecorate']);
    const html = '<div class="pg-node pg-shot" data-key="shot:1" style="left:0"><div class="inner">x</div></div>';
    for (const s of pg.IMPACT_STATES) {
        const out = pgImpactDecorate(html, node(s));
        assert.match(out, new RegExp(`class="pg-node imp-${s}\\b`), `${s}: no class on the node`);
        if (s === 'current') { assert.doesNotMatch(out, /pg-imp"/, 'current draws no pill'); continue; }
        assert.match(out, /class="pg-imp"/, `${s}: no pill`);
        assert.match(out, new RegExp(`why-${s}`), `${s}: why not in the tooltip`);
        assert.match(out, new RegExp(`act-${s}`), `${s}: action not in the tooltip`);
        assert.ok(out.indexOf('pg-imp"') > out.indexOf('>'), 'the pill is inside the node, not before it');
    }
    const withBadge = pgImpactDecorate(html, node('current', { impact: { state: 'current', why: '', action: '', badges: [{ stage: 'voice', state: 'redo' }] } }));
    assert.match(withBadge, /voice/, 'a badge stage is shown even when the node itself is current');
    assert.equal(pgImpactDecorate(html, { key: 'x', type: 'shot' }), html.replace('class="pg-node', 'class="pg-node'), 'no impact → unchanged');
});

test('edges into a node that is behind take that state\'s colour; others keep theirs', () => {
    const { pgEdgeColor, PG_IMPACT_LOOK } = load(['PG_IMPACT_LOOK', 'pgEdgeColor']);
    assert.equal(pgEdgeColor('#123456', node('redo')), PG_IMPACT_LOOK.redo.color);
    assert.equal(pgEdgeColor('#123456', node('waiting')), PG_IMPACT_LOOK.waiting.color);
    for (const s of ['current', 'never', 'untracked']) assert.equal(pgEdgeColor('#123456', node(s)), '#123456', s);
    assert.equal(pgEdgeColor('#123456', null), '#123456');
});

test('"only what\'s behind" keeps behind nodes and their parents, and drops the rest', () => {
    const { pgBehindKeep } = load(['pgBehind', 'pgBehindKeep']);
    const nodes = [
        { key: 'shot:a', type: 'shot', impact: { state: 'redo' } },
        { key: 'shot:b', type: 'shot', impact: { state: 'current' } },
        { key: 'shot:c', type: 'shot', impact: { state: 'current', badges: [{ stage: 'voice', state: 'waiting' }] } },
        { key: 'ver:v1', type: 'video', parent: 'shot:b', impact: { state: 'redo' } },
        { key: 'ver:v2', type: 'video', parent: 'shot:a', impact: { state: 'current' } },
        { key: 'shot:d', type: 'shot', impact: { state: 'untracked' } },
    ];
    const keep = n => pgBehindKeep(n, nodes);
    assert.deepEqual(nodes.filter(keep).map(n => n.key).sort(), ['shot:a', 'shot:b', 'shot:c', 'ver:v1']);
    assert.match(fnSource('pgVisible'), /behindOnly/, 'pgVisible ignores the filter');
});

test('the legend counts every state and offers the filter with how many are behind', () => {
    const { pgLegendHtml } = load(['PG_IMPACT_LOOK', 'pgBehind', 'pgLegendHtml']);
    const nodes = pg.IMPACT_STATES.map((s, i) => ({ key: 'n' + i, type: 'shot', impact: { state: s } }))
        .concat([{ key: 'nx', type: 'shot', impact: { state: 'redo' } }]);
    const html = pgLegendHtml(nodes, false);
    for (const s of pg.IMPACT_STATES) assert.ok(html.includes('imp-' + s), `${s} missing from the legend`);
    assert.match(html, /2\s*redo/i, 'redo counted twice');
    assert.match(html, /only what.s behind/i);
    assert.match(html, /\(3\)/, 'three nodes behind (two redo, one waiting)');
    assert.match(pgLegendHtml(nodes, true), /\bon\b/, 'the toggle shows it is on');
    assert.match(fnSource('pgHeader'), /pgLegendHtml\(/, 'the header does not draw the legend');
    assert.match(SPA, /id="pgLegend"/, 'no legend slot in the page');
});

test('the drawer explains a node that is behind, and says nothing for one that is current', () => {
    const { pgImpactDrawerHtml } = load(['PG_IMPACT_LOOK', 'pgImpactDrawerHtml']);
    for (const s of pg.IMPACT_STATES) {
        const html = pgImpactDrawerHtml(node(s));
        if (s === 'current') { assert.equal(html, ''); continue; }
        assert.match(html, new RegExp(`why-${s}`));
        assert.match(html, new RegExp(`act-${s}`));
    }
    assert.match(fnSource('pgRenderDrawer'), /pgImpactDrawerHtml\(/, 'the drawer does not draw it');
});

test('every node type goes through the decoration, and every edge through the colour rule', () => {
    assert.match(fnSource('pgNodeHtml'), /pgImpactDecorate\(/);
    assert.match(fnSource('pgDrawEdges'), /pgEdgeColor\(/);
});
