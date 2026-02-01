# FILM-121: Character and location suggestion from screenplay content

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

After screenplay-to-scene sync, analyze the extracted data for entity suggestions. Collect all character names from character cues in the Fountain AST. Compare against existing `film_characters` for the project. For each unrecognized character name, generate a suggestion: `{ name, mention_count, first_scene, suggested_action: 'create' }`. Similarly for locations: collect all locations from scene headings, compare against `film_locations`, suggest creating new ones. Add endpoint `GET /film/projects/:id/screenplay/suggestions` that returns `{ unmatched_characters: [...], unmatched_locations: [...] }`. In the frontend, show a notification badge on the screenplay page: "3 new characters detected" / "2 new locations detected". Clicking opens a suggestions panel where the user can bulk-create characters/locations with one click ("Create All" button that POSTs to existing character/location creation endpoints).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-120

## Notes

Part of the Film Engine — Full Production Pipeline epic.
