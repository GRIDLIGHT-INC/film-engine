/** Resolve the board's chosen frame. A broken explicit selection never falls forward. */
function selectedFrame(db, shotId) {
    const shot = db.prepare('SELECT current_frame_version FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return null;
    const pinned = shot.current_frame_version != null;
    return db.prepare(`SELECT * FROM film_assets WHERE shot_id = ?
        AND asset_type IN ('keyframe', 'storyboard')
        AND (NOT json_valid(metadata) OR json_extract(metadata, '$.station_index') IS NULL)
        ${pinned ? 'AND version = ?' : ''}
        ORDER BY version DESC, created_at DESC, id DESC LIMIT 1`)
        .get(...(pinned ? [shotId, shot.current_frame_version] : [shotId])) || null;
}
module.exports = { selectedFrame };
