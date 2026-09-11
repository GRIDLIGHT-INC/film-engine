#!/usr/bin/env node
/**
 * A dry run of every service a production uses.
 *
 *   node backend/dry-run.js [project-id] [--json]
 *
 * Opens no socket, reads no credential into its output, and generates nothing.
 * For each capability it reports the provider and model that would run, what
 * the request is composed FROM, the request the provider would receive, and
 * what the rate book says it costs.
 *
 * Built on buildCapabilityPayload and each adapter's own request builder rather
 * than on a second description of them — a report assembled independently
 * drifts from what is sent, which is the fault the refine preview shipped once.
 */

const { db } = require('./db/database');
const providers = require('./lib/providers');
const { describeCapability } = require('./lib/dry-run');
const { providerConfigOf } = require('./lib/provider-config');

const C = {
    dim: s => `\x1b[2m${s}\x1b[0m`,
    bold: s => `\x1b[1m${s}\x1b[0m`,
    green: s => `\x1b[32m${s}\x1b[0m`,
    amber: s => `\x1b[33m${s}\x1b[0m`,
    cyan: s => `\x1b[36m${s}\x1b[0m`,
    red: s => `\x1b[31m${s}\x1b[0m`,
};

function pickProject(id) {
    if (id) return db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);
    return db.prepare('SELECT * FROM film_projects ORDER BY updated_at DESC LIMIT 1').get();
}

/** A shot with as much built as possible, so the report describes a real request. */
function pickShot(projectId) {
    return db.prepare(`
        SELECT sh.* FROM film_shots sh
        JOIN film_scenes sc ON sc.id = sh.scene_id
        WHERE sc.project_id = ?
        ORDER BY (SELECT COUNT(*) FROM film_assets a WHERE a.shot_id = sh.id) DESC
        LIMIT 1`).get(projectId);
}

function main() {
    const args = process.argv.slice(2);
    const asJson = args.includes('--json');
    const project = pickProject(args.find(a => !a.startsWith('--')));
    if (!project) { console.error('No project found.'); process.exit(1); }

    const shot = pickShot(project.id);
    const cfg = providerConfigOf(project);

    const { loadShotContext } = require('./lib/capability-payloads');
    let ctx = { project };
    if (shot) {
        try { ctx = { ...loadShotContext(shot.id), project }; }
        catch (_) { ctx = { project, shot }; }
    }

    const rows = providers.CAPABILITIES
        .map(cap => describeCapability(cap, ctx, cfg));

    if (asJson) {
        console.log(JSON.stringify({ project: project.title, shot: shot && shot.shot_code, capabilities: rows }, null, 2));
        return;
    }

    const line = '─'.repeat(78);
    console.log(`\nDry run — ${C.bold(project.title)}${shot ? `, built from shot ${C.bold(shot.shot_code)}` : ''}`);
    console.log(C.dim('Nothing was sent. No credential appears below; pictures are described, not printed.'));
    console.log(line);

    let total = 0;
    for (const r of rows) {
        const head = r.provider
            ? `${C.green('●')} ${C.bold(r.capability.padEnd(9))} ${r.provider}${r.model ? C.dim(' / ' + r.model) : ''}`
            : `${C.red('○')} ${C.bold(r.capability.padEnd(9))} ${C.dim('no provider')}`;
        console.log(`\n${head}`);

        if (r.cost) {
            const c = r.cost;
            const money = c.subscription ? 'on your subscription — charges the project nothing'
                : c.self_hosted ? 'local — free'
                : `$${c.estimate_usd} per ${c.basis}`;
            console.log(`  ${C.dim('cost')}     ${money}`);
            if (!c.subscription && !c.self_hosted) total += c.estimate_usd;
        }

        if (r.inputs.length) {
            console.log(`  ${C.dim('built from')}`);
            r.inputs.forEach(i => console.log(`      · ${i}`));
        }

        const body = r.outbound && r.outbound.body ? r.outbound.body : r.payload;
        if (body) {
            if (r.outbound && r.outbound.url) console.log(`  ${C.dim('POST')}     ${r.outbound.url}`);
            console.log(`  ${C.dim(r.outbound ? 'sends' : 'payload')}`);
            for (const [k, v] of Object.entries(body)) {
                const shown = typeof v === 'string' ? v
                    : (v && typeof v === 'object' ? JSON.stringify(v) : String(v));
                const flat = String(shown).replace(/\n/g, ' ');
                console.log(`      ${C.cyan(k.padEnd(18))} ${flat.length > 300 ? flat.slice(0, 300) + '…' : flat}`);
            }
        }
        r.notes.forEach(n => console.log(`  ${C.amber('note')}     ${n}`));
    }

    console.log(`\n${line}`);
    const live = rows.filter(r => r.provider).length;
    console.log(`${live} of ${rows.length} capabilities would run. `
        + `One pass over this shot: ${C.bold('$' + total.toFixed(2))} in metered spend.`);
    console.log(C.dim('LLM work is on your MCP subscription and charges the project nothing.'));
}

if (require.main === module) main();
module.exports = { main };
