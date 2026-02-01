# FILM-107: Scene numbering — automatic and manual

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Implement scene numbering on scene heading elements. By default, auto-number sequentially (1, 2, 3...) based on document order. Display scene numbers in the left margin gutter of the editor (use CSS `::before` pseudo-element or an absolutely-positioned span). Add a "Lock Scene Numbers" toggle in the toolbar. When locked: scene numbers become a `data-scene-number` attribute that persists even if scenes are reordered. When unlocked: numbers auto-recalculate on each edit. Support manual override: double-click a scene number to edit it (e.g., "42A" for an inserted scene). Store scene numbers in the Fountain output using Fountain's `#N#` scene number syntax. The serializer (FILM-104) should output locked scene numbers as `INT. LOCATION - DAY #42#`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-106

## Notes

Part of the Film Engine — Full Production Pipeline epic.
