/**
 * EDITS: a cut finished in an editor, brought back into the project.
 *
 * A picture file exported from Premiere, versioned (v1, v2, …) in the
 * project's `05 Edit` folder, measured by the encoder, and — when the XML or
 * EDL it was cut from is imported too — read into a cut list saying which
 * Film Engine shot plays where in THAT edit (lib/edit-cut.js).
 *
 * A score session can then be written against an edit instead of against the
 * assembly: its picture is the cut, its length is the edit's, and its stems
 * line up with the edit's first frame, so they drop straight onto the
 * sequence in Premiere at 00:00.
 *
 * NOTHING IS OVERWRITTEN. Each import is a new version with its own file; the
 * previous cut is exactly as it was, because a score timed to v2 has to be
 * able to say it was timed to v2 after v3 arrives.
 *
 * THE BYTES DECIDE, AND THE ENCODER HAS THE LAST WORD. A container is
 * recognised from its first bytes (never the name), and the encoder must then
 * read a video stream and a length out of the file — an edit that cannot be
 * decoded is a picture nobody can score against, found out at the worst time.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cut = require('./edit-cut');

function db() { return require('../db/database').db; }
function newId() { return require('../db/database').generateId(); }

const SUBDIR = 'edits';
/** The biggest picture file read in one request; larger ones come as a resumable upload. */
const MAX_CUT_TEXT = 20 * 1024 * 1024;

/** What container the first bytes are. Null when they are not a video we can keep. */
function sniffVideo(head) {
    const b = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
    if (b.length < 12) return null;
    const atom = b.toString('latin1', 4, 8);
    if (atom === 'ftyp') {
        const brand = b.toString('latin1', 8, 12);
        return /^qt/.test(brand) ? 'mov' : 'mp4';
    }
    // QuickTime movies written without an ftyp open on another top-level atom.
    if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(atom)) return 'mov';
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'mkv';
    return null;
}

function error(status, message, extra) { const e = new Error(message); e.status = status; Object.assign(e, extra || {}); return e; }

function projectOf(projectId) {
    const p = db().prepare('SELECT id, title FROM film_projects WHERE id = ?').get(projectId);
    if (!p) throw error(404, 'Project not found');
    return p;
}

function nextVersion(projectId) {
    const r = db().prepare('SELECT MAX(version) AS v FROM film_edits WHERE project_id = ?').get(projectId);
    return (r && r.v ? r.v : 0) + 1;
}

/** The URL an edit's picture is served from. */
function pictureUrl(projectId, fileName) {
    return fileName ? require('./file-storage').getFileUrl(SUBDIR, projectId, fileName) : null;
}

/**
 * Where the bytes come from: a data URI (small), raw bytes, or a finished
 * resumable upload (large — moved into place, never read into memory).
 * Returns `{ kind: 'bytes', bytes }` or `{ kind: 'file', path, head }`.
 */
function sourceOf(input) {
    const i = input || {};
    if (i.upload_id) {
        const claimed = require('./uploads').claimUpload(i.upload_id);
        const fd = fs.openSync(claimed.path, 'r');
        const head = Buffer.alloc(64);
        try { fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }
        return { kind: 'file', path: claimed.path, head, name: i.name || claimed.name };
    }
    if (i.bytes) return { kind: 'bytes', bytes: Buffer.isBuffer(i.bytes) ? i.bytes : Buffer.from(i.bytes), name: i.name };
    if (i.data) {
        const m = String(i.data).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
        if (!m) throw error(400, 'data must be a base64 data URI of the exported video');
        return { kind: 'bytes', bytes: Buffer.from(m[2].replace(/\s/g, ''), 'base64'), name: i.name };
    }
    throw error(400, 'send the exported edit: data (a data URI), or upload_id (a finished resumable upload, for large files)');
}

/**
 * Import a picture file as the project's next edit version, and its cut when
 * one is sent with it. Returns the stored edit.
 */
function importEdit(projectId, input) {
    const project = projectOf(projectId);
    const i = input || {};
    // Parse the cut FIRST: a cut that cannot be read refuses the whole import
    // before a file is written or an upload is claimed, rather than leaving an
    // edit with half its story (or throwing away a transfer that took an hour).
    let parsedCut = null;
    if (i.cut) parsedCut = readCutText(i.cut, i.sequence);
    const src = sourceOf(i);
    const head = src.kind === 'bytes' ? src.bytes.subarray(0, 64) : src.head;
    const ext = sniffVideo(head);
    if (!ext) {
        if (src.kind === 'file') fs.rmSync(src.path, { force: true });
        throw error(400, 'That is not a video file Film Engine can keep. Export the edit from Premiere as H.264 (.mp4) or ProRes/QuickTime (.mov).');
    }

    const fileStorage = require('./file-storage');
    const version = nextVersion(projectId);
    const fileName = `edit_v${version}.${ext}`;
    const dir = fileStorage.ensureDir(projectId, SUBDIR);
    const filePath = fileStorage.getFilePath(projectId, SUBDIR, fileName);
    if (fs.existsSync(filePath)) throw error(409, `${fileName} already exists in ${dir} — nothing was overwritten`);
    if (src.kind === 'bytes') fs.writeFileSync(filePath, src.bytes);
    else {
        try { fs.renameSync(src.path, filePath); }
        catch (e) {
            if (e.code !== 'EXDEV') throw e;
            fs.copyFileSync(src.path, filePath);
            fs.rmSync(src.path, { force: true });
        }
    }

    const seen = require('./ffmpeg').inspectMedia(filePath);
    const durationMs = seen.ok && seen.durationSeconds > 0 ? Math.round(seen.durationSeconds * 1000) : 0;
    if (!seen.ok || !durationMs || seen.videoReason) {
        fs.rmSync(filePath, { force: true });
        throw error(400, `The encoder could not read a picture out of that file (${seen.reason || seen.videoReason || 'no length'}). Re-export the edit and try again.`);
    }

    const size = fs.statSync(filePath).size;
    const assetId = newId(), editId = newId();
    const title = String(i.name || `${project.title} — edit v${version}`).slice(0, 200);
    db().transaction(() => {
        db().prepare(
            `INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, duration_ms,
                size_bytes, version, metadata, license_source, license_status, created_at)
             VALUES (?, ?, 'other', ?, ?, ?, ?, ?, ?, ?, ?, 'external', 'unknown', datetime('now'))`)
            .run(assetId, projectId, filePath, fileName, ext, ext === 'mov' ? 'video/quicktime' : ext === 'mkv' ? 'video/x-matroska' : 'video/mp4',
                durationMs, size, version, JSON.stringify({ kind: 'edit', edit_id: editId, version, original_name: src.name || null }));
        db().prepare(
            `INSERT INTO film_edits (id, project_id, version, name, notes, asset_id, duration_ms, frame_rate, width, height, has_audio)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(editId, projectId, version, title, String(i.notes || '').slice(0, 4000), assetId, durationMs,
                seen.fps || null, seen.width || null, seen.height || null, seen.hasAudio ? 1 : 0);
    })();

    if (parsedCut) attachCut(editId, { parsed: parsedCut, text: i.cut, name: i.cut_name });
    return getEdit(editId);
}

/** Parse the text of an XML or EDL (a data URI of one is accepted too). */
function readCutText(input, sequence) {
    let text = String(input || '');
    const m = /^data:[^;,]*;base64,(.+)$/s.exec(text);
    if (m) text = Buffer.from(m[1], 'base64').toString('utf8');
    if (!text.trim()) throw error(400, 'the cut is empty — export Final Cut Pro XML or an EDL from Premiere');
    if (text.length > MAX_CUT_TEXT) throw error(413, 'that cut file is larger than any XML or EDL of a film should be');
    try { return { ...cut.parseCut(text, { sequence }), text }; }
    catch (e) { throw error(400, e.message); }
}

/** The project's shots and the clip files it stored for them — what a cut is matched against. */
function matchContext(projectId) {
    const shots = db().prepare(
        `SELECT sh.id, sh.shot_code, sh.scene_id FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ?`).all(projectId);
    const files = db().prepare(
        `SELECT file_name, shot_id FROM film_assets WHERE project_id = ? AND shot_id IS NOT NULL
            AND asset_type IN ('video_raw','video_synced','video_final','storyboard','keyframe')
          ORDER BY CASE asset_type WHEN 'video_final' THEN 0 WHEN 'video_synced' THEN 1 WHEN 'video_raw' THEN 2 ELSE 3 END`).all(projectId);
    let coverage = new Map();
    try {
        for (const r of db().prepare(
            `SELECT a.file_name, c.shot_id FROM film_clip_coverage c JOIN film_assets a ON a.id = c.asset_id WHERE a.project_id = ?`).all(projectId)) {
            if (!coverage.has(r.file_name)) coverage.set(r.file_name, []);
            coverage.get(r.file_name).push(r.shot_id);
        }
    } catch (_) { coverage = new Map(); }
    const byId = new Map(shots.map(s => [s.id, s.shot_code]));
    return {
        shots,
        files: files.map(f => ({ ...f, covers: (coverage.get(f.file_name) || []).filter(id => id !== f.shot_id).map(id => byId.get(id)).filter(Boolean) })),
    };
}

/**
 * Attach (or replace) the cut an edit was made from. The text is kept as a
 * file beside the picture, so what the cut list was read from can be re-read.
 */
function attachCut(editId, input) {
    const e = db().prepare('SELECT * FROM film_edits WHERE id = ?').get(editId);
    if (!e) throw error(404, 'Edit not found');
    const i = input || {};
    const parsed = i.parsed || readCutText(i.text !== undefined ? i.text : i.data, i.sequence);
    const ctx = matchContext(e.project_id);
    const matched = cut.matchCut(parsed, ctx.shots, ctx.files);
    delete matched.text;

    const fileStorage = require('./file-storage');
    const ext = parsed.format === 'edl' ? 'edl' : 'xml';
    const fileName = `edit_v${e.version}_cut.${ext}`;
    fileStorage.saveFile(e.project_id, SUBDIR, fileName, Buffer.from(parsed.text || '', 'utf8'));
    const filePath = fileStorage.getFilePath(e.project_id, SUBDIR, fileName);

    db().transaction(() => {
        // A replaced cut file keeps its asset row: one cut per edit version.
        let cutAssetId = e.cut_asset_id;
        if (cutAssetId && db().prepare('SELECT 1 FROM film_assets WHERE id = ?').get(cutAssetId)) {
            db().prepare('UPDATE film_assets SET file_path = ?, file_name = ?, format = ?, size_bytes = ? WHERE id = ?')
                .run(filePath, fileName, ext, Buffer.byteLength(parsed.text || ''), cutAssetId);
        } else {
            cutAssetId = newId();
            db().prepare(
                `INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, size_bytes, version,
                    metadata, license_source, license_status, created_at)
                 VALUES (?, ?, 'other', ?, ?, ?, ?, ?, ?, ?, 'external', 'unknown', datetime('now'))`)
                .run(cutAssetId, e.project_id, filePath, fileName, ext, ext === 'xml' ? 'application/xml' : 'text/plain',
                    Buffer.byteLength(parsed.text || ''), e.version,
                    JSON.stringify({ kind: 'edit_cut', edit_id: e.id, version: e.version, format: parsed.format, original_name: i.name || null }));
        }
        db().prepare(
            `UPDATE film_edits SET cut_json = ?, cut_format = ?, cut_asset_id = ?, cut_imported_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
            .run(JSON.stringify(matched), parsed.format, cutAssetId, e.id);
    })();
    return getEdit(editId);
}

/** Re-match a stored cut against the shots as they are now (shots added, files renamed). */
function rematchCut(editId) {
    const e = db().prepare('SELECT * FROM film_edits WHERE id = ?').get(editId);
    if (!e) throw error(404, 'Edit not found');
    if (!e.cut_json) throw error(409, 'this edit has no cut imported yet');
    const stored = JSON.parse(e.cut_json);
    const ctx = matchContext(e.project_id);
    const again = cut.matchCut({ ...stored, events: stored.events.map(x => ({ ...x, shot_id: undefined })) }, ctx.shots, ctx.files);
    db().prepare("UPDATE film_edits SET cut_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(again), editId);
    return getEdit(editId);
}

function present(row) {
    if (!row) return null;
    const asset = row.asset_id ? db().prepare('SELECT id, file_name, file_path, size_bytes, format FROM film_assets WHERE id = ?').get(row.asset_id) : null;
    const cutAsset = row.cut_asset_id ? db().prepare('SELECT id, file_name FROM film_assets WHERE id = ?').get(row.cut_asset_id) : null;
    let cutList = null;
    try { cutList = row.cut_json ? JSON.parse(row.cut_json) : null; } catch (_) { cutList = null; }
    const sessions = db().prepare('SELECT id, name, status FROM film_music_sessions WHERE edit_id = ? ORDER BY created_at').all(row.id);
    const latest = db().prepare('SELECT MAX(version) AS v FROM film_edits WHERE project_id = ?').get(row.project_id).v;
    return {
        id: row.id, project_id: row.project_id, version: row.version, name: row.name, notes: row.notes,
        is_latest: row.version === latest,
        duration_ms: row.duration_ms, frame_rate: row.frame_rate, width: row.width, height: row.height, has_audio: !!row.has_audio,
        asset_id: row.asset_id, file_name: asset ? asset.file_name : null, file_path: asset ? asset.file_path : null,
        size_bytes: asset ? asset.size_bytes : null,
        available: !!(asset && asset.file_path && fs.existsSync(asset.file_path)),
        video_url: asset ? pictureUrl(row.project_id, asset.file_name) : null,
        cut: cutList ? { format: row.cut_format, file_name: cutAsset ? cutAsset.file_name : null, imported_at: row.cut_imported_at,
            sequence: cutList.sequence, sequences: cutList.sequences, picture_track: cutList.picture_track,
            summary: cutList.summary, events: cutList.events, overlays: cutList.overlays || [] } : null,
        sessions,
        created_at: row.created_at, updated_at: row.updated_at,
    };
}

function getEdit(editId) {
    const row = db().prepare('SELECT * FROM film_edits WHERE id = ?').get(editId);
    if (!row) throw error(404, 'Edit not found');
    return present(row);
}

function listEdits(projectId) {
    projectOf(projectId);
    return db().prepare('SELECT * FROM film_edits WHERE project_id = ? ORDER BY version DESC').all(projectId).map(present);
}

function updateEdit(editId, body) {
    const e = db().prepare('SELECT * FROM film_edits WHERE id = ?').get(editId);
    if (!e) throw error(404, 'Edit not found');
    const b = body || {};
    const name = b.name !== undefined ? String(b.name).slice(0, 200) : e.name;
    const notes = b.notes !== undefined ? String(b.notes).slice(0, 4000) : e.notes;
    db().prepare("UPDATE film_edits SET name = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(name, notes, editId);
    return getEdit(editId);
}

/**
 * Remove an edit version. Refused while a score session is written against
 * it — deleting the picture out from under a score is how music ends up timed
 * to nothing — unless `force`, which leaves those sessions with no picture and
 * says so. The files move to `deleted/`, recoverable, like a plate.
 */
function deleteEdit(editId, opts) {
    const e = getEdit(editId);
    if (e.sessions.length && !(opts && opts.force)) {
        throw error(409, `score session(s) ${e.sessions.map(s => `"${s.name || s.id}"`).join(', ')} are written against this edit. Point them at another edit first, or delete with force.`,
            { code: 'EDIT_IN_USE', sessions: e.sessions });
    }
    const assets = [e.asset_id, db().prepare('SELECT cut_asset_id FROM film_edits WHERE id = ?').get(editId).cut_asset_id].filter(Boolean);
    const moved = [];
    for (const id of assets) {
        const a = db().prepare('SELECT file_path FROM film_assets WHERE id = ?').get(id);
        if (a && a.file_path && fs.existsSync(a.file_path)) {
            const dir = path.join(path.dirname(a.file_path), 'deleted');
            fs.mkdirSync(dir, { recursive: true });
            const dest = path.join(dir, `${crypto.randomBytes(3).toString('hex')}_${path.basename(a.file_path)}`);
            fs.renameSync(a.file_path, dest);
            moved.push(dest);
        }
    }
    db().transaction(() => {
        db().prepare('DELETE FROM film_edits WHERE id = ?').run(editId);
        for (const id of assets) db().prepare('DELETE FROM film_assets WHERE id = ?').run(id);
    })();
    return { deleted: true, id: editId, version: e.version, recoverable: moved, sessions_left_without_picture: e.sessions.map(s => s.id) };
}

/** The newest edit version of a project, or null. */

module.exports = {    SUBDIR, sniffVideo, importEdit, attachCut, rematchCut, readCutText,
    getEdit, listEdits, updateEdit, deleteEdit, matchContext, pictureUrl,};
