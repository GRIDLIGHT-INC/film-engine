# FILM-114: AI scene rewrite and improvement

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Implement the "Rewrite" mode in the AI chat panel. The user selects text in the editor (one or more blocks), then activates the Rewrite mode. The selected text is automatically sent as context. The user provides rewrite instructions (e.g., "Make the dialogue more natural", "Add more visual detail to the action lines", "Increase tension"). The system prompt includes: the original text, rewrite instructions, project context, and style constraints ("Output valid Fountain format. Preserve character names and scene heading format. Maintain the same scene structure unless asked to restructure."). The AI response appears in the chat panel with a diff-style view: red strikethrough for removed lines, green for added lines (compare original selection to AI output, line-by-line). Show "Accept Rewrite" (replaces selection in editor) and "Reject" (dismiss) buttons. Also support a "Rewrite Inline" mode where the user highlights a single dialogue line and types a quick rewrite instruction.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-113

## Notes

Part of the Film Engine — Full Production Pipeline epic.
