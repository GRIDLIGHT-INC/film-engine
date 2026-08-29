-- A cue that changes over its own length.
--
-- film_music_cues carried one description for the whole cue, so "sparse under
-- the argument, then it opens out when he finally says it" could only be
-- written as a sentence and hoped for. ElevenLabs' /music takes a
-- composition_plan: named sections, each with its own direction and its own
-- duration, and the API honours those durations.
--
-- NULL/'[]' means no sections, which is the state every existing cue is in and
-- which keeps the plain prompt path byte-identical: `prompt` and
-- `composition_plan` are mutually exclusive at the provider, so a cue that
-- names no sections must send exactly what it sends today.
ALTER TABLE film_music_cues ADD COLUMN sections_json TEXT DEFAULT '[]';

-- What the cue must NOT be. The provider takes negatives globally and per
-- section, and "no drums until the reveal" is a note a composer gives
-- constantly and had nowhere to live.
ALTER TABLE film_music_cues ADD COLUMN negative_prompt TEXT DEFAULT '';
