# FILM-103: Character name autocomplete from project characters

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

When the user is typing in a `character` element type block, show an autocomplete dropdown with matching character names from the project's `film_characters` table. On the editor's `input` event, if the current block is type `character`, extract the partial text and filter `state.characters` (loaded from `GET /film/projects/:id/characters`). Render a floating dropdown positioned below the cursor using `window.getSelection().getRangeAt(0).getBoundingClientRect()`. Navigate with arrow keys, select with Enter or Tab. On selection, replace the block text with the chosen character name (in ALL CAPS). Also collect character names that appear in the screenplay but do not exist in `film_characters` — display these as "unrecognized" in a different color, and offer a "Create Character" action from the dropdown. Same pattern for location autocomplete on `scene-heading` type blocks: match against `state.locations` after the `INT./EXT.` prefix.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-100

## Notes

Part of the Film Engine — Full Production Pipeline epic.
