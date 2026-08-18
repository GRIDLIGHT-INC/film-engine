#!/usr/bin/env node
/**
 * Pre-run readiness report for an end-to-end screenplay → finished shot test.
 *
 *   node backend/preflight.js                 # against the newest project
 *   node backend/preflight.js --all           # every project
 *   node backend/preflight.js <project-id>
 *   node backend/preflight.js --no-dialogue   # screenplay has no spoken lines
 *   node backend/preflight.js --json
 *
 * Exits 0 when every stage can run and 1 when any is blocked, so it can gate a
 * run rather than merely inform one.
 */

const { db } = require('./db/database');
const { preflight } = require('./lib/e2e-preflight');

const PAINT = {
    go: '\x1b[32m  GO     \x1b[0m',
    skipped: '\x1b[90m  SKIP   \x1b[0m',
    handoff: '\x1b[36m  NLE    \x1b[0m',
    blocked: '\x1b[31m  BLOCKED\x1b[0m',
};

function pickProject(argv) {
    const explicit = argv.find(a => !a.startsWith('--'));
    if (explicit) {
        const row = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(explicit);
        if (!row) {
            process.stderr.write(`No project with id ${explicit}\n`);
            process.exit(2);
        }
        return row;
    }
    return db.prepare('SELECT * FROM film_projects ORDER BY updated_at DESC LIMIT 1').get() || null;
}

/** Every project, worst first: the one that fails is the one worth seeing. */
async function auditAll(opts) {
    const projects = db.prepare('SELECT * FROM film_projects ORDER BY updated_at DESC').all();
    if (!projects.length) {
        process.stdout.write('No projects yet.\n');
        process.exit(0);
    }

    const reports = [];
    for (const project of projects) {
        let projectConfig = {};
        try { projectConfig = JSON.parse(project.provider_config || '{}'); } catch (_) { projectConfig = {}; }
        const report = await preflight({ projectConfig, hasDialogue: opts.hasDialogue, inEngine: opts.inEngine });
        reports.push({ project, report });
    }

    if (opts.asJson) {
        process.stdout.write(JSON.stringify(reports.map(r => ({
            project: r.project.id, title: r.project.title, ...r.report,
        })), null, 2) + '\n');
        process.exit(reports.every(r => r.report.ready) ? 0 : 1);
    }

    process.stdout.write(`\nEnd-to-end readiness — ${reports.length} project(s)\n${'─'.repeat(76)}\n`);
    for (const { project, report } of reports) {
        const { go, handoff, skipped, blocked, total } = report.summary;
        const verdict = report.ready ? '\x1b[32mREADY  \x1b[0m' : '\x1b[31mBLOCKED\x1b[0m';
        process.stdout.write(`${verdict} ${project.title}\n`);
        process.stdout.write(`        ${go} ready, ${handoff} in the NLE, ${skipped} skipped, ${blocked} blocked, of ${total}\n`);
        for (const stage of report.blocked) {
            process.stdout.write(`        · ${stage.name}: ${stage.reasons[0] || 'blocked'}\n`);
        }
    }
    process.stdout.write(`${'─'.repeat(76)}\n`);
    process.exit(reports.every(r => r.report.ready) ? 0 : 1);
}

async function main() {
    const argv = process.argv.slice(2);
    const asJson = argv.includes('--json');
    const hasDialogue = !argv.includes('--no-dialogue');
    const inEngine = argv.includes('--in-engine');

    // --all, because auditing whichever project was touched last and saying
    // nothing about that choice is how a configured project sat unexamined
    // while a demo project reported seven blocked stages.
    if (argv.includes('--all')) return auditAll({ asJson, hasDialogue, inEngine });

    const project = pickProject(argv);
    let projectConfig = {};
    if (project) {
        try { projectConfig = JSON.parse(project.provider_config || '{}'); } catch (_) { projectConfig = {}; }
    }

    const report = await preflight({ projectConfig, hasDialogue, inEngine });

    if (asJson) {
        process.stdout.write(JSON.stringify({ project: project && project.id, ...report }, null, 2) + '\n');
        process.exit(report.ready ? 0 : 1);
    }

    const title = project ? `${project.title} (${project.id})` : 'no project — checking defaults';
    process.stdout.write(`\nEnd-to-end readiness — ${title}\n`);
    process.stdout.write(`${'─'.repeat(76)}\n`);

    for (const stage of report.stages) {
        const cap = stage.capability ? ` [${stage.capability}` + (stage.effective ? ` → ${stage.effective}` : '') + ']' : '';
        process.stdout.write(`${PAINT[stage.verdict]} ${stage.name}${cap}\n`);
        for (const reason of stage.reasons) process.stdout.write(`           ${reason}\n`);
    }

    process.stdout.write(`${'─'.repeat(76)}\n`);
    const { go, skipped, handoff, blocked, total } = report.summary;
    process.stdout.write(`${go} ready, ${handoff} finished in the NLE, ${skipped} auto-skipped, ${blocked} blocked, of ${total} stages\n`);

    if (!report.ready) {
        process.stdout.write('\nTo unblock:\n');
        const fixes = [...new Set(report.blocked.flatMap(b => b.fixes))];
        for (const fix of fixes) process.stdout.write(`  • ${fix}\n`);
        process.stdout.write('\n');
    } else {
        process.stdout.write('\nEvery stage can run. A live test will generate media and spend money.\n\n');
    }

    process.exit(report.ready ? 0 : 1);
}

if (require.main === module) {
    main().catch(err => {
        process.stderr.write(`preflight failed: ${err.stack}\n`);
        process.exit(2);
    });
}
