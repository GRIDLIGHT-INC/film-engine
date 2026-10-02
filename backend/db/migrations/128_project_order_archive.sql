-- The project list: an order a person sets by dragging, and an archive that hides
-- a project without deleting anything in it. NULL sort_order sorts after every
-- placed project, newest first; NULL archived_at means on the list.
ALTER TABLE film_projects ADD COLUMN sort_order INTEGER DEFAULT NULL;
ALTER TABLE film_projects ADD COLUMN archived_at TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_archived_order ON film_projects(archived_at, sort_order);
