-- What failed in a run, structurally.
--
-- A run row recorded `steps_failed` as a list of ids and nothing else about
-- them. For the conform that lost the executor walk — which of the two
-- executors was tried, which was not, and why — on the way from the step to
-- the row, so a failed project run said `assembly` and left the reader to
-- rerun it to find out. `failures` carries { step, code, error, walk } per
-- failed step; `error_message` gets one readable line per failure.
ALTER TABLE film_pipeline_runs ADD COLUMN failures TEXT DEFAULT '[]';
