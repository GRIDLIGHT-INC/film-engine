-- FILM-002: film_projects table (SQLite)
CREATE TABLE IF NOT EXISTS film_projects (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    logline     TEXT DEFAULT '',
    genre       TEXT DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'concept'
                CHECK (status IN (
                    'concept', 'script', 'pre-production', 'storyboard',
                    'production', 'post-production', 'review', 'export', 'complete'
                )),
    style_preset TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_projects_status ON film_projects(status);
CREATE INDEX IF NOT EXISTS idx_film_projects_created ON film_projects(created_at DESC);
