# FILM-127: Index card view for scene reordering

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add an "Index Cards" view mode toggle on the screenplay page. When activated, the editor is replaced by a grid of draggable index cards — one per scene. Each card shows: scene number, scene heading (INT/EXT, location, time), first 100 chars of action/description, character names present, estimated page length, and a color indicator for scene status. Cards are arranged in a CSS grid (3-4 columns). Implement drag-and-drop reordering using native HTML5 drag and drop API (`draggable="true"`, `dragstart`, `dragover`, `drop` events). When the user drops a card in a new position, reorder the scenes in the Fountain content: extract each scene's Fountain text block (from heading to next heading), rearrange them in the new order, update scene numbers, and write back to the editor. Show a "Reorder Scenes" confirmation dialog before applying. Also allow double-clicking a card to jump to that scene in the editor view.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-106, FILM-120

## Notes

Part of the Film Engine — Full Production Pipeline epic.
