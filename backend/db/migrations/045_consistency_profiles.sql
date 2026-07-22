-- First-class consistency profiles.
--
-- Profiles are the production contract for visual/voice continuity. Entity
-- creation can stay exploratory; downstream generation consumes locked profiles.
CREATE TABLE IF NOT EXISTS film_consistency_profiles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    profile_type TEXT NOT NULL CHECK (profile_type IN ('character', 'location', 'prop', 'style', 'voice')),
    subject_id TEXT DEFAULT '',
    subject_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked', 'archived')),
    canonical_asset_id TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    prompt_contract TEXT NOT NULL DEFAULT '',
    negative_contract TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    provider_model TEXT NOT NULL DEFAULT '',
    locked_seed INTEGER,
    reference_weight REAL DEFAULT 0.7,
    required_roles TEXT NOT NULL DEFAULT '[]',
    settings TEXT NOT NULL DEFAULT '{}',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consistency_profiles_project ON film_consistency_profiles(project_id, profile_type, status);
CREATE INDEX IF NOT EXISTS idx_consistency_profiles_subject ON film_consistency_profiles(project_id, profile_type, subject_id);

-- Multiple canonical/supporting references per profile. The canonical profile
-- asset remains on film_consistency_profiles.canonical_asset_id for fast reads;
-- this table gives UI/routes role-specific reference management.
CREATE TABLE IF NOT EXISTS film_consistency_refs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES film_consistency_profiles(id) ON DELETE CASCADE,
    asset_id TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    ref_role TEXT NOT NULL DEFAULT 'canonical',
    weight REAL DEFAULT 0.7,
    is_required INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consistency_refs_profile ON film_consistency_refs(profile_id, ref_role);
CREATE INDEX IF NOT EXISTS idx_consistency_refs_asset ON film_consistency_refs(asset_id);

-- Persisted audit snapshots for UI/history. The pure audit helper can be used
-- without writing here; routes/pipeline may store checks when useful.
CREATE TABLE IF NOT EXISTS film_consistency_checks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_id TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    scene_id TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'warning' CHECK (status IN ('ready', 'warning', 'blocked')),
    missing TEXT NOT NULL DEFAULT '[]',
    warnings TEXT NOT NULL DEFAULT '[]',
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consistency_checks_project ON film_consistency_checks(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consistency_checks_shot ON film_consistency_checks(shot_id, created_at);
