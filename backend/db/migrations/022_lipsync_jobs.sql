-- FILM-036-040: Lip-Sync & Performance Pipeline
-- Track lip-sync processing jobs
CREATE TABLE IF NOT EXISTS film_lipsync_jobs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_id         TEXT NOT NULL REFERENCES film_shots(id) ON DELETE CASCADE,
    video_asset_id  TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    audio_asset_id  TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    model           TEXT DEFAULT 'wav2lip',
    face_index      INTEGER DEFAULT 0,
    quality         TEXT DEFAULT 'high',
    output_path     TEXT DEFAULT '',
    duration_ms     INTEGER DEFAULT 0,
    error_message   TEXT DEFAULT '',
    params          TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lipsync_jobs_shot ON film_lipsync_jobs(shot_id);
CREATE INDEX IF NOT EXISTS idx_lipsync_jobs_status ON film_lipsync_jobs(status);
