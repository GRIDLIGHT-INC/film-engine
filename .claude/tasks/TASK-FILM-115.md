# FILM-115: AI screenplay chat — context-aware conversation endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Extend `backend/routes/screenplay-ai.js` to support full conversation context. The endpoint accepts `conversation_history` as an array of `{ role, content }` messages. Truncate history to the last 20 messages or ~8000 tokens to stay within context limits. The system prompt always includes the current project context (auto-refreshed from DB on each request). Add a "Current Scene" context mode: when enabled, include the Fountain text of the scene the cursor is currently in (extracted by the frontend from the editor, sent as `current_scene_fountain` in the request body). This allows the AI to answer questions like "What if Bob reacts differently here?" with awareness of the actual screenplay content. Add SSE streaming support (similar to `breakdown/stream`): route `POST /film/projects/:id/screenplay-ai/stream` that proxies the `/chat/intelligent` stream and relays chunks as SSE events to the frontend.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-112

## Notes

Part of the Film Engine — Full Production Pipeline epic.
