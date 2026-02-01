# FILM-110: Cursor-aware element type indicator and toolbar state

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Keep the toolbar's element type dropdown synchronized with the cursor's current position. On `selectionchange` event, determine which editor block the cursor is in (walk `window.getSelection().anchorNode` up to find the parent `[data-element-type]` div). Update the toolbar dropdown to show the current element type. Also update the scene number display to show which scene the cursor is in. Highlight the corresponding entry in the scene navigator panel. Show character count for the current block in the status area. If the cursor is in a dialogue block, show the speaking character's name in the toolbar.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-100

## Notes

Part of the Film Engine — Full Production Pipeline epic.
