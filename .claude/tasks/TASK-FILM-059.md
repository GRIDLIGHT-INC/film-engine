# FILM-059: FCPXML export generator

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** NLE Export & Integration (6 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Create `gateway/src/film_export.rs` module. Add `mod film_export;` to `gateway/src/main.rs`. Implement `generate_fcpxml(project: &FilmProject, shots: &[FilmShot], assets: &[FilmAsset]) -> String`. Build valid FCPXML 1.11 XML: `<fcpxml version="1.11">` → `<resources>` (define `<format>`, `<asset>` per media file with `src` pointing to exported media paths) → `<library>` → `<event>` → `<project>` → `<sequence>` → `<spine>` with `<clip>` per shot ordered by scene/shot. Include `<marker>` elements for dialogue cues (from scene card), camera movements, and scene boundaries. Set `duration` per clip from shot `duration_ms`. Audio tracks: separate `<lane>` for dialogue, music, SFX. Use `quick-xml = "0.36"` crate for XML generation (add to `gateway/Cargo.toml`). Write output to `/data/film/projects/{pid}/export/timeline.fcpxml`. Add `film_export_fcpxml` handler in `gateway/src/handlers.rs`, route: `.route("/film/projects/:project_id/export/fcpxml", get(film_export_fcpxml))`. Return `Content-Type: application/xml`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
