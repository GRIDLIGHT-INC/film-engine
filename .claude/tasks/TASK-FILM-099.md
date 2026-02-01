# FILM-099: Screenplay editor contenteditable shell and page layout

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Replace the existing `page-screenplay` section in `src/index.html` (currently lines 888-903 with a plain textarea). Build a new screenplay editor layout with three panels: a left toolbar panel (element type selector, scene navigator toggle), the main editor area (a `contenteditable="true"` div styled to look like a screenplay page — white background `#fff`, black text, Courier 12pt, US Letter aspect ratio with proper margins), and a right sidebar area (reserved for AI chat panel in later tasks). The editor div (`#screenplayEditor`) receives a class `screenplay-page` with CSS: `width: 8.5in; max-width: 100%; min-height: 11in; margin: 0 auto; padding: 1in 1in 1in 1.5in; font-family: 'Courier Prime', 'Courier New', monospace; font-size: 12pt; line-height: 1; background: #fff; color: #111; border: 1px solid var(--border);`. Wrap the editor in a scrollable container. Add a screenplay toolbar above the editor with: element type dropdown, bold/italic/underline toggles, scene number display, page/word count display, and a save button. Load the latest Fountain content on page navigation via `GET /film/projects/:id/script/latest/fountain` and render it into the contenteditable div using the Fountain renderer from FILM-095. Keep the old upload textarea available as a collapsible "Import Text" section below the editor.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-095, FILM-097

## Notes

Part of the Film Engine — Full Production Pipeline epic.
