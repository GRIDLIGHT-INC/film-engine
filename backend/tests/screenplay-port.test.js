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
    const m = src('lib/fountain-parser.js').match(/ELEMENT_TYPES\s*=\s*\{([\s\S]*?)\n\s*\};/);
    assert.ok(m, 'the parser no longer declares ELEMENT_TYPES');
    const types = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
    // Anchored against SHRINKING. The old pattern stopped at the first `}`, so a
    // nested object or a brace in a comment would silently return a shorter
    // list — and a shorter list makes every assertion below EASIER to satisfy.
    // A test whose grip loosens as the code it guards grows is worse than none,
    // because it still reports green.
    assert.ok(types.length >= 13,
        `only ${types.length} element types parsed out — the extraction is broken, not the parser`);
    return types;
}

/**
 * How a writer can actually produce each element, from three editor registries.
 *
 * Draft 1 measured this by regexing element-type strings out of index.html.
 * String presence is not authoring capability and the two differ by four
 * elements — the "wired vs merely exists" error this file exists to prevent,
 * committed by the file itself.
 *
 * `typed` is graph REACHABILITY, not set membership. `nextType` says what
 * follows Enter, so `'lyrics': 'lyrics'` is a self-loop that keeps you in lyrics
 * once you are there and is not a way in. Reading it as membership over-counts.
 */
function authorability() {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

    const nt = html.match(/nextType:\s*\{([\s\S]*?)\}/);
    assert.ok(nt, 'AUTO_FORMAT_RULES.nextType is gone — the editor no longer declares its types');
    const known = [...nt[1].matchAll(/'([a-z-]+)'\s*:/g)].map(m => m[1]);
    assert.ok(known.length >= 8, `only ${known.length} editor types extracted — the extraction broke`);
    const edges = {};
    for (const m of nt[1].matchAll(/'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) edges[m[1]] = m[2];

    const bodyOf = name => {
        const i = html.indexOf('function ' + name + '(');
        return i < 0 ? '' : html.slice(i, i + 3000);
    };
    const seeds = new Set();
    for (const fn of ['autoDetectElementType', 'detectElementTypeImmediate']) {
        for (const m of bodyOf(fn).matchAll(/detectedType\s*=\s*'([a-z-]+)'|return\s+'([a-z-]+)'/g)) {
            const t = m[1] || m[2];
            if (known.includes(t)) seeds.add(t);
        }
    }
    assert.ok(seeds.size >= 3, `only ${seeds.size} classifier seeds found — the extraction broke`);

    const typed = new Set(seeds);
    for (let grew = true; grew;) {
        grew = false;
        for (const t of [...typed]) {
            const n = edges[t];
            if (n && known.includes(n) && !typed.has(n)) { typed.add(n); grew = true; }
        }
    }

    const tc = html.match(/tabCycles:\s*\{([\s\S]*?)\n\s{8}\}/);
    const cycled = new Set(tc
        ? [...tc[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]).filter(t => known.includes(t))
        : []);
    const commanded = new Set(/function toggleDualDialogue/.test(html) ? ['dual-dialogue'] : []);
    const reachable = new Set([...typed, ...cycled, ...commanded]);

    return { known, typed, cycled, commanded, reachable,
        stranded: known.filter(t => !reachable.has(t)) };
}

/**
 * The plan's own claim, not any sentence containing the number.
 *
 * The first version asserted `doc.includes('editor 9/13')` and passed on the
 * sentence "Draft 1 asserted editor 9/13 as a fact. It is not a fact" — the plan
 * REPUDIATING the number satisfied a check meant to verify it claimed it. A
 * substring match cannot tell a claim from its retraction, so the claim is
 * anchored to the one line that makes it.
 */
function coverageLine() {
    const line = plan().split('\n').find(l => l.startsWith('**Coverage:'));
    assert.ok(line, 'the plan no longer states its coverage on a single **Coverage:** line');
    return line;
}

/**
 * How a writer can actually produce each element, derived from three separate
 * registries in the editor.
 *
 * Draft 1 measured this by regexing element-type strings out of index.html.
 * String presence is not authoring capability, and the difference is four
 * elements — the exact "wired vs merely exists" error this file was written to
 * prevent, committed by the file itself.
 *
 * `typed` is graph REACHABILITY, not set membership. `nextType` says what comes
 * after Enter, so `'lyrics': 'lyrics'` is a self-loop that keeps you in lyrics
 * once you are there and is not a way in. Reading it as membership over-counts.
 */
function authorability() {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

    const nt = html.match(/nextType:\s*\{([\s\S]*?)\}/);
    assert.ok(nt, 'AUTO_FORMAT_RULES.nextType is gone — the editor no longer declares its own types');
    const known = [...nt[1].matchAll(/'([a-z-]+)'\s*:/g)].map(m => m[1]);
    const edges = {};
    for (const m of nt[1].matchAll(/'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) edges[m[1]] = m[2];

    const bodyOf = name => {
        const i = html.indexOf('function ' + name + '(');
        return i < 0 ? '' : html.slice(i, i + 3000);
    };
    const seeds = new Set();
    for (const fn of ['autoDetectElementType', 'detectElementTypeImmediate']) {
        for (const m of bodyOf(fn).matchAll(/detectedType\s*=\s*'([a-z-]+)'|return\s+'([a-z-]+)'/g)) {
            const t = m[1] || m[2];
            if (known.includes(t)) seeds.add(t);
        }
    }
    assert.ok(seeds.size >= 3, `only ${seeds.size} classifier seeds found — the extraction is broken`);

    const typed = new Set(seeds);
    for (let grew = true; grew;) {
        grew = false;
        for (const t of [...typed]) {
            const n = edges[t];
            if (n && known.includes(n) && !typed.has(n)) { typed.add(n); grew = true; }
        }
    }

    const tc = html.match(/tabCycles:\s*\{([\s\S]*?)\n\s{8}\}/);
    const cycled = new Set(tc ? [...tc[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]).filter(t => known.includes(t)) : []);
    const commanded = new Set(/function toggleDualDialogue/.test(html) ? ['dual-dialogue'] : []);

    const reachable = new Set([...typed, ...cycled, ...commanded]);
    return { known, typed, cycled, commanded, reachable,
        stranded: known.filter(t => !reachable.has(t)) };
}

/** Editor type names are hyphenated; parser types are underscored. */
const asEditor = t => t.replace(/_/g, '-');

test('the plan accounts for every element the parser can emit', () => {
    const types = elementTypes();
    assert.ok(types.length >= 13, `only ${types.length} element types found — the scan is broken`);
    const doc = plan();
    const missing = types.filter(t => !new RegExp('`' + t + '`').test(doc));
    assert.deepStrictEqual(missing, [],
        `the parser emits these and the plan never mentions them: ${missing.join(', ')}`);
});

test('the plan states the coverage counts, and they are true', () => {
    const types = elementTypes();
    const { reachable } = authorability();
    const fdxMap = src('lib/fdx-generator.js').match(/FDX_TYPE_MAP\s*=\s*\{([\s\S]*?)\}/);
    assert.ok(fdxMap, 'the FDX generator no longer declares FDX_TYPE_MAP');

    // Only PARSED types count. dual-dialogue is authorable and is not an element
    // type, so counting it would inflate the figure.
    const authorable = types.filter(t => reachable.has(asEditor(t)));
    const exported = types.filter(t => new RegExp(`\\b${t}\\s*:`).test(fdxMap[1]));

    const line = coverageLine();
    assert.ok(line.includes(`parser ${types.length}/${types.length}`),
        `coverage line does not state parser ${types.length}/${types.length}: ${line}`);
    assert.ok(line.includes(`authorable ${authorable.length}/${types.length}`),
        `the plan claims a different authorable coverage than the ${authorable.length}/${types.length} the editor reaches: ${line}`);
    assert.ok(line.includes(`FDX ${exported.length}/${types.length}`),
        `the plan claims a different FDX coverage than the ${exported.length}/${types.length} the map shows: ${line}`);
});

test('the editor state machine is partitioned into types and states', () => {
    // Requirement from the writers-tool agent, and it is this morning's error in
    // a third costume: counting the CONTAINER instead of the thing.
    //
    // AUTO_FORMAT_RULES holds element types AND state names (`default`,
    // `after-scene`, `in-dialogue`). A test that iterates it naively counts 13,
    // disagrees with the plan's 10, and the obvious "fix" is to change the plan
    // to 13 — inflating the type count with things that are not types.
    //
    // So every key is classified explicitly and an unknown one FAILS. Adding a
    // fourth state breaks this loudly rather than silently inflating a figure.
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const STATES = ['default', 'after-scene', 'in-dialogue'];

    const all = new Set();
    for (const block of ['nextType', 'emptyLineType', 'tabCycles']) {
        const m = html.match(new RegExp(block + ':\\s*\\{([\\s\\S]*?)\\n\\s{8}\\}'));
        if (!m) continue;
        for (const k of m[1].matchAll(/'([a-z-]+)'\s*:/g)) all.add(k[1]);
    }
    assert.ok(all.size >= 10, `only ${all.size} state-machine keys found — the extraction broke`);

    const { known } = authorability();
    const unclassified = [...all].filter(k => !known.includes(k) && !STATES.includes(k));
    assert.deepStrictEqual(unclassified, [],
        `AUTO_FORMAT_RULES has keys that are neither an element type nor a known state: ${unclassified.join(', ')}. `
        + 'Classify it before any count that iterates this object can be trusted.');
});

test('the plan defines authorability rather than just counting it', () => {
    // The regression this replaces: a single "editor N/13" number that conflated
    // reachable-by-typing with merely-rendered. The three routes a writer has
    // are separate registries and the plan has to name them.
    const doc = plan();
    const missing = ['typed', 'cycled', 'commanded', 'stranded']
        .filter(term => !new RegExp('\\*\\*' + term + '\\*\\*').test(doc));
    assert.deepStrictEqual(missing, [],
        `the plan counts authorability without defining it — missing: ${missing.join(', ')}`);
});

test('every element the plan calls stranded really is known-but-unreachable', () => {
    // `stranded` is its own bug class: the editor knows the type, can leave it,
    // and offers no way in. A row marked stranded that is reachable aims phase 2
    // at work that does not exist; one that is UNKNOWN to the editor is a larger
    // fix wearing the same label.
    const { known, reachable, stranded } = authorability();
    const claimed = plan().split('\n')
        .filter(l => l.startsWith('|') && /\*\*stranded\*\*/.test(l))
        .map(l => (l.match(/`([a-z_]+)`/) || [])[1])
        .filter(Boolean);

    // NOT "some exist". Phase 2 cleared them all, and an assertion that the
    // list is non-empty goes red exactly when the work is finished — which is
    // the failure mode my peer named: a test that punishes finishing will be
    // deleted, not fixed. What must hold is AGREEMENT in both directions.
    const wrong = claimed.filter(t => !known.includes(asEditor(t)) || reachable.has(asEditor(t)));
    assert.deepStrictEqual(wrong, [],
        `the plan calls these stranded, but they are reachable or unknown to the editor: ${wrong.join(', ')}`);

    const unlisted = stranded.filter(e => !claimed.includes(e.replace(/-/g, '_')));
    assert.deepStrictEqual(unlisted, [],
        `the editor strands these and the plan does not say so: ${unlisted.join(', ')}`);
});


test('the plan and the FDX map agree about what is exported', () => {
    // Written as AGREEMENT rather than as "these defects exist". The first
    // version asserted `note: 'Action'` was still present, so fixing the bug
    // turned the suite red and the cheapest way back to green was to un-fix it.
    const map = src('lib/fdx-generator.js').match(/FDX_TYPE_MAP\s*=\s*\{([\s\S]*?)\}/)[1];
    const doc = plan();

    const exported = t => new RegExp(`\\b${t}\\s*:`).test(map);
    const disagreements = [];

    for (const t of ['section', 'synopsis']) {
        const rowSaysDropped = doc.split('\n')
            .some(l => l.startsWith('|') && l.includes('`' + t + '`') && /dropped/.test(l));
        if (exported(t) && rowSaysDropped) disagreements.push(`${t}: exported, plan says dropped`);
        if (!exported(t) && !rowSaysDropped) disagreements.push(`${t}: dropped, plan does not say so`);
    }

    // A note must never be script text again. Asserted as a permanent rule
    // rather than as a description of the current map, because this is the one
    // defect that changed what the script SAYS.
    assert.ok(!/note:\s*'Action'/.test(map),
        'a Fountain note is exported as Action again — it lands in the screenplay body');

    // Boneyard must stay out: it is text that was cut.
    assert.ok(!exported('boneyard'), 'boneyard is exported — that resurrects deleted scenes');

    assert.deepStrictEqual(disagreements, [], `\n  ${disagreements.join('\n  ')}`);
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
    // The writers-tool column is not the driver's to invent. The failure mode
    // is the driver filling it in silently — NOT the cells being filled at all,
    // which is the goal. Asserting the literal marker survives made the plan
    // uncompletable: finish Set 3 honestly and the suite goes red, and the
    // cheapest way back to green is to delete the content. So assert the
    // INVARIANT instead — every Set 3 row is either still marked unverified, or
    // carries a line naming who supplied it and what it was checked against.
    // Read the ROWS, not the prose around them. Prose can contain the word
    // "UNVERIFIED" while describing the convention, which is enough to satisfy
    // a section-wide regex and let an unattributed table through — that is
    // exactly how the first version of this check passed on a plan it should
    // have rejected.
    const set3 = doc.slice(doc.indexOf('## Set 3'), doc.indexOf('## Phases'));
    const rows = set3.split('\n').filter(l => /^\| *(\d+|—) *\|/.test(l));
    const anyUnfilled = rows.some(r => /UNVERIFIED/.test(r));
    const supplied = /Cells supplied by the writers-tool agent/.test(set3);
    if (rows.length && !anyUnfilled && !supplied) {
        missing.push('Set 3 has filled rows but no line saying who supplied them');
    }
    assert.deepStrictEqual(missing, [], `the plan is missing: ${missing.join(', ')}`);
});
