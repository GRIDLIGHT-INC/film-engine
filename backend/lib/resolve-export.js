/**
 * DAVINCI RESOLVE: THE FILM, READY TO EDIT.
 *
 * "I'd like to be able to export to DaVinci Resolve, ready to edit with all the
 * information, and a first edit based on shots and footage. Can we make a
 * connection to it?"
 *
 * The first edit is the cut PLAYBACK already plays (routes/timeline.loadTimeline),
 * not a second assembly: each shot in running order at the length Playback holds
 * it, its selected clip or, when it has none yet, its storyboard frame held for
 * that length; the dialogue lines where Playback speaks them (with the card's
 * pauses), the shot's effects, and every scene bed at its offset and level. Two
 * assemblies of one film is how an editor gets a cut that disagrees with what the
 * director approved on screen.
 *
 *   <Title>_Resolve_<stamp>/
 *     <Title>.xml                    the first edit (FCP 7 XML, which Resolve imports
 *                                    with stills, levels and clip markers intact)
 *     <Title>_metadata.csv           File > Import Metadata: scene, shot, description,
 *                                    dialogue, camera, per file
 *     Import into Resolve.py         the connection: run inside Resolve (Workspace >
 *                                    Scripts), it makes the project, a bin per scene,
 *                                    imports the media and the timeline, and adds the
 *                                    shot markers
 *     READ ME.txt
 *     Scene_01_INT-DINER-NIGHT/
 *       Video/1A.mp4  Stills/1B.png  Sound/1A_dialogue_1.mp3 …
 *     Score/
 *
 * Media is COPIED, never moved, and the plan is free and separate from writing,
 * on the conform's and the Premiere handover's precedent.
 */
const fs = require('fs');
const path = require('path');
const { escapeXml: esc, isNtscFps, msToFrames, msToTimecode } = require('./nle-export');
const { sceneFolder } = require('./premiere-scenes');

const DEFAULT_FPS = 24;
// Bed kinds get their own lanes, after dialogue and effects, in a fixed order an
// editor can rely on: A1 production sound, A2 dialogue, A3 effects, then beds.
const LANES = [
    { key: 'clip', name: 'Production sound' },
    { key: 'dialogue', name: 'Dialogue' },
    { key: 'sfx', name: 'Effects' },
    { key: 'music', name: 'Music' },
    { key: 'ambient', name: 'Ambience' },
];

function parseCard(json) {
    try { return JSON.parse(json || '{}') || {}; } catch (_) { return {}; }
}

function extOf(p) {
    return (path.extname(p || '').replace('.', '') || 'bin').toLowerCase();
}

/** What a card says, as the words an editor reads on a marker and in the metadata. */
function shotInfo(card) {
    const cam = card.camera || {};
    const dialogue = (Array.isArray(card.dialogue) ? card.dialogue : [])
        .map(d => (typeof d === 'string' ? d : [d.character, d.parenthetical ? `(${d.parenthetical})` : '', d.line || d.text].filter(Boolean).join(' ')))
        .filter(Boolean);
    const camera = [cam.framing, cam.shot_type, cam.lens, cam.movement, cam.angle].filter(Boolean).join(', ');
    return {
        description: String(card.description || card.action || '').trim(),
        direction: String(card.direction || '').trim(),
        dialogue,
        camera,
        characters: (card.characters || []).map(c => (typeof c === 'string' ? c : c && c.name)).filter(Boolean),
        props: (card.props || []).map(p => (typeof p === 'string' ? p : p && p.name)).filter(Boolean),
        lighting: [card.lighting && card.lighting.type, card.lighting && card.lighting.technique].filter(Boolean).join(', '),
    };
}

/** A marker note: everything about the shot, one fact per line. */
function markerNote(info) {
    return [
        info.description,
        info.direction && `Direction: ${info.direction}`,
        info.dialogue.length && `Dialogue: ${info.dialogue.join(' / ')}`,
        info.camera && `Camera: ${info.camera}`,
        info.characters.length && `Cast: ${info.characters.join(', ')}`,
        info.lighting && `Lighting: ${info.lighting}`,
    ].filter(Boolean).join('\n');
}

/**
 * What the export would hold. FREE: reads rows and checks files exist.
 * Returns the edit as clips on lanes, in milliseconds, and the files to copy.
 */
function planResolve(db, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) { const e = new Error('Project not found'); e.code = 'NOT_FOUND'; throw e; }
    const timeline = require('../routes/timeline').loadTimeline(projectId);
    const fps = Number(project.target_fps) || Number(timeline && timeline.fps) || DEFAULT_FPS;

    const scenes = db.prepare('SELECT id, scene_number, int_ext, location, time_of_day, description FROM film_scenes WHERE project_id = ?').all(projectId);
    const sceneById = new Map(scenes.map(s => [s.id, s]));
    const shotRows = db.prepare(`SELECT sh.id, sh.shot_code, sh.scene_card_yaml, sh.scene_id FROM film_shots sh
        JOIN film_scenes s ON s.id = sh.scene_id WHERE s.project_id = ?`).all(projectId);
    const shotById = new Map(shotRows.map(s => [s.id, s]));
    const notesBy = new Map();
    for (const n of db.prepare(`SELECT n.shot_id, n.content, n.timecode_ms, n.resolved FROM film_shot_notes n
        JOIN film_shots sh ON sh.id = n.shot_id JOIN film_scenes s ON s.id = sh.scene_id
        WHERE s.project_id = ? AND (n.resolved IS NULL OR n.resolved = 0)`).all(projectId)) {
        (notesBy.get(n.shot_id) || notesBy.set(n.shot_id, []).get(n.shot_id)).push(n);
    }

    const folders = new Map();
    const taken = new Set();
    const folderOf = sceneId => {
        if (!sceneId) return 'Unplaced';
        if (folders.has(sceneId)) return folders.get(sceneId);
        let f = sceneFolder(sceneById.get(sceneId) || { scene_number: '?' });
        while (taken.has(f)) f += '_';
        taken.add(f); folders.set(sceneId, f);
        return f;
    };

    const files = new Map();      // source path -> { from, to, kind }
    const missing = [];
    const fileFor = (from, rel, kind) => {
        if (!from || !fs.existsSync(from)) { missing.push({ kind, file: rel, reason: `there is no file at ${from || '(no path)'}` }); return null; }
        if (!files.has(from)) {
            let to = rel; let n = 1;
            const used = new Set([...files.values()].map(f => f.to));
            while (used.has(to)) { n += 1; to = rel.replace(/(\.[^.]+)$/, `_${n}$1`); }
            files.set(from, { from, to, kind });
        }
        return files.get(from).to;
    };

    const video = [];
    const lanes = { clip: [], dialogue: [], sfx: [], music: [], ambient: [] };
    const markers = [];
    const shots = [];
    const entries = (timeline && timeline.entries) || [];
    const { inspectMedia } = require('./ffmpeg');
    let lastScene = null;

    // Shot effects (audio_sfx on the shot): the timeline carries one audio asset
    // per shot, so these come from the rows, newest per file, as the conform reads them.
    const sfxByShot = new Map();
    for (const r of db.prepare(`SELECT shot_id, file_path, file_name, duration_ms FROM film_assets
        WHERE project_id = ? AND asset_type = 'audio_sfx' AND shot_id IS NOT NULL ORDER BY created_at DESC`).all(projectId)) {
        const list = sfxByShot.get(r.shot_id) || [];
        if (!list.some(x => x.file_name === r.file_name)) list.push(r);
        sfxByShot.set(r.shot_id, list);
    }

    for (const e of entries) {
        const shot = shotById.get(e.shot_id) || {};
        const card = parseCard(shot.scene_card_yaml);
        const info = shotInfo(card);
        const folder = folderOf(e.scene_id);
        const code = e.shot_code || shot.shot_code || `shot${e.index + 1}`;
        const sc = sceneById.get(e.scene_id) || {};
        const heading = [sc.int_ext, sc.location, sc.time_of_day].filter(Boolean).join(' ');
        const row = { shot_id: e.shot_id, shot_code: code, scene: sc.scene_number, heading, start_ms: e.start_ms, duration_ms: e.duration_ms, info, picture: 'none', file: null };

        if (e.scene_id !== lastScene) {
            markers.push({ at_ms: e.start_ms, name: `Scene ${sc.scene_number == null ? '?' : sc.scene_number}`, note: [heading, sc.description].filter(Boolean).join('\n'), color: 'Blue' });
            lastScene = e.scene_id;
        }

        let carries = false;
        if (e.video && e.video.path) {
            const rel = fileFor(e.video.path, `${folder}/Video/${code}.${extOf(e.video.path)}`, 'video');
            if (rel) {
                let srcMs = Number(e.video.duration_ms) || 0;
                try { const seen = inspectMedia(e.video.path); carries = !!(seen.ok && seen.hasAudio); if (!srcMs && seen.ok && seen.durationSeconds) srcMs = Math.round(seen.durationSeconds * 1000); } catch (_) { /* unreadable clips still go on the timeline */ }
                video.push({ name: code, file: rel, start_ms: e.start_ms, duration_ms: e.duration_ms, source_ms: srcMs || e.duration_ms, still: false, note: markerNote(info) });
                if (carries) lanes.clip.push({ name: code, file: rel, start_ms: e.start_ms, duration_ms: e.duration_ms, source_ms: srcMs || e.duration_ms, gain_db: 0 });
                row.picture = 'clip'; row.file = rel;
            }
        } else if (e.still && e.still.path) {
            const rel = fileFor(e.still.path, `${folder}/Stills/${code}.${extOf(e.still.path)}`, 'still');
            if (rel) {
                video.push({ name: `${code} (board)`, file: rel, start_ms: e.start_ms, duration_ms: e.duration_ms, still: true, note: markerNote(info) });
                row.picture = 'storyboard'; row.file = rel;
            }
        }
        if (row.picture === 'none') missing.push({ kind: 'picture', shot_code: code, reason: 'this shot has no clip and no storyboard frame; it is a gap in the edit' });

        markers.push({ at_ms: e.start_ms, name: code, note: markerNote(info), color: row.picture === 'clip' ? 'Green' : row.picture === 'storyboard' ? 'Yellow' : 'Red' });
        for (const n of notesBy.get(e.shot_id) || []) {
            markers.push({ at_ms: e.start_ms + Math.min(Math.max(0, Number(n.timecode_ms) || 0), Math.max(0, e.duration_ms - 1)), name: `Note ${code}`, note: n.content, color: 'Red' });
        }

        // Dialogue and effects follow Playback's rule: a clip that carries its own
        // sound speaks for itself, and laying the generated lines over it says
        // every line twice.
        const end = e.start_ms + e.duration_ms;
        if (!carries) {
            let t = e.start_ms;
            for (const [i, line] of (e.audio_lines || []).entries()) {
                if (!line || !line.path || t >= end) continue;
                const rel = fileFor(line.path, `${folder}/Sound/${code}_dialogue_${i + 1}.${extOf(line.path)}`, 'dialogue');
                const dur = Number(line.duration_ms) || 0;
                if (rel) lanes.dialogue.push({ name: `${code} line ${i + 1}`, file: rel, start_ms: t, duration_ms: dur > 0 ? Math.min(dur, end - t) : end - t, source_ms: dur || end - t, gain_db: 0 });
                t += dur + (Number.isFinite(Number(line.pause_after_ms)) ? Number(line.pause_after_ms) : 700);
            }
            for (const [i, r] of (sfxByShot.get(e.shot_id) || []).entries()) {
                const rel = fileFor(r.file_path, `${folder}/Sound/${code}_sfx_${i + 1}.${extOf(r.file_path)}`, 'sfx');
                const dur = Number(r.duration_ms) || 0;
                if (rel) lanes.sfx.push({ name: `${code} sfx ${i + 1}`, file: rel, start_ms: e.start_ms, duration_ms: dur > 0 ? Math.min(dur, e.duration_ms) : e.duration_ms, source_ms: dur || e.duration_ms, gain_db: -4 });
            }
        }
        shots.push(row);
    }

    for (const [i, b] of ((timeline && timeline.beds) || []).entries()) {
        const kind = b.kind === 'ambient' ? 'ambient' : b.kind === 'sfx' ? 'sfx' : 'music';
        const isScore = b.source === 'score_session';
        const rel = fileFor(b.path, isScore ? `Score/${path.basename(b.path)}` : `${folderOf(b.scene_id)}/Sound/scene_${kind}_${i + 1}.${extOf(b.path)}`, kind);
        if (!rel) continue;
        const span = Math.max(0, (b.end_ms || 0) - (b.start_ms || 0));
        const srcMs = Number(b.asset_duration_ms) || span;
        lanes[kind].push({ name: `${kind} ${path.basename(b.path)}`, file: rel, start_ms: b.start_ms, duration_ms: Math.min(span, srcMs) || span, source_ms: srcMs, gain_db: Number(b.gain_db) || 0, fade_in_ms: b.fade_in_ms || 0, fade_out_ms: b.fade_out_ms || 0 });
    }

    return {
        project_id: projectId,
        title: project.title || 'Untitled',
        fps,
        resolution: project.target_resolution || '1920x1080',
        total_ms: (timeline && timeline.total_duration_ms) || 0,
        shots,
        video,
        lanes,
        markers,
        folders: [...new Set([...files.values()].map(f => f.to.split('/')[0]))],
        files: [...files.values()].map(({ from, ...rest }) => rest),
        file_count: files.size,
        missing,
        counts: {
            shots: shots.length,
            clips: shots.filter(s => s.picture === 'clip').length,
            storyboard_frames: shots.filter(s => s.picture === 'storyboard').length,
            gaps: shots.filter(s => s.picture === 'none').length,
            dialogue_lines: lanes.dialogue.length,
            effects: lanes.sfx.length,
            beds: lanes.music.length + lanes.ambient.length,
            markers: markers.length,
        },
        _files: [...files.values()],
    };
}

/** Clips that overlap on one lane go to the next track of that lane. */
function stack(items) {
    const tracks = [];
    for (const it of [...items].sort((a, b) => a.start_ms - b.start_ms)) {
        let t = tracks.find(tr => tr[tr.length - 1].start_ms + tr[tr.length - 1].duration_ms <= it.start_ms);
        if (!t) { t = []; tracks.push(t); }
        t.push(it);
    }
    return tracks;
}

/** The first edit as FCP 7 XML (xmeml v5), the format Resolve imports with stills. */
function buildResolveXml(plan, urlOf) {
    const fps = plan.fps;
    const tb = Math.round(fps);
    const ntsc = isNtscFps(fps) ? 'TRUE' : 'FALSE';
    const rate = `<rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>`;
    const [w, h] = String(plan.resolution).split('x').map(Number);
    const f = ms => msToFrames(Math.max(0, ms), fps);
    const fileIds = new Map();
    const fileEl = (rel, isStill, srcMs, hasAudio) => {
        if (fileIds.has(rel)) return `<file id="${fileIds.get(rel)}"/>`;
        const id = `file-${fileIds.size + 1}`;
        fileIds.set(rel, id);
        const media = isStill
            ? `<media><video><samplecharacteristics><width>${w || 1920}</width><height>${h || 1080}</height></samplecharacteristics></video></media>`
            : `<media>${/\.(mp4|mov|m4v|webm|mkv)$/i.test(rel) ? '<video/>' : ''}${hasAudio !== false ? '<audio><channelcount>2</channelcount></audio>' : ''}</media>`;
        return `<file id="${id}"><name>${esc(path.basename(rel))}</name><pathurl>${esc(urlOf(rel))}</pathurl>${rate}<duration>${isStill ? f(3600000) : f(srcMs || 0)}</duration>${media}</file>`;
    };
    let n = 0;
    const clipitem = (it, kind) => {
        n += 1;
        const dur = f(it.duration_ms);
        const start = f(it.start_ms);
        const level = Number.isFinite(it.gain_db) && it.gain_db !== 0
            ? `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${Math.pow(10, it.gain_db / 20).toFixed(5)}</value></parameter></effect></filter>` : '';
        const marker = kind === 'video' && it.note
            ? `<marker><name>${esc(it.name)}</name><comment>${esc(it.note)}</comment><in>0</in><out>-1</out></marker>` : '';
        return `<clipitem id="clipitem-${n}"><name>${esc(it.name)}</name><enabled>TRUE</enabled><duration>${it.still ? dur : f(it.source_ms || it.duration_ms)}</duration>${rate}`
            + `<start>${start}</start><end>${start + dur}</end><in>0</in><out>${dur}</out>`
            + fileEl(it.file, !!it.still, it.source_ms, kind === 'video' ? undefined : true)
            + (kind !== 'video' ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>' : '')
            + level + marker + `</clipitem>`;
    };
    const videoTrack = `<track>${plan.video.map(v => clipitem(v, 'video')).join('')}</track>`;
    const audioTracks = LANES.flatMap(l => stack(plan.lanes[l.key] || []).map(items => `<track>${items.map(it => clipitem(it, l.key)).join('')}</track>`)).join('');
    const seqMarkers = plan.markers.filter(m => /^Scene /.test(m.name) || /^Note /.test(m.name))
        .map(m => `<marker><name>${esc(m.name)}</name><comment>${esc(m.note || '')}</comment><in>${f(m.at_ms)}</in><out>-1</out></marker>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
<sequence id="sequence-1">
<name>${esc(plan.title)} — first edit</name>
<duration>${f(plan.total_ms)}</duration>
${rate}
<timecode>${rate}<string>${msToTimecode(0, fps)}</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
<media>
<video><format><samplecharacteristics>${rate}<width>${w || 1920}</width><height>${h || 1080}</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>${videoTrack}</video>
<audio>${audioTracks}</audio>
</media>
${seqMarkers}
</sequence>
</xmeml>
`;
}

function csvCell(v) {
    const s = Array.isArray(v) ? v.join(' / ') : String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Resolve's File > Import Metadata matches rows to clips by File Name. */
function buildMetadataCsv(plan) {
    const head = ['File Name', 'Clip Name', 'Scene', 'Shot', 'Description', 'Comments', 'Keywords', 'Camera'];
    const rows = plan.shots.filter(s => s.file).map(s => [
        path.basename(s.file), s.shot_code, s.scene, s.shot_code, s.info.description,
        [s.heading, s.info.direction, s.info.dialogue.length ? `Dialogue: ${s.info.dialogue.join(' / ')}` : '', s.picture === 'storyboard' ? 'Storyboard frame: no footage yet' : ''].filter(Boolean).join(' | '),
        [...s.info.characters, ...s.info.props].join(', '), s.info.camera,
    ]);
    return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

/**
 * The connection. Runs inside Resolve (Workspace > Scripts, which works in the
 * free version) or from a terminal with Resolve Studio open. It makes the project,
 * a bin per scene, imports the media, the first edit and the metadata, and puts a
 * marker with the shot's information on every shot.
 */
function buildImportScript(plan, xmlName, csvName) {
    const markerData = plan.markers.map(m => ({ frame: msToFrames(m.at_ms, plan.fps), name: m.name, note: m.note || '', color: m.color }));
    return `#!/usr/bin/env python3
# Film Engine -> DaVinci Resolve: "${plan.title.replace(/"/g, '')}"
#
# Inside Resolve: copy this folder anywhere, then copy this file into
#   ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/
# and run it from Workspace > Scripts > Utility. That works in the free version.
# With Resolve Studio open you can also run it from a terminal:  python3 "Import into Resolve.py"
#
# It creates the project, sets its frame rate and resolution, makes a bin per
# scene, imports the media, the first edit (${xmlName}) and the shot information
# (${csvName}), and adds a marker with each shot's information.
import os, sys, json

HERE = ${JSON.stringify('__HERE__')}
if HERE == "__HERE__" or not os.path.isdir(HERE):
    HERE = os.path.dirname(os.path.abspath(__file__))

TITLE = ${JSON.stringify(plan.title)}
FPS = ${JSON.stringify(String(plan.fps))}
RES = ${JSON.stringify(plan.resolution)}
FOLDERS = ${JSON.stringify(plan.folders)}
MARKERS = json.loads(${JSON.stringify(JSON.stringify(markerData))})

def get_resolve():
    try:
        return resolve  # noqa: F821  (defined when run from Resolve's Scripts menu)
    except NameError:
        pass
    for p in ["/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules",
              os.path.expandvars(r"%PROGRAMDATA%\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting\\Modules"),
              "/opt/resolve/Developer/Scripting/Modules"]:
        if os.path.isdir(p) and p not in sys.path:
            sys.path.append(p)
    try:
        import DaVinciResolveScript as dvr
        return dvr.scriptapp("Resolve")
    except Exception as err:
        print("Could not reach Resolve:", err)
        return None

def main():
    r = get_resolve()
    if not r:
        print("Open DaVinci Resolve first. From a terminal this needs Resolve Studio; in the free version run it from Workspace > Scripts.")
        return 1
    pm = r.GetProjectManager()
    name = TITLE
    project = pm.CreateProject(name)
    n = 2
    while not project:
        name = "%s (%d)" % (TITLE, n); n += 1
        project = pm.CreateProject(name)
    w, h = RES.split("x")
    for k, v in (("timelineFrameRate", FPS), ("timelineResolutionWidth", w), ("timelineResolutionHeight", h),
                 ("timelinePlaybackFrameRate", FPS)):
        project.SetSetting(k, v)
    pool = project.GetMediaPool()
    root = pool.GetRootFolder()
    for folder in FOLDERS:
        full = os.path.join(HERE, folder)
        if not os.path.isdir(full):
            continue
        b = pool.AddSubFolder(root, folder)
        pool.SetCurrentFolder(b)
        paths = []
        for dirpath, _, files in os.walk(full):
            paths += [os.path.join(dirpath, f) for f in sorted(files) if not f.startswith(".")]
        if paths:
            pool.ImportMedia(paths)
    pool.SetCurrentFolder(root)
    tl = pool.ImportTimelineFromFile(os.path.join(HERE, ${JSON.stringify(xmlName)}), {"timelineName": TITLE + " — first edit", "importSourceClips": False, "sourceClipsPath": HERE})
    if not tl:
        print("The timeline did not import. In Resolve: File > Import > Timeline and pick", ${JSON.stringify(xmlName)})
    else:
        project.SetCurrentTimeline(tl)
        for m in MARKERS:
            tl.AddMarker(m["frame"], m["color"], m["name"], m["note"], 1)
    csv = os.path.join(HERE, ${JSON.stringify(csvName)})
    print("Done: project", name, "with", len(MARKERS), "markers.")
    print("For the shot information on every clip: Media Pool > select all > right-click > Import Metadata, and pick", csv)
    return 0

if __name__ == "__main__":
    sys.exit(main() or 0)
else:
    main()
`;
}

/** Write the export. `opts.dest` must not exist or must be empty. */
function writeResolve(db, projectId, opts = {}) {
    const dest = opts.dest;
    if (!dest) throw new Error('writeResolve needs a destination folder');
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
        const err = new Error(`${dest} already has files in it; an export is written into a new folder`);
        err.code = 'DEST_NOT_EMPTY'; throw err;
    }
    const plan = planResolve(db, projectId);
    if (!plan.video.length) {
        const err = new Error('No shot has a clip or a storyboard frame yet, so there is no edit to hand over.');
        err.code = 'NOTHING_TO_EDIT'; err.plan = plan; throw err;
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const f of plan._files) {
        const to = path.join(dest, f.to);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(f.from, to);
    }
    const stem = plan.title.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'export';
    const xmlName = `${stem}.xml`;
    const csvName = `${stem}_metadata.csv`;
    const urlOf = rel => 'file://' + encodeURI(path.join(dest, rel)).replace(/#/g, '%23');
    fs.writeFileSync(path.join(dest, xmlName), buildResolveXml(plan, urlOf), 'utf8');
    fs.writeFileSync(path.join(dest, csvName), buildMetadataCsv(plan), 'utf8');
    fs.writeFileSync(path.join(dest, 'Import into Resolve.py'), buildImportScript(plan, xmlName, csvName).replace('"__HERE__"', JSON.stringify(dest)), 'utf8');
    const c = plan.counts;
    fs.writeFileSync(path.join(dest, 'READ ME.txt'), [
        `${plan.title} — DaVinci Resolve export, ready to edit.`,
        '',
        'Fastest: in Resolve, Workspace > Scripts needs the script in its Scripts folder; copy "Import into Resolve.py" to',
        '  ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/',
        'then run it from Workspace > Scripts > Utility. It makes the project, a bin per scene, the first edit and the shot markers.',
        '',
        `By hand: File > Import > Timeline > ${xmlName}, then select the clips in the Media Pool > Import Metadata > ${csvName}.`,
        '',
        `The first edit: ${c.shots} shots, ${c.clips} with footage, ${c.storyboard_frames} held on their storyboard frame (yellow markers), ${c.gaps} gaps;`,
        `${c.dialogue_lines} dialogue lines, ${c.effects} effects, ${c.beds} music and ambience beds. Audio lanes: production sound, dialogue, effects, music, ambience.`,
        'Every shot carries a marker with its description, dialogue, camera and cast; scenes start with a blue marker; open notes are red.',
        '',
        plan.missing.length ? 'Missing when this was made:' : 'Nothing was missing when this was made.',
        ...plan.missing.map(m => `  ${m.shot_code || m.file || ''} ${m.kind}: ${m.reason}`),
        '',
    ].join('\n'), 'utf8');
    const { _files, ...pub } = plan;
    return { ...pub, dest, xml: xmlName, metadata: csvName, script: 'Import into Resolve.py', copied: _files.length };
}

module.exports = { planResolve, writeResolve, buildResolveXml, buildMetadataCsv, buildImportScript, shotInfo, LANES };
