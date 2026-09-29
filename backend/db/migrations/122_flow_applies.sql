-- FOG-002 (GRD-4583): applying one flow to a selection of shots.
-- One apply record ties together the runs it started — exactly one per
-- runnable shot of the plan whose fingerprint it was given. The runs are
-- ordinary film_flow_runs rows made by the existing executor; apply_id is how
-- the queue, the recipe panel and the graph find the apply a run belongs to.
CREATE TABLE IF NOT EXISTS film_flow_applies (
    id             TEXT PRIMARY KEY,
    flow_id        TEXT NOT NULL REFERENCES film_flows(id) ON DELETE CASCADE,
    project_id     TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    fingerprint    TEXT NOT NULL,
    targets_json   TEXT NOT NULL DEFAULT '[]',
    vars_json      TEXT NOT NULL DEFAULT '{}',
    status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','paused','complete','completed_with_errors','failed','cancelled')),
    total_cost     REAL NOT NULL DEFAULT 0,
    ignore_budget  INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at   TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_flow_applies_fingerprint ON film_flow_applies(fingerprint, status);

-- A run outlives the apply record that started it: deleting the record must
-- not take generated work with it.
ALTER TABLE film_flow_runs ADD COLUMN apply_id TEXT REFERENCES film_flow_applies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_flow_runs_apply ON film_flow_runs(apply_id);
