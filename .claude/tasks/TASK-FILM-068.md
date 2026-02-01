# FILM-068: Video preview player

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Desktop App Integration (5 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `desktop/src/components/film/VideoPlayer.tsx`. Implement using HTML5 `<video>` element with Tauri `convertFileSrc()` for local file paths. Transport controls: play/pause button, stop, scrub bar (range input tracking `currentTime`/`duration`), frame-forward/back (±1/24s), volume slider. Support two modes: single-shot preview (load one shot's video) and sequence playback (concatenate all shots in order via a playlist — advance to next shot on ended event). Audio sync: set `<video>` and `<audio>` elements' `currentTime` in sync when separate dialogue/music tracks exist. Display shot code and timecode overlay. Add fullscreen toggle via `video.requestFullscreen()`. Style with dark theme matching existing desktop app. Export as reusable component accepting `shotId` or `projectId` prop.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
