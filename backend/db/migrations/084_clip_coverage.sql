-- ONE CLIP, SEVERAL SHOTS.
--
-- An asset belonged to exactly one shot, so a video generated to contain 1A,
-- 1B and 1C could not say so. Playback held each of those shots for its card's
-- duration and showed the storyboard frames of moments the viewer had just
-- watched, and the conform reported 1B and 1C as missing footage.
--
-- A join table rather than a JSON column on film_assets: "is this shot
-- covered" becomes an indexed lookup instead of a scan over every asset, the
-- cascades below do the right thing without cleanup code anyone has to
-- remember, and the run keeps an explicit position.
CREATE TABLE IF NOT EXISTS film_clip_coverage (
    asset_id   TEXT NOT NULL REFERENCES film_assets(id) ON DELETE CASCADE,
    shot_id    TEXT NOT NULL REFERENCES film_shots(id)  ON DELETE CASCADE,
    -- Where this shot falls inside the clip. 0 is the lead: the shot the clip
    -- is attached to, and the position the clip is laid down at.
    position   INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (asset_id, shot_id)
);

-- A shot can be inside at most ONE clip. Two clips both claiming to contain 1B
-- is a timeline with no answer to "what plays here", and the failure would be
-- silent: whichever row came back first would win.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clip_coverage_shot ON film_clip_coverage(shot_id);
CREATE INDEX IF NOT EXISTS idx_clip_coverage_asset ON film_clip_coverage(asset_id);
