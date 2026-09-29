-- PGN-018: collapse a sequence or scene on the production graph. Stored per
-- project beside the pinned layout. Collapsing moves no node — it only changes
-- what is drawn — so expanding restores the layout exactly.
CREATE TABLE IF NOT EXISTS production_group_layout (
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    group_key  TEXT NOT NULL,
    collapsed  INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, group_key)
);
