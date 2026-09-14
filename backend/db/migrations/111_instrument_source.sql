-- Where a sound came from, so it can be recognised later.
--
-- "You should dynamically have the library name and the patch name when we load
-- it into Film Engine so I know the source of the file in the future."
--
-- A captured patch is compressed binary with no name in it, so the name comes
-- from Kontakt's own catalogue (komplete.db3, read live and never copied): the
-- row records which sound it is and the file NI has for it.
ALTER TABLE film_instruments ADD COLUMN source_ref TEXT;    -- e.g. 'kontakt:1423'
ALTER TABLE film_instruments ADD COLUMN source_file TEXT;   -- the .nki/.nksn the sound lives in
