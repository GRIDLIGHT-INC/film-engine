-- 3D Asset Generation Pipeline
-- Proxies Gridlight /3d endpoints (text->mesh, image->mesh, rig, retexture, animate).
--
-- NOTE ON film_assets.asset_type:
--   film_assets has a restrictive CHECK on asset_type that cannot be widened in
--   place (SQLite cannot ALTER a CHECK, and the migration runner wraps every file
--   in a transaction where `PRAGMA foreign_keys=OFF` is a no-op — so the safe
--   table-rebuild procedure is not available here without risking the inbound FK
--   film_video_jobs.keyframe_asset_id -> film_assets(id)). Following the existing
--   convention already used for reference sheets, 3D outputs are registered in
--   film_assets as asset_type='other' with metadata.kind='model_3d' (or
--   'model_rigged' / 'model_animated' / 'texture'). film_3d_jobs below is the
--   typed source of truth for all 3D queries.

CREATE TABLE IF NOT EXISTS film_3d_jobs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    character_id    TEXT REFERENCES film_characters(id) ON DELETE SET NULL,
    prop_id         TEXT,                          -- no FK: props are deleted freely; linkage kept soft
    subject_kind    TEXT NOT NULL DEFAULT 'character'
                    CHECK (subject_kind IN ('character', 'prop', 'set', 'shot')),
    gen_type        TEXT NOT NULL DEFAULT 'generate'
                    CHECK (gen_type IN ('generate', 'from_image', 'rig', 'retexture', 'animate')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'generating', 'complete', 'failed', 'cancelled')),
    source_asset_id TEXT REFERENCES film_assets(id) ON DELETE SET NULL,  -- for from_image / rig / retexture / animate
    upstream_job_id TEXT DEFAULT '',               -- Gridlight async job id, if the service returns one
    model           TEXT DEFAULT 'hunyuan3d',
    format          TEXT DEFAULT 'glb',
    seed            INTEGER DEFAULT -1,
    prompt          TEXT DEFAULT '',
    output_path     TEXT DEFAULT '',
    output_asset_id TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    error_message   TEXT DEFAULT '',
    params          TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_3d_jobs_project ON film_3d_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_3d_jobs_character ON film_3d_jobs(character_id);
CREATE INDEX IF NOT EXISTS idx_3d_jobs_prop ON film_3d_jobs(prop_id);
CREATE INDEX IF NOT EXISTS idx_3d_jobs_status ON film_3d_jobs(status);
CREATE INDEX IF NOT EXISTS idx_3d_jobs_gen_type ON film_3d_jobs(gen_type);
