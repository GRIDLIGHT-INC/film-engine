-- AI spend tracking: what each generation consumed, in the provider's own units.
--
-- film_cost_entries (037) already existed and had exactly ONE writer: a manual
-- POST that a human had to fill in by hand. So a project could generate forty
-- images and report a spend of zero, which is indistinguishable from a project
-- that generated nothing. This table is what makes the ledger self-writing.
--
-- Separate from film_cost_entries rather than more columns on it, because the
-- two answer different questions. A cost entry is money — it is what the budget
-- bar, the flow gate and the forecast all sum. A usage event is CONSUMPTION:
-- tokens, credits, characters, seconds, priced at whatever the rate book said
-- at the moment of the call. Rates change; what was consumed does not. Keeping
-- the quantity and the rate that priced it means a rate correction can be
-- replayed over history instead of silently rewriting what the ledger claims
-- was spent.

CREATE TABLE IF NOT EXISTS film_usage_events (
    id              TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES film_projects(id) ON DELETE CASCADE,
    -- Nulled rather than cascaded: deleting a shot must not erase the record
    -- that money was spent on it. The spend happened; the shot is what stopped
    -- existing. Same reasoning as film_assets.shot_id.
    shot_id         TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    scene_id        TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    cost_entry_id   TEXT REFERENCES film_cost_entries(id) ON DELETE SET NULL,

    provider        TEXT NOT NULL DEFAULT '',
    capability      TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',

    -- What the adapter could measure, and how much of it.
    unit            TEXT NOT NULL DEFAULT 'call',
    quantity        REAL NOT NULL DEFAULT 0,
    -- The provider's own billing unit — credits, mostly. This is the number a
    -- prepaid balance actually runs out of, and reporting only dollars hides it.
    native_unit     TEXT NOT NULL DEFAULT '',
    native_quantity REAL NOT NULL DEFAULT 0,
    -- Token splits and anything else the response reported, as JSON.
    parts           TEXT NOT NULL DEFAULT '{}',

    unit_rate       REAL NOT NULL DEFAULT 0,
    amount_usd      REAL NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'USD',

    -- 0 = measured from a real response. 1 = reconstructed or inferred (a
    -- backfill over assets that predate tracking, a duration the adapter could
    -- not read, a model the rate book does not name). Named rather than folded
    -- in, because "we measured $41" and "we think it was about $41" are
    -- different claims and only one of them should be defended in a meeting.
    estimated       INTEGER NOT NULL DEFAULT 0,
    estimate_basis  TEXT NOT NULL DEFAULT '',

    -- Reconstruction key: one usage event per source artefact, so re-running a
    -- backfill cannot double a project's history.
    source_ref      TEXT DEFAULT NULL,

    ok              INTEGER NOT NULL DEFAULT 1,
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_project ON film_usage_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_capability ON film_usage_events(project_id, capability);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON film_usage_events(project_id, provider);
CREATE INDEX IF NOT EXISTS idx_usage_shot ON film_usage_events(shot_id);
-- Partial: a live event has no source_ref, and thousands of NULLs must not
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_source ON film_usage_events(source_ref)
    WHERE source_ref IS NOT NULL;

-- Per-install rate corrections. The researched book in lib/provider-pricing.js
-- is a default, not a fact about this account: credit-to-dollar conversion
-- depends on which plan the user is on, and Meshy in particular publishes
-- credit costs without publishing what a credit costs. A user on another plan
-- fixes their own book here rather than editing code — and the researched
-- default stays underneath, so a bad override can be deleted rather than
-- reconstructed.
CREATE TABLE IF NOT EXISTS film_provider_rates (
    id              TEXT PRIMARY KEY,
    provider        TEXT NOT NULL,
    capability      TEXT NOT NULL,
    model           TEXT DEFAULT NULL,
    native_per_unit REAL DEFAULT NULL,
    usd_per_native  REAL DEFAULT NULL,
    note            TEXT NOT NULL DEFAULT '',
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_rates_key
    ON film_provider_rates(provider, capability, COALESCE(model, ''));
