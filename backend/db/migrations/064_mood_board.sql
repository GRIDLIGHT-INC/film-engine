-- Phase 3: the board where a look is decided, before anything generates.
--
-- style_preset was a free-text column, typed once, applied to every image
-- prompt forever, and assembled from nothing. There was no surface on which a
-- look was developed, so there was no moment at which anyone could notice that
-- "…teal/amber, wet streets, mist, anatomical beast, anamorphic, grain" had a
-- creature in it — and that string then drew one into an establishing shot
-- whose scene card reads "Empty, ordinary, still."
--
-- A separate table rather than more columns on film_continuity_refs: continuity
-- refs answer "did this match what we already shot", which is a question about
-- the past. A mood board answers "what should this look like", which is a
-- question about work not yet done. Same shape, opposite direction, and
-- conflating them would make both queries lie.

CREATE TABLE IF NOT EXISTS film_mood_board (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,

    -- What facet of the look this entry speaks to. Free text rather than a
    -- CHECK: a director will want a facet nobody predicted, and a CHECK here
    -- cannot be widened in place (migration 042 recorded that lesson).
    kind        TEXT NOT NULL DEFAULT 'image',

    -- The words that will reach the style preset. This is the load-bearing
    -- column: composing a style is concatenating these.
    note        TEXT NOT NULL DEFAULT '',

    -- A reference picture, when the entry is one. Either a stored asset or a
    -- path; both are optional, because "teal shadows" is a valid entry with no
    -- picture at all.
    asset_id    TEXT DEFAULT NULL,
    image_path  TEXT NOT NULL DEFAULT '',

    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_mood_board_project ON film_mood_board(project_id);
