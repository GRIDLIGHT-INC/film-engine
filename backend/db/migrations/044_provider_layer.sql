-- Phase 1: multi-provider adapter layer foundation.
--
-- (1) Asset provenance & rights columns on film_assets — every generated or
--     licensed asset records which provider/model produced it, its job id, and
--     its licensing basis, so rights are auditable at export. Additive/nullable.
ALTER TABLE film_assets ADD COLUMN provider TEXT DEFAULT '';
ALTER TABLE film_assets ADD COLUMN provider_model TEXT DEFAULT '';
ALTER TABLE film_assets ADD COLUMN provider_job_id TEXT DEFAULT '';
ALTER TABLE film_assets ADD COLUMN license_source TEXT DEFAULT '';   -- 'generated' | 'licensed_catalog' | ''
ALTER TABLE film_assets ADD COLUMN license_status TEXT DEFAULT '';
ALTER TABLE film_assets ADD COLUMN prompt_hash TEXT DEFAULT '';
ALTER TABLE film_assets ADD COLUMN input_refs TEXT DEFAULT '';       -- JSON array of source asset ids
ALTER TABLE film_assets ADD COLUMN rights_notes TEXT DEFAULT '';
ALTER TABLE film_assets ADD COLUMN expires_at TEXT DEFAULT '';       -- for presigned provider URLs

CREATE INDEX IF NOT EXISTS idx_film_assets_provider ON film_assets(provider);

-- (2) Per-project provider selection (capability -> provider id), JSON.
--     Empty/unset means "use the env/gridlight default" (see lib/providers).
ALTER TABLE film_projects ADD COLUMN provider_config TEXT DEFAULT '{}';

-- (3) Global provider credentials store (server-side only; never returned in
--     full to the SPA). One row per provider. Keys are entered by the user in
--     the Provider Settings panel and stored in the local app data directory,
--     alongside all other Film Engine data.
CREATE TABLE IF NOT EXISTS film_provider_credentials (
    provider    TEXT PRIMARY KEY,
    api_key     TEXT DEFAULT '',
    meta        TEXT DEFAULT '{}',     -- JSON: extra config (org id, base url, oauth tokens, ...)
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
