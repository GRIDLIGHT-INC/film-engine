-- One anchor, held deliberately, put down when you are done with it.
--
-- 073 got the shape wrong. It made the anchor a standing property of every
-- scene and DERIVED one automatically — the first shot in the scene that had a
-- frame — so pinning 1A lit up an anchor badge on 2A as well, because scene 2
-- had quietly appointed its own. Nothing was wrong on screen; the model was.
--
-- Anchoring is not a property a scene has. It is something a director picks up
-- while working on 1B and 1C and puts down afterwards to go back to plates. So:
-- exactly ONE active anchor per project, set explicitly, replaced by setting
-- another, and cleared explicitly. Nothing is an anchor by default and nothing
-- becomes one on its own.
--
-- That also retires the separate on/off switch. Setting an anchor IS turning it
-- on, which removes the state nobody could hold in their head: a pinned frame
-- that reached nothing because a checkbox elsewhere was clear.
ALTER TABLE film_projects ADD COLUMN anchor_shot_id TEXT REFERENCES film_shots(id) ON DELETE SET NULL;

-- The two columns 073 added, now unreachable. Dropped rather than left behind:
-- a dead column that still reads plausibly is the next person's afternoon.
ALTER TABLE film_projects DROP COLUMN scene_anchor_refs;
ALTER TABLE film_scenes DROP COLUMN anchor_shot_id;
