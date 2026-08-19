-- Phase 1: a generated artefact records what it was made from.
--
-- Nothing did. Editing a character's appearance, a location description, a
-- style preset or a scene card left every frame already generated from the old
-- version looking valid forever, and the only signal was a director noticing.
-- That is affordable at eight shots and impossible at fifteen hundred. It has
-- already cost once: a character plate generated in a stock clip-art style
-- survived the fix to its own builder by fourteen hours, because it was cached
-- and nothing knew it was out of date.
--
-- NULL default, and NULL means "outside the workflow" rather than "stale".
-- Treating an absent fingerprint as stale would retroactively invalidate every
-- asset in every existing project — wrong, and the fastest way to get the whole
-- feature switched off. It is also what keeps the byte-identical guarantee in
-- tests/fixtures/video-payload-golden.json intact for shots that predate this.

ALTER TABLE film_assets ADD COLUMN input_fingerprint TEXT DEFAULT NULL;

-- Which artefact kind the fingerprint was computed for. asset_type is close but
-- not the same thing: 'storyboard' and 'keyframe' are both the `keyframe` kind,
-- and the kind is what the registry in lib/artefact-fingerprint.js is keyed on.
ALTER TABLE film_assets ADD COLUMN artefact_kind TEXT DEFAULT NULL;

ALTER TABLE film_assets ADD COLUMN fingerprinted_at TEXT DEFAULT NULL;
