# FILM-113: AI scene writing — generate scenes in Fountain format

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Implement the "Write Scene" mode in the AI chat panel. The user provides a scene prompt (e.g., "Write a tense confrontation between Alice and Bob in the coffee shop") and optionally selects which characters and location from the project. The system prompt instructs the AI to output in valid Fountain format. The handler in `screenplay-ai.js` constructs: system prompt with Fountain format rules (scene heading format, character cue format, parenthetical format, etc.), project context (characters with personality notes, location details), and any preceding scenes for story continuity (pass last 2-3 scene headings and brief summaries). The AI response is validated: check that it contains at least one scene heading, character names, and dialogue. If valid Fountain, render it in the chat panel with screenplay styling and show "Insert at Cursor" / "Append to Script" / "Replace Current Scene" action buttons. On "Insert at Cursor": parse the Fountain response, create the corresponding editor blocks, and insert them at the current cursor position.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-112, FILM-094

## Notes

Part of the Film Engine — Full Production Pipeline epic.
