-- A location's set, built in Blender from its own plates.
--
-- "The Blender build, done automatically: we might remove the Marble process
-- since Blender is free to do."
--
-- One row per ATTEMPT. The connected agent reads the plates and writes a
-- layout; the engine builds it headless and renders it from every plate
-- camera beside the plate, so a build is judged against the pictures it came
-- from. Attempts are kept rather than overwritten: the second layout is
-- written from what the first one got wrong, and losing the first loses the
-- reason. A finished attempt becomes a world version and a 3D model asset.
--
-- CASCADE from the location and project: an attempt at a place that no longer
-- exists cannot be read again. SET NULL from the world version and the asset:
-- deleting a world must not erase the record of how its set was made.
CREATE TABLE IF NOT EXISTS film_set_builds (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    location_id       TEXT NOT NULL REFERENCES film_locations(id) ON DELETE CASCADE,
    attempt           INTEGER NOT NULL,
    layout_json       TEXT NOT NULL,
    note              TEXT,
    status            TEXT NOT NULL DEFAULT 'rendered'
                      CHECK (status IN ('rendered', 'failed', 'finished')),
    error             TEXT,
    out_dir           TEXT,
    renders_json      TEXT NOT NULL DEFAULT '{}',
    faces_json        TEXT,
    world_version_id  TEXT REFERENCES film_world_versions(id) ON DELETE SET NULL,
    asset_id          TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_set_builds_location ON film_set_builds(location_id, attempt);
