-- Things that are true of the person using the app, not of one project.
--
-- The screenplay's author was a free-text field on every title page, retyped
-- per project and per draft, and blank whenever somebody forgot. It is not a
-- property of a screenplay; it is a property of whoever is writing them here,
-- and it is the same answer every time.
--
-- A key/value table rather than columns on a settings row: there is exactly one
-- setting today, and inventing a wide table for it would be guessing at the
-- next four. Keys are namespaced strings so the guess is never needed.
--
-- Deliberately NOT per project. An author who has to set their own name once
-- per project will get it wrong on the project they cared least about, which is
-- the one that ends up being sent somewhere.

CREATE TABLE IF NOT EXISTS film_app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
