/**
 * An edit made in Premiere comes home: kept by version, read into a cut list,
 * and scored against.
 *
 * Set-based three ways, because each failed partially in the design:
 *
 *   FORMATS   every format `CUT_FORMATS` names is read, round-tripped through
 *             this engine's OWN exporter for that format, so a cut exported to
 *             Premiere and brought back lands on the same shots at the same
 *             times. A reader that handles xmeml and silently misreads an EDL
 *             passes any test written against one.
 *   MATCHES   every way an event is matched to a shot (by file, by shot code)
 *             and the event that is no shot at all.
 *   CONSUMERS every part of the score that reads a session's picture — the
 *             brief, the read model, the bounce, the package, approval and
 *             drift. A session on an edit whose brief follows the cut while its
 *             bounce is as long as the assembly is stems that do not line up.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-edits-' + crypto.randomUUID().slice(0, 8));
const { lavfiSource } = require('./helpers');
delete process.env.FILM_PROJECTS_DIR;

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const cut = require('../lib/edit-cut');
const edits = require('../lib/edits');
const folders = require('../lib/project-folders');
const fileStorage = require('../lib/file-storage');
const nle = require('../lib/nle-export');
const { callTool, listTools } = require('../lib/mcp-tools');
const { resolveFfmpeg } = require('../lib/ffmpeg');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-edits-'));
const bin = () => resolveFfmpeg().bin;

function movie(name, secs, opts) {
    const o = opts || {};
    const p = path.join(TMP, name);
    const args = ['-y', '-loglevel', 'error', ...lavfiSource(`color=c=blue:s=160x90:d=${secs}:r=24`,
        o.audio !== false && `sine=frequency=330:duration=${secs}:sample_rate=48000`)];
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(secs));
    if (o.audio !== false) args.push('-c:a', 'aac', '-shortest');
    args.push(p);
    execFileSync(bin(), ['-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    return p;
}

function wav(name, secs) {
    const p = path.join(TMP, name);
    execFileSync(bin(), ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}:sample_rate=48000`,
        '-ac', '2', '-c:a', 'pcm_s24le', p], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    return p;
}

const dataUri = (p, mime) => `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;

/** A project with a project folder, one scene and shots 1A..1D with clips on disk. */
async function film(title) {
    const r = await callTool('project_create', { title, assets_parent: fs.mkdtempSync(path.join(TMP, 'root-')) });
    assert.strictEqual(r._status, 201, JSON.stringify(r.body));
    const pid = r.body.id;
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location, time_of_day) VALUES (?, ?, 1, 'DINER', 'NIGHT')").run(sceneId, pid);
    const shots = [];
    for (const [i, code] of ['1A', '1B', '1C', '1D', '1DA'].entries()) {
        const id = generateId();
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, sort_order, duration_ms, scene_card_yaml) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, sceneId, code, i, 2000, JSON.stringify({ shot_code: code, description: `shot ${code}`, characters: ['RAY'],
                dialogue: code === '1B' ? [{ character: 'RAY', line: 'You came back.' }] : [] }));
        const file = `${code}.mp4`;
        const p = fileStorage.saveFile(pid, 'video', file, Buffer.from('clip'));
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, duration_ms)
                    VALUES (?, ?, ?, 'video_raw', ?, ?, 3000)`).run(generateId(), pid, id, file, p);
        shots.push({ id, shot_code: code, scene_id: sceneId });
    }
    return { pid, sceneId, shots };
}

// ── FORMATS: every one read, round-tripped through our own exporter ─────────

const EXPORTERS = Object.freeze({
    xmeml: (project, shots, assets) => nle.generatePremiereXML(project, shots, assets, { target_fps: 24 }),
    edl: (project, shots, assets) => nle.generateEDL(project, shots, { target_fps: 24, assets }),
});

test('every cut format the reader names has an exporter here to round-trip it', () => {
    assert.deepStrictEqual(Object.keys(EXPORTERS).sort(), [...cut.CUT_FORMATS].sort());
});

for (const format of cut.CUT_FORMATS) {
    test(`${format}: a cut exported to the editor and brought back lands on the same shots at the same times`, async () => {
        const f = await film(`Round Trip ${format}`);
        // An EDITED order, not the assembly: 1C first, 1A trimmed, 1B dropped.
        const edited = [
            { ...f.shots[2], duration_ms: 1500, scene_number: 1 },
            { ...f.shots[0], duration_ms: 1000, scene_number: 1 },
            { ...f.shots[4], duration_ms: 2500, scene_number: 1 },
        ];
        const assets = db.prepare("SELECT * FROM film_assets WHERE project_id = ? AND asset_type = 'video_raw'").all(f.pid);
        const text = EXPORTERS[format]({ title: 'Round Trip' }, edited, assets);
        const parsed = cut.parseCut(text, { fps: 24 });
        assert.strictEqual(parsed.format, format);
        const matched = cut.matchCut(parsed, f.shots, assets.map(a => ({ file_name: a.file_name, shot_id: a.shot_id })));
        assert.deepStrictEqual(matched.events.map(e => e.shot_code), ['1C', '1A', '1DA'], 'the cut order is lost, or 1DA was read as 1D');
        assert.deepStrictEqual(matched.events.map(e => [e.start_ms, e.duration_ms]), [[0, 1500], [1500, 1000], [2500, 2500]]);
        assert.strictEqual(matched.summary.unmatched, 0);
        assert.deepStrictEqual(matched.summary.shots_not_in_cut.sort(), ['1B', '1D']);
        // How it matched: xmeml carries the file; an EDL carries only a clip name.
        assert.ok(matched.events.every(e => e.matched_by === (format === 'xmeml' ? 'file' : 'code')), JSON.stringify(matched.events.map(e => e.matched_by)));
    });
}

test('xmeml as Premiere writes it: -1 beside a transition means the cut is at the transition centre, a disabled clip is no picture', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE xmeml>
<xmeml version="4"><sequence id="s1"><name>Reel 1 &amp; 2</name><duration>144</duration>
<rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate><media><video><track>
  <clipitem id="c1"><name>1A_take2</name><start>0</start><end>-1</end><in>12</in><out>72</out>
    <file id="f1"><name>1A.mp4</name><pathurl>file://localhost/Volumes/Edit/1A.mp4</pathurl></file></clipitem>
  <transitionitem><start>40</start><end>56</end><alignment>center</alignment></transitionitem>
  <clipitem id="c2"><name>Title</name><start>-1</start><end>96</end><in>0</in><out>48</out></clipitem>
  <clipitem id="c3"><name>1B</name><enabled>FALSE</enabled><start>96</start><end>120</end></clipitem>
  <clipitem id="c4"><name>again</name><start>120</start><end>144</end><file id="f1"/></clipitem>
</track><track><clipitem id="t"><name>LOWER THIRD</name><start>10</start><end>30</end></clipitem></track>
</video></media></sequence></xmeml>`;
    const parsed = cut.parseCut(xml);
    assert.strictEqual(parsed.sequence, 'Reel 1 & 2', 'entities not decoded');
    assert.deepStrictEqual(parsed.events.map(e => [e.name, e.start_ms, e.end_ms]),
        [['1A_take2', 0, 2000], ['Title', 2000, 4000], ['again', 5000, 6000]]);
    assert.strictEqual(parsed.events[0].source_in_ms, 500);
    assert.strictEqual(parsed.events[2].file_name, '1A.mp4', 'a <file id> reference was not resolved to its first definition');
    assert.deepStrictEqual(parsed.overlays.map(o => o.name), ['LOWER THIRD'], 'a title on V2 is an overlay, not a cut');
    const m = cut.matchCut(parsed, [{ id: 'a', shot_code: '1A', scene_id: 's' }], [{ file_name: '1A.mp4', shot_id: 'a' }]);
    assert.deepStrictEqual(m.events.map(e => e.matched_by), ['file', null, 'file']);
    assert.deepStrictEqual(m.summary.unmatched_names, ['Title'], 'a title the project did not make must be named, never dropped');
});

test('what is not a cut is refused by name', () => {
    assert.throws(() => cut.parseCut('<fcpxml version="1.11"><resources/></fcpxml>'), /FCPXML/);
    assert.throws(() => cut.parseCut('hello'), /not a cut/);
    assert.throws(() => cut.parseCut('<xmeml version="4"></xmeml>'), /no <sequence>/);
    assert.throws(() => cut.parseCut('<xmeml><sequence><name>A</name></sequence></xmeml>', { sequence: 'B' }), /no sequence named "B"/);
});

// ── MATCHES: every way, and a code is a whole token ─────────────────────────

test('matching: by file, by shot code as a whole token (longest first), or none — and each is said', () => {
    const shots = [{ id: 'a', shot_code: '2A' }, { id: 'aa', shot_code: '2AA' }, { id: 'b', shot_code: '2B' }];
    const events = [
        { name: 'anything', file_name: 'render_07.mov', start_ms: 0, end_ms: 1000 },   // by file
        { name: '2AA_v3', file_name: '', start_ms: 1000, end_ms: 2000 },              // 2AA, never 2A
        { name: 'SC2A-take4', file_name: '', start_ms: 2000, end_ms: 3000 },           // a code inside a longer token is NOT a match
        { name: 'shot 2B final', file_name: '', start_ms: 3000, end_ms: 4000 },        // whole token
        { name: 'Stock_ocean', file_name: 'stock.mov', start_ms: 4000, end_ms: 5000 }, // none
    ];
    const m = cut.matchCut({ events }, shots, [{ file_name: 'render_07.mov', shot_id: 'b' }]);
    assert.deepStrictEqual(m.events.map(e => [e.shot_code, e.matched_by]),
        [['2B', 'file'], ['2AA', 'code'], [null, null], ['2B', 'code'], [null, null]]);
    assert.deepStrictEqual(m.summary.by, { file: 1, code: 2 });
    assert.deepStrictEqual(m.summary.shots_not_in_cut, ['2A']);
});

// ── Importing: a version, in 05 Edit, measured, never overwritten ───────────

test('an edit imports as the next version into 05 Edit, measured by the encoder, and v1 is untouched by v2', async () => {
    const f = await film('Versioned Cut');
    const root = fileStorage.projectRoot(f.pid);
    const one = await callTool('edit_import', { project_id: f.pid, data: dataUri(movie('v1.mp4', 3), 'video/mp4'), name: 'First assembly' });
    assert.strictEqual(one._status, 201, JSON.stringify(one.body));
    const e1 = one.body.edit;
    assert.strictEqual(e1.version, 1);
    assert.strictEqual(e1.file_path, path.join(root, '05 Edit', 'edit_v1.mp4'));
    assert.ok(Math.abs(e1.duration_ms - 3000) < 100, `measured ${e1.duration_ms}`);
    assert.strictEqual(e1.has_audio, true);
    assert.strictEqual(e1.width, 160);
    const before = fs.readFileSync(e1.file_path);

    // v2 arrives through a resumable upload, moved into place rather than read.
    const uploads = require('../lib/uploads');
    const bytes = fs.readFileSync(movie('v2.mov', 4, { audio: false }));
    const up = uploads.beginUpload({ total_bytes: bytes.length, mime: 'video/quicktime', name: 'v2.mov' });
    uploads.appendChunk(up.id, 0, bytes.subarray(0, 1000));
    uploads.appendChunk(up.id, 1000, bytes.subarray(1000));
    const two = await callTool('edit_import', { project_id: f.pid, upload_id: up.id });
    assert.strictEqual(two._status, 201, JSON.stringify(two.body));
    assert.strictEqual(two.body.edit.version, 2);
    assert.strictEqual(two.body.edit.has_audio, false);
    assert.ok(fs.readFileSync(e1.file_path).equals(before), 'importing v2 changed v1');
    const list = (await callTool('edit_list', { project_id: f.pid })).body.edits;
    assert.deepStrictEqual(list.map(e => [e.version, e.is_latest]), [[2, true], [1, false]]);
    // The picture serves.
    const res = { status: 0, writeHead(s) { this.status = s; }, end() {}, on() {}, once() {}, emit() {}, write() { return true; } };
    fileStorage.serveFile(res, f.pid, 'edits', 'edit_v1.mp4');
    assert.strictEqual(res.status, 200);
});

test('what is not a picture is refused, and leaves nothing behind', async () => {
    const f = await film('Refused Cut');
    const dir = fileStorage.dirFor(f.pid, 'edits');
    const before = fs.readdirSync(dir).length;
    for (const [what, data] of [
        ['a WAV', dataUri(wav('bed.wav', 1), 'audio/wav')],
        ['text named .mp4', `data:video/mp4;base64,${Buffer.from('not a movie at all, just words').toString('base64')}`],
    ]) {
        const r = await callTool('edit_import', { project_id: f.pid, data });
        assert.strictEqual(r._status, 400, `${what} was accepted`);
    }
    // A cut that cannot be read refuses the whole import before a file is written.
    const bad = await callTool('edit_import', { project_id: f.pid, data: dataUri(movie('ok.mp4', 1), 'video/mp4'), cut: '<fcpxml/>' });
    assert.strictEqual(bad._status, 400);
    assert.strictEqual(fs.readdirSync(dir).length, before, 'a refused import left a file');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM film_edits WHERE project_id = ?').get(f.pid).n, 0);
});

// ── CONSUMERS: every reader of a session's picture follows the edit ─────────

const CONSUMERS = Object.freeze(['brief', 'read_model', 'bounce', 'package_picture', 'approval', 'drift']);

test('a score written against an edit: every consumer of its picture follows the cut, not the assembly', async () => {
    const f = await film('Scored Cut');
    const assets = db.prepare("SELECT * FROM film_assets WHERE project_id = ? AND asset_type = 'video_raw'").all(f.pid);
    // The editor's cut: 1B then 1A, with a title card the project did not make.
    const edited = [{ ...f.shots[1], duration_ms: 1500 }, { ...f.shots[0], duration_ms: 2500 }];
    const xml = EXPORTERS.xmeml({ title: 'Scored' }, edited, assets);
    const imp = await callTool('edit_import', { project_id: f.pid, data: dataUri(movie('scored.mp4', 5), 'video/mp4'), cut: xml });
    assert.strictEqual(imp._status, 201, JSON.stringify(imp.body));
    const edit = imp.body.edit;
    assert.ok(fs.existsSync(path.join(fileStorage.projectRoot(f.pid), '05 Edit', 'edit_v1_cut.xml')), 'the XML the cut was read from is not kept');

    const created = await callTool('music_session_create', { project_id: f.pid, edit_id: edit.id, name: 'Score to the cut' });
    assert.strictEqual(created._status, 201, JSON.stringify(created.body));
    const sid = created.body.session.id;
    const seen = {};

    // brief
    const brief = (await callTool('music_session_brief', { session_id: sid })).body;
    const pic = brief.brief.picture;
    assert.strictEqual(pic.kind, 'edit');
    assert.strictEqual(pic.total_ms, edit.duration_ms, 'the brief is not as long as the edit');
    assert.deepStrictEqual(pic.shots.map(s => [s.shot_code, s.start_ms, s.duration_ms]), [['1B', 0, 1500], ['1A', 1500, 2500]]);
    assert.strictEqual(brief.brief.dialogue.lines, 1, 'the cut\'s dialogue is not the cut\'s shots');
    assert.strictEqual(brief.brief.length.ms, edit.duration_ms);
    seen.brief = true;

    // read model
    const model = (await callTool('music_session_get', { session_id: sid })).body;
    assert.strictEqual(model.picture.kind, 'edit');
    assert.ok(model.picture.edit.video_url.startsWith(`/film/edits/${f.pid}/`));
    assert.strictEqual(model.duration_ms, edit.duration_ms, 'an empty session on an edit must already be the edit\'s length');
    seen.read_model = true;

    // bounce: a one-second cue still bounces to the whole edit, so stems line up at both ends
    const bed = wav('cue.wav', 1);
    const bedPath = fileStorage.saveFile(f.pid, 'music', 'cue.wav', fs.readFileSync(bed));
    const bedAsset = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_name, file_path, duration_ms) VALUES (?, ?, 'audio_music', 'cue.wav', ?, 1000)`).run(bedAsset, f.pid, bedPath);
    const track = await callTool('music_track_create', { session_id: sid, name: 'Strings', role: 'strings' });
    assert.ok(track._status < 300, JSON.stringify(track.body));
    const trackId = (track.body.track || track.body.row || track.body).id;
    const clip = await callTool('music_clip_create', { session_id: sid, track_id: trackId, asset_id: bedAsset, start_ms: 500, duration_ms: 1000 });
    assert.ok(clip._status < 300, JSON.stringify(clip.body));
    const bounce = await callTool('music_bounce', { session_id: sid });
    assert.ok(bounce._status < 300, JSON.stringify(bounce.body));
    const master = db.prepare("SELECT duration_ms, file_path FROM film_assets WHERE id = ?").get((bounce.body.master || (bounce.body.bounce || {}).master || {}).asset_id);
    const measured = require('../lib/ffmpeg').inspectMedia(master.file_path);
    assert.ok(Math.abs(measured.durationSeconds * 1000 - edit.duration_ms) < 50,
        `the bounce is ${measured.durationSeconds}s against a ${edit.duration_ms}ms edit — its stems would not line up in Premiere`);
    seen.bounce = true;

    // package: the reference picture is the edit, not the conformed assembly
    const pkg = await callTool('music_package_build', { session_id: sid });
    assert.ok(pkg._status < 300, JSON.stringify(pkg.body));
    const manifest = require('../lib/music-package').listPackages(db, sid)[0];
    const pkgAsset = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(manifest.asset_id);
    const zip = fs.readFileSync(pkgAsset.file_path);
    assert.ok(zip.includes(Buffer.from('picture/reference.mp4')), 'the package does not carry the edit as its reference picture');
    assert.match(zip.toString('latin1'), new RegExp(`"edit_id":\\s*"${edit.id}"`), 'the package does not say which edit the score is timed to');
    seen.package_picture = true;

    // approval: delivered with the edit, never laid on the assembly
    db.prepare("UPDATE film_music_sessions SET status = 'approved', approved_mix_asset_id = (SELECT id FROM film_assets WHERE file_path = ?) WHERE id = ?").run(master.file_path, sid);
    const { approvedScores } = require('../lib/music-approval');
    const scores = approvedScores(db, f.pid);
    assert.strictEqual(scores.scores.length, 0, 'a score timed to the editor\'s cut was placed on the assembly');
    assert.deepStrictEqual(scores.reports.map(r => r.state), ['on_edit']);
    db.prepare("UPDATE film_music_sessions SET status = 'review', approved_mix_asset_id = NULL WHERE id = ?").run(sid);
    seen.approval = true;

    // drift: a newer cut is said, and applied only when asked
    const v2 = await callTool('edit_import', { project_id: f.pid, data: dataUri(movie('scored2.mp4', 6), 'video/mp4') });
    const drift = (await callTool('music_session_drift', { session_id: sid })).body;
    assert.deepStrictEqual(drift.newer_edit && [drift.newer_edit.version, drift.newer_edit.written_against], [2, 1]);
    assert.strictEqual((await callTool('music_session_get', { session_id: sid })).body.picture.edit.version, 1, 'a newer cut moved the score by itself');
    const moved = await callTool('music_session_update', { session_id: sid, edit_id: v2.body.edit.id });
    assert.ok(moved._status < 300, JSON.stringify(moved.body));
    assert.strictEqual((await callTool('music_session_drift', { session_id: sid })).body.newer_edit, null);
    seen.drift = true;

    assert.deepStrictEqual(Object.keys(seen).sort(), [...CONSUMERS].sort(), 'a consumer of the picture was not exercised');

    // An edit a score is written against is not deleted out from under it.
    const del = await callTool('edit_delete', { edit_id: v2.body.edit.id });
    assert.strictEqual(del._status, 409);
    assert.match(del.body.error, /Score to the cut/);
});

test('edit_cut_rematch picks up a shot added after the cut was imported', async () => {
    const f = await film('Rematch Cut');
    const xml = `<xmeml version="4"><sequence><name>S</name><rate><timebase>24</timebase></rate><media><video><track>
        <clipitem><name>2A_pickup</name><start>0</start><end>48</end></clipitem></track></video></media></sequence></xmeml>`;
    const imp = await callTool('edit_import', { project_id: f.pid, data: dataUri(movie('re.mp4', 2), 'video/mp4'), cut: xml });
    assert.strictEqual(imp.body.edit.cut.summary.matched, 0);
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, sort_order, scene_card_yaml) VALUES (?, ?, '2A', 9, '{}')").run(generateId(), f.sceneId);
    const again = await callTool('edit_cut_rematch', { edit_id: imp.body.edit.id });
    assert.deepStrictEqual(again.body.edit.cut.events.map(e => [e.shot_code, e.matched_by]), [['2A', 'code']]);
});

// ── The folder, the bundle, the surfaces ────────────────────────────────────

test('05 Edit sits between the clips and the sound; old folders are renamed and their records follow', async () => {
    const names = folders.layoutList().map(e => e.folder.split('/')[0]);
    const tops = [...new Set(names)];
    assert.deepStrictEqual(tops, ['01 References', '02 Storyboard', '03 Previs', '04 Video', '05 Edit', '06 Sound', '07 Delivery']);

    // A folder made under the old numbering.
    const r = await callTool('project_create', { title: 'Old Numbering', assets_parent: fs.mkdtempSync(path.join(TMP, 'old-')) });
    const root = r.body.assets_dir, pid = r.body.id;
    for (const rn of folders.LAYOUT_RENAMES) fs.rmSync(path.join(root, rn.to), { recursive: true, force: true });
    const oldDialogue = path.join(root, '05 Sound', 'Dialogue', 'line.wav');
    const oldExport = path.join(root, '06 Delivery', 'Exports', 'cut.xml');
    for (const p of [oldDialogue, oldExport]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); }
    const ids = [oldDialogue, oldExport].map(p => {
        const id = generateId();
        db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_name, file_path, metadata) VALUES (?, ?, 'other', ?, ?, ?)")
            .run(id, pid, path.basename(p), p, JSON.stringify({ was: p }));
        return id;
    });
    // Before the upgrade, a path under a former name still resolves to its kind.
    assert.strictEqual(fileStorage.locate(oldDialogue).subdir, 'audio');
    const up = require('../lib/project-storage').upgradeLayouts();
    assert.ok(up.renamed.filter(x => x.project_id === pid).length === 2, JSON.stringify(up));
    for (const id of ids) {
        const a = db.prepare('SELECT file_path, metadata FROM film_assets WHERE id = ?').get(id);
        assert.ok(fs.existsSync(a.file_path), `${a.file_path} is not where its row says`);
        assert.ok(/06 Sound|07 Delivery/.test(a.file_path));
        assert.strictEqual(JSON.parse(a.metadata).was, a.file_path, 'a path inside JSON was not followed');
    }
    assert.match(fs.readFileSync(path.join(root, folders.README_NAME), 'utf8'), /05 Edit/);
    assert.ok(fs.existsSync(path.join(root, '05 Edit')));
    // Idempotent: nothing left to rename.
    assert.strictEqual(require('../lib/project-storage').upgradeLayouts().renamed.filter(x => x.project_id === pid).length, 0);
});

test('a bundle carries the edits and the score keeps pointing at its own edit', async () => {
    const f = await film('Bundled Edit');
    const imp = await callTool('edit_import', { project_id: f.pid, data: dataUri(movie('b.mp4', 2), 'video/mp4') });
    const s = await callTool('music_session_create', { project_id: f.pid, edit_id: imp.body.edit.id, name: 'Carried' });
    assert.strictEqual(s._status, 201, JSON.stringify(s.body));
    const bundle = require('../lib/project-bundle');
    const out = bundle.importProject(fs.readFileSync(bundle.exportProject(f.pid).archivePath));
    const np = out.project.id;
    const e = db.prepare('SELECT * FROM film_edits WHERE project_id = ?').get(np);
    assert.ok(e && e.id !== imp.body.edit.id, 'the edit did not travel, or kept its old id');
    const session = db.prepare('SELECT edit_id FROM film_music_sessions WHERE project_id = ?').get(np);
    assert.strictEqual(session.edit_id, e.id, 'the score points at the source project\'s edit');
    const asset = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(e.asset_id);
    assert.strictEqual(asset.file_path, path.join(out.project.assets_dir, '05 Edit', 'edit_v1.mp4'));
    assert.ok(fs.existsSync(asset.file_path));
});

test('every edit route has an MCP tool, and a session can be created on an edit', () => {
    const tools = new Map(listTools().map(t => [t.name, t]));
    for (const n of ['edit_list', 'edit_get', 'edit_import', 'edit_cut_import', 'edit_cut_rematch', 'edit_update', 'edit_delete']) {
        assert.ok(tools.has(n), `${n} is missing`);
    }
    assert.ok(tools.get('music_session_create').inputSchema.properties.edit_id, 'music_session_create cannot name an edit');
    // Derived: every method the edits router dispatches is reached by a tool.
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'edits.js'), 'utf8');
    const methods = new Set([...src.matchAll(/req\.method === '([A-Z]+)'/g)].map(m => m[1]));
    const toolMethods = new Set(listTools().filter(t => t.name.startsWith('edit_'))
        .map(t => require('../lib/mcp-tools').ALL_ROUTE_TOOLS.find(r => r.name === t.name).method));
    for (const m of methods) assert.ok(toolMethods.has(m), `the edits router takes ${m} and no tool sends it`);
});

test('the page: an Edit page in Post, the score monitor follows the playhead, and a session can be opened on an edit', () => {
    const page = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    assert.match(page, /data-page="edits" onclick="navigateTo\('edits'\)"/);
    assert.match(page, /id="page-edits"/);
    assert.match(page, /edits: loadEditsPage,/);
    for (const fn of ['loadEditsPage', 'importEditFile', 'importEditCut', 'rematchEditCut', 'scoreThisEdit', 'deleteEditVersion',
        'mwPictureHtml', 'mwPictureFollow', 'mwMoveToEdit']) {
        assert.ok(new RegExp(`function ${fn}\\(`).test(page), `${fn} is not defined`);
    }
    const body = fn => page.slice(page.indexOf(`function ${fn}(`), page.indexOf('\n    }\n', page.indexOf(`function ${fn}(`)));
    assert.match(body('mwPlay'), /mwPictureFollow\(true\)/, 'the picture does not play with the score');
    assert.match(body('mwPause'), /mwPictureFollow\(false\)/, 'the picture keeps playing when the score stops');
    assert.match(body('mwCreateSession'), /\/edits'/, 'a new score session cannot be put on an edit');
    assert.match(body('mwCreateSessionSubmit'), /body\.edit_id = id/);
    assert.match(body('importEditFile'), /X-Upload-Offset/, 'a large edit is sent in one request, which dies on the first dropped connection');
    assert.match(body('mwDriftHtml'), /newer_edit/, 'a newer cut is never mentioned on the score');
});
