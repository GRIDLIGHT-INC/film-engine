-- Repair the station index for a database that already ran 096 unguarded.
--
-- json_extract THROWS on malformed JSON and an index is evaluated at INSERT
-- time, so the unguarded version made it impossible to store an asset whose
-- metadata is not JSON — a row this codebase deliberately tolerates, and one
-- the gallery suite inserts on purpose to prove the JS and SQL rules agree
-- about it.
--
-- 096 is corrected for a fresh database; this repairs one that is not.
DROP INDEX IF EXISTS idx_assets_sequence_station;

CREATE INDEX IF NOT EXISTS idx_assets_sequence_station
    ON film_assets (
        json_extract(metadata, '$.sequence_id'),
        json_extract(metadata, '$.shot_id'),
        json_extract(metadata, '$.station_index')
    )
    WHERE json_valid(metadata);
