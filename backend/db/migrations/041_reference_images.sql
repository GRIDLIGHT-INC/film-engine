-- Reference image generation job tracking for locations
CREATE TABLE IF NOT EXISTS film_location_image_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id),
    location_id TEXT NOT NULL REFERENCES film_locations(id),
    status TEXT NOT NULL DEFAULT 'pending',
    model TEXT DEFAULT 'sdxl',
    seed INTEGER,
    output_path TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Reference image generation job tracking for props
CREATE TABLE IF NOT EXISTS film_prop_image_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES film_projects(id),
    prop_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    model TEXT DEFAULT 'sdxl',
    seed INTEGER,
    output_path TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
