-- Query support for operations/compliance dashboards.

CREATE INDEX IF NOT EXISTS idx_voice_jobs_project_created ON film_voice_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_jobs_project_created ON film_video_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_music_jobs_project_created ON film_music_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lipsync_jobs_project_created ON film_lipsync_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_jobs_project_created ON film_post_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_3d_jobs_project_created ON film_3d_jobs(project_id, created_at DESC);
