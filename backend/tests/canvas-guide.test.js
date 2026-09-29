/**
 * The Production Canvas guide (a Word document with pictures) is generated
 * from scripts/make-canvas-guide.py and the pictures in
 * docs/guide/production-canvas/. The previous one lived in a temporary folder
 * and was one clean-up away from being lost — the fate of the guide before it.
 *
 * Held to the page it teaches, every set read from the code rather than typed
 * here: the epic's eight features, every right-click item, every header
 * control, every queue bucket, every node state, and every tool an agent uses
 * on the graph. A guide that names six of eight features reads as complete —
 * which is exactly how the last one went stale.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const GEN = path.join(ROOT, 'scripts', 'make-canvas-guide.py');
const IMG = path.join(ROOT, 'docs', 'guide', 'production-canvas');
const SPA = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const EPIC = fs.readFileSync(path.join(ROOT, 'docs', 'plans', 'production-graph-nodes-epic.md'), 'utf8');
// The text as the document will read: Python escapes an apostrophe inside '...' as \\'.
const guide = () => fs.readFileSync(GEN, 'utf8').replace(/\\'/g, "'");
const has = (text, label) => text.toLowerCase().includes(String(label).toLowerCase());

function fnSource(name) {
    const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(SPA);
    let depth = 0;
    for (let j = SPA.indexOf('{', m.index); j < SPA.length; j++) {
        if (SPA[j] === '{') depth++; else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
}
function constObject(name) {
    const m = new RegExp(`const\\s+${name}\\s*=\\s*Object\\.freeze\\(`).exec(SPA);
    let depth = 0, start = SPA.indexOf('(', m.index);
    for (let j = start; j < SPA.length; j++) {
        if (SPA[j] === '(') depth++; else if (SPA[j] === ')' && --depth === 0) return new Function(`return ${SPA.slice(start + 1, j)};`)();
    }
}

test('the generator lives in the repo, beside its pictures', () => {
    assert.ok(fs.existsSync(GEN), 'no scripts/make-canvas-guide.py');
    assert.ok(fs.existsSync(IMG) && fs.readdirSync(IMG).filter(f => f.endsWith('.jpg')).length >= 20, 'the pictures are not in docs/guide/production-canvas');
    assert.match(guide(), /docs['", /]+guide['", /]+production-canvas/, 'the generator does not read its pictures from the repo');
});

test('every picture the guide places exists', () => {
    const names = [...guide().matchAll(/(?:pic\(|\[)\s*'(\d\d-[a-z0-9-]+)'/g)].map(m => m[1])
        .concat([...guide().matchAll(/'(\d\d-[a-z0-9-]+)'/g)].map(m => m[1]));
    const uniq = [...new Set(names)];
    assert.ok(uniq.length >= 20, `only ${uniq.length} pictures placed`);
    assert.deepEqual(uniq.filter(n => !fs.existsSync(path.join(IMG, n + '.jpg'))), [], 'these pictures are placed and missing');
});

test('the guide teaches every one of the epic\'s eight features', () => {
    const features = [...EPIC.matchAll(/^\| (F\d) \| ([^|]+?) \|/gm)].map(m => m[2].trim().replace(/"/g, ''));
    assert.equal(features.length, 8);
    assert.deepEqual(features.filter(f => !has(guide().replace(/"/g, ''), f)), [], 'the guide does not teach these');
});

test('every right-click item, header control, queue bucket and node state is named in the guide', () => {
    const menu = fnSource('pgOpenMenu');
    const labels = new Set([...menu.matchAll(/'([A-Z][a-z][A-Za-z ]+)'/g)].map(m => m[1])
        .concat([...menu.matchAll(/>([A-Z][A-Za-z ]+)</g)].map(m => m[1])));
    const header = SPA.slice(SPA.indexOf('<div class="pg-header">'), SPA.indexOf('<div class="pg-body"'));
    for (const m of header.matchAll(/>([A-Z][A-Za-z ]+)<\/button>/g)) labels.add(m[1]);
    for (const l of Object.values(constObject('PG_QUEUE_LABELS'))) labels.add(l);
    for (const v of Object.values(constObject('PG_IMPACT_LOOK'))) labels.add(v.label);
    labels.add("Only what's behind");
    assert.ok(labels.size >= 20, `only ${labels.size} labels read from the page`);
    assert.deepEqual([...labels].filter(l => !has(guide(), l)), [], 'the guide does not name these');
});

test('every tool an agent uses on the graph is named in the guide', () => {
    const tools = require('../lib/mcp-tools').listTools().map(t => t.name)
        .filter(n => /^(production_graph|run_changed|run_to_here|generation_queue|run_cancel|generation_cancel|asset_provenance|pattern_|graph_hold|version_select)/.test(n));
    assert.ok(tools.length >= 16, `only ${tools.length} graph tools`);
    assert.deepEqual(tools.filter(t => !guide().includes(t)), [], 'the guide does not name these tools');
});
