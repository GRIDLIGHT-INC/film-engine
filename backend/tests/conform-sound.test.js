const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

/**
 * THE MASTER CARRIES THE FILM'S OWN SOUND.
 *
 * The conform kept only the sound inside the clips, so a film whose dialogue,
 * score and ambience were generated here was assembled SILENT: the files played
 * in Playback and reached the NLE lanes, and none of them reached the master.
 *
 * Every assertion that matters is MEASURED from the file, because a filter
 * graph that names the right inputs and produces silence passes every string
 * check there is — which is how every join here was silent for months.
 *
 * Set-based over the kinds a scene's cue sheet can play (the timeline's own
 * BED_KIND_FOR) plus dialogue: a kind added to the cue sheet and never laid
 * fails here rather than going missing from the deliverable.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-conform-sound-' + crypto.randomUUID().slice(0, 8));
const { lavfiSource } = require('./helpers');

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const conform = require('../lib/conform');
const { BED_KIND_FOR } = require('../lib/timeline');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');

const bin = () => resolveFfmpeg().bin;
const sh = args => execFileSync(bin(), ['-nostdin', '-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-csound-')); });

function clip(name, secs, withSound) {
    const p = path.join(TMP, name);
    sh([...lavfiSource(`color=c=blue:s=320x240:d=${secs}`, withSound && `sine=frequency=200:duration=${secs}`),
        '-c:v', 'libx264', '-r', '24', '-t', String(secs), '-pix_fmt', 'yuv420p',
        ...(withSound ? ['-c:a', 'aac', '-shortest'] : []), p]);
    return p;
}
function tone(name, hz, secs) {
    const p = path.join(TMP, name);
    sh(['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}:sample_rate=48000`, '-ac', '2', '-c:a', 'pcm_s24le', p]);
    return p;
}
function meanDb(file, fromS, durS) {
    const r = spawnSync(bin(), ['-nostdin', '-ss', String(fromS), '-t', String(durS), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000 });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(r.stderr || ''));
    return m ? Number(m[1]) : null;
}
const HEARD = -45, SILENT = -60;

/** A film of `shots` two-second shots in one scene. */
function film({ shots = 2, clipSound = [] } = {}) {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, target_fps) VALUES (?, 'Sound', 24)").run(projectId);
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'ROOM')").run(sceneId, projectId);
    const ids = [];
    for (let i = 0; i < shots; i++) {
        const code = `1${String.fromCharCode(65 + i)}`, id = generateId(); ids.push(id);
        db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order) VALUES (?, ?, ?, ?, 2000, ?)")
            .run(id, sceneId, code, JSON.stringify({ shot_code: code, camera: {} }), i);
        const c = clip(`${projectId.slice(0, 6)}_${code}.mp4`, 2, clipSound.includes(i));
        db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms) VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 2000)")
            .run(generateId(), projectId, id, c, path.basename(c));
    }
    return { projectId, sceneId, ids };
}
function dialogue(f, shotIndex, secs) {
    const name = `${f.projectId.slice(0, 6)}_1${String.fromCharCode(65 + shotIndex)}_MAYA_0.wav`;
    const p = tone(name, 1000, secs);
    db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms) VALUES (?, ?, ?, 'audio_dialogue', ?, ?, 'wav', ?)")
        .run(generateId(), f.projectId, f.ids[shotIndex], p, name, secs * 1000);
}
function cue(f, cueType, secs, extra = {}) {
    const assetType = { music: 'audio_music', ambient: 'audio_ambient', sfx: 'audio_sfx' }[BED_KIND_FOR[cueType]];
    const p = tone(`${f.projectId.slice(0, 6)}_${cueType}_${generateId().slice(0, 4)}.wav`, 440, secs);
    const assetId = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_path, file_name, format, duration_ms) VALUES (?, ?, ?, ?, ?, ?, 'wav', ?)")
        .run(assetId, f.projectId, f.sceneId, assetType, p, path.basename(p), secs * 1000);
    db.prepare(`INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, title, start_ms, volume_db, fade_in_ms, fade_out_ms, generated_asset_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`)
        .run(generateId(), f.projectId, f.sceneId, cueType, cueType, extra.start_ms || 0, extra.volume_db || 0, assetId);
}

test('every kind a scene cue sheet plays is laid into the plan, and dialogue too', () => {
    const kinds = [...new Set(Object.values(BED_KIND_FOR))];
    assert.ok(kinds.length >= 3, `the cue-sheet kinds were not read: ${kinds}`);
    const f = film();
    for (const [cueType, kind] of Object.entries(BED_KIND_FOR)) {
        if (kinds.includes(kind)) { cue(f, cueType, 4); kinds.splice(kinds.indexOf(kind), 1); }
    }
    dialogue(f, 1, 1);
    // A shot's own effect, as POST /shots/:id/sfx/generate stores it.
    const fx = tone(`${f.projectId.slice(0, 6)}_1A_sfx.wav`, 700, 1);
    db.prepare("INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, duration_ms) VALUES (?, ?, ?, 'audio_sfx', ?, ?, 'wav', 1000)")
        .run(generateId(), f.projectId, f.ids[0], fx, path.basename(fx));
    const plan = conform.planConform(f.projectId);
    assert.ok(plan.ok, plan.error);
    const laid = new Set(plan.sound.placements.map(p => p.kind));
    for (const kind of [...new Set(Object.values(BED_KIND_FOR)), 'dialogue', 'shot_sfx']) {
        assert.ok(laid.has(kind), `${kind} is generated for this film and never reaches the master`);
    }
    const line = plan.sound.placements.find(p => p.kind === 'dialogue');
    assert.strictEqual(line.offset_ms, 2000, 'the line does not start where its shot starts in the cut');
});

test('the master is heard: a line where its shot plays, silence before it', async () => {
    const f = film();
    dialogue(f, 1, 1);
    const out = await conform.runConform(f.projectId, { filename: 'line_master' });
    assert.ok(out.ok, out.error);
    const before = meanDb(out.output, 0.3, 1.4), during = meanDb(out.output, 2.1, 0.8);
    assert.ok(before === null || before < SILENT, `the film is not silent before the line (${before} dB)`);
    assert.ok(during !== null && during > HEARD, `the line is not in the master where its shot plays (${during} dB)`);
    assert.ok(Math.abs(inspectMedia(out.output).durationSeconds - 4) < 0.3, 'laying sound changed the film\'s length');
});

test('a bed plays across its scene at its own level, and stops where the film does', async () => {
    const f = film();
    cue(f, 'ambient', 10, { volume_db: -6 });
    const plan = conform.planConform(f.projectId);
    const bed = plan.sound.placements.find(p => p.kind === 'ambient');
    assert.strictEqual(bed.gain_db, -6, 'the cue\'s own level was not carried');
    assert.strictEqual(bed.play_ms, 4000, 'a bed longer than its scene is not stopped where the scene ends');
    const out = await conform.runConform(f.projectId, { filename: 'bed_master' });
    assert.ok(out.ok, out.error);
    assert.ok(meanDb(out.output, 0.2, 1.5) > HEARD && meanDb(out.output, 2.2, 1.5) > HEARD, 'the bed is not heard across its scene');
    assert.ok(Math.abs(inspectMedia(out.output).durationSeconds - 4) < 0.3, 'a ten-second bed lengthened a four-second film');
});

test('a clip that carries its own sound is not talked over by its generated dialogue', () => {
    const f = film({ clipSound: [1] });
    dialogue(f, 1, 1);
    const plan = conform.planConform(f.projectId);
    assert.strictEqual(plan.sound.placements.filter(p => p.kind === 'dialogue').length, 0,
        'the line is laid under a clip that already speaks it, so it would be said twice');
    assert.ok(plan.sound.reports.some(r => /carries its own sound/.test(r)), 'the skip is not said');
});

test('a finished project mix is the soundtrack: nothing is laid over it', () => {
    const f = film();
    dialogue(f, 1, 1);
    cue(f, 'score', 4);
    const mix = tone(`${f.projectId.slice(0, 6)}_mix.wav`, 330, 4);
    db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, duration_ms, metadata) VALUES (?, ?, 'audio_mix', ?, ?, 'wav', 4000, '{}')")
        .run(generateId(), f.projectId, mix, path.basename(mix));
    const plan = conform.planConform(f.projectId);
    assert.strictEqual(plan.sound.placements.length, 0, 'generated sound is laid over a mix that already contains it');
});

test("a bed's level is in the audio, not only in the plan", async () => {
    // A filter graph that drops `volume` still carries gain_db in the plan and
    // plays every bed at unity: only the file can tell the two apart.
    const level = async db_ => {
        const f = film();
        cue(f, 'ambient', 4, { volume_db: db_ });
        const out = await conform.runConform(f.projectId, { filename: `lvl_${Math.abs(db_)}` });
        assert.ok(out.ok, out.error);
        return meanDb(out.output, 0.5, 3);
    };
    const loud = await level(-3), quiet = await level(-23);
    assert.ok(loud - quiet > 15, `a 20dB difference in the cue's level is ${(loud - quiet).toFixed(1)}dB in the master`);
});
