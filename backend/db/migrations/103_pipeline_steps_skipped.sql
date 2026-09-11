-- A step the runner decided NOT to run was computed and stored nowhere.
--
-- The scene and project runners built a `skippedSteps` list — a scene-scoped
-- score already generated for this scene, a project-scoped conform on a run
-- below its scope — and wrote only completed and failed to the row. So the one
-- thing that distinguishes "did not run, on purpose, for this reason" from
-- "nothing happened" was thrown away the moment it was known, which is the
-- defect scene scope was introduced to stop: a step that quietly does nothing
-- is indistinguishable from one that ran.
ALTER TABLE film_pipeline_runs ADD COLUMN steps_skipped TEXT DEFAULT '[]';
