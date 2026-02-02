-- FILM-120: Add 'removed' status to film_scenes
-- SQLite doesn't support ALTER CHECK constraints, so we need to recreate the table

-- Create new table with updated CHECK constraint
CREATE TABLE IF NOT EXISTS film_scenes_new (
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
                            'voices_recorded', 'shots_generated', 'post_processed', 'approved',
                            'removed'
                        )),
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Copy data from old table
INSERT INTO film_scenes_new SELECT * FROM film_scenes;

-- Drop old table and rename new one
DROP TABLE film_scenes;
ALTER TABLE film_scenes_new RENAME TO film_scenes;

-- Recreate index
CREATE INDEX IF NOT EXISTS idx_film_scenes_project ON film_scenes(project_id, scene_number);
