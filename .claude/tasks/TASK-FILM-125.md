# FILM-125: Screenplay version history with diff view

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Extend the script version UI. Currently, versions are listed as simple badges. Add a "Compare Versions" feature. When the user selects two versions from the version list, show a side-by-side diff view. Implement a simple line-by-line diff algorithm in the frontend: split both versions by newline, use a longest-common-subsequence algorithm to identify additions, deletions, and unchanged lines. Render additions with green background, deletions with red background. Add a "Restore Version" button that copies a previous version's Fountain content into the editor (creating a new version). Show word count delta between versions. Display version metadata: timestamp, word count, page count, scene count. Limit storage: keep all versions (no auto-pruning) but only load full content on demand (the list endpoint already returns metadata without content).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-097

## Notes

Part of the Film Engine — Full Production Pipeline epic.
