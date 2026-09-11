const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * THE ABLETON SIDECAR: A SEPARATE, LOCALHOST-ONLY PROCESS THAT SPEAKS
 * AbletonOSC AND NOTHING ELSE, BEHIND THE DAW CONTRACT.
 *
 * MUS-017. Tested over real UDP against a fake-Live protocol harness that
 * speaks the AbletonOSC subset (commit 0ca6821): the OSC codec round-trips
 * every type it uses; the handshake reads Live's version and refuses to
 * mutate an unreviewed one; replies are correlated to their requests even out
 * of order; a lost reply is a timeout for that request only; Live going away
 * and coming back is a disconnect and a reconnect; the HTTP surface binds
 * loopback, demands its token and offers an allowlist of typed operations
 * with no generic address or property setter; and the Ableton adapter built
 * on it passes the MUS-016 driver's own rules — Film Engine's tracks only,
 * stable ids, conflicts, supervised transport.
 *
 * Set-based over the sidecar's operation allowlist and the OSC types. What
 * AbletonOSC cannot do — place audio from a file, export a render — is
 * declared and reported, never pretended: the stems arrive through the
 * portable score package.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-abl-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const osc = require('../lib/osc');
const ableton = require('../lib/ableton-osc');
const { createFakeLive } = require('../lib/daw/fake-live');
const { createSidecar, sidecarConfig } = require('../ableton-sidecar');
const { createAbletonAdapter } = require('../lib/daw/ableton');
const daw = require('../lib/daw-adapter');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (await fn()) return true; await sleep(20); } return false; }

/** A fake Live, a client pointed at it, and a sidecar in front, all on ephemeral ports. */
async function rig(opts) {
    const o = opts || {};
    const client = ableton.createAbletonClient({ host: '127.0.0.1', sendPort: 0, recvPort: 0, timeoutMs: o.timeoutMs || 400, heartbeatMs: o.heartbeatMs || 150 });
    await client.bind();
    const live = createFakeLive({ version: o.version || [12, 4], replyPort: client.recvPort, faults: o.faults || {} });
    await live.start();
    client.setSendPort(live.port);
    await client.start();
    const sidecar = await createSidecar({ client, token: 'tok-' + generateId(), port: 0 });
    const close = async () => { await sidecar.close(); await client.stop(); await live.stop(); };
    return { client, live, sidecar, close };
}
async function call(sc, op, args, token) {
    const r = await fetch(`${sc.url}/op`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token === undefined ? sc.token : token}` }, body: JSON.stringify({ op, args: args || {} }) });
    return { status: r.status, body: await r.json() };
}

// ── The codec ──────────────────────────────────────────────────────────────

test('the OSC codec round-trips every type the protocol uses, pads to four bytes, and refuses malformed packets', () => {
    const cases = [
        ['/live/test', []],
        ['/live/track/set/name', [3, 'strings ⟨fe:abc⟩']],
        ['/live/song/set/tempo', [{ type: 'f', value: 92.5 }]],
        ['/live/x', [{ type: 'b', value: Buffer.from([1, 2, 3, 4, 5]) }]],
        ['/live/y', [true, false]],
        ['/live/song/get/track_names', [0, 7]],
    ];
    for (const [address, args] of cases) {
        const buf = osc.encode(address, args);
        assert.strictEqual(buf.length % 4, 0, `${address}: not padded to four bytes`);
        const back = osc.decode(buf);
        assert.strictEqual(back.address, address);
        const want = args.map(a => (a && typeof a === 'object' && 'value' in a ? a.value : a));
        for (const [i, v] of want.entries()) {
            if (Buffer.isBuffer(v)) assert.ok(v.equals(back.args[i]));
            else if (typeof v === 'number' && !Number.isInteger(v)) assert.ok(Math.abs(back.args[i] - v) < 1e-4);
            else assert.deepStrictEqual(back.args[i], v, `${address} arg ${i}`);
        }
    }
    for (const bad of [Buffer.from('nope'), Buffer.from('/live/test\0\0'), Buffer.alloc(3)]) assert.throws(() => osc.decode(bad), /osc|malformed|type tag/i);
    assert.throws(() => osc.encode('live/no-slash', []), /address/);
});

// ── The allowlist ──────────────────────────────────────────────────────────

test('the sidecar offers a closed set of typed operations: no generic address, no arbitrary setter, no delete, and every mutation says how it is confirmed', () => {
    const ops = ableton.SIDECAR_OPS;
    assert.ok(Object.keys(ops).length >= 8, 'the allowlist is suspiciously small');
    for (const [name, op] of Object.entries(ops)) {
        assert.ok(op.what && op.what.length > 15, `${name}: says nothing`);
        assert.ok(Array.isArray(op.addresses) && op.addresses.every(a => ableton.OSC_ADDRESSES.includes(a)), `${name}: reaches an address outside the reviewed set`);
        for (const [arg, spec] of Object.entries(op.args || {})) {
            assert.ok(['integer', 'number', 'string', 'fe_key'].includes(spec.type), `${name}.${arg}: untyped`);
            assert.ok(!/address|path|property|attribute/i.test(arg), `${name}: takes a generic ${arg}`);
        }
        if (op.mutates) assert.ok(op.confirm && op.confirm.length > 10, `${name}: a mutation with no confirmation read`);
    }
    assert.ok(!ableton.OSC_ADDRESSES.some(a => /delete/.test(a)), 'a delete address is reachable');
    assert.ok(ableton.OSC_ADDRESSES.every(a => a.startsWith('/live/')));
    assert.deepStrictEqual(ableton.UNSUPPORTED.map(u => u.what).sort(), ['export a render', 'place audio from a file'].sort());
    for (const u of ableton.UNSUPPORTED) assert.ok(u.why && u.instead, `${u.what}: no reason or alternative`);
});

test('the sidecar is loopback-only, token-gated and refuses what is not on its list', async () => {
    assert.throws(() => sidecarConfig({ ABLETON_OSC_HOST: '192.168.1.20', ABLETON_SIDECAR_TOKEN: 'x'.repeat(24) }), /loopback|localhost/);
    assert.throws(() => sidecarConfig({ ABLETON_OSC_HOST: '127.0.0.1' }), /token/i);
    assert.throws(() => sidecarConfig({ ABLETON_OSC_HOST: '127.0.0.1', ABLETON_SIDECAR_TOKEN: 'short' }), /token/i);
    const cfg = sidecarConfig({ ABLETON_SIDECAR_TOKEN: 'x'.repeat(24) });
    assert.deepStrictEqual([cfg.host, cfg.sendPort, cfg.recvPort], ['127.0.0.1', 11000, 11001]);
    const r = await rig();
    try {
        assert.strictEqual(r.sidecar.address, '127.0.0.1', 'the sidecar listens beyond loopback');
        assert.strictEqual((await call(r.sidecar, 'fe_tracks_read', {}, 'wrong-token')).status, 401);
        const unknown = await call(r.sidecar, 'set_property', { address: '/live/song/set/tempo' });
        assert.strictEqual(unknown.status, 403); assert.match(unknown.body.error, /allowlist|not allowed/i);
        const badType = await call(r.sidecar, 'tempo_set', { bpm: 'fast' });
        assert.strictEqual(badType.status, 400); assert.match(badType.body.error, /bpm/);
    } finally { await r.close(); }
});

// ── Handshake, correlation, reconnect, health ──────────────────────────────

test('the handshake reads Live\'s version: 12.4 is compatible, another is connected but refuses to mutate, and silence is not connected', async () => {
    const ok = await rig();
    try {
        const h = ok.client.health();
        assert.strictEqual(h.connected, true); assert.strictEqual(h.compatible, true);
        assert.strictEqual(h.live_version, '12.4');
        assert.strictEqual(h.abletonosc_pin.commit, ableton.ABLETONOSC_PIN.commit);
        assert.match(h.version_note, /12\.4\.5/);
    } finally { await ok.close(); }
    const old = await rig({ version: [11, 3] });
    try {
        const h = old.client.health();
        assert.strictEqual(h.connected, true); assert.strictEqual(h.compatible, false); assert.match(h.reason, /11\.3/);
        assert.strictEqual((await call(old.sidecar, 'fe_tracks_read')).status, 200, 'an incompatible Live cannot even be read');
        const w = await call(old.sidecar, 'tempo_set', { bpm: 100 });
        assert.strictEqual(w.status, 409); assert.match(w.body.error, /compatible|12\.4/);
    } finally { await old.close(); }
    const mute = await rig({ faults: { silent: true } });
    try {
        const h = mute.client.health();
        assert.strictEqual(h.connected, false); assert.ok(h.reason, 'silence gives no reason');
        const w = await call(mute.sidecar, 'fe_tracks_read');
        assert.strictEqual(w.status, 503);
    } finally { await mute.close(); }
});

test('replies find their own requests out of order; a lost reply fails only its request; a /live/error fails the request it answers', async () => {
    const r = await rig({ faults: { shuffle: true } });
    try {
        r.live.setTracks(['a', 'b', 'c', 'd', 'e']);
        const names = await Promise.all([0, 1, 2, 3, 4].map(i => r.client.request('track_name_get', { track_id: i })));
        assert.deepStrictEqual(names.map(n => n.name), ['a', 'b', 'c', 'd', 'e'], 'a reply was matched to another request');
        r.live.dropNext('/live/track/get/name', 1);
        const [lost, kept] = await Promise.allSettled([r.client.request('track_name_get', { track_id: 1 }), r.client.request('track_name_get', { track_id: 2 })]);
        assert.strictEqual(lost.status, 'rejected'); assert.match(lost.reason.message, /timed out/i);
        assert.strictEqual(kept.status, 'fulfilled'); assert.strictEqual(kept.value.name, 'c');
        const err = await r.client.request('track_name_get', { track_id: 99 }).catch(e => e);
        assert.match(String(err.message), /live\/error|no such track|out of range/i);
    } finally { await r.close(); }
});

test('Live going away is a disconnect with pending work failed; Live coming back is a reconnect and a fresh handshake', async () => {
    const r = await rig({ heartbeatMs: 80, timeoutMs: 150 });
    try {
        assert.strictEqual(r.client.health().connected, true);
        await r.live.stop();
        assert.ok(await until(() => r.client.health().connected === false, 2000), 'a silent Live still reads as connected');
        const during = await r.client.request('fe_tracks_read', {}).catch(e => e);
        assert.match(String(during.message), /not connected|disconnected/i);
        await r.live.start();
        assert.ok(await until(() => r.client.health().connected === true, 3000), 'the client did not reconnect');
        const h = r.client.health();
        assert.ok(h.reconnects >= 1, 'the reconnect is not counted');
        assert.ok(h.handshakes >= 2, 'no fresh handshake after the reconnect');
        const health = await fetch(`${r.sidecar.url}/health`, { headers: { Authorization: `Bearer ${r.sidecar.token}` } }).then(x => x.json());
        for (const k of ['connected', 'compatible', 'live_version', 'abletonosc_pin', 'last_heartbeat_at', 'rtt_ms', 'pending', 'reconnects', 'last_error', 'ports']) assert.ok(k in health, `health has no ${k}`);
    } finally { await r.close(); }
});

test('a Film Engine rename is refused on a track that does not carry its marker: the sidecar cannot touch somebody else\'s track', async () => {
    const r = await rig();
    try {
        r.live.setTracks(['Lead vocal (the composer\'s)']);
        const w = await call(r.sidecar, 'fe_track_rename', { track_id: 0, fe_key: 'fe:track:x', name: 'mine now' });
        assert.strictEqual(w.status, 403); assert.match(w.body.error, /not a Film Engine track|marker/i);
        assert.deepStrictEqual(r.live.state().tracks.map(t => t.name), ['Lead vocal (the composer\'s)']);
        const c = await call(r.sidecar, 'fe_track_create', { fe_key: 'fe:track:y', name: 'strings' });
        assert.strictEqual(c.status, 200, JSON.stringify(c.body));
        assert.match(r.live.state().tracks[1].name, /^strings ⟨fe:[0-9a-f]{10}⟩$/);
        const again = await call(r.sidecar, 'fe_track_create', { fe_key: 'fe:track:y', name: 'strings' });
        assert.strictEqual(again.body.track_id, c.body.track_id, 'creating the same key twice made a second track');
        assert.strictEqual(r.live.state().tracks.length, 2);
    } finally { await r.close(); }
});

// ── The Ableton adapter, through the MUS-016 driver ────────────────────────

const bin = () => resolveFfmpeg().bin;
function film() {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Abl')").run(projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, name, tempo_map_json) VALUES (?, ?, 'Cue', ?)").run(sessionId, projectId, JSON.stringify([{ at_ms: 0, bpm: 96, numerator: 4, denominator: 4 }]));
    const dir = path.join(DATA_DIR, 'music', projectId); fs.mkdirSync(dir, { recursive: true });
    for (const [i, name] of ['strings', 'drums'].entries()) {
        const p = path.join(dir, `s_${name}_${generateId().slice(0, 6)}.wav`);
        execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${220 + i * 110}:duration=2:sample_rate=48000`, '-ac', '2', '-c:a', 'pcm_s24le', p], { stdio: 'pipe', timeout: 120000 });
        const a = generateId();
        db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata) VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 2000, '{}')").run(a, projectId, p, path.basename(p));
        const t = generateId();
        db.prepare("INSERT INTO film_music_tracks (id, session_id, name, role, sort_order) VALUES (?, ?, ?, ?, ?)").run(t, sessionId, name, name, i);
        db.prepare("INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, take_status) VALUES (?, ?, ?, ?, 'imported', 0, 2000, 'selected')").run(generateId(), t, a, name);
    }
    return { projectId, sessionId };
}

test('the Ableton adapter satisfies the DAW contract: pushes Film Engine\'s tracks only, keeps their ids, reports a Live-side rename, drives the transport, and says what it cannot pull', async () => {
    const r = await rig();
    try {
        r.live.setTracks(['Their bass']);
        const adapter = createAbletonAdapter({ url: r.sidecar.url, token: r.sidecar.token });
        assert.deepStrictEqual(daw.validateAdapter(adapter).errors, []);
        assert.strictEqual(adapter.id, 'ableton');
        const s = await daw.status(adapter);
        assert.ok(s.ok && s.connected && s.compatible, JSON.stringify(s));

        const f = film();
        const plan = await daw.planPush(db, f.sessionId, adapter);
        assert.ok(plan.ok, plan.error);
        assert.ok(plan.untouched.some(t => t.name === 'Their bass'));
        const pushed = await daw.push(db, f.sessionId, adapter, { plan_fingerprint: plan.plan_fingerprint });
        assert.ok(pushed.ok, pushed.error);
        const names = r.live.state().tracks.map(t => t.name);
        assert.strictEqual(names[0], 'Their bass', 'somebody else\'s track changed');
        assert.strictEqual(names.filter(n => /⟨fe:/.test(n)).length, 2);
        assert.strictEqual(r.live.state().tempo, 96, 'the session tempo did not reach Live');
        assert.ok(pushed.applied.every(a => a.audio === 'manual' && /stems\//.test(a.stem_path || '')), 'the push does not say the audio must be placed by hand from the package');

        // Second push: the same tracks, updated, no duplicates.
        const plan2 = await daw.planPush(db, f.sessionId, adapter);
        assert.deepStrictEqual(plan2.instructions.map(i => i.action), ['update', 'update']);
        await daw.push(db, f.sessionId, adapter, { plan_fingerprint: plan2.plan_fingerprint, idempotency_key: 'second' });
        assert.strictEqual(r.live.state().tracks.filter(t => /⟨fe:/.test(t.name)).length, 2, 'a second push duplicated the tracks');

        // Somebody renames a Film Engine track in Live, keeping the marker.
        const idx = r.live.state().tracks.findIndex(t => /^strings/.test(t.name));
        r.live.renameTrack(idx, r.live.state().tracks[idx].name.replace('strings', 'strings (comped)'));
        const plan3 = await daw.planPush(db, f.sessionId, adapter);
        assert.strictEqual(plan3.conflicts.length, 1); assert.match(plan3.conflicts[0].reason, /changed in the DAW/);

        // Transport: supervised locate in beats at the session tempo; play.
        const loc = await daw.transport(db, f.sessionId, adapter, { command: 'locate', position_ms: 5000, supervised: true });
        assert.ok(loc.ok, loc.error);
        assert.ok(Math.abs(r.live.state().song_time - 5000 / 60000 * 96) < 1e-3, 'locate did not convert milliseconds to beats at the Live tempo');
        assert.ok((await daw.transport(db, f.sessionId, adapter, { command: 'play', supervised: true })).ok);
        assert.strictEqual(r.live.state().playing, true);

        // Pull: AbletonOSC cannot export a render; the plan says so rather than pretending.
        const pp = await daw.planPull(db, f.sessionId, adapter);
        assert.ok(pp.ok); assert.deepStrictEqual(pp.items, []);
        assert.match(adapter.pullReason, /cannot export|package/i);
    } finally { await r.close(); }
});

// ── Installation is documented, and nothing from Ableton is bundled ───────

test('the installation guide names the pinned AbletonOSC commit, the reviewed Live version, the ports and the token, and bundles nothing of Ableton\'s', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'ableton-sidecar.md'), 'utf8');
    for (const needle of [ableton.ABLETONOSC_PIN.commit, ableton.LIVE_SUPPORTED.reviewed, '11000', '11001', 'ABLETON_SIDECAR_TOKEN', 'ableton-sidecar.js', 'Remote Scripts']) assert.ok(doc.includes(needle), `the guide does not mention ${needle}`);
    assert.match(doc, /not bundled|does not bundle|never bundle/i);
    for (const u of ableton.UNSUPPORTED) assert.ok(doc.includes(u.what), `the guide does not say it cannot ${u.what}`);
    const tracked = fs.readdirSync(path.join(__dirname, '..', 'lib', 'daw'));
    assert.ok(!tracked.some(f => /\.py$|\.als$|\.amxd$/i.test(f)), 'an Ableton component is in the repository');
});
