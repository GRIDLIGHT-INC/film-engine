-- The style book: a director's library of shots, reusable across films.
--
-- Every other reference collection here is project_id NOT NULL — the mood
-- board, continuity refs, the story bible, marketing assets. All four answer a
-- question about ONE film. A style book is the opposite: it accumulates across
-- films and is the director's, not the project's.
--
-- Exactly one thing in this codebase already solves "save it once, reuse it
-- across every project": film_flows, where project_id IS NULL means a LIBRARY
-- flow, listed alongside a project's own. This follows it rather than
-- inventing a second mechanism.

CREATE TABLE IF NOT EXISTS film_style_book (
    id            TEXT PRIMARY KEY,

    -- NULL = the director's library, visible from every project.
    --
    -- ON DELETE SET NULL, NEVER CASCADE. A library entry authored while a
    -- project happened to be open must outlive that project; cascading would
    -- delete the director's own library as a side effect of tidying up a film.
    -- That is the film_refsheet_jobs trap from migration 067, where a missing
    -- ON DELETE action made DELETE /projects/:id fail outright on any project
    -- that had generated a reference sheet.
    project_id    TEXT REFERENCES film_projects(id) ON DELETE SET NULL,

    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',

    -- The scene card's own camera shape, so applying an entry is a merge
    -- rather than a translation. Every facet optional: "85mm, that's all I
    -- know" is a legitimate entry, and requiring a sensor would stop it being
    -- written down.
    camera_json   TEXT NOT NULL DEFAULT '{}',

    -- Free text, following ShotDeck: a director searches by the facets they
    -- already think in, and a controlled vocabulary here would be wrong within
    -- a week.
    tags          TEXT NOT NULL DEFAULT '',

    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_style_book_scope ON film_style_book(project_id, sort_order);

-- Several visuals per entry, which is the ask. A separate table because the
-- mood board's one-image-per-row shape is what forces an entry to be
-- duplicated to hold two pictures.
CREATE TABLE IF NOT EXISTS film_style_book_media (
    id            TEXT PRIMARY KEY,
    entry_id      TEXT NOT NULL REFERENCES film_style_book(id) ON DELETE CASCADE,

    -- From MEDIA_KINDS. No CHECK: migration 042 recorded that a CHECK here
    -- cannot be widened in place, and this list will grow.
    media_kind    TEXT NOT NULL DEFAULT 'image',

    -- Both, following film_mood_board, which carries asset_id AND image_path
    -- and resolves image_path first. Uploaded and generated visuals arrive
    -- differently and a single column would force one of them through a
    -- conversion that has nowhere to happen.
    asset_id      TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    file_path     TEXT NOT NULL DEFAULT '',

    note          TEXT NOT NULL DEFAULT '',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_style_book_media_entry ON film_style_book_media(entry_id, sort_order);
