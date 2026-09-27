/**
 * A connection that predates the capability
 * ─────────────────────────────────────────────────────────────────────────
 *
 * An agent host spawns backend/mcp-server.js once and keeps that process for
 * the life of the connection, so `tools/list` is answered from a registry built
 * when the process loaded. Four analysis tools shipped at 08:26; the host's
 * process had started at 13:54 the previous day. Asked to use them, the
 * connected model checked the name, searched the catalogue by keyword,
 * re-queried the server, correctly found nothing, and concluded the feature was
 * unbuilt — offering to design the pair that already existed. Every step of
 * that reasoning was sound; the information it needed was unreachable.
 *
 * These hold the two channels that DO reach a stale process. A diagnostic tool
 * would not: it would be missing from exactly the connections that need it,
 * which is why one was not built.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-stale-' + crypto.randomUUID().slice(0, 8));

const build = require('../lib/mcp-build');
const tools = require('../lib/mcp-tools');

/**
 * Run the process as if a tool had shipped after it loaded.
 *
 * `await`ed rather than wrapped in a sync finally: `try { return body() }
 * finally { restore() }` around an ASYNC body restores the moment the promise
 * is created, so the stub is gone before the code under test runs — and the
 * assertion then fails against a perfectly healthy connection.
 */
async function asStaleProcess(hide, body) {
    const real = tools.listTools;
    const full = real();
    tools.listTools = () => full.filter(t => !hide.test(t.name));
    const stamp = new Date();
    fs.utimesSync(build.SURFACE_MODULES[0], stamp, stamp);
    try { return await body(full); } finally { tools.listTools = real; }
}

test('a fresh process reports nothing, and says nothing', () => {
    // A warning that is always on is one people learn to ignore, taking the
    // real one with it — so the quiet case is the one that matters most.
    const drift = build.surfaceDrift();
    assert.equal(drift.stale, false, JSON.stringify(drift));
    assert.equal(build.stalenessNote(), null);
});

test('a stale process names the tools it is missing', async () => {
    const note = await asStaleProcess(/^analysis_/, () => build.stalenessNote());
    assert.ok(note, 'a connection missing four tools reported nothing');
    for (const name of ['analysis_brief', 'analysis_write']) {
        assert.ok(note.includes(name),
            `the note must NAME what is missing — "something changed" is not actionable: ${note}`);
    }
});

test('the note gives the remedy and contradicts the wrong conclusion', async () => {
    const note = await asStaleProcess(/^analysis_/, () => build.stalenessNote());
    assert.ok(/[Rr]estart/.test(note), 'the note never says what to do');
    assert.ok(/built/.test(note),
        'the note must say the capability EXISTS — the failure mode is a model concluding it does not');
    assert.ok(/started at \d{4}-/.test(note), 'the note does not say when this connection was built');
});

test('drift is a real diff, not a timestamp', () => {
    /*
     * Touching a surface module changes its mtime and nothing else. A check
     * that fired on that alone would go off on every save and be switched off
     * within a day.
     */
    const stamp = new Date();
    fs.utimesSync(build.SURFACE_MODULES[0], stamp, stamp);
    const drift = build.surfaceDrift();
    assert.equal(drift.stale, false,
        'a touched file with an unchanged tool list was reported as a stale connection');
});

test('the diagnostic leaves the process exactly as it found it', () => {
    // It evicts modules from the require cache to re-read them. A diagnostic
    // that leaves the process in a different state than it found it is worse
    // than no diagnostic.
    const before = build.SURFACE_MODULES.map(f => require.cache[f]);
    const names = tools.listTools().map(t => t.name);
    const stamp = new Date();
    fs.utimesSync(build.SURFACE_MODULES[0], stamp, stamp);
    build.surfaceDrift();
    build.SURFACE_MODULES.forEach((f, i) => {
        assert.strictEqual(require.cache[f], before[i],
            `${path.basename(f)} was left evicted or replaced in the require cache`);
    });
    assert.deepEqual(tools.listTools().map(t => t.name), names,
        'the live registry changed identity after a diagnostic ran');
});

test('it never throws, whatever the disk or the registry does', () => {
    // This runs inside an error path and while answering initialize. A
    // diagnostic that can break either is worse than the confusion it exists to
    // prevent.
    const target = build.SURFACE_MODULES[0];
    const saved = fs.readFileSync(target);
    try {
        fs.writeFileSync(target, 'this is not javascript {{{');
        assert.doesNotThrow(() => build.surfaceDrift());
        assert.doesNotThrow(() => build.stalenessNote());
        assert.equal(build.surfaceDrift().stale, false,
            'an unreadable registry was reported as a stale connection');
    } finally {
        fs.writeFileSync(target, saved);
    }

    // And when the LIVE registry is the thing that throws — the case an
    // unreadable file does not reach, because that is caught deeper down.
    const real = tools.listTools;
    tools.listTools = () => { throw new Error('registry exploded'); };
    const stamp = new Date();
    fs.utimesSync(build.SURFACE_MODULES[0], stamp, stamp);
    try {
        assert.doesNotThrow(() => build.surfaceDrift());
        assert.doesNotThrow(() => build.stalenessNote());
        assert.doesNotThrow(() => build.serverInfo({ name: 'x', version: '0.1.0' }));
        /*
         * And it must not answer CONFIDENTLY AND WRONGLY. Reading the live
         * registry as an empty list compares as "this connection is missing all
         * 206 tools", which is the same class of failure as the one being
         * fixed: a definite answer that is not true.
         */
        const drift = build.surfaceDrift();
        assert.equal(drift.stale, false,
            `an unreadable registry reported ${drift.missing.length} missing tools`);
        assert.equal(build.stalenessNote(), null);
    } finally { tools.listTools = real; }
});

test('behaviour is deliberately not in the surface set', () => {
    /*
     * Route modules change what a tool DOES, not which exist. Including them
     * would flag every backend edit as a stale connection — the noise that
     * gets a check ignored. Stated by name so the exclusion is a decision
     * rather than an oversight.
     */
    const names = build.SURFACE_MODULES.map(f => path.basename(f));
    assert.deepEqual(names.sort(), ['flow-node-types.js', 'mcp-tools.js']);
    assert.ok(!build.SURFACE_MODULES.some(f => f.includes(`${path.sep}routes${path.sep}`)));
});

test('initialize hands the client the build, not a constant nobody updates', async () => {
    /*
     * A host fixes its tool list when it spawns this process, so the only
     * record of WHICH build a connection is serving is what initialize says.
     * Asserted through the real method, because a helper that produces the
     * right string and a server that ignores it look identical from the lib.
     */
    const server = require('../mcp-server');
    const hello = await server.METHODS.initialize({
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' },
    });
    assert.match(hello.serverInfo.version, new RegExp(`^${require('../package.json').version.replace(/\./g, '\\.')}\\+\\d+tools\\.\\d{4}-\\d{2}-\\d{2}T`),
        `initialize tells a client nothing about which build it reached: ${hello.serverInfo.version}`);
    assert.equal(hello.serverInfo.name, 'film-engine');

    const info = build.serverInfo({ name: 'film-engine', version: '0.1.0' });
    assert.equal(info.name, 'film-engine');
    assert.match(info.version, /^0\.1\.0\+\d+tools\.\d{4}-\d{2}-\d{2}T/,
        `the version says nothing about which build this is: ${info.version}`);
    assert.ok(info.version.includes(`+${tools.listTools().length}tools.`));
});

test('the unknown-tool error carries the note when the connection is stale', async () => {
    const server = require('../mcp-server');
    const ask = async name => {
        try { await server.METHODS['tools/call']({ name, arguments: {} }); return null; }
        catch (err) { return err.message; }
    };

    // Fresh: a plain protocol error, with no lecture attached. A healthy
    // connection told to restart is the noise that gets the check ignored.
    const plain = await ask('no_such_tool_at_all');
    assert.ok(plain, 'an unadvertised name did not error');
    assert.ok(!/[Rr]estart the agent host/.test(plain),
        `a healthy connection must not be told to restart: ${plain}`);

    /*
     * Stale: the same error, plus what is actually wrong.
     *
     * The name asked for is one no build has, because the DISPATCHER is built
     * at load and cannot be un-built here — a real stale process lacks the name
     * in both the list and the dispatcher, and this reproduces the half that
     * reaches the caller. What the note reports as missing is driven by the
     * registry diff, which is stubbed.
     */
    const message = await asStaleProcess(/^analysis_/, () => ask('analysis_brief_x'));
    assert.ok(message, 'an unadvertised name did not error while stale');
    assert.ok(/analysis_brief_x/.test(message), 'the error no longer names what was asked for');
    assert.ok(/analysis_brief/.test(message) && /[Rr]estart/.test(message),
        `the one channel that reaches a stale connection said nothing useful: ${message}`);
    assert.ok(/built/.test(message),
        'the error must contradict the wrong conclusion, which is that the tool was never made');
});

test('every tool in the registry is served over the wire', { timeout: 60000 }, async () => {
    /*
     * The other half of the same failure: a tool that exists in the registry
     * and never reaches a client is invisible in exactly the same way, and a
     * registry test cannot see it. Spawned the way an agent host spawns it.
     */
    const served = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js')], {
            env: { ...process.env, FILM_DATA_DIR: process.env.FILM_DATA_DIR },
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        let out = '';
        const timer = setTimeout(() => { proc.kill(); reject(new Error('the server never answered')); }, 45000);
        proc.stdout.on('data', chunk => {
            out += chunk;
            for (const line of out.split('\n')) {
                let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
                if (msg.id === 2 && msg.result) {
                    clearTimeout(timer); proc.kill();
                    resolve(msg.result.tools.map(t => t.name));
                }
            }
        });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    });

    const declared = tools.listTools().map(t => t.name).sort();
    assert.deepEqual(served.slice().sort(), declared,
        'the tools a client receives are not the tools the registry declares');
    // The four this was reported for, named so the case cannot be silently lost.
    for (const name of ['analysis_brief', 'analysis_write', 'analysis_get', 'analysis_delete']) {
        assert.ok(served.includes(name), `${name} does not reach a connected client`);
    }
});
