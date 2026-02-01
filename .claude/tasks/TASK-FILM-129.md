# FILM-129: Revision tracking with colored page indicators

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Implement revision tracking. Add a `revisions` JSON column to `film_scripts` via migration `018_screenplay_revisions.sql`. Each revision record: `{ revision_number, color, date, pages_changed }`. Standard revision colors in order: White (original), Blue, Pink, Yellow, Green, Goldenrod, Buff, Salmon, Cherry. When the user creates a new version and marks it as a revision (via a "Mark as Revision" toggle on save), assign the next color in sequence. In the editor, display a colored strip in the left margin for pages that changed in the current revision (compare against previous version to detect changed pages). In the scene navigator, show the revision color dot next to each scene that was modified. The revision number and color appear in the toolbar. Import FDX revisions (from FILM-098) into this same structure.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-125

## Notes

Part of the Film Engine — Full Production Pipeline epic.
