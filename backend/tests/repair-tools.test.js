const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * RBF-009 — the repair, reachable from an agent.
 *
 * THIS IS THE GOAL'S OWN STATED RABBIT HOLE: "make sure we use MCPs wherever we
 * can". A capability with no MCP surface is one the connected model cannot use,
 * and this codebase has shipped that failure before — `POST /film/projects`
 * worked for months with no `project_create`, so an agent could write a
 * screenplay into a project and could not bring one into existence. Nothing
 * failed; the capability was simply absent, which is the hardest gap to notice
 * because there is no error to read.
 *
 * So the denominator is DERIVED FROM THE ROUTES, not from a list of tool names:
 * every repair route the server dispatches must have a covering tool. A tool
 * list can only confirm what somebody remembered.
 */

/*
 * FILM_DATA_DIR IS SET BEFORE ANY REQUIRE. db/database resolves its path at
 * IMPORT time, so a test that requires it without this opens the operator's
 * REAL database — which is exactly what happened: this file recreated
 * ~/.gridlight and left three unrelated audio tests failing with SQLITE_ERROR.
 * tests/test-isolation.test.js exists for precisely this and caught it.
 */
process.env.FILM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-repairtools-'));

const BACKEND = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
/*
 * ALL_ROUTE_TOOLS is the RAW registry — it carries method, path and handler.
 * `listTools()` is the MCP-facing view and carries only what a client sees, so
 * it cannot answer "does this dispatch anywhere". Both are checked: a tool
 * present in the registry and absent from the listing is one no agent can call.
 */
const { ALL_ROUTE_TOOLS, listTools, callTool } = require('../lib/mcp-tools');
const TOOLS = ALL_ROUTE_TOOLS;

/** Repair routes the server actually dispatches, found rather than listed. */
function repairRoutes() {
    const out = new Set();
    for (const m of SERVER.matchAll(/parts\[3\]\s*===\s*'(repair[a-z-]*)'/g)) out.add(m[1]);
    for (const m of SERVER.matchAll(/parts\[1\]\s*===\s*'(repair[a-z-]*)'/g)) out.add(m[1]);
    return [...out];
}

const byName = (n) => TOOLS.find(t => t.name === n);

test('the scan found the repair routes it is meant to police', () => {
    const found = repairRoutes();
    assert.ok(found.length >= 2,
        `only ${found.length} repair route(s) dispatched (${found.join(', ')}); either the run route `
        + 'was never wired, or this scan is looking in the wrong place and every check below is vacuous');
});

test('every repair route has a covering MCP tool', () => {
    /*
     * A route that ships without a tool is a thing the app can do and an agent
     * cannot. Matched on the tool's own path builder, so a tool that merely
     * mentions the word in its description does not count as coverage.
     */
    const uncovered = [];
    for (const route of repairRoutes()) {
        const covering = TOOLS.filter((t) => {
            if (typeof t.path !== 'function') return false;
            let built = '';
            try { built = t.path({ shot_id: 'X', start_sec: 1, end_sec: 5 }); } catch (_) { built = ''; }
            return built.includes(route);
        });
        if (!covering.length) uncovered.push(route);
    }
    assert.deepStrictEqual(uncovered, [],
        `repair routes an agent cannot reach: ${uncovered.join(', ')}`);
});

test('both tools are visible to a client, not only present in the registry', () => {
    const listed = listTools().map(t => t.name);
    for (const name of ['repair_plan', 'repair_run']) {
        assert.ok(listed.includes(name),
            `${name} is in the registry and absent from the listing, so no agent can call it`);
    }
});

test('repair_plan is free, and says so', () => {
    const t = byName('repair_plan');
    assert.ok(t, 'there is no repair_plan tool');
    assert.strictEqual(t.method, 'GET', 'a free packet is a GET; a POST reads as an action');
    assert.match(t.description, /free|spends nothing|costs nothing/i,
        `repair_plan does not tell an agent it is free: ${t.description}`);
    assert.ok(!/SPENDS CREDITS/.test(t.description),
        'repair_plan claims to spend; it is the thing you raise BEFORE spending');
});

test('repair_run says it spends, in the words every other paid tool uses', () => {
    /*
     * The convention is not decoration. An agent deciding whether to call
     * something reads the description, and every generating tool here carries
     * the same phrase — a paid tool that words it differently is one a model
     * can miss.
     */
    const t = byName('repair_run');
    assert.ok(t, 'there is no repair_run tool');
    assert.strictEqual(t.method, 'POST');
    assert.match(t.description, /SPENDS CREDITS/,
        `repair_run does not warn that it spends: ${t.description}`);
});

test('both tools declare the arguments a repair actually needs', () => {
    for (const name of ['repair_plan', 'repair_run']) {
        const t = byName(name);
        for (const arg of ['shot_id', 'start_sec', 'end_sec']) {
            assert.ok(t.schema && t.schema[arg], `${name} does not accept ${arg}`);
        }
        assert.deepStrictEqual(t.required, ['shot_id', 'start_sec', 'end_sec'],
            `${name} does not require the marks; a repair with no range is not a repair`);
    }
});

test('both tools build a path that the router really dispatches', async () => {
    /*
     * LISTED IS NOT CALLABLE. `plate_generate` sat in the registry carrying the
     * shape of a route tool and no run(), so every invocation died before
     * reaching a route — listed, described, schema'd, and never once callable.
     */
    for (const name of ['repair_plan', 'repair_run']) {
        const t = byName(name);
        assert.ok(typeof t.path === 'function', `${name} has no path builder`);
        const built = t.path({ shot_id: 'abc', start_sec: 2, end_sec: 8 });
        assert.match(built, /^\/film\//, `${name} builds a path outside /film: ${built}`);
        assert.ok(t.handler, `${name} names no route handler, so it dispatches to nothing`);
    }
});

test('calling repair_plan through the tool surface reaches the route, not an error', async () => {
    /*
     * Driven through callTool rather than asserted from the registry. A tool
     * whose path is right and whose dispatch is wrong returns a 404 that reads
     * to a model as "this shot has no repair", which is a different claim.
     */
    const out = await callTool('repair_plan', { shot_id: 'no-such-shot', start_sec: 1, end_sec: 6 });
    const text = JSON.stringify(out);
    assert.ok(!/is not a function|Cannot read propert/i.test(text),
        `repair_plan is listed but not callable: ${text.slice(0, 200)}`);
    // A missing shot is a 404 from the route — which proves the route was reached.
    assert.match(text, /not found|no such|refused|shot/i,
        `repair_plan reached something, but not the repair route: ${text.slice(0, 200)}`);
});

/* ── the generator that makes repair_run able to run at all ────────────── */

test('a real generator is wired, so repair_run is not a tool that cannot run', () => {
    /*
     * runRepair takes `generate` as an injected function. Until something
     * supplies a REAL one, every path in this codebase is unable to spend on a
     * repair — and `repair_run` would be listed, callable, and incapable of
     * doing the one thing it names.
     */
    const { repairGenerator } = require('../lib/repair-run');
    assert.strictEqual(typeof repairGenerator, 'function',
        'nothing supplies a real generator, so repair_run cannot execute anything');
});

test('the generator can resolve a real provider, not only an injected one', () => {
    /*
     * WRITTEN AFTER A LIVE RUN FOUND THIS. Every other test here injects a
     * provider, so the real resolution path was never walked — and it was
     * broken: it called `parseProjectConfig`, a name that exists only in a
     * COMMENT in usage-meter.js, so it threw on every real call and the runner
     * reported "no video provider could be resolved". That reads as a
     * configuration problem, not a typo, which is why nothing pointed at it.
     *
     * Asserted against the module's SOURCE rather than by resolving, because
     * resolving needs a real project and credentials — but a name that is not
     * exported can be checked for nothing.
     */
    const conf = require('../lib/provider-config');
    const src = fs.readFileSync(path.join(BACKEND, 'lib', 'repair-run.js'), 'utf8');
    const used = [...src.matchAll(/require\(['"]\.\/provider-config['"]\)/g)].length;
    assert.ok(used >= 1, 'the generator no longer reads a project\'s provider config');
    for (const m of src.matchAll(/const \{ (\w+) \} = require\(['"]\.\/provider-config['"]\)/g)) {
        assert.ok(typeof conf[m[1]] === 'function',
            `repair-run destructures ${m[1]} from provider-config, which does not export it — `
            + `it exports ${Object.keys(conf).join(', ')}`);
    }
});

test('the generator sends the two frames as ORDERED keyframes', async () => {
    /*
     * `images_list` is ordered and the order IS the meaning: [0] the frame it
     * starts on, [1] the frame it ends on. Reversed, the move runs backwards
     * and reads as a model fault rather than a field-order one — which is
     * exactly how it would be reported.
     */
    const { repairGenerator } = require('../lib/repair-run');
    let sent = null;
    const fake = {
        id: 'fake', generate: async (cap, payload) => { sent = payload; return { ok: true, data: Buffer.from('x') }; },
    };
    await repairGenerator({
        images: ['https://x.test/first.png', 'https://x.test/last.png'],
        plan: { generate: { durationSeconds: 6, resolution: '480p' } },
    }, { provider: fake, persist: async () => '/tmp/out.mp4' });

    assert.ok(sent, 'the generator never called the provider');
    const keys = sent.keyframes || sent.images || [];
    assert.strictEqual(keys.length, 2, `expected two keyframes, sent ${keys.length}`);
    const uri = (k) => (typeof k === 'string' ? k : (k.image || k.uri || k.url));
    assert.match(uri(keys[0]), /first/, 'the first keyframe is not the in-mark frame');
    assert.match(uri(keys[1]), /last/, 'the second keyframe is not the out-mark frame');
});

test('a provider refusal comes back as a reason, never a throw', async () => {
    const { repairGenerator } = require('../lib/repair-run');
    const refusing = { id: 'fake', generate: async () => { throw new Error('402 no credits'); } };
    let r;
    await assert.doesNotReject(async () => {
        r = await repairGenerator({ images: ['https://x.test/a.png', 'https://x.test/b.png'],
            plan: { generate: { durationSeconds: 6, resolution: '480p' } } },
        { provider: refusing, persist: async () => '/tmp/out.mp4' });
    }, 'a provider refusal threw out of the generator');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /credits|402|refus/i, `the refusal is not carried through: ${r.reason}`);
});

test('no handler reads shot.project_id without joining the scene', () => {
    /*
     * FOUND BY RUNNING AGAINST A REAL DATABASE, not by reading. `film_shots` has
     * NO project_id — a shot belongs to a scene and the scene to the project —
     * so a bare `SELECT * FROM film_shots` followed by `shot.project_id` reads
     * undefined. It then resolves a media path under a directory literally
     * named "undefined" and fails as a MISSING CLIP, which sends you looking
     * for the footage rather than at the query. Every other handler in
     * approvals.js already joined; the two I added did not.
     *
     * Bound by FUNCTION, never by a character window — the window is the
     * anti-pattern this codebase has paid for four times.
     */
    const { db } = require('../db/database');
    const cols = db.prepare('PRAGMA table_info(film_shots)').all().map(c => c.name);
    assert.ok(!cols.includes('project_id'),
        'film_shots now HAS project_id; this whole check is obsolete and should be deleted');

    const dir = path.join(BACKEND, 'routes');
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const fn of src.split(/\n(?=(?:async )?function )/)) {
            if (!/\bshot\.project_id\b/.test(fn)) continue;
            const q = /db\.prepare\(([\s\S]*?)\)\s*\.get\(/.exec(fn);
            if (!q) continue;                       // the shot came from elsewhere
            if (!/FROM film_shots/i.test(q[1])) continue;
            if (!/JOIN film_scenes/i.test(q[1])) {
                offenders.push(`${f}: ${(/(?:async )?function (\w+)/.exec(fn) || [, '?'])[1]}`);
            }
        }
    }
    assert.deepStrictEqual(offenders, [],
        `these read shot.project_id from a query that never selects it: ${offenders.join(', ')}`);
});

test('no repair tool hands the reasoning back to a server-side LLM', () => {
    /*
     * The agent host IS the model here. A tool that calls a server-side LLM
     * asks the user for a second key to answer a question the connected model
     * has already read, and fails with a billing error the model cannot act on.
     */
    for (const name of ['repair_plan', 'repair_run']) {
        const t = byName(name);
        assert.ok(!/llm|gpt|claude|anthropic/i.test(String(t.description)),
            `${name} mentions a language model; the repair involves no reasoning we should be buying`);
    }
    const run = fs.readFileSync(path.join(BACKEND, 'lib', 'repair-run.js'), 'utf8');
    assert.ok(!/require\(['"][^'"]*llm-client/.test(run),
        'the repair runner reaches a server-side LLM');
});
