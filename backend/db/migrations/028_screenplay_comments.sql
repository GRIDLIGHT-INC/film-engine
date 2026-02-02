-- 028: Screenplay inline comments
CREATE TABLE IF NOT EXISTS film_screenplay_comments (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    element_index INTEGER NOT NULL DEFAULT 0,
    start_offset INTEGER NOT NULL DEFAULT 0,
    end_offset INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT 'user',
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_screenplay_comments_script ON film_screenplay_comments(script_id);
CREATE INDEX IF NOT EXISTS idx_screenplay_comments_resolved ON film_screenplay_comments(resolved);
