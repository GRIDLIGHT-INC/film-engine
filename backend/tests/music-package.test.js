const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * A SCORE THAT LEAVES FILM ENGINE AND COMES BACK: ONE ARCHIVE, BYTE-STABLE,
 * THAT ANY DAW OR PERSON CAN OPEN AND THAT FILM ENGINE CAN READ BACK.
 *
 * MUS-015. The portable score package is the interchange baseline the epic
 * puts before any DAW adapter: a versioned, DAW-neutral manifest plus
 * equal-length, aligned 48 kHz BWF stems rendered from the session itself,
 * the reference picture when there is one, and everything needed to put the
 * stems back where they came from.
 *
 * Set-based three ways:
 *   - over the manifest's own sections: every one is written, and a package
 *     missing any one is refused by name;
 *   - over the failure set a package can arrive in — a tampered stem, a
 *     missing file, an unlisted file, a stem of a different length, a wrong
 *     sample rate, an unknown version, a foreign format — each refused naming
 *     what is wrong, and an import of it writes nothing;
 *   - over the round trip: into a new session everything is restored
 *     aligned; back into the session it came from, every stem finds its
 *     track by its matching key and lands as a candidate take beside what the
 *     track already holds, never over it.
 *
 * And deterministic: the same session builds the same bytes, twice.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-pkg-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const pkg = require('../lib/music-package');
const { readZip } = require('../lib/music-separation');
const { readScoreSession } = require('../lib/music-session');
const route = require('../routes/music-sessions');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');
const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');

const bin = () => resolveFfmpeg().bin;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function toneBytes(hz, seconds, rate) {
    const p = path.join(os.tmpdir(), `pkg_${generateId().slice(0, 8)}.wav`);
    execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=${rate || 48000}`, '-ac', '2', '-c:a', 'pcm_s24le', p], { stdio: 'pipe', timeout: 120000 });
    const b = fs.readFileSync(p); fs.unlinkSync(p); return b;
}

function film(opts) {
    const o = opts || {};
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Pkg')").run(projectId);
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, name, frame_rate, tempo_map_json) VALUES (?, ?, 'Night drive', 24, ?)")
        .run(sessionId, projectId, JSON.stringify([{ at_ms: 0, bpm: 90, numerator: 4, denominator: 4 }, { at_ms: 2000, bpm: 90, numerator: 3, denominator: 4 }]));
    const dir = path.join(DATA_DIR, 'music', projectId); fs.mkdirSync(dir, { recursive: true });
    const tracks = [];
    for (const [i, t] of [['strings', 'strings', 220], ['drums', 'drums', 330]].entries()) {
        const bytes = toneBytes(t[2], 3);
        const file = path.join(dir, `src_${t[0]}_${generateId().slice(0, 6)}.wav`); fs.writeFileSync(file, bytes);
        const assetId = generateId();
        db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata, license_source, license_status, provider) VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 3000, ?, 'external', 'cleared', 'composer')")
            .run(assetId, projectId, file, path.basename(file), JSON.stringify({ hash: sha(bytes), kind: 'stem_original' }));
        db.prepare("INSERT INTO film_rights (id, project_id, entity_type, entity_id, subject, rights_type, status, owner, source) VALUES (?, ?, 'music', ?, ?, 'music_license', 'cleared', 'The Composer', 'commissioned')").run(generateId(), projectId, assetId, t[0]);
        const trackId = generateId();
        db.prepare("INSERT INTO film_music_tracks (id, session_id, name, role, sort_order) VALUES (?, ?, ?, ?, ?)").run(trackId, sessionId, t[0], t[1], i);
        const clipId = generateId();
        db.prepare("INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, source_offset_ms, take_status) VALUES (?, ?, ?, ?, 'imported', ?, 3000, 0, 'selected')").run(clipId, trackId, assetId, t[0], i * 500);
        tracks.push({ trackId, clipId, assetId });
    }
    db.prepare("INSERT INTO film_music_markers (id, session_id, kind, position_ms, label) VALUES (?, ?, 'hit', 1500, 'door slam')").run(generateId(), sessionId);
    db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, valence, arousal, intensity, source, status) VALUES (?, ?, 0, 3500, 'unease', -0.3, 0.5, 0.5, 'director', 'accepted')").run(generateId(), sessionId);
    if (o.picture) {
        const p = path.join(dir, `master_${generateId().slice(0, 6)}.mp4`);
        execFileSync(bin(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24:duration=1', '-pix_fmt', 'yuv420p', p], { stdio: 'pipe', timeout: 120000 });
        db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata, version) VALUES (?, ?, 'video_final', ?, ?, 'mp4', 'video/mp4', 1000, ?, 1)")
            .run(generateId(), projectId, p, path.basename(p), JSON.stringify({ kind: 'project_master' }));
    }
    return { projectId, sessionId, tracks };
}

/** Rebuild a ZIP from entries, the way a person repacking a folder would. */
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
const entriesOf = buf => { const r = readZip(buf); assert.ok(r.ok, r.error); return r.entries; };
const manifestOf = buf => JSON.parse(entriesOf(buf).find(e => e.name === 'manifest.json').bytes.toString('utf8'));
function repack(buf, change) {
    const entries = entriesOf(buf).map(e => ({ name: e.name, bytes: e.bytes }));
    const manifest = JSON.parse(entries.find(e => e.name === 'manifest.json').bytes.toString('utf8'));
    const out = change(entries, manifest) || entries;
    const m = out.find(e => e.name === 'manifest.json');
    if (m) m.bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    return zipOf(out);
}
/** A WAV's rate, channel count, bytes per sample and frame count, and whether it carries a bext chunk. */
function wavFacts(buf) {
    assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF'); assert.strictEqual(buf.toString('ascii', 8, 12), 'WAVE');
    let p = 12, fmt = null, frames = null, bext = null;
    while (p + 8 <= buf.length) {
        const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
        if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
        // EBU Tech 3285: Description is 256 bytes (the key fits); OriginatorReference is only 32.
        if (id === 'bext') bext = { description: buf.toString('ascii', p + 8, p + 8 + 256).replace(/\0+$/, ''), originator: buf.toString('ascii', p + 8 + 256, p + 8 + 288).replace(/\0+$/, ''), timeRef: buf.readUInt32LE(p + 8 + 338) };
        if (id === 'data') frames = size / (fmt.channels * fmt.bits / 8);
        p += 8 + size + (size % 2);
    }
    return { ...fmt, frames, bext };
}

// ── The manifest ───────────────────────────────────────────────────────────

test('a build writes every manifest section, equal-length aligned BWF stems with their matching keys, and the files it lists', async () => {
    const f = film();
    const out = await pkg.buildPackage(db, f.sessionId);
    assert.strictEqual(out.ok, true, out.error);
    const buf = fs.readFileSync(out.file_path);
    assert.strictEqual(sha(buf), out.sha256);
    const m = manifestOf(buf);
    for (const s of pkg.MANIFEST_SECTIONS) assert.ok(s in m, `the manifest has no ${s}`);
    assert.strictEqual(m.format, pkg.FORMAT);
    assert.strictEqual(m.version, pkg.VERSION);
    assert.strictEqual(m.session.id, f.sessionId);
    assert.ok(m.operations.bounce_operation_id, 'the bounce the stems came from is not named');
    assert.deepStrictEqual([m.timing.sample_rate, m.timing.frame_rate], [48000, 24]);
    assert.deepStrictEqual(m.timing.tempo_map.map(t => `${t.at_ms}:${t.numerator}/${t.denominator}`), ['0:4/4', '2000:3/4'], 'the time-signature map is not carried');
    assert.deepStrictEqual(m.markers.map(k => [k.kind, k.position_ms, k.label]), [['hit', 1500, 'door slam']]);
    assert.deepStrictEqual(m.emotion.map(r => r.label), ['unease']);
    assert.strictEqual(m.picture.included, false); assert.match(m.picture.reason, /no conformed film/i);

    // Stems: one per sounding track, equal length, 48 kHz, BWF with the key and a zero time reference.
    const entries = entriesOf(buf);
    const frames = new Set();
    assert.strictEqual(m.stems.length, 2);
    for (const s of m.stems) {
        const e = entries.find(x => x.name === s.path);
        assert.ok(e, `${s.path} is listed and not in the archive`);
        const w = wavFacts(e.bytes);
        assert.strictEqual(w.rate, 48000); assert.strictEqual(w.bits, 24);
        assert.strictEqual(w.frames, m.timing.length_samples, `${s.path} is not the session's length`);
        frames.add(w.frames);
        assert.ok(w.bext, `${s.path} carries no bext chunk`);
        assert.ok(w.bext.description.startsWith(s.key), `${s.path}'s BWF description does not lead with its matching key`);
        assert.strictEqual(w.bext.originator, 'Film Engine');
        assert.strictEqual(w.bext.timeRef, 0, `${s.path} is not aligned to the session start`);
        assert.ok(m.tracks.some(t => t.key === s.key && t.stem === s.path), `${s.path} is not tied to a track`);
    }
    assert.strictEqual(frames.size, 1, 'the stems are not all the same length');
    assert.ok(entries.find(e => e.name === m.master.path), 'no master in the archive');

    // Placement, rights, provenance, hashes, keys.
    for (const t of f.tracks) {
        const tr = m.tracks.find(x => x.id === t.trackId);
        assert.ok(tr && tr.key === `fe:track:${t.trackId}`);
        const clip = tr.clips.find(c => c.id === t.clipId);
        assert.ok(clip && clip.key === `fe:clip:${t.clipId}`);
        assert.strictEqual(clip.start_samples, Math.round(clip.start_ms * 48));
        assert.ok(clip.asset_sha256, 'a clip does not carry its source hash');
        const r = m.rights.find(x => x.asset_id === t.assetId);
        assert.ok(r && r.status === 'cleared' && r.owner === 'The Composer', 'the source rights are not carried');
        assert.ok(m.provenance.some(p => p.asset_id === t.assetId), 'the source provenance is not carried');
    }
    for (const fl of m.files) {
        const e = entries.find(x => x.name === fl.path);
        assert.ok(e, `${fl.path} missing`);
        assert.strictEqual(sha(e.bytes), fl.sha256, `${fl.path}: hash`);
        assert.strictEqual(e.bytes.length, fl.bytes);
    }
    assert.strictEqual(m.matching.session_key, `fe:session:${f.sessionId}`);
    assert.strictEqual(pkg.validatePackage(buf).ok, true, JSON.stringify(pkg.validatePackage(buf).errors));
});

test('the same session builds the same bytes; a changed session builds a different package; entries are sorted with fixed times', async () => {
    const f = film();
    const a = await pkg.buildPackage(db, f.sessionId);
    const bounces = db.prepare("SELECT COUNT(*) n FROM film_music_operations WHERE session_id = ? AND kind = 'bounce'").get(f.sessionId).n;
    const b = await pkg.buildPackage(db, f.sessionId);
    assert.ok(a.ok && b.ok);
    assert.strictEqual(a.sha256, b.sha256, 'two builds of an unchanged session differ');
    assert.strictEqual(a.asset_id, b.asset_id, 'an identical package was registered twice');
    assert.strictEqual(b.reused, true);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM film_music_operations WHERE session_id = ? AND kind = 'bounce'").get(f.sessionId).n, bounces, 'an unchanged session was rendered again');
    const buf = fs.readFileSync(a.file_path);
    const names = entriesOf(buf).map(e => e.name);
    assert.deepStrictEqual(names, names.slice().sort(), 'entries are not in a stable order');
    // Every local header carries the fixed DOS time (00:00) and date (1980-01-01).
    for (let p = 0; p < buf.length - 4; p++) {
        if (buf.readUInt32LE(p) === 0x04034b50) { assert.strictEqual(buf.readUInt16LE(p + 10), 0); assert.strictEqual(buf.readUInt16LE(p + 12), 0x21); }
    }
    db.prepare('UPDATE film_music_tracks SET gain_db = -6 WHERE id = ?').run(f.tracks[0].trackId);
    const c = await pkg.buildPackage(db, f.sessionId);
    assert.ok(c.ok, c.error);
    assert.notStrictEqual(c.sha256, a.sha256, 'a changed mix packaged to the same bytes');
    assert.notStrictEqual(manifestOf(fs.readFileSync(c.file_path)).package.id, manifestOf(buf).package.id);
    assert.strictEqual(pkg.listPackages(db, f.sessionId).length, 2);
});

test('the reference picture is packaged with its hash when the film has a master', async () => {
    const f = film({ picture: true });
    const out = await pkg.buildPackage(db, f.sessionId);
    assert.ok(out.ok, out.error);
    const buf = fs.readFileSync(out.file_path);
    const m = manifestOf(buf);
    assert.strictEqual(m.picture.included, true);
    const e = entriesOf(buf).find(x => x.name === m.picture.path);
    assert.ok(e, 'the picture is listed and not packaged');
    assert.strictEqual(sha(e.bytes), m.picture.sha256);
    assert.strictEqual(m.picture.frame_rate, 24);
});

// ── Validation ─────────────────────────────────────────────────────────────

test('a package missing any manifest section, or arriving broken in any of the known ways, is refused naming what is wrong', async () => {
    const f = film();
    const out = await pkg.buildPackage(db, f.sessionId);
    const good = fs.readFileSync(out.file_path);
    for (const s of pkg.MANIFEST_SECTIONS) {
        const bad = repack(good, (entries, m) => { delete m[s]; });
        const v = pkg.validatePackage(bad);
        assert.strictEqual(v.ok, false, `a package with no ${s} validated`);
        assert.ok(v.errors.some(e => e.includes(s)), `the refusal does not name ${s}: ${v.errors}`);
    }
    const shorter = toneBytes(440, 1);
    const wrongRate = toneBytes(440, 3, 44100);
    const CASES = {
        'tampered stem': [(entries, m) => { const e = entries.find(x => x.name === m.stems[0].path); e.bytes = Buffer.from(e.bytes); e.bytes[e.bytes.length - 1] ^= 0xff; }, /hash|sha256/i],
        'missing file': [(entries, m) => entries.filter(x => x.name !== m.stems[1].path), /missing|not in the archive/i],
        'unlisted file': [(entries) => [...entries, { name: 'stems/99_extra.wav', bytes: shorter }], /not listed|unlisted/i],
        'stem of another length': [(entries, m) => { const e = entries.find(x => x.name === m.stems[0].path); e.bytes = shorter; const fl = m.files.find(x => x.path === e.name); fl.sha256 = sha(shorter); fl.bytes = shorter.length; }, /length|samples/i],
        'wrong sample rate': [(entries, m) => { const e = entries.find(x => x.name === m.stems[0].path); e.bytes = wrongRate; const fl = m.files.find(x => x.path === e.name); fl.sha256 = sha(wrongRate); fl.bytes = wrongRate.length; }, /44100|sample rate/i],
        'unknown version': [(entries, m) => { m.version = 99; }, /version 99/],
        'foreign format': [(entries, m) => { m.format = 'some-other-daw'; }, /format/i],
    };
    for (const [name, [change, expect]] of Object.entries(CASES)) {
        const bad = repack(good, change);
        const v = pkg.validatePackage(bad);
        assert.strictEqual(v.ok, false, `${name}: validated`);
        assert.match(v.errors.join(' | '), expect, `${name}: ${v.errors}`);
        // Importing it writes nothing.
        const target = film();
        const before = { assets: db.prepare('SELECT COUNT(*) n FROM film_assets').get().n, sessions: db.prepare('SELECT COUNT(*) n FROM film_music_sessions').get().n };
        const imp = pkg.importPackage(db, target.projectId, bad, {});
        assert.strictEqual(imp.ok, false, `${name}: imported`);
        assert.deepStrictEqual({ assets: db.prepare('SELECT COUNT(*) n FROM film_assets').get().n, sessions: db.prepare('SELECT COUNT(*) n FROM film_music_sessions').get().n }, before, `${name}: an import of it wrote something`);
    }
    assert.strictEqual(pkg.validatePackage(Buffer.from('not a zip at all, sorry')).ok, false);
});

// ── Import and the round trip ──────────────────────────────────────────────

test('importing into a new session restores the arrangement aligned, with the tempo map, markers, arc, hashes and rights', async () => {
    const f = film();
    const out = await pkg.buildPackage(db, f.sessionId);
    const buf = fs.readFileSync(out.file_path);
    const m = manifestOf(buf);
    const other = film();
    const imp = pkg.importPackage(db, other.projectId, buf, {});
    assert.strictEqual(imp.ok, true, imp.error);
    assert.notStrictEqual(imp.session_id, f.sessionId);
    const s = readScoreSession(db, imp.session_id);
    assert.strictEqual(s.session.project_id, other.projectId);
    assert.deepStrictEqual(s.session.tempo_map.map(t => `${t.at_ms}:${t.numerator}/${t.denominator}`), ['0:4/4', '2000:3/4']);
    assert.deepStrictEqual(s.markers.map(k => k.label), ['door slam']);
    assert.deepStrictEqual(s.emotion_ranges.map(r => [r.label, r.status]), [['unease', 'accepted']]);
    assert.strictEqual(s.tracks.length, m.stems.length);
    for (const t of s.tracks) {
        assert.strictEqual(t.clips.length, 1);
        const c = t.clips[0];
        assert.deepStrictEqual([c.start_ms, c.source_offset_ms, c.duration_ms, c.source_kind], [0, 0, m.timing.length_ms, 'imported'], 'an imported stem is not aligned to the session start');
        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(c.asset_id);
        const meta = JSON.parse(asset.metadata);
        const stem = m.stems.find(x => x.key === meta.matching_key);
        assert.ok(stem, 'the imported stem does not remember its matching key');
        assert.strictEqual(sha(fs.readFileSync(asset.file_path)), m.files.find(x => x.path === stem.path).sha256, 'the stem was not stored byte-identical');
        const rights = db.prepare('SELECT * FROM film_rights WHERE entity_id = ?').get(asset.id);
        assert.ok(rights && rights.status === 'cleared', 'the rights did not travel');
        assert.match(rights.notes, new RegExp(m.package.id));
    }
    const op = db.prepare('SELECT * FROM film_music_operations WHERE id = ?').get(imp.operation_id);
    assert.deepStrictEqual([op.kind, op.status], ['import', 'complete']);
    assert.strictEqual(JSON.parse(op.params_json).package_id, m.package.id);
});

test('back into the session it came from, every stem finds its track by key and lands as a candidate take; what was there is untouched', async () => {
    const f = film();
    const out = await pkg.buildPackage(db, f.sessionId);
    const buf = fs.readFileSync(out.file_path);
    const before = readScoreSession(db, f.sessionId);
    // A track deleted since the package was made has no home: its stem gets a new track.
    db.prepare('DELETE FROM film_music_tracks WHERE id = ?').run(f.tracks[1].trackId);
    const imp = pkg.importPackage(db, f.projectId, buf, { session_id: f.sessionId });
    assert.strictEqual(imp.ok, true, imp.error);
    assert.deepStrictEqual([imp.matched, imp.created], [1, 1]);
    const after = readScoreSession(db, f.sessionId);
    const kept = after.tracks.find(t => t.id === f.tracks[0].trackId);
    const original = kept.clips.find(c => c.id === f.tracks[0].clipId);
    const was = before.tracks.find(t => t.id === f.tracks[0].trackId).clips.find(c => c.id === f.tracks[0].clipId);
    assert.deepStrictEqual([original.asset_id, original.start_ms, original.duration_ms, original.take_status], [was.asset_id, was.start_ms, was.duration_ms, 'selected'], 'the original clip was changed');
    const returned = kept.clips.find(c => c.id !== f.tracks[0].clipId);
    assert.ok(returned, 'the matched stem did not land on its track');
    assert.strictEqual(returned.take_status, 'candidate');
    assert.ok(returned.take_group && returned.take_group === original.take_group, 'the returned stem is not a take beside the original');
    assert.strictEqual(after.tracks.length, before.tracks.length, 'a matched stem made a new track, or the unmatched one did not');
    assert.deepStrictEqual(after.tempo_map || after.session.tempo_map, before.session.tempo_map, 'the session tempo map was overwritten by an import');
    assert.strictEqual(after.markers.length, before.markers.length, 'markers were duplicated into the session they came from');
});

// ── Served, and reachable ──────────────────────────────────────────────────

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, writeHead(c) { this.statusCode = c; return this; }, end(p) { resolve({ status: this.statusCode, body: JSON.parse(p || '{}') }); } };
        Promise.resolve(route.handleMusicSessions({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean), {})).catch(reject);
    });
}

test('build, list, validate and import are served, and the tools say what writes and what is free', async () => {
    const f = film();
    const built = await call('POST', `/film/music-sessions/${f.sessionId}/package`, {});
    assert.strictEqual(built.status, 201, JSON.stringify(built.body).slice(0, 300));
    assert.ok(built.body.asset_id && built.body.url && built.body.sha256);
    const list = await call('GET', `/film/music-sessions/${f.sessionId}/packages`);
    assert.strictEqual(list.status, 200); assert.strictEqual(list.body.packages.length, 1);
    const other = film();
    const check = await call('POST', `/film/projects/${other.projectId}/music-packages/import`, { asset_id: built.body.asset_id, validate_only: true });
    assert.strictEqual(check.status, 200, JSON.stringify(check.body).slice(0, 300)); assert.strictEqual(check.body.ok, true);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_music_sessions WHERE project_id = ?').get(other.projectId).n, 1, 'validating wrote a session');
    const bytes = fs.readFileSync(db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(built.body.asset_id).file_path);
    const imp = await call('POST', `/film/projects/${other.projectId}/music-packages/import`, { data: 'data:application/zip;base64,' + bytes.toString('base64') });
    assert.strictEqual(imp.status, 201, JSON.stringify(imp.body).slice(0, 300));
    const bad = await call('POST', `/film/projects/${other.projectId}/music-packages/import`, { data: Buffer.from('nope').toString('base64') });
    assert.strictEqual(bad.status, 400);

    const by = n => PRODUCTION_TOOLS.find(t => t.name === n);
    for (const n of ['music_package_build', 'music_package_list', 'music_package_validate', 'music_package_import']) assert.ok(by(n), `no ${n}`);
    assert.match(by('music_package_build').description, /spends nothing|free/i);
    assert.match(by('music_package_validate').description, /writes nothing/i);
    assert.match(by('music_package_import').description, /candidate|never over/i);
    assert.strictEqual(by('music_package_validate').path({ project_id: 'P' }), '/film/projects/P/music-packages/import');
});
