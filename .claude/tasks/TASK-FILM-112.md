# FILM-112: AI brainstorm and outline generation

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Implement the "Brainstorm" mode in the AI chat panel. When the mode is set to Brainstorm, the system prompt sent to `/chat/intelligent` is configured for story development. It includes the project context: title, logline, genre, existing characters (names + descriptions), existing locations. The user can ask for: story ideas, beat sheets, three-act structure outlines, character arc suggestions, theme exploration. Create `backend/routes/screenplay-ai.js` with handler `handleScreenplayAI(req, res, parts)`. Route: `POST /film/projects/:id/screenplay-ai` with body `{ mode, message, conversation_history }`. The handler gathers project context from the DB, constructs the system prompt based on mode, prepends conversation history, and calls `${gatewayUrl}/chat/intelligent`. Return `{ response, mode }`. Register the route in `server.js`. The "Brainstorm" system prompt: "You are an experienced screenwriter and story consultant. Help the user develop their story. The project is: {title}, genre: {genre}, logline: {logline}. Known characters: {chars}. Known locations: {locs}."

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-111

## Notes

Part of the Film Engine — Full Production Pipeline epic.
