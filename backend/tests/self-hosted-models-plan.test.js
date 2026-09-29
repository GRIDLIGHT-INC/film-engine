/**
 * GRD-4453 (Self-Hosted Models & AWS Daily Batch Rendering) is worked from
 * Jira: task STATUS lives in the tracker and nowhere else. What Jira does not
 * hold is how each task is worked — which of the two repositories it lands in,
 * which command proves it, and which tasks may touch AWS. That is
 * docs/plans/self-hosted-models-plan.md, held here so the loop can trust it:
 *
 *   - FEM-001..FEM-014, each exactly once, each with its own Jira key;
 *   - a repo from the agreed set, and a test command that belongs to it (a
 *     BOTH row runs both repositories' commands);
 *   - prerequisites that name real tasks and never loop;
 *   - every task that provisions or starts AWS compute marked gated, behind
 *     the user's explicit yes for that run;
 *   - NO status — a second copy of the state is how the two come to disagree.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAN = path.join(__dirname, '..', '..', 'docs', 'plans', 'self-hosted-models-plan.md');
const TASKS = Array.from({ length: 14 }, (_, i) => `FEM-${String(i + 1).padStart(3, '0')}`);
const JIRA = id => `GRD-${4564 + Number(id.slice(4))}`;   // FEM-001 = GRD-4565 … FEM-014 = GRD-4578
const REPOS = ['film-engine', 'gridlight', 'both'];
const FE_TEST = 'cd backend && npm test';
const GL_TESTS = ['cd gateway && cargo test --lib --bins', 'python3 -m pytest -q tests/contract', 'cd agent && cargo nextest run'];
// The epic's own words: every task whose requirements provision or start AWS compute.
const AWS_TASKS = ['FEM-005', 'FEM-006', 'FEM-009', 'FEM-010', 'FEM-011', 'FEM-012'];

const text = () => fs.readFileSync(PLAN, 'utf8');
function rows() {
    const out = {};
    for (const line of text().split('\n')) {
        const c = line.split('|').map(s => s.trim());
        if (!/^FEM-\d{3}$/.test(c[1] || '')) continue;
        const [, id, jira, title, repo, tests, prereqs, gate] = c;
        (out[id] = out[id] || []).push({ id, jira, title, repo, tests, prereqs, gate });
    }
    return out;
}

test('the plan exists, names the tracker as the only state, and both roots', () => {
    assert.ok(fs.existsSync(PLAN), 'no docs/plans/self-hosted-models-plan.md');
    const t = text();
    assert.match(t, /GRD-4453/);
    assert.match(t, /state lives in Jira/i, 'the plan does not say where task state lives');
    assert.match(t, /\/Users\/mannyhenri\/code\/film-engine/);
    assert.match(t, /\/Users\/mannyhenri\/code\/gl-dev-media/);
});

test('FEM-001..FEM-014 each appear exactly once, with their own Jira key and a title', () => {
    const r = rows();
    assert.deepEqual(TASKS.filter(id => !r[id]), [], 'tasks missing from the plan');
    assert.deepEqual(TASKS.filter(id => r[id] && r[id].length !== 1), [], 'tasks listed more than once');
    assert.deepEqual(Object.keys(r).filter(id => !TASKS.includes(id)), [], 'rows for tasks the epic does not have');
    for (const id of TASKS) {
        assert.equal(r[id][0].jira, JIRA(id), `${id} carries the wrong Jira key`);
        assert.ok(r[id][0].title.length > 10, `${id} has no title`);
    }
});

test('every row names a repo from the agreed set and a test command that belongs to it', () => {
    const bad = [];
    for (const [id, [row]] of Object.entries(rows())) {
        if (!REPOS.includes(row.repo)) { bad.push(`${id}: repo "${row.repo}"`); continue; }
        const fe = row.tests.includes(FE_TEST), gl = GL_TESTS.some(c => row.tests.includes(c));
        if (row.repo === 'film-engine' && (!fe || gl)) bad.push(`${id}: a film-engine row must run "${FE_TEST}" only`);
        if (row.repo === 'gridlight' && (fe || !gl)) bad.push(`${id}: a gridlight row must run a gridlight command only`);
        if (row.repo === 'both' && !(fe && gl)) bad.push(`${id}: a both row must run both repos' commands`);
    }
    assert.deepEqual(bad, []);
});

test('prerequisites name real, earlier tasks, so the order cannot loop', () => {
    const bad = [];
    for (const [id, [row]] of Object.entries(rows())) {
        const deps = row.prereqs === 'None' ? [] : row.prereqs.split(',').map(s => s.trim());
        for (const d of deps) {
            if (!TASKS.includes(d)) bad.push(`${id} → ${d}: no such task`);
            else if (Number(d.slice(4)) >= Number(id.slice(4))) bad.push(`${id} → ${d}: not an earlier task`);
        }
    }
    assert.deepEqual(bad, []);
});

test('every task that touches AWS compute is gated, and nothing else claims to be', () => {
    const r = rows();
    const gated = TASKS.filter(id => /gated/i.test(r[id][0].gate));
    assert.deepEqual(gated, AWS_TASKS, 'the AWS gate is on the wrong tasks');
    assert.match(text(), /explicit yes/i, 'the gate does not say what opens it');
});

test('the plan holds no task status — Jira is the only state', () => {
    const status = /\b(TODO|To Do|In Progress|DONE|BLOCKED|SKIPPED|WAITING ON)\b/;
    const table = text().split('\n').filter(l => /^\| FEM-/.test(l));
    assert.deepEqual(table.filter(l => status.test(l)), [], 'a task row carries a status');
    assert.doesNotMatch(text().split('\n')[0] + text().match(/^\|.*\|$/m)[0], /\bState\b|\bStatus\b/, 'the table has a status column');
});
