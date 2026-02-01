# FILM-065: Film production page (`FilmPage.tsx`)

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Desktop App Integration (5 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Create `desktop/src/FilmPage.tsx` as a new top-level page. Add `"film"` to `TabId` union type in `desktop/src/App.tsx` (line ~37) and to `TAB_ORDER` array (line ~49). Add film icon tab button alongside existing Start, Apps, Models, Monitor, Settings tabs. FilmPage layout: left sidebar with project list (fetched via `invoke("film_list_projects")`), main content area showing selected project detail. Project detail view: header with title/logline/status badge, tabbed sections for Script, Scenes, Characters, Locations, Shot Board, Storyboard, Export. Use existing layout patterns from `desktop/src/AppsPage.tsx` (sidebar + content). Add "New Project" button using `GRADIENT_CLASS` style (line ~42). Use `useSettingsStore` for gateway URL. Style with Tailwind matching existing design tokens. Add loading states with existing spinner pattern.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
