-- FILM-005: film_scenes table (SQLite)
-- characters_present stored as JSON array string e.g. '["ALICE","BOB"]'
CREATE TABLE IF NOT EXISTS film_scenes (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    scene_number        INTEGER NOT NULL,
    int_ext             TEXT DEFAULT '',
    location            TEXT DEFAULT '',
    time_of_day         TEXT DEFAULT '',
    description         TEXT DEFAULT '',
    characters_present  TEXT DEFAULT '[]',
    estimated_duration  INTEGER DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'written'
                        CHECK (status IN (
                            'written', 'broken_down', 'storyboarded', 'cast',
                            'voices_recorded', 'shots_generated', 'post_processed', 'approved'
                        )),
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_scenes_project ON film_scenes(project_id, scene_number);
