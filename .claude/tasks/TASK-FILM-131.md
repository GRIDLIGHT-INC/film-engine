# FILM-131: FDX file upload UI with drag-and-drop

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add a "Import Final Draft" button in the screenplay toolbar or in the "Import Text" collapsible section. Opens a modal with a drag-and-drop zone (styled as a dashed border area with an icon). Accept `.fdx` files via both `<input type="file" accept=".fdx,.xml">` and drag-and-drop (`dragenter`, `dragleave`, `drop` events). On file drop/select, read the file content with `FileReader.readAsText()`, send to `POST /film/projects/:id/script/import-fdx` with `{ fdx_content }`. Display a progress indicator during upload and conversion. On success, show a summary: "Imported {N} scenes, {N} characters detected, {N} pages". Load the converted Fountain content into the editor. Show any warnings (e.g., unsupported FDX features that were skipped). Also support importing `.fountain` files directly (just load the text into the editor and trigger save).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-098

## Notes

Part of the Film Engine — Full Production Pipeline epic.
