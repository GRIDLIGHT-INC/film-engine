# FILM-118: Text upload and chapter selection UI

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add a new modal or page section "Convert Text to Screenplay" accessible from the screenplay page toolbar. UI flow: (1) User pastes or types source text into a large textarea, or uploads a `.txt` file via `<input type="file">` (read with `FileReader`). (2) Auto-detect chapter breaks (lines matching `/^(chapter|part)\s+\d+/i` or `---` separators or double blank lines). Display detected chapters as a selectable list with checkboxes. (3) User selects chapters to convert and optionally adds style notes. (4) On "Convert", send each selected chapter sequentially to `POST /text-to-screenplay` (show progress bar). (5) Display converted Fountain text in a preview pane (side-by-side: original on left, screenplay on right). (6) User can edit the preview. (7) "Accept & Insert" appends the converted text to the current screenplay in the editor. Handle errors per-chapter (if one fails, continue with others).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-117

## Notes

Part of the Film Engine — Full Production Pipeline epic.
