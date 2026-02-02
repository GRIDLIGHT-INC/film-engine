-- FILM-157: Credit roll & title sequences
CREATE TABLE IF NOT EXISTS film_credits (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    section TEXT NOT NULL DEFAULT 'cast',
    -- section: opening, cast, crew, special_thanks, closing
    role TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    character_name TEXT DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    style TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_credits_project ON film_credits(project_id, section, sort_order);

CREATE TABLE IF NOT EXISTS film_title_cards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    card_type TEXT NOT NULL DEFAULT 'main_title',
    -- card_type: main_title, subtitle, chapter, end_title, card
    text TEXT NOT NULL DEFAULT '',
    subtext TEXT NOT NULL DEFAULT '',
    position_in_timeline INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 3000,
    style TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_title_cards_project ON film_title_cards(project_id, sort_order);
