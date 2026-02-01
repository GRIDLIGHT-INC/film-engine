# FILM-018: Storyboard prompt engineering

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Storyboard Generation (5 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `gateway/src/film_prompt.rs` module. Add `mod film_prompt;` to `gateway/src/main.rs`. Implement `build_storyboard_prompt(scene_card: &SceneCard, character_db: &[FilmCharacter], location_db: &[FilmLocation]) -> String`. Map scene card fields to SDXL-optimized prompt segments: `shot_type` → "close-up shot", "wide establishing shot", etc.; `lens` → "35mm lens", "telephoto"; `lighting.key_light` → "dramatic side lighting", "soft diffused light"; `lighting.color_temp` → "warm golden hour", "cool blue moonlight". Inject character LoRA trigger tokens: for each character in scene card, look up `FilmCharacter.lora_id` and `ti_token`, prepend to prompt as `<lora:{lora_id}:0.8> {ti_token}`. Apply style presets: map `style.preset` to negative prompt templates (e.g., "cinematic" → negative: "cartoon, anime, watercolor"). Include location reference prompt from `FilmLocation.reference_prompt`. Build final prompt as `"{subject}, {camera}, {lighting}, {style}, masterpiece, high quality"`. Export as `pub fn` callable from handlers.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
