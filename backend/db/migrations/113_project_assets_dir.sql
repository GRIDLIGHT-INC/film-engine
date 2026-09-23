-- WHERE A PROJECT'S FILES LIVE.
--
-- A folder the person chose, holding every file the film makes, laid out in
-- the order the film is made (lib/project-folders.js). NULL means the old
-- kind-first layout under the data directory — every project made before this
-- column existed — which keeps working unchanged until it is moved.
ALTER TABLE film_projects ADD COLUMN assets_dir TEXT;
