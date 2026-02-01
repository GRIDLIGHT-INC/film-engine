# FILM-119: Bulk text conversion with progress tracking

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Enhance the text-to-screenplay conversion to handle full books/long texts. When the total text exceeds 10,000 characters, auto-chunk into segments (at chapter breaks or ~8,000 character boundaries at sentence breaks). Process chunks sequentially with a progress indicator showing "Converting chunk {N} of {total}...". Between chunks, include the last 500 characters of the previous chunk's output as context overlap so the AI maintains story continuity. Aggregate all converted Fountain chunks into a single document. Add a "Convert Full Document" button that processes the entire uploaded text. Display estimated conversion time based on chunk count. Allow cancellation mid-conversion (abort the fetch and stop processing remaining chunks).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-118

## Notes

Part of the Film Engine — Full Production Pipeline epic.
