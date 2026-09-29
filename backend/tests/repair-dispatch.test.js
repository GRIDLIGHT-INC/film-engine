const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-dispatch-'));

const BACKEND = path.join(__dirname, '..');
const SPA = fs.readFileSync(path.join(BACKEND, '..', 'src', 'index.html'), 'utf8');
const strip = (s) => s.split('\n').map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');

/**
 * A REPAIR THAT SILENTLY DOES THE ADJACENT-BUT-WRONG THING.
 *
 * The page sends `bridge: isBridge` and `routes/repair.js` never reads it — so
 * pressing "Bridge this cut" runs a WITHIN-CLIP repair. It succeeds. It returns
 * a version. It splices generated footage into the FIRST shot and leaves the
 * second untouched, when the whole premise of a bridge is that neither shot is
 * individually at fault.
 *
 * Nothing errors, which is what makes this class expensive: the editor gets a
 * plausible result, for money, that is not the operation they asked for.
 *
 * MY PEER RAISED THE GENERALISATION and it is the right one — check EVERY path
 * that can start a repair, not just the one known to be wrong. A second route
 * with the same mis-binding would be invisible to a test written against the
 * first.
 */

/** Every entry point that can plan or run a repair. Found, not listed. */
function entryPoints() {
    const found = [];
    const routes = path.join(BACKEND, 'routes');
    for (const f of fs.readdirSync(routes).filter(x => x.endsWith('.js'))) {
        const src = strip(fs.readFileSync(path.join(routes, f), 'utf8'));
        if (/\brunRepair\s*\(|\brunBridge\s*\(|\bplanRepair\s*\(|\bplanBridge\s*\(/.test(src)) {
            found.push({ id: `routes/${f}`, src, kind: /run(Repair|Bridge)\s*\(/.test(src) ? 'run' : 'plan' });
        }
    }
    const tools = strip(fs.readFileSync(path.join(BACKEND, 'lib', 'mcp-tools.js'), 'utf8'));
    for (const m of tools.matchAll(/name:\s*'(repair_[a-z_]+)'/g)) found.push({ id: `tool:${m[1]}`, src: tools, kind: 'tool' });
    if (/pbRunRepair/.test(SPA)) found.push({ id: 'page:pbRunRepair', src: strip(SPA), kind: 'page' });
    return found;
}

test('the scan found the repair entry points it is meant to police', () => {
    const eps = entryPoints();
    assert.ok(eps.length >= 4,
        `only ${eps.length} entry point(s) found (${eps.map(e => e.id).join(', ')}); `
        + 'this scan is looking in the wrong place and every check below is vacuous');
});

test('every entry point that can RUN a repair honours the bridge flag', () => {
    /*
     * The distinction is not cosmetic. A bridge and a splice produce DIFFERENT
     * artefacts — one a new piece of footage plus two trim points, the other a
     * rewritten clip — so a runner that ignores the flag does not merely
     * mislabel the result, it makes the wrong thing.
     */
    const wrong = [];
    for (const ep of entryPoints()) {
        if (ep.kind === 'plan' || ep.kind === 'page') continue;   // planning and the caller are checked below
        const relevant = ep.kind === 'tool'
            ? (/repair_run/.test(ep.src) ? ep.src : '')
            : ep.src;
        if (!relevant) continue;
        if (!/\bbridge\b/.test(relevant)) wrong.push(`${ep.id}: never reads a bridge flag`);
    }
    assert.deepStrictEqual(wrong, [],
        `these can start a repair and cannot tell a bridge from a splice: ${wrong.join(', ')}`);
});

test('the run route dispatches a bridge to the bridge runner, not the splice runner', () => {
    /*
     * BOUND TO THE GUARDING CONDITION, and two weaker versions are worth
     * recording because both passed over a dead branch.
     *
     * The first asserted that `runBridge` appeared before `runRepair(` in the
     * source. Turning the whole branch into `if (false)` PASSED it — the import
     * and the dead call are still there, in that order. Source POSITION cannot
     * tell live code from dead code.
     *
     * The second tried to drive the route and stub both runners. That passed
     * too, and vacuously: routes/repair.js DESTRUCTURES them at module load, so
     * reassigning the module's exports afterwards never reaches the captured
     * binding — the stub was never called and the assertion held over an empty
     * list. A behavioural drive is not reachable without injection this route
     * does not have, and adding injection purely for a test is worse than
     * saying so.
     *
     * So: find the call, walk back to the `if` that guards it, and require that
     * condition to actually test the flag. `if (false)` fails. So does a
     * condition on some other field.
     */
    const src = strip(fs.readFileSync(path.join(BACKEND, 'routes', 'repair.js'), 'utf8'));
    const call = src.indexOf('runBridge(');
    assert.ok(call > 0, 'the run route never calls a bridge runner');

    /*
     * EVERY condition on the way to the call, not the nearest one. The nearest
     * `if` before it is the inner `if (!nextClip)` guard, so lastIndexOf named
     * the wrong branch and reported working code as broken — the check has to
     * ask whether ANYTHING on the path tests the flag.
     */
    const before = src.slice(0, call);
    const conditions = [...before.matchAll(/if\s*\(([^{]*)\)\s*\{/g)].map(m => m[1]);
    assert.ok(conditions.length > 0, 'the bridge call is not guarded by anything');
    assert.ok(conditions.some(c => /\bbridge\b/.test(c)),
        'no condition on the way to the bridge call tests the bridge flag, so it either always '
        + `fires or never does. Conditions seen: ${conditions.map(c => c.trim()).slice(-4).join(' | ')}`);

    // And it must return, or execution falls through into the splice as well.
    // Bounded by the call itself and the splice that follows it, not by the
    // stale `guard` index the earlier version left behind.
    const spliceAt = src.indexOf('const result = await runRepair');
    const branch = src.slice(call, spliceAt > call ? spliceAt : src.length);
    assert.match(branch, /return json\(/,
        'the bridge branch does not return, so a bridge request also runs the within-clip splice');
});

test('an agent can ask for a bridge, not only a person', () => {
    /*
     * The goal's own stated rabbit hole. A capability reachable from the page
     * and not from MCP is one the connected model cannot use.
     */
    /*
     * BOUNDED BY THE TOOL'S OWN DECLARATION, not by a character window. A
     * 3000-char slice from repair_plan runs into repair_run's block, so
     * deleting repair_plan's bridge argument passed on repair_run's — the
     * fourth time a fixed-size window has lied in this codebase.
     */
    const { ALL_ROUTE_TOOLS } = require('../lib/mcp-tools');
    for (const name of ['repair_plan', 'repair_run']) {
        const t = ALL_ROUTE_TOOLS.find(x => x.name === name);
        assert.ok(t, `${name} is gone`);
        assert.ok(t.schema && t.schema.bridge,
            `${name} cannot express a bridge, so an agent can only ever ask for a splice`);
        assert.ok(t.schema.next_shot_id,
            `${name} takes a bridge flag but no shot on the far side of the cut`);
    }
});

/* ── the executor itself ───────────────────────────────────────────────── */

test('a bridge produces its own footage and two trim points, never a spliced shot', async () => {
    /*
     * THE BEHAVIOURAL DIFFERENCE. A within-clip repair writes a new version of
     * one shot. A bridge must not: it hands back a piece of footage that sits
     * BETWEEN two shots, plus where to cut each of them. If it registered a new
     * version of shot A it would be the splice wearing a different name.
     */
    const { runBridge } = require('../lib/repair-run');
    assert.strictEqual(typeof runBridge, 'function', 'there is no bridge runner');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-bridge-run-'));
    const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
    const mk = (n, secs, colour) => {
        const p = path.join(tmp, n);
        execFileSync(resolveFfmpeg().bin, ['-nostdin', '-y', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `color=c=${colour}:s=320x240:d=${secs + 1}`,
            '-frames:v', String(Math.round(secs * 24)), '-c:v', 'mpeg4', '-r', '24', p],
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        return p;
    };
    const a = mk('a.mp4', 10, 'red');
    const b = mk('b.mp4', 10, 'blue');
    const inserted = [];

    const r = await runBridge({
        spans: [
            { shotId: 'a', shotCode: '1A', sourcePath: a, startSec: 7, endSec: 10, durationSeconds: 10 },
            { shotId: 'b', shotCode: '1B', sourcePath: b, startSec: 0, endSec: 3, durationSeconds: 10 },
        ],
        resolution: '480p',
        publicBase: 'https://x.test',
        /*
         * A REAL projectId, because the frames must be MINTABLE. Only media the
         * engine already stores can be handed to a provider, so extracting to a
         * bare temp dir is refused one stage later — correctly. Passing null
         * here tested a path the route can never take.
         */
        projectId: 'bridge-test',
        /*
         * The SQL is captured as well as the args, because asset_type is a
         * LITERAL IN THE STATEMENT rather than a parameter — a stub that keeps
         * only the args cannot see it, and a mutation filing the bridge as
         * video_raw survived exactly that blindness.
         */
        db: { prepare: (sql) => ({ get: () => null, run: (...args) => inserted.push({ sql, args }) }) },
        generate: async () => ({ ok: true, path: mk('gen.mp4', 6, 'green') }),
    });

    assert.strictEqual(r.ok, true, `failed at ${r.stage}: ${r.reason}`);
    assert.ok(fs.existsSync(r.output), 'no bridge file was produced');
    const seen = inspectMedia(r.output);
    assert.ok(Math.abs(seen.durationSeconds - 6) < 0.4,
        `the bridge should be 6s (3 off A plus 3 off B), read ${seen.durationSeconds}`);

    assert.ok(Array.isArray(r.trim) && r.trim.length === 2, 'no trim instructions came back');
    assert.deepStrictEqual(r.trim.map(t => [t.shot_code, t.new_out_sec ?? t.new_in_sec]),
        [['1A', 7], ['1B', 3]], 'the trim points are not where the marks were');

    // The source clips must be untouched — a bridge rewrites neither shot.
    assert.ok(fs.existsSync(a) && fs.existsSync(b), 'a source clip was destroyed');
    /*
     * A bridge filed as video_raw would be selected by the timeline, the
     * conform and all three NLE exporters — appearing in the cut IN ADDITION to
     * the two shots it replaces part of. It must be `other`.
     */
    const insertSql = inserted.map(i => i.sql).join(' ');
    assert.ok(!/'video_raw'|'video_final'|'video_synced'/.test(insertSql),
        'the bridge registered itself as shot footage, so it would appear in the cut twice');
    assert.match(insertSql, /'other'/, 'the bridge was not registered as `other`');
    assert.strictEqual(r.assetType, 'other');
    assert.strictEqual(r.kind, 'bridge');

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* temp */ }
});

test('a bridge refusal names its stage, like every other repair stage', async () => {
    const { runBridge } = require('../lib/repair-run');
    const r = await runBridge({ spans: [], resolution: '480p' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.stage && r.reason, `refused with no stage or reason: ${JSON.stringify(r)}`);
    assert.strictEqual(r.stage, 'plan', 'an empty span list is a planning failure');
});

test('a THROWN error names the stage it happened in, not the first one', async () => {
    /*
     * The gap a mutation found: every thrown error reported `plan`, so an
     * undefined import in the delivery stage came back as a planning failure —
     * which sends a reader to the marks rather than to the code that broke. A
     * refusal test cannot catch it, because refusals name their stage
     * explicitly; only a THROW exercises the catch.
     */
    const { runBridge } = require('../lib/repair-run');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-bridge-throw-'));
    const { resolveFfmpeg } = require('../lib/ffmpeg');
    const mk = (n, secs) => {
        const p2 = path.join(tmp, n);
        execFileSync(resolveFfmpeg().bin, ['-nostdin', '-y', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `color=c=red:s=320x240:d=${secs + 1}`,
            '-frames:v', String(Math.round(secs * 24)), '-c:v', 'mpeg4', '-r', '24', p2],
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        return p2;
    };
    const r = await runBridge({
        spans: [
            { shotId: 'a', shotCode: '1A', sourcePath: mk('ta.mp4', 10), startSec: 7, endSec: 10, durationSeconds: 10 },
            { shotId: 'b', shotCode: '1B', sourcePath: mk('tb.mp4', 10), startSec: 0, endSec: 3, durationSeconds: 10 },
        ],
        resolution: '480p', publicBase: 'https://x.test', projectId: 'throw-test',
        generate: () => { throw new Error('boom from the generator'); },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'generate',
        `a throw inside the generate stage was reported as "${r.stage}"`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* temp */ }
});

test('the page no longer claims a cut cannot be planned', () => {
    const body = strip(SPA);
    assert.ok(!/Cross-clip is REPORTED rather than planned/.test(body),
        'the page still carries the comment saying a cut cannot be planned; it can');
});
