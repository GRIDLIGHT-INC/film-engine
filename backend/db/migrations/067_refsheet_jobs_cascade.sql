-- A project that generated a character sheet could never be deleted.
--
-- film_refsheet_jobs declared both its foreign keys with no ON DELETE action,
-- so deleting a character it referenced raised FOREIGN KEY constraint failed,
-- which cascaded up: deleting the project deletes its characters, that delete
-- is refused, and the whole DELETE /projects/:id returns 500.
--
-- It stayed invisible because the only projects anyone deleted were empty
-- ones — a project has to have generated a reference sheet to be affected, and
-- the first real deletion attempt hit it immediately.
--
-- CASCADE rather than SET NULL: a refsheet job records an attempt to draw a
-- particular character. Without the character it is not an orphan record worth
-- keeping, it is a row that can never be interpreted again. Both columns are
-- NOT NULL anyway, so SET NULL could not be honoured.
--
-- SQLite cannot alter a foreign key in place, so the table is rebuilt.

PRAGMA foreign_keys = OFF;

-- film_unified_generation_jobs SELECTs from film_refsheet_jobs, so dropping the
-- table invalidates the view and every later query against it. Same trap
-- migration 057 hit and documented; the view is recreated verbatim below.
DROP VIEW IF EXISTS film_unified_generation_jobs;

CREATE TABLE film_refsheet_jobs_new (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    character_id TEXT NOT NULL REFERENCES film_characters(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    views TEXT DEFAULT '["front","side","back"]',
    model TEXT DEFAULT 'sdxl',
    seed INTEGER,
    output_paths TEXT,
    error_message TEXT,
    params TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO film_refsheet_jobs_new
    SELECT id, project_id, character_id, status, views, model, seed,
           output_paths, error_message, params, created_at
      FROM film_refsheet_jobs;

DROP TABLE film_refsheet_jobs;
ALTER TABLE film_refsheet_jobs_new RENAME TO film_refsheet_jobs;

CREATE INDEX IF NOT EXISTS idx_film_refsheet_jobs_project ON film_refsheet_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_film_refsheet_jobs_character ON film_refsheet_jobs(character_id);

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

PRAGMA foreign_keys = ON;
