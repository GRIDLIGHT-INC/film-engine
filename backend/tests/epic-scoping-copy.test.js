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

/**
 * A TASK RECORDED AS DONE MUST POINT AT THE CODE THAT DID IT.
 *
 * The task file is where the durable reasoning goes — the tracker holds status,
 * the file holds why. Reasoning with no pointer to an implementation is half a
 * record: a later reader has to search commit messages to reconnect them, and
 * the connection is the whole value.
 *
 * Found at the end of the plate-camera epic. Eleven task files carried full
 * reasoning and exactly ONE carried its commit hash — I wrote it into the first
 * and stopped. That is the shape every hand-maintained convention fails in: it
 * survives as long as somebody remembers it.
 *
 * WHY THIS DOES NOT POLICE EVERY EPIC IN THE DIRECTORY. Measured when written:
 * 39 completed tasks across four epics, and 28 record no commit. Three of those
 * epics predate this convention and one of them was not even implemented in
 * this repository, so `git cat-file` here could not vouch for it either way.
 * Failing the suite on other people's history would get this check deleted, and
 * the protection would go with it.
 *
 * So the epics NOT yet held are NAMED with their counts, on the precedent
 * `manual-edit.test.js` set with NOT_BUILT: a gap written down is work, and a
 * gap silently excluded is one nobody finds again. A count that drifts fails —
 * which is what forces an entry to be removed when it is fixed rather than left
 * to rot.
 */

/** Epics this check holds to full traceability. */
const TRACED_EPICS = ['Plate Camera Controls'];

/**
 * Known-untraced epics, with the number of completed tasks that name no commit.
 * Wrong counts FAIL: an entry that no longer describes reality makes the whole
 * list a story.
 */
const UNTRACED_EPICS = Object.freeze({
    'Redo the video between two chosen frames': 10,
    'iOS Capture and Previz Finalization': 9,
});

/**
 * Epics with no plan document in THIS repository are outside this check
 * entirely — neither policed nor counted.
 *
 * `.claude/tasks` is shared across repositories, so it holds work this codebase
 * did not do and cannot vouch for: `git cat-file` here would fail on a valid
 * hash from another repo. Counting them was worse than useless — the count of
 * "Connections, Skills and Automations" went 9 -> 10 -> 14 in a few hours while
 * that epic was actively worked, so the suite went red on somebody else's
 * progress. A check that fails on work it has no standing to judge is one
 * people delete, and the real protection goes with it.
 *
 * Derived, not listed: an epic is ours if `docs/plans/` carries its title.
 */
function isOursToJudge(epic) {
    const dir = path.join(__dirname, '..', '..', 'docs', 'plans');
    return fs.readdirSync(dir).filter(f => f.endsWith('.md')).some(f => {
        const first = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')[0];
        return first.trim() === `# Epic: ${epic}`;
    });
}

const TASKS_DIR = '/Users/mannyhenri/Documents/Git/gridlight/.claude/tasks';

/** Completed task files, grouped by the epic they name. */
function completedByEpic() {
    const out = new Map();
    for (const f of fs.readdirSync(TASKS_DIR).filter(x => /^[A-Z]+-\d+\.md$/.test(x))) {
        const body = fs.readFileSync(path.join(TASKS_DIR, f), 'utf8');
        if (!/^- \[x\] DONE\b/m.test(body)) continue;          // in progress owes nothing
        const epic = (body.match(/^- \*\*Epic:\*\* (.+)$/m) || [null, '(none)'])[1].trim();
        if (!out.has(epic)) out.set(epic, []);
        out.get(epic).push({ file: f, body });
    }
    return out;
}

/** Completed tasks in an epic that name no resolvable commit. */
function untraced(entries) {
    const { execFileSync } = require('child_process');
    const REPO = path.join(__dirname, '..', '..');
    return entries.map(({ file, body }) => {
        const hash = (body.match(/\bcommit ([0-9a-f]{7,40})\b/) || [])[1];
        if (!hash) return `${file}: marked DONE and names no commit`;
        try {
            // A recorded hash that does not RESOLVE is worse than none: it
            // reads as a working pointer.
            execFileSync('git', ['cat-file', '-e', `${hash}^{commit}`], { cwd: REPO, stdio: 'pipe' });
            return null;
        } catch (_) { return `${file}: names commit ${hash}, which is not in this repository`; }
    }).filter(Boolean);
}

test('EVERY completed task in a traced epic points at a commit that exists', (t) => {
    if (!fs.existsSync(TASKS_DIR)) {
        // Named, not silent: a skip that looks like a pass is coverage that is
        // not there.
        t.skip(`no task directory at ${TASKS_DIR} — this check runs on the authoring machine`);
        return;
    }
    const groups = completedByEpic();
    const bad = [];
    for (const epic of TRACED_EPICS) {
        const entries = groups.get(epic);
        assert.ok(entries && entries.length >= 5,
            `${epic}: ${entries ? entries.length : 0} completed tasks found — the scan is broken, `
            + 'and one that finds too few reports an untraceable epic as traceable');
        bad.push(...untraced(entries).map(x => `${epic} / ${x}`));
    }
    assert.deepStrictEqual(bad, [],
        'these completed tasks cannot be traced to code:\n  ' + bad.join('\n  '));
});

test('the untraced epics are named accurately, so the list cannot rot', (t) => {
    /*
     * A count that drifts fails. Fix one of these and this test tells you to
     * update the entry — or to move the epic into TRACED_EPICS, which is the
     * point. Silently excluding them would hide 28 records nobody would find
     * again.
     */
    if (!fs.existsSync(TASKS_DIR)) { t.skip('task directory is on the authoring machine'); return; }
    const groups = completedByEpic();
    const wrong = [];

    // Nothing foreign may be listed: it would reintroduce the drift.
    const foreign = Object.keys(UNTRACED_EPICS).filter(e => !isOursToJudge(e));
    assert.deepStrictEqual(foreign, [],
        `these epics have no plan document in this repository and must not be counted here: `
        + foreign.join(', '));

    for (const [epic, expected] of Object.entries(UNTRACED_EPICS)) {
        const entries = groups.get(epic);
        if (!entries) { wrong.push(`${epic}: no completed tasks found; the entry is stale`); continue; }
        const n = untraced(entries).length;
        if (n !== expected) {
            wrong.push(`${epic}: ${n} untraced, the list says ${expected}`
                + (n === 0 ? ' — it is fixed; move it to TRACED_EPICS' : ''));
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('no epic is both traced and excused', () => {
    const overlap = TRACED_EPICS.filter(e => UNTRACED_EPICS[e] !== undefined);
    assert.deepStrictEqual(overlap, [],
        `these epics are held to traceability and excused from it: ${overlap.join(', ')}`);
});
