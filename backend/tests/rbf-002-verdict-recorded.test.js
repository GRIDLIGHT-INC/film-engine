const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * RBF-002 — the probe's answer has to reach the plan, everywhere the question
 * was asked.
 *
 * RBF-001 cost $3.205 to answer one question: does `video-edit`'s `images_list`
 * act as keyframes, or as style references? It is style references, so approach
 * B is dead and the splice is ours after all.
 *
 * THE FAILURE THIS GUARDS IS NOT A MISSING DOCUMENT — it is a plan that answers
 * the question in one place and goes on asking it in three others. A reader who
 * opens the brief sees "unproven, cheap to test" and buys the probe again; a
 * reader who opens the epic sees "RBF-001 answers it" and waits for an answer
 * that already exists. Both are silent, and both cost money.
 *
 * So the denominator is DERIVED TWICE, and neither half is a list I typed:
 *
 *   1. WHICH DOCUMENTS are in scope comes from scanning the planning directory
 *      for files that discuss both `video-edit` and `images_list` — the two
 *      terms that make a document one that asked this question.
 *   2. WHICH CLAIMS each of them made comes from reading that document AS IT
 *      STOOD at the RBF-001 commit and finding the openness markers actually
 *      in it. A marker registry that describes reality is one that was found
 *      in the real prior text, not one that sounded plausible while writing
 *      the test.
 */

const REPO = path.join(__dirname, '..', '..');
const PLANS = path.join(REPO, 'docs', 'plans');
const SCOPING = '/Users/mannyhenri/Documents/Git/gridlight/.claude/scoping';

/** The commit that answered the question. Fixed, never HEAD: once this task is
 *  committed HEAD carries the corrected text, and a baseline that moves with
 *  HEAD proves nothing about what was there before. */
const BASELINE = '17e40f9';

const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * The verdict document is EXCLUDED by name with its reason: it is the answer
 * itself, so requiring it to reference the answer is circular.
 */
const VERDICT_DOC = 'rbf-001-video-edit-probe.md';

/** Documents that asked this question — derived, not listed. */
function planningDocs() {
    const out = [];
    for (const dir of [PLANS, SCOPING]) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.md') || f === VERDICT_DOC) continue;
            const p = path.join(dir, f);
            const s = read(p);
            if (s.includes('video-edit') && s.includes('images_list')) out.push(p);
        }
    }
    return out;
}

/**
 * Ways a document says "this is still open". Each cites where it came from, and
 * the test below refuses to trust any entry it cannot find in the real prior
 * text — a marker that matches nothing historical is decoration, and a registry
 * of decoration reports full coverage over an empty set.
 */
const OPENNESS_MARKERS = [
    { re: /\bunproven\b/i,                  why: 'brief · approach B was labelled unproven' },
    { re: /\bunresolved\b/i,                why: 'brief · open question 1 was unresolved' },
    { re: /RBF-001 answers it/i,            why: 'epic · open question 1 deferred to the probe' },
    { re: /may do the substitution/i,       why: 'brief · idea 4 speculated the provider would splice' },
    { re: /cheap to test/i,                 why: 'brief · approach B was still a proposal' },
    { re: /\bunexplored\b/i,                why: 'research · video-edit + images_list not yet tried' },
];

function baselineText(p) {
    const rel = path.relative(REPO, p);
    if (rel.startsWith('..')) return null;      // outside the repo; not in git
    return execFileSync('git', ['show', `${BASELINE}:${rel}`], { cwd: REPO, encoding: 'utf8' });
}

test('the scan found the documents that asked the question', () => {
    const docs = planningDocs();
    assert.ok(docs.length >= 4,
        `only ${docs.length} planning documents discuss video-edit and images_list; `
        + 'this scan is looking in the wrong place and every check below would pass vacuously');
    for (const want of ['redo-between-frames-epic.md', 'redo-between-frames-brief.md']) {
        assert.ok(docs.some(d => path.basename(d) === want), `${want} is not in the scanned set`);
    }
});

test('every document that asked the question now carries the answer', () => {
    const missing = [];
    for (const p of planningDocs()) {
        const s = read(p);
        // The answer is the verdict word AND an attribution, so a document that
        // merely uses the phrase in passing does not satisfy this.
        if (!/style[- ]references/i.test(s) || !/RBF-001/.test(s)) missing.push(path.basename(p));
    }
    assert.deepStrictEqual(missing, [],
        `these still discuss video-edit + images_list without recording the verdict: ${missing.join(', ')}`);
});

test('no document still presents the question as open', () => {
    let found = 0;
    const still = [];
    for (const p of planningDocs()) {
        const before = baselineText(p);
        if (before === null) continue;          // scoping copy: covered by the byte-identity test
        const now = read(p);
        for (const m of OPENNESS_MARKERS) {
            if (!m.re.test(before)) continue;   // this document never made that claim
            found++;
            if (m.re.test(now)) still.push(`${path.basename(p)}: ${m.why}`);
        }
    }
    assert.ok(found >= 6,
        `only ${found} openness markers found in the pre-verdict text; the marker registry `
        + 'no longer describes the documents it was written from');
    assert.deepStrictEqual(still, [],
        `the question is answered and these still ask it:\n  ${still.join('\n  ')}`);
});

test('the branch is stated: the tasks that do not shrink are named', () => {
    for (const name of ['redo-between-frames-epic.md', 'redo-between-frames-brief.md']) {
        const s = read(path.join(PLANS, name));
        for (const id of ['RBF-004', 'RBF-006']) {
            assert.ok(s.includes(id), `${name} never names ${id}, which the verdict decides the size of`);
        }
        assert.match(s, /does not shrink|do not shrink/i,
            `${name} records the verdict without saying what it does to the work`);
    }
});

test('the conditional resolved in the negative — the splice is still ours', () => {
    /*
     * RBF-002's third acceptance criterion is conditional: "if video-edit
     * honours keyframes, the within-a-clip case is marked as needing no splice".
     * It does not, so the obligation is the OTHER branch — and a plan that
     * simply omits the conditional leaves a reader to assume the cheaper one.
     */
    for (const name of ['redo-between-frames-epic.md', 'redo-between-frames-brief.md']) {
        const s = read(path.join(PLANS, name));
        assert.match(s, /splice is ours|still needs the splice|approach B is dead/i,
            `${name} does not state that the within-a-clip case still needs a splice`);
        assert.doesNotMatch(s, /needs no splice(?![^.]*(?:only if|would have|did not))/i,
            `${name} still claims the within-a-clip case needs no splice`);
    }
});

test('the constraint the probe discovered is recorded where constraints live', () => {
    const e = read(path.join(PLANS, 'redo-between-frames-epic.md'));
    const constraints = e.slice(e.indexOf('## Constraints'), e.indexOf('## Task Breakdown'));
    assert.ok(constraints.length > 200, 'the constraints section did not slice; this check is not running');
    assert.match(constraints, /localhost/i,
        'the epic never records that frames must be reachable by the provider, and we serve localhost only');
    assert.match(constraints, /http|fetchable|reachable/i,
        'the epic never records that images_list entries must be fetchable URLs');
});

test('the cost model is corrected to what was actually billed', () => {
    const e = read(path.join(PLANS, 'redo-between-frames-epic.md'));
    assert.match(e, /source|clip handed in/i, 'the epic never says what the billed length is measured from');
    assert.match(e, /3\.20|3\.205/, 'the epic does not record the measured spend against its own estimate');
    // The old figure may survive as a corrected record, never as a live estimate.
    assert.doesNotMatch(e, /Cheapest possible repair \$0\.68(?!.{0,120}(?:wrong|not|estimate was|measured))/is,
        'the epic still presents $0.68 as the cheapest possible repair');
});

test('the newly discovered constraint has a task, not just a paragraph', () => {
    const e = read(path.join(PLANS, 'redo-between-frames-epic.md'));
    const rows = [...e.matchAll(/^\|\s*(RBF-\d{3})\s*\|([^|]+)\|([^|]+)\|/gm)];
    /*
     * Bound to the CONCEPT, not to a substring. The first version of this
     * matched /url/ and passed before the task existed, because RBF-001's own
     * description contains `video_url` — a check that cries wolf in reverse,
     * reporting coverage that is not there. The TITLE has to name the work.
     */
    const hosting = rows.find(r => /reachable|fetchable|expose|host/i.test(r[2])
        && /localhost|provider|fetch/i.test(r[3]));
    assert.ok(hosting,
        'no task covers exposing frames at a URL the provider can fetch — the probe found '
        + 'this is required and nothing in the plan schedules it');
    const taskFile = path.join('/Users/mannyhenri/Documents/Git/gridlight/.claude/tasks',
        `GRD-${3430 + Number(hosting[1].slice(4))}.md`);
    assert.ok(fs.existsSync(taskFile) || fs.readdirSync('/Users/mannyhenri/Documents/Git/gridlight/.claude/tasks')
        .some(f => read(path.join('/Users/mannyhenri/Documents/Git/gridlight/.claude/tasks', f)).includes(hosting[1])),
        `${hosting[1]} is in the epic with no task file anywhere`);
});
