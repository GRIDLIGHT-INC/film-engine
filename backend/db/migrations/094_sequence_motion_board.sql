-- A reviewable image for each sampled moment of a video sequence.
-- Storyboard anchors point at their existing asset. Generated in-betweens get
-- their own reference_image asset, so replacing one frame never rewrites the
-- approved storyboard or makes an experiment look like finished footage.
CREATE TABLE IF NOT EXISTS film_sequence_frames (
    id              TEXT PRIMARY KEY,
    sequence_id     TEXT NOT NULL REFERENCES film_sequences(id) ON DELETE CASCADE,
    frame_index     INTEGER NOT NULL,
    time_ms         INTEGER NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('anchor', 'inbetween')),
    source_shot_id  TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    from_shot_id    TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    to_shot_id      TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    asset_id        TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    prompt          TEXT NOT NULL DEFAULT '',
    direction       TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'missing'
                    CHECK (status IN ('missing', 'generating', 'draft', 'approved', 'failed')),
    error_message   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sequence_id, frame_index)
);
