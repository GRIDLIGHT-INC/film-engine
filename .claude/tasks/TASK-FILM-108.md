# FILM-108: Page count estimation and page breaks

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Implement page estimation logic. Industry standard: 1 screenplay page approximately equals 1 minute of screen time. A standard page has ~55 lines of Courier 12pt. Count lines per element type: scene headings = 2 lines (heading + blank), action = ceil(charCount / 60) + 1 blank, character = 1 line, dialogue = ceil(charCount / 35) + 0 blank, parenthetical = 1 line, transition = 2 lines. Sum all lines, divide by 55 for page count. Display in toolbar: "~{N} pages (~{N} min)". Optionally render soft page break indicators in the editor — a subtle dashed line and "--- Page {N} ---" label at every 55-line boundary. Store estimated page count in `film_scripts.page_count` on save. The page break indicators should be non-editable decorative elements (CSS `pointer-events: none; user-select: none;`).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-100

## Notes

Part of the Film Engine — Full Production Pipeline epic.
