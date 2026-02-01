# FILM-066: Shot board component

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Desktop App Integration (5 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Create `desktop/src/components/film/ShotBoard.tsx`. Fetch shots via `invoke("film_get_shotlist", { projectId })`. Render as visual grid of shot thumbnails (load images from shot keyframe path via Tauri `convertFileSrc()`). Each card shows: thumbnail, shot code badge, status indicator (color-coded: green=complete, yellow=generating, red=failed, gray=pending), duration label. Click card to expand detail panel with scene card YAML, render ledger, version history. Add "Re-render" button per shot calling `invoke("film_rerender_shot", { shotId })`. Add "Approve" button setting shot status. Implement drag-to-reorder via HTML5 drag events (update `shot_code` ordering). Group shots by scene with collapsible `<details>` elements. Use `desktop/src/components/ui/ScrollArea.tsx` for scrollable grid. Filter by status via dropdown.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
