-- FILM-011: film_characters table
-- Character profiles with visual description, voice, and generation references
CREATE TABLE IF NOT EXISTS film_characters (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    description         TEXT DEFAULT '',
    appearance_prompt   TEXT DEFAULT '',
    personality_notes   TEXT DEFAULT '',
    age_range           TEXT DEFAULT '',
    gender              TEXT DEFAULT '',
    ethnicity           TEXT DEFAULT '',
    build               TEXT DEFAULT '',
    hair                TEXT DEFAULT '',
    distinguishing      TEXT DEFAULT '',
    lora_id             TEXT DEFAULT NULL,
    ti_token            TEXT DEFAULT NULL,
    voice_profile_id    TEXT DEFAULT NULL,
    default_costume_id  TEXT DEFAULT NULL,
    reference_images    TEXT DEFAULT '[]',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_characters_project ON film_characters(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_film_characters_name ON film_characters(project_id, name);
