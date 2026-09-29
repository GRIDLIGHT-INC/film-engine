/**
 * GRD-4453 (Self-Hosted Models & AWS Daily Batch Rendering) is worked from
 * Jira: task STATUS lives in the tracker and nowhere else. What Jira does not
 * hold is how each task is worked — which of the two repositories it lands in,
 * what existing code it extends, which command proves it, and which tasks may
 * touch AWS. That is docs/plans/self-hosted-models-plan.md, held here so the
 * loop can trust it:
 *
 *   - FEM-001..FEM-014, each exactly once, each with its own Jira key;
 *   - a repo from the agreed set, and test commands that each name the repo
 *     they run in ([fe] / [gl]) and each equal a known command exactly — a
 *     command matched by substring is how an unknown one slips through;
 *   - prerequisites that name real tasks and never loop;
 *   - every task that provisions or starts an AWS resource (compute OR
 *     storage) marked gated, behind the user's explicit yes for that run;
 *   - every path the note names exists, in the repository it belongs to — a
 *     renamed path should fail here, not in the middle of the loop;
 *   - NO status — a second copy of the state is how the two come to disagree.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FE_ROOT = path.join(__dirname, '..', '..');
const GL_ROOT = '/Users/mannyhenri/code/gl-dev-media';
const PLAN = path.join(FE_ROOT, 'docs', 'plans', 'self-hosted-models-plan.md');
const TASKS = Array.from({ length: 14 }, (_, i) => `FEM-${String(i + 1).padStart(3, '0')}`);
const JIRA = id => `GRD-${4564 + Number(id.slice(4))}`;   // FEM-001 = GRD-4565 … FEM-014 = GRD-4578
const REPOS = ['film-engine', 'gridlight', 'both'];
const HEADER = ['Task', 'Jira', 'Title', 'Repo', 'Extends', 'Tests', 'Prerequisites', 'AWS'];

// Every command a row may run, per repository, matched EXACTLY.
const COMMANDS = {
    fe: [/^cd backend && npm test$/],
    gl: [
        /^cd gateway && cargo test --lib --bins$/,
        /^cd gateway && cargo nextest run -E 'kind\(test\)'$/,
        /^python3 -m pytest -q tests\/contract$/,
        /^python3 -m pytest -q agents\/[a-z0-9_]+\/tests$/,
        /^python3 scripts\/media_lab\/serve\.py up --box <box> --model <model> --region ca-central-1 --dry-run --yes$/,
        /^cd agent && cargo nextest run$/,
    ],
};
// What each gridlight command needs on disk to be runnable at all.
function glPathsOf(cmd) {
    if (cmd.startsWith('cd gateway')) return ['gateway/Cargo.toml'];
    if (cmd.startsWith('cd agent')) return ['agent/Cargo.toml'];
    if (cmd.includes('serve.py')) return ['scripts/media_lab/serve.py', 'scripts/media_lab/registry.py'];
    const m = cmd.match(/pytest -q (\S+)$/);
    return m ? [m[1]] : [];
}
// Confirmed against GRD-4565..4578: these provision or start an AWS resource.
// Compute: 005, 006, 009, 010, 011, 012, 014. Storage (S3): 007.
const AWS_TASKS = ['FEM-005', 'FEM-006', 'FEM-007', 'FEM-009', 'FEM-010', 'FEM-011', 'FEM-012', 'FEM-014'];

const text = () => fs.readFileSync(PLAN, 'utf8');
const cells = line => line.split('|').slice(1, -1).map(s => s.trim());
function rows() {
    const out = {};
    for (const line of text().split('\n')) {
        const c = cells(line);
        if (!/^FEM-\d{3}$/.test(c[0] || '')) continue;
        const [id, jira, title, repo, extendsCell, tests, prereqs, gate] = c;
        (out[id] = out[id] || []).push({ id, jira, title, repo, extendsCell, tests, prereqs, gate, width: c.length });
    }
    return out;
}
function commandsOf(row) {
    return row.tests.split(';').map(s => s.trim()).filter(Boolean).map(s => {
        const m = s.match(/^\[(fe|gl)\] (.+)$/);
        return m ? { repo: m[1], cmd: m[2] } : { repo: null, cmd: s };
    });
}

test('the plan exists, names the tracker as the only state, and both roots', () => {
    assert.ok(fs.existsSync(PLAN), 'no docs/plans/self-hosted-models-plan.md');
    const t = text();
    assert.match(t, /GRD-4453/);
    assert.match(t, /state lives in Jira/i, 'the plan does not say where task state lives');
    assert.match(t, /Jira link says otherwise, the link wins|the link wins/i, 'the plan does not say Jira links outrank the prerequisites column');
    assert.ok(t.includes(FE_ROOT), 'the film-engine root is not named');
    assert.ok(t.includes(GL_ROOT), 'the gridlight root is not named');
});

test('the task table has exactly the agreed columns, and no status column', () => {
    const header = text().split('\n').find(l => /^\|\s*Task\s*\|/.test(l));
    assert.ok(header, 'no task table header');
    assert.deepEqual(cells(header), HEADER);
});

test('FEM-001..FEM-014 each appear exactly once, with their own Jira key, a title and every column', () => {
    const r = rows();
    assert.deepEqual(TASKS.filter(id => !r[id]), [], 'tasks missing from the plan');
    assert.deepEqual(TASKS.filter(id => r[id] && r[id].length !== 1), [], 'tasks listed more than once');
    assert.deepEqual(Object.keys(r).filter(id => !TASKS.includes(id)), [], 'rows for tasks the epic does not have');
    for (const id of TASKS) {
        const row = r[id][0];
        assert.equal(row.width, HEADER.length, `${id} has ${row.width} cells, not ${HEADER.length}`);
        assert.equal(row.jira, JIRA(id), `${id} carries the wrong Jira key`);
        assert.ok(row.title.length > 10, `${id} has no title`);
        assert.ok(row.extendsCell.length > 2, `${id} does not say what it extends (or "new")`);
    }
});

test('every command names its repository and is one of the known commands exactly', () => {
    const bad = [];
    for (const [id, [row]] of Object.entries(rows())) {
        const cmds = commandsOf(row);
        if (!cmds.length) bad.push(`${id}: no test command`);
        for (const { repo, cmd } of cmds) {
            if (!repo) { bad.push(`${id}: "${cmd}" names no repository ([fe] or [gl])`); continue; }
            if (!COMMANDS[repo].some(rx => rx.test(cmd))) bad.push(`${id}: [${repo}] "${cmd}" is not a known command`);
        }
    }
    assert.deepEqual(bad, []);
});

test('every row runs the repositories it names, and only those', () => {
    const bad = [];
    for (const [id, [row]] of Object.entries(rows())) {
        if (!REPOS.includes(row.repo)) { bad.push(`${id}: repo "${row.repo}"`); continue; }
        const used = new Set(commandsOf(row).map(c => c.repo));
        const want = row.repo === 'film-engine' ? ['fe'] : row.repo === 'gridlight' ? ['gl'] : ['fe', 'gl'];
        if ([...used].sort().join() !== want.join()) bad.push(`${id}: a ${row.repo} row runs [${[...used].join(', ')}]`);
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

test('every task that provisions or starts an AWS resource is gated, and nothing else claims to be', () => {
    const r = rows();
    const gated = TASKS.filter(id => /^gated\b/i.test(r[id][0].gate));
    assert.deepEqual(gated, AWS_TASKS, 'the AWS gate is on the wrong tasks');
    for (const id of TASKS.filter(id => !AWS_TASKS.includes(id))) assert.equal(r[id][0].gate, '—', `${id} should read — in the AWS column`);
    const t = text();
    assert.match(t, /explicit yes/i, 'the gate does not say what opens it');
    assert.match(t, /compute or storage/i, 'the gate does not cover storage as well as compute');
    assert.match(t, /pending the user's yes/i, 'the gate does not say how a gated child is closed');
    assert.match(t, /Region per worker/, 'the region decision the ca-central-1 offerings force is not recorded');
});

test('a suite that is red at baseline is named, with the rule that a task must not add to it', () => {
    const t = text();
    assert.match(t, /own environment/i, 'the agent suites do not say they run in their own venv');
    assert.match(t, /not green at baseline/i, 'the red baseline is not named, so the loop would blame the next task for it');
    assert.match(t, /must not ADD failures/, 'the no-new-failures rule is not stated');
    for (const a of ['audio', 'voice', 'image']) assert.match(t, new RegExp(`${a} (has )?\\d+`), `the ${a} baseline count is not recorded`);
});

test('every path the note names exists in its own repository', t => {
    const extendsPaths = [];
    for (const [id, [row]] of Object.entries(rows())) {
        for (const m of row.extendsCell.matchAll(/`([^`]+)`/g)) {
            const p = m[1];
            if (!p.includes('/') || /^GET /.test(p)) continue;
            extendsPaths.push({ id, p });
        }
    }
    assert.ok(extendsPaths.length >= 10, `only ${extendsPaths.length} paths named`);
    const fe = extendsPaths.filter(x => /^(lib|routes)\//.test(x.p) || x.p.startsWith('src/'));
    const missingFe = fe.filter(x => !fs.existsSync(path.join(FE_ROOT, x.p.startsWith('src/') ? '' : 'backend', x.p)))
        .map(x => `${x.id}: ${x.p}`);
    assert.deepEqual(missingFe, [], 'these film-engine paths do not exist');

    if (!fs.existsSync(GL_ROOT)) { t.diagnostic(`gridlight root ${GL_ROOT} absent — its paths are not checked here`); return; }
    const gl = extendsPaths.filter(x => !fe.includes(x));
    for (const [id, [row]] of Object.entries(rows())) {
        for (const c of commandsOf(row).filter(c => c.repo === 'gl')) for (const p of glPathsOf(c.cmd)) gl.push({ id, p });
    }
    const missingGl = gl.filter(x => !fs.existsSync(path.join(GL_ROOT, x.p))).map(x => `${x.id}: ${x.p}`);
    assert.deepEqual([...new Set(missingGl)], [], 'these gridlight paths do not exist');
});

test('the plan holds no task status — Jira is the only state', () => {
    const status = /\b(TODO|To Do|In Progress|DONE|BLOCKED|SKIPPED|WAITING ON)\b/;
    const table = text().split('\n').filter(l => /^\| FEM-/.test(l));
    assert.deepEqual(table.filter(l => status.test(l)), [], 'a task row carries a status');
});
