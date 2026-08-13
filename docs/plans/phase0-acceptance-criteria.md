# Phase 0 — Test Specification & Acceptance Criteria

**Status:** Implemented and green.
**Under test:** `backend/lib/capability-payloads.js`
**Executable suite:** `backend/tests/phase0-payload-parity.test.js` — 60 tests, all passing
**Completeness check:** `backend/tests/phase0-spec-coverage.test.js` — 11 tests, passing
**Machine-readable matrix:** [`phase0-test-matrix.json`](./phase0-test-matrix.json)

---

## 1. What Phase 0 must prove

One payload-construction path per capability, shared by the per-domain routes and the orchestrator.

Two live defects motivate it:

| # | Location | Defect |
|---|---|---|
| 1 | `routes/pipeline.js:122` | Ships `{shot_id, scene_id, project_id, step}` to every generator. No prompt builder, no consistency context. Every orchestrated run generates from nothing. |
| 2 | `routes/storyboard.js:97` | Calls `fetch(\`${GRIDLIGHT_URL}/image\`)` directly. `provider_config.image` is ignored, so a Runway- or OpenAI-configured project still gets Gridlight — on the most visible path in the product. |

## 2. The set under test

Derived from the orchestrator's own dispatch table, `STEP_CAPABILITY` in `routes/pipeline.js:102-105`. The route does not export it, so both test files recover it **from source** — hard-coding a copy would let the set drift silently.

**8 capabilities**, each crossed with **6 acceptance criteria** = **48 capability cases**, plus **3 global cases** = **51 specified cases**.

| Capability | Step | Scope | Cardinality | Builder today |
|---|---|---|---|---|
| `image` | keyframe | shot | one | `buildStoryboardPrompt` + consistency |
| `video` | video | shot | one | `buildVideoPayload` |
| `voice` | voice | shot | **many** (per dialogue line) | `buildVoicePayload` + consistency |
| `lipsync` | lipsync | shot | one | **inline** — `routes/lipsync.js:115` |
| `music` | music | **scene** | one | `buildMusicPrompt` |
| `sfx` | sfx | shot | **many** (per cue) | `buildSFXPrompts` |
| `ambient` | ambient | **scene** | one | `buildAmbientPrompt` |
| `post` | post | shot | one (4 sub-types) | **inline** — `buildPostPayload` |

Scope is cross-checked against `PIPELINE_STEPS`, so a capability cannot claim a scope the engine disagrees with.

### Three asymmetries the implementation must not flatten

These are the reason a naive "one builder per capability" extraction would break things, and each has dedicated cases:

1. **Cardinality is not uniform.** `voice` and `sfx` are one-context-to-many-payloads. A builder returning a single object silently drops every dialogue line after the first.
2. **Scope is not uniform.** `music` and `ambient` are scene-scoped and must build with **no shot in context**. Requiring a shot forces the caller to pick an arbitrary one.
3. **`post` has four sub-types** (`upscale`, `face_restore`, `color_grade`, composite) and the orchestrator's single `post` step currently specifies none. **Open decision for implementation** — see §6.

---

## 3. Acceptance criteria

| ID | Name | Statement | Failure means |
|---|---|---|---|
| **AC1** | Builder registration & provider dispatch | Every dispatched capability resolves to a registered builder, and the provider that runs is the one `provider_config` names. | A capability silently has no builder, or a project's provider choice is ignored — the two shapes the current defects take. |
| **AC2** | Payload content | Every payload carries its required keys and is never the four-key stub. | The generator is asked to produce something from nothing; output is unrelated to the screenplay. |
| **AC3** | Caller parity & determinism | The payload is identical whether the route or the orchestrator asks, and identical context yields identical payload. | Running a shot through the pipeline gives a different result than running it from its own page. |
| **AC4** | Consistency propagation | Locked seed, prompt/negative additions, and references reach every capability that supports them. | Character identity drifts between shots; consistency holds on one path and is dropped on the other. |
| **AC5** | Cardinality & scope | Many-capabilities return arrays, one-capabilities return objects, scene-scoped capabilities build with no shot. | Dialogue lines or cues collapse to one; a scene cue demands a shot it should not need. |
| **AC6** | Error paths & preconditions | Missing preconditions raise a diagnosable error; genuinely empty inputs yield **zero** payloads rather than one malformed payload. | Undefined URLs and empty prompts reach the provider, burning budget on requests that cannot succeed. |

The distinction inside AC6 is deliberate and is where most of the edge-case value sits:

- **Missing precondition → throw.** No video asset for lipsync is a *broken* request.
- **Empty input → empty array.** A shot with no dialogue is a *valid* silent shot. It must yield zero voice payloads, not one payload with `text: ""`. Today a shot with no dialogue is handled by `autoSkipSteps()` at the *engine* level; the builder must be safe on its own, because the canvas will call it without that guard.

---

## 4. Fixture design

One fixture, `fixtureCtx()`, describing a single shot rich enough to satisfy every capability's preconditions at once: a scene card with dialogue and an SFX cue, a matched character with a LoRA id and voice profile, a location, a 45-second scene duration, and keyframe/video/audio assets already present.

**Fixtures are plain objects — never a temp database.** This is a constraint on the implementation, not a convenience: `buildCapabilityPayload(capability, ctx)` must take a *context* rather than a shot id, so it can be exercised without I/O. `loadShotContext(shotId)` does the reading, separately, and must lazy-require the DB so importing the module in a unit test does not open a database. **If the parity suite cannot be written without a database, the interface is wrong.**

Determinism: the fixture is a pure literal with no clock, no randomness, and no filesystem reads, so AC3's repeat-build comparison is meaningful.

---

## 5. Notable individual cases

**`ambient.AC3` — the loop/bed split.** A 45-second scene must yield `duration_s <= 30` (the loop), `bed_duration_s === 45` (what it must cover), and `loopable === true`. If an extraction collapses these into one duration, the mixer plays the bed once and leaves the rest of the scene dry — a regression that produces a *plausible-sounding* result and so survives casual review. This is pinned as an exact-value assertion, not a shape check.

**`voice.AC5` — fan-out per line.** Two dialogue lines must yield exactly two payloads, with `payload[1].text` matching the second line. A builder that returns one payload leaves half the dialogue ungenerated and the shot plays silent.

**`voice.AC6` / `sfx.AC6` — empty means empty.** Zero payloads, no throw. Every silent shot in a feature would otherwise trigger a paid generation.

**`lipsync.AC6` — two separate throws.** Missing video and missing audio are tested independently and must throw with distinguishable messages (`/video/i`, `/audio/i`). A single generic "missing asset" error makes the failure undiagnosable from a batch run's logs.

**`*.AC4` on `lipsync` / `music` / `sfx` / `ambient` — tolerating a no-op.** These capabilities consume assets or scene mood, not visual identity, so consistency context is a no-op for them. It must be *accepted without corrupting the payload* rather than throwing. Uniform context handling has to actually be uniform, or every caller needs to know which capabilities take context.

**`global.no-inline-payloads`** scans every route calling a provider for a payload literal containing a `stream:` key. Known offender at spec time: **`lipsync.js`**. This is the structural guarantee behind AC3 — without it, parity is coincidental rather than enforced.

---

## 6. Decisions taken

All three were resolved as recommended:

1. **Orchestrated `post` sub-type → `composite`.** `DEFAULT_POST_JOB_TYPE` in `capability-payloads.js`, overridable via `ctx.overrides.job_type`. An unconfigured run keeps doing what it did.
2. **`buildCapabilityPayload` returns `{payload, meta}`.** `meta` carries capability, cardinality, count, and the project/scene/shot ids — the seam Phase 2's node handlers will use for job rows and `providerId`.
3. **`image` keeps `callImageGen`'s defaults verbatim** (`sdxl`, 1024×1024, 30 steps, guidance 7.5), moved into `IMAGE_DEFAULTS`, so the extraction is behaviour-preserving rather than a retune.

### A fourth decision the implementation forced

**Precondition failures skip; they do not fail.** The orchestrator calls generators but never persists their output, so on an orchestrated run there is never a video asset for `lipsync` or `post` to consume. Hard-failing there cost three retries with exponential backoff on a condition no retry can change, and broke the pipeline end-to-end test.

The builder still throws (AC6 is unchanged and still passes) — but the error is tagged `code: 'PRECONDITION'`, and `executeStep` turns that specific tag into a recorded skip with a reason. Layering the decision at the orchestrator rather than the builder keeps "missing prerequisite" and "broken context" distinguishable, which is what AC6 was drawing a line between in the first place.

That the orchestrator discards generation results is a real gap, and a larger one than Phase 0. Phase 2's node handlers own persistence.

### One test corrected

`voice.AC4` originally asserted that a voice payload carries the locked **seed or image references** — the same shape as `image` and `video`. That is factually wrong: `applyConsistencyToVoicePayload` reads `context.voice.by_character`, because identity for speech is a voice id and its settings, not a seed. Satisfying the original assertion would have meant sending an image reference to a TTS provider.

It was replaced with two cases pinning the real contract — exact propagation of `voice_id`, `consistency_profile_id`, `language`, `speed` and `similarity_boost`, plus a negative case proving another character's locked profile does **not** leak onto this payload. Both are strictly stronger than the substring OR-match they replaced. Test count went 59 → 60.

---

## 7. Current state

```
$ node --test backend/tests/phase0-payload-parity.test.js
# tests 60
# pass 60
# fail 0
```

Both original defects are closed, plus the third found while writing the spec:

- `routes/pipeline.js` builds through `buildCapabilityPayload`; the four-key stub is gone.
- `routes/storyboard.js` resolves `image` through the provider registry on **both** the sync and streaming paths, so `provider_config.image` is finally honoured.
- `routes/lipsync.js` no longer assembles its payload inline.

One module was needed that the plan did not foresee: `backend/lib/consistency-apply.js`. `consistency-context.js` requires `db/database` at module scope, so applying an already-built consistency context forced a database import on any caller that only wanted to shape a payload. The pure functions moved out and are re-exported, so there is still one definition and every existing import is unchanged.
