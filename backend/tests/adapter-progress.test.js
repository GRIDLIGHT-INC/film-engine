/**
 * PGN-002 — adapters report what they can.
 *
 * Every generating adapter DECLARES what progress it can give:
 *   percent — a percentage when the provider sends one, and a phase
 *   phase   — a phase ("queued", "generating") but no percentage
 *   none    — nothing: a synchronous call that returns when it is done
 *
 * and a declaration is only believed if it is TRUE: every adapter claiming
 * percent or phase is run here against a stubbed network, through the same
 * resolve() funnel a route uses, and must leave progress on its job row. The
 * fixture table is held equal to the set of claiming adapters, so an adapter
 * that starts claiming progress later cannot do so without being proven.
 *
 * "Unknown" is not "0": a provider that sends no percentage leaves the percent
 * NULL, and the graph will say so rather than draw an empty bar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-ap-' + crypto.randomUUID().slice(0, 8));
// Poll fast: the throttle and the intervals are about time, and a test must not wait for them.
for (const k of ['RUNWAY_POLL_INTERVAL_MS', 'BFL_POLL_INTERVAL_MS', 'SEEDANCE_POLL_INTERVAL_MS',
    'MUAPI_POLL_MS', 'MESHY_POLL_INTERVAL_MS', 'WORLDLABS_POLL_MS']) process.env[k] = '5';
for (const k of ['RUNWAY_API_KEY', 'BFL_API_KEY', 'MUAPI_API_KEY', 'SEEDANCE_API_KEY', 'MESHY_API_KEY', 'WORLDLABS_API_KEY']) process.env[k] = 'test-key-123456';

require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const providers = require('../lib/providers');

const PROJECT = generateId();
process.env.TOPAZ_API_KEY = process.env.TOPAZ_API_KEY || 'test-key-123456';
process.env.TOPAZ_POLL_INTERVAL_MS = '5';
process.env.MAGNIFIC_API_KEY = process.env.MAGNIFIC_API_KEY || 'test-key-123456';
process.env.MAGNIFIC_POLL_INTERVAL_MS = '5';
process.env.HF_CREDENTIALS = process.env.HF_CREDENTIALS || 'test-key-id:test-key-secret';
process.env.HIGGSFIELD_POLL_INTERVAL_MS = '5';
const TOPAZ_CLIP = path.join(process.env.FILM_DATA_DIR || os.tmpdir(), 'topaz-progress-clip.mp4');
fs.mkdirSync(path.dirname(TOPAZ_CLIP), { recursive: true });
fs.writeFileSync(TOPAZ_CLIP, Buffer.alloc(2048, 1));
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Adapter progress')").run(PROJECT);
const cfg = () => { const c = {}; Object.defineProperty(c, '__project_id', { value: PROJECT, enumerable: false }); return c; };
const lastRow = () => db.prepare('SELECT * FROM film_generation_jobs WHERE project_id = ? ORDER BY rowid DESC LIMIT 1').get(PROJECT);

const LEVELS = ['percent', 'phase', 'none'];
const generating = () => providers.list().filter(a => typeof a.generate === 'function'
    && (a.capabilities || []).some(c => c !== 'llm'));

/**
 * One fixture per adapter that claims progress: which capability to call, the
 * payload, and how its API answers a poll — once still running (with a
 * percentage where the provider sends one), then finished with a failure so
 * the test ends without fetching media. The progress is what is under test.
 */
const RUNNING = {
    runway: { status: 'RUNNING', progress: 0.5 },
    muapi: { status: 'processing', progress: 50 },
    seedance: { status: 'processing', progress: 50 },
    meshy: { status: 'IN_PROGRESS', progress: 50 },
    worldlabs: { done: false, metadata: { progress: 0.5 } },
    topaz: { status: 'processing', progress: 50 },
    magnific: { data: { task_id: 't1', status: 'IN_PROGRESS' } },
    higgsfield: { status: 'in_progress', request_id: 't1' },
};
const FINISHED = {
    runway: { status: 'FAILED', failure: 'stub' },
    muapi: { status: 'failed', error: 'stub' },
    seedance: { status: 'failed', error: 'stub' },
    meshy: { status: 'FAILED', task_error: { message: 'stub' } },
    worldlabs: { done: true, error: { message: 'stub' } },
    topaz: { status: 'failed', message: 'stub' },
    magnific: { data: { task_id: 't1', status: 'FAILED' } },
    higgsfield: { status: 'failed', request_id: 't1', error: 'stub' },
};
const FIXTURES = {
    runway: { cap: 'video', payload: { prompt: 'a quiet street at dusk', init_image: 'data:image/png;base64,iVBORw0KGgo=', duration: 5 } },
    muapi: { cap: 'image', payload: { prompt: 'a quiet street at dusk' } },
    seedance: { cap: 'video', payload: { prompt: 'a quiet street at dusk', init_image: 'https://example.com/a.png', duration: 5 } },
    meshy: { cap: 'model3d', payload: { prompt: 'a wooden chair', refine: false } },
    worldlabs: { cap: 'world', payload: { prompt: 'a quiet street', images: [] } },
    gridlight: { cap: 'video', payload: { prompt: 'a quiet street at dusk' } },
    // Topaz uploads the clip itself, so the fixture is a real file on disk and
    // the measured facts the upscale route would hand it.
    topaz: { cap: 'post', payload: { model: 'slp-2.6', source_video: TOPAZ_CLIP, source_width: 1280, source_height: 720,
        source_seconds: 2, source_fps: 24, target_resolution: '1920x1080' } },
    magnific: { cap: 'post', payload: { model: 'magnific-video-upscaler-precision', source_video: TOPAZ_CLIP,
        source_seconds: 2, source_fps: 24, target_resolution: '1920x1080' } },
    higgsfield: { cap: 'video', payload: { model: 'seedance-2-5', prompt: 'a quiet street at dusk', init_image: 'https://example.com/a.png', duration: 5 } },
};

function stubFetch(id) {
    let polls = 0;
    return async (url, init) => {
        const method = (init && init.method) || 'GET';
        const json = body => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/json']]),
            json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.from(JSON.stringify(body)) });
        if (method !== 'GET') {
            return json({ id: 't1', request_id: 't1', result: 't1', polling_url: 'https://poll.example/t1',
                operation_id: 'op1', done: false, requestId: 't1', urls: ['https://upload.example/t1'], uploadId: 'u1',
                data: { task_id: 't1', status: 'CREATED' }, files: [{ upload_url: 'https://upload.example/m1', asset_url: 'https://asset.example/m1' }] });
        }
        polls += 1;
        return json(polls === 1 ? RUNNING[id] : FINISHED[id]);
    };
}

test('every generating adapter declares what progress it can give', () => {
    const bad = generating().filter(a => !LEVELS.includes(a.reportsProgress)).map(a => `${a.id}=${a.reportsProgress}`);
    assert.deepEqual(bad, []);
});

test('the fixture table is exactly the adapters that claim progress', () => {
    const claiming = generating().filter(a => a.reportsProgress !== 'none').map(a => a.id).sort();
    assert.ok(claiming.length >= 5, `only ${claiming.length} adapters claim progress`);
    assert.deepEqual(Object.keys(FIXTURES).sort(), claiming);
});

test('every adapter that claims progress writes it to its job row, through resolve()', async () => {
    const realFetch = globalThis.fetch;
    const gv = require('../lib/gridlight-video');
    const realGv = gv.generateVideo;
    const failures = [];
    try {
        for (const a of generating().filter(x => x.reportsProgress !== 'none')) {
            const fx = FIXTURES[a.id];
            if (!fx) { failures.push(`${a.id}: no fixture`); continue; }
            globalThis.fetch = stubFetch(a.id);
            if (a.id === 'gridlight') {
                gv.generateVideo = async (payload, opts) => {
                    opts.onEvent({ event: 'loading_model', phase: 'warming up' });
                    opts.onEvent({ event: 'progress', phase: 'generating', step: 5, total: 10 });
                    return { ok: false, status: 502, error: 'stub' };
                };
            }
            try {
                await providers.withJobRecording(a, fx.cap, cfg()).generate(fx.cap, fx.payload, { timeout: 5000 });
            } catch (e) { failures.push(`${a.id}: threw ${e.message}`); continue; }
            const row = lastRow();
            if (!row || !row.phase || row.phase === 'running') { failures.push(`${a.id}: no phase recorded (${row && row.phase})`); continue; }
            if (a.reportsProgress === 'percent' && !(row.percent > 0)) failures.push(`${a.id}: claims percent, recorded ${row.percent}`);
            if (a.reportsProgress === 'phase' && row.percent !== null && row.percent !== undefined && row.percent !== 50) {
                failures.push(`${a.id}: invented a percent ${row.percent}`);
            }
        }
    } finally { globalThis.fetch = realFetch; gv.generateVideo = realGv; }
    assert.deepEqual(failures, []);
});

test('a caller\'s onProgress that throws never fails the generation, and still receives events', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubFetch('runway');
    const got = [];
    try {
        const runway = providers.get('runway');
        const r = await providers.withJobRecording(runway, 'video', cfg()).generate('video', FIXTURES.runway.payload,
            { timeout: 5000, onProgress: e => { got.push(e); throw new Error('painter broke'); } });
        assert.equal(r.ok, false, 'the stubbed task fails; it must fail on its own terms, not the callback');
        assert.match(String(r.error), /runway/);
        assert.ok(got.length >= 1, 'the caller still received progress');
        assert.ok(got.every(e => e && typeof e === 'object'), 'events are objects');
    } finally { globalThis.fetch = realFetch; }
});

test('pollPercent reads the shapes providers use and invents nothing', () => {
    const { pollPercent } = require('../lib/generation-progress');
    assert.equal(pollPercent({ progress: 0.5 }), 50);
    assert.equal(pollPercent({ progress: 42 }), 42);
    assert.equal(pollPercent({ progress_percent: 7 }), 7);
    assert.equal(pollPercent({ metadata: { progress: 0.25 } }), 25);
    assert.equal(pollPercent({ status: 'running' }), undefined);
    assert.equal(pollPercent({ progress: null }), undefined);
    assert.equal(pollPercent(null), undefined);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
