# FILM-123: Screenplay content feeds breakdown pipeline

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Update `backend/routes/breakdown.js` to use Fountain-parsed screenplay data instead of raw text. When `breakdownSync` or `breakdownStream` is called and the project has a Fountain-format script, use the structured Fountain AST to build richer scene text for the AI prompt. Instead of sending raw text, format each scene with explicit element labels: `SCENE HEADING: INT. LOCATION - DAY`, `ACTION: description text`, `CHARACTER: NAME`, `DIALOGUE: lines`, `PARENTHETICAL: (wryly)`. This structured format gives the AI better context for generating scene cards. Also pass character appearance descriptions from `film_characters` and location reference prompts from `film_locations` (these may have been populated by the user or by FILM-121). Update the internal scene text formatting to accept an optional `fountainElements` parameter.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-120

## Notes

Part of the Film Engine — Full Production Pipeline epic.
