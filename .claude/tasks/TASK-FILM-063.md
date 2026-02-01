# FILM-063: Audio deliverables packaging

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** NLE Export & Integration (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_audio_export` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/projects/:project_id/export/audio", post(film_audio_export))`. Collect all audio assets across all shots: dialogue stems (per character from `/audio_dialogue/`), music stems (from `/audio_music/score.wav`), SFX stems, ambient stems, temp-mix. Concatenate per-character dialogue across shots in timeline order using FFmpeg: `ffmpeg -f concat -i filelist.txt -c copy output.wav`. Generate SRT subtitles from dialogue timing: iterate all shot scene cards, extract character dialogue with timestamps, format as `{index}\n{start} --> {end}\n{character}: {text}\n\n`. Write SRT to `/data/film/projects/{pid}/export/subtitles.srt`. Copy all stem files to `/data/film/projects/{pid}/export/audio/` organized by type: `dialogue/`, `music/`, `sfx/`, `ambient/`, `mix/`. Return `{"stems": {"dialogue": [...], "music": [...], "sfx": [...], "ambient": [...]}, "subtitle_path": "...", "temp_mix_path": "..."}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
