# FILM-087: Production timeline / milestone tracker

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** B: Production Management (8 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs`: `CREATE TABLE IF NOT EXISTS film_milestones (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES film_projects(id), title TEXT NOT NULL, phase TEXT NOT NULL, target_date TEXT, actual_date TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))`. Add `FilmMilestone` struct to `gateway/src/database.rs`. Implement `MetadataBackend` trait methods: `create_milestone`, `get_milestones_by_project`, `update_milestone`. On project creation (FILM-001 handler), auto-create one milestone per phase (`Script`, `Pre-Production`, `Storyboard`, `Production`, `Post-Production`, `Review`, `Export`) using `MetadataBackend::create_milestone()`. Add `film_timeline` and `film_milestone_create` handlers in `gateway/src/handlers.rs`. Register routes: `.route("/film/projects/:project_id/timeline", get(film_timeline).post(film_milestone_create))` and `.route("/film/milestones/:milestone_id", put(film_milestone_update))`. `film_timeline` returns milestones with `completion_pct` calculated from child task statuses. Return `Json<Vec<FilmMilestone>>` sorted by phase order.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-001

## Notes

Part of the Film Engine — Full Production Pipeline epic.
