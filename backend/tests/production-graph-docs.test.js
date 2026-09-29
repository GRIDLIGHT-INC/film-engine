/**
 * PGN-023 — the production-graph epic, recorded in CLAUDE.md and the agent
 * guide, held to the code rather than to a list typed beside it.
 *
 *   - every module the epic added is in the tree, under the directory it is in
 *     (docs-drift matches on file names, so a file listed under the wrong
 *     directory passes it);
 *   - every route the graph serves is in the API table;
 *   - the design section names each of the epic's eight features;
 *   - where progress comes from is stated per adapter, from each adapter's own
 *     `reportsProgress`, and what cancel does from each adapter's `cancel`;
 *   - the agent guide names every tool that reaches the graph's routes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CLAUDE = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const EPIC = fs.readFileSync(path.join(ROOT, 'docs', 'plans', 'production-graph-nodes-epic.md'), 'utf8');
const STATE = fs.readFileSync(path.join(ROOT, 'docs', 'plans', 'production-graph-nodes-results.md'), 'utf8');
const GUIDE = fs.readFileSync(path.join(ROOT, 'docs', 'claude-desktop-guide.md'), 'utf8');
const SECTION_TITLE = '### The Graph Shows Its Work';
const section = () => {
    const i = CLAUDE.indexOf(SECTION_TITLE);
    if (i < 0) return '';
    const next = CLAUDE.indexOf('\n### ', i + SECTION_TITLE.length);
    return CLAUDE.slice(i, next < 0 ? undefined : next);
};

/** Which backend directory the tree puts each file under. */
function treePlacement() {
    const at = {};
    let dir = null;
    for (const line of CLAUDE.split('\n')) {
        const top = line.match(/^│   [├└]── ([a-z-]+)\/\s*(#|$)/);
        if (top) { dir = top[1]; continue; }
        if (/^[├└]── /.test(line) || /^│   [├└]── [a-z-]+\.[a-z]+/.test(line)) { if (!/^│   │/.test(line)) dir = dir; }
        const f = line.match(/^│   │   [├└]── ([a-z0-9-]+\.(?:js|py|sql))\b/);
        if (f && dir) (at[f[1]] = at[f[1]] || []).push(dir);
    }
    return at;
}

test('every module the epic added is in the tree, under the directory it is actually in', () => {
    const named = [...new Set([...STATE.matchAll(/`(?:backend\/)?(lib|routes)\/([a-z0-9-]+\.js)`/g)].map(m => m[2]))];
    const files = named.map(f => ({ f, dir: ['lib', 'routes'].find(d => fs.existsSync(path.join(ROOT, 'backend', d, f))) })).filter(x => x.dir);
    assert.ok(files.length >= 10, `only ${files.length} epic modules found in the state doc`);
    const at = treePlacement();
    const wrong = files.filter(({ f, dir }) => !(at[f] || []).includes(dir)).map(({ f, dir }) => `${dir}/${f} (tree says ${(at[f] || ['nowhere']).join(', ')})`);
    assert.deepEqual(wrong, [], 'the tree misplaces or omits these');
});

test('every route the production graph serves is in the API table', () => {
    const row = CLAUDE.split('\n').filter(l => l.startsWith('| Production graph |')).join('\n');
    const src = fs.readFileSync(path.join(ROOT, 'backend', 'routes', 'production-graph.js'), 'utf8');
    const segs = [...new Set([...src.matchAll(/parts\[4\] === '([a-z-]+)'/g)].map(m => m[1]))];
    assert.ok(segs.length >= 9, `only ${segs.length} route segments`);
    const missing = segs.filter(s => !row.includes(s));
    assert.deepEqual(missing, [], 'the API table does not name these production-graph routes');
    for (const other of ['/generation-jobs/:id/cancel', '/assets/:id/provenance']) assert.ok(row.includes(other), `${other} is missing from the row`);
});

test('the design section names every one of the epic\'s eight features', () => {
    const s = section();
    assert.ok(s, `no "${SECTION_TITLE}" section in CLAUDE.md`);
    const features = [...EPIC.matchAll(/^\| (F\d) \| ([^|]+?) \|/gm)].map(m => ({ id: m[1], name: m[2].trim() }));
    assert.equal(features.length, 8, `found ${features.length} features in the epic`);
    const missing = features.filter(f => !s.toLowerCase().includes(f.name.toLowerCase())).map(f => `${f.id} ${f.name}`);
    assert.deepEqual(missing, [], 'the section does not name these features');
});

test('where progress comes from and what cancel does are stated per adapter, from their own declarations', () => {
    const s = section();
    const providers = require('../lib/providers');
    const adapters = providers.list().map(a => a.id || a.name).map(id => ({ id, a: providers.get(id) }));
    const bad = [];
    for (const { id, a } of adapters) {
        if (a.reportsProgress && a.reportsProgress !== 'none'
            && !new RegExp(`${a.reportsProgress}[^.\\n]*\\b${id}\\b|\\b${id}\\b[^.\\n]*${a.reportsProgress}`, 'i').test(s)) bad.push(`${id}: reports ${a.reportsProgress}`);
        if (a.cancel === 'provider' && !new RegExp(`\\b${id}\\b[^.\\n]*(really|truly|actually) (stops|cancels)|cancel[^.\\n]*\\b${id}\\b`, 'i').test(s)) bad.push(`${id}: cancels at the provider`);
    }
    assert.deepEqual(bad, [], 'the section does not say this about these adapters');
    assert.match(s, /no percentage from this provider/i, 'the honest fallback for a provider with no percentage is not stated');
    assert.match(s, /stop waiting/i);
    assert.match(s, /bill/i, 'stop waiting is not said to leave the job billing');
});

test('the agent guide names every tool that reaches the production graph', () => {
    const { buildTools } = require('../lib/mcp-tools');
    const tools = (typeof buildTools === 'function' ? buildTools() : require('../lib/mcp-tools').TOOLS || []);
    const list = Array.isArray(tools) ? tools : [];
    const graph = list.filter(t => /production_graph|run_changed|run_to_here|generation_queue|run_cancel|generation_cancel|asset_provenance|pattern_|graph_hold|version_select/.test(t.name)).map(t => t.name);
    assert.ok(graph.length >= 16, `only ${graph.length} graph tools found`);
    assert.deepEqual(graph.filter(n => !GUIDE.includes('`' + n + '`')), [], 'the guide does not name these');
    const s = section();
    assert.ok(graph.every(n => s.includes(n)) || /claude-desktop-guide/.test(s), 'the section neither names the tools nor points to the guide');
});
