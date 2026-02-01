# FILM-116: AI-powered screenplay statistics and suggestions

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add a "Script Analysis" action in the AI chat panel. When triggered, the handler sends the full screenplay Fountain text through `/chat/intelligent` with a system prompt requesting analysis: pacing assessment, dialogue-to-action ratio commentary, character voice distinctiveness, scene length distribution, potential plot holes or loose threads, and formatting suggestions. The response is displayed as a structured report in the chat panel with sections. Also implement a non-AI local analysis function `analyzeScreenplay(ast)` in `fountain-parser.js` that computes: total word count, dialogue word count, action word count, dialogue percentage, average scene length (in lines), longest scene, shortest scene, character dialogue distribution (words per character), scene count by INT vs EXT, scene count by time of day. Display these statistics in a "Script Stats" card below the editor (collapsible).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-112, FILM-094

## Notes

Part of the Film Engine — Full Production Pipeline epic.
