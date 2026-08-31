/** Lifecycle for the one current orientation-plan attachment per location. */
const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');

const WHERE_PLAN = "asset_type = 'other' AND json_valid(metadata) AND json_extract(metadata, '$.kind') = 'orientation_plan'";

function rowsFor(where, value, exceptId) {
    return db.prepare(`SELECT id, file_path FROM film_assets WHERE ${where} = ? AND ${WHERE_PLAN}`
        + (exceptId ? ' AND id != ?' : '')).all(...(exceptId ? [value, exceptId] : [value]));
}

function archiveRow(row) {
    // The database is the current-plan invariant. Remove that pointer first so
    // an unwritable volume can never block a location/project delete or leave
    // two current plans after replacement. The bytes remain recoverable at
    // either the archive destination or their original, known path.
    db.prepare('DELETE FROM film_assets WHERE id = ?').run(row.id);
    if (row.file_path && fs.existsSync(row.file_path)) {
        try {
            const dir = path.join(path.dirname(row.file_path), 'deleted', 'orientation');
            fs.mkdirSync(dir, { recursive: true });
            const dest = path.join(dir, `${row.id}_${path.basename(row.file_path)}`);
            fs.renameSync(row.file_path, dest);
        } catch (err) {
            console.warn(`Could not archive orientation plan ${row.id}; retained at ${row.file_path}: ${err.message}`);
        }
    }
}

function archiveRows(rows) {
    for (const row of rows) archiveRow(row);
    return rows.length;
}

function replaceOrientationPlan(locationId, keepAssetId) {
    return archiveRows(rowsFor('location_id', locationId, keepAssetId));
}
function dropOrientationPlan(locationId) {
    return archiveRows(rowsFor('location_id', locationId));
}
function dropOrientationPlansForProject(projectId) {
    return archiveRows(rowsFor('project_id', projectId));
}
function dropAllOrientationPlans() {
    return archiveRows(db.prepare(`SELECT id, file_path FROM film_assets WHERE ${WHERE_PLAN}`).all());
}

module.exports = {
    WHERE_PLAN, replaceOrientationPlan, dropOrientationPlan,
    dropOrientationPlansForProject, dropAllOrientationPlans,
};
