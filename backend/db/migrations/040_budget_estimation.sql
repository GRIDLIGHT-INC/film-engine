-- FILM-165: Budget estimation module
-- Add cost fields to characters for talent budgeting
ALTER TABLE film_characters ADD COLUMN day_rate REAL DEFAULT NULL;
ALTER TABLE film_characters ADD COLUMN shooting_days INTEGER DEFAULT NULL;
ALTER TABLE film_characters ADD COLUMN travel_allowance REAL DEFAULT 0;
ALTER TABLE film_characters ADD COLUMN actor_name TEXT DEFAULT '';
ALTER TABLE film_characters ADD COLUMN talent_tier TEXT DEFAULT 'unknown';

-- Add cost fields to locations for location budgeting
ALTER TABLE film_locations ADD COLUMN daily_rate REAL DEFAULT NULL;
ALTER TABLE film_locations ADD COLUMN prep_days INTEGER DEFAULT 0;
ALTER TABLE film_locations ADD COLUMN shoot_days INTEGER DEFAULT NULL;
ALTER TABLE film_locations ADD COLUMN permits_cost REAL DEFAULT 0;
ALTER TABLE film_locations ADD COLUMN location_type TEXT DEFAULT 'unknown';

-- Budget estimates table for full production budget breakdown
CREATE TABLE IF NOT EXISTS film_budget_estimates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Budget Estimate',
    template TEXT DEFAULT 'custom',
    -- template: micro, indie, low, mid, studio, custom
    currency TEXT DEFAULT 'USD',
    total_estimated REAL DEFAULT 0,
    above_the_line REAL DEFAULT 0,
    below_the_line REAL DEFAULT 0,
    production REAL DEFAULT 0,
    post_production REAL DEFAULT 0,
    other_costs REAL DEFAULT 0,
    contingency_pct REAL DEFAULT 10,
    line_items TEXT DEFAULT '[]',
    -- JSON array of { category, subcategory, description, amount, source, confidence, assumptions }
    assumptions TEXT DEFAULT '[]',
    -- JSON array of assumptions made during estimation
    missing_data TEXT DEFAULT '[]',
    -- JSON array of { field, entity_type, entity_id, suggested_range }
    ai_estimated_fields TEXT DEFAULT '[]',
    -- JSON array of { field, value, confidence, reasoning, estimated_at }
    web_searched_fields TEXT DEFAULT '[]',
    -- JSON array of { field, value, source_url, date_retrieved }
    shooting_days_estimate INTEGER DEFAULT NULL,
    complexity_score REAL DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_estimates_project ON film_budget_estimates(project_id);

-- Budget estimate line items for granular tracking
CREATE TABLE IF NOT EXISTS film_budget_line_items (
    id TEXT PRIMARY KEY,
    estimate_id TEXT NOT NULL REFERENCES film_budget_estimates(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    -- above_the_line, below_the_line_production, post_production, other
    subcategory TEXT NOT NULL,
    -- story_rights, writer, producer, director, cast_principal, etc.
    description TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    quantity REAL DEFAULT 1,
    rate REAL DEFAULT 0,
    unit TEXT DEFAULT 'flat',
    -- flat, day, week, hour, allow
    source TEXT DEFAULT 'manual',
    -- manual, web_search, ai_estimate, calculated
    source_url TEXT DEFAULT NULL,
    confidence TEXT DEFAULT 'medium',
    -- high, medium, low
    assumptions TEXT DEFAULT '',
    entity_type TEXT DEFAULT NULL,
    -- character, location, scene, shot
    entity_id TEXT DEFAULT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_line_items_estimate ON film_budget_line_items(estimate_id, category, sort_order);
