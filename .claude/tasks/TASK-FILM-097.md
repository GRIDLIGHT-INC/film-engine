# FILM-097: Screenplay save/load API endpoints (Fountain-aware)

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Modify `backend/routes/scripts.js`. The existing `uploadScript` function currently accepts `{ content }` as plaintext. Extend it: if body contains `fountain_content`, parse it with `parseFountain()`, store raw Fountain in `fountain_content` column, store rendered plaintext in `content` (for backward compat with existing breakdown), compute and store `page_count` (estimated at ~55 lines per page in Fountain), `scene_count`, `dialogue_percentage`, and `title_page_json`. Also bulk-insert into `film_script_elements` for element-level access. Add new endpoint `PUT /film/projects/:id/script/:version` to update an existing script version in-place (for the editor's auto-save). Add `GET /film/projects/:id/script/latest/fountain` that returns the raw Fountain content of the latest version. When `fountain_content` is provided, the scene extraction should use the Fountain parser instead of the old regex parser for more accurate results — scene headings, characters, and locations are all available from the Fountain AST.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-094, FILM-096

## Notes

Part of the Film Engine — Full Production Pipeline epic.
