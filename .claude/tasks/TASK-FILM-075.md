# FILM-075: Continuity checker

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** QA & Quality Gates (3 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_continuity_check` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/continuity", get(film_continuity_check))`. Query Neo4j for shot context: `MATCH (s:Shot {id: $shot_id})<-[:FOLLOWS]-(prev:Shot) RETURN prev` and `MATCH (s:Shot {id: $shot_id})-[:FOLLOWS]->(next:Shot) RETURN next`. For adjacent shots, query character appearances: `MATCH (c:FilmCharacter)-[:APPEARS_IN]->(s:Shot {id: $id}), (c)-[:WEARS]->(cos:Costume) RETURN c, cos`. Compare: characters present in current shot vs adjacent shots — warn if character appears/disappears unexpectedly. Costume consistency — warn if character wears different costume in consecutive shots without scene break. Location consistency — warn if shot location doesn't match scene's declared location. Use `state.neo4j` pool methods from `gateway/src/neo4j.rs` (pattern: `pool.ensure_connected().await`, `graph.execute(query).await`). Return `{"shot_id": "...", "warnings": [{"type": "costume_change", "character": "Alice", "detail": "Wearing blue dress in shot 12A but red in 12B"}], "adjacent_shots": {prev, next}}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
