const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * A DAW IS AN EDITOR FILM ENGINE TALKS TO, NEVER THE PLACE THE SCORE LIVES.
 *
 * MUS-016. The adapter contract every DAW integration implements — status,
 * session read, push plan, push, pull plan, pull, supervised transport — and
 * the engine-side driver that holds every adapter to the same rules, whatever
 * the transport (AbletonOSC next, anything else later):
 *
 *   - ACKNOWLEDGED: a mutation that comes back without an acknowledgement
 *     echoing the request is a failure, not a success nobody confirmed;
 *   - IDEMPOTENT: the same push or pull asked twice happens once;
 *   - STABLE IDS: a Film Engine key maps to one external id for good, so a
 *     second push updates what the first created;
 *   - CONFLICTS REPORTED: a Film Engine track edited in the DAW since the last
 *     push is a conflict the plan names and the push refuses until decided;
 *   - TIMED: every operation has a ceiling, and a mutation that times out is
 *     recorded as unknown-outcome, safe to retry by its key;
 *   - AUDITED: every mutation is an operation row naming the adapter, the
 *     request, the key and the outcome;
 *   - BOUNDED: only Film Engine-owned tracks may change — a plan never names
 *     another, and an acknowledgement claiming to have touched one fails.
 *
 * Set-based over the adapter operation registry, against the reference
 * in-memory DAW, which can be told to misbehave in each of the ways a real
 * one can.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-daw-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const daw = require('../lib/daw-adapter');
const pkg = require('../lib/music-package');
const { createMemoryDaw } = require('../lib/daw/memory');
const { readScoreSession } = require('../lib/music-session');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');

const bin = () => resolveFfmpeg().bin;
function toneBytes(hz, seconds) {
    const p = path.join(os.tmpdir(), `daw_${generateId().slice(0, 8)}.wav`);
    execFileSync(bin(), ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=48000`, '-ac', '2', '-c:a', 'pcm_s24le', p], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    const b = fs.readFileSync(p); fs.unlinkSync(p); return b;
}
function film() {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'DAW')").run(projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, name) VALUES (?, ?, 'Cue 1')").run(sessionId, projectId);
    const dir = path.join(DATA_DIR, 'music', projectId); fs.mkdirSync(dir, { recursive: true });
    const tracks = [];
    for (const [i, name] of ['strings', 'drums'].entries()) {
        const bytes = toneBytes(220 + i * 110, 2);
        const file = path.join(dir, `src_${name}_${generateId().slice(0, 6)}.wav`); fs.writeFileSync(file, bytes);
        const assetId = generateId();
        db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata) VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 2000, ?)").run(assetId, projectId, file, path.basename(file), JSON.stringify({ hash: crypto.createHash('sha256').update(bytes).digest('hex') }));
        const trackId = generateId();
        db.prepare("INSERT INTO film_music_tracks (id, session_id, name, role, sort_order) VALUES (?, ?, ?, ?, ?)").run(trackId, sessionId, name, name, i);
        db.prepare("INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, take_status) VALUES (?, ?, ?, ?, 'imported', 0, 2000, 'selected')").run(generateId(), trackId, assetId, name);
        tracks.push({ trackId, assetId });
    }
    return { projectId, sessionId, tracks };
}
const audit = sid => daw.listAudit(db, sid);
/** What a DAW would render back: the session's own portable package. */
async function packageOf(sid) { const b = await pkg.buildPackage(db, sid); assert.ok(b.ok, b.error); return fs.readFileSync(b.file_path); }

// ── The contract ───────────────────────────────────────────────────────────

test('the operation registry declares all seven operations with their ceiling, mutation, acknowledgement and idempotency rules', () => {
    assert.deepStrictEqual(Object.keys(daw.DAW_OPERATIONS).sort(), ['pull', 'pull_plan', 'push', 'push_plan', 'session_read', 'status', 'transport']);
    for (const [name, op] of Object.entries(daw.DAW_OPERATIONS)) {
        assert.ok(op.what && op.what.length > 20, `${name}: says nothing about what it does`);
        assert.ok(Number.isInteger(op.timeout_ms) && op.timeout_ms > 0, `${name}: no timeout`);
        assert.strictEqual(typeof op.mutates, 'boolean', `${name}: does not say whether it mutates`);
        if (op.mutates) {
            assert.strictEqual(op.ack, true, `${name}: a mutation without a required acknowledgement`);
            assert.strictEqual(op.audited, true, `${name}: a mutation that leaves no audit record`);
        }
        if (name === 'push' || name === 'pull') assert.strictEqual(op.idempotent, true, `${name}: not idempotent`);
        if (name === 'transport') assert.strictEqual(op.supervised, true, 'transport is not supervised');
        if (op.adapter_method) assert.ok(daw.ADAPTER_METHODS.includes(op.adapter_method));
    }
    assert.deepStrictEqual(daw.TRANSPORT_COMMANDS.slice().sort(), ['locate', 'play', 'stop']);
});

test('an adapter missing any method the contract requires is refused by name; the reference DAW satisfies it', () => {
    assert.deepStrictEqual(daw.validateAdapter(createMemoryDaw()).errors, []);
    for (const m of daw.ADAPTER_METHODS) {
        const a = createMemoryDaw();
        delete a[m];
        const v = daw.validateAdapter(a);
        assert.strictEqual(v.ok, false, `an adapter without ${m} validated`);
        assert.ok(v.errors.some(e => e.includes(m)), `the refusal does not name ${m}`);
    }
    assert.strictEqual(daw.validateAdapter({ ...createMemoryDaw(), id: '' }).ok, false);
});

test('the links table holds one external id per key per adapter, and goes with its session', () => {
    const cols = db.prepare('PRAGMA table_info(film_music_daw_links)').all().map(c => c.name);
    for (const c of ['session_id', 'adapter_id', 'fe_key', 'kind', 'external_id', 'revision']) assert.ok(cols.includes(c), `no ${c}`);
    const f = film();
    const ins = (k, e) => db.prepare("INSERT INTO film_music_daw_links (id, session_id, adapter_id, fe_key, kind, external_id) VALUES (?, ?, 'memory', ?, 'track', ?)").run(generateId(), f.sessionId, k, e);
    ins('fe:track:a', 'x1');
    assert.throws(() => ins('fe:track:a', 'x2'), /UNIQUE/, 'one key mapped to two external ids');
    assert.throws(() => ins('fe:track:b', 'x1'), /UNIQUE/, 'two keys mapped to one external id');
    db.prepare('DELETE FROM film_music_sessions WHERE id = ?').run(f.sessionId);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_music_daw_links WHERE session_id = ?').get(f.sessionId).n, 0);
});

// ── Push: plan, ownership, conflicts, stable ids, idempotency ─────────────

test('a push plan creates what is new, never names a track Film Engine does not own, and a push lands it acknowledged with stable ids', async () => {
    const f = film();
    const d = createMemoryDaw();
    d.addForeignTrack('Vocal comp (the composer\'s own)');
    const plan = await daw.planPush(db, f.sessionId, d);
    assert.strictEqual(plan.ok, true, plan.error);
    assert.deepStrictEqual(plan.instructions.map(i => i.action).sort(), ['create', 'create']);
    assert.ok(plan.untouched.some(t => /composer/.test(t.name)), 'the foreign track is not reported as left alone');
    assert.ok(plan.instructions.every(i => !/composer/.test(i.name)), 'the plan names a track Film Engine does not own');
    assert.ok(plan.plan_fingerprint && plan.package_id);

    const pushed = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan.plan_fingerprint });
    assert.strictEqual(pushed.ok, true, pushed.error);
    const links = db.prepare("SELECT * FROM film_music_daw_links WHERE session_id = ? AND adapter_id = 'memory' AND kind = 'track'").all(f.sessionId);
    assert.strictEqual(links.length, 2);
    const first = Object.fromEntries(links.map(l => [l.fe_key, l.external_id]));
    assert.strictEqual(d.state().tracks.filter(t => t.owner === 'film-engine').length, 2);

    // A second push of a changed session updates the SAME external tracks.
    db.prepare('UPDATE film_music_tracks SET gain_db = -3 WHERE id = ?').run(f.tracks[0].trackId);
    const plan2 = await daw.planPush(db, f.sessionId, d);
    assert.deepStrictEqual(plan2.instructions.map(i => i.action).sort(), ['update', 'update']);
    assert.ok(plan2.instructions.every(i => first[i.fe_key] === i.external_id), 'the second push does not address the tracks the first created');
    const pushed2 = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan2.plan_fingerprint });
    assert.ok(pushed2.ok, pushed2.error);
    assert.strictEqual(d.state().tracks.filter(t => t.owner === 'film-engine').length, 2, 'a second push created duplicates');
    const again = Object.fromEntries(db.prepare("SELECT * FROM film_music_daw_links WHERE session_id = ? AND kind = 'track'").all(f.sessionId).map(l => [l.fe_key, l.external_id]));
    assert.deepStrictEqual(again, first, 'the external ids moved');
});

test('the same push asked twice happens once; a stale plan is refused; a DAW-side edit is a conflict the push refuses until decided', async () => {
    const f = film();
    const d = createMemoryDaw();
    const plan = await daw.planPush(db, f.sessionId, d);
    const a = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan.plan_fingerprint });
    const calls = d.calls('push');
    const b = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan.plan_fingerprint });
    assert.ok(a.ok && b.ok);
    assert.strictEqual(d.calls('push'), calls, 'a repeated push reached the DAW again');
    assert.strictEqual(b.replayed, true);
    assert.strictEqual(b.operation_id, a.operation_id);

    // The session moved after the plan was read.
    const plan2 = await daw.planPush(db, f.sessionId, d);
    db.prepare('UPDATE film_music_tracks SET pan = 0.5 WHERE id = ?').run(f.tracks[1].trackId);
    const stale = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan2.plan_fingerprint });
    assert.strictEqual(stale.ok, false); assert.strictEqual(stale.code, 'STALE_PLAN');

    // Somebody edits a Film Engine track in the DAW.
    const ext = db.prepare("SELECT external_id FROM film_music_daw_links WHERE session_id = ? AND fe_key = ?").get(f.sessionId, `fe:track:${f.tracks[0].trackId}`).external_id;
    d.editTrack(ext);
    const plan3 = await daw.planPush(db, f.sessionId, d);
    assert.strictEqual(plan3.conflicts.length, 1);
    assert.match(plan3.conflicts[0].reason, /changed in the DAW/i);
    const refused = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan3.plan_fingerprint });
    assert.strictEqual(refused.ok, false); assert.strictEqual(refused.code, 'CONFLICTS');
    assert.match(refused.error, new RegExp(plan3.conflicts[0].fe_key));
    const skipped = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan3.plan_fingerprint, resolutions: { [plan3.conflicts[0].fe_key]: 'keep_daw' } });
    assert.strictEqual(skipped.ok, true, skipped.error);
    assert.ok(!skipped.applied.some(x => x.fe_key === plan3.conflicts[0].fe_key), 'a track the director chose to keep was overwritten');
    const plan4 = await daw.planPush(db, f.sessionId, d);
    const over = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan4.plan_fingerprint, resolutions: { [plan4.conflicts[0].fe_key]: 'overwrite' } });
    assert.ok(over.ok && over.applied.some(x => x.fe_key === plan4.conflicts[0].fe_key));
});

// ── Every misbehaviour is a failure, recorded ─────────────────────────────

test('for every mutating operation: no acknowledgement, a wrong request id, or a timeout is a recorded failure, and the bounded one leaves links untouched', async () => {
    const mutating = Object.entries(daw.DAW_OPERATIONS).filter(([, op]) => op.mutates).map(([n]) => n);
    assert.deepStrictEqual(mutating.sort(), ['pull', 'push', 'transport']);
    for (const op of mutating) {
        for (const fault of ['no_ack', 'wrong_request_id', 'slow']) {
            const f = film();
            const d = createMemoryDaw({ fault: { [op]: fault } });
            let out;
            const timeouts = { [op]: 60 };
            if (op === 'push') {
                const plan = await daw.planPush(db, f.sessionId, d);
                out = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan.plan_fingerprint, timeouts });
            } else if (op === 'pull') {
                d.renderFrom(await packageOf(f.sessionId));
                const pp = await daw.planPull(db, f.sessionId, d);
                out = await daw.pull(db, f.sessionId, d, { item_id: pp.items[0].item_id, timeouts });
            } else {
                out = await daw.transport(db, f.sessionId, d, { command: 'play', supervised: true, timeouts });
            }
            assert.strictEqual(out.ok, false, `${op}/${fault}: reported success`);
            assert.match(out.error, fault === 'slow' ? /timed out/i : /acknowledg/i, `${op}/${fault}: ${out.error}`);
            const rows = audit(f.sessionId).filter(r => r.op === op);
            assert.ok(rows.length && rows[0].status === 'failed', `${op}/${fault}: no failed audit record`);
            if (fault === 'slow' && op !== 'transport') assert.match(rows[0].error, /unknown|may have|retry/i, `${op}: a timed-out mutation does not say its outcome is unknown`);
            assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_music_daw_links WHERE session_id = ?').get(f.sessionId).n, 0, `${op}/${fault}: links were written from an unconfirmed mutation`);
        }
    }
    // A read that hangs is a timeout too, and writes nothing.
    for (const op of ['status', 'session_read']) {
        const d = createMemoryDaw({ fault: { [op]: 'slow' } });
        const out = op === 'status' ? await daw.status(d, { timeouts: { status: 60 } }) : await daw.readSession(d, { timeouts: { session_read: 60 } });
        assert.strictEqual(out.ok, false); assert.match(out.error, /timed out/i);
    }
});

test('an acknowledgement claiming to have changed a track Film Engine does not own fails the push and writes no links', async () => {
    const f = film();
    const d = createMemoryDaw({ fault: { push: 'touch_foreign' } });
    d.addForeignTrack('Their track');
    const plan = await daw.planPush(db, f.sessionId, d);
    const out = await daw.push(db, f.sessionId, d, { plan_fingerprint: plan.plan_fingerprint });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /does not own|not Film Engine/i);
    assert.strictEqual(audit(f.sessionId)[0].status, 'failed');
    assert.match(audit(f.sessionId)[0].error, /boundary|does not own/i);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_music_daw_links WHERE session_id = ?').get(f.sessionId).n, 0);
});

// ── Pull and transport ─────────────────────────────────────────────────────

test('a pull brings a DAW render back as candidate takes, once, and refuses bytes that are not what the plan named', async () => {
    const f = film();
    const d = createMemoryDaw();
    const plan = await daw.planPush(db, f.sessionId, d);
    await daw.push(db, f.sessionId, d, { plan_fingerprint: plan.plan_fingerprint });
    d.renderFrom(await packageOf(f.sessionId));
    const pp = await daw.planPull(db, f.sessionId, d);
    assert.strictEqual(pp.ok, true, pp.error);
    assert.strictEqual(pp.items.length, 1);
    assert.ok(pp.items[0].sha256 && pp.items[0].already_pulled === false);
    const before = readScoreSession(db, f.sessionId);
    const got = await daw.pull(db, f.sessionId, d, { item_id: pp.items[0].item_id });
    assert.strictEqual(got.ok, true, got.error);
    const after = readScoreSession(db, f.sessionId);
    assert.strictEqual(after.tracks.length, before.tracks.length, 'a pull made tracks instead of takes');
    for (const t of after.tracks) {
        const was = before.tracks.find(x => x.id === t.id).clips[0];
        assert.ok(t.clips.some(c => c.id === was.id && c.take_status === 'selected'), 'a pull replaced a take');
        assert.ok(t.clips.some(c => c.id !== was.id && c.take_status === 'candidate'), 'the pulled stem is not a candidate take');
    }
    const calls = d.calls('pull');
    const again = await daw.pull(db, f.sessionId, d, { item_id: pp.items[0].item_id });
    assert.ok(again.ok && again.replayed, 'a repeated pull was imported again');
    assert.strictEqual(d.calls('pull'), calls);
    assert.strictEqual((await daw.planPull(db, f.sessionId, d)).items[0].already_pulled, true);

    // Bytes that do not match the hash the plan named are refused, and nothing is imported.
    const g = film();
    const d2 = createMemoryDaw({ fault: { pull: 'wrong_bytes' } });
    d2.renderFrom(await packageOf(g.sessionId));
    const pp2 = await daw.planPull(db, g.sessionId, d2);
    const bad = await daw.pull(db, g.sessionId, d2, { item_id: pp2.items[0].item_id });
    assert.strictEqual(bad.ok, false); assert.match(bad.error, /hash|sha256/i);
    assert.strictEqual(readScoreSession(db, g.sessionId).tracks.every(t => t.clips.length === 1), true, 'a refused pull imported something');
});

test('transport is supervised and allowlisted: an unsupervised or unknown command is refused before the DAW hears it', async () => {
    const f = film();
    const d = createMemoryDaw();
    const un = await daw.transport(db, f.sessionId, d, { command: 'play' });
    assert.strictEqual(un.ok, false); assert.match(un.error, /supervised/i);
    const odd = await daw.transport(db, f.sessionId, d, { command: 'record', supervised: true });
    assert.strictEqual(odd.ok, false); assert.match(odd.error, /play, stop, locate|allow/i);
    const far = await daw.transport(db, f.sessionId, d, { command: 'locate', supervised: true });
    assert.strictEqual(far.ok, false); assert.match(far.error, /position_ms/);
    assert.strictEqual(d.calls('transport'), 0, 'a refused command reached the DAW');
    const ok = await daw.transport(db, f.sessionId, d, { command: 'locate', position_ms: 1500, supervised: true });
    assert.strictEqual(ok.ok, true, ok.error);
    assert.strictEqual(d.state().playhead_ms, 1500);
    const row = audit(f.sessionId).find(r => r.op === 'transport');
    assert.ok(row && row.status === 'complete' && row.request_id && row.adapter_id === 'memory');
});

test('every mutation is audited with the adapter, the request, the key, the outcome and how long it took', async () => {
    const f = film();
    const d = createMemoryDaw();
    const plan = await daw.planPush(db, f.sessionId, d);
    await daw.push(db, f.sessionId, d, { plan_fingerprint: plan.plan_fingerprint });
    await daw.transport(db, f.sessionId, d, { command: 'stop', supervised: true });
    const rows = audit(f.sessionId);
    assert.deepStrictEqual(rows.map(r => r.op).sort(), ['push', 'transport']);
    for (const r of rows) {
        assert.strictEqual(r.adapter_id, 'memory');
        assert.ok(r.request_id, `${r.op}: no request id`);
        assert.ok(r.idempotency_key, `${r.op}: no idempotency key`);
        assert.ok(Number.isFinite(r.duration_ms), `${r.op}: no duration`);
        assert.strictEqual(r.status, 'complete');
    }
    // Reads are free and leave no record.
    await daw.status(d); await daw.readSession(d); await daw.planPush(db, f.sessionId, d);
    assert.strictEqual(audit(f.sessionId).length, 2);
});
