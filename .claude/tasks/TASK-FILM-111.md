# FILM-111: AI chat panel — sidebar UI alongside editor

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add a collapsible right-side panel to the screenplay editor layout (toggled by a button or `Ctrl/Cmd+Shift+A`). The panel contains: a conversation history area (scrollable div showing user and AI messages), an input textarea at the bottom with a Send button, and a mode selector dropdown (Brainstorm, Write Scene, Rewrite, Convert). Style the panel to match the app's dark aesthetic (it sits next to the white screenplay page). Messages are rendered as chat bubbles: user messages right-aligned with accent background, AI responses left-aligned with surface background. AI responses that contain Fountain-formatted text should be rendered with screenplay CSS (miniature preview). Add an "Insert into Editor" button on AI responses that contain screenplay content — clicking it appends or replaces content at the cursor position in the editor. The conversation state is stored in `state.aiChat` (array of message objects) and persists per-project in localStorage.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-099

## Notes

Part of the Film Engine — Full Production Pipeline epic.
