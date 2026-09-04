-- World Engine — a place a camera can stand in, built from a location's plates.
--
-- A World is NOT a Shot. A world is a persistent set that many shots are framed
-- inside; a shot is one camera setup within one version of it. Conflating them
-- is what makes "six shots, one world" unsayable.
--
-- Two things this schema deliberately does NOT do:
--
--   1. It does not store a camera. `film_previs_blocking` already holds
--      camera_json, subjects_json, moves_json and camera_keys_json under
--      shot_id UNIQUE, and a second camera store is two answers to "where is
--      the camera for this shot" — the failure this codebase has recorded
--      three times (the plate pointer, the frame pointer, effectiveCamera).
--      A SpatialShot is that row plus a world pin, which is the two columns at
--      the bottom of this file.
--
--   2. It does not add a job table. film_generation_jobs (101) already records
--      an async handle BEFORE polling, keyed by provider + request_id, and
--      `world` is already a priced capability. A second job table would be a
--      second answer to "what is running".

CREATE TABLE IF NOT EXISTS film_worlds (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    -- A world usually reconstructs a LOCATION, and is usually used by one
    -- scene, but neither is required: a set can outlive both. SET NULL rather
    -- than CASCADE for the same reason.
    scene_id          TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    location_id       TEXT REFERENCES film_locations(id) ON DELETE SET NULL,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    -- No FK: the versions table does not exist yet at this point in the file,
    -- and a world with no version is a legitimate state (created, not yet
    -- generated). Resolved by query, not by constraint.
    active_version_id TEXT,
    -- NULL means unlocked, which is what every world starts as. A timestamp
    -- rather than a boolean because "when did we call this done" is the useful
    -- half of the answer.
    locked_at         TEXT DEFAULT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_worlds_project ON film_worlds(project_id);

CREATE TABLE IF NOT EXISTS film_world_versions (
    id                TEXT PRIMARY KEY,
    world_id          TEXT NOT NULL REFERENCES film_worlds(id) ON DELETE CASCADE,
    version           INTEGER NOT NULL,
    parent_version_id TEXT REFERENCES film_world_versions(id) ON DELETE SET NULL,
    provider          TEXT NOT NULL DEFAULT 'worldlabs',
    provider_world_id TEXT,
    model             TEXT,
    status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'approved', 'production', 'failed')),
    reason            TEXT NOT NULL DEFAULT '',

    -- SCALE: NULL means UNCALIBRATED, and is deliberately not 1.0.
    --
    -- Marble promises no unit. "Nobody has measured this" and "this measures
    -- 1:1" are different claims, and spelling them the same is how a confident
    -- wrong distance reaches a lens calculation looking deliberate. Both
    -- operands are stored beside the factor so it can be re-derived and argued
    -- with rather than taken on trust.
    scale_factor      REAL DEFAULT NULL,
    scale_source      TEXT DEFAULT NULL,
    scale_known_m     REAL DEFAULT NULL,
    scale_measured    REAL DEFAULT NULL,

    caption           TEXT,
    bounds_json       TEXT,
    job_id            TEXT REFERENCES film_generation_jobs(id) ON DELETE SET NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),

    -- A version is never overwritten; it is superseded. This is what makes
    -- "shot 2B is pinned to v3" mean something a month later.
    UNIQUE (world_id, version)
);

CREATE INDEX IF NOT EXISTS idx_world_versions_world ON film_world_versions(world_id);

CREATE TABLE IF NOT EXISTS film_world_assets (
    id               TEXT PRIMARY KEY,
    world_version_id TEXT NOT NULL REFERENCES film_world_versions(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL
                     CHECK (kind IN ('collider', 'panorama', 'thumbnail',
                                     'splat_100k', 'splat_500k', 'splat_full')),
    -- Exactly one of these is the truth for a given row. The three heavy kinds
    -- are COPIED (asset_id set) because GET /marble/v1/worlds is a 404 — there
    -- is no list endpoint, so a world we cannot re-fetch and cannot list is a
    -- paid asset with no path back. The splats are RECORDED by URL until
    -- WORLD_SPLATS is on, because full_res is 25 MB per world.
    remote_url       TEXT,
    asset_id         TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    bytes            INTEGER,
    metadata_json    TEXT NOT NULL DEFAULT '{}',

    -- Re-ingesting replaces rather than accumulates: the six-rows-for-three-
    -- files bug that plate views already paid for once.
    UNIQUE (world_version_id, kind)
);

CREATE TABLE IF NOT EXISTS film_world_sources (
    id               TEXT PRIMARY KEY,
    world_version_id TEXT NOT NULL REFERENCES film_world_versions(id) ON DELETE CASCADE,
    source_asset_id  TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    source_type      TEXT NOT NULL
                     CHECK (source_type IN ('image', 'multi-image', 'video', 'text')),
    -- Ordered, because on a multi-image reconstruction the order and the
    -- azimuth together are what decide which way the world faces.
    azimuth          REAL,
    ordinal          INTEGER NOT NULL DEFAULT 0,
    metadata_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_world_sources_version ON film_world_sources(world_version_id);

-- The world pin. ON DELETE SET NULL, never CASCADE: deleting a world must not
-- delete the blocking a director authored inside it. That is the
-- film_refsheet_jobs trap of migration 067, and the same reasoning
-- film_assets.shot_id already follows.
ALTER TABLE film_previs_blocking ADD COLUMN world_version_id TEXT
    REFERENCES film_world_versions(id) ON DELETE SET NULL;
ALTER TABLE film_previs_blocking ADD COLUMN world_pinned_at TEXT DEFAULT NULL;
