# FILM-128: Title page editor

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add a "Title Page" button in the screenplay toolbar. Opens a modal with form fields for the standard Fountain title page keys: `Title`, `Credit` (e.g., "Written by"), `Author`, `Source` (e.g., "Based on..."), `Draft date`, `Contact`, `Copyright`, `Notes`. Pre-populate from the current script's `title_page_json` field and from the project's metadata (title, logline). On save, serialize to Fountain title page format (key/value pairs at the top of the document, separated by blank line from content). Update the `title_page_json` field in the DB. The title page is rendered at the top of the screenplay editor as a centered, formatted block (title in larger font, author below, draft date, contact info at bottom — mimicking standard title page layout). The title page section should be non-editable in the main editor (edit only via the modal).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-097

## Notes

Part of the Film Engine — Full Production Pipeline epic.
