-- FILM-006: film_shots table (SQLite)
CREATE TABLE IF NOT EXISTS film_shots (
    id              TEXT PRIMARY KEY,
    scene_id        TEXT NOT NULL REFERENCES film_scenes(id) ON DELETE CASCADE,
    shot_code       TEXT NOT NULL DEFAULT '',
    scene_card_yaml TEXT DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                        'pending', 'generating', 'complete', 'failed', 'approved'
                    )),
    render_job_id   TEXT DEFAULT NULL,
    duration_ms     INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_shots_scene ON film_shots(scene_id);
CREATE INDEX IF NOT EXISTS idx_film_shots_status ON film_shots(status);
