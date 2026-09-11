const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

/**
 * ONE PARENT, ORDERED CHILDREN, AND A PARENT THAT CANNOT LIE.
 *
 * MUS-013. A generation or a separation is one PARENT operation with one CHILD
 * per output, in order: each child carries its provider, model and job id,
 * its cost, which attempt it belongs to, the fingerprints of what it was made
 * from, its take number, and an acceptance state read from the take itself.
 *
 * The rule the whole task exists for: a failed child cannot leave a parent
 * looking complete. So the parent's status is DERIVED from its children and
 * the test is a truth table over every combination of child states, not a
 * handful of examples — a rollup that gets "two done, one failed" right and
 * "all done, one missing" wrong passes any example written against the first.
 *
 * And a job must be resumable: a run whose process is gone is found by
 * polling, reported as interrupted rather than left "running" for ever, and
 * retried as a new attempt that names the one it retries.
 */

delete process.env.ELEVENLABS_API_KEY;
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-jobs-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const jobs = require('../lib/music-jobs');
const gen = require('../lib/music-generation');
const sep = require('../lib/music-separation');
const contracts = require('../lib/music-session');
const route = require('../routes/music-sessions');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');
const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');

const bin = () => resolveFfmpeg().bin;
function toneBytes(hz, seconds) {
    const p = path.join(os.tmpdir(), `jobs_${generateId().slice(0, 8)}.wav`);
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=44100`, '-ac', '2', '-c:a', 'pcm_s16le', p], { stdio: 'pipe', timeout: 120000 });
    const b = fs.readFileSync(p); fs.unlinkSync(p); return b;
}
function crc32(buf) {
    let c, crc = 0xFFFFFFFF;
    for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
function zipOf(entries) {
    const locals = [], centrals = []; let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name); const crc = crc32(e.bytes);
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.bytes.length, 18); lh.writeUInt32LE(e.bytes.length, 22); lh.writeUInt16LE(name.length, 26);
        const local = Buffer.concat([lh, name, e.bytes]);
        const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.bytes.length, 20); ch.writeUInt32LE(e.bytes.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([ch, name])); locals.push(local); offset += local.length;
    }
    const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}
void zlib;

const FULL = {
    music_compose: { status: 'available', models: ['m1'], limits: { min_ms: 3000, max_ms: 600000, models: ['m1'] }, source: 'test' },
    music_parts: { status: 'available', limits: { max_parts: 4, part_roles: ['strings', 'drums', 'bass', 'piano'] }, source: 'test' },
    music_separate: { status: 'unsupported', reason: 'this fake provider does not separate recordings' },
    music_reference: { status: 'available', limits: { reference_kinds: ['audio', 'melody'], max_reference_ms: 60000 }, source: 'test' },
    music_video: { status: 'available', limits: { max_video_ms: 600000, video_formats: ['mp4'] }, source: 'test' },
    music_inpaint: { status: 'available', limits: { max_range_ms: 30000, context_ms: 5000 }, source: 'test' },
};
function fake(o) {
    const opts = o || {};
    let n = 0;
    return {
        id: 'fakemusic', capabilities: ['music'], music: FULL,
        async generate(cap, payload) {
            n++;
            if (opts.fail) return { ok: false, status: 500, error: 'fakemusic 500: the composer is out' };
            if (payload.workflow === 'music_parts') {
                return { ok: true, provider_model: 'm1', provider_job_id: `job-${n}`, parts: payload.parts.map((p, i) => ({ role: p, data: opts.badPart === i ? Buffer.from('words, not audio') : toneBytes(220 + i * 110, 2) })) };
            }
            return { ok: true, data: toneBytes(330, 3), provider_model: 'm1', provider_job_id: `job-${n}` };
        },
    };
}

function film() {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, provider_config) VALUES (?, 'Jobs', ?)").run(projectId, JSON.stringify({ music: 'elevenlabs' }));
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, name, tempo_map_json) VALUES (?, ?, 'S', ?)").run(sessionId, projectId, JSON.stringify([{ at_ms: 0, bpm: 100, numerator: 4, denominator: 4 }]));
    db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, valence, arousal, intensity, source, status) VALUES (?, ?, 0, 12000, 'dread', -0.5, 0.4, 0.5, 'director', 'accepted')").run(generateId(), sessionId);
    const dir = path.join(DATA_DIR, 'music', projectId); fs.mkdirSync(dir, { recursive: true });
    const bytes = toneBytes(440, 4);
    const file = path.join(dir, `src_${generateId().slice(0, 6)}.wav`); fs.writeFileSync(file, bytes);
    const assetId = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata) VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 4000, '{}')").run(assetId, projectId, file, path.basename(file));
    const trackId = generateId();
    db.prepare("INSERT INTO film_music_tracks (id, session_id, name, role) VALUES (?, ?, 'score', 'score')").run(trackId, sessionId);
    const clipId = generateId();
    db.prepare("INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, source_offset_ms, take_status) VALUES (?, ?, ?, 'first', 'generated', 0, 4000, 0, 'selected')").run(clipId, trackId, assetId);
    return { projectId, sessionId, trackId, clipId, assetId, bytes };
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// ── The schema and the contract ───────────────────────────────────────────

test('an operation can be a child: group, order, attempt, take number, output clip and both fingerprints are columns, and the contract writes them', () => {
    const cols = db.prepare('PRAGMA table_info(film_music_operations)').all().map(c => c.name);
    for (const c of jobs.CHILD_COLUMNS) assert.ok(cols.includes(c), `film_music_operations has no ${c}`);
    const v = contracts.VALIDATORS.film_music_operations({ kind: 'generate', status: 'running', group_id: 'P', seq: 2, attempt: 3, take_number: 4, output_clip_id: 'C', source_fingerprint: 'sf', context_fingerprint: 'cf' });
    assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
    const row = contracts.toRow('film_music_operations', v.value);
    for (const c of jobs.CHILD_COLUMNS) assert.ok(c in row, `the contract drops ${c}`);
    for (const [field, bad] of [['seq', -1], ['attempt', 0], ['take_number', 0]]) {
        assert.strictEqual(contracts.VALIDATORS.film_music_operations({ kind: 'generate', [field]: bad }).ok, false, `${field}=${bad} was accepted`);
    }
    const fks = db.prepare('PRAGMA foreign_key_list(film_music_operations)').all();
    assert.ok(fks.some(f => f.from === 'group_id' && f.table === 'film_music_operations' && f.on_delete === 'CASCADE'), 'a child does not go with its parent');
    assert.ok(fks.some(f => f.from === 'output_clip_id' && f.on_delete === 'SET NULL'), 'deleting a take would delete its history');
});

// ── The rollup, as a truth table ──────────────────────────────────────────

test('a parent is complete only when every expected child is complete: the whole truth table over child states and counts', () => {
    const STATES = contracts.VOCABULARY['film_music_operations.status'];
    const combos = [[]];
    for (let size = 1; size <= 3; size++) {
        const next = [];
        for (const c of combos.filter(x => x.length === size - 1)) for (const s of STATES) next.push([...c, s]);
        combos.push(...next);
    }
    let checked = 0;
    for (const children of combos) {
        for (const expected of [null, 1, 2, 3]) {
            const got = jobs.deriveStatus(children.map((status, seq) => ({ status, seq })), expected);
            const allDone = children.length > 0 && children.every(s => s === 'complete') && (expected == null || children.length >= expected);
            const anyOpen = children.some(s => s === 'planned' || s === 'running');
            const anyBad = children.some(s => s === 'failed' || s === 'cancelled');
            const want = allDone ? 'complete' : anyOpen ? 'running' : 'failed';
            assert.strictEqual(got.status, want, `children [${children}] expected ${expected}: ${got.status}, want ${want}`);
            if (want === 'failed') assert.ok(got.reason && got.reason.length > 10, `children [${children}] failed with no reason`);
            if (anyBad && want === 'failed') assert.match(got.reason, /#\d|child|missing|no outputs/i);
            checked++;
        }
    }
    assert.ok(checked > 300, `only ${checked} cases`);
});

test('a parent stored as complete over a failed child reads as failed, is flagged, and the rollup repairs it', () => {
    const f = film();
    const parent = jobs.openJob(db, f.sessionId, { kind: 'generate', provider: 'fakemusic', params: { workflow: 'music_compose' }, expected: 2 });
    const a = jobs.addChild(db, parent, { seq: 0, label: 'a' });
    const b = jobs.addChild(db, parent, { seq: 1, label: 'b' });
    jobs.settleChild(db, a, { status: 'complete', cost_usd: 0.01 });
    jobs.settleChild(db, b, { status: 'failed', error: 'the second part was not audio' });
    db.prepare("UPDATE film_music_operations SET status = 'complete' WHERE id = ?").run(parent);
    const read = jobs.readJob(db, f.sessionId, parent);
    assert.strictEqual(read.status, 'failed', 'a stored "complete" was believed over a failed child');
    assert.strictEqual(read.consistent, false);
    assert.match(read.reason, /#1|b/);
    jobs.rollup(db, parent);
    assert.strictEqual(db.prepare('SELECT status FROM film_music_operations WHERE id = ?').get(parent).status, 'failed');
    assert.strictEqual(jobs.readJob(db, f.sessionId, parent).consistent, true);
});

// ── Real runs carry the lineage ───────────────────────────────────────────

test('every generating workflow records one parent and ordered children with provider, model, job id, cost, attempt, fingerprints, take numbers and acceptance', async () => {
    const INPUT = {
        music_compose: f => ({ prompt: 'x', duration_ms: 12000, track_id: f.trackId }),
        music_parts: f => ({ prompt: 'x', parts: ['strings', 'drums', 'bass'], duration_ms: 12000 }),
        music_reference: f => ({ prompt: 'x', reference_asset_id: f.assetId, reference_kind: 'audio', duration_ms: 12000 }),
        music_video: null,
        music_inpaint: f => ({ clip_id: f.clipId, range: { start_ms: 500, end_ms: 3500 }, prompt: 'x' }),
    };
    for (const wf of gen.GENERATE_WORKFLOWS) {
        if (!INPUT[wf]) continue; // picture conditioning is covered by the generation suite; its lineage is the same code path
        const f = film();
        const out = await gen.generate(db, f.sessionId, wf, INPUT[wf](f), { adapter: fake() });
        assert.strictEqual(out.ok, true, `${wf}: ${out.error}`);
        const job = jobs.readJob(db, f.sessionId, out.operation_id);
        assert.strictEqual(job.status, 'complete');
        assert.strictEqual(job.consistent, true);
        assert.strictEqual(job.attempt, 1);
        assert.strictEqual(job.children.length, out.outputs.length, `${wf}: children and outputs disagree`);
        assert.deepStrictEqual(job.children.map(c => c.seq), job.children.map((_, i) => i), `${wf}: children are not in order`);
        let cost = 0;
        for (const [i, c] of job.children.entries()) {
            assert.strictEqual(c.status, 'complete');
            assert.strictEqual(c.provider, 'fakemusic');
            assert.strictEqual(c.model, 'm1');
            assert.ok(c.job_ref, `${wf}: child ${i} has no provider job id`);
            assert.strictEqual(c.output_asset_id, out.outputs[i].asset_id);
            assert.strictEqual(c.output_clip_id, out.outputs[i].clip_id);
            assert.ok(c.context_fingerprint, `${wf}: child ${i} has no context fingerprint`);
            assert.ok(Number.isInteger(c.take_number) && c.take_number >= 1);
            assert.ok(['pending', 'accepted'].includes(c.acceptance));
            cost += c.cost_usd;
        }
        assert.ok(Math.abs(cost - job.cost_usd) < 1e-9, `${wf}: the parent's cost is not its children's`);
        if (wf === 'music_reference' || wf === 'music_inpaint') assert.strictEqual(job.children[0].source_fingerprint, sha(f.bytes), `${wf}: the source is not fingerprinted`);
        if (wf === 'music_compose' || wf === 'music_inpaint') {
            // A second take on an occupied track is take 2, and pending until chosen.
            assert.strictEqual(job.children[0].take_number, 2);
            assert.strictEqual(job.children[0].acceptance, 'pending');
            db.prepare("UPDATE film_music_clips SET take_status = 'selected' WHERE id = ?").run(job.children[0].output_clip_id);
            assert.strictEqual(jobs.readJob(db, f.sessionId, out.operation_id).children[0].acceptance, 'accepted', 'acceptance is not read from the take');
            db.prepare("UPDATE film_music_clips SET take_status = 'rejected' WHERE id = ?").run(job.children[0].output_clip_id);
            assert.strictEqual(jobs.readJob(db, f.sessionId, out.operation_id).children[0].acceptance, 'rejected');
        }
    }
    // A third take on the same track is take 3.
    const f = film();
    await gen.generate(db, f.sessionId, 'music_compose', { prompt: 'x', duration_ms: 12000, track_id: f.trackId }, { adapter: fake() });
    const third = await gen.generate(db, f.sessionId, 'music_compose', { prompt: 'x', duration_ms: 12000, track_id: f.trackId }, { adapter: fake() });
    assert.strictEqual(jobs.readJob(db, f.sessionId, third.operation_id).children[0].take_number, 3);
});

test('one bad child fails the parent, names itself, cancels its siblings, and nothing is registered; a provider failure fails every child', async () => {
    const f = film();
    const assets = () => db.prepare('SELECT COUNT(*) n FROM film_assets WHERE project_id = ?').get(f.projectId).n;
    const before = assets();
    const out = await gen.generate(db, f.sessionId, 'music_parts', { prompt: 'x', parts: ['strings', 'drums', 'bass'], duration_ms: 12000 }, { adapter: fake({ badPart: 1 }) });
    assert.strictEqual(out.ok, false);
    const job = jobs.readJob(db, f.sessionId, out.operation_id);
    assert.strictEqual(job.status, 'failed');
    assert.deepStrictEqual(job.children.map(c => c.status), ['cancelled', 'failed', 'cancelled']);
    assert.match(job.children[1].error_message, /not audio/i);
    assert.match(job.children[0].error_message, /drums|#1/);
    assert.match(job.reason, /#1/);
    assert.strictEqual(assets(), before);

    const down = await gen.generate(db, f.sessionId, 'music_parts', { prompt: 'x', parts: ['strings', 'drums'], duration_ms: 12000 }, { adapter: fake({ fail: true }) });
    const dj = jobs.readJob(db, f.sessionId, down.operation_id);
    assert.strictEqual(dj.status, 'failed');
    assert.deepStrictEqual(dj.children.map(c => c.status), ['failed', 'failed']);
    assert.ok(dj.children.every(c => /composer is out/.test(c.error_message)));
});

test('a separation is one parent with a child per stem, and the listings show parents only', async () => {
    const f = film();
    const tone = toneBytes(440, 4);
    const adapter = { id: 'elevenlabs', async generate() { return { ok: true, data: zipOf([{ name: 'vocals.wav', bytes: tone }, { name: 'instrumental.wav', bytes: tone }]), provider_model: 'two_stems_v1', provider_job_id: 'sep-1' }; } };
    const out = await sep.startSeparation(db, f.sessionId, { clip_id: f.clipId, stems: 2 }, { adapter, wait: true });
    assert.strictEqual(out.ok, true, out.error);
    const job = jobs.readJob(db, f.sessionId, out.operation_id);
    assert.strictEqual(job.status, 'complete');
    assert.deepStrictEqual(job.children.map(c => c.label), ['vocals', 'instrumental']);
    assert.ok(job.children.every(c => c.source_fingerprint === sha(f.bytes) && c.take_number === 1 && c.job_ref === 'sep-1'));
    assert.strictEqual(sep.listSeparations(db, f.sessionId).length, 1, 'children are listed as separations');
    await gen.generate(db, f.sessionId, 'music_parts', { prompt: 'x', parts: ['strings', 'drums'], duration_ms: 12000 }, { adapter: fake() });
    assert.strictEqual(gen.listGenerations(db, f.sessionId).length, 1, 'children are listed as generations');
    assert.deepStrictEqual(jobs.listJobs(db, f.sessionId).map(j => j.kind).sort(), ['generate', 'separate']);
});

// ── Resumable ──────────────────────────────────────────────────────────────

test('a job whose process is gone is found by polling, reported interrupted rather than running for ever, and retried as the next attempt', async () => {
    const f = film();
    // A run that was in flight when its process died: running, children running, nothing live.
    const orphan = jobs.openJob(db, f.sessionId, { kind: 'generate', provider: 'fakemusic', params: { workflow: 'music_compose', input: { prompt: 'x', duration_ms: 12000 } }, expected: 1 });
    jobs.addChild(db, orphan, { seq: 0, label: 'compose' });
    const polled = jobs.pollJob(db, f.sessionId, orphan);
    assert.strictEqual(polled.status, 'failed');
    assert.match(polled.reason, /interrupted/i);
    assert.strictEqual(polled.resumable, 'retry');
    assert.ok(polled.children.every(c => c.status === 'failed' && /interrupted/i.test(c.error_message)));

    // A run this process still owns is left alone.
    let release; const gate = new Promise(r => { release = r; });
    const slow = { ...fake(), async generate(cap, p) { await gate; return fake().generate(cap, p); } };
    const started = gen.generate(db, f.sessionId, 'music_compose', { prompt: 'x', duration_ms: 12000 }, { adapter: slow });
    await new Promise(r => setTimeout(r, 30));
    const live = jobs.listJobs(db, f.sessionId).find(j => j.status === 'running');
    assert.ok(live, 'the in-flight run is not visible');
    assert.strictEqual(jobs.pollJob(db, f.sessionId, live.operation_id).status, 'running', 'a live run was marked interrupted');
    release(); await started;

    // Retry: a new attempt that names what it retries; a finished job is not retried.
    const again = await jobs.retryJob(db, f.sessionId, orphan, { adapter: fake(), wait: true });
    assert.strictEqual(again.ok, true, again.error);
    const next = jobs.readJob(db, f.sessionId, again.operation_id);
    assert.strictEqual(next.attempt, 2);
    assert.strictEqual(next.parent_id, orphan);
    assert.strictEqual(next.status, 'complete');
    const twice = await jobs.retryJob(db, f.sessionId, again.operation_id, { adapter: fake() });
    assert.strictEqual(twice.ok, false); assert.strictEqual(twice.status, 409);
    assert.strictEqual((await jobs.retryJob(db, f.sessionId, generateId(), {})).status, 404);
});

// ── Served, and reachable ──────────────────────────────────────────────────

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, writeHead(c) { this.statusCode = c; return this; }, end(p) { resolve({ status: this.statusCode, body: JSON.parse(p || '{}') }); } };
        Promise.resolve(route.handleMusicSessions({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean), {})).catch(reject);
    });
}

test('jobs are listed, read, polled and retried over HTTP and MCP, and the tools say what spends', async () => {
    const f = film();
    const out = await gen.generate(db, f.sessionId, 'music_parts', { prompt: 'x', parts: ['strings', 'drums'], duration_ms: 12000 }, { adapter: fake() });
    const list = await call('GET', `/film/music-sessions/${f.sessionId}/jobs`);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.jobs.length, 1);
    assert.strictEqual(list.body.jobs[0].children.length, 2);
    const one = await call('GET', `/film/music-sessions/${f.sessionId}/jobs/${out.operation_id}`);
    assert.strictEqual(one.status, 200); assert.strictEqual(one.body.status, 'complete');
    assert.strictEqual((await call('GET', `/film/music-sessions/${f.sessionId}/jobs/${generateId()}`)).status, 404);
    const poll = await call('POST', `/film/music-sessions/${f.sessionId}/jobs/${out.operation_id}/poll`);
    assert.strictEqual(poll.status, 200); assert.strictEqual(poll.body.status, 'complete');
    assert.strictEqual((await call('POST', `/film/music-sessions/${f.sessionId}/jobs/${out.operation_id}/retry`)).status, 409);

    const by = n => PRODUCTION_TOOLS.find(t => t.name === n);
    for (const n of ['music_job_list', 'music_job_get', 'music_job_poll', 'music_job_retry']) assert.ok(by(n), `no ${n} tool`);
    assert.match(by('music_job_list').description, /free/i);
    assert.match(by('music_job_poll').description, /free|spends nothing/i);
    assert.match(by('music_job_retry').description, /costs money|spends/i);
    assert.strictEqual(by('music_job_get').path({ session_id: 'S', operation_id: 'O' }), '/film/music-sessions/S/jobs/O');
});
