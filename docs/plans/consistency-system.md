# Film Engine Consistency System

Status: implementation in progress by Claude + codex.

## Goal

Film Engine should allow creative exploration while designing characters, locations, props, styles, and voices, but production generation must use locked identity contracts so shots stay consistent across a project.

The working model is:

1. Explore: generate candidate references freely.
2. Lock: approve a consistency profile.
3. Generate: inject locked profile anchors into storyboard, video, and voice generation.
4. Verify: audit readiness and surface missing anchors before expensive pipeline runs.

## Research Basis

Current professional AI film/video tooling converges on reference-conditioned generation rather than seed-only prompting.

- Runway’s API and docs support reference images and image-to-video inputs; their reference-media guidance states that high-quality, isolated references are the biggest practical lever for output quality.
- Luma Agents supports image and video generation with `image_ref` and keyframes, including multi-anchor keyframes for video.
- OpenAI `gpt-image-1` accepts image inputs via image editing, which lets production images use locked reference files instead of text-only identity descriptions.
- Runway accepts canonical references directly: tagged `referenceImages` on `text_to_image`, and a keyframe as `promptImage` on `image_to_video`, so locked identity images survive into production generation without prompt-only description.
- ElevenLabs documents that voice consistency is best handled by stable voice identities and clean, consistent samples; Professional Voice Cloning is more consistent than instant cloning when high quality and emotional range matter.
- Research/production patterns align with this: DreamBooth/LoRA for trained subject identity, IP-Adapter for image-prompt identity, and ControlNet/OpenPose/Depth/Canny for pose/layout control.

Implication: seed lock is useful for deterministic style but not enough for identity. Locked canonical reference assets plus provider-specific reference injection are the baseline.

## Data Model

Migration `045_consistency_profiles.sql` adds three tables.

`film_consistency_profiles`

- `profile_type`: `character`, `location`, `prop`, `style`, or `voice`
- `subject_id` / `subject_name`: link to the entity being locked
- `status`: `draft`, `locked`, or `archived`
- `canonical_asset_id`: primary identity anchor in `film_assets`
- `prompt_contract` / `negative_contract`: text that must be included in production prompts
- `provider`, `provider_model`, `locked_seed`, `reference_weight`
- `required_roles`: JSON role list such as `["front","side","full_body"]`
- `settings`: JSON for provider-specific locked settings, for example ElevenLabs `voice_id`

`film_consistency_refs`

Stores role-specific supporting references for a profile. The canonical asset remains on the profile for fast lookup; this table supports additional refs like `front`, `side`, `wide`, `detail`, or `color`.

`film_consistency_checks`

Stores optional audit snapshots for UI/history. The main audit helpers are pure reads and do not require writes.

## Helper Contract

`backend/lib/consistency-context.js` exports:

- `auditShotReadiness(shot, scene, project)` -> `{ ready, missing, warnings }`
- `auditProjectReadiness(projectId)` -> project-level readiness plus per-shot results
- `buildShotReferencePayload(shot, scene, project)` -> locked profiles, canonical references, input asset IDs, prompt additions, negative additions, locked seed, and voice settings
- `applyConsistencyToImagePayload(payload, context)` -> adds prompt/negative contracts, locked seed, `reference_images`, `input_refs`, and an IP-Adapter fallback
- `applyConsistencyToVoicePayload(payload, context, characterName)` -> adds locked `voice_id` and voice settings
- `recordConsistencyCheck(shot, scene, project, options)` -> writes a Verify-compatible row to `film_consistency_checks` using existing columns only.

Reference payloads preserve a deterministic multi-reference order: character, location, prop, style; then subject name; then canonical/face/front/side/back/full_body/expression/wide/detail/color roles; then higher weight. `REF_ROLES` is exported from `consistency-context.js` so route validation, ordering, and Studio vocabulary share one source. Payloads also include `references_by_role` and `reference_groups` for Studio/adapter consumers that need role-level grouping while keeping the existing flat `references` and `input_refs` arrays.

Readiness audits enforce `required_roles` for locked visual profiles. For example, a character profile requiring `front` and `side` references is not ready until both roles are attached. Conflicting locked seeds are guarded: if applicable profiles specify different seeds, generation payloads do not receive a locked seed and the audit returns a warning naming the conflict. If a caller omits a seed or passes the `-1` sentinel, the locked seed is applied; explicit seed `0` is preserved.

## Generation Integration

Storyboard generation:

- Adds prompt and negative contracts to storyboard prompts.
- Uses the locked seed when present.
- Sends locked references as `reference_images` and `ip_adapter_image`.
- Stores `film_assets.input_refs` on storyboard assets.

Video generation:

- Reuses the same prompt/negative contracts.
- Carries locked references to provider payloads.
- Stores `film_assets.input_refs` on `video_raw` assets.

Voice generation:

- Applies locked per-character voice settings by character name.
- Supports both top-level voice profile fields and `voice_params` JSON.
- Records Verify rows after dialogue audio assets are created.

Provider adapters:

- Gridlight receives canonical fields unchanged.
- OpenAI uses `/images/edits` with local reference images when available; otherwise it preserves the existing text-to-image path.
- Runway maps `reference_images` onto tagged `referenceImages` for image generation. Its video endpoints take a single `promptImage`, so the shot keyframe becomes the first frame, falling back to the first locked reference when a shot has no keyframe.
- Multi-reference ordering is prepared in `buildShotReferencePayload` and preserved by OpenAI image edits and Runway `referenceImages`.

Verify rows:

`recordConsistencyCheck` is best-effort: generation stays successful if Verify persistence cannot write. On success, it writes `status`, `missing`, `warnings`, and `details` JSON in this shape:

```json
{
  "subjects": [
    {
      "profile_id": "...",
      "profile_type": "character",
      "subject_name": "Mara",
      "role": "canonical",
      "score": 1,
      "status": "ready",
      "reference_asset_id": "...",
      "output_asset_id": "..."
    }
  ],
  "scorer": "stub",
  "thresholds": { "ready": 0.85, "warning": 0.70 }
}
```

## Operating Rules

- Draft profiles never affect production.
- Locked visual profiles without canonical assets block strict readiness.
- Missing voice profiles warn first, because not every shot has dialogue and existing projects may not have voice locks yet.
- Every generated asset should record `input_refs` so exported media can be traced back to the locked anchors used to create it.

## Future Work

- Add optional embedding-based drift scoring for faces/locations/voice once dependencies/provider support are chosen.
- Add LoRA/DreamBooth training jobs for highest-stakes characters.
- Add pose/depth/layout references for strict blocking on complex action scenes.
