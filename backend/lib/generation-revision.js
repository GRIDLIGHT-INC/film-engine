/** The durable decisions and reference bytes approved for a shot generation. */
const crypto = require('crypto');
const fs = require('fs');
const { selectedFrame } = require('./selected-frame');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function generationRevision(db, shotId, extraAssetIds = []) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return null;
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const read = (table, column, value) => tables.has(table)
        ? db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY id`).all(value) : [];
    const clean = row => Object.fromEntries(Object.entries(row || {}).filter(([key]) =>
        !['updated_at', 'production_status', 'status', 'actual_cost', 'estimated_cost', 'last_render_at'].includes(key)));
    const decisions = {
        shot: clean(shot), scene: clean(scene), project: clean(project),
        characters: read('film_characters', 'project_id', project.id),
        locations: read('film_locations', 'project_id', project.id),
        props: read('film_props', 'project_id', project.id),
        moodboard: read('film_mood_board', 'project_id', project.id),
        previs: read('film_previs_blocking', 'shot_id', shotId),
        annotations: read('film_storyboard_annotations', 'shot_id', shotId),
        reviewNotes: read('film_shot_notes', 'shot_id', shotId),
        consistency: read('film_consistency_profiles', 'project_id', project.id),
    };
    const profiles = decisions.consistency.map(r => r.id);
    decisions.consistencyRefs = profiles.flatMap(id => read('film_consistency_refs', 'profile_id', id));
    const pin = decisions.previs[0] && decisions.previs[0].world_version_id;
    decisions.worldVersion = pin ? read('film_world_versions', 'id', pin) : [];
    const worldId = decisions.worldVersion[0] && decisions.worldVersion[0].world_id;
    decisions.world = worldId ? read('film_worlds', 'id', worldId) : [];
    const assets = db.prepare(`SELECT * FROM film_assets WHERE project_id = ?
        AND asset_type IN ('reference_image', 'character_sheet', 'reference_sheet') ORDER BY id`).all(project.id);
    const frame = selectedFrame(db, shotId);
    const anchor = project.anchor_shot_id ? selectedFrame(db, project.anchor_shot_id) : null;
    if (frame) assets.push(frame);
    if (anchor) assets.push(anchor);
    for (const id of [...extraAssetIds, ...decisions.moodboard.map(r => r.asset_id), ...decisions.consistency.map(r => r.canonical_asset_id), ...decisions.consistencyRefs.map(r => r.asset_id)].filter(Boolean)) {
        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(id);
        if (asset) assets.push(asset);
    }
    const fileDigest = file => {
        if (!file) return null;
        try { return hash(fs.readFileSync(file)); } catch (_) { return 'unreadable'; }
    };
    decisions.assets = [...new Map(assets.map(r => [r.id, r])).values()]
        .sort((a,b) => a.id.localeCompare(b.id)).map(r => ({ ...r, bytes: fileDigest(r.file_path) }));
    decisions.moodboard = decisions.moodboard.map(r => ({ ...r, bytes: fileDigest(r.image_path) }));
    return { fingerprint: hash(JSON.stringify(decisions)), shot_id: shotId,
        selected_frame_asset_id: frame && frame.id, anchor_asset_id: anchor && anchor.id,
        asset_ids: decisions.assets.map(r => r.id) };
}
module.exports = { generationRevision };
