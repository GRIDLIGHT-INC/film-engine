# FILM-126: Screenplay statistics dashboard

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add a "Stats" tab or collapsible section on the screenplay page. Use the local `analyzeScreenplay()` function from FILM-116 to compute and display: (1) Overview: page count, word count, scene count, estimated runtime. (2) Dialogue breakdown: pie chart (rendered as an SVG or CSS-only donut chart) showing dialogue percentage vs action. (3) Character report: table showing each character, their dialogue word count, number of scenes they appear in, percentage of total dialogue. Sort by dialogue amount. (4) Scene length distribution: bar chart (CSS bars) showing approximate page length per scene. Highlight outlier scenes (too short < 0.5 pages or too long > 5 pages). (5) INT/EXT ratio and time-of-day distribution. All data computed client-side from the Fountain AST — no backend call needed. Update stats on each editor change (debounced 2s).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-116

## Notes

Part of the Film Engine — Full Production Pipeline epic.
