-- FILM-088: Shot version history
-- Each re-render or revision creates a new version
CREATE TABLE IF NOT EXISTS film_shot_versions (
    id                  TEXT PRIMARY KEY,
    shot_id             TEXT NOT NULL REFERENCES film_shots(id) ON DELETE CASCADE,
    version             INTEGER NOT NULL DEFAULT 1,
    render_ledger_id    TEXT REFERENCES render_ledger(id) ON DELETE SET NULL,
    thumbnail_path      TEXT DEFAULT '',
    video_path          TEXT DEFAULT '',
    audio_path          TEXT DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'review', 'approved', 'rejected', 'archived')),
    notes               TEXT DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_shot_versions_shot ON film_shot_versions(shot_id, version DESC);
