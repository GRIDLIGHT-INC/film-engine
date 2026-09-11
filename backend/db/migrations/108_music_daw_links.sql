-- MUS-016: stable external ids for DAW round trips.
--
-- A Film Engine key (fe:track:<id>, fe:clip:<id> …) maps to exactly one item
-- in a given DAW adapter's session, for good: the second push updates what
-- the first created instead of making a duplicate, and a DAW item maps back
-- to exactly one Film Engine row. Both directions are UNIQUE per session and
-- adapter. `revision` is the DAW's own revision of the item as Film Engine
-- last saw it after an acknowledged write — a different revision on the next
-- read means somebody changed it in the DAW, which is a conflict to report,
-- never to overwrite silently. CASCADE: a link means nothing without its
-- session.
CREATE TABLE IF NOT EXISTS film_music_daw_links (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES film_music_sessions(id) ON DELETE CASCADE,
    adapter_id   TEXT NOT NULL,
    fe_key       TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'track'
                 CHECK (kind IN ('session', 'group', 'track', 'clip', 'marker')),
    external_id  TEXT NOT NULL,
    revision     TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (session_id, adapter_id, fe_key),
    UNIQUE (session_id, adapter_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_film_music_daw_links_session ON film_music_daw_links(session_id, adapter_id);
