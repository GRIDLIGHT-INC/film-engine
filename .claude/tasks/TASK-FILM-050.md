# FILM-050: Locked vs creative generation modes

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Render Ledger & Reproducibility (4 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `generation_mode: GenerationMode` to `SceneCard` in `gateway/src/film_scene_card.rs` with enum `GenerationMode { Locked, Creative }` (default `Creative`). In `Locked` mode: freeze `seed`, `sampler`, `steps`, `guidance_scale` from the most recent render ledger entry — query `MetadataBackend::get_ledger_by_shot(shot_id)` and use last entry's params. Override any user-supplied randomization. In `Creative` mode: allow random seed (generate via `rand::thread_rng().gen::<u64>()`) but still log all params to ledger. In storyboard/video generation handlers, check `scene_card.generation_mode`: if `Locked`, load frozen params from ledger before dispatching to agent; if `Creative`, generate fresh seed. Add `rand = "0.8"` to `gateway/Cargo.toml` if not present. Add `GET /film/shots/:shot_id/render-params` handler returning latest ledger entry for inspection. Register route in `gateway/src/main.rs`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
