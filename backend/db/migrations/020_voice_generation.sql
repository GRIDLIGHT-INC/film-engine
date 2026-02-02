-- FILM-022-028: Voice & Dialogue Pipeline
-- Track voice generation jobs per dialogue line
CREATE TABLE IF NOT EXISTS film_voice_jobs (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_id         TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    character_id    TEXT REFERENCES film_characters(id) ON DELETE SET NULL,
    dialogue_text   TEXT NOT NULL DEFAULT '',
    emotion         TEXT DEFAULT 'neutral',
    voice_profile_id TEXT REFERENCES film_voice_profiles(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'generating', 'complete', 'failed')),
    output_path     TEXT DEFAULT '',
    duration_ms     INTEGER DEFAULT 0,
    sample_rate     INTEGER DEFAULT 24000,
    model_used      TEXT DEFAULT '',
    seed            INTEGER DEFAULT -1,
    params          TEXT DEFAULT '{}',
    error_message   TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_voice_jobs_project ON film_voice_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_voice_jobs_shot ON film_voice_jobs(shot_id);
CREATE INDEX IF NOT EXISTS idx_voice_jobs_status ON film_voice_jobs(status);
