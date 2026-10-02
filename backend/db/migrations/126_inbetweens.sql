-- In-betweens between two key shots: 1A at 0 s, 1B at the end of the gap, and
-- the frames a director places between them, each directed on its own and by
-- the time ranges it falls in. The frames themselves are film_assets rows
-- (asset_type 'other', metadata.kind 'inbetween_frame'), so a regenerated frame
-- is a new version and the old one is kept.
CREATE TABLE IF NOT EXISTS film_inbetweens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    from_shot_id TEXT NOT NULL REFERENCES film_shots(id) ON DELETE CASCADE,
    to_shot_id TEXT NOT NULL REFERENCES film_shots(id) ON DELETE CASCADE,
    gap_ms INTEGER NOT NULL CHECK (gap_ms > 0),
    -- [{ at_ms, direction }], in time order; at_ms strictly inside (0, gap_ms).
    frames_json TEXT NOT NULL DEFAULT '[]',
    -- [{ id, lane, start_ms, end_ms, text }]: what happens over a stretch of time.
    ranges_json TEXT NOT NULL DEFAULT '[]',
    -- The strip as it was signed off; the clip refuses when it has changed.
    approved_fingerprint TEXT,
    approved_at TEXT,
    -- The clip made from the strip, once there is one.
    clip_asset_id TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (from_shot_id, to_shot_id),
    CHECK (from_shot_id <> to_shot_id)
);
CREATE INDEX IF NOT EXISTS idx_inbetweens_project ON film_inbetweens(project_id);
