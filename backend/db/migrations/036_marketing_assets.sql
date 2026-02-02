-- FILM-158: Marketing assets (poster, key art, banners)
CREATE TABLE IF NOT EXISTS film_marketing_assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'poster',
    -- type: poster, key_art, banner, social_card, still, thumbnail, logo
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    aspect_ratio TEXT NOT NULL DEFAULT '2:3',
    resolution TEXT NOT NULL DEFAULT '1080x1620',
    image_path TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    -- status: planned, generating, generated, approved, rejected
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_marketing_project ON film_marketing_assets(project_id, type);
