# FILM-130: Export to PDF, Fountain, and plain text

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add an "Export" dropdown button in the screenplay toolbar with options: "Fountain (.fountain)", "Plain Text (.txt)", "PDF (.pdf)". Fountain export: use the `toFountain()` function from FILM-094 to serialize the editor content, then trigger a browser download using `Blob` + `URL.createObjectURL` + a hidden `<a>` element with `download` attribute. Plain Text export: strip Fountain markup, output just the text with proper whitespace formatting (indented dialogue, centered headers). PDF export: use the Fountain renderer (FILM-095) to generate an HTML document with print-ready CSS (`@page { size: letter; margin: 1in; }`, page breaks at `sp-page-break`), then open in a new window and call `window.print()` (which on most systems offers "Save as PDF"). Include title page as the first page. The print CSS should hide all non-screenplay UI and render the pure formatted screenplay. Ensure Courier 12pt, correct margins, and page numbers in the footer (`@bottom-center { content: counter(page); }`).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-095, FILM-128

## Notes

Part of the Film Engine — Full Production Pipeline epic.
