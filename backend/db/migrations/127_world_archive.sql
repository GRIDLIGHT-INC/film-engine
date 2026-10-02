-- Hide superseded sets without deleting versions, geometry or provenance.
ALTER TABLE film_worlds ADD COLUMN archived_at TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_worlds_archive ON film_worlds(project_id, archived_at);
