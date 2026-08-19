-- The board carries specs, not just words.
--
-- Every technical choice on it was free text, so a lens picked here could reach
-- a prompt string and nothing else — not previs, which solves framing from a
-- real focal length, and not the project settings, which decide what is
-- actually delivered. A spec that lands nowhere is decoration.
--
-- Two columns rather than a JSON blob: these are queried ("what lens is this
-- film shot on") and validated against a registry, and a blob makes both
-- awkward for no gain.

ALTER TABLE film_mood_board ADD COLUMN spec_kind  TEXT DEFAULT NULL;
ALTER TABLE film_mood_board ADD COLUMN spec_value TEXT DEFAULT NULL;
