-- FILM-003: film_scripts table (SQLite)
CREATE TABLE IF NOT EXISTS film_scripts (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL DEFAULT 1,
    content     TEXT NOT NULL DEFAULT '',
    word_count  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_scripts_project ON film_scripts(project_id, version DESC);
