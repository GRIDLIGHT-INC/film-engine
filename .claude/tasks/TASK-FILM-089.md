# FILM-089: Production board component (desktop)

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** B: Production Management (8 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Create `desktop/src/FilmProductionBoard.tsx` React component. Use existing UI patterns from `desktop/src/components/ui/` (`Checkbox.tsx`, `ScrollArea.tsx`). Fetch project data via Tauri `invoke("film_get_dashboard", { projectId })` command (requires FILM-069 Tauri commands). Render Kanban-style board with columns per `FilmShotStatus`: `Written` → `Storyboarded` → `Generated` → `PostProcessed` → `Approved`. Each card shows shot thumbnail (loaded from `/data/film/` path via Tauri `convertFileSrc()`), shot code, scene number, duration. Implement drag-and-drop via `@dnd-kit/core` (add to `desktop/package.json`). Group shots by scene with collapsible headers. Color-code cards by department completion (green = all done, yellow = partial, red = failed). Add to desktop navigation: import in `desktop/src/App.tsx` alongside existing `AppsPage`, `ModelsPage`, `MonitorPage`, add `"film"` to `TabId` union type (line ~37) and `TAB_ORDER` array (line ~49). Style with existing Tailwind design tokens and `GRADIENT_CLASS` pattern.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-069

## Notes

Part of the Film Engine — Full Production Pipeline epic.
