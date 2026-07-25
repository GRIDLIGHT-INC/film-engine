-- General rights register for actorless AI-film production.

CREATE TABLE IF NOT EXISTS film_rights (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    entity_type       TEXT NOT NULL DEFAULT 'asset'
                      CHECK (entity_type IN (
                          'character', 'voice', 'model', 'source', 'music',
                          'asset', 'output', 'dataset', 'other'
                      )),
    entity_id         TEXT DEFAULT '',
    subject           TEXT NOT NULL DEFAULT '',
    rights_type       TEXT NOT NULL DEFAULT 'commercial_use'
                      CHECK (rights_type IN (
                          'commercial_use', 'likeness', 'voice_clone',
                          'model_license', 'music_license', 'dataset_license',
                          'release', 'other'
                      )),
    status            TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (status IN ('unknown', 'cleared', 'restricted', 'expired', 'blocked')),
    owner             TEXT DEFAULT '',
    source            TEXT DEFAULT '',
    license_url       TEXT DEFAULT '',
    consent_reference TEXT DEFAULT '',
    territory         TEXT DEFAULT 'worldwide',
    expires_on        TEXT DEFAULT '',
    restrictions      TEXT DEFAULT '',
    notes             TEXT DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_rights_project ON film_rights(project_id, entity_type, status);
CREATE INDEX IF NOT EXISTS idx_film_rights_entity ON film_rights(entity_type, entity_id);
