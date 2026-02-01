# FILM-016: Neo4j continuity graph: film nodes

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Character & Asset Registry (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

In `gateway/src/neo4j.rs`, add methods to `Neo4jPool`: `create_film_character_node(&self, id: &str, name: &str, project_id: &str) -> Result<()>` using Cypher `MERGE (c:FilmCharacter {id: $id}) SET c.name = $name, c.project_id = $project_id`. Add `create_shot_node`, `create_location_node`, `create_costume_node`, `create_prop_node`. Add relationship methods: `link_character_to_shot(character_id, shot_id)` using `MATCH (c:FilmCharacter {id: $cid}), (s:Shot {id: $sid}) MERGE (c)-[:APPEARS_IN]->(s)`. Similarly for `WEARS`, `SET_IN`, `USES_PROP`, `FOLLOWS`, `HAS_VOICE`. Use `state.neo4j.as_ref()` pattern from existing `neo4j.rs` methods (e.g., `store_entity` at line ~200). Call graph writes from shot creation handler (FILM-008): after inserting shot into PostgreSQL, parse scene card for characters/locations/props and write corresponding Neo4j nodes + relationships via `tokio::spawn`. Add `query_shot_continuity(shot_id: &str) -> Result<ContinuityContext>` returning adjacent shots' characters, costumes, locations for consistency checking.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-008

## Notes

Part of the Film Engine — Full Production Pipeline epic.
