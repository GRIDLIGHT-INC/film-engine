# FILM-122: Bidirectional metadata sync — characters/locations to screenplay

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

When a character is renamed in `film_characters` (via `PUT /film/characters/:id`), propagate the name change into the screenplay. In the character update handler, if `name` changed, find all occurrences of the old name in the latest screenplay's Fountain content (character cues only — lines that are the old name in ALL CAPS). Replace with the new name. Save as a new script version with note "Auto-renamed {old} to {new}". Same for location renames in scene headings. Add a `propagate_to_screenplay: true/false` flag to the update endpoints (default `true`). In the frontend, show a confirmation dialog: "Rename 'BOB' to 'ROBERT' in 7 places in the screenplay?" before proceeding. This ensures the screenplay stays consistent when metadata entities change.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-121

## Notes

Part of the Film Engine — Full Production Pipeline epic.
