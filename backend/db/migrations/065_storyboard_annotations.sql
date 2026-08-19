-- Phase 3: marking up a generated frame.
--
-- A director's fastest notation is an arrow, not a sentence. "Move her left,
-- push in past the mailbox" is three strokes and a word, and the board had no
-- way to carry any of it: pictures you could regenerate, and nothing you could
-- draw on.
--
-- Attached to the SHOT, not to the asset. A note is about the shot; the PNG is
-- one attempt at it. Keying markup to an asset id would erase the direction at
-- the moment it was acted on — regenerate the frame and lose the arrow that
-- asked for the regeneration, which is precisely backwards.

CREATE TABLE IF NOT EXISTS film_storyboard_annotations (
    id          TEXT PRIMARY KEY,
    shot_id     TEXT NOT NULL REFERENCES film_shots(id) ON DELETE CASCADE,

    kind        TEXT NOT NULL DEFAULT 'arrow',

    -- NORMALISED geometry: [[x,y], ...] with x and y in 0..1 of the frame.
    -- Never pixels. A frame regenerated at another resolution, or a board read
    -- on a phone, would otherwise move every arrow off the thing it points at.
    points_json TEXT NOT NULL DEFAULT '[]',

    text        TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#f59e0b',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_annotations_shot ON film_storyboard_annotations(shot_id);
