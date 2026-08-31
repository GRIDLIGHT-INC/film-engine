-- A generation the host abandons is not lost.
--
-- Every async provider here returns an id the moment it accepts a job, and
-- until now that id lived only in a local variable inside the poll loop. So a
-- tool call torn down at the host's sixty-second abort took the only reference
-- to a job the provider was already billing for: the render finished, and the
-- result had nowhere to be delivered.
--
-- Writing the handle down BEFORE polling is the whole feature. The happy path
-- is unchanged -- the adapter still polls and still returns bytes -- and the
-- row is what makes the other path recoverable rather than lost.
--
-- ON DELETE CASCADE from the project, SET NULL from the shot and scene: a
-- deleted shot must not remove the record of money already spent, which is the
-- same reasoning film_assets.shot_id follows.
CREATE TABLE IF NOT EXISTS film_generation_jobs (
    id           TEXT PRIMARY KEY,
    project_id   TEXT REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_id      TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    scene_id     TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    provider     TEXT NOT NULL,
    capability   TEXT NOT NULL,
    request_id   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'completed', 'failed')),
    asset_id     TEXT,
    error        TEXT,
    meta         TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    settled_at   TEXT
);

-- The question asked on every collect: what is still outstanding for this
-- project. Indexed because a run that generated a hundred shots leaves a
-- hundred settled rows behind the handful that matter.
CREATE INDEX IF NOT EXISTS idx_generation_jobs_open
    ON film_generation_jobs(project_id, status);

-- One row per provider request. A retry that re-submits gets its own id; the
-- same id recorded twice is the same job, and counting it twice would offer a
-- collect that has already happened.
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_request
    ON film_generation_jobs(provider, request_id);
