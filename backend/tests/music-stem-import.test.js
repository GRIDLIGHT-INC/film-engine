const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * ALIGNED STEM IMPORT: THE ORIGINAL IS SACRED, THE PLACEMENT IS ALIGNED.
 *
 * MUS-006. A composer hands over instrument stems — several equal-length
 * files that share a start — and the one thing an importer must never do is
 * help: no trimming the head, no implicit warping, no re-encoding the file it
 * was given. So the original is stored byte-for-byte and hashed, its
 * technical facts are read from the file rather than the name, an optional
 * 48 kHz WORKING copy is made beside it with the resampling recorded, the
 * rights are written down (unknown is a recorded answer), and the tracks and
 * clips land in one transaction with a common start and a zero source
 * offset. Leading silence survives because nothing touches the bytes.
 *
 * Set-based over the library's STEM_FORMATS registry: every format it claims
 * to accept is built for real, imported under a name that lies about it, and
 * held to the same rules.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-stems-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const stems = require('../lib/music-stems');
const route = require('../routes/music-sessions');
const { readScoreSession } = require('../lib/music-session');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
const { parseProbe } = require('../lib/audio-features');
const { DATA_DIR } = require('../lib/file-storage');
const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');

const bin = () => resolveFfmpeg().bin;
let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-stems-')); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

/** A 1s 440Hz stereo tone at 44.1 kHz with 250ms of leading silence, in one format. */
function fixture(formatId) {
    const enc = { wav: ['-c:a', 'pcm_s16le'], aiff: ['-c:a', 'pcm_s16be'], flac: ['-c:a', 'flac'], mp3: ['-c:a', 'libmp3lame', '-b:a', '128k'], m4a: ['-c:a', 'aac'] }[formatId];
    assert.ok(enc, `this suite cannot build a ${formatId} fixture`);
    const p = path.join(TMP, `${formatId}_${generateId().slice(0, 6)}.${formatId}`);
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
        '-af', 'adelay=250|250', '-ac', '2', '-ar', '44100', ...enc, p], { stdio: 'pipe', timeout: 120000 });
    return fs.readFileSync(p);
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const probe = file => {
    const r = require('child_process').spawnSync(bin(), ['-hide_banner', '-i', file], { encoding: 'utf8' });
    return parseProbe(String(r.stderr || ''));
};

function session() {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Stems')").run(projectId);
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')").run(sceneId, projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, scene_id, name) VALUES (?, ?, ?, 'S')").run(sessionId, projectId, sceneId);
    return { projectId, sceneId, sessionId };
}
const counts = sid => ({
    tracks: db.prepare('SELECT COUNT(*) n FROM film_music_tracks WHERE session_id = ?').get(sid).n,
    clips: db.prepare('SELECT COUNT(*) n FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id WHERE t.session_id = ?').get(sid).n,
    ops: db.prepare('SELECT COUNT(*) n FROM film_music_operations WHERE session_id = ?').get(sid).n,
});
const assetsOf = pid => db.prepare("SELECT * FROM film_assets WHERE project_id = ? AND metadata LIKE '%\"kind\":\"stem_%' ORDER BY created_at, id").all(pid);
const rightsOf = pid => db.prepare('SELECT * FROM film_rights WHERE project_id = ?').all(pid);

// ── The registry ───────────────────────────────────────────────────────────

test('the format registry names the five the epic requires, and each sniffs its own bytes and nobody else\'s', () => {
    const reg = stems.STEM_FORMATS;
    for (const id of ['wav', 'aiff', 'flac', 'mp3', 'm4a']) assert.ok(reg[id], `no ${id} in STEM_FORMATS`);
    const samples = Object.fromEntries(Object.keys(reg).map(id => [id, fixture(id)]));
    for (const [id, spec] of Object.entries(reg)) {
        assert.ok(spec.ext && spec.mime && typeof spec.sniff === 'function' && typeof spec.lossless === 'boolean', `${id}: incomplete entry`);
        assert.strictEqual(stems.detectFormat(samples[id]), id, `${id}: its own bytes were not recognised`);
        for (const [other, bytes] of Object.entries(samples)) {
            if (other === id) continue;
            assert.notStrictEqual(spec.sniff(bytes) ? id : null, id === other ? null : id, `${id} claims ${other}'s bytes`);
        }
    }
    assert.strictEqual(stems.detectFormat(Buffer.from('this is not audio at all, however long it is made to be')), null);
});

// ── Every format, held to the same rules ───────────────────────────────────

test('every format: the original is stored byte-identical under its true extension, measured, hashed, placed at offset zero', async () => {
    for (const [id, spec] of Object.entries(stems.STEM_FORMATS)) {
        const s = session();
        const bytes = fixture(id);
        // A name that lies: the bytes decide.
        const lie = id === 'wav' ? 'take.bin' : `take_${id}.wav`;
        const out = await stems.importStems(db, s.sessionId, {
            files: [{ name: lie, bytes, role: 'cello' }],
            start_ms: 500,
            rights: { status: 'cleared', owner: 'Me', source: 'own recording' },
        });
        assert.strictEqual(out.ok, true, `${id}: ${JSON.stringify(out.error || out.errors)}`);
        assert.strictEqual(out.imported.length, 1);
        const item = out.imported[0];

        const original = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(item.asset_id);
        assert.ok(original, `${id}: no original asset row`);
        assert.ok(original.file_name.endsWith(`.${spec.ext}`), `${id}: stored as ${original.file_name}, not .${spec.ext}`);
        assert.ok(original.file_path.startsWith(DATA_DIR), `${id}: stored outside the data dir`);
        assert.strictEqual(sha(fs.readFileSync(original.file_path)), sha(bytes), `${id}: the original was changed on the way in`);
        assert.strictEqual(original.asset_type, 'audio_music');
        assert.strictEqual(original.license_source, 'external');
        const meta = JSON.parse(original.metadata);
        assert.strictEqual(meta.kind, 'stem_original');
        assert.strictEqual(meta.hash, sha(bytes), `${id}: the recorded hash is not the file's`);
        assert.strictEqual(meta.session_id, s.sessionId);
        assert.strictEqual(meta.format, id);
        assert.strictEqual(meta.lossless, spec.lossless);
        assert.strictEqual(meta.tech.channels, 2, `${id}: channels ${meta.tech.channels}`);
        assert.strictEqual(meta.tech.sample_rate, 44100, `${id}: sample rate ${meta.tech.sample_rate}`);
        assert.ok(Math.abs(meta.tech.duration_ms - 1250) < 150, `${id}: duration ${meta.tech.duration_ms}`);
        if (spec.lossless) assert.strictEqual(meta.tech.bit_depth, 16, `${id}: bit depth ${meta.tech.bit_depth}`);
        else assert.strictEqual(meta.tech.bit_depth, null, `${id}: a lossy file claims a bit depth`);
        assert.ok(meta.tech.codec, `${id}: no codec`);

        // The arrangement: one track, one clip, aligned, untrimmed.
        const model = readScoreSession(db, s.sessionId);
        const track = model.tracks.find(t => t.id === item.track_id);
        assert.ok(track, `${id}: no track`);
        assert.strictEqual(track.role, 'cello');
        const clip = track.clips.find(c => c.id === item.clip_id);
        assert.ok(clip, `${id}: no clip`);
        assert.strictEqual(clip.start_ms, 500, `${id}: the common start was not honoured`);
        assert.strictEqual(clip.source_offset_ms, 0, `${id}: leading silence was trimmed by offset`);
        assert.strictEqual(clip.source_kind, 'imported');
        assert.strictEqual(clip.take_status, 'selected');
        assert.ok(Math.abs(clip.duration_ms - meta.tech.duration_ms) <= 1, `${id}: clip length is not the measured length`);
        assert.strictEqual(clip.asset_id, item.asset_id, `${id}: with no derivative the clip must reference the original`);

        // Rights and lineage.
        const rights = db.prepare('SELECT * FROM film_rights WHERE entity_id = ?').get(item.asset_id);
        assert.ok(rights, `${id}: no rights row`);
        assert.deepStrictEqual([rights.status, rights.owner, rights.entity_type, rights.rights_type], ['cleared', 'Me', 'music', 'music_license']);
        assert.strictEqual(rights.id, item.rights_id);
        const op = db.prepare('SELECT * FROM film_music_operations WHERE id = ?').get(out.operation_id);
        assert.ok(op && op.kind === 'import' && op.status === 'complete', `${id}: no complete import operation`);
        assert.strictEqual(clip.source_operation_id, out.operation_id, `${id}: the clip does not name the import that made it`);
    }
});

// ── The working copy ───────────────────────────────────────────────────────

test('a 48 kHz working derivative is optional, recorded, and the original stays; a file already at 48 kHz gets none', async () => {
    const s = session();
    const bytes = fixture('mp3');
    const out = await stems.importStems(db, s.sessionId, { files: [{ name: 'lead.mp3', bytes }], normalize_48k: true });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    const item = out.imported[0];
    assert.ok(item.working_asset_id, 'no working derivative was made');
    const working = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(item.working_asset_id);
    assert.ok(working.file_name.endsWith('.wav'));
    const seen = probe(working.file_path);
    assert.strictEqual(seen.sample_rate, 48000, `working copy is ${seen.sample_rate} Hz`);
    const wm = JSON.parse(working.metadata);
    assert.strictEqual(wm.kind, 'stem_working');
    assert.strictEqual(wm.derived_from, item.asset_id, 'the working copy does not name its original');
    assert.deepStrictEqual(wm.resample, { from: 44100, to: 48000 }, 'the resampling was not recorded');
    assert.ok(Math.abs(inspectMedia(working.file_path).durationSeconds * 1000 - 1250) < 150, 'the working copy is a different length');
    // The original is untouched and still hashed as given.
    const original = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(item.asset_id);
    assert.strictEqual(sha(fs.readFileSync(original.file_path)), sha(bytes));
    // The clip plays the working copy.
    const clip = readScoreSession(db, s.sessionId).tracks[0].clips[0];
    assert.strictEqual(clip.asset_id, item.working_asset_id);

    // Already 48 kHz and lossless: nothing to normalise, and it says so.
    const p48 = path.join(TMP, `at48_${generateId().slice(0, 6)}.wav`);
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000', '-ac', '2', '-c:a', 'pcm_s24le', p48], { stdio: 'pipe' });
    const same = await stems.importStems(db, s.sessionId, { files: [{ name: 'at48.wav', bytes: fs.readFileSync(p48) }], normalize_48k: true });
    assert.strictEqual(same.ok, true);
    assert.strictEqual(same.imported[0].working_asset_id, null, 'a 48 kHz lossless file was resampled to itself');
    assert.match(same.imported[0].normalized_note || '', /already 48/i);
    assert.strictEqual(JSON.parse(db.prepare('SELECT metadata FROM film_assets WHERE id = ?').get(same.imported[0].asset_id).metadata).tech.bit_depth, 24);
});

// ── Batch: aligned, ordered, atomic ────────────────────────────────────────

test('a batch lands every file at one common start, in the order given, as separate tracks', async () => {
    const s = session();
    const files = [['drums.wav', fixture('wav')], ['bass.flac', fixture('flac')], ['keys.m4a', fixture('m4a')]].map(([name, bytes]) => ({ name, bytes }));
    const out = await stems.importStems(db, s.sessionId, { files, start_ms: 1000 });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    const model = readScoreSession(db, s.sessionId);
    assert.deepStrictEqual(model.tracks.map(t => t.name), ['drums', 'bass', 'keys'], 'tracks are not in the order the files were given');
    assert.deepStrictEqual(model.tracks.map(t => t.sort_order), [0, 1, 2]);
    for (const t of model.tracks) {
        assert.strictEqual(t.clips.length, 1);
        assert.strictEqual(t.clips[0].start_ms, 1000, `${t.name} does not share the common start`);
        assert.strictEqual(t.clips[0].source_offset_ms, 0);
    }
    assert.strictEqual(counts(s.sessionId).ops, 1, 'a batch is one import operation, not three');
    // The roles were inferred from the names when none was given.
    assert.deepStrictEqual(model.tracks.map(t => t.role), ['drums', 'bass', 'keys']);
});

test('a batch with one unreadable file writes nothing: no rows, no files', async () => {
    const s = session();
    const before = { ...counts(s.sessionId), assets: assetsOf(s.projectId).length, rights: rightsOf(s.projectId).length };
    const dir = path.join(DATA_DIR, 'music', s.projectId);
    const filesBefore = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    const out = await stems.importStems(db, s.sessionId, { files: [
        { name: 'good.wav', bytes: fixture('wav') },
        // Sniffs as a WAV and decodes as nothing: the good file is already on
        // disk when this one is refused, which is what makes the cleanup real.
        { name: 'bad.wav', bytes: Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(64, 0x5a)]) },
    ] });
    assert.strictEqual(out.ok, false, 'a batch with garbage in it succeeded');
    assert.match(out.error, /bad\.wav/, 'the refusal does not name the file');
    assert.deepStrictEqual({ ...counts(s.sessionId), assets: assetsOf(s.projectId).length, rights: rightsOf(s.projectId).length }, before, 'a failed batch left rows behind');
    const filesAfter = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    assert.strictEqual(filesAfter, filesBefore, 'a failed batch left files on disk');
});

// ── Hints and rights ───────────────────────────────────────────────────────

test('BPM and key hints are read from the name, and are hints', async () => {
    const s = session();
    const out = await stems.importStems(db, s.sessionId, { files: [{ name: 'pad_120bpm_Am.wav', bytes: fixture('wav') }] });
    assert.strictEqual(out.ok, true);
    const meta = JSON.parse(db.prepare('SELECT metadata FROM film_assets WHERE id = ?').get(out.imported[0].asset_id).metadata);
    assert.deepStrictEqual(meta.hints, { bpm: 120, key: 'Am', from: 'filename' });
    const none = await stems.importStems(db, s.sessionId, { files: [{ name: 'take.wav', bytes: fixture('wav') }] });
    const m2 = JSON.parse(db.prepare('SELECT metadata FROM film_assets WHERE id = ?').get(none.imported[0].asset_id).metadata);
    assert.deepStrictEqual(m2.hints, { bpm: null, key: null, from: null }, 'a hint was invented');
});

test('rights are recorded, never assumed: no declaration is written down as unknown', async () => {
    const s = session();
    const out = await stems.importStems(db, s.sessionId, { files: [{ name: 'x.wav', bytes: fixture('wav') }] });
    const r = db.prepare('SELECT * FROM film_rights WHERE entity_id = ?').get(out.imported[0].asset_id);
    assert.strictEqual(r.status, 'unknown');
    assert.strictEqual(db.prepare('SELECT license_status FROM film_assets WHERE id = ?').get(out.imported[0].asset_id).license_status, 'unknown');
    const bad = await stems.importStems(db, s.sessionId, { files: [{ name: 'y.wav', bytes: fixture('wav') }], rights: { status: 'probably fine' } });
    assert.strictEqual(bad.ok, false, 'an unlisted rights status was accepted');
    assert.match(bad.error, /status/);
});

// ── The route and the tool ─────────────────────────────────────────────────

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, writeHead(c) { this.statusCode = c; return this; }, end(p) { resolve({ status: this.statusCode, body: JSON.parse(p || '{}') }); } };
        Promise.resolve(route.handleMusicSessions({ method, url, body: body || {} }, res, url.split('/').filter(Boolean), {})).catch(reject);
    });
}

test('POST /music-sessions/:id/stems imports from data URIs, refuses an empty batch, and is reachable over MCP', async () => {
    const s = session();
    const data = `data:audio/wav;base64,${fixture('wav').toString('base64')}`;
    const res = await call('POST', `/film/music-sessions/${s.sessionId}/stems`, { files: [{ name: 'guitar.wav', data }], start_ms: 0 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.imported.length, 1);
    assert.ok(res.body.imported[0].url, 'the import does not say where the file is served');
    assert.strictEqual((await call('POST', `/film/music-sessions/${s.sessionId}/stems`, { files: [] })).status, 400);
    assert.strictEqual((await call('POST', `/film/music-sessions/${generateId()}/stems`, { files: [{ name: 'g.wav', data }] })).status, 404);

    const t = PRODUCTION_TOOLS.find(x => x.name === 'music_stem_import');
    assert.ok(t, 'no music_stem_import tool');
    assert.strictEqual(t.method, 'POST');
    assert.strictEqual(t.path({ session_id: 'S' }), '/film/music-sessions/S/stems');
    assert.match(t.description, /free|spends nothing/i);
    assert.match(t.description, /48 ?kHz/i);
    assert.match(t.description, /leading silence|never trim/i);
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-tools.js'), 'utf8');
    assert.match(src, /name: 'music_stem_import'/);
});
