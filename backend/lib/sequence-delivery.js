/**
 * Where a sequence leg's finished clip goes.
 *
 * ONE definition of the filename and ONE of the film_assets row, because the
 * clip can now arrive by two roads and they must agree. The live road is
 * `routes/sequences.js`, which polls and files what comes back. The other is
 * `generation-jobs.collect()`, which delivers a job the agent host abandoned
 * — or, as happened here, one the engine wrongly marked failed while the
 * provider held a rendered, PAID-FOR clip.
 *
 * If those two roads name the file differently or stamp different metadata,
 * a collected leg is invisible to the sequence that bought it: `sequence_plan`
 * reports the leg as still missing, `sequence_stitch` skips it, and the only
 * symptom is a bill for footage nobody can find. So neither road states these
 * facts itself; both read them from here.
 */

const SAFE = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'shot';

/** The name a leg's clip is stored under. */
function clipFileName(sequenceId, from, to) {
    return `sequence_${SAFE(String(sequenceId || '').slice(0, 8))}_${SAFE(from)}_${SAFE(to)}.mp4`;
}

/**
 * The metadata that makes a stored clip FINDABLE as a leg.
 *
 * `sequence_plan` looks a leg up by exactly these three keys, so a row without
 * them is a file on disk and nothing more.
 */
function clipMetadata(o) {
    return { sequence_id: o.sequenceId, from: o.from, to: o.to };
}

/**
 * File a leg's clip. Returns the asset id.
 *
 * Idempotent on (project, file_name, sequence leg): collecting the same job
 * twice must not leave two rows claiming to be the same leg, because the
 * lookup above takes the first it finds and the two would be indistinguishable.
 */
function fileSequenceClip(o) {
    const { db, generateId } = require('../db/database');
    const fileName = o.fileName || clipFileName(o.sequenceId, o.from, o.to);
    const existing = db.prepare(`SELECT id FROM film_assets
        WHERE project_id = ? AND file_name = ? AND asset_type = 'video_raw'`)
        .get(o.projectId, fileName);
    const meta = JSON.stringify(Object.assign(clipMetadata(o), o.extra || {}));
    if (existing) {
        db.prepare('UPDATE film_assets SET file_path = ?, metadata = ? WHERE id = ?')
            .run(o.filePath || '', meta, existing.id);
        return existing.id;
    }
    const id = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, asset_type, file_path, file_name, format, version, metadata)
        VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1, ?)`)
        .run(id, o.projectId, o.shotId || null, o.filePath || '', fileName, meta);
    return id;
}

module.exports = { clipFileName, clipMetadata, fileSequenceClip };
