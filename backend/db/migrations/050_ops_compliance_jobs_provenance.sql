-- Ops/compliance gap closures: unified queue support and AI provenance manifests.

CREATE TABLE IF NOT EXISTS film_provenance_manifests (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    asset_id        TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    manifest_type   TEXT NOT NULL DEFAULT 'project'
                    CHECK (manifest_type IN ('project', 'asset', 'export')),
    disclosure      TEXT NOT NULL DEFAULT '',
    c2pa_status     TEXT NOT NULL DEFAULT 'sidecar_only'
                    CHECK (c2pa_status IN ('sidecar_only', 'not_signed', 'signed')),
    manifest_json   TEXT NOT NULL DEFAULT '{}',
    sidecar_path    TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_provenance_project ON film_provenance_manifests(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provenance_asset ON film_provenance_manifests(asset_id);

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
