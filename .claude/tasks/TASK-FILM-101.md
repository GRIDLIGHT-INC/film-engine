# FILM-101: Auto-formatting rules — Tab/Enter element cycling

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Implement the auto-formatting intelligence that makes screenplay writing fluid. Define element transition rules: after `Scene Heading` + Enter -> `Action`; after `Action` + Enter on empty line -> `Action` (or `Character` if prev line was also empty); after `Character` + Enter -> `Dialogue`; after `Dialogue` + Enter -> `Character` (if line is empty, switch to `Action`); after `Parenthetical` + Enter -> `Dialogue`; after `Transition` + Enter -> `Scene Heading`. Tab key cycles through the most common types for the current context. Implement smart detection: if the user types an all-caps line that matches a known character name (from `state.characters`), auto-suggest switching to `character` type. If the user types a line starting with `INT.` or `EXT.`, auto-detect as `scene-heading`. If the user types a line ending with `:` in all caps, auto-detect as `transition`. These auto-detections happen on Enter or after a brief debounce. Store the rules in a configurable map for extensibility.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-100

## Notes

Part of the Film Engine — Full Production Pipeline epic.
