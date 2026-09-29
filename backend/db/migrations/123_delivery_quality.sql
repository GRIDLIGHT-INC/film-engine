-- The project's delivery settings drive quality.
--
-- "We need to force this to generators, and if they cannot provide it,
-- downgrade to the best quality they have."
--
-- 1. Drafting becomes OPT-IN. video_draft defaulted to 1 when it was added
--    (migration 100), and nothing on the page could show or change it, so every
--    project was asking generators for their smallest size without anyone
--    having chosen that. It is switched off everywhere; a project that wants
--    cheap drafts turns it on in Settings. The column default cannot be
--    altered in place, so project creation writes 0 explicitly.
--    The old column's default cannot be changed in place (film_projects is
--    referenced by every table, and the runner cannot switch foreign keys off
--    inside its transaction), so the choice moves to a new column that
--    defaults OFF. video_draft stays for anything reading it and is written
--    in step; draft_video is the one the engine reads.
UPDATE film_projects SET video_draft = 0;
ALTER TABLE film_projects ADD COLUMN draft_video INTEGER NOT NULL DEFAULT 0;

-- 2. A delivery preset's codec and audio layout, kept. Applying a preset wrote
--    resolution, rate, aspect and colour space and dropped these two, so a
--    "ProRes 422 HQ, 5.1" delivery produced an H.264 stereo master. The master
--    is now encoded as the delivery says.
ALTER TABLE film_projects ADD COLUMN delivery_codec TEXT NOT NULL DEFAULT '';
ALTER TABLE film_projects ADD COLUMN delivery_audio_channels INTEGER NOT NULL DEFAULT 2;
