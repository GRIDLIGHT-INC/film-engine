/**
 * The screenplay port plan, held to the code.
 *
 * A plan is a document, and a document drifts. This one makes claims about
 * which Fountain elements each surface supports — and those claims are exactly
 * the kind that read as true forever while the code moves underneath them.
 *
 * So the plan is CONFORMANCE-TESTED, the way `previs-plan.test.js` holds the
 * previs plan and `docs-drift.test.js` holds CLAUDE.md. Every check here derives
 * its expectation from a registry — the parser's own element types, the FDX type
 * map, the MCP tool list — and compares it against what the plan says. An
 * example-based version ("the plan mentions synopsis") would pass on a
 * half-written plan, which is the precise failure this exists to prevent.
 *
 * The rule it enforces: the plan may not claim a capability the code cannot
 * demonstrate, and may not omit an element the parser can emit.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-splan-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..', '..');
const PLAN = path.join(ROOT, 'docs', 'plans', 'screenplay-port.md');
const plan = () => fs.readFileSync(PLAN, 'utf8');
const src = f => fs.readFileSync(path.join(__dirname, '..', ...f.split('/')), 'utf8');

/**
 * The element registry, read from the parser rather than listed here.
 *
 * Listing them would make this test agree with itself. A fourteenth element
 * added to the parser must fail this file until the plan accounts for it.
 */
function elementTypes() {
    const m = src('lib/fountain-parser.js').match(/ELEMENT_TYPES\s*=\s*\{([\s\S]*?)\}/);
    assert.ok(m, 'the parser no longer declares ELEMENT_TYPES');
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
}

test('the plan accounts for every element the parser can emit', () => {
    const types = elementTypes();
    assert.ok(types.length >= 13, `only ${types.length} element types found — the scan is broken`);
    const doc = plan();
    const missing = types.filter(t => !new RegExp('`' + t + '`').test(doc));
    assert.deepStrictEqual(missing, [],
        `the parser emits these and the plan never mentions them: ${missing.join(', ')}`);
});

test('the plan states the coverage counts, and they are true', () => {
    // The headline numbers are the thing a reader takes away, so they are the
    // thing most worth being wrong. Recomputed here from source.
    const types = elementTypes();
    const editor = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const fdxMap = src('lib/fdx-generator.js').match(/FDX_TYPE_MAP\s*=\s*\{([\s\S]*?)\}/);
    assert.ok(fdxMap, 'the FDX generator no longer declares FDX_TYPE_MAP');

    const authored = types.filter(t => {
        const hyph = t.replace(/_/g, '-');
        return new RegExp(`['"\\.](${t}|${hyph})['"\\s]`).test(editor);
    });
    const exported = types.filter(t => new RegExp(`\\b${t}\\s*:`).test(fdxMap[1]));

    const doc = plan();
    assert.ok(doc.includes(`parser ${types.length}/${types.length}`),
        `the plan does not state parser coverage as ${types.length}/${types.length}`);
    assert.ok(doc.includes(`editor ${authored.length}/${types.length}`),
        `the plan claims a different editor coverage than the ${authored.length}/${types.length} the source shows`);
    assert.ok(doc.includes(`FDX ${exported.length}/${types.length}`),
        `the plan claims a different FDX coverage than the ${exported.length}/${types.length} the map shows`);
});

test('every element the plan calls unauthored really is absent from the editor', () => {
    // The plan's whole organising claim is "complete implementation, incomplete
    // surface". If an element it calls missing is in fact authorable, the claim
    // is false and the phases are aimed at the wrong work.
    const editor = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const doc = plan();
    const wrong = [];
    for (const t of elementTypes()) {
        // A row marking the editor column with ✗ for this element.
        const row = doc.split('\n').find(l => l.includes('`' + t + '`') && l.startsWith('|'));
        if (!row) continue;
        const cells = row.split('|').map(c => c.trim());
        const editorCell = cells[4];              // # | element | parser | renderer | editor | ...
        if (editorCell !== '✗') continue;
        const hyph = t.replace(/_/g, '-');
        if (new RegExp(`['"\\.](${t}|${hyph})['"\\s]`).test(editor)) {
            wrong.push(t);
        }
    }
    assert.deepStrictEqual(wrong, [],
        `the plan says the editor cannot author these, but it can: ${wrong.join(', ')}`);
});

test('the FDX defects the plan names are real', () => {
    const map = src('lib/fdx-generator.js').match(/FDX_TYPE_MAP\s*=\s*\{([\s\S]*?)\}/)[1];

    // A note is a production note, not script text. Exporting it as Action puts
    // it in the screenplay body — worse than dropping it, and the only one of
    // the three defects that changes what the script SAYS.
    assert.match(map, /note:\s*'Action'/,
        'the plan claims notes export as Action; they no longer do — update the plan');

    for (const dropped of ['section', 'synopsis', 'page_break']) {
        assert.ok(!new RegExp(`\\b${dropped}\\s*:`).test(map),
            `the plan claims ${dropped} is dropped on FDX export; it is now mapped — update the plan`);
    }
});

test('the MCP screenplay surface is what the plan says it is', () => {
    const { listTools } = require('../lib/mcp-tools');
    const actual = listTools().map(t => t.name).filter(n => /^(script|scene)_/.test(n)).sort();
    const doc = plan();

    for (const name of actual) {
        assert.ok(doc.includes('`' + name + '`'),
            `${name} exists on the MCP surface and the plan does not list it`);
    }

    // And the blocking gap must still be a gap. When phase 1 lands, this flips
    // and the plan has to be updated — which is the point: the plan cannot
    // quietly go on describing a hole that has been filled.
    for (const missing of ['scene_append', 'scene_insert_after']) {
        const exists = actual.includes(missing);
        const claimedAbsent = new RegExp('`' + missing + '`[^\\n]*absent').test(doc);
        assert.strictEqual(exists, !claimedAbsent,
            exists
                ? `${missing} now exists — the plan still calls it absent`
                : `${missing} does not exist and the plan does not record it as absent`);
    }
});

test('the plan names its phases, its deferrals and who owns the unverified cells', () => {
    const doc = plan();
    const missing = [];
    for (const phase of ['Phase 1', 'Phase 2', 'Phase 3']) {
        if (!doc.includes(phase)) missing.push(phase);
    }
    // Anything not done is named with a reason — the standard this work runs
    // under, and a plan that omits the section cannot honour it.
    if (!/## Deferred/.test(doc)) missing.push('a Deferred section');
    // The writers-tool column is not the driver's to invent. If it is silently
    // filled in, that is the failure mode this marks.
    if (!/UNVERIFIED/.test(doc)) missing.push('UNVERIFIED markers on the writers-tool cells');
    assert.deepStrictEqual(missing, [], `the plan is missing: ${missing.join(', ')}`);
});
