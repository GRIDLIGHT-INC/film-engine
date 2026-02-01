-- Film props table
-- Prop registry for continuity tracking across scenes
CREATE TABLE IF NOT EXISTS film_props (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    visual_prompt   TEXT DEFAULT '',
    category        TEXT DEFAULT 'generic'
                    CHECK (category IN (
                        'generic', 'weapon', 'vehicle', 'technology', 'food',
                        'document', 'furniture', 'clothing-accessory', 'musical-instrument', 'other'
                    )),
    reference_images TEXT DEFAULT '[]',
    notes           TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_props_project ON film_props(project_id);
