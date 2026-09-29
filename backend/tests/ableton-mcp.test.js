const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * THE ABLETON TOOLS: SEVEN OPERATIONS OF THE DAW CONTRACT, AND NOTHING THAT
 * COULD REACH INTO LIVE ANY OTHER WAY.
 *
 * MUS-018. Each tool is one operation of `DAW_OPERATIONS`, dispatched through
 * the score-session route into the MUS-016 driver, so an agent is held to
 * exactly the rules the driver holds every adapter to: a push is planned,
 * fingerprinted and idempotent; a pull is imported only after its hash and
 * alignment are validated; the transport is supervised. Set-based over the
 * contract's operations: every operation has its tool and no tool has an
 * operation outside the contract — and no tool takes an address, a path, a
 * property or a value that could set anything in Live the contract does not
 * name.
 *
 * Run against the real sidecar over UDP to a fake Live for the Ableton path,
 * and against the reference DAW for the pull path Ableton cannot offer
 * (AbletonOSC exports no render), so the hash-and-alignment gate is exercised
 * through the tools rather than assumed.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-abl-mcp-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const mcp = require('../lib/mcp-tools');
const daw = require('../lib/daw-adapter');
const registry = require('../lib/daw-registry');
const ableton = require('../lib/ableton-osc');
const { createFakeLive } = require('../lib/daw/fake-live');
const { createMemoryDaw } = require('../lib/daw/memory');
const { createSidecar } = require('../ableton-sidecar');
const musicPackage = require('../lib/music-package');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');

const TOOLS = registry.ABLETON_TOOLS;
const call = async (name, args) => mcp.presentResult(await mcp.callTool(name, args));
const failed = r => r && typeof r.status === 'number' && r.status >= 400;

function film() {
    const bin = resolveFfmpeg().bin;
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'AblMcp')").run(projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, name, tempo_map_json) VALUES (?, ?, 'Cue', ?)").run(sessionId, projectId, JSON.stringify([{ at_ms: 0, bpm: 90, numerator: 4, denominator: 4 }]));
    const dir = path.join(DATA_DIR, 'music', projectId); fs.mkdirSync(dir, { recursive: true });
    for (const [i, name] of ['pads', 'bass'].entries()) {
        const p = path.join(dir, `m_${name}_${generateId().slice(0, 6)}.wav`);
        execFileSync(bin, ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${200 + i * 150}:duration=2:sample_rate=48000`, '-ac', '2', '-c:a', 'pcm_s24le', p], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
        const a = generateId();
        db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata) VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 2000, '{}')").run(a, projectId, p, path.basename(p));
        const t = generateId();
        db.prepare("INSERT INTO film_music_tracks (id, session_id, name, role, sort_order) VALUES (?, ?, ?, ?, ?)").run(t, sessionId, name, name, i);
        db.prepare("INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, take_status) VALUES (?, ?, ?, ?, 'imported', 0, 2000, 'selected')").run(generateId(), t, a, name);
    }
    return { projectId, sessionId };
}

async function liveRig() {
    const client = ableton.createAbletonClient({ host: '127.0.0.1', sendPort: 0, recvPort: 0, timeoutMs: 500, heartbeatMs: 200 });
    await client.bind();
    const live = createFakeLive({ replyPort: client.recvPort });
    await live.start();
    client.setSendPort(live.port);
    await client.start();
    const token = 'tok-' + crypto.randomUUID();
    const sidecar = await createSidecar({ client, token, port: 0 });
    const prev = { url: process.env.ABLETON_SIDECAR_URL, token: process.env.ABLETON_SIDECAR_TOKEN };
    process.env.ABLETON_SIDECAR_URL = sidecar.url;
    process.env.ABLETON_SIDECAR_TOKEN = token;
    return { live, close: async () => {
        process.env.ABLETON_SIDECAR_URL = prev.url || ''; process.env.ABLETON_SIDECAR_TOKEN = prev.token || '';
        if (!prev.url) delete process.env.ABLETON_SIDECAR_URL; if (!prev.token) delete process.env.ABLETON_SIDECAR_TOKEN;
        await sidecar.close(); await client.stop(); await live.stop();
    } };
}

// ── The set ────────────────────────────────────────────────────────────────

test('every operation of the DAW contract has exactly one Ableton tool, and every Ableton tool is one of them', () => {
    const ops = Object.keys(daw.DAW_OPERATIONS).sort();
    assert.deepStrictEqual(Object.values(TOOLS).sort(), ops, 'an operation has no tool, or a tool maps to something outside the contract');
    assert.deepStrictEqual(Object.keys(TOOLS).sort(), ['ableton_mix_pull', 'ableton_mix_pull_plan', 'ableton_score_push', 'ableton_score_push_plan', 'ableton_session_read', 'ableton_status', 'ableton_transport'].sort());
    const listed = mcp.listTools().map(t => t.name);
    for (const name of Object.keys(TOOLS)) assert.ok(listed.includes(name), `${name} is not served to an agent`);
    assert.deepStrictEqual(listed.filter(n => /^ableton_/.test(n)).sort(), Object.keys(TOOLS).sort(), 'an ableton_ tool exists outside the contract');
});

test('no Ableton tool can set anything the contract does not name: no address, path, property, attribute or free value', () => {
    const byName = new Map(mcp.listTools().map(t => [t.name, t]));
    for (const [name, op] of Object.entries(TOOLS)) {
        const t = byName.get(name);
        const props = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
        for (const p of props) assert.ok(!/address|osc|property|attribute|lom|setter|^value$|^path$|^op$/i.test(p), `${name} takes a generic ${p}`);
        const def = daw.DAW_OPERATIONS[op];
        if (def.mutates) assert.match(t.description, /changes Live|in Live|Live's transport/i, `${name} changes Live and does not say so`);
        else assert.match(t.description, /^Free/, `${name} is free and does not say so`);
        if (def.supervised) { assert.ok(props.includes('supervised'), `${name} has no supervised flag`); assert.match(t.description, /person/i); }
        if (def.idempotent) assert.ok(props.includes('idempotency_key'), `${name} cannot be retried by key`);
    }
    assert.match(byName.get('ableton_score_push').description, /plan_fingerprint/);
    assert.match(byName.get('ableton_mix_pull').description, /hash/i);
});

// ── Not configured ─────────────────────────────────────────────────────────

test('with no sidecar configured, every Ableton tool says how to set it up rather than failing obscurely', async () => {
    const saved = { url: process.env.ABLETON_SIDECAR_URL, token: process.env.ABLETON_SIDECAR_TOKEN };
    delete process.env.ABLETON_SIDECAR_TOKEN;
    try {
        const f = film();
        for (const name of Object.keys(TOOLS)) {
            const r = await call(name, { session_id: f.sessionId, command: 'stop', supervised: true, plan_fingerprint: 'x', item_id: 'x' });
            assert.ok(failed(r) && r.status === 503, `${name} answered ${JSON.stringify(r).slice(0, 120)}`);
            assert.match(r.error, /ABLETON_SIDECAR_TOKEN/); assert.match(r.error, /ableton-sidecar\.md/);
        }
        process.env.ABLETON_SIDECAR_TOKEN = 'x'.repeat(24);
        process.env.ABLETON_SIDECAR_URL = 'http://192.168.1.9:3190';
        const r = await call('ableton_status', {});
        assert.ok(failed(r)); assert.match(r.error, /loopback|127\.0\.0\.1/);
    } finally {
        if (saved.url) process.env.ABLETON_SIDECAR_URL = saved.url; else delete process.env.ABLETON_SIDECAR_URL;
        if (saved.token) process.env.ABLETON_SIDECAR_TOKEN = saved.token; else delete process.env.ABLETON_SIDECAR_TOKEN;
    }
});

// ── Against the sidecar and a fake Live ────────────────────────────────────

test('through the sidecar: status, a plan, an idempotent push into Film Engine\'s own tracks, supervised transport, and a pull that says it cannot', async () => {
    const r = await liveRig();
    try {
        r.live.setTracks(['Keys (the composer\'s)']);
        const f = film();
        const st = await call('ableton_status', {});
        assert.ok(!failed(st) && st.connected && st.compatible, JSON.stringify(st));
        const sess = await call('ableton_session_read', {});
        assert.ok(!failed(sess)); assert.deepStrictEqual(sess.tracks.map(t => t.owner), ['live']);

        const plan = await call('ableton_score_push_plan', { session_id: f.sessionId });
        assert.ok(!failed(plan), JSON.stringify(plan));
        assert.strictEqual(plan.free, true);
        assert.deepStrictEqual(plan.instructions.map(i => i.action), ['create', 'create']);
        assert.ok(plan.untouched.some(t => /composer/.test(t.name)));

        const stale = await call('ableton_score_push', { session_id: f.sessionId, plan_fingerprint: 'not-the-plan' });
        assert.ok(failed(stale) && stale.code === 'STALE_PLAN');

        const pushed = await call('ableton_score_push', { session_id: f.sessionId, plan_fingerprint: plan.plan_fingerprint });
        assert.ok(!failed(pushed) && pushed.replayed === false, JSON.stringify(pushed));
        assert.strictEqual(r.live.state().tracks.filter(t => /⟨fe:/.test(t.name)).length, 2);
        assert.strictEqual(r.live.state().tracks[0].name, 'Keys (the composer\'s)');
        assert.strictEqual(r.live.state().tempo, 90);

        const again = await call('ableton_score_push', { session_id: f.sessionId, plan_fingerprint: plan.plan_fingerprint });
        assert.strictEqual(again.replayed, true, 'the same plan pushed twice reached Live twice');
        assert.strictEqual(r.live.state().tracks.filter(t => /⟨fe:/.test(t.name)).length, 2);

        const unasked = await call('ableton_transport', { session_id: f.sessionId, command: 'play' });
        assert.ok(failed(unasked) && unasked.status === 403);
        assert.strictEqual(r.live.state().playing, false);
        const moved = await call('ableton_transport', { session_id: f.sessionId, command: 'locate', position_ms: 4000, supervised: true });
        assert.ok(!failed(moved), JSON.stringify(moved));
        assert.ok(Math.abs(r.live.state().song_time - 6) < 1e-3, 'four seconds at 90 bpm is six beats');

        const pp = await call('ableton_mix_pull_plan', { session_id: f.sessionId });
        assert.ok(!failed(pp)); assert.deepStrictEqual(pp.items, []); assert.match(pp.unavailable, /package/i);
        const pull = await call('ableton_mix_pull', { session_id: f.sessionId, item_id: 'anything' });
        assert.ok(failed(pull)); assert.match(pull.error, /package/i);

        const audit = daw.listAudit(db, f.sessionId);
        assert.ok(audit.some(a => a.op === 'push' && a.adapter_id === 'ableton' && a.status === 'complete'));
        assert.ok(audit.some(a => a.op === 'transport' && a.status === 'complete'));
        assert.ok(!audit.some(a => a.op === 'transport' && a.status === 'failed' && /play/.test(a.error)), 'an unsupervised command reached the audit as an attempt');
    } finally { await r.close(); }
});

// ── The pull gate, through the tools ───────────────────────────────────────

test('a pull through the tools imports only bytes whose hash matches, as candidate takes, and a second pull of the same render reaches the DAW no more', async () => {
    const f = film();
    const built = await musicPackage.buildPackage(db, f.sessionId, { include_picture: false });
    assert.ok(built.ok, built.error);
    const bytes = fs.readFileSync(built.file_path);

    const bad = createMemoryDaw({ fault: { pull: 'wrong_bytes' } });
    bad.renderFrom(bytes);
    registry.useAdapter('ableton', bad);
    try {
        const plan = await call('ableton_mix_pull_plan', { session_id: f.sessionId });
        assert.strictEqual(plan.items.length, 1);
        const before = db.prepare('SELECT COUNT(*) n FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ?').get(f.sessionId).n;
        const r = await call('ableton_mix_pull', { session_id: f.sessionId, item_id: plan.items[0].item_id });
        assert.ok(failed(r)); assert.match(r.error, /hash/);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ?').get(f.sessionId).n, before, 'bytes that failed the hash reached the session');

        const good = createMemoryDaw();
        good.renderFrom(bytes);
        registry.useAdapter('ableton', good);
        const plan2 = await call('ableton_mix_pull_plan', { session_id: f.sessionId });
        const ok = await call('ableton_mix_pull', { session_id: f.sessionId, item_id: plan2.items[0].item_id });
        assert.ok(!failed(ok), JSON.stringify(ok));
        const takes = db.prepare("SELECT c.take_status FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ? AND c.take_status = 'candidate'").all(f.sessionId);
        assert.ok(takes.length >= 2, 'the pulled stems did not land as candidate takes');
        const again = await call('ableton_mix_pull', { session_id: f.sessionId, item_id: plan2.items[0].item_id });
        assert.strictEqual(again.replayed, true);
        assert.strictEqual(good.calls('pull'), 1, 'the same render was fetched from the DAW twice');
    } finally { registry.useAdapter('ableton', null); }
});
