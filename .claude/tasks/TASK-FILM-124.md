# FILM-124: Scene cards from screenplay — direct shot planning integration

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

After scenes are synced from the screenplay, automatically make them available for shot planning. In the frontend, when navigating from the Screenplay page to the Scenes page, the newly synced scenes should appear with accurate character and location data. Add a "Break Down Scene" button on each scene card in the Scenes view that calls the existing `POST /film/projects/:id/breakdown` endpoint with `{ scene_id }`. Add a "Break Down All New Scenes" button that calls breakdown with `{ all_scenes: true }` for any scenes still in `written` status. Show the relationship in the UI: on the screenplay page, each scene heading in the editor gets a small icon indicating its breakdown status (checkmark for broken_down, clock for pending). This uses the scene status data from `film_scenes` synced via FILM-120.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-120

## Notes

Part of the Film Engine — Full Production Pipeline epic.
