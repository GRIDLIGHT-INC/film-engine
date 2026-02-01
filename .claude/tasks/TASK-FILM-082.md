# FILM-082: Production status state machine

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** B: Production Management (8 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `gateway/src/film_status.rs` module. Add `mod film_status;` to `gateway/src/main.rs`. Define `FilmProjectStatus` enum: `Concept`, `Script`, `PreProduction`, `Storyboard`, `Production`, `PostProduction`, `Review`, `Export`, `Complete`. Implement `FilmProjectStatus::allowed_transitions(&self) -> Vec<FilmProjectStatus>` enforcing valid state transitions (e.g., `Script` can go to `PreProduction` but not `Complete`). Add `advance_project_status(project_id: Uuid, state: &AppState) -> Result<FilmProjectStatus>` function: query scene/shot completion counts from `MetadataBackend`, determine if current phase is complete (e.g., all scenes have status `broken_down` → advance from `Script` to `PreProduction`). Add `POST /film/projects/:project_id/status` handler in `gateway/src/handlers.rs` for manual override (accepts `{"status": "production"}`), validate transition is allowed. Register route in `gateway/src/main.rs`. Call `advance_project_status()` from shot completion handlers as a side-effect. Persist in `film_projects.status` column.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
