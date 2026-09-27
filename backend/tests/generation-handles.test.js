/**
 * A generation the host abandons is not lost
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "A tool call through the MCP host is abandoned at sixty seconds. Any
 *  generation still polling at that moment is not slow — it is LOST. The
 *  handler is torn down mid-await, nothing is written to film_assets, and the
 *  caller is told: Device 'my-mac-local' did not respond within 60s.
 *  Which reads like a connection fault. It is not. The provider very likely
 *  finished the job and billed for it; the result had nowhere to be delivered."
 *
 * Measured across every adapter that polls:
 *
 *     meshy        900s   15x over the host window
 *     seedance     900s   15x over
 *     bfl-image    300s    5x over
 *     runway       300s    5x over
 *     muapi-image   48s   under
 *
 * NO TIMEOUT VALUE FIXES THIS, which is the whole point: no budget is both
 * longer than a 4K render and shorter than the abort. Shortening them alone
 * would trade a lost result for a failed one and still burn the money.
 *
 * THE FIX IS A HANDLE. The provider returns an id the moment the job is
 * accepted; persisting THAT before polling means the process can die, the host
 * can abort, and the result is still collectable. The happy path is unchanged —
 * the adapter still polls and still returns bytes — and the recovery path
 * exists only because the id was written down first.
 *
 * The denominator is DERIVED FROM THE SOURCE: any adapter whose generate obtains
 * an id and then sleeps in a loop is an async adapter, and must declare itself
 * one. Two-way, so an adapter that starts polling later is caught, and one that
 * declares it without polling is caught too.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-gh-' + crypto.randomUUID().slice(0, 8));

const PROVIDER_DIR = path.join(__dirname, '..', 'lib', 'providers');
const providers = require('../lib/providers');

/**
 * Adapter id -> the file that defines it, derived by loading each module rather
 * than guessed from the id: `bfl` lives in `bfl-image.js`, and a guessed
 * filename fails with ENOENT, which reads as the adapter being missing.
 */
function sourceById() {
    const map = {};
    for (const file of fs.readdirSync(PROVIDER_DIR).filter(f => f.endsWith('.js'))) {
        if (['index.js', 'base.js', 'credentials.js', 'oauth.js'].includes(file)) continue;
        let mod;
        try { mod = require(path.join(PROVIDER_DIR, file)); } catch (_) { continue; }
        const a = mod && (mod.adapter || mod.default);
        if (a && a.id) map[a.id] = { file, src: fs.readFileSync(path.join(PROVIDER_DIR, file), 'utf8') };
    }
    return map;
}


/** The body of a named function in this source, by brace matching. */
function bodyOf(src, header) {
    const m = header.exec(src);
    if (!m) return null;
    let depth = 0, started = false;
    for (let i = m.index; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') { depth--; if (started && depth === 0) return src.slice(m.index, i + 1); }
    }
    return null;
}

/**
 * The generate PATH, following one call level.
 *
 * meshy's generate delegates the whole submit-and-poll to `run(payload, ...,
 * opts, capability)`, so its own body mentions neither the budget nor the
 * handle -- and reading it alone reports a correct adapter as broken. One
 * level, not an unbounded walk: the rule manual-edit and screenplay-mutators
 * already follow.
 */
function generateBody(src) {
    let body = bodyOf(src, /(?:async function generate\s*\(|async generate\s*\()/);
    if (!body) return null;
    for (const call of body.matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\([^)]*\bopts\b/g)) {
        const inner = bodyOf(src, new RegExp(`(?:async function|function)\\s+${call[1]}\\s*\\(`));
        if (inner) body += '\n' + inner;
    }
    return body;
}

/** Adapters whose source shows a poll loop: a sleep inside a bounded repeat. */
function pollingModules() {
    const out = [];
    for (const file of fs.readdirSync(PROVIDER_DIR).filter(f => f.endsWith('.js'))) {
        if (['index.js', 'base.js', 'credentials.js', 'oauth.js'].includes(file)) continue;
        const src = fs.readFileSync(path.join(PROVIDER_DIR, file), 'utf8');
        const sleeps = /await sleep\(|await new Promise\(r => setTimeout/.test(src);
        const loops = /for \(|while \(/.test(src);
        const polls = /POLL_|pollTask|pollResult|awaitResult|polling_url/.test(src);
        if (sleeps && loops && polls) out.push({ file, src });
    }
    return out;
}

test('the polling adapters are found, and there are several', () => {
    const found = pollingModules();
    assert.ok(found.length >= 4,
        `expected the async adapters to be discovered from source, found ${found.length}: `
        + found.map(f => f.file).join(', '));
});

test('every adapter that polls declares itself async, and only those do', () => {
    const polling = new Set(pollingModules().map(f => f.file.replace(/\.js$/, '')));
    const wrong = [];
    for (const a of providers.list()) {
        const declared = !!a.asyncGeneration;
        // Which module is this adapter? Its id is not always its filename.
        const mod = [...polling].find(m => m === a.id || m.startsWith(a.id) || a.id.startsWith(m.split('-')[0]));
        const pollsInSource = !!mod;
        if (pollsInSource && !declared) {
            wrong.push(`${a.id}: polls a provider and does not declare asyncGeneration — a torn-down call loses the result`);
        }
        if (declared && !pollsInSource) {
            wrong.push(`${a.id}: declares asyncGeneration and its source shows no poll loop`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

const asyncAdapters = () => providers.list().filter(a => a.asyncGeneration);

test('every async adapter can be told how long it may wait', () => {
    /*
     * The budget belongs to the CALLER, not the adapter: an HTTP request can
     * wait fifteen minutes for a 4K mesh, and a tool call through the host has
     * sixty seconds whatever the adapter would prefer. An adapter with a
     * hardcoded budget cannot be run safely from both.
     */
    const byId = sourceById();
    const missing = [];
    for (const a of asyncAdapters()) {
        const entry = byId[a.id];
        assert.ok(entry, `${a.id}: could not find the module that defines it`);
        /*
         * SCOPED TO GENERATE. `collect()` computes a budget too, by design, so
         * a file-wide search is satisfied by the recovery path while the path
         * that actually spends ignores the host window -- proven by mutation.
         */
        const body = generateBody(entry.src) || entry.src;
        if (!/opts\.timeout/.test(body)) {
            missing.push(`${a.id}: generate ignores opts.timeout, so a caller cannot bound it`);
        }
        if (!/budgetFor\(/.test(body)) {
            missing.push(`${a.id}: generate does not pass its budget through budgetFor, so the host window is ignored`);
        }
    }
    assert.deepStrictEqual(missing, [], missing.join('\n  '));
});

test('every async adapter reports its handle the moment the provider accepts', () => {
    /*
     * `onHandle` is called with the provider's own id BEFORE polling starts.
     * That ordering is the entire feature: a handle recorded after the poll is
     * a handle that is never recorded on exactly the calls that need it.
     */
    const byId = sourceById();
    const missing = [];
    for (const a of asyncAdapters()) {
        const entry = byId[a.id];
        assert.ok(entry, `${a.id}: could not find the module that defines it`);
        /*
         * A CALL, not the guard beside it. `typeof opts.onHandle === 'function'`
         * matches a bare mention, so deleting the invocation and leaving the
         * check survived -- the adapter would guard a callback it never calls.
         */
        if (!/opts\.onHandle\s*\(/.test(entry.src)) {
            missing.push(`${a.id}: never CALLS onHandle, so an abandoned call cannot be collected`);
        }
        /*
         * ORDERING, WITHIN THE GENERATE PATH ONLY.
         *
         * The handle must be reported BEFORE the poll begins -- one written
         * after the wait is never written on precisely the calls that need it.
         * Scoped to generate's own body because `collect()` polls too, by
         * design, and it sits above `generate` in some adapters: a file-wide
         * position compare reported Runway as broken when it was correct.
         */
        const body = generateBody(entry.src);
        if (body) {
            const at = body.indexOf('opts.onHandle');
            const poll = body.search(/await (pollTask|pollResult|awaitResult)\(/);
            if (at >= 0 && poll >= 0 && at > poll) {
                missing.push(`${a.id}: reports its handle AFTER polling, which is too late to help`);
            }
        }
    }
    assert.deepStrictEqual(missing, [], missing.join('\n  '));
});

// ---------------------------------------------------------------------------
// The store, and the recovery it exists for
// ---------------------------------------------------------------------------

test('a handle survives the process that created it', () => {
    const jobs = require('../lib/generation-jobs');
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();

    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))`).run(pid, 'handle probe');

    const id = jobs.record({
        provider: 'seedance', capability: 'video', requestId: 'req-abc-123',
        projectId: pid, shotId: null, sceneId: null,
    });
    assert.ok(id, 'recording a handle returned nothing');

    const open = jobs.pending(pid);
    assert.strictEqual(open.length, 1, `expected one pending job, saw ${open.length}`);
    assert.strictEqual(open[0].request_id, 'req-abc-123');
    assert.strictEqual(open[0].provider, 'seedance');
    assert.strictEqual(open[0].status, 'pending');
});

test('a completed handle stops being offered for collection', () => {
    const jobs = require('../lib/generation-jobs');
    const { db, generateId } = require('../db/database');
    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))`).run(pid, 'handle probe 2');

    const id = jobs.record({ provider: 'muapi', capability: 'image', requestId: 'r1', projectId: pid });
    jobs.complete(id, { assetId: null });
    assert.strictEqual(jobs.pending(pid).length, 0, 'a completed job is still offered for collection');

    const id2 = jobs.record({ provider: 'muapi', capability: 'image', requestId: 'r2', projectId: pid });
    jobs.fail(id2, 'the provider refused');
    assert.strictEqual(jobs.pending(pid).length, 0, 'a failed job is still offered for collection');
});

test('the same provider request is one handle, however often it is recorded', () => {
    /*
     * A retry that re-submits gets a NEW provider id and deserves its own row.
     * The same id recorded twice is the same job, and two rows for one request
     * would offer a collect that has already happened -- which on a paid
     * generation means delivering it, and being asked to deliver it again.
     */
    const jobs = require('../lib/generation-jobs');
    const { db, generateId } = require('../db/database');
    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))`).run(pid, 'dedupe probe');

    const a = jobs.record({ provider: 'runway', capability: 'video', requestId: 'same-id', projectId: pid });
    const b = jobs.record({ provider: 'runway', capability: 'video', requestId: 'same-id', projectId: pid });
    assert.ok(a, 'the first record returned nothing');
    assert.strictEqual(b, a, 'recording the same provider request twice produced a second handle');
    assert.strictEqual(jobs.pending(pid).length, 1,
        `one provider request produced ${jobs.pending(pid).length} collectable jobs`);

    // A genuinely different request is a different job.
    const c = jobs.record({ provider: 'runway', capability: 'video', requestId: 'other-id', projectId: pid });
    assert.notStrictEqual(c, a, 'two different provider requests collapsed into one handle');
    assert.strictEqual(jobs.pending(pid).length, 2, 'a second distinct request was not recorded');
});

test('recording a handle never throws, whatever it is handed', () => {
    /*
     * The rule stampAsset already documents: by the time this runs the request
     * has been made and the money is gone. Turning a paid, accepted generation
     * into an error because the bookkeeping failed is the worst trade
     * available.
     */
    const jobs = require('../lib/generation-jobs');
    assert.doesNotThrow(() => jobs.record({}));
    assert.doesNotThrow(() => jobs.record(null));
    assert.doesNotThrow(() => jobs.record({ provider: 'nope', requestId: 'x', projectId: 'not-a-project' }));
});

// ---------------------------------------------------------------------------
// The host window
// ---------------------------------------------------------------------------

test('a budget is only imposed where a host actually aborts', () => {
    const jobs = require('../lib/generation-jobs');
    const before = process.env.FILM_HOST_ABORT_MS;
    try {
        delete process.env.FILM_HOST_ABORT_MS;
        assert.strictEqual(jobs.budgetFor(900000), 900000,
            'an HTTP caller had its budget cut — nothing aborts it, and a 4K mesh legitimately takes minutes');

        process.env.FILM_HOST_ABORT_MS = '60000';
        const bounded = jobs.budgetFor(900000);
        assert.ok(bounded < 60000,
            `under a 60s host abort the budget must finish first, got ${bounded}ms`);
        assert.ok(bounded > 20000,
            `the budget collapsed to ${bounded}ms — most generations would never get a chance`);

        assert.strictEqual(jobs.budgetFor(10000), 10000,
            'a budget already shorter than the window was lengthened');
    } finally {
        if (before === undefined) delete process.env.FILM_HOST_ABORT_MS;
        else process.env.FILM_HOST_ABORT_MS = before;
    }
});

test('the MCP server declares the window; the HTTP server does not', () => {
    const mcp = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf8');
    assert.match(mcp, /FILM_HOST_ABORT_MS/,
        'the MCP server does not declare the host abort window, so nothing bounds a tool call');
    const httpSrv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(!/FILM_HOST_ABORT_MS\s*=/.test(httpSrv),
        'the HTTP server sets a host abort window — a browser request is not abandoned at 60s');
});

test('a timed-out generation is recoverable, and says so', () => {
    /*
     * The reported symptom was "the device did not respond", which reads as a
     * connection fault. A timeout that names its handle is the difference
     * between a lost render and one waiting to be collected.
     */
    const jobs = require('../lib/generation-jobs');
    const out = jobs.timedOut({ provider: 'seedance', jobId: 'job-1', requestId: 'req-9', waitedMs: 45000 });
    assert.strictEqual(out.ok, false, 'a timeout must not be reported as a success');
    assert.ok(out.pending, 'a timeout that is collectable must say it is still running');
    assert.match(String(out.error), /job-1|collect/i,
        `the timeout does not name the handle or the way to collect it: ${out.error}`);
});

// ---------------------------------------------------------------------------
// The whole loop: abandoned, recorded, collected
// ---------------------------------------------------------------------------

test('an abandoned generation is recorded and can be collected afterwards', async () => {
    /*
     * The behaviour every other check here is in service of, end to end,
     * against a stub provider so nothing is spent.
     *
     * The stub does exactly what the real ones do: accept the job, report the
     * handle, then fail to finish inside the budget. What must survive that is
     * a row naming the provider's own id -- and a later collect must deliver
     * the result the provider had all along.
     */
    const providers = require('../lib/providers');
    const jobs = require('../lib/generation-jobs');
    const { db, generateId } = require('../db/database');

    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))`).run(pid, 'abandon probe');

    let finished = false;
    const stub = {
        id: 'stub-async', kind: 'generator', label: 'Stub', requiresKey: false,
        capabilities: ['image'], asyncGeneration: true,
        supports: c => c === 'image',
        async generate(capability, payload, opts) {
            // The provider accepts and hands back its id.
            if (opts && opts.onHandle) opts.onHandle('stub-req-1', { capability });
            if (!finished) {
                // Still running when the caller's budget ran out.
                return opts && opts.onTimeout
                    ? opts.onTimeout('stub-req-1', 45000)
                    : { ok: false, status: 504, error: 'timed out' };
            }
            return { ok: true, data: Buffer.from('finished'), provider: 'stub-async' };
        },
        async collect(requestId) {
            if (!finished) return { ok: false, status: 504, pending: true, error: 'still running' };
            return { ok: true, data: Buffer.from('collected bytes'), provider: 'stub-async' };
        },
    };
    providers.register(stub);

    const adapter = providers.resolve('image', { image: 'stub-async', __project_id: pid });
    assert.strictEqual(adapter.id, 'stub-async', 'the stub did not resolve');

    // 1. The call is abandoned.
    const first = await adapter.generate('image', { prompt: 'x' }, {});
    assert.strictEqual(first.ok, false, 'the abandoned call reported success');
    assert.ok(first.pending, 'an abandoned call must report itself as still running, not as a failure');

    // 2. And the handle survived it.
    const open = jobs.pending(pid);
    assert.strictEqual(open.length, 1,
        `the abandoned generation left ${open.length} collectable handles — it is lost`);
    assert.strictEqual(open[0].request_id, 'stub-req-1');
    const jobId = open[0].id;

    // 3. Collecting while it is still running is safe and changes nothing.
    const early = await jobs.collect(jobId, {});
    assert.strictEqual(early.ok, false, 'collecting an unfinished job reported success');
    assert.ok(early.pending, 'collecting an unfinished job must say it is still running');
    assert.strictEqual(jobs.pending(pid).length, 1,
        'an unfinished collect settled the job — it can never be collected again');

    // 4. The provider finishes, and the result is delivered.
    finished = true;
    const got = await jobs.collect(jobId, {});
    assert.strictEqual(got.ok, true, `collecting the finished job failed: ${got.error}`);
    assert.strictEqual(jobs.pending(pid).length, 0,
        'a delivered job is still being offered for collection — it would be delivered twice');
});
