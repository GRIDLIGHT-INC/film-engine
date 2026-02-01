-- FILM-013: film_locations table
-- Location registry with visual references and lighting defaults
CREATE TABLE IF NOT EXISTS film_locations (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    description         TEXT DEFAULT '',
    reference_prompt    TEXT DEFAULT '',
    reference_images    TEXT DEFAULT '[]',
    lighting_default    TEXT DEFAULT 'natural',
    time_of_day_default TEXT DEFAULT '',
    atmosphere_notes    TEXT DEFAULT '',
    sound_notes         TEXT DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_locations_project ON film_locations(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_film_locations_name ON film_locations(project_id, name);
