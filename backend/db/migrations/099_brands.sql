-- A brand OUTLIVES a project.
--
-- The same reason the style book does: one client buys many spots, and a kit
-- that dies with the project is one that is re-uploaded every time that client
-- comes back. NO project_id, and it must survive a project delete -- the
-- film_refsheet_jobs trap of migration 067, where a CASCADE deleted a library
-- as a side effect of tidying up one film.
CREATE TABLE IF NOT EXISTS film_brands (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL DEFAULT '',
    logo_asset_id     TEXT NOT NULL DEFAULT '',      -- a film_assets row
    logo_clear_space  TEXT NOT NULL DEFAULT '',      -- '0.5x cap height', free text
    palette           TEXT NOT NULL DEFAULT '',      -- JSON array of hex strings
    fonts             TEXT NOT NULL DEFAULT '',      -- JSON array of {role, family, weight}
    cta               TEXT NOT NULL DEFAULT '',
    cta_url           TEXT NOT NULL DEFAULT '',
    legal_line        TEXT NOT NULL DEFAULT '',
    banned_phrases    TEXT NOT NULL DEFAULT '',      -- JSON array of strings
    tone              TEXT NOT NULL DEFAULT '',      -- reaches the prompt
    approval_contact  TEXT NOT NULL DEFAULT '',
    notes             TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A claim and the evidence for it.
--
-- FTC, the Competition Act, the CAP Code and the ACCC all require an objective
-- claim to be substantiated. An automated pipeline can put "#1", "clinically
-- proven" or "saves 50%" into a paid advertisement in seconds, which is exactly
-- why the substantiation has to be a row somebody signed rather than a memory.
CREATE TABLE IF NOT EXISTS film_claims (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    claim          TEXT NOT NULL DEFAULT '',
    substantiation TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'unsubstantiated'
                   CHECK (status IN ('unsubstantiated', 'substantiated', 'withdrawn')),
    approved_by    TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_film_claims_project ON film_claims(project_id, status);

ALTER TABLE film_projects ADD COLUMN brand_id TEXT NOT NULL DEFAULT '';
ALTER TABLE film_projects ADD COLUMN client   TEXT NOT NULL DEFAULT '';
ALTER TABLE film_projects ADD COLUMN campaign TEXT NOT NULL DEFAULT '';
