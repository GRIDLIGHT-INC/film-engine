-- Treatment and screenplay analysis.
--
-- A TREATMENT is what a writer produces before the screenplay: prose that
-- states what happens, in order, without dialogue or format. It is stored here
-- rather than as a film_scripts row because it is not a screenplay — the
-- Fountain parser would read its paragraphs as action and manufacture scenes
-- from nothing, and every report built on scene presence would then describe a
-- document that has no scenes.
--
-- Versioned for the same reason screenplays are: a treatment is rewritten, and
-- the draft you replaced is the one you sometimes want back.
CREATE TABLE IF NOT EXISTS film_treatments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_treatments_project ON film_treatments(project_id, version DESC);

-- An ANALYSIS is what a reader concluded, stored as the four layers.
--
-- `script_id` records WHICH draft was read, and it is ON DELETE SET NULL rather
-- than CASCADE: an analysis of a draft outlives that draft, and a report whose
-- own subject has been superseded is exactly the one a writer wants to compare
-- against. NULL means the draft it was written against is gone, which the
-- report says rather than hiding.
--
-- `analyst` records who read it — a model name, or a person. A note carries a
-- confidence, and confidence means something different depending on who is
-- claiming it.
CREATE TABLE IF NOT EXISTS film_screenplay_analyses (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    script_id TEXT REFERENCES film_scripts(id) ON DELETE SET NULL,
    script_version INTEGER,
    analyst TEXT,
    map_json TEXT NOT NULL DEFAULT '{}',
    observations_json TEXT NOT NULL DEFAULT '[]',
    questions_json TEXT NOT NULL DEFAULT '[]',
    opportunities_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analyses_project ON film_screenplay_analyses(project_id, created_at DESC);
