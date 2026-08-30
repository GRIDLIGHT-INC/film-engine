-- A shot as a strip of stations, indexed.
--
-- NO NEW TABLE. A station is a storyboard frame like any other and belongs in
-- film_assets: that is what gives it the shot_frames archive for free, so a bad
-- in-between becomes a re-roll you keep rather than one you lose. A parallel
-- table would need its own archive, its own serving route and its own delete,
-- and would be the second place "which picture is this shot's" is answered.
--
-- What it needs is to be FOUND quickly. The strip is read on every plan, every
-- run and every approval check, and each of those asks the same two questions:
-- which stations belong to this sequence, and in what order.

-- GUARDED BY json_valid, and that guard is load-bearing.
--
-- json_extract THROWS on malformed JSON, and an index is evaluated at INSERT
-- time — so an unguarded expression index makes it impossible to store an asset
-- whose metadata is not JSON, which this codebase deliberately tolerates and
-- which sendableSql already guards against for the same reason. Caught by the
-- gallery suite within a minute: inserting its "not json at all" row started
-- failing with SQLITE_ERROR.
CREATE INDEX IF NOT EXISTS idx_assets_sequence_station
    ON film_assets (
        json_extract(metadata, '$.sequence_id'),
        json_extract(metadata, '$.shot_id'),
        json_extract(metadata, '$.station_index')
    )
    WHERE json_valid(metadata);

-- And the approval, which is a property of the sequence rather than of any one
-- station. Empty means unapproved, which is what every sequence that exists
-- today is -- treating an absent fingerprint as stale would refuse all of them
-- on the day this ships.
ALTER TABLE film_sequences ADD COLUMN strip_fingerprint TEXT DEFAULT '';
ALTER TABLE film_sequences ADD COLUMN strip_approved_at TEXT;
