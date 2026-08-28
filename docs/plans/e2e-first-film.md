# The First Finished Film — implementation plan

**The claim to prove:** write a screenplay, take it through every stage of the
pipeline, and end with a movie file — all managed from Film Engine.

Everything below is measured from this install, not assumed. The denominator is
`lib/e2e-preflight`, the same registry `backend/preflight.js` walks, and
`backend/tests/e2e-first-film-plan.test.js` holds this document to it.

---

## 1. Measured starting state

`node backend/preflight.js e71fdca0-de1c-4677-8b6e-e2564bc7d341` reports
**15 stages: 12 ready, 3 finished in the NLE, 0 auto-skipped, 0 blocked.**

So nothing is blocking. The gap is not capability — it is that **no project has
ever been run through**:

| Project | Scenes / Shots | Assets |
|---|---|---|
| From the Mist | 11 / 61 | none at all |
| Wingfall | 3 / 13 | 82 storyboard, 2 `video_raw`, exports |
| The Glass Harbour | 1 / 13 | 20 storyboard, plates |

Total spend ever recorded: **$14.12**, every cent of it images
(`film_cost_entries`: 91 image entries, 1 model3d). No voice, music, video or
assembly has ever been metered — which confirms the two Wingfall clips were
made on Runway directly rather than through the engine.

**An encoder exists.** `availableExecutors()` reports `ffmpeg (bundled)` →
`available: true`, so a single master file can actually be produced. This was
the historical blocker and it is closed.

## 2. Why a fixture, not an existing project

`backend/tests/fixtures/thirty-second.fountain` is one scene, four action
beats, two dialogue lines — sized to exercise every step at the lowest cost.
Finishing **Wingfall** or **The Glass Harbour** instead means 13 shots through
every stage: several times the spend to prove exactly the same sentence, on a
board that already has creative decisions in it worth protecting.

Prove the pipeline on the fixture. Then finish a real film knowing the machine
works.

## 3. The 15 stages, and where each one happens

| # | Stage id | Where | Capability | Spends |
|---|---|---|---|---|
| 1 | `project` | engine | — | no |
| 2 | `script` | engine | — | no |
| 3 | `breakdown` | **MCP** | `llm` | **no — subscription** |
| 4 | `shots` | engine | — | no |
| 5 | `keyframe` | engine | `image` | yes |
| 6 | `video` | engine | `video` | yes |
| 7 | `voice` | engine | `voice` | yes |
| 8 | `lipsync` | **NLE hand-off** | `lipsync` | — |
| 9 | `music` | engine | `music` | yes |
| 10 | `sfx` | engine | `sfx` | yes |
| 11 | `ambient` | engine | `ambient` | yes |
| 12 | `post` | **NLE hand-off** | `post` | — |
| 13 | `assembly` | engine (ffmpeg) | — | no |
| 14 | `mix` | **NLE hand-off** | — | — |
| 15 | `export` | engine | — | no |

**Three stages finish in the NLE and that is not a gap.** `lipsync`, `post` and
`mix` have no adapter but Gridlight, which does not implement them. Planning to
"generate the lip-sync" would be planning work nothing does. The export carries
the material — `AUDIO_LANES` puts dialogue, music, SFX and ambient out on their
own tracks — so the finishing happens where a finisher already works.

**`breakdown` goes through MCP and costs nothing.** `anthropic:llm` is marked
`subscription: true`: the connected model IS the LLM here, so there is no API
key and no bill. 458 LLM calls and 11.3M tokens are recorded to date at **$0**.
This is the standing rabbit hole — use MCP for AI queries — and it is already
honoured. Do not add a server-side LLM call to close a stage.

## 4. What the finished film will and will not be

Stated up front because both are measured facts that change what "final movie"
can mean:

- **The image provider ignores the requested resolution.** Meshy is
  `ratio-only` and returns **1376×768** at 16:9 — about one megapixel. A 2K or
  4K board is not available on this account without a BFL or Google key.
- **Video is 720p-class.** Runway's `image_to_video` documents `1280:720`, so
  a clip generates at that ceiling whatever the project setting says. The route
  to a larger deliverable is the upscale in post, not a bigger ask here.

The first finished film is therefore a **720p short**. That is the honest
target, and it proves the claim exactly as well as a 4K one would.

## 5. Cost

From the rate book, with quantities from the fixture and the per-call figure
**measured** from this install (93 Meshy calls, 708 credits → **7.61 credits
per image** at $0.02/credit ≈ **$0.15 per keyframe**; 91 entries totalling
**$13.92** ≈ $0.153 each):

| Stage | Quantity | Rate | Cost |
|---|---|---|---|
| `breakdown` | ~25k tokens | subscription | **$0.00** |
| `keyframe` | 5 shots | $0.15 / image | $0.75 |
| `video` | 5 × 5s = 25s | $0.05 / s | $1.25 |
| `voice` | ~200 characters | $0.0001 / char | $0.02 |
| `music` | 30s | $0.000167 / s | $0.01 |
| `sfx` + `ambient` | ~60s | $0.00005 / s | $0.01 |
| `assembly`, `export` | — | local ffmpeg | $0.00 |
| | | **total** | **≈ $2.04** |

Budget **$5** to absorb a regeneration or two. The entire acceptance criterion
can be proven for about the price of a coffee, which is the single most useful
number in this document.

## 6. Milestones

**The dependency chain is strictly linear**, and that is a property of the
pipeline rather than a scheduling choice: `PIPELINE_STEPS.depends` makes video
read the keyframe, lip-sync read the video and the dialogue, and assembly read
every shot. The one real dependency worth stating separately is that **M4's
video is conditioned on M3's keyframe** — generating motion before the board is
approved buys a clip of a frame you were going to change.

M1 → M2 → M3 → M4 → M5 → M6 → M7. Stop at any failing **Done when**: a stage
that half-succeeded costs money to discover twice.

### M1 — Project and screenplay in, scenes and shots out
**Depends on** nothing.
**Do** Create a project, upload `backend/tests/fixtures/thirty-second.fountain`,
run the breakdown **through MCP** (`script_write`, then compose scene cards with
`shot_create` — not a server-side LLM route).
**Done when** the project has 1 scene and 3–6 shots, each with a scene card that
`validateSceneCard` accepts.
**Verify** `node backend/preflight.js <project-id>` → stages `project`, `script`,
`breakdown`, `shots` all GO, and `curl -s localhost:3100/film/projects/<id>/shotlist`
returns the shots.

### M2 — Entities exist and are described
**Depends on** M1.
**Do** `entities_create` from the screenplay, then write each
`appearance_prompt` / `description` / `visual_prompt` from the agent side.
**Done when** no entity the shots reference is undescribed — an undescribed
subject is re-invented in every frame it appears in.
**Verify** `curl -s localhost:3100/film/projects/<id>/elements-list` → `undescribed`
is empty.

### M3 — Plates, then a board
**Depends on** M2.
**Do** Generate a plate per subject, then the storyboard.
**Done when** every shot has a keyframe and every subject a plate.
**Verify** `curl -s localhost:3100/film/projects/<id>/storyboard` → a frame per
shot; `node backend/preflight.js <id>` → `keyframe` GO. Expect **1376×768**
files, per §4.

### M4 — Motion, dialogue and score
**Depends on** M3 (video is conditioned on the keyframe).
**Do** Video per shot, voice for the two dialogue lines, then scene music, SFX
and ambient.
**Done when** each shot has a `video_raw`, each dialogue line an
`audio_dialogue`, and the scene has music and ambient.
**Verify** `curl -s localhost:3100/film/projects/<id>/video` and `.../voice` and
`.../music/jobs` → one asset per expected item, and
`curl -s localhost:3100/film/projects/<id>/spend` shows the real total against
the ≈$2.04 estimate.

### M5 — One file
**Depends on** M4.
**Do** Conform the shots into a single master.
**Done when** a single playable file exists whose duration is the sum of the
shots — not a folder of clips.
**Verify** `curl -s -X POST localhost:3100/film/projects/<id>/conform` then read
the file back with `node -e "…ffprobe duration…"`. A missing shot must **refuse**
the conform rather than silently producing a shorter film.

### M6 — Hand off to the NLE
**Depends on** M5.
**Do** Export FCPXML, EDL and Premiere XML.
**Done when** all three open in an NLE, with dialogue, music, SFX and ambient on
**separate** lanes — the `AUDIO_LANES` guarantee — and no fileless clip items.
**Verify** `curl -s localhost:3100/film/projects/<id>/export/fcpxml` (and `/edl`,
`/premiere`), then `node --test backend/tests/nle-import-validity.test.js`.
`lipsync`, `post` and `mix` are completed here, by hand, and are **not** engine
failures.

### M7 — Write it down
**Depends on** M6.
**Do** Record the real numbers — what each stage cost, what it produced, what
had to be redone — in this document.
**Done when** the measured total sits beside the estimate in §5, and every
divergence is explained.
**Verify** `node --test backend/tests/e2e-first-film-plan.test.js` → passing,
with the measured column filled in.

## 7. Manual testing instructions

Two servers, then the browser:

```
node backend/server.js                      # the API, on :3100
node backend/dev-server.js 3200             # the page, on :3200
```

Open `http://localhost:3200`. To drive it from a phone on the same network,
start the page server with `FILM_ENGINE_HOST=0.0.0.0` — it prints the LAN
address and warns that it is unauthenticated.

Walk the milestones **in order** in the UI, using the free previews before every
paid button: the prompt preview on a frame, and the video preview on a shot.
Both spend nothing and show exactly what would be sent. Anything that looks
wrong in the preview will be wrong in the output, and cost money to learn.

At each paid step, confirm the pre-spend dialog names the references it will
send. A shot sending **no** references is the case worth stopping on.

## 8. Risks, and what to do about each

| Risk | Signal | Response |
|---|---|---|
| A provider refuses on moderation | the fallback chain reports the walk | let `image-fallback` try the next credentialed provider; it never replays a 400 |
| Meshy returns 1376×768 | `requested_size_ignored` on the result | expected — see §4; switch providers only if the board must be 2K |
| A shot has no keyframe when video runs | the sequence refuses | generate the missing frame; never skip, or the cut joins through a moment nobody saw |
| The conform refuses | a named list of missing shots | finish those shots; the refusal is the feature |
| Spend runs past the estimate | `/spend` against §5 | the budget gate returns 402 before generating; raise it deliberately or stop |

## 9. Out of scope for this plan

The **path-containment sweep** the security review recommended — auditing every
DB-sourced path that becomes a filesystem operation across all routes, not just
the style book. It is real work and it does not block the first film, so it is
named here rather than folded in and half-done.
