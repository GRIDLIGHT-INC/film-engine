-- Applied is a relationship between two editable projections. Store each side
-- separately so the engine can distinguish "the stage moved" (Apply) from
-- "the board moved" (re-seed Previs) instead of inviting a destructive Apply.
ALTER TABLE film_previs_blocking ADD COLUMN applied_card_fingerprint TEXT DEFAULT NULL;
