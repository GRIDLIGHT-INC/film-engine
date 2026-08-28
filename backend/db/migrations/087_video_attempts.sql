-- Every video generation attempt, so the router is built from THIS film's data.
--
-- The model leaderboard is not the question. "Which model gives me an
-- acceptable shot for the lowest expected cost, on MY shots" is, and no
-- internet benchmark answers it. Recording attempts before the next ten real
-- shots are generated turns making the film into the benchmark: no $50 of
-- synthetic experiments, and a dataset that is about the film being made.
--
-- Deliberately records the SHOT's characteristics alongside the outcome. "H3
-- accepts 78% of the time" is mildly useful; "H3 is strong on single-character
-- wide shots and weak on two-character physical interaction" is what actually
-- routes a shot, and it cannot be recovered later if the shape of the shot was
-- not written down at the time.
--
-- estimated_credits AND actual_credits, because a divergence between them is
-- itself a finding: it means the rate card has moved or the estimator is wrong
-- about references, and both are worth knowing before a big run.

CREATE TABLE IF NOT EXISTS film_video_attempts (
    id                  TEXT PRIMARY KEY,
    shot_id             TEXT REFERENCES film_shots(id) ON DELETE CASCADE,
    project_id          TEXT REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_version        INTEGER,

    provider            TEXT NOT NULL DEFAULT '',
    model               TEXT NOT NULL DEFAULT '',
    tier                TEXT NOT NULL DEFAULT '',

    duration            REAL,
    resolution          TEXT NOT NULL DEFAULT '',

    -- what was actually sent, since the reference package is the variable most
    -- likely to explain why one attempt worked and another did not
    reference_images    INTEGER NOT NULL DEFAULT 0,
    reference_videos    INTEGER NOT NULL DEFAULT 0,
    reference_audio     INTEGER NOT NULL DEFAULT 0,
    reference_roles     TEXT NOT NULL DEFAULT '',

    -- the shape of the shot, for the router to learn from
    shot_type           TEXT NOT NULL DEFAULT '',
    camera_movement     TEXT NOT NULL DEFAULT '',
    character_count     INTEGER NOT NULL DEFAULT 0,
    prop_count          INTEGER NOT NULL DEFAULT 0,

    estimated_credits   REAL,
    actual_credits      REAL,
    generation_ms       INTEGER,

    -- NULL means nobody has judged it yet, which is different from rejected
    validation_score    REAL,
    accepted            INTEGER,
    rejection_reason    TEXT NOT NULL DEFAULT '',

    attempt_number      INTEGER NOT NULL DEFAULT 1,
    asset_id            TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_video_attempts_shot ON film_video_attempts(shot_id);
CREATE INDEX IF NOT EXISTS idx_video_attempts_model ON film_video_attempts(model, accepted);
CREATE INDEX IF NOT EXISTS idx_video_attempts_project ON film_video_attempts(project_id);
