-- FILM-090-093: Music & Sound Design Pipeline
-- Track music, SFX, and ambient generation jobs
CREATE TABLE IF NOT EXISTS film_music_jobs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    scene_id        TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    shot_id         TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    music_cue_id    TEXT REFERENCES film_music_cues(id) ON DELETE SET NULL,
    gen_type        TEXT NOT NULL DEFAULT 'score'
                    CHECK (gen_type IN ('score', 'sfx', 'ambient', 'transition')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'generating', 'complete', 'failed')),
    prompt          TEXT DEFAULT '',
    model           TEXT DEFAULT 'musicgen-large',
    duration_ms     INTEGER DEFAULT 0,
    tempo_bpm       INTEGER DEFAULT 0,
    key_signature   TEXT DEFAULT '',
    seed            INTEGER DEFAULT -1,
    output_path     TEXT DEFAULT '',
    output_format   TEXT DEFAULT 'wav',
    error_message   TEXT DEFAULT '',
    params          TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_music_jobs_project ON film_music_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_music_jobs_scene ON film_music_jobs(scene_id);
CREATE INDEX IF NOT EXISTS idx_music_jobs_status ON film_music_jobs(status);
