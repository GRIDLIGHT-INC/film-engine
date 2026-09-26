const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

/**
 * THE APPROVED SCORE REACHES THE FILM ONCE, AT ITS OWN PLACE, AND NOTHING
 * PLAYS UNDER IT.
 *
 * MUS-020. A score session is approved EXPLICITLY — a bounce is selected, and
 * a bounce made before the session last changed is refused — and every
 * surface that assembles the film then consumes that one mix: the timeline
 * and the playback that reads it, the project and per-shot audio mix, the
 * pipeline's scene music step, the three NLE exports and the conformed
 * master. Set-based over `SCORE_CONSUMERS`: a consumer with no probe here
 * fails, so a seventh surface arrives covered or not at all.
 *
 * The fixture is a real film: two scenes of two shots, real clips, legacy
 * scene music on both scenes, and a session over scene 2's sequence whose
 * bounce is a real render. Scene 1 keeps its legacy music; scene 2's legacy
 * music is dropped under the approved score, which starts exactly where scene
 * 2's first shot starts. The master is MEASURED: scene 1's own music before
 * the score, the score's tone after.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-score-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const approval = require('../lib/music-approval');
const renderer = require('../lib/music-renderer');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');
const mcp = require('../lib/mcp-tools');

const bin = () => resolveFfmpeg().bin;
const sh = args => execFileSync(bin(), ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe', timeout: 120000 });
let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-score-')); });

function silentClip(name, secs) {
    const p = path.join(TMP, name);
    sh(['-f', 'lavfi', '-i', `color=c=blue:s=320x240:d=${secs}`, '-c:v', 'libx264', '-r', '24', '-t', String(secs), '-pix_fmt', 'yuv420p', p]);
    return p;
}
function tone(dir, name, hz, secs) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    sh(['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}:sample_rate=48000`, '-ac', '2', '-c:a', 'pcm_s24le', p]);
    return p;
}
function meanDb(file, fromS, durS) {
    const r = spawnSync(bin(), ['-ss', String(fromS), '-t', String(durS), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000 });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(r.stderr || ''));
    return m ? Number(m[1]) : null;
}
const call = (handler, method, url, body) => new Promise(resolve => {
    const out = [];
    const res = {
        statusCode: 200, headers: {},
        setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); return this; },
        write(p) { out.push(String(p)); },
        end(p) { if (p) out.push(String(p)); const text = out.join(''); let body = text; try { body = JSON.parse(text); } catch (_) { /* xml */ } resolve({ status: this.statusCode, body, text }); },
    };
    Promise.resolve(handler({ method, url, body: body || {}, headers: {} }, res, url.split('?')[0].split('/').filter(Boolean), {}))
        .then(r => { if (r === false) resolve({ status: 404, body: {} }); })
        .catch(err => resolve({ status: 500, body: { error: err.message } }));
});
const sessions = () => require('../routes/music-sessions').handleMusicSessions;

/** Two scenes, two shots each, two seconds each; legacy music on both scenes; a session over scene 2. */
function film() {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, target_fps) VALUES (?, 'Scored', 24)").run(projectId);
    const musicDir = path.join(DATA_DIR, 'music', projectId);
    const scene = [], shot = {};
    for (const n of [1, 2]) {
        const sid = generateId(); scene.push(sid);
        db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, 'ROOM')").run(sid, projectId, String(n));
        for (const [i, letter] of ['A', 'B'].entries()) {
            const code = `${n}${letter}`, id = generateId(); shot[code] = id;
            db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, ?, ?, 2000, ?)")
                .run(id, sid, code, JSON.stringify({ shot_code: code, camera: {} }), i);
            const clip = silentClip(`${projectId.slice(0, 6)}_${code}.mp4`, 2);
            db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms) VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 2000)")
                .run(generateId(), projectId, id, clip, path.basename(clip));
        }
        const legacy = tone(musicDir, `legacy_${n}_${generateId().slice(0, 6)}.wav`, 300 + n * 100, 4);
        db.prepare("INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_path, file_name, format, duration_ms) VALUES (?, ?, ?, 'audio_music', ?, ?, 'wav', 4000)")
            .run(generateId(), projectId, sid, legacy, path.basename(legacy));
    }
    const seq = generateId();
    db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Scene 2', ?)").run(seq, projectId, JSON.stringify([shot['2A'], shot['2B']]));
    const sessionId = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, sequence_id, name, status) VALUES (?, ?, ?, 'Score', 'review')").run(sessionId, projectId, seq);
    const cue = tone(musicDir, `cue_${generateId().slice(0, 6)}.wav`, 880, 4);
    const asset = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms, metadata) VALUES (?, ?, 'audio_music', ?, ?, 'wav', 'audio/wav', 4000, '{}')").run(asset, projectId, cue, path.basename(cue));
    const track = generateId();
    db.prepare("INSERT INTO film_music_tracks (id, session_id, name, role, sort_order) VALUES (?, ?, 'strings', 'strings', 0)").run(track, sessionId);
    const clipId = generateId();
    db.prepare("INSERT INTO film_music_clips (id, track_id, asset_id, name, source_kind, start_ms, duration_ms, take_status) VALUES (?, ?, ?, 'cue', 'imported', 0, 4000, 'selected')").run(clipId, track, asset);
    return { projectId, sessionId, scene, shot, clipId, musicDir };
}

async function bounced(f) {
    const b = await renderer.runBounce(db, f.sessionId, {});
    assert.ok(b.ok, b.error);
    return renderer.listBounces(db, f.sessionId).find(x => x.status === 'complete');
}

// ── The approval workflow ──────────────────────────────────────────────────

test('approval is explicit: a bounce is selected, a stale one is refused, a plain status write cannot approve, and revoking stops every consumer', async () => {
    const f = film();
    const route = sessions();
    const early = await call(route, 'POST', `/film/music-sessions/${f.sessionId}/approve`, {});
    assert.strictEqual(early.status, 409); assert.match(early.body.error, /bounce/i, 'approved with nothing rendered');

    const b = await bounced(f);
    const put = await call(route, 'PUT', `/film/music-sessions/${f.sessionId}`, { status: 'approved' });
    assert.strictEqual(put.status, 409); assert.strictEqual(put.body.code, 'USE_APPROVE');

    db.prepare('UPDATE film_music_clips SET gain_db = -3 WHERE id = ?').run(f.clipId);
    const stale = await call(route, 'POST', `/film/music-sessions/${f.sessionId}/approve`, { bounce_operation_id: b.operation_id });
    assert.strictEqual(stale.status, 409); assert.strictEqual(stale.body.code, 'STALE_MIX');
    db.prepare('UPDATE film_music_clips SET gain_db = 0 WHERE id = ?').run(f.clipId);

    const ok = await call(route, 'POST', `/film/music-sessions/${f.sessionId}/approve`, {});
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const row = db.prepare('SELECT status, approved_mix_asset_id, approved_at FROM film_music_sessions WHERE id = ?').get(f.sessionId);
    assert.strictEqual(row.status, 'approved'); assert.strictEqual(row.approved_mix_asset_id, b.master.asset_id); assert.ok(row.approved_at);
    assert.ok(db.prepare("SELECT 1 FROM film_music_operations WHERE session_id = ? AND kind = 'approve' AND status = 'complete'").get(f.sessionId), 'the approval is not recorded');

    const forged = await call(route, 'PUT', `/film/music-sessions/${f.sessionId}`, { approved_mix_asset_id: generateId(), notes: 'x' });
    assert.strictEqual(forged.status, 200);
    assert.strictEqual(db.prepare('SELECT approved_mix_asset_id FROM film_music_sessions WHERE id = ?').get(f.sessionId).approved_mix_asset_id, b.master.asset_id, 'a PUT body replaced the approved mix');

    assert.strictEqual(approval.approvedScores(db, f.projectId).scores.length, 1);
    const off = await call(route, 'POST', `/film/music-sessions/${f.sessionId}/unapprove`, {});
    assert.strictEqual(off.status, 200);
    const after = approval.approvedScores(db, f.projectId);
    assert.strictEqual(after.scores.length, 0);
    assert.ok(after.reports.some(r => r.session_id === f.sessionId && r.state === 'unapproved'));
});

test('the score report names every state: unapproved, stale, missing, overlapping — and consumes only what it can place once', async () => {
    const f = film();
    await bounced(f);
    assert.ok(approval.approveMix(db, f.sessionId).ok);
    let rep = approval.approvedScores(db, f.projectId);
    assert.strictEqual(rep.scores[0].state, 'ok');

    db.prepare('UPDATE film_music_clips SET gain_db = -6 WHERE id = ?').run(f.clipId);
    rep = approval.approvedScores(db, f.projectId);
    assert.strictEqual(rep.scores.length, 1, 'a stale approved mix is still the approved mix');
    assert.strictEqual(rep.scores[0].state, 'stale'); assert.ok(rep.reports.some(r => r.state === 'stale'));
    db.prepare('UPDATE film_music_clips SET gain_db = 0 WHERE id = ?').run(f.clipId);

    // A second approved session over the same shots: only one is consumed.
    const other = generateId();
    db.prepare("INSERT INTO film_music_sessions (id, project_id, sequence_id, name, status, approved_mix_asset_id, approved_at) SELECT ?, project_id, sequence_id, 'Rival', 'approved', approved_mix_asset_id, datetime('now', '-1 day') FROM film_music_sessions WHERE id = ?").run(other, f.sessionId);
    rep = approval.approvedScores(db, f.projectId);
    assert.strictEqual(rep.scores.length, 1, 'two approved mixes over one picture would both play');
    assert.ok(rep.reports.some(r => r.session_id === other && r.state === 'overlapping'));
    db.prepare('DELETE FROM film_music_sessions WHERE id = ?').run(other);

    const master = db.prepare('SELECT file_path FROM film_assets WHERE id = (SELECT approved_mix_asset_id FROM film_music_sessions WHERE id = ?)').get(f.sessionId).file_path;
    fs.renameSync(master, master + '.gone');
    rep = approval.approvedScores(db, f.projectId);
    assert.strictEqual(rep.scores.length, 0, 'a mix whose file is gone was consumed');
    assert.ok(rep.reports.some(r => r.state === 'missing'));
    fs.renameSync(master + '.gone', master);
});

// ── Every consumer ─────────────────────────────────────────────────────────

let F = null;
async function scored() {
    if (F) return F;
    const f = film();
    await bounced(f);
    const a = approval.approveMix(db, f.sessionId);
    assert.ok(a.ok, a.error);
    f.mixPath = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(a.asset_id).file_path;
    f.legacy = db.prepare("SELECT scene_id, file_path FROM film_assets WHERE project_id = ? AND asset_type = 'audio_music' AND scene_id IS NOT NULL").all(f.projectId);
    F = f; return f;
}
const legacyOf = (f, i) => f.legacy.find(l => l.scene_id === f.scene[i]).file_path;
const count = (text, needle) => text.split(needle).length - 1;

const PROBES = {
    async timeline(f) {
        const tl = require('../routes/timeline').loadTimeline(f.projectId);
        const music = tl.beds.filter(b => b.kind === 'music');
        const score = music.filter(b => b.path === f.mixPath);
        assert.strictEqual(score.length, 1, 'the approved mix is not on the timeline exactly once');
        assert.strictEqual(score[0].start_ms, 4000, 'the score is not at scene 2\'s first shot');
        assert.ok(!music.some(b => b.path === legacyOf(f, 1)), 'scene 2\'s legacy music plays under the approved score');
        assert.ok(music.some(b => b.path === legacyOf(f, 0)), 'scene 1 lost its music, which no score covers');
        assert.ok(tl.score && tl.score.placements.length === 1);
    },
    async playback(f) {
        // What the page plays is the served timeline: at no instant do two music beds overlap.
        const r = await call(require('../routes/timeline').handleTimeline, 'GET', `/film/projects/${f.projectId}/timeline`);
        assert.strictEqual(r.status, 200);
        const music = (r.body.beds || []).filter(b => b.kind === 'music');
        for (let t = 0; t < 8000; t += 250) assert.ok(music.filter(b => t >= b.start_ms && t < b.end_ms).length <= 1, `two music beds at ${t} ms`);
        assert.strictEqual(music.filter(b => b.path === f.mixPath).length, 1);
    },
    async audio_mix(f) {
        const mg = require('../routes/music-gen');
        const r = await call(mg.handleMusicGen, 'POST', `/film/projects/${f.projectId}/music/mix`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.score.placements.length, 1); assert.strictEqual(r.body.score.placements[0].offset_ms, 4000);
        const scene2 = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(f.scene[1]);
        for (const [code, into] of [['2A', 0], ['2B', 2000]]) {
            const tracks = mg.collectShotAudioTracks(f.shot[code], scene2, { duration_ms: 2000 }).filter(t => t.type === 'music');
            assert.strictEqual(tracks.length, 1, `${code}: not exactly one music track`);
            assert.strictEqual(tracks[0].url, f.mixPath); assert.strictEqual(tracks[0].source_offset_ms, into);
        }
        const scene1 = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(f.scene[0]);
        assert.strictEqual(mg.collectShotAudioTracks(f.shot['1A'], scene1, { duration_ms: 2000 }).filter(t => t.type === 'music')[0].url, legacyOf(f, 0));
    },
    async pipeline(f) {
        const { scoreGate } = require('../routes/pipeline');
        const covered = approval.coveredScenes(db, f.projectId);
        const two = scoreGate('music', { id: f.scene[1] }, covered);
        assert.strictEqual(two.run, false); assert.match(two.reason, /approved score/);
        assert.strictEqual(scoreGate('music', { id: f.scene[0] }, covered).run, true);
        assert.strictEqual(scoreGate('ambient', { id: f.scene[1] }, covered).run, true, 'the score suppressed the ambience, which is not music');
        assert.match(fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8').match(/async function runShotPlan[\s\S]*?\n}/)[0], /scoreGate\(/, 'the runner never asks');
    },
    async nle_export(f) {
        const nle = require('../routes/nle-export').handleNLEExport;
        for (const fmt of ['premiere', 'fcpxml']) {
            const r = await call(nle, 'GET', `/film/projects/${f.projectId}/export/${fmt}`);
            assert.strictEqual(r.status, 200, `${fmt}: ${String(r.text).slice(0, 200)}`);
            const mixName = path.basename(f.mixPath);
            // One reference to the file: Premiere names it in <pathurl>, FCPXML in the asset's src (its name attribute is not a reference).
            const refs = fmt === 'premiere' ? count(r.text, mixName + '</pathurl>') : (r.text.match(new RegExp(`src="[^"]*${mixName.replace(/[.]/g, '\\.')}"`, 'g')) || []).length;
            assert.strictEqual(refs, 1, `${fmt}: the approved mix is not in the export exactly once`);
            assert.strictEqual(count(r.text, path.basename(legacyOf(f, 1))), 0, `${fmt}: scene 2's legacy music is layered under the score`);
            assert.ok(count(r.text, path.basename(legacyOf(f, 0))) >= 1, `${fmt}: scene 1's music is missing`);
        }
    },
    async conform(f) {
        const conform = require('../lib/conform');
        const plan = conform.planConform(f.projectId);
        assert.strictEqual(plan.score.placements.length, 1); assert.strictEqual(plan.score.placements[0].offset_ms, 4000);
        const out = await conform.runConform(f.projectId, { filename: 'scored_master' });
        assert.ok(out.ok, out.error);
        const before = meanDb(out.output, 0.5, 3), during = meanDb(out.output, 4.5, 3);
        // Scene 1 is not under the score, so its own music plays there: the
        // conform lays the film's generated sound as Playback does
        // (tests/conform-sound.test.js). It used to be silent because NO
        // generated sound reached the master at all.
        assert.ok(before !== null && before > -45, `scene 1's own music is not in the master before the score (${before} dB)`);
        assert.ok(!(plan.sound.placements || []).some(p => p.kind === 'music' && p.scene_id === f.scene[1]),
            'scene 2\'s legacy music is laid under the approved score');
        assert.ok(during !== null && during > -45, `the score is not in the master where it belongs (${during} dB)`);
        assert.ok(Math.abs(inspectMedia(out.output).durationSeconds - 8) < 0.3, 'the score changed the film\'s length');
    },
};

test('every consumer of the film consumes the approved score exactly once, at its canonical offset, with nothing layered under it', async () => {
    const f = await scored();
    const ids = approval.SCORE_CONSUMERS.map(c => c.id);
    assert.deepStrictEqual(ids.slice().sort(), Object.keys(PROBES).sort(), 'a consumer has no probe, or a probe has no consumer');
    for (const c of approval.SCORE_CONSUMERS) {
        assert.ok(c.what && c.file, `${c.id}: undeclared`);
        const src = fs.readFileSync(path.join(__dirname, '..', '..', c.file), 'utf8');
        assert.ok(c.id === 'playback' ? /timeline\.beds|\.beds\b/.test(src) : /music-approval/.test(src), `${c.id}: ${c.file} does not read the approved score`);
        await PROBES[c.id](f);
    }
});

test('the approval and the report reach an agent', async () => {
    const f = film();
    await bounced(f);
    const a = mcp.presentResult(await mcp.callTool('music_session_approve', { session_id: f.sessionId }));
    assert.strictEqual(a.status_after || a.session.status, 'approved', JSON.stringify(a));
    const rep = mcp.presentResult(await mcp.callTool('music_score_report', { project_id: f.projectId }));
    assert.strictEqual(rep.scores.length, 1);
    const off = mcp.presentResult(await mcp.callTool('music_session_unapprove', { session_id: f.sessionId }));
    assert.strictEqual(off.session.status, 'review');
});
