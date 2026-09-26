-- PER-DECISION STATE: what each directing decision is doing, one at a time.
--
-- Apply and approve already exist, but each records ONE fingerprint for the
-- whole shot. A director exploring a shot needs finer grain than that: lock
-- the lens and height, keep trying the lighting. So Apply now also records a
-- fingerprint PER DECISION (camera, direction, lighting, location_view,
-- characters, props, movement), each side kept separately exactly as 081 did
-- for the whole shot, and a lock is a list of decision ids.
--
-- Both columns are NULL for every shot blocked before this, and a NULL reads
-- as "applied as a whole, never split" — nothing already applied changes state.
ALTER TABLE film_previs_blocking ADD COLUMN applied_parts_json TEXT DEFAULT NULL;
ALTER TABLE film_previs_blocking ADD COLUMN locked_parts_json TEXT DEFAULT NULL;
