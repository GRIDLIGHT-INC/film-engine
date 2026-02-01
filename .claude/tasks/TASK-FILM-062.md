# FILM-062: ProRes 422 LT / DNxHR LB encoding

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** NLE Export & Integration (6 tasks)
- **Size:** "dnxhr"
- **Created:** 2026-02-01

## Summary

Add `film_encode` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/encode", post(film_encode))`. Accept `{"codec": "prores"

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
