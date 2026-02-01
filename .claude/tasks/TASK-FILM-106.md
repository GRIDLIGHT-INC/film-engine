# FILM-106: Scene navigator / outline panel

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add a collapsible left panel (toggled by a button in the toolbar or `Ctrl/Cmd+Shift+O`) that shows a scene outline. Parse the current editor content to extract all scene headings with their scene numbers. Display as a scrollable list: each entry shows `#N - INT./EXT. LOCATION - TIME` and a brief character summary (first 2-3 character names found in that scene's elements). Clicking a scene entry scrolls the editor to that scene heading using `element.scrollIntoView({ behavior: 'smooth', block: 'start' })`. Highlight the current scene (the one the cursor is in) with an accent border. Update the outline on each editor change (debounced 1s). Also show the total scene count and estimated page count at the top of the panel.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-100

## Notes

Part of the Film Engine — Full Production Pipeline epic.
