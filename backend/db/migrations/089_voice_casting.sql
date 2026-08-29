-- Casting a voice.
--
-- `buildVoicePayload` has read `voiceProfile.voice_id` since phase 4 and this
-- table never had the column, so the branch was dead: the `voice_params`
-- fallback was written by nothing, and every line fell through to the
-- provider's DEFAULT_VOICE_ID. A whole cast in one voice, silently, with no way
-- to change it from the app.
--
-- Added rather than replaced: the row already carries a name, a language, a
-- model and a sample path, and those are what a cloned voice needs. `voice_id`
-- is what a CATALOGUE voice needs, and most productions will use one.
ALTER TABLE film_voice_profiles ADD COLUMN voice_id TEXT;

-- What a director was auditioning when they picked it. Not the audio — that is
-- a file — but the line they judged it on, so "why is RAY this voice" has an
-- answer three weeks later.
ALTER TABLE film_voice_profiles ADD COLUMN cast_note TEXT;

CREATE INDEX IF NOT EXISTS idx_voice_profiles_character
    ON film_voice_profiles(character_id);
