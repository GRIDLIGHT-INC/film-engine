-- FILM-156: Continuity reference board
CREATE TABLE IF NOT EXISTS film_continuity_refs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    ref_type TEXT NOT NULL DEFAULT 'visual',
    -- ref_type: visual, wardrobe, prop, lighting, color, framing
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    scene_id TEXT DEFAULT NULL,
    character_id TEXT DEFAULT NULL,
    shot_id TEXT DEFAULT NULL,
    asset_id TEXT DEFAULT NULL,
    image_path TEXT DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_continuity_project ON film_continuity_refs(project_id, ref_type);
CREATE INDEX IF NOT EXISTS idx_continuity_scene ON film_continuity_refs(scene_id);
CREATE INDEX IF NOT EXISTS idx_continuity_character ON film_continuity_refs(character_id);
