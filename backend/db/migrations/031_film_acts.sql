-- 031: Act/sequence structure for organizing scenes into acts
-- Supports classic 3-act structure or custom act counts

CREATE TABLE IF NOT EXISTS film_acts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    act_number INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES film_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_acts_project ON film_acts (project_id, sort_order);

-- Link scenes to acts (optional — scenes can be unassigned)
ALTER TABLE film_scenes ADD COLUMN act_id TEXT DEFAULT NULL;
