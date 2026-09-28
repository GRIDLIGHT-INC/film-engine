/**
 * PGN-001 — every generation is a job row while it runs, and the row can say
 * how far along it is.
 *
 * The Production graph (and later its queue strip) reads ONE place to learn
 * what is running: film_generation_jobs. Until now only async providers wrote a
 * row, and only once the provider handed back an id, so a synchronous image or
 * a voice line was running with nothing on record — the graph could not show
 * it, and a job started by Claude in the MCP process was invisible to the page.
 *
 * Set-based over the REGISTRY: every adapter crossed with every capability it
 * serves (llm excluded — a reasoning call is not a generation a director
 * queues). A rule honoured by the async adapters and forgotten for the sync
 * ones is the partial fix this exists to catch.
 *
 * The collection readers are held too: a synchronous row has no provider
 * handle, so offering it for collect or recovery would promise a result that
 * no provider holds.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-gp-' + crypto.randomUUID().slice(0, 8));

require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const providers = require('../lib/providers');
const jobs = require('../lib/generation-jobs');
const progress = require('../lib/generation-progress');

const PROJECT = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Progress')").run(PROJECT);

const cfg = () => {
    const c = {};
    Object.defineProperty(c, '__project_id', { value: PROJECT, enumerable: false });
    return c;
};
const rows = () => db.prepare('SELECT * FROM film_generation_jobs WHERE project_id = ? ORDER BY created_at, rowid').all(PROJECT);
const clear = () => db.prepare('DELETE FROM film_generation_jobs WHERE project_id = ?').run(PROJECT);

/** Every (adapter, capability) pair that makes something — derived, never typed. */
function pairs() {
    const out = [];
    for (const a of providers.list()) {
        if (typeof a.generate !== 'function') continue;
        for (const cap of a.capabilities || []) if (cap !== 'llm') out.push([a, cap]);
    }
    return out;
}

/** The real adapter with its network call replaced; flags and prototype kept. */
function stubbed(adapter, behaviour) {
    const s = Object.create(adapter);
    s.generate = async (cap, payload, opts) => behaviour(cap, payload, opts || {});
    return s;
}

test('migration 117 gives a job the fields progress needs', () => {
    const cols = new Set(db.prepare('PRAGMA table_info(film_generation_jobs)').all().map(c => c.name));
    for (const c of ['percent', 'phase', 'started_at', 'heartbeat_at', 'collectable']) {
        assert.ok(cols.has(c), `film_generation_jobs has no ${c} column`);
    }
});

test('every adapter x capability: a row exists WHILE the generation runs, and settles after', async () => {
    const all = pairs();
    assert.ok(all.length >= 15, `only ${all.length} generating pairs found — the scan is broken`);
    const missing = [];
    for (const [adapter, cap] of all) {
        clear();
        let seenDuring = null;
        const s = stubbed(adapter, async (c, p, o) => {
            if (adapter.asyncGeneration && typeof o.onHandle === 'function') o.onHandle('req-' + adapter.id + '-' + cap, {});
            seenDuring = rows();
            return { ok: true, data: Buffer.from('x') };
        });
        const wrapped = providers.withJobRecording(s, cap, cfg());
        const r = await wrapped.generate(cap, {}, {});
        assert.ok(r.ok);
        const during = (seenDuring || []);
        const after = rows();
        if (during.length !== 1 || during[0].status !== 'pending' || !during[0].started_at
            || after.length !== 1 || after[0].status !== 'completed') {
            missing.push(`${adapter.id}:${cap} (during ${during.length}, after ${after.map(x => x.status).join(',') || 'none'})`);
        }
    }
    assert.deepEqual(missing, []);
});

test('an async adapter\'s row is the collectable handle; a sync adapter\'s is not', async () => {
    const wrong = [];
    for (const [adapter, cap] of pairs()) {
        clear();
        const s = stubbed(adapter, async (c, p, o) => {
            if (adapter.asyncGeneration && typeof o.onHandle === 'function') o.onHandle('h-' + adapter.id + '-' + cap, {});
            return { ok: true };
        });
        await providers.withJobRecording(s, cap, cfg()).generate(cap, {}, {});
        const [row] = rows();
        const want = adapter.asyncGeneration ? 1 : 0;
        if (!row || row.collectable !== want) wrong.push(`${adapter.id}:${cap} collectable=${row && row.collectable}`);
        if (row && adapter.asyncGeneration && row.request_id !== 'h-' + adapter.id + '-' + cap) wrong.push(`${adapter.id}:${cap} request_id ${row.request_id}`);
    }
    assert.deepEqual(wrong, []);
});

test('a generation that fails or throws settles its row as failed, and a throw still propagates', async () => {
    const [adapter, cap] = pairs().find(([a]) => !a.asyncGeneration);
    clear();
    await providers.withJobRecording(stubbed(adapter, async () => ({ ok: false, error: 'refused' })), cap, cfg()).generate(cap, {}, {});
    assert.equal(rows()[0].status, 'failed');
    assert.match(rows()[0].error, /refused/);
    clear();
    await assert.rejects(providers.withJobRecording(stubbed(adapter, async () => { throw new Error('boom'); }), cap, cfg()).generate(cap, {}, {}), /boom/);
    assert.equal(rows()[0].status, 'failed');
});

test('an async job still running when the call returns pending stays pending and collectable', async () => {
    const [adapter, cap] = pairs().find(([a]) => a.asyncGeneration);
    clear();
    await providers.withJobRecording(stubbed(adapter, async (c, p, o) => { o.onHandle('slow-1', {}); return { ok: false, pending: true }; }), cap, cfg()).generate(cap, {}, {});
    const [row] = rows();
    assert.equal(row.status, 'pending');
    assert.equal(row.collectable, 1);
    assert.equal(jobs.pending(PROJECT).length, 1);
});

test('llm calls are not generations and write no row', async () => {
    const llm = providers.list().find(a => (a.capabilities || []).includes('llm') && typeof a.generate === 'function');
    assert.ok(llm, 'no llm adapter registered');
    clear();
    await providers.withJobRecording(stubbed(llm, async () => ({ ok: true })), 'llm', cfg()).generate('llm', {}, {});
    assert.equal(rows().length, 0);
});

test('a sync row is never offered for collect or recovery', () => {
    clear();
    const running = progress.start({ provider: 'openai', capability: 'image', projectId: PROJECT });
    const failed = progress.start({ provider: 'openai', capability: 'image', projectId: PROJECT });
    jobs.fail(failed, 'x');
    assert.ok(running && failed);
    assert.equal(jobs.pending(PROJECT).length, 0, 'a running sync row was offered for collect');
    assert.equal(jobs.recoverable(PROJECT).length, 0, 'a failed sync row was offered for recovery');
});

test('progress writes are throttled to one a second per job, the latest value is kept, and settle flushes it', () => {
    clear();
    let now = 1_000_000;
    progress._setClock(() => now);
    try {
        const id = progress.start({ provider: 'openai', capability: 'image', projectId: PROJECT });
        assert.equal(progress.report(id, { percent: 10, phase: 'rendering' }), true, 'first report after start should write');
        now += 200;
        assert.equal(progress.report(id, { percent: 20 }), false, 'second report inside the second must not write');
        assert.equal(jobs.get(id).percent, 10);
        now += 900;
        assert.equal(progress.report(id, { percent: 30 }), true);
        assert.equal(jobs.get(id).percent, 30);
        now += 100;
        progress.report(id, { percent: 55, phase: 'decoding' });
        progress.flush(id);
        const row = jobs.get(id);
        assert.equal(row.percent, 55);
        assert.equal(row.phase, 'decoding');
        assert.ok(row.heartbeat_at);
    } finally { progress._setClock(null); }
});

test('bad progress is ignored and nothing throws', () => {
    clear();
    const id = progress.start({ provider: 'openai', capability: 'image', projectId: PROJECT });
    progress._setClock(() => 5_000_000);
    try {
        progress.report(id, { percent: 250 });
        assert.equal(jobs.get(id).percent, 100, 'percent is clamped to 100');
        progress._setClock(() => 7_000_000);
        progress.report(id, { percent: 'abc', phase: 'x'.repeat(500) });
        const row = jobs.get(id);
        assert.equal(row.percent, 100, 'a non-number does not overwrite the last good percent');
        assert.ok(row.phase.length <= 80, 'phase is bounded');
    } finally { progress._setClock(null); }
    assert.doesNotThrow(() => progress.report('no-such-job', { percent: 5 }));
    assert.doesNotThrow(() => progress.report(null, { percent: 5 }));
    assert.equal(progress.start({}), null, 'a start with no provider records nothing');
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
