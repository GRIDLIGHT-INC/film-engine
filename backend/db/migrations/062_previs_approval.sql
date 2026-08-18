-- The iteration loop needs somewhere to record "this one".
--
-- A director blocks, looks at the frame, restages, looks again. That loop has
-- no natural end, and film_shots.status already permits 'approved' while no
-- generation path has ever read it — so the sign-off existed as a vocabulary
-- and never as a fact.
--
-- The fingerprint, not a boolean, is the point. A flag says a shot was approved
-- at some time; it cannot say WHAT was approved, so approving a close-up and
-- then dragging the camera leaves the flag standing over a shot nobody signed
-- off. Storing a hash of the camera + card at the moment of approval makes
-- "approved" and "approved AS IT IS NOW" different questions, which is the one
-- distinction an iterative loop actually turns on.
--
-- Additive with NULL defaults: a shot that was never approved has no
-- fingerprint, so every existing shot generates exactly as it did before.

ALTER TABLE film_previs_blocking ADD COLUMN approved_fingerprint TEXT DEFAULT NULL;
ALTER TABLE film_previs_blocking ADD COLUMN approved_at TEXT DEFAULT NULL;
