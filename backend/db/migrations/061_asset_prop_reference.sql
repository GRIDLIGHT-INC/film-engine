-- Reference plates for props.
--
-- film_assets could already link a plate to a character or a location, but not
-- to a prop -- so a prop plate had nowhere to attach and the storyboard route
-- could never find one. lib/reference-images.js has ranked 'prop' as a
-- referenceable kind since it was written; this is the column that makes that
-- ranking mean something.
--
-- Nullable and unconstrained by design: the vast majority of assets are not
-- prop plates, and adding a FK constraint would require rebuilding the table
-- (SQLite cannot ALTER one in place) for no benefit the application does not
-- already enforce.

ALTER TABLE film_assets ADD COLUMN prop_id TEXT;

CREATE INDEX IF NOT EXISTS idx_film_assets_prop ON film_assets(prop_id);
