-- The director's own instruments: a plugin, and the state that recalls a patch.
--
-- "I have 248 libraries that I paid for over the years... I want to use those
-- libraries INSIDE Film Engine." A plugin exposes its STATE, not its browser,
-- so an instrument here is a plugin path plus the state blob that loads the
-- sound — captured once through the plugin's editor, or read from an NKS
-- preset, whose PCHK chunk is that same state.
--
-- NOT project-scoped, deliberately, on the style-book precedent: a library a
-- director bought outlives any one film, and re-capturing a patch per project
-- is exactly the time this is meant to save.

CREATE TABLE IF NOT EXISTS film_instruments (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    -- What plays it. The path is checked against the plugin folders by the
    -- sidecar on every render; stored here so a row survives a reinstall.
    plugin_path   TEXT NOT NULL,
    plugin_format TEXT NOT NULL DEFAULT 'vst3'
                  CHECK (plugin_format IN ('vst3', 'au', 'vst')),
    -- Where the patch came from. 'captured' is a person at the plugin's own
    -- editor; 'nks' is a preset file this engine read.
    source        TEXT NOT NULL DEFAULT 'captured'
                  CHECK (source IN ('captured', 'nks')),
    -- The state that recalls the sound: a file under the data directory for a
    -- capture, or the preset it was read from. One of the two is always set.
    state_path    TEXT,
    preset_path   TEXT,
    state_bytes   INTEGER NOT NULL DEFAULT 0,
    library       TEXT NOT NULL DEFAULT '',
    vendor        TEXT NOT NULL DEFAULT '',
    -- What it is, for finding it among thousands: ["strings","solo","soft"].
    tags_json     TEXT NOT NULL DEFAULT '[]',
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_instruments_name ON film_instruments(name);
CREATE INDEX IF NOT EXISTS idx_instruments_library ON film_instruments(library);

-- Which instrument plays a score track.
--
-- SET NULL, never CASCADE: an instrument removed from the library must not take
-- the arrangement with it — the clips, the takes and the placement are the work.
ALTER TABLE film_music_tracks ADD COLUMN instrument_id TEXT
    REFERENCES film_instruments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_music_tracks_instrument ON film_music_tracks(instrument_id);
