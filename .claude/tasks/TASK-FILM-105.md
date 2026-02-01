# FILM-105: Undo/redo stack for screenplay editor

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Implement a custom undo/redo system for the contenteditable editor. The browser's built-in contenteditable undo is unreliable, so maintain a manual history stack. On each meaningful edit (debounced at 500ms after input stops), snapshot the editor's `innerHTML` and cursor position (computed as a path through child nodes). Maintain `undoStack[]` (max 100 entries) and `redoStack[]`. On `Ctrl/Cmd+Z`: pop from undoStack, push current state to redoStack, restore innerHTML and cursor. On `Ctrl/Cmd+Shift+Z`: pop from redoStack, push current to undoStack, restore. Collapse consecutive single-character typing into one undo entry (by comparing timestamps — if within 500ms, update the current entry instead of pushing new). Element type changes should create their own undo entry. The undo stack is per-session (not persisted).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-104

## Notes

Part of the Film Engine — Full Production Pipeline epic.
