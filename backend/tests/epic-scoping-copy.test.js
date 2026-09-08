const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PLANS = path.join(__dirname, '..', '..', 'docs', 'plans');
const SCOPING = '/Users/mannyhenri/Documents/Git/gridlight/.claude/scoping';

/**
 * A SCOPED EPIC THAT IS NOT THE EPIC IS WORSE THAN NO COPY.
 *
 * The scoping step's instruction is "do not modify the epic content — copy it
 * exactly", and the failure it guards against is silent: a copy written by
 * re-typing through a heredoc or a template can lose a backtick, expand a `$`,
 * or stop early, and the result still looks like an epic. Nobody reads two
 * files side by side to notice.
 *
 * WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * The first version pinned ONE epic and asserted its copy stayed BYTE-IDENTICAL
 * for ever. That is right at the moment of copying and wrong as a standing
 * rule, because a source epic here is a LIVING document — it is held to the
 * code by its own fidelity test, so a task landing rewrites its Current State
 * table. Measured when this was generalised: of four pairs, two had already
 * drifted in exactly that way (the iOS epic recording "Built 2026-09-07 by
 * ICP-008"; PAR-026 moving from *conditional* to **Built**). Byte-identity
 * would have failed both for SUCCEEDING — the same defect this codebase has now
 * paid for seven times.
 *
 * So the standing contract is STRUCTURAL: same title, same headings in the same
 * order, same set of planned tasks. Prose may drift as work lands; the SHAPE of
 * the plan may not, because that is what somebody scoping from the copy reads.
 *
 * Byte-identity is verified at COPY TIME by the step that makes the copy (cmp
 * plus sha256, recorded in its report). A test cannot tell "just copied" from
 * "copied months ago", so asserting it here would freeze the source.
 *
 * SET-BASED over every film-engine epic that HAS a copy — never one pinned
 * slug. An epic with no copy is not a failure: not every plan is scoped, and
 * `epic-ship-and-test-film-engine.md` is the goal decomposition rather than a
 * scoped epic.
 */

const read = (p) => fs.readFileSync(p, 'utf8');

/** The slug the scoping step derives: strip a leading `epic-` or trailing `-epic`. */
const slugOf = (base) => base.replace(/\.md$/, '').replace(/^epic-/, '').replace(/-epic$/, '');

/** Every (source, copy) pair that exists — derived, never listed. */
function pairs() {
    if (!fs.existsSync(SCOPING)) return null;   // another machine; see the named skip below
    return fs.readdirSync(PLANS)
        .filter(f => /epic/.test(f) && f.endsWith('.md'))
        .map(f => ({ slug: slugOf(f), source: path.join(PLANS, f),
                     copy: path.join(SCOPING, `EPIC-${slugOf(f)}.md`) }))
        .filter(p => fs.existsSync(p.copy));
}

/** What the scoping template mandates. */
const REQUIRED_SECTIONS = [
    '# Epic:', '## Overview', '## Business Goals', '## Current State',
    '## Target State', '## Constraints', '## Task Breakdown',
    '## Open Questions', '## Success Metrics',
];

const headings = (s) => [...s.matchAll(/^#+ .*$/gm)].map(m => m[0].trim());

/**
 * Tasks that are PLANNED, not merely mentioned.
 *
 * A task id appears in its own table row AND in other tasks' dependency cells,
 * so scanning the whole document cannot tell a plan from a reference — deleting
 * a row leaves the id behind in every dependency that names it, and the copy
 * then has a task that is depended on and unplanned. Anchored to the start of a
 * row so only the id cell counts. Any prefix: RBF, ICP, PCC, PAR.
 */
const plannedTasks = (s) =>
    [...new Set([...s.matchAll(/^\|\s*([A-Z]{2,5}-\d{3})\s*\|/gm)].map(m => m[1]))].sort();

test('the scoping directory is reachable, and film-engine epics have been copied there', (t) => {
    /*
     * This directory lives in another repo on this machine. Skipping elsewhere
     * is right — but the skip is NAMED, because a test that quietly passes when
     * its subject is absent is coverage that is not there.
     */
    if (!fs.existsSync(SCOPING)) {
        t.skip(`no scoping directory at ${SCOPING} — this check runs on the authoring machine`);
        return;
    }
    const all = pairs();
    assert.ok(all.length >= 3,
        `only ${all.length} epic/copy pairs found; the pairing is broken, and a scan that finds too `
        + 'few reports the copies as faithful by looking at almost none of them');
});

test('EVERY copy carries the title of the epic it was copied from', () => {
    const all = pairs();
    if (!all) return;
    const wrong = all.filter(p => read(p.source).split('\n')[0] !== read(p.copy).split('\n')[0])
        .map(p => p.slug);
    assert.deepStrictEqual(wrong, [], `titled differently from its epic: ${wrong.join(', ')}`);
});

test('EVERY copy carries every section the template mandates', () => {
    const all = pairs();
    if (!all) return;
    const bad = [];
    for (const p of all) {
        const missing = REQUIRED_SECTIONS.filter(s => !read(p.copy).includes(s));
        if (missing.length) bad.push(`${p.slug}: ${missing.join(', ')}`);
    }
    assert.deepStrictEqual(bad, [], 'sections lost in the copy:\n  ' + bad.join('\n  '));
});

test('EVERY copy has the same headings as its source, in the same order', () => {
    /*
     * A section check alone passes on a file truncated mid-table, because a
     * partial write keeps every heading it had already reached. Comparing the
     * ordered heading list against the source catches a copy that stopped early
     * — which is what an interrupted write looks like.
     */
    const all = pairs();
    if (!all) return;
    const bad = [];
    for (const p of all) {
        const a = headings(read(p.source)), b = headings(read(p.copy));
        if (a.join('\n') !== b.join('\n')) {
            bad.push(`${p.slug}: source ${a.length} headings, copy ${b.length}`
                + (a.length === b.length ? ' — same count, different text' : ''));
        }
    }
    assert.deepStrictEqual(bad, [], 'the copy is not the same document:\n  ' + bad.join('\n  '));
});

test('EVERY task planned in an epic is planned in its copy, and the copy invents none', () => {
    /*
     * Both directions. A copy MISSING a task means work scoped against the
     * wrong set; a copy naming a task the source dropped means work planned
     * that does not exist. Neither is visible without comparing.
     */
    const all = pairs();
    if (!all) return;
    const bad = [];
    for (const p of all) {
        const a = plannedTasks(read(p.source)), b = plannedTasks(read(p.copy));
        assert.ok(a.length >= 10,
            `${p.slug}: only ${a.length} task rows parsed from the source; this scan is wrong`);
        const lost = a.filter(id => !b.includes(id));
        const invented = b.filter(id => !a.includes(id));
        if (lost.length) bad.push(`${p.slug}: tasks lost in the copy: ${lost.join(', ')}`);
        if (invented.length) bad.push(`${p.slug}: copy plans tasks the epic does not: ${invented.join(', ')}`);
    }
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('every file in the scoping directory follows the naming convention', () => {
    if (!fs.existsSync(SCOPING)) return;
    const siblings = fs.readdirSync(SCOPING).filter(f => /^EPIC-.*\.md$/.test(f));
    assert.ok(siblings.length >= 2, `only ${siblings.length} EPIC files; cannot confirm the convention`);
    for (const f of siblings) {
        assert.match(f, /^EPIC-[a-z0-9]+(-[a-z0-9]+)*\.md$/,
            `${f} breaks the kebab-case convention its siblings follow`);
    }
});
