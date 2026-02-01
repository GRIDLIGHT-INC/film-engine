# FILM-109: Dual dialogue support

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Implement dual dialogue (two characters speaking simultaneously, rendered side-by-side). In Fountain, dual dialogue is indicated by `^` after the second character name. In the editor, when the user applies the "Dual Dialogue" element type (via `Ctrl/Cmd+7` or toolbar), the current character+dialogue block is paired with the previous character+dialogue block. Render the pair as a flex container with two columns, each 45% width. The left column contains the first character/dialogue, the right column the second. In the contenteditable, represent this as a wrapper div `<div class="sp-dual-dialogue" data-element-type="dual-dialogue">` containing two child column divs. The serializer should output the `^` suffix on the second character name in Fountain. Handle editing within dual dialogue columns (cursor navigation between left and right). Allow "un-dualing" by pressing the dual dialogue shortcut again.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-100

## Notes

Part of the Film Engine — Full Production Pipeline epic.
