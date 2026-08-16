-- Phase 2: previs blocking becomes storable.
--
-- Where the camera stands for a shot, what it is mounted on, and the path it
-- travels. One row per shot: blocking belongs to a shot the way a scene card
-- does, and "load this shot's blocking" must not become a "which one?" question.
-- Alternates are a versioning feature, and film_shot_versions already exists if
-- that is ever wanted.

CREATE TABLE IF NOT EXISTS film_previs_blocking (
    id          TEXT PRIMARY KEY,

    -- UNIQUE, not merely indexed. The uniqueness is the modelling decision, and
    -- enforcing it in the schema means the route never has to arbitrate between
    -- two rows that should never both exist.
    shot_id     TEXT NOT NULL UNIQUE REFERENCES film_shots(id) ON DELETE CASCADE,

    -- position, rotation, focal length, sensor, stop, focus distance.
    camera_json TEXT NOT NULL DEFAULT '{}',

    -- Where the subject stands and how tall it is. Framing is solved against
    -- this, so it is data rather than an assumption baked into the solver.
    subject_json TEXT NOT NULL DEFAULT '{}',

    -- The ground plane, and later its walls. A room is where a framing distance
    -- stops being a suggestion and becomes a constraint.
    stage_json  TEXT NOT NULL DEFAULT '{}',

    -- A column rather than a field inside camera_json because it is QUERIED:
    -- "every shot in this scene that needs the crane" is the scheduling question
    -- previs makes answerable, and it should not require parsing JSON per row.
    rig         TEXT NOT NULL DEFAULT 'dolly',

    -- The scene card already names the movement; it is denormalised here so the
    -- stored path can be checked against what it was sampled from.
    movement    TEXT NOT NULL DEFAULT 'static',

    -- The movement SAMPLED TO KEYFRAMES, not the parameters it came from. Same
    -- reasoning as film_flow_runs.graph_snapshot: a path recomputed from an enum
    -- silently stops meaning anything the moment that enum's default intensity
    -- is retuned, and "recreate this shot exactly" has to survive the taxonomy
    -- changing underneath it.
    path_json   TEXT NOT NULL DEFAULT '[]',

    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The scheduling query above.
CREATE INDEX IF NOT EXISTS idx_previs_blocking_rig ON film_previs_blocking(rig);
