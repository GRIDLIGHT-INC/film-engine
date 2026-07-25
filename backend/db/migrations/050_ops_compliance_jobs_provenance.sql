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
       model AS model, prompt AS prompt, output_path, error_message, created_at
FROM film_video_jobs
UNION ALL
SELECT id, project_id, shot_id, NULL AS scene_id, 'voice' AS job_type, status,
       model_used AS model, dialogue_text AS prompt, output_path, error_message, created_at
FROM film_voice_jobs
UNION ALL
SELECT id, project_id, shot_id, scene_id, 'music:' || gen_type AS job_type, status,
       model AS model, prompt AS prompt, output_path, error_message, created_at
FROM film_music_jobs
UNION ALL
SELECT id, project_id, shot_id, NULL AS scene_id, 'lipsync' AS job_type, status,
       model AS model, '' AS prompt, output_path, error_message, created_at
FROM film_lipsync_jobs
UNION ALL
SELECT id, project_id, shot_id, NULL AS scene_id, 'post:' || job_type AS job_type, status,
       model AS model, '' AS prompt, output_path, error_message, created_at
FROM film_post_jobs
UNION ALL
SELECT id, project_id, NULL AS shot_id, NULL AS scene_id, '3d:' || gen_type AS job_type, status,
       model AS model, prompt AS prompt, output_path, error_message, created_at
FROM film_3d_jobs;
