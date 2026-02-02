-- FILM-161: Auto-backup system
CREATE TABLE IF NOT EXISTS film_backups (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    backup_type TEXT NOT NULL DEFAULT 'manual',
    -- backup_type: manual, auto, scheduled
    file_path TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    tables_included TEXT NOT NULL DEFAULT '[]',
    row_counts TEXT NOT NULL DEFAULT '{}',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backups_project ON film_backups(project_id, created_at);
