-- FILM-129: Screenplay revision tracking
-- Adds revision tracking with colored page indicators

-- Add revisions column to film_scripts (JSON array of revision records)
-- Each revision: { revision_number, color, date, pages_changed }
ALTER TABLE film_scripts ADD COLUMN revisions TEXT DEFAULT '[]';

-- Revision number for this script version (NULL = not a revision, just a draft)
ALTER TABLE film_scripts ADD COLUMN revision_number INTEGER DEFAULT NULL;

-- Revision color for this script version
ALTER TABLE film_scripts ADD COLUMN revision_color TEXT DEFAULT NULL
    CHECK (revision_color IS NULL OR revision_color IN (
        'white', 'blue', 'pink', 'yellow', 'green',
        'goldenrod', 'buff', 'salmon', 'cherry'
    ));

-- Date when this revision was marked
ALTER TABLE film_scripts ADD COLUMN revision_date TEXT DEFAULT NULL;

-- Pages that changed in this revision (JSON array of page numbers)
ALTER TABLE film_scripts ADD COLUMN revision_pages_changed TEXT DEFAULT '[]';
