-- FILM-159: Budget & cost tracking
ALTER TABLE film_projects ADD COLUMN budget_total REAL DEFAULT 0;
ALTER TABLE film_projects ADD COLUMN budget_currency TEXT DEFAULT 'USD';

CREATE TABLE IF NOT EXISTS film_cost_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    cost_type TEXT NOT NULL DEFAULT 'other',
    -- cost_type: render_gpu, model_inference, voice_tts, music_generation,
    --            image_generation, video_generation, storage, license, other
    description TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    gpu_seconds REAL DEFAULT 0,
    model_used TEXT DEFAULT '',
    scene_id TEXT DEFAULT NULL,
    shot_id TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_costs_project ON film_cost_entries(project_id, cost_type);
CREATE INDEX IF NOT EXISTS idx_costs_date ON film_cost_entries(project_id, created_at);
