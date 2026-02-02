-- FILM-052-058: Post-Production Pipeline
-- Track post-production jobs (upscale, face restore, color grade, composite)
CREATE TABLE IF NOT EXISTS film_post_jobs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_id         TEXT NOT NULL REFERENCES film_shots(id) ON DELETE CASCADE,
    input_asset_id  TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    job_type        TEXT NOT NULL DEFAULT 'upscale'
                    CHECK (job_type IN ('upscale', 'face_restore', 'color_grade', 'denoise', 'composite')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    color_preset_id TEXT REFERENCES film_color_presets(id) ON DELETE SET NULL,
    model           TEXT DEFAULT '',
    output_path     TEXT DEFAULT '',
    error_message   TEXT DEFAULT '',
    params          TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_post_jobs_project ON film_post_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_post_jobs_shot ON film_post_jobs(shot_id);
CREATE INDEX IF NOT EXISTS idx_post_jobs_status ON film_post_jobs(status);
