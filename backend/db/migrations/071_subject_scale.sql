-- How big a thing actually is, in metres.
--
-- An image model has no metric understanding. Nothing in it knows a lawn
-- sprinkler is thirty centimetres and a car is five metres, and a reference
-- plate makes this WORSE rather than better: a plate is a close-up filling its
-- frame, and IP-adapter conditioning transfers appearance rather than size, so
-- the model reproduces what it was shown. A sprinkler plate produces a
-- sprinkler the size of the car parked beside it, which is exactly what
-- happened on the first frame that used one.
--
-- Size in a generated image comes from three things and only three: relative
-- language ("no taller than the kerb"), frame-fraction language ("one eighth of
-- the frame width"), and an anchor object of known size in shot. All three need
-- a number that nobody was recording.
--
-- Metres, not a free-text note. The engine already computes exactly what a lens
-- covers at a distance — frameCoverage(12m, 40mm, super35) is 7.5m wide — so a
-- declared height turns into a real frame fraction by arithmetic. A note saying
-- "small" cannot be divided by 7.5.
--
-- NULL means UNDECLARED, and undeclared means the prompt says nothing about
-- scale rather than guessing. An invented default is indistinguishable from a
-- deliberate one and would be wrong silently, which is the failure this exists
-- to end.

ALTER TABLE film_characters ADD COLUMN height_m REAL DEFAULT NULL;
ALTER TABLE film_props      ADD COLUMN height_m REAL DEFAULT NULL;
ALTER TABLE film_props      ADD COLUMN width_m  REAL DEFAULT NULL;
ALTER TABLE film_props      ADD COLUMN length_m REAL DEFAULT NULL;
