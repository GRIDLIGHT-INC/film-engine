# FILM-102: Keyboard shortcuts for element types and formatting

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add keyboard shortcut handler to the screenplay editor. Register shortcuts on the editor's `keydown` event: `Ctrl/Cmd+1` = Scene Heading, `Ctrl/Cmd+2` = Action, `Ctrl/Cmd+3` = Character, `Ctrl/Cmd+4` = Dialogue, `Ctrl/Cmd+5` = Parenthetical, `Ctrl/Cmd+6` = Transition, `Ctrl/Cmd+7` = Dual Dialogue, `Ctrl/Cmd+8` = Centered, `Ctrl/Cmd+9` = Note. Also: `Ctrl/Cmd+B` = Bold, `Ctrl/Cmd+I` = Italic, `Ctrl/Cmd+U` = Underline (these use `document.execCommand` or manual span wrapping). `Ctrl/Cmd+S` = Save (triggers auto-save to backend). `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` = Undo/Redo (handled by FILM-105). Show a keyboard shortcut help overlay toggled by `Ctrl/Cmd+/` or a `?` button in the toolbar.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-100

## Notes

Part of the Film Engine — Full Production Pipeline epic.
