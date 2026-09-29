/**
 * FOG-013 (GRD-4594) — the flows-on-the-graph epic, documented.
 *
 * Three readers, three documents: CLAUDE.md for whoever works on the code, the
 * Word guide to the canvas (scripts/make-canvas-guide.py) for the director, and
 * docs/claude-desktop-guide.md for the agent. The denominator is every FOG task
 * the CODE cites — lib/, routes/, the page and the tests — so a task that
 * shipped is documented or this fails, and a task the code never mentions
 * cannot be claimed here. Each one carries what it puts in front of a person
 * and what it gives an agent, or says why it has neither.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

function citedIds() {
    const files = [];
    const walk = d => {
        for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
            const rel = path.join(d, e.name);
            if (e.isDirectory()) walk(rel);
            else if (/\.(js|html)$/.test(e.name)) files.push(rel);
        }
    };
    ['backend/lib', 'backend/routes', 'backend/tests'].forEach(walk);
    files.push('src/index.html');
    const ids = new Set();
    for (const f of files) for (const m of read(f).matchAll(/\bFOG-0\d\d\b/g)) ids.add(m[0]);
    return [...ids].sort();
}

// What each task put in front of a director (a phrase the Word guide must carry)
// and in front of an agent (tools the agent guide must name), or why not.
const FEATURES = {
    'FOG-001': { guide: 'The plan', tools: ['flow_apply_plan'] },
    'FOG-002': { guide: null, why: 'The apply record and its runs; a director meets it as the plan and the queue.', tools: ['flow_apply', 'flow_apply_get'] },
    'FOG-003': { guide: 'Apply flow…', tools: [] },
    'FOG-004': { guide: 'Made by flows', tools: ['production_graph_get'] },
    'FOG-005': { guide: 'Pick', tools: ['flow_run_branches', 'flow_run_select'] },
    'FOG-006': { guide: 'Templates on the shelf', tools: ['flow_templates'] },
    'FOG-007': { guide: 'Waiting for a pick', tools: ['generation_queue', 'flow_run_cancel'] },
    'FOG-008': { guide: 'How was this made', tools: ['asset_provenance'] },
    'FOG-009': { guide: 'The form', tools: ['flow_form'] },
    'FOG-010': { guide: 'Suggestions', tools: [] },
    'FOG-011': { guide: 'Edit flow', tools: [] },
    'FOG-012': { guide: null, why: 'The agent surface itself.', tools: ['flow_apply_plan', 'flow_apply', 'flow_apply_get', 'flow_form'] },
    'FOG-013': { guide: null, why: 'This documentation and the end-to-end proof.', tools: [] },
};

function section(text, heading) {
    const i = text.indexOf(heading);
    assert.ok(i >= 0, `no "${heading}"`);
    const next = text.indexOf('\n### ', i + heading.length);
    return text.slice(i, next < 0 ? undefined : next);
}
const wordSection = () => {
    const src = read('scripts/make-canvas-guide.py').replace(/\\'/g, "'");
    const i = src.indexOf("doc.add_heading('20. Flows on the canvas'");
    assert.ok(i >= 0, 'the Word guide has no flows section');
    return src.slice(i, src.indexOf("doc.add_heading('21.", i));
};

test('the set is what the code cites, and every task in it is declared here', () => {
    const ids = citedIds();
    assert.ok(ids.length >= 12, `the code cites only ${ids}`);
    assert.deepEqual(Object.keys(FEATURES).sort(), ids, 'a FOG task the code cites is not accounted for, or one here is cited nowhere');
    for (const [id, f] of Object.entries(FEATURES)) {
        if (f.guide === null) assert.ok((f.why || '').length > 10, `${id} has no Word-guide entry and no reason`);
    }
});

test('CLAUDE.md has the section, and it names every task the code cites', () => {
    const s = section(read('CLAUDE.md'), '### Flows on the Production Graph');
    for (const id of citedIds()) assert.ok(s.includes(id), `CLAUDE.md's flows section does not name ${id}`);
    for (const m of ['lib/flow-apply.js', 'lib/flow-outputs.js', 'lib/flow-pick.js', 'lib/flow-form.js']) {
        assert.ok(fs.existsSync(path.join(ROOT, 'backend', m)), `${m} does not exist`);
        assert.ok(s.includes(m), `the section does not name ${m}`);
    }
    assert.ok(s.includes('tests/flows-on-graph-e2e.test.js'), 'the end-to-end proof is not named');
});

test('the Word guide carries every task a director meets, and lists it in the contents', () => {
    const src = read('scripts/make-canvas-guide.py');
    assert.match(src, /'20\. Flows on the canvas'/, 'the contents do not list the flows section');
    const w = wordSection().toLowerCase();
    for (const [id, f] of Object.entries(FEATURES)) {
        if (f.guide) assert.ok(w.includes(f.guide.toLowerCase()), `${id}: the Word guide does not say "${f.guide}"`);
    }
    // The labels it uses are the page's own, so a renamed control fails here.
    const spa = read('src/index.html');
    for (const label of ['Apply flow…', 'Made by flows', 'Waiting for a pick', 'Edit flow', 'Cancel run']) {
        assert.ok(spa.includes(label), `the guide teaches "${label}" and the page has no such label`);
    }
});

test('the agent guide names every tool the tasks gave an agent, and each is a real tool', () => {
    const guide = read('docs/claude-desktop-guide.md');
    const tools = new Set(require('../lib/mcp-tools').listTools().map(t => t.name));
    for (const [id, f] of Object.entries(FEATURES)) {
        for (const t of f.tools) {
            assert.ok(tools.has(t), `${id}: ${t} is not a tool`);
            assert.ok(guide.includes('`' + t + '`'), `${id}: the agent guide does not name ${t}`);
        }
    }
    assert.match(section(guide, '### Running whole pipelines'), /flow_run_select/, 'the pick is not explained where applying is');
});
