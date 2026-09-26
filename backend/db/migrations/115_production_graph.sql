-- THE PRODUCTION GRAPH: what plays, how shots join, and where the nodes sit.
--
-- The graph replaces eight production pages with one, and four facts it needs
-- had nowhere to live.
--
-- 1. WHICH VIDEO IS THE ONE THAT PLAYS. A frame already has a pointer
--    (film_shots.current_frame_version). A clip had none: playback took the
--    best clip TYPE, so a second generation could not be chosen over the first
--    and "select this version" would have changed nothing on screen. SET NULL,
--    because deleting a clip must leave the shot falling back to the ordinary
--    rule rather than refusing the delete.
ALTER TABLE film_shots ADD COLUMN selected_video_asset_id TEXT
    REFERENCES film_assets(id) ON DELETE SET NULL;

-- A sequence's own clip — the stitched master, a native multi-shot clip, or an
-- upload — is a version of the SEQUENCE, and it plays once across its members.
ALTER TABLE film_sequences ADD COLUMN selected_video_asset_id TEXT
    REFERENCES film_assets(id) ON DELETE SET NULL;

-- 2. HOW ONE SHOT BECOMES THE NEXT. One entry per adjacent pair, in shot order:
--    { "type": "cut" | "continuous" | "dissolve" | "match_cut" | "whip_pan" | "morph",
--      "prompt": "how A becomes B" }.
--    An empty list reads as every join continuous, which is what a sequence did
--    before joins existed, so every sequence that exists plans exactly as it did.
ALTER TABLE film_sequences ADD COLUMN joins_json TEXT NOT NULL DEFAULT '[]';

-- 3. A FRAME BORROWED FROM ANOTHER SEQUENCE. { "sequence_id", "mode":
--    "shot_image" | "video_last_frame", "shot_id"? }. A reference, never
--    membership: a shot belongs to one sequence and is never played twice.
--    `link_fingerprint` is what the linked frames resolved to when this
--    sequence last generated, so a changed source version reads as stale.
ALTER TABLE film_sequences ADD COLUMN start_frame_ref TEXT;
ALTER TABLE film_sequences ADD COLUMN end_frame_ref TEXT;
ALTER TABLE film_sequences ADD COLUMN link_fingerprint TEXT;

-- A sound node wired to a sequence scores that sequence's span. A cue already
-- carries shot_id and scene_id; the sequence is the missing third parent.
ALTER TABLE film_music_cues ADD COLUMN sequence_id TEXT
    REFERENCES film_sequences(id) ON DELETE SET NULL;

-- 4. WHERE EACH NODE SITS. Placed automatically from the shot list; a node a
--    person dragged is pinned and "Tidy layout" leaves it alone.
--    node_key: shot:<id> | seq:<id> | sound:<id> | ver:<id> | link:<seq>:start|end
CREATE TABLE IF NOT EXISTS production_node_layout (
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    node_key   TEXT NOT NULL,
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    pinned     INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, node_key)
);
