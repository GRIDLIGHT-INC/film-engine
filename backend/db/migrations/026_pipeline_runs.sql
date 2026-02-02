-- FILM-070-072: Shot Pipeline Orchestrator
-- Track pipeline execution runs (shot, scene, or project level)
CREATE TABLE IF NOT EXISTS film_pipeline_runs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_id         TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    scene_id        TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    run_type        TEXT NOT NULL DEFAULT 'shot'
                    CHECK (run_type IN ('shot', 'scene', 'project')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'paused', 'complete', 'failed', 'cancelled')),
    current_step    TEXT DEFAULT '',
    steps_completed TEXT DEFAULT '[]',
    steps_remaining TEXT DEFAULT '[]',
    steps_failed    TEXT DEFAULT '[]',
    total_steps     INTEGER DEFAULT 0,
    progress_pct    REAL DEFAULT 0.0,
    started_at      TEXT DEFAULT NULL,
    completed_at    TEXT DEFAULT NULL,
    error_message   TEXT DEFAULT '',
    params          TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON film_pipeline_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON film_pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_shot ON film_pipeline_runs(shot_id);
