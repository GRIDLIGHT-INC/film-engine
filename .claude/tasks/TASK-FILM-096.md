# FILM-096: Database migration for Fountain screenplay storage

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Create `backend/db/migrations/017_screenplay_fountain.sql`. Add columns to `film_scripts` table: `format TEXT NOT NULL DEFAULT 'plaintext' CHECK (format IN ('plaintext', 'fountain', 'fdx'))`, `fountain_content TEXT DEFAULT ''` (stores raw Fountain markup separately from the existing `content` column which remains for backward compatibility), `title_page_json TEXT DEFAULT '{}'` (parsed title page as JSON), `page_count INTEGER DEFAULT 0`, `scene_count INTEGER DEFAULT 0`, `dialogue_percentage REAL DEFAULT 0`. Add new table `film_script_elements`: `id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES film_scripts(id) ON DELETE CASCADE, element_index INTEGER NOT NULL, element_type TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', scene_number INTEGER, meta TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))` with index on `(script_id, element_index)`. This table stores the parsed element-level representation for fast queries (e.g., find all dialogue for a specific character).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-094

## Notes

Part of the Film Engine — Full Production Pipeline epic.
