# FILM-104: Editor-to-Fountain serializer and auto-save

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Implement `serializeEditorToFountain()` function that walks the contenteditable div's child `<div>` elements, reads each `data-element-type` and text content, and produces valid Fountain markup. Mapping: `scene-heading` -> `INT./EXT. ...` (preserve original or force-prefix with `.`); `character` -> ALL CAPS on own line; `dialogue` -> indented text after character; `parenthetical` -> `(text)` on own line between character and dialogue; `transition` -> `> TEXT` or `TEXT:` format; `centered` -> `> text <`; `lyrics` -> `~ text`; `note` -> `[[text]]`; `action` -> plain text with blank line separators. Handle bold (`**text**`), italic (`*text*`), underline (`_text_`) by inspecting inline `<b>`, `<i>`, `<u>` tags. Implement debounced auto-save: 3 seconds after the last edit, serialize to Fountain, send `PUT /film/projects/:id/script/:version` with `{ fountain_content }`. Show a save indicator in the toolbar ("Saved" / "Saving..." / "Unsaved changes"). Also implement `loadFountainIntoEditor(fountainText)` which parses Fountain and populates the contenteditable div with correctly typed `<div>` blocks.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-100, FILM-094

## Notes

Part of the Film Engine — Full Production Pipeline epic.
