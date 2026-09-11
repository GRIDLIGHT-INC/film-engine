const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

/**
 * A SCORED PROJECT, CARRIED TO ANOTHER MACHINE AND FINISHED THERE.
 *
 * MUS-021. The project bundle carries every score-session table the schema
 * declares — sessions, tracks, clips, emotion ranges, markers, automation,
 * operations and their job children, DAW links — the picture sequences the
 * sessions sit on, and every file they name, each with its sha256. On import
 * every id is new and every reference to an old one, in a column or inside
 * JSON, is rewritten; every path points into this machine's data directory; a
 * damaged file refuses the whole import; and a broken reference rolls it back.
 *
 * Proven by doing it: a real scored film is exported, the original is DELETED
 * — rows and files — and the bundle is imported. The imported project then
 * reopens, plays, rebounces and reassembles with no original machine and no
 * DAW. Set-based over the score tables read out of the migrations, so a table
 * added later arrives in the bundle or fails here.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-mbundle-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const bundle = require('../lib/project-bundle');
const approval = require('../lib/music-approval');
const renderer = require('../lib/music-renderer');
const musicPackage = require('../lib/music-package');
const { readScoreSession } = require('../lib/music-session');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');
const { PATH_COLUMNS, resolveStored } = require('../lib/data-paths');

const bin = () => resolveFfmpeg().bin;
const sh = args => execFileSync(bin(), ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe', timeout: 120000 });
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The score tables, from the migrations themselves. */
function scoreTables() {
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const out = new Set(['film_sequences']);
    for (const f of fs.readdirSync(dir)) {
        for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (film_music_(?!cues|jobs)\w+)/g)) out.add(m[1]);
    }
    return [...out];
}
const fkOf = table => db.prepare(`PRAGMA foreign_key_list(${table})`).all();
function meanDb(file, fromS, durS) {
    const r = spawnSync(bin(), ['-ss', String(fromS), '-t', String(durS), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000 });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(r.stderr || ''));
    return m ? Number(m[1]) : null;
}

/** A scored film with one of everything a session can hold. */
async function scoredFilm() {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, target_fps) VALUES (?, 'Carried', 24)").run(projectId);
    const dir = t => { const d = path.join(DATA_DIR, t, projectId); fs.mkdirSync(d, { recursive: true }); return d; };
    const scene = [], shot = {};
    for (const n of [1, 2]) {
        const sid = generateId(); scene.push(sid);
        db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, 'ROOM')").run(sid, projectId, String(n));
        for (const [i, letter] of ['A', 'B'].entries()) {
            const code = `${n}${letter}`, id = generateId(); shot[code] = id;
            db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, ?, ?, 2000, ?)").run(id, sid, code, JSON.stringify({ shot_code: code, camera: {} }), i);
            const clip = path.join(dir('video'), `${code}.mp4`);
            sh(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-c:v', 'libx264', '-r', '24', '-t', '2', '-pix_fmt', 'yuv420p', clip]);
            db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms) VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 2000)").run(generateId(), projectId, id, clip, path.basename(clip));
        }
        const legacy = path.join(dir('music'), `legacy_${n}.wav`);
        sh(['-f', 'lavfi', '-i', `sine=frequency=${300 + 100 * n}:duration=4:sample_rate=48000`, '-ac', '2', '-c:a', 'pcm_s24le', legacy]);
        db.prepare("INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_path, file_name, format, duration_ms) VALUES (?, ?, ?, 'audio_music', ?, ?, 'wav', 4000)").run(generateId(), projectId, sid, legacy, path.basename(legacy));
    }
    const seq = generateId();
    db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Scene 2', ?)").run(seq, projectId, JSON.stringify([shot['2A'], shot['2B']]));
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, sequence_id, name, status, tempo_map_json) VALUES (?, ?, ?, 'Score', 'review', ?)").run(sessionId, projectId, seq, JSON.stringify([{ at_ms: 0, bpm: 100, numerator: 4, denominator: 4 }]));
    const cue = path.join(dir('music'), 'cue.wav');
    sh(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=4:sample_rate=48000', '-ac', '2', '-c:a', 'pcm_s24le', cue]);
    const asset = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata) VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 4000, ?)").run(asset, projectId, cue, 'cue.wav', JSON.stringify({ hash: sha(cue), session_id: sessionId }));
    const track = generateId();
    db.prepare("INSERT INTO film_music_tracks (id, session_id, name, role, sort_order) VALUES (?, ?, 'strings', 'strings', 0)").run(track, sessionId);
    const clip = generateId();
    db.prepare("INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, take_status) VALUES (?, ?, ?, 'cue', 'imported', 0, 4000, 'selected')").run(clip, track, asset);
    db.prepare("INSERT INTO film_music_emotion_ranges (id, session_id, start_ms, end_ms, label, source, status) VALUES (?, ?, 0, 4000, 'longing', 'director', 'accepted')").run(generateId(), sessionId);
    db.prepare("INSERT INTO film_music_markers (id, session_id, shot_id, kind, position_ms, label) VALUES (?, ?, ?, 'hit', 2000, 'door')").run(generateId(), sessionId, shot['2B']);
    db.prepare("INSERT INTO film_music_automation (id, track_id, clip_id, parameter, points_json) VALUES (?, ?, ?, 'gain', ?)").run(generateId(), track, clip, JSON.stringify([{ at_ms: 0, value: 0 }, { at_ms: 3000, value: -3 }]));
    // A job: a parent with one child that names its clip, and a retry naming its parent.
    const parent = generateId(), child = generateId(), retry = generateId();
    db.prepare("INSERT INTO film_music_operations (id, session_id, kind, status, params_json) VALUES (?, ?, 'generate', 'failed', ?)").run(parent, sessionId, JSON.stringify({ workflow: 'music_compose', track_id: track }));
    db.prepare("INSERT INTO film_music_operations (id, session_id, kind, status, group_id, seq, output_clip_id, output_asset_id, params_json) VALUES (?, ?, 'generate', 'complete', ?, 1, ?, ?, '{}')").run(child, sessionId, parent, clip, asset);
    db.prepare("INSERT INTO film_music_operations (id, session_id, kind, status, parent_id, attempt, params_json) VALUES (?, ?, 'generate', 'complete', ?, 2, '{}')").run(retry, sessionId, parent);
    db.prepare("INSERT INTO film_music_daw_links (id, session_id, adapter_id, fe_key, kind, external_id, revision) VALUES (?, ?, 'ableton', ?, 'track', 'fe:0123456789', 'r1')").run(generateId(), sessionId, `fe:track:${track}`);

    const b = await renderer.runBounce(db, sessionId, {});
    assert.ok(b.ok, b.error);
    assert.ok(approval.approveMix(db, sessionId).ok);
    const pkg = await musicPackage.buildPackage(db, sessionId, { include_picture: false });
    assert.ok(pkg.ok, pkg.error);
    return { projectId, sessionId, shot, scene, pkgAssetId: pkg.asset_id };
}

function snapshot(projectId) {
    const rows = {};
    for (const { table, filter } of bundle.EXPORT_TABLES) {
        try { rows[table] = db.prepare(`SELECT * FROM ${table} WHERE ${filter}`).all(projectId); } catch (_) { rows[table] = []; }
    }
    return rows;
}
function deleteOriginal(projectId) {
    db.prepare('DELETE FROM film_projects WHERE id = ?').run(projectId);
    for (const d of fs.readdirSync(DATA_DIR)) { const p = path.join(DATA_DIR, d, projectId); if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
}

let RUN = null;
async function carried() {
    if (RUN) return RUN;
    const f = await scoredFilm();
    const before = snapshot(f.projectId);
    const hashes = Object.fromEntries(before.film_assets.filter(a => a.file_path).map(a => [a.id, sha(resolveStored(a.file_path))]));
    const { archivePath, manifest } = bundle.exportProject(f.projectId);
    const bytes = fs.readFileSync(archivePath);
    deleteOriginal(f.projectId);
    const out = bundle.importProject(bytes);
    RUN = { f, before, hashes, manifest, bytes, out, newId: out.project.id, after: snapshot(out.project.id) };
    return RUN;
}

// ── The set ────────────────────────────────────────────────────────────────

test('every score table the migrations declare, and the sequences sessions sit on, travel in the bundle', () => {
    const tables = bundle.EXPORT_TABLES.map(t => t.table);
    for (const t of scoreTables()) assert.ok(tables.includes(t), `${t} is not in the bundle`);
    // Parents before children, so every reference exists by the time a row lands.
    for (const t of scoreTables()) {
        for (const fk of fkOf(t)) {
            if (fk.table === t || !tables.includes(fk.table)) continue;
            // A mutual reference (a clip names the operation that made it; an operation names its output clip)
            // has no parent-first order; the import checks references after every row has landed instead.
            if (fkOf(fk.table).some(back => back.table === t)) continue;
            assert.ok(tables.indexOf(fk.table) < tables.indexOf(t), `${t} is imported before ${fk.table}, which it references`);
        }
    }
});

test('a scored project carried to a clean machine: every row, every id new, every reference rewritten, every file present and byte-identical', async () => {
    const r = await carried();
    for (const t of scoreTables()) {
        assert.strictEqual(r.after[t].length, r.before[t].length, `${t}: ${r.before[t].length} rows left, ${r.after[t].length} arrived`);
        assert.ok(r.before[t].length > 0, `${t}: the fixture exercises nothing`);
    }
    // No old id survives anywhere in what arrived, in a column or inside JSON.
    const old = new Set(Object.values(r.before).flat().map(x => x.id).filter(Boolean));
    for (const [t, rows] of Object.entries(r.after)) {
        for (const row of rows) for (const [col, v] of Object.entries(row)) {
            if (typeof v !== 'string') continue;
            for (const id of v.match(UUID) || []) assert.ok(!old.has(id), `${t}.${col} still names an id from the other machine (${id})`);
        }
    }
    // Every reference resolves inside the new project.
    for (const t of scoreTables().concat(['film_assets'])) {
        for (const fk of fkOf(t)) {
            for (const row of r.after[t]) {
                const v = row[fk.from];
                if (v == null) continue;
                assert.ok(db.prepare(`SELECT 1 FROM ${fk.table} WHERE ${fk.to || 'id'} = ?`).get(v), `${t}.${fk.from} → ${fk.table} ${v} does not exist`);
            }
        }
    }
    // Every file: here, under this data directory, byte-identical.
    const byOld = new Map(r.before.film_assets.map(a => [a.file_name + '|' + a.asset_type, a]));
    for (const a of r.after.film_assets.filter(x => x.file_path)) {
        const p = resolveStored(a.file_path);
        assert.ok(p.startsWith(DATA_DIR) && p.includes(r.newId), `${a.file_name} does not point into the new project (${a.file_path})`);
        assert.ok(fs.existsSync(p), `${a.file_name} is not on disk`);
        const o = byOld.get(a.file_name + '|' + a.asset_type);
        if (o) assert.strictEqual(sha(p), r.hashes[o.id], `${a.file_name} arrived different`);
    }
    for (const spec of PATH_COLUMNS) for (const row of r.after[spec.table] || []) {
        const v = row[spec.column];
        if (v) assert.ok(!v.includes(r.f.projectId), `${spec.table}.${spec.column} still points at the old project`);
    }
    assert.ok(Array.isArray(r.manifest.files) && r.manifest.files.length > 0 && r.manifest.files.every(x => /^[0-9a-f]{64}$/.test(x.sha256)), 'the manifest carries no hashes');
});

test('the imported project reopens, plays, rebounces and reassembles with no original machine and no DAW', async () => {
    const r = await carried();
    const sid = r.after.film_music_sessions[0].id;
    // Reopen: the arrangement as it was, and the approval still the approved mix.
    const model = readScoreSession(db, sid);
    assert.strictEqual(model.tracks.length, 1); assert.strictEqual(model.tracks[0].clips.length, 1);
    assert.strictEqual(model.session.status, 'approved');
    const scores = approval.approvedScores(db, r.newId);
    assert.strictEqual(scores.scores.length, 1, JSON.stringify(scores.reports));
    assert.strictEqual(scores.scores[0].state, 'ok', `the carried approval reads as ${scores.scores[0].state}: ${scores.scores[0].reasons}`);
    // Play: the timeline's score bed is a file on this machine.
    const tl = require('../routes/timeline').loadTimeline(r.newId);
    const bed = tl.beds.find(b => b.source === 'score_session');
    assert.ok(bed && fs.existsSync(bed.path) && bed.start_ms === 4000);
    // Rebounce: nothing changed, so an unforced bounce in the latest render's own stems mode is refused as
    // unchanged (the carried render is still current); a forced one renders here, on this machine.
    const latest = renderer.listBounces(db, sid).find(b => b.current);
    const again = await renderer.runBounce(db, sid, { stems: latest.stems_mode });
    assert.strictEqual(again.ok, false); assert.strictEqual(again.code || again.status, again.code ? 'UNCHANGED' : 409);
    const forced = await renderer.runBounce(db, sid, { force: true });
    assert.ok(forced.ok, forced.error);
    // The package still validates.
    const pkg = r.after.film_assets.find(a => a.metadata && /score_package|"kind":"package"/.test(a.metadata)) || r.after.film_assets.find(a => /score_package_/.test(a.file_name));
    assert.ok(pkg, 'the score package did not travel');
    assert.ok(musicPackage.validatePackage(fs.readFileSync(resolveStored(pkg.file_path))).ok);
    // Reassemble: the master, with the score where it belongs.
    const out = await require('../lib/conform').runConform(r.newId, { filename: 'carried_master' });
    assert.ok(out.ok, out.error);
    assert.ok(meanDb(out.output, 4.5, 3) > -45, 'the carried score is not in the reassembled master');
    assert.ok(Math.abs(inspectMedia(out.output).durationSeconds - 8) < 0.3);
});

test('a damaged file in the bundle refuses the whole import, and nothing is written', async () => {
    const r = await carried();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-bad-bundle-'));
    const arc = path.join(dir, 'b.tar.gz');
    fs.writeFileSync(arc, r.bytes);
    const x = path.join(dir, 'x'); fs.mkdirSync(x);
    execFileSync('tar', ['xzf', arc, '-C', x]);
    const victim = path.join(x, 'music', 'cue.wav');
    assert.ok(fs.existsSync(victim));
    const buf = fs.readFileSync(victim); buf[buf.length - 10] ^= 0xff; fs.writeFileSync(victim, buf);
    const bad = path.join(dir, 'bad.tar.gz');
    execFileSync('tar', ['czf', bad, '-C', x, '.']);
    const projects = db.prepare('SELECT COUNT(*) n FROM film_projects').get().n;
    const sessions = db.prepare('SELECT COUNT(*) n FROM film_music_sessions').get().n;
    assert.throws(() => bundle.importProject(fs.readFileSync(bad)), /cue\.wav/);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_projects').get().n, projects, 'a damaged bundle created a project');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_music_sessions').get().n, sessions);
});
