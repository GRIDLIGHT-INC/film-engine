# FILM-095: Fountain renderer — HTML output with screenplay CSS

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `backend/lib/fountain-renderer.js` (also isomorphic). Takes the parsed Fountain AST from FILM-094 and produces HTML with CSS class names per element type. Each element becomes a `<div class="sp-{type}">` (e.g., `sp-scene-heading`, `sp-action`, `sp-character`, `sp-dialogue`, `sp-parenthetical`, `sp-transition`, `sp-dual-dialogue-left`, `sp-dual-dialogue-right`, `sp-centered`, `sp-lyrics`, `sp-note`, `sp-page-break`). Title page renders as a dedicated `<div class="sp-title-page">` section. Export `renderFountainHTML(ast) -> string`. Also create the accompanying CSS as a string constant: Courier Prime / Courier New 12pt, industry margins (1.5in left, 1in right for action; 3.7in left indent for character names; 2.5in left / 2.5in right for dialogue; 3.1in left for parenthetical; transitions right-aligned). Scene headings bold + underlined. Page-break element renders as a visible `---` with page-break CSS. Dual dialogue uses side-by-side flex/grid layout.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-094

## Notes

Part of the Film Engine — Full Production Pipeline epic.
