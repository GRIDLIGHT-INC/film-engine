const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

/**
 * THE DETERMINISTIC BOUNCE: WHAT THE SESSION SAYS IS WHAT THE FILE HOLDS.
 *
 * MUS-008. The browser monitors a session through an AudioContext; the film
 * is delivered from a FILE, rendered on the backend from the same rows, and
 * the two must not disagree. So the renderer resolves clips and automation
 * into one ffmpeg graph, writes a 48 kHz master plus the chosen delivery
 * stems, registers every output with its render parameters, and refuses to
 * render the same inputs twice unless told to.
 *
 * Every case here PRODUCES A FILE AND MEASURES IT. Asserting the argument
 * array is the mistake the conform already paid for: arguments that look
 * right and produce an unplayable file pass every string check there is.
 * Silence is a measured level below the noise floor, a fade is a measured
 * difference between the head of a clip and its body, a pan is a channel
 * that is silent while the other is not.
 *
 * Set-based over the epic's own case list — silence, overlap, fades,
 * solo/mute, pan/gain, failures, rerender versioning — and over STEM_MODES,
 * because a bounce that renders the master and drops one stem grouping is
 * the partial failure a single example cannot see.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-bounce-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const renderer = require('../lib/music-renderer');
const route = require('../routes/music-sessions');
const { readScoreSession } = require('../lib/music-session');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { parseProbe } = require('../lib/audio-features');
const { DATA_DIR } = require('../lib/file-storage');
const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');

const bin = () => resolveFfmpeg().bin;
let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-bounce-')); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

/** A stereo tone at 48 kHz, amplitude 0.5, as a WAV under the project's music dir, registered as an asset. */
function tone(projectId, hz, seconds, opts) {
    const o = opts || {};
    const dir = path.join(DATA_DIR, 'music', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const name = `tone_${hz}_${generateId().slice(0, 6)}.wav`;
    const p = path.join(dir, name);
    execFileSync(bin(), ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=${o.rate || 48000}`,
        '-ac', '2', '-af', 'volume=0.5', '-c:a', 'pcm_s16le', p], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata)
                VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', ?, '{}')`).run(id, projectId, p, name, Math.round(seconds * 1000));
    return { id, path: p, name };
}

/** Mean level of one region, in dB, from the rendered file itself. */
function levelDb(file, fromMs, toMs, channel) {
    const af = [`atrim=start=${fromMs / 1000}:end=${toMs / 1000}`, channel === 'left' ? 'pan=mono|c0=c0' : channel === 'right' ? 'pan=mono|c0=c1' : null, 'volumedetect'].filter(Boolean).join(',');
    const r = spawnSync(bin(), ['-nostdin', '-hide_banner', '-i', file, '-af', af, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000 });
    const m = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(r.stderr || '');
    if (!m) throw new Error(`no level for ${file}: ${(r.stderr || '').slice(-300)}`);
    return m[1] === '-inf' ? -120 : Number(m[1]);
}
const probe = file => parseProbe(String(spawnSync(bin(), ['-nostdin', '-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).stderr || ''));
// ffmpeg's sine source is quiet (about -24 dB before the fixture's volume=0.5),
// so a heard tone measures around -30 dB and silence around -91: HEARD sits
// between them, and every level assertion is relative to what the fixture
// actually produces rather than to a number typed from memory.
const SILENT = -70;
const HEARD = -45;

function film(opts) {
    const o = opts || {};
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Bounce')").run(projectId);
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')").run(sceneId, projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, scene_id, name, sample_rate) VALUES (?, ?, ?, 'S', ?)").run(sessionId, projectId, sceneId, o.sample_rate || 48000);
    return { projectId, sceneId, sessionId };
}
function track(sessionId, fields) {
    const id = generateId();
    const f = { name: 'trk', role_kind: 'instrument', role: '', sort_order: 0, gain_db: 0, pan: 0, muted: 0, soloed: 0, output_track_id: null, ...fields };
    db.prepare(`INSERT INTO film_music_tracks (id, session_id, name, role_kind, role, sort_order, gain_db, pan, muted, soloed, output_track_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, sessionId, f.name, f.role_kind, f.role, f.sort_order, f.gain_db, f.pan, f.muted ? 1 : 0, f.soloed ? 1 : 0, f.output_track_id);
    return id;
}
function clip(trackId, assetId, fields) {
    const id = generateId();
    const f = { name: 'clip', source_kind: 'imported', start_ms: 0, duration_ms: 1000, source_offset_ms: 0, gain_db: 0, fade_in_ms: 0, fade_out_ms: 0, loop_policy: 'none', take_status: 'selected', ...fields };
    db.prepare(`INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, source_offset_ms, gain_db, fade_in_ms, fade_out_ms, loop_policy, take_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, trackId, assetId, f.name, f.source_kind, f.start_ms, f.duration_ms, f.source_offset_ms, f.gain_db, f.fade_in_ms, f.fade_out_ms, f.loop_policy, f.take_status);
    return id;
}
function automation(trackId, parameter, points, clipId) {
    const id = generateId();
    db.prepare(`INSERT INTO film_music_automation (id, track_id, clip_id, parameter, interpolation, points_json) VALUES (?, ?, ?, ?, 'linear', ?)`)
        .run(id, trackId, clipId || null, parameter, JSON.stringify(points));
    return id;
}
const masterOf = out => db.prepare('SELECT * FROM film_assets WHERE id = ?').get(out.master.asset_id);
const bounce = (sid, opts) => renderer.runBounce(db, sid, opts || {});

// ── The registry ───────────────────────────────────────────────────────────

test('every stem mode covers exactly the audible source tracks, and a plan spends nothing', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 1);
    const bus = track(f.sessionId, { name: 'music bus', role_kind: 'bus' });
    const strings = track(f.sessionId, { name: 'strings', role_kind: 'family', output_track_id: bus });
    const cello = track(f.sessionId, { name: 'cello', output_track_id: strings, sort_order: 1 });
    const viola = track(f.sessionId, { name: 'viola', output_track_id: strings, sort_order: 2 });
    const perc = track(f.sessionId, { name: 'perc', output_track_id: bus, sort_order: 3 });
    const ref = track(f.sessionId, { name: 'temp score', role_kind: 'reference', sort_order: 4 });
    for (const t of [cello, viola, perc, ref]) clip(t, a.id, {});
    assert.deepStrictEqual(renderer.STEM_MODES, ['none', 'instrument', 'family', 'bus'], 'the stem modes are not the four the epic names');
    const expected = {
        none: [],
        instrument: [['cello'], ['viola'], ['perc']],
        family: [['cello', 'viola'], ['perc']],
        bus: [['cello', 'viola', 'perc']],
    };
    const nameOf = id => db.prepare('SELECT name FROM film_music_tracks WHERE id = ?').get(id).name;
    for (const mode of renderer.STEM_MODES) {
        const before = db.prepare('SELECT COUNT(*) n FROM film_assets').get().n;
        const plan = renderer.planBounce(db, f.sessionId, { stems: mode });
        assert.strictEqual(plan.ok, true, `${mode}: ${plan.error}`);
        const groups = plan.stems.map(s => s.track_ids.map(nameOf).sort()).sort((x, y) => x.join().localeCompare(y.join()));
        assert.deepStrictEqual(groups, expected[mode].map(g => g.slice().sort()).sort((x, y) => x.join().localeCompare(y.join())), `${mode}: the stems do not cover the audible tracks as one group each`);
        assert.ok(!plan.clips.some(c => c.track_id === ref), `${mode}: a reference track was bounced`);
        assert.ok(plan.skipped.some(s => s.track_id === ref && /reference/.test(s.reason)), `${mode}: the reference track was dropped without a reason`);
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_assets').get().n, before, `${mode}: planning registered something`);
        assert.strictEqual(plan.sample_rate, 48000);
        assert.ok(plan.fingerprint && plan.fingerprint.length >= 16, 'no fingerprint');
    }
});

// ── Silence, overlap, fades ────────────────────────────────────────────────

test('silence is rendered as silence for exactly the session length, and a gap between clips is silent', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 1);
    const t = track(f.sessionId, {});
    clip(t, a.id, { start_ms: 1000, duration_ms: 1000 });
    clip(t, a.id, { start_ms: 3000, duration_ms: 1000 });
    const out = await bounce(f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    const m = masterOf(out);
    const p = probe(m.file_path);
    assert.strictEqual(p.sample_rate, 48000);
    assert.strictEqual(p.channels, 2);
    assert.ok(Math.abs(p.duration_ms - 4000) <= 30, `the master is ${p.duration_ms} ms for a 4000 ms session`);
    assert.ok(levelDb(m.file_path, 0, 900) < SILENT, 'the head is not silent');
    assert.ok(levelDb(m.file_path, 2100, 2900) < SILENT, 'the gap is not silent');
    assert.ok(levelDb(m.file_path, 1100, 1900) > HEARD, 'the clip is not heard');
    assert.ok(levelDb(m.file_path, 3100, 3900) > HEARD, 'the second clip is not heard');
});

test('overlapping clips are both heard, and nothing is normalised away', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 2), b = tone(f.projectId, 660, 2);
    const t1 = track(f.sessionId, {}), t2 = track(f.sessionId, { sort_order: 1 });
    clip(t1, a.id, { start_ms: 0, duration_ms: 2000 });
    clip(t2, b.id, { start_ms: 1000, duration_ms: 2000 });
    const out = await bounce(f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    const m = masterOf(out).file_path;
    const alone = levelDb(m, 100, 900), both = levelDb(m, 1100, 1900), tail = levelDb(m, 2100, 2900);
    assert.ok(both - alone > 2 && both - alone < 4, `two equal tones should sum to ~+3 dB, got ${(both - alone).toFixed(2)} (a mixer that normalises by input count halves them)`);
    assert.ok(Math.abs(alone - tail) < 0.5, 'a lone clip is not at the same level everywhere');
});

test('a fade is a ramp inside the clip: the head is quieter than the body, the tail quieter than the body', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 2);
    const t = track(f.sessionId, {});
    clip(t, a.id, { duration_ms: 2000, fade_in_ms: 500, fade_out_ms: 500 });
    const out = await bounce(f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    const m = masterOf(out).file_path;
    const head = levelDb(m, 0, 250), body = levelDb(m, 800, 1200), tail = levelDb(m, 1750, 2000);
    assert.ok(body - head > 6, `fade-in: head ${head} vs body ${body}`);
    assert.ok(body - tail > 6, `fade-out: tail ${tail} vs body ${body}`);
});

// ── Solo, mute, gain, pan, automation, loop ────────────────────────────────

test('a muted track is absent, a soloed track silences the rest, and both are named in the plan', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 1), b = tone(f.projectId, 660, 1);
    const t1 = track(f.sessionId, { name: 'kept' }), t2 = track(f.sessionId, { name: 'muted', muted: 1, sort_order: 1 });
    clip(t1, a.id, { start_ms: 0 }); const cm = clip(t2, b.id, { start_ms: 2000 });
    let out = await bounce(f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    let m = masterOf(out).file_path;
    assert.ok(levelDb(m, 100, 900) > HEARD, 'the kept track is not heard');
    assert.ok(levelDb(m, 2100, 2900) < SILENT, 'the muted track is heard');
    assert.ok(out.plan.skipped.some(s => s.clip_id === cm && /muted/.test(s.reason)), 'the muted clip was dropped without saying so');

    // Solo the other one: now the first is silent, the muted one stays silent (mute beats solo).
    db.prepare('UPDATE film_music_tracks SET muted = 0 WHERE id = ?').run(t2);
    const t3 = track(f.sessionId, { name: 'solo', soloed: 1, sort_order: 2 });
    clip(t3, a.id, { start_ms: 4000 });
    out = await bounce(f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    m = masterOf(out).file_path;
    assert.ok(levelDb(m, 100, 900) < SILENT, 'a track is heard while another is soloed');
    assert.ok(levelDb(m, 2100, 2900) < SILENT, 'a second unsoloed track is heard');
    assert.ok(levelDb(m, 4100, 4900) > HEARD, 'the soloed track is silent');
    assert.ok(out.plan.skipped.filter(s => /solo/.test(s.reason)).length === 2, 'the unsoloed clips are dropped without saying so');
});

test('track and clip gain sum in dB, and a hard pan leaves the other channel silent', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 1);
    const ref = track(f.sessionId, { name: 'ref' });
    const quiet = track(f.sessionId, { name: 'quiet', gain_db: -6, sort_order: 1 });
    const left = track(f.sessionId, { name: 'left', pan: -1, sort_order: 2 });
    clip(ref, a.id, { start_ms: 0 });
    clip(quiet, a.id, { start_ms: 2000, gain_db: -6 });
    clip(left, a.id, { start_ms: 4000 });
    const out = await bounce(f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    const m = masterOf(out).file_path;
    const r = levelDb(m, 100, 900), q = levelDb(m, 2100, 2900);
    assert.ok(Math.abs((r - q) - 12) < 1, `-6 dB on the track and -6 dB on the clip should be 12 dB down, got ${(r - q).toFixed(2)}`);
    assert.ok(levelDb(m, 4100, 4900, 'right') < SILENT, 'a hard-left clip is heard on the right');
    assert.ok(levelDb(m, 4100, 4900, 'left') > HEARD, 'a hard-left clip is silent on the left');
    assert.ok(Math.abs(levelDb(m, 100, 900, 'left') - levelDb(m, 100, 900, 'right')) < 0.5, 'a centred clip is not equal on both channels');
});

test('gain automation is rendered as a ramp, and a curve on a parameter the renderer cannot draw is named', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 2);
    const t = track(f.sessionId, {});
    clip(t, a.id, { duration_ms: 2000 });
    automation(t, 'gain', [{ at_ms: 0, value: -60 }, { at_ms: 2000, value: 0 }]);
    automation(t, 'pan', [{ at_ms: 0, value: -1 }, { at_ms: 2000, value: 1 }]);
    const out = await bounce(f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    const m = masterOf(out).file_path;
    const early = levelDb(m, 100, 400), late = levelDb(m, 1600, 1900);
    assert.ok(late - early > 20, `gain automation is not a ramp: early ${early}, late ${late}`);
    assert.ok(out.plan.warnings.some(w => /pan/.test(w) && /automation/.test(w)), 'pan automation was silently not rendered');
});

test('a looping clip fills its own length from a shorter file; a non-looping one falls silent', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 0.5);
    const t1 = track(f.sessionId, { name: 'loop' }), t2 = track(f.sessionId, { name: 'once', sort_order: 1 });
    clip(t1, a.id, { start_ms: 0, duration_ms: 2000, loop_policy: 'loop' });
    clip(t2, a.id, { start_ms: 3000, duration_ms: 2000, loop_policy: 'none' });
    const out = await bounce(f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    const m = masterOf(out).file_path;
    assert.ok(levelDb(m, 1600, 1900) > HEARD, 'the loop stopped before the clip ended');
    assert.ok(levelDb(m, 4600, 4900) < SILENT, 'a non-looping clip kept sounding past its file');
    assert.ok(levelDb(m, 3100, 3400) > HEARD, 'the non-looping clip did not sound at all');
});

// ── 48 kHz, stems, registration ────────────────────────────────────────────

test('a 44.1 kHz session with a 44.1 kHz file still delivers 48 kHz stereo 24-bit, and says so', async () => {
    const f = film({ sample_rate: 44100 });
    const a = tone(f.projectId, 440, 1, { rate: 44100 });
    const t = track(f.sessionId, {});
    clip(t, a.id, {});
    const out = await bounce(f.sessionId, { stems: 'instrument' });
    assert.strictEqual(out.ok, true, out.error);
    for (const asset of [masterOf(out), ...out.stems.map(s => db.prepare('SELECT * FROM film_assets WHERE id = ?').get(s.asset_id))]) {
        const p = probe(asset.file_path);
        assert.strictEqual(p.sample_rate, 48000, `${asset.file_name} is ${p.sample_rate} Hz`);
        assert.strictEqual(p.channels, 2);
        assert.match(p.codec || '', /pcm_s24le/, `${asset.file_name} is ${p.codec}`);
        assert.strictEqual(asset.asset_type === 'audio_mix' || asset.asset_type === 'audio_music', true);
        const meta = JSON.parse(asset.metadata);
        assert.strictEqual(meta.sample_rate, 48000);
        assert.strictEqual(meta.session_id, f.sessionId);
    }
    assert.ok(out.plan.warnings.some(w => /44100/.test(w) && /48000/.test(w)), 'the resampling from the session rate is not stated');
    assert.strictEqual(out.stems.length, 1);
    assert.deepStrictEqual(JSON.parse(masterOf(out).metadata).kind, 'bounce_master');
    assert.deepStrictEqual(JSON.parse(db.prepare('SELECT metadata FROM film_assets WHERE id = ?').get(out.stems[0].asset_id).metadata).kind, 'bounce_stem');
    assert.strictEqual(masterOf(out).asset_type, 'audio_mix', 'the master is not registered as a mix');
});

test('every output is registered with its render parameters, and the operation names them all', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 1);
    const bus = track(f.sessionId, { name: 'bus', role_kind: 'bus' });
    const t1 = track(f.sessionId, { name: 'cello', output_track_id: bus, sort_order: 1 });
    const t2 = track(f.sessionId, { name: 'perc', output_track_id: bus, sort_order: 2 });
    clip(t1, a.id, {}); clip(t2, a.id, { start_ms: 500 });
    const out = await bounce(f.sessionId, { stems: 'instrument' });
    assert.strictEqual(out.ok, true, out.error);
    const op = db.prepare('SELECT * FROM film_music_operations WHERE id = ?').get(out.operation_id);
    assert.strictEqual(op.kind, 'bounce'); assert.strictEqual(op.status, 'complete');
    assert.strictEqual(op.output_asset_id, out.master.asset_id);
    const params = JSON.parse(op.params_json);
    assert.strictEqual(params.fingerprint, out.plan.fingerprint, 'the operation does not record the fingerprint it rendered');
    assert.ok(Array.isArray(params.ffmpeg_args) && params.ffmpeg_args.length > 4, 'the encoder invocation is not recorded');
    assert.strictEqual(params.stems_mode, 'instrument');
    assert.deepStrictEqual(params.outputs.map(o => o.asset_id).sort(), [out.master.asset_id, ...out.stems.map(s => s.asset_id)].sort(), 'the operation does not name every output');
    assert.strictEqual(params.version, 1);
    for (const o of [out.master, ...out.stems]) {
        assert.ok(o.url && /^\/film\/music\//.test(o.url), `${o.name}: no served url`);
        const row = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(o.asset_id);
        assert.ok(fs.existsSync(row.file_path), `${o.name}: the file is not where the row says`);
        assert.ok(row.size_bytes > 1000 && row.duration_ms > 0);
        const meta = JSON.parse(row.metadata);
        assert.strictEqual(meta.operation_id, out.operation_id);
        assert.strictEqual(meta.bounce_version, 1);
    }
    // Two stems, equal length, and the master's length — the interchange baseline.
    const lengths = [out.master, ...out.stems].map(o => probe(db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(o.asset_id).file_path).duration_ms);
    assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 30, `stems are not equal length: ${lengths.join(', ')}`);
    // The read model lists the bounce as an operation, with its output.
    const model = readScoreSession(db, f.sessionId);
    assert.ok(model.operations.some(o => o.id === out.operation_id && o.output_asset_id === out.master.asset_id));
});

// ── Failures ───────────────────────────────────────────────────────────────

test('a clip whose file is gone refuses the bounce and names the clip; an encoder failure leaves a failed operation and no files', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 1);
    const t = track(f.sessionId, {});
    const c = clip(t, a.id, { name: 'lost' });
    fs.unlinkSync(a.path);
    const plan = renderer.planBounce(db, f.sessionId, {});
    assert.strictEqual(plan.ok, false, 'a missing file was planned around');
    assert.match(plan.error, /lost/, 'the refusal does not name the clip');
    const refused = await bounce(f.sessionId);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM film_music_operations WHERE session_id = ? AND kind = 'bounce'").get(f.sessionId).n, 0, 'a refused plan wrote an operation');

    // A session with nothing audible is refused, not rendered as a minute of silence.
    const empty = film();
    track(empty.sessionId, {});
    const nothing = renderer.planBounce(db, empty.sessionId, {});
    assert.strictEqual(nothing.ok, false);
    assert.match(nothing.error, /no audible clips|nothing to bounce/i);

    // The encoder fails: the operation records it, registers nothing, leaves nothing.
    const g = film();
    const b = tone(g.projectId, 440, 1);
    clip(track(g.sessionId, {}), b.id, {});
    const before = db.prepare('SELECT COUNT(*) n FROM film_assets').get().n;
    const dir = path.join(DATA_DIR, 'music', g.projectId);
    const filesBefore = fs.readdirSync(dir).length;
    const bad = await bounce(g.sessionId, { bin: '/nonexistent/ffmpeg' });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /encoder|ffmpeg|ENOENT/i);
    const op = db.prepare("SELECT * FROM film_music_operations WHERE session_id = ? AND kind = 'bounce'").get(g.sessionId);
    assert.ok(op && op.status === 'failed' && op.error_message.length > 5, 'the failure is not recorded on the operation');
    assert.strictEqual(op.output_asset_id, null);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_assets').get().n, before, 'a failed render registered an asset');
    assert.strictEqual(fs.readdirSync(dir).length, filesBefore, 'a failed render left files behind');
    void c;
});

// ── Rerender versioning ────────────────────────────────────────────────────

test('the same inputs are not rendered twice unless forced; a change renders a new version that supersedes, and every version survives', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 1);
    const t = track(f.sessionId, {});
    const c = clip(t, a.id, {});
    const v1 = await bounce(f.sessionId);
    assert.strictEqual(v1.ok, true, v1.error);
    assert.strictEqual(v1.version, 1);

    const again = await bounce(f.sessionId);
    assert.strictEqual(again.ok, false, 'identical inputs were rendered again');
    assert.match(again.error, /unchanged|already/i);
    assert.strictEqual(again.code, 'UNCHANGED');
    assert.strictEqual(again.previous_operation_id, v1.operation_id);

    const forced = await bounce(f.sessionId, { force: true });
    assert.strictEqual(forced.ok, true, forced.error);
    assert.strictEqual(forced.version, 2);
    assert.strictEqual(forced.supersedes, v1.operation_id);

    db.prepare('UPDATE film_music_clips SET gain_db = -6 WHERE id = ?').run(c);
    const changed = await bounce(f.sessionId);
    assert.strictEqual(changed.ok, true, changed.error);
    assert.strictEqual(changed.version, 3);
    assert.notStrictEqual(changed.plan.fingerprint, v1.plan.fingerprint);
    assert.strictEqual(changed.supersedes, forced.operation_id);

    // Every version is still registered and on disk: a bounce is a take, not an overwrite.
    for (const v of [v1, forced, changed]) {
        const row = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(v.master.asset_id);
        assert.ok(row && fs.existsSync(row.file_path), `version ${v.version} is gone`);
    }
    const list = renderer.listBounces(db, f.sessionId);
    assert.deepStrictEqual(list.map(b => b.version), [3, 2, 1]);
    assert.strictEqual(list[0].current, true);
    assert.strictEqual(list[0].master.asset_id, changed.master.asset_id);
});

// ── The route and the tools ────────────────────────────────────────────────

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, writeHead(c) { this.statusCode = c; return this; }, end(p) { resolve({ status: this.statusCode, body: JSON.parse(p || '{}') }); } };
        const query = Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''));
        Promise.resolve(route.handleMusicSessions({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean), query)).catch(reject);
    });
}

test('plan, bounce and the list are served, and reachable over MCP as free-plan / do / list', async () => {
    const f = film();
    const a = tone(f.projectId, 440, 1);
    clip(track(f.sessionId, {}), a.id, {});
    const plan = await call('GET', `/film/music-sessions/${f.sessionId}/bounce/plan?stems=instrument`);
    assert.strictEqual(plan.status, 200, JSON.stringify(plan.body).slice(0, 200));
    assert.strictEqual(plan.body.ok, true);
    assert.strictEqual(plan.body.stems.length, 1);
    const done = await call('POST', `/film/music-sessions/${f.sessionId}/bounce`, { stems: 'none' });
    assert.strictEqual(done.status, 201, JSON.stringify(done.body).slice(0, 200));
    assert.strictEqual(done.body.version, 1);
    const twice = await call('POST', `/film/music-sessions/${f.sessionId}/bounce`, {});
    assert.strictEqual(twice.status, 409, 'an unchanged rerender is not a conflict');
    const list = await call('GET', `/film/music-sessions/${f.sessionId}/bounces`);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.bounces.length, 1);
    const one = await call('GET', `/film/music-sessions/${f.sessionId}/bounces/${done.body.operation_id}`);
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body.status, 'complete');
    assert.ok(one.body.master.url);
    assert.strictEqual((await call('GET', `/film/music-sessions/${f.sessionId}/bounces/${generateId()}`)).status, 404);
    assert.strictEqual((await call('POST', `/film/music-sessions/${f.sessionId}/bounce`, { stems: 'sideways' })).status, 400, 'an unknown stem mode was accepted');

    const tools = Object.fromEntries(['music_bounce_plan', 'music_bounce', 'music_bounce_list'].map(n => [n, PRODUCTION_TOOLS.find(t => t.name === n)]));
    for (const [n, t] of Object.entries(tools)) assert.ok(t, `no ${n} tool`);
    assert.strictEqual(tools.music_bounce_plan.method, 'GET');
    assert.match(tools.music_bounce_plan.description, /free/i);
    assert.strictEqual(tools.music_bounce.method, 'POST');
    assert.match(tools.music_bounce.description, /48 ?kHz/i);
    assert.match(tools.music_bounce.description, /spends nothing|no provider|local/i);
    assert.match(tools.music_bounce.description, /unchanged|force/i);
    assert.deepStrictEqual(tools.music_bounce.schema.stems.enum, renderer.STEM_MODES);
    assert.strictEqual(tools.music_bounce_list.method, 'GET');
    assert.strictEqual(tools.music_bounce.path({ session_id: 'S' }), '/film/music-sessions/S/bounce');
    assert.strictEqual(tools.music_bounce_list.path({ session_id: 'S' }), '/film/music-sessions/S/bounces');
});
