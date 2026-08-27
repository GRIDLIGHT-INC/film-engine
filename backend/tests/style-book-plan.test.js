/**
 * The style-book implementation plan: does it wire into everything it must?
 *
 * This checks the PLAN, not the feature. A new subsystem in this codebase does
 * not merely add files — it joins registries that other tests already walk, and
 * a plan that omits one of those describes work that will fail on the day it
 * lands rather than on the day it is written.
 *
 * The set is derived from the SUITE: six existing tests scan a directory or a
 * registry and will pick up a style book automatically, each imposing a
 * contract. Plus the camera facets the apply step must merge, and the
 * integration files themselves. None of that is in the request.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PLAN = path.join(ROOT, 'docs', 'plans', 'style-book-implementation.md');

function plan() {
    assert.ok(fs.existsSync(PLAN), `the implementation plan does not exist at ${PLAN}`);
    return fs.readFileSync(PLAN, 'utf8');
}

/**
 * Existing tests that derive their denominator from a directory or registry,
 * and so will police a style book with nothing added to them.
 *
 * Each entry names the contract the plan has to satisfy. Verified against the
 * test file itself, so a renamed test fails here rather than silently
 * dropping its contract.
 */
const POLICING = [
    { file: 'docs-drift.test.js', derives: /readdirSync/, contract: 'CLAUDE.md' },
    { file: 'mcp-no-server-llm.test.js', derives: /ENTITY_ROUTES/, contract: 'ENTITY_ROUTES' },
    { file: 'nav-chrome.test.js', derives: /var RAIL/, contract: 'RAIL' },
    { file: 'nav-flow.test.js', derives: /PROJECT_PHASES/, contract: 'ALWAYS_AVAILABLE' },
    { file: 'test-isolation.test.js', derives: /readdirSync/, contract: 'FILM_DATA_DIR' },
    { file: 'manual-edit.test.js', derives: /readdirSync/, contract: 'manual-edit' },
];

/** Every camera facet the apply step must be able to merge onto a card. */
function cameraFacets() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scene-card-schema.js'), 'utf8');
    return [...new Set([...src.matchAll(/card\.camera\.([a-z_]+)/g)].map(m => m[1]))];
}

/** The next migration number, read from disk rather than assumed. */
function nextMigration() {
    const files = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
        .filter(f => /^\d{3}_/.test(f)).sort();
    const last = Number(files[files.length - 1].slice(0, 3));
    return String(last + 1).padStart(3, '0');
}

test('the plan exists and is a plan, not a sketch', () => {
    const p = plan();
    assert.ok(p.length > 6000, `the plan is ${p.length} characters — that is a sketch`);
    for (const heading of ['Interface', 'File', 'Rationale', 'Phase']) {
        assert.ok(new RegExp(heading, 'i').test(p), `the plan has no "${heading}" section`);
    }
});

test('every test that will police this subsystem is named, with its contract', () => {
    /*
     * The point of the list. Each of these walks a directory or a registry, so
     * a style book joins its denominator the moment the files land — and a plan
     * that has not read them describes work that fails on arrival.
     */
    const p = plan();
    const missing = [];
    for (const t of POLICING) {
        const src = fs.readFileSync(path.join(__dirname, t.file), 'utf8');
        assert.match(src, t.derives, `${t.file} no longer derives its set — the contract has changed`);
        if (!p.includes(t.file)) missing.push(`${t.file} (not named)`);
        else if (!p.includes(t.contract)) missing.push(`${t.file} (named, but its "${t.contract}" contract is not stated)`);
    }
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});

test('the migration number is the real next one', () => {
    // A plan naming 080 when the tree is at 084 is a plan someone will follow.
    const p = plan();
    const next = nextMigration();
    assert.ok(p.includes(`${next}_`),
        `the plan does not name migration ${next}_… as the next number`);
});

test('every camera facet is given a disposition', () => {
    // Carried or deliberately not carried — but named either way, or the
    // omission is a gap rather than a decision.
    const p = plan();
    const missing = cameraFacets().filter(f => !p.includes(f));
    assert.deepStrictEqual(missing, [],
        `the plan does not say what apply does with: ${missing.join(', ')}`);
});

test('the files it creates and edits are named with paths', () => {
    /*
     * "Design implementation plan with file paths and interfaces" — so the
     * plan has to name the real ones. Each is checked for existence where it
     * must already exist, so a plan cannot cite a file that is not there.
     */
    const p = plan();
    const mustEdit = [
        'backend/server.js',
        'backend/lib/mcp-tools.js',
        'backend/lib/nav-flow.js',
        'src/index.html',
        'CLAUDE.md',
    ];
    const gaps = [];
    for (const f of mustEdit) {
        if (!fs.existsSync(path.join(ROOT, f))) gaps.push(`${f} does not exist`);
        else if (!p.includes(f)) gaps.push(`${f} is not named in the plan`);
    }
    // And the new files, which must NOT exist yet — this is a plan.
    for (const f of ['backend/routes/style-book.js', 'backend/lib/style-book.js']) {
        if (!p.includes(f)) gaps.push(`${f} is not named in the plan`);
    }
    assert.deepStrictEqual(gaps, [], `\n  ${gaps.join('\n  ')}`);
});

test('the interfaces are given signatures, not just names', () => {
    // A module list is not an interface. Each exported function the plan
    // introduces has to say what it takes and what it returns.
    const p = plan();
    for (const fn of ['listStyleBook', 'applyEntryToShot', 'validateEntry']) {
        assert.ok(p.includes(fn), `the plan does not define ${fn}`);
        const at = p.indexOf(fn);
        const around = p.slice(at, at + 260);
        assert.match(around, /\(|→|returns/i, `${fn} is named without a signature`);
    }
});

test('the cross-project storage decision survives into the plan', () => {
    // The research concluded film_flows' nullable project_id. A plan that
    // quietly reverts to project-scoped would discard the finding.
    const p = plan();
    assert.match(p, /project_id/, 'the plan does not say how entries are scoped');
    assert.match(p, /ON DELETE SET NULL/,
        'the plan does not protect library entries from a project deletion');
    assert.ok(!/ON DELETE CASCADE[^\n]*film_projects/.test(p),
        'the plan cascades entries from projects — deleting a film would delete the library');
});

test('the reference-slot finding is carried forward, not lost', () => {
    /*
     * KIND_RANK ranks style last of five against a budget of three. The plan
     * must not describe visuals as conditioning a frame, or it designs on a
     * false premise the research already disproved.
     */
    const p = plan();
    assert.match(p, /KIND_RANK/, 'the plan does not mention the reference ranking');
    const rank = require('../lib/reference-images').KIND_RANK;
    assert.strictEqual(rank.style, Math.max(...Object.values(rank)),
        'style is no longer the lowest-ranked reference — the plan needs revisiting');
});
