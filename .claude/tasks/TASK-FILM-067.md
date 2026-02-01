# FILM-067: Storyboard viewer component

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Desktop App Integration (5 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `desktop/src/components/film/StoryboardViewer.tsx`. Fetch storyboard data via `invoke("film_get_storyboard", { projectId })`. Render as horizontal strip of storyboard frames with consistent height and variable width (preserving aspect ratio). Each frame shows: thumbnail image, shot code overlay, duration label, truncated dialogue text below. Click frame to show full scene card details in slide-out panel. Add "Regenerate" button per frame calling `invoke("film_regenerate_storyboard", { shotId })` with loading spinner during generation. Use `desktop/src/components/ui/ScrollArea.tsx` for horizontal scrolling. Add keyboard navigation: left/right arrows move between frames. Full-width layout within FilmPage content area.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
