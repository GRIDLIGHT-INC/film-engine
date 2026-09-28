/**
 * Which of this project's files is this one? (PGN-015)
 *
 * A file dropped on the production canvas is hashed in the BROWSER, and only
 * its sha256 and its size arrive here: a two-gigabyte clip must not be
 * uploaded to learn that it is already on the board. The project's own files
 * are compared by size first, so only a file of the same length is ever read,
 * and each hash is cached against the file's size and mtime — a path is not an
 * identity, because a regenerated file is written over the same name.
 *
 * A match says which node it belongs to. A version the graph draws is its own
 * node (`ver:<id>`); a frame lives in its shot's drawer; and every match also
 * names its PARENT, so a version the graph does not draw still opens
 * somewhere. The recipe travels with it, so the page opens provenance at once.
 */
const fs = require('fs');
const crypto = require('crypto');

const SHA_RE = /^[0-9a-f]{64}$/;
const FRAME_TYPES = ['storyboard', 'keyframe'];
const VIDEO_TYPES = ['video_raw', 'video_synced', 'video_final'];
const AUDIO_TYPES = ['audio_music', 'audio_sfx', 'audio_ambient', 'audio_dialogue', 'audio_mix'];

const parse = t => { try { return t ? JSON.parse(t) : {}; } catch (_) { return {}; } };

/** Every family the graph draws, and where a file of it is opened. */
const MATCH_RULES = Object.freeze([
    { kind: 'frame', types: FRAME_TYPES,
        place: r => r.shot_id ? { node_key: `shot:${r.shot_id}`, parent_key: `shot:${r.shot_id}` } : null },
    { kind: 'video', types: VIDEO_TYPES,
        place: (r, m) => ({ node_key: `ver:${r.id}`,
            parent_key: m.sequence_id ? `seq:${m.sequence_id}` : (r.shot_id ? `shot:${r.shot_id}` : null) }) },
    { kind: 'audio', types: AUDIO_TYPES,
        place: (r, m, cueId) => ({ node_key: `ver:${r.id}`,
            parent_key: cueId ? `sound:${cueId}` : (r.shot_id ? `shot:${r.shot_id}` : null) }) },
]);

const cache = new Map();   // path -> { size, mtimeMs, hash }
const stats = { hashed: 0 };

function hashOf(p, st) {
    const hit = cache.get(p);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.hash;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    stats.hashed++;
    cache.set(p, { size: st.size, mtimeMs: st.mtimeMs, hash });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return hash;
}

function placeFor(db, row) {
    const m = parse(row.metadata);
    let cueId = m.cue_id || m.music_cue_id || null;
    if (!cueId && AUDIO_TYPES.includes(row.asset_type)) {
        const c = db.prepare('SELECT id FROM film_music_cues WHERE generated_asset_id = ?').get(row.id);
        cueId = c ? c.id : null;
    }
    const rule = MATCH_RULES.find(r => r.types.includes(row.asset_type));
    if (rule) { const at = rule.place(row, m, cueId); if (at) return { kind: rule.kind, ...at }; }
    // Not a family the graph draws (a plate, a mesh): the recipe still opens,
    // on the shot it belongs to when it belongs to one.
    const shot = row.shot_id ? `shot:${row.shot_id}` : null;
    return { kind: 'other', node_key: shot, parent_key: shot };
}

/**
 * @returns {{matched:boolean, asset?, kind?, node_key?, parent_key?, recipe?, compared:number} | {error:string}}
 */
function matchFile(db, projectId, { sha256, size } = {}) {
    const hash = String(sha256 || '').toLowerCase();
    if (!SHA_RE.test(hash)) return { error: 'sha256 must be 64 hex characters — the file’s own hash, computed where it was dropped' };
    const bytes = Number(size);
    if (!Number.isInteger(bytes) || bytes <= 0) return { error: 'size must be the file’s length in bytes, a positive whole number' };
    const rows = db.prepare(`SELECT id, asset_type, file_name, file_path, shot_id, scene_id, metadata, created_at
        FROM film_assets WHERE project_id = ? AND file_path IS NOT NULL AND file_path != ''
        ORDER BY created_at DESC`).all(projectId);
    let compared = 0;
    for (const r of rows) {
        let st;
        try { st = fs.statSync(r.file_path); } catch (_) { continue; }
        if (!st.isFile() || st.size !== bytes) continue;
        compared++;
        let h;
        try { h = hashOf(r.file_path, st); } catch (_) { continue; }
        if (h !== hash) continue;
        const at = placeFor(db, r);
        let recipe = null;
        try { recipe = require('./asset-recipe').assetRecipe(db, r.id); } catch (_) { recipe = null; }
        return { matched: true, compared, kind: at.kind, node_key: at.node_key, parent_key: at.parent_key,
            asset: { asset_id: r.id, asset_type: r.asset_type, file_name: r.file_name, created_at: r.created_at }, recipe };
    }
    return { matched: false, compared };
}

module.exports = { matchFile, MATCH_RULES, _stats: () => ({ ...stats }), _clearCache: () => cache.clear() };
