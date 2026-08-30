-- One row per FILE that leaves the job.
--
-- A film has one shape. A commercial has fourteen to twenty-two, and the set is
-- decided BEFORE anything is generated -- because it is what says which shots
-- must be shot vertical rather than cropped later. A 9:16 centre crop of a 16:9
-- frame keeps 32% of its width; Auto Reframe follows a subject inside the pixels
-- it has and cannot invent the two-thirds that were never generated.
--
-- Premiere renders these. The engine plans them and emits one sequence per row.
CREATE TABLE IF NOT EXISTS film_deliverables (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    key             TEXT NOT NULL DEFAULT '',        -- '30_16x9' -- the sequence name in the NLE
    label           TEXT NOT NULL DEFAULT '',
    profile_id      TEXT NOT NULL DEFAULT '',        -- a DELIVERY_PROFILES id, or '' for hand-built
    aspect_ratio    TEXT NOT NULL DEFAULT '16:9',
    width           INTEGER NOT NULL DEFAULT 1920,
    height          INTEGER NOT NULL DEFAULT 1080,
    fps             REAL    NOT NULL DEFAULT 29.97,
    duration_ms     INTEGER NOT NULL DEFAULT 30000,
    platform        TEXT NOT NULL DEFAULT ''
                    CHECK (platform IN ('', 'broadcast', 'ctv', 'youtube', 'meta',
                                        'tiktok', 'shorts', 'web', 'still')),
    loudness_target TEXT NOT NULL DEFAULT '',        -- '-24 LKFS', '-23 LUFS', '-14 LUFS'
    caption_mode    TEXT NOT NULL DEFAULT 'sidecar'
                    CHECK (caption_mode IN ('none', 'sidecar', 'burned')),
    native          INTEGER NOT NULL DEFAULT 0,      -- 1 = must be GENERATED at this ratio
    sort_order      INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'ready', 'delivered', 'dropped')),
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_film_deliverables_project
    ON film_deliverables(project_id, sort_order);

-- The runtime the spot must hit, EXACTLY.
--
-- 0 means "no target", which is every film ever made in this tool and must stay
-- the behaviour of a project that never sets one -- the same rule NULL follows
-- for an artefact fingerprint.
ALTER TABLE film_projects ADD COLUMN target_duration_ms INTEGER NOT NULL DEFAULT 0;

-- A shot's own ratio. Empty inherits the project's, which is what every existing
-- shot does and must keep doing.
ALTER TABLE film_shots ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT '';
