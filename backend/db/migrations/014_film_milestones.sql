-- FILM-087: Production milestones & timeline
-- Phase tracking with target/actual dates and completion percentage
CREATE TABLE IF NOT EXISTS film_milestones (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT DEFAULT '',
    phase           TEXT NOT NULL DEFAULT 'concept'
                    CHECK (phase IN (
                        'concept', 'script', 'pre-production', 'storyboard',
                        'production', 'post-production', 'review', 'export', 'complete'
                    )),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    target_date     TEXT DEFAULT NULL,
    actual_date     TEXT DEFAULT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
    completion_pct  INTEGER DEFAULT 0,
    auto_generated  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_milestones_project ON film_milestones(project_id, sort_order);
