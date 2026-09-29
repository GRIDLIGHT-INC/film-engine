/**
 * PREMIERE, ONE FOLDER PER SCENE.
 *
 * "A function that creates the folders per scene for Premiere and drops the
 * video in, to make it easy for the editing part."
 *
 * An editor opening a project wants the media already sorted the way the film
 * is: one folder per scene, each holding that scene's clips named by shot code
 * and its sound beside them. So the handover is:
 *
 *   <Title>_Premiere_<stamp>/
 *     <Title>.xml                 the cut, as Premiere XML (xmeml v5), with a bin per scene
 *     READ ME.txt                 what is here and what was missing
 *     Scene_01_INT-DINER-NIGHT/
 *       Video/1A.mp4 …            each shot's SELECTED clip (the conform's own rule)
 *       Sound/1A_dialogue_1.mp3 … the shot's dialogue and effects, the scene's beds
 *     Score/                      an approved score, when there is one
 *
 * The XML points at the copies, as file URLs, so it opens online on this
 * machine; moved elsewhere, Premiere's Locate finds them by the same folders.
 * The bins reference the files the sequence defines (xmeml lets a file be
 * defined once and referenced by id afterwards), so each scene's clips appear
 * in its bin and on the timeline as ONE master clip, never two.
 *
 * Media is COPIED, never moved: the project's own files must survive a handover.
 * Planning is free and separate from writing, on the conform's precedent.
 */
const fs = require('fs');
const path = require('path');

const VIDEO = ['video_final', 'video_synced', 'video_raw'];
const SOUND = ['audio_dialogue', 'audio_sfx', 'audio_music', 'audio_ambient'];

/** A folder name that is safe in a file URL and still readable. */
function sceneFolder(scene) {
    const num = String(scene.scene_number == null ? '' : scene.scene_number);
    const n = /^\d+$/.test(num) ? num.padStart(2, '0') : (num || 'X');
    const words = [scene.int_ext, scene.location, scene.time_of_day].filter(Boolean).join(' ');
    const slug = words.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return `Scene_${n}${slug ? '_' + slug : ''}`;
}

function extOf(a) {
    const e = path.extname(a.file_name || a.file_path || '').replace('.', '');
    return e || a.format || 'bin';
}

/**
 * What the handover would hold. FREE: reads rows and checks files exist.
 * `shots` and `assets` are the export's own (folded, selected, scored), so the
 * plan describes exactly the XML that will be written.
 */
function planPremiereScenes(db, project, shots, assets) {
    const scenes = new Map();
    const sceneRows = db.prepare('SELECT id, scene_number, int_ext, location, time_of_day FROM film_scenes WHERE project_id = ?')
        .all(project.id);
    const sceneById = new Map(sceneRows.map(s => [s.id, s]));
    const taken = new Set();
    const files = [];            // { asset_id, from, to (relative), kind, scene_folder, shot_code }
    const missing = [];

    const folderOf = sceneId => {
        if (scenes.has(sceneId)) return scenes.get(sceneId).folder;
        const sc = sceneById.get(sceneId) || { scene_number: '?' };
        let folder = sceneFolder(sc);
        while (taken.has(folder)) folder += '_';
        taken.add(folder);
        scenes.set(sceneId, { scene_id: sceneId, scene_number: sc.scene_number, folder, shots: [], sound: [] });
        return folder;
    };
    const add = (a, rel, kind, sceneId, code) => {
        if (!a.file_path || !fs.existsSync(a.file_path)) {
            missing.push({ asset_id: a.id, shot_code: code || null, kind, reason: `there is no file at ${a.file_path || '(no path)'}` });
            return;
        }
        files.push({ asset_id: a.id, from: a.file_path, to: rel, kind, scene_folder: sceneId ? folderOf(sceneId) : null, shot_code: code || null });
    };

    const shotScene = new Map(shots.map(s => [s.id, s.scene_id]));
    for (const sh of shots) {
        const folder = folderOf(sh.scene_id);
        const entry = scenes.get(sh.scene_id);
        const clip = assets.find(a => a.shot_id === sh.id && VIDEO.includes(a.asset_type));
        if (clip) {
            add(clip, `${folder}/Video/${sh.shot_code}.${extOf(clip)}`, 'video', sh.scene_id, sh.shot_code);
            entry.shots.push({ shot_code: sh.shot_code, asset_id: clip.id, file: `${folder}/Video/${sh.shot_code}.${extOf(clip)}` });
        } else {
            entry.shots.push({ shot_code: sh.shot_code, asset_id: null, file: null });
            missing.push({ asset_id: null, shot_code: sh.shot_code, kind: 'video', reason: 'this shot has no clip yet' });
        }
    }
    // Sound: a shot's own lines and effects, then each scene's beds, then a score.
    const counts = new Map();
    for (const a of assets) {
        if (!SOUND.includes(a.asset_type)) continue;
        let sceneId = a.shot_id ? shotScene.get(a.shot_id) : a.scene_id;
        let rel;
        const label = a.asset_type.replace('audio_', '');
        if (a.lay_on_shot_id) {                            // an approved score (MUS-020)
            rel = `Score/${path.basename(a.file_path || a.id)}`;
            sceneId = null;
        } else {
            if (!sceneId || !shotScene.size || ![...shotScene.values()].includes(sceneId)) continue;
            const code = a.shot_id ? (shots.find(s => s.id === a.shot_id) || {}).shot_code : 'scene';
            const key = `${sceneId}|${code}|${label}`;
            const n = (counts.get(key) || 0) + 1; counts.set(key, n);
            rel = `${folderOf(sceneId)}/Sound/${code}_${label}_${n}.${extOf(a)}`;
        }
        add(a, rel, label, sceneId, null);
        if (sceneId && scenes.has(sceneId)) scenes.get(sceneId).sound.push(rel);
    }

    return {
        project_id: project.id,
        scenes: [...scenes.values()],
        files: files.map(({ from, ...rest }) => rest),
        file_count: files.length,
        missing,
        _files: files,
    };
}

/** The sequence element out of a whole xmeml document. */
function sequenceOf(xml) {
    const start = xml.indexOf('<sequence');
    const end = xml.lastIndexOf('</sequence>');
    if (start < 0 || end < 0) throw new Error('the Premiere generator returned no sequence');
    return xml.slice(start, end + '</sequence>'.length);
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The xmeml: the sequence first (it DEFINES every file), then a bin per scene
 * whose clips reference those definitions by id.
 */
function buildScenesXml(project, plan, sequenceXml, fps) {
    // clipitem name → the id of the file it defines, read from our own generator.
    const fileIdByCode = new Map();
    const re = /<clipitem id="[^"]*">\s*<name>([^<]*)<\/name>[\s\S]*?<file id="([^"]+)">/g;
    let m;
    while ((m = re.exec(sequenceXml))) if (!fileIdByCode.has(m[1])) fileIdByCode.set(m[1], m[2]);
    const timebase = Math.round(Number(fps) || 24);
    const ntsc = [23.976, 29.97, 59.94].some(x => Math.abs(Number(fps) - x) < 0.01) ? 'TRUE' : 'FALSE';

    let n = 0;
    const bins = plan.scenes.map(sc => {
        const clips = sc.shots.filter(s => fileIdByCode.has(esc(s.shot_code))).map(s => {
            n++;
            return `        <clip id="bin-clip-${n}">
          <name>${esc(s.shot_code)}</name>
          <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
          <media><video><track><clipitem id="bin-clipitem-${n}"><name>${esc(s.shot_code)}</name><file id="${fileIdByCode.get(esc(s.shot_code))}"/></clipitem></track></video></media>
        </clip>\n`;
        }).join('');
        return `    <bin>\n      <name>${esc(sc.folder)}</name>\n      <children>\n${clips}      </children>\n    </bin>\n`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
<project>
  <name>${esc(project.title || 'Untitled')}</name>
  <children>
${sequenceXml}
${bins}  </children>
</project>
</xmeml>
`;
}

/**
 * Write the handover. `opts.dest` is the folder to create; it must not exist
 * or must be empty. Returns what was written.
 */
function writePremiereScenes(db, project, shots, assets, opts = {}) {
    const { generatePremiereXML } = require('./nle-export');
    const dest = opts.dest;
    if (!dest) throw new Error('writePremiereScenes needs a destination folder');
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
        const err = new Error(`${dest} already has files in it; a handover is written into a new folder`);
        err.code = 'DEST_NOT_EMPTY';
        throw err;
    }
    const plan = planPremiereScenes(db, project, shots, assets);
    if (!plan.scenes.some(s => s.shots.some(x => x.asset_id))) {
        const err = new Error('No shot has a clip yet, so there is nothing to put in a scene folder.');
        err.code = 'NO_CLIPS';
        err.plan = plan;
        throw err;
    }

    fs.mkdirSync(dest, { recursive: true });
    const url = new Map();
    for (const f of plan._files) {
        const to = path.join(dest, f.to);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(f.from, to);
        url.set(f.asset_id, 'file://' + encodeURI(to));
    }
    // The generator turns file_path into a file URL; an URL is left as it is.
    const rewritten = assets.map(a => (url.has(a.id) ? { ...a, file_path: url.get(a.id) } : a));
    const settings = opts.settings || {};
    const sequence = sequenceOf(generatePremiereXML(project, shots, rewritten, settings, null));
    const xml = buildScenesXml(project, plan, sequence, settings.target_fps || project.target_fps);
    const stem = (project.title || 'export').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'export';
    const xmlPath = path.join(dest, `${stem}.xml`);
    fs.writeFileSync(xmlPath, xml, 'utf8');

    const readme = [
        `${project.title || 'Untitled'} — Premiere handover, one folder per scene.`,
        '',
        `Import ${path.basename(xmlPath)} into Premiere (File > Import). It carries the cut as a sequence and a bin per scene.`,
        'Or import the scene folders themselves: Premiere makes a bin for each folder.',
        '',
        ...plan.scenes.map(s => `${s.folder}: ${s.shots.map(x => x.shot_code + (x.asset_id ? '' : ' (no clip)')).join(', ')}`),
        '',
        plan.missing.length ? 'Missing when this was made:' : 'Nothing was missing when this was made.',
        ...plan.missing.map(x => `  ${x.shot_code || x.asset_id || ''} ${x.kind}: ${x.reason}`),
        '',
    ].join('\n');
    fs.writeFileSync(path.join(dest, 'READ ME.txt'), readme, 'utf8');

    const { _files, ...pub } = plan;
    return { ...pub, dest, xml: path.basename(xmlPath), copied: _files.length };
}

module.exports = { planPremiereScenes, writePremiereScenes, buildScenesXml, sceneFolder };
