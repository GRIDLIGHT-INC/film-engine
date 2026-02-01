# FILM-120: Screenplay-to-scenes sync — extract and update film_scenes

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Screenplay Editor & Writing Tools (38 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

When the screenplay is saved (auto-save or manual), automatically sync scenes with the `film_scenes` table. Parse the current Fountain content to extract scene headings. Compare against existing scenes for the project. Use a matching algorithm: match by scene number first, then by location+time_of_day similarity if scene numbers shifted. For each scene heading: if a matching scene exists, update its `int_ext`, `location`, `time_of_day`, and `description` (the action text following the heading until the next heading). If no match, create a new scene. If an existing scene's heading was deleted from the screenplay, mark it as `status='removed'` (add this value to the status CHECK constraint via a new migration if needed). Also extract `characters_present` from character cues within each scene. Return a sync report: `{ scenes_added, scenes_updated, scenes_removed, characters_found }`. This sync replaces the old `parseScreenplay()` call in `uploadScript()`. Add flag `sync_scenes: true/false` to the save endpoint to control whether sync runs.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

FILM-104, FILM-094

## Notes

Part of the Film Engine — Full Production Pipeline epic.
