-- Scene-character join table
-- Tracks which characters appear in which scenes, with what costume and props
CREATE TABLE IF NOT EXISTS film_scene_characters (
    id              TEXT PRIMARY KEY,
    scene_id        TEXT NOT NULL REFERENCES film_scenes(id) ON DELETE CASCADE,
    character_id    TEXT NOT NULL REFERENCES film_characters(id) ON DELETE CASCADE,
    costume_id      TEXT REFERENCES film_costumes(id) ON DELETE SET NULL,
    screen_time_ms  INTEGER DEFAULT 0,
    dialogue_lines  INTEGER DEFAULT 0,
    notes           TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_film_scene_characters_unique ON film_scene_characters(scene_id, character_id);
CREATE INDEX IF NOT EXISTS idx_film_scene_characters_character ON film_scene_characters(character_id);

-- Scene-prop join table
CREATE TABLE IF NOT EXISTS film_scene_props (
    id              TEXT PRIMARY KEY,
    scene_id        TEXT NOT NULL REFERENCES film_scenes(id) ON DELETE CASCADE,
    prop_id         TEXT NOT NULL REFERENCES film_props(id) ON DELETE CASCADE,
    notes           TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_film_scene_props_unique ON film_scene_props(scene_id, prop_id);
