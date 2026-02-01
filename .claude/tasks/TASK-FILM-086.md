# FILM-086: Scene breakdown / call sheet generator

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** B: Production Management (8 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_scene_breakdown` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/scenes/:scene_id/breakdown", get(film_scene_breakdown))`. Query scene details from `MetadataBackend::get_scene()`. Extract characters from scene's shots' scene cards (parse `scene_card_yaml` via `serde_yaml::from_str::<SceneCard>()`). Query Neo4j for enrichment: `MATCH (c:FilmCharacter)-[:APPEARS_IN]->(s:Shot) WHERE s.scene_id = $scene_id RETURN c` plus `MATCH (c:FilmCharacter)-[:WEARS]->(cos:Costume)` and `MATCH (s:Shot)-[:USES_PROP]->(p:Prop)` using `state.neo4j` pool (pattern from `gateway/src/neo4j.rs` `Neo4jPool::ensure_connected()` then `graph.run(query)`). Combine scene card data with graph data. Return `Json<SceneBreakdown>` with `characters: Vec<{name, costume, props}>`, `locations: Vec<{name, time_of_day}>`, `props: Vec<String>`, `sfx_notes: Vec<String>`. Add `SceneBreakdown` struct to `gateway/src/types.rs`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
