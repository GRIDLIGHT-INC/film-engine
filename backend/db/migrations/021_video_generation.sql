-- FILM-029-035: Video Generation Pipeline
-- Track video generation jobs per shot
CREATE TABLE IF NOT EXISTS film_video_jobs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_id         TEXT NOT NULL REFERENCES film_shots(id) ON DELETE CASCADE,
    keyframe_asset_id TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'generating', 'interpolating', 'complete', 'failed')),
    prompt          TEXT DEFAULT '',
    negative_prompt TEXT DEFAULT '',
    model           TEXT DEFAULT 'animatediff-sdxl',
    seed            INTEGER DEFAULT -1,
    num_frames      INTEGER DEFAULT 16,
    fps             INTEGER DEFAULT 24,
    width           INTEGER DEFAULT 1024,
    height          INTEGER DEFAULT 576,
    duration_ms     INTEGER DEFAULT 0,
    camera_control  TEXT DEFAULT '{}',
    output_path     TEXT DEFAULT '',
    error_message   TEXT DEFAULT '',
    params          TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_project ON film_video_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_video_jobs_shot ON film_video_jobs(shot_id);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON film_video_jobs(status);
