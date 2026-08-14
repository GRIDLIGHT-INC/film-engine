-- Fix a latent 500 in the pipeline orchestrator.
--
-- routes/pipeline.js has always written 'completed_with_errors' when a step
-- fails, and migration 026's CHECK has never permitted it:
--
--   const finalStatus = failedSteps.length > 0 ? 'completed_with_errors' : 'complete';
--
-- So any partially failed run threw SQLITE_CONSTRAINT_CHECK on the final
-- UPDATE and the request returned 500 — losing the run record for exactly the
-- runs whose record mattered most. It stayed hidden because nothing in the
-- orchestrated path could fail: the old executeStep sent a stub payload that
-- every provider accepted, and it discarded results rather than persisting
-- them. Steps only became capable of failing once they started saving.
--
-- The status is intended and used by routes/video-gen.js and
-- routes/characters.js too, so the schema is what is wrong here.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt.

PRAGMA foreign_keys = OFF;

-- The unified jobs view SELECTs from film_pipeline_runs, so dropping the table
-- invalidates it. Drop it first and rebuild it verbatim afterwards; a rebuild
-- that leaves a dangling view fails every later query against it, not just this
-- migration.
DROP VIEW IF EXISTS film_unified_generation_jobs;

CREATE TABLE film_pipeline_runs_new (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_id         TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    scene_id        TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    run_type        TEXT NOT NULL DEFAULT 'shot'
                    CHECK (run_type IN ('shot', 'scene', 'project')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'paused', 'complete',
                                      'completed_with_errors', 'failed', 'cancelled')),
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

INSERT INTO film_pipeline_runs_new
SELECT id, project_id, shot_id, scene_id, run_type, status, current_step,
       steps_completed, steps_remaining, steps_failed, total_steps, progress_pct,
       started_at, completed_at, error_message, params, created_at
FROM film_pipeline_runs;

DROP TABLE film_pipeline_runs;
ALTER TABLE film_pipeline_runs_new RENAME TO film_pipeline_runs;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON film_pipeline_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status  ON film_pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_shot    ON film_pipeline_runs(shot_id);

CREATE VIEW IF NOT EXISTS film_unified_generation_jobs AS
SELECT id, project_id, shot_id, NULL AS scene_id, 'video' AS job_type, status,
       model AS model, prompt AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, duration_ms, NULL AS cost_usd
FROM film_video_jobs
UNION ALL
SELECT id, project_id, shot_id, NULL AS scene_id, 'voice' AS job_type, status,
       model_used AS model, dialogue_text AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, duration_ms, NULL AS cost_usd
FROM film_voice_jobs
UNION ALL
SELECT id, project_id, shot_id, scene_id, 'music:' || gen_type AS job_type, status,
       model AS model, prompt AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, duration_ms, NULL AS cost_usd
FROM film_music_jobs
UNION ALL
SELECT id, project_id, shot_id, NULL AS scene_id, 'lipsync' AS job_type, status,
       model AS model, '' AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, duration_ms, NULL AS cost_usd
FROM film_lipsync_jobs
UNION ALL
SELECT id, project_id, shot_id, NULL AS scene_id, 'post:' || job_type AS job_type, status,
       model AS model, '' AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, NULL AS duration_ms, NULL AS cost_usd
FROM film_post_jobs
UNION ALL
SELECT id, project_id, NULL AS shot_id, NULL AS scene_id, '3d:' || gen_type AS job_type, status,
       model AS model, prompt AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, NULL AS duration_ms, NULL AS cost_usd
FROM film_3d_jobs
UNION ALL
SELECT id, project_id, shot_id, scene_id, 'pipeline:' || run_type AS job_type, status,
       current_step AS model, steps_remaining AS prompt, '' AS output_path, error_message,
       created_at, completed_at,
       CASE
           WHEN started_at IS NOT NULL AND completed_at IS NOT NULL
           THEN CAST((julianday(completed_at) - julianday(started_at)) * 86400000 AS INTEGER)
           ELSE NULL
       END AS duration_ms,
       NULL AS cost_usd
FROM film_pipeline_runs
UNION ALL
SELECT id, project_id, NULL AS shot_id, NULL AS scene_id, 'refsheet' AS job_type, status,
       model AS model, views AS prompt, output_paths AS output_path, error_message,
       created_at, NULL AS completed_at, NULL AS duration_ms, NULL AS cost_usd
FROM film_refsheet_jobs
UNION ALL
SELECT id, project_id, shot_id, NULL AS scene_id, 'stitch' AS job_type, status,
       transition_type AS model, params AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, total_duration_ms AS duration_ms, NULL AS cost_usd
FROM film_stitch_jobs
UNION ALL
SELECT id, project_id, shot_id, scene_id, 'audio_mix' AS job_type, status,
       'audio-mixer' AS model, params AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, duration_ms, NULL AS cost_usd
FROM film_audio_mix_jobs
UNION ALL
SELECT id, project_id, NULL AS shot_id, NULL AS scene_id, 'location_image' AS job_type, status,
       model AS model, '' AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, NULL AS duration_ms, NULL AS cost_usd
FROM film_location_image_jobs
UNION ALL
SELECT id, project_id, NULL AS shot_id, NULL AS scene_id, 'prop_image' AS job_type, status,
       model AS model, '' AS prompt, output_path, error_message,
       created_at, NULL AS completed_at, NULL AS duration_ms, NULL AS cost_usd
FROM film_prop_image_jobs;

PRAGMA foreign_keys = ON;
