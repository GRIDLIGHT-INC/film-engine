# FILM-117: Text-to-screenplay conversion endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add route `POST /film/projects/:id/text-to-screenplay` in a new `backend/routes/text-convert.js`. Accepts `{ text, chapter_title?, style_notes? }` where `text` is prose/novel text (up to 10,000 characters per request). The handler constructs a system prompt instructing the AI to convert prose into Fountain-formatted screenplay: identify dialogue and format as Character/Dialogue, convert narrative descriptions into Action lines, infer scene headings from location changes in the text, preserve the original story beats. Include project context (existing characters, locations) so the AI uses consistent names. The response is raw Fountain text. The handler validates the output (must contain at least one scene heading) and returns `{ fountain_text, scenes_detected, characters_detected, validation }`. Register route in `server.js`. Also add `POST /film/projects/:id/text-to-screenplay/preview` that returns the conversion without saving — for user review.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-094, FILM-112

## Notes

Part of the Film Engine — Full Production Pipeline epic.
