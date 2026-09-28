-- A running generation says how far along it is (PGN-001).
--
-- film_generation_jobs began as the record of a PROVIDER HANDLE: an async job
-- whose id had to be written down before polling so it could be collected if
-- the caller was torn down. The Production graph needs something wider -- one
-- place that says what is running right now, including synchronous calls that
-- have no handle, and including jobs started by Claude in the separate MCP
-- process, which the page only learns about through the database.
--
-- percent       0..100 when the provider reports one; NULL means unknown, never 0
-- phase         a short word from the provider or the engine ("rendering")
-- started_at    when the generation began, so elapsed time can be shown
-- heartbeat_at  the last time anything was heard, so a stalled row is visible
-- collectable   1 = a provider holds this job and collect() can fetch it;
--               0 = a synchronous call with no handle, never offered for
--               collect or recovery, because no provider could answer.
ALTER TABLE film_generation_jobs ADD COLUMN percent REAL;
ALTER TABLE film_generation_jobs ADD COLUMN phase TEXT;
ALTER TABLE film_generation_jobs ADD COLUMN started_at TEXT;
ALTER TABLE film_generation_jobs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE film_generation_jobs ADD COLUMN collectable INTEGER NOT NULL DEFAULT 1;
