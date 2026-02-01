-- Film voice profiles
-- Voice references for TTS generation — linked to characters
CREATE TABLE IF NOT EXISTS film_voice_profiles (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    character_id    TEXT REFERENCES film_characters(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    sample_path     TEXT DEFAULT '',
    sample_duration_ms INTEGER DEFAULT 0,
    speaker_embedding TEXT DEFAULT '',
    tts_model       TEXT DEFAULT 'qwen3-tts',
    voice_params    TEXT DEFAULT '{}',
    language        TEXT DEFAULT 'en',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_voice_profiles_project ON film_voice_profiles(project_id);
CREATE INDEX IF NOT EXISTS idx_film_voice_profiles_character ON film_voice_profiles(character_id);
