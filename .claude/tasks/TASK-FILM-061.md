# FILM-061: Premiere Pro XML export

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** NLE Export & Integration (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

In `gateway/src/film_export.rs`, implement `generate_premiere_xml(project: &FilmProject, shots: &[FilmShot], assets: &[FilmAsset]) -> String`. Generate Adobe Premiere-compatible XML (FCP 7 XML format, widely supported). Structure: `<xmeml version="5">` → `<sequence>` → `<media>` → `<video>` → `<track>` with `<clipitem>` per shot. Separate `<audio>` tracks for dialogue, music, SFX. Include `<marker>` elements for scene boundaries and dialogue cues. Set `<timebase>24</timebase>` and `<ntsc>FALSE</ntsc>`. Each `<file>` element references media path with `<pathurl>file:///path/to/media.mov</pathurl>`. Use `quick-xml` crate (same as FILM-059). Write to `/data/film/projects/{pid}/export/timeline.prproj.xml`. Add handler and route: `.route("/film/projects/:project_id/export/premiere", get(film_export_premiere))`. Return `Content-Type: application/xml`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-059

## Notes

Part of the Film Engine — Full Production Pipeline epic.
