-- Film costumes / wardrobe table
-- Costume definitions per character — essential for visual continuity
CREATE TABLE IF NOT EXISTS film_costumes (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    character_id    TEXT NOT NULL REFERENCES film_characters(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    visual_prompt   TEXT DEFAULT '',
    color_palette   TEXT DEFAULT '',
    reference_images TEXT DEFAULT '[]',
    scenes_used     TEXT DEFAULT '[]',
    notes           TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_costumes_character ON film_costumes(character_id);
CREATE INDEX IF NOT EXISTS idx_film_costumes_project ON film_costumes(project_id);
