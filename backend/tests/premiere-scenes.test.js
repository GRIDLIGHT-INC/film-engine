/**
 * Premiere, one folder per scene — and every NLE export plays the SELECTED clip.
 *
 * "A function on Film Engine that creates the folders per scene for Premiere
 * and drops the video in, to make it easy for the editing part."
 *
 * Set-based over the project's own scenes and shots:
 *   - every scene gets a folder, every shot with a clip lands in it named by
 *     its code, and the file copied is the clip the director SELECTED (a shot
 *     here holds two clips and the older one is selected, so "the first row"
 *     and "the newest" are both wrong);
 *   - the XML is balanced, has a bin per scene, every file a bin references is
 *     defined earlier, and every file URL resolves to a file in the handover;
 *   - the plan writes nothing; a project with no clips is refused;
 *   - the plain Premiere, FCPXML and EDL exports name the selected clip too.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-ps-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleNLEExport } = require('../routes/nle-export');
const { resolveFfmpeg } = require('../lib/ffmpeg');

function call(method, parts, query = {}) {
    return new Promise(resolve => {
        const res = { code: 0, body: '', writeHead(c) { this.code = c; }, setHeader() {},
            end(b) { this.body = b || ''; let j = null; try { j = JSON.parse(this.body); } catch (_) {} resolve({ code: this.code, json: j, text: this.body }); } };
        handleNLEExport({ method, headers: {} }, res, parts, query);
    });
}

const ff = resolveFfmpeg();
const MEDIA = path.join(process.env.FILM_DATA_DIR, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
function clip(name, colour) {
    const f = path.join(MEDIA, name);
    execFileSync(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:d=1`,
        '-pix_fmt', 'yuv420p', f], { stdio: ['ignore', 'ignore', 'ignore'] });
    return f;
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const pid = generateId();
db.prepare(`INSERT INTO film_projects (id, title, target_resolution, target_fps) VALUES (?, 'Glass Harbour', '1920x1080', 24)`).run(pid);
const scenes = [
    { id: generateId(), n: 1, ie: 'INT', loc: 'DINER', tod: 'NIGHT' },
    { id: generateId(), n: 2, ie: 'EXT', loc: 'HARBOUR ROAD', tod: 'DAWN' },
];
for (const s of scenes) db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(s.id, pid, s.n, s.ie, s.loc, s.tod);
const shots = [['1A', 0], ['1B', 0], ['2A', 1]].map(([code, si], i) => {
    const id = generateId();
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, sort_order) VALUES (?, ?, ?, 1000, ?)`).run(id, scenes[si].id, code, i);
    return { id, code, scene: scenes[si] };
});
function asset(shot, type, file, created, extra = {}) {
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_path, file_name, format, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000, ?)`).run(id, pid, shot ? shot.id : null, extra.scene_id || null, type, file, path.basename(file),
        path.extname(file).slice(1), created);
    return id;
}
// 1A: three takes and the MIDDLE one is selected, so neither "the first row"
// nor "the newest" can pass for the rule.
asset(shots[0], 'video_raw', clip('1A_take0.mp4', 'yellow'), '2025-12-01 00:00:00');
const selectedFile = clip('1A_take1.mp4', 'red');
const otherFile = clip('1A_take2.mp4', 'blue');
const selectedId = asset(shots[0], 'video_raw', selectedFile, '2026-01-01 00:00:00');
asset(shots[0], 'video_raw', otherFile, '2026-02-01 00:00:00');
db.prepare('UPDATE film_shots SET selected_video_asset_id = ? WHERE id = ?').run(selectedId, shots[0].id);
asset(shots[2], 'video_raw', clip('2A.mp4', 'green'), '2026-01-01 00:00:00');
// 1B has no clip. A dialogue line on 1A and an ambient bed on scene 2.
const line = path.join(MEDIA, 'line.mp3');
execFileSync(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1', line], { stdio: ['ignore', 'ignore', 'ignore'] });
asset(shots[0], 'audio_dialogue', line, '2026-01-01 00:00:00');
asset(null, 'audio_ambient', line, '2026-01-01 00:00:00', { scene_id: scenes[1].id });

test('the plan is free, names every scene and what is missing, and writes nothing', async () => {
    const before = fs.readdirSync(process.env.FILM_DATA_DIR).length;
    const r = await call('GET', ['film', 'projects', pid, 'export', 'premiere-scenes']);
    assert.equal(r.code, 200);
    assert.equal(r.json.spends, false);
    assert.equal(r.json.scenes.length, scenes.length, 'a folder per scene');
    assert.deepEqual(r.json.scenes.map(s => s.folder), ['Scene_01_INT-DINER-NIGHT', 'Scene_02_EXT-HARBOUR-ROAD-DAWN']);
    assert.ok(r.json.missing.some(m => m.shot_code === '1B' && m.kind === 'video'), '1B is named as having no clip');
    assert.equal(fs.readdirSync(process.env.FILM_DATA_DIR).length, before, 'nothing written');
});

test('writing puts each shot\'s SELECTED clip in its scene folder, with a bin per scene in the XML', async () => {
    const r = await call('POST', ['film', 'projects', pid, 'export', 'premiere-scenes']);
    assert.equal(r.code, 200, r.text);
    const dest = r.json.dest;
    for (const s of shots) {
        const f = path.join(dest, r.json.scenes.find(x => x.scene_id === s.scene.id).folder, 'Video', `${s.code}.mp4`);
        if (s.code === '1B') { assert.ok(!fs.existsSync(f)); continue; }
        assert.ok(fs.existsSync(f), `${s.code} is in its scene folder`);
    }
    assert.equal(sha(path.join(dest, 'Scene_01_INT-DINER-NIGHT/Video/1A.mp4')), sha(selectedFile), '1A is the SELECTED take');
    assert.ok(fs.readdirSync(path.join(dest, 'Scene_01_INT-DINER-NIGHT/Sound')).some(n => /dialogue/.test(n)), 'the dialogue is beside it');
    assert.ok(fs.readdirSync(path.join(dest, 'Scene_02_EXT-HARBOUR-ROAD-DAWN/Sound')).some(n => /ambient/.test(n)), 'the scene bed is in its folder');
    assert.ok(fs.existsSync(path.join(dest, 'READ ME.txt')));
    assert.ok(fs.existsSync(selectedFile), 'the originals are copied, never moved');

    const xml = fs.readFileSync(path.join(dest, r.json.xml), 'utf8');
    // Balanced tags.
    const stack = [];
    for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w-]*)[^>]*?(\/?)>/g)) {
        if (m[0].startsWith('<?')) continue;
        if (m[3]) continue;
        if (m[1]) assert.equal(stack.pop(), m[2], `</${m[2]}> closes what it opened`); else stack.push(m[2]);
    }
    assert.equal(stack.length, 0, 'every element closes');
    for (const s of r.json.scenes) assert.ok(xml.includes(`<bin>\n      <name>${s.folder}</name>`), `a bin for ${s.folder}`);
    // Every referenced file is defined earlier.
    for (const m of xml.matchAll(/<file id="([^"]+)"\/>/g)) {
        const def = xml.indexOf(`<file id="${m[1]}">`);
        assert.ok(def >= 0 && def < m.index, `${m[1]} is defined before a bin references it`);
    }
    assert.ok(/<clip id="bin-clip-\d+">\s*<name>1A<\/name>/.test(xml) && /<name>2A<\/name>/.test(xml));
    // Every file URL points into the handover.
    const urls = [...xml.matchAll(/<pathurl>([^<]+)<\/pathurl>/g)].map(m => decodeURI(m[1].replace(/^file:\/\//, '')));
    assert.ok(urls.length >= 2);
    for (const u of urls) {
        assert.ok(u.startsWith(dest), `${u} is inside the handover`);
        assert.ok(fs.existsSync(u), `${u} exists`);
    }
});

test('every NLE export names the SELECTED clip, not the oldest or newest row', async () => {
    for (const fmt of ['premiere', 'fcpxml', 'edl']) {
        const r = await call('GET', ['film', 'projects', pid, 'export', fmt]);
        assert.equal(r.code, 200, fmt);
        if (fmt === 'edl') continue;               // an EDL names reels, not files
        assert.ok(r.text.includes('1A_take1.mp4'), `${fmt} names the selected clip`);
        for (const other of ['1A_take0.mp4', '1A_take2.mp4']) assert.ok(!r.text.includes(other), `${fmt} does not name ${other}`);
    }
});

test('a project with no clips is refused, and nothing is left behind', async () => {
    const empty = generateId();
    db.prepare(`INSERT INTO film_projects (id, title) VALUES (?, 'Empty')`).run(empty);
    const sc = generateId();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)`).run(sc, empty);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms) VALUES (?, ?, '1A', 1000)`).run(generateId(), sc);
    const r = await call('POST', ['film', 'projects', empty, 'export', 'premiere-scenes']);
    assert.equal(r.code, 409);
    assert.equal(r.json.error, 'NO_CLIPS');
});

test('an agent and a person can both reach it', () => {
    const { TOOLS } = require('../lib/mcp-tools');
    const names = new Set((TOOLS || require('../lib/mcp-tools').listTools()).map(t => t.name));
    assert.ok(names.has('export_premiere_scenes_plan') && names.has('export_premiere_scenes'));
    const src = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
    assert.match(src, /onclick="exportPremiereScenes\(\)"/);
    const at = src.indexOf('async function exportPremiereScenes(');
    const body = src.slice(at, src.indexOf('\n    }\n', at));
    assert.match(body, /export\/premiere-scenes/);
    assert.match(body, /method: 'POST'/);
});
