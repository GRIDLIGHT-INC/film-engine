# FILM-051: Re-render endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Render Ledger & Reproducibility (4 tasks)
- **Size:** "video"
- **Created:** 2026-02-01

## Summary

Add `film_shot_rerender` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/re-render", post(film_shot_rerender))`. Accept optional `Json<RerenderRequest>` with `overrides: Option<RenderOverrides>` (seed, steps, guidance, prompt tweaks). Load most recent `RenderLedgerEntry` via `MetadataBackend::get_ledger_by_shot(shot_id)`. In `locked` mode: use stored params exactly (ignore overrides), route to same agent type with same model. In `creative` mode: merge overrides with stored params. Before re-rendering, create new shot version entry (FILM-088) for rollback. Dispatch to appropriate agent (ImageGen for storyboard re-render, VideoGen for video, etc.) based on which asset is being re-rendered (accept `asset_type: "storyboard"

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-088

## Notes

Part of the Film Engine — Full Production Pipeline epic.
