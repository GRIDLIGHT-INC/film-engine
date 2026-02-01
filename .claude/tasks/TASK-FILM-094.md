# FILM-094: Fountain format parser — shared JavaScript library

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Create `backend/lib/fountain-parser.js` as an isomorphic (Node + browser) module. Parse Fountain markup into a structured AST (array of typed element objects). Support all Fountain spec element types: Title Page (key/value pairs), Scene Heading (INT./EXT. with forced `.` prefix), Action, Character (ALL CAPS, forced `@` prefix), Dialogue, Parenthetical, Transition (forced `>` prefix), Dual Dialogue (`^` suffix on character), Centered Text (`> text <`), Lyrics (`~` prefix), Page Break (`===`), Section headers (`#`/`##`/`###`), Synopsis (`= text`), Notes (`[[text]]`), Boneyard (`/*...*/`). Each parsed element: `{ type, text, depth?, scene_number?, dual?, meta? }`. The parser should handle both strict and liberal Fountain (e.g., recognize `CUT TO:` as transition even without `>`). Export `parseFountain(text) -> { title_page, elements }` and `toFountain(elements) -> string` (round-trip). Include scene heading auto-numbering. Also include `analyzeScreenplay(ast)` function for local statistics: total word count, dialogue word count, action word count, dialogue percentage, average scene length (in lines), longest scene, shortest scene, character dialogue distribution (words per character), scene count by INT vs EXT, scene count by time of day. The module should work with `require()` in Node and as an inline `<script>` in the browser by detecting `typeof module`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

None

## Notes

Part of the Film Engine — Full Production Pipeline epic.
