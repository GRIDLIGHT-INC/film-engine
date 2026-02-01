# FILM-100: Element type management in contenteditable

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Implement the core contenteditable block model. Each line/paragraph in the editor is a `<div>` with a `data-element-type` attribute (`scene-heading`, `action`, `character`, `dialogue`, `parenthetical`, `transition`, `dual-dialogue`, `centered`, `lyrics`, `note`). Default type is `action`. When the user changes the element type (via dropdown or keyboard shortcut), update `data-element-type` on the current block and apply the corresponding CSS class (margin, indent, text-transform per FILM-095 CSS). Implement type-specific styling: scene headings get `text-transform: uppercase; font-weight: bold;`; character names get `text-transform: uppercase; margin-left: 2.2in;`; dialogue gets `margin-left: 1in; margin-right: 1.5in;`; parenthetical gets `margin-left: 1.6in; margin-right: 2in;`; transitions get `text-align: right;`. On Enter key: if the current block is empty, cycle back to `action` type; if non-empty, create a new block with the auto-next type (see FILM-101). On Tab key: cycle element type forward (Action -> Character -> Dialogue -> Action). Maintain cursor position during type changes.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-099

## Notes

Part of the Film Engine — Full Production Pipeline epic.
