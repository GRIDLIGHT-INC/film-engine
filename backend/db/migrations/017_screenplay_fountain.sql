-- FILM-096: Fountain screenplay storage
-- Adds format support and element-level storage for parsed screenplays

-- Add Fountain-specific columns to film_scripts
ALTER TABLE film_scripts ADD COLUMN format TEXT NOT NULL DEFAULT 'plaintext'
    CHECK (format IN ('plaintext', 'fountain', 'fdx'));

ALTER TABLE film_scripts ADD COLUMN fountain_content TEXT DEFAULT '';

ALTER TABLE film_scripts ADD COLUMN title_page_json TEXT DEFAULT '{}';

ALTER TABLE film_scripts ADD COLUMN page_count INTEGER DEFAULT 0;

ALTER TABLE film_scripts ADD COLUMN scene_count INTEGER DEFAULT 0;

ALTER TABLE film_scripts ADD COLUMN dialogue_percentage REAL DEFAULT 0;

-- Element-level storage for parsed screenplays
-- Enables fast queries (e.g., find all dialogue for a character, list all scenes)
CREATE TABLE IF NOT EXISTS film_script_elements (
    id              TEXT PRIMARY KEY,
    script_id       TEXT NOT NULL REFERENCES film_scripts(id) ON DELETE CASCADE,
    element_index   INTEGER NOT NULL,
    element_type    TEXT NOT NULL
                    CHECK (element_type IN (
                        'scene_heading', 'action', 'character', 'dialogue',
                        'parenthetical', 'transition', 'centered', 'lyrics',
                        'page_break', 'section', 'synopsis', 'note', 'boneyard'
                    )),
    text            TEXT NOT NULL DEFAULT '',
    scene_number    TEXT DEFAULT NULL,
    depth           INTEGER DEFAULT NULL,
    dual            TEXT DEFAULT NULL CHECK (dual IS NULL OR dual IN ('left', 'right')),
    meta            TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_script_elements_script
    ON film_script_elements(script_id, element_index);

CREATE INDEX IF NOT EXISTS idx_film_script_elements_type
    ON film_script_elements(script_id, element_type);

CREATE INDEX IF NOT EXISTS idx_film_script_elements_scene
    ON film_script_elements(script_id, scene_number);
