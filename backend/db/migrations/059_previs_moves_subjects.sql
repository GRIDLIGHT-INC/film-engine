-- Phase 5: compound moves and a populated stage.
--
-- A shot held ONE movement and one subject box. Neither survives contact with a
-- real move: "push in, settle, then pan off" is three legs, and judging whether
-- the camera clears the foreground needs something in the foreground.
--
-- Both columns are additive with a default, so every blocking already saved
-- keeps loading and keeps sampling to the path it sampled before. `movement`
-- stays as the single-leg form and as the name the video layer's camera_control
-- is keyed on; a sequence records its legs here and its first leg still names
-- the control the generator already understands.

ALTER TABLE film_previs_blocking ADD COLUMN moves_json TEXT NOT NULL DEFAULT '[]';

-- Placed objects: the standing figure, boxes, spheres. Not a set-modelling
-- format — position, size and kind only, which is the line that keeps this a
-- previs tool rather than a worse Blender.
ALTER TABLE film_previs_blocking ADD COLUMN subjects_json TEXT NOT NULL DEFAULT '[]';
