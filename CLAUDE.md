# Film Engine

AI film production pipeline for Gridlight. Transforms screenplays into editor-ready output through automated scene breakdown, storyboarding, and asset generation.

## Quick Start

```bash
cd backend
npm install
node server.js
```

Server runs on `http://localhost:3100`. Database auto-initializes on first run (SQLite at `data/film-engine.db`).

## Architecture

```
film-engine/
├── backend/
│   ├── server.js           # HTTP server + routing (port 3100)
│   ├── db/
│   │   ├── database.js     # SQLite connection (better-sqlite3)
│   │   ├── schema.js       # Auto-migration runner
│   │   └── migrations/     # SQL migration files (52 migrations)
│   ├── routes/
│   │   ├── projects.js     # Project CRUD
│   │   ├── scripts.js      # Screenplay upload/versioning + Fountain
│   │   ├── scenes.js       # Scene listing
│   │   ├── shots.js        # Shot creation + shot list
│   │   ├── breakdown.js    # AI screenplay breakdown (SSE streaming)
│   │   ├── screenplay-ai.js    # AI writing assistant
│   │   ├── text-convert.js     # Text-to-screenplay conversion
│   │   ├── characters.js   # Characters, voice profiles, costumes
│   │   ├── locations.js    # Locations + props
│   │   ├── notes.js        # Shot notes + review workflow
│   │   ├── assets.js       # Asset registry, music cues, color presets, music rights
│   │   ├── dashboard.js    # Dashboard, status board, milestones
│   │   ├── render-ledger.js    # Render logging + reproducibility
│   │   ├── production-status.js # Project status state machine
│   │   ├── call-sheets.js      # Scene/project call sheets
│   │   ├── nle-export.js       # FCPXML, EDL, Premiere XML export
│   │   ├── storyboard.js       # Storyboard generation, viewer, regeneration
│   │   ├── voice.js            # Voice & dialogue pipeline (Phase 4)
│   │   ├── video-gen.js        # Video generation pipeline (Phase 5)
│   │   ├── lipsync.js          # Lip-sync pipeline (Phase 6)
│   │   ├── music-gen.js        # Music, SFX, ambient generation (Phase 7)
│   │   ├── post-production.js  # Post-production pipeline (Phase 9)
│   │   ├── pipeline.js         # Pipeline orchestrator (Phase 12)
│   │   ├── qa.js               # QA checks & quality gates (Phase 13)
│   │   ├── project-bundle.js   # Project export/import bundles
│   │   ├── acts.js             # Act/sequence structure (Phase 16)
│   │   ├── subtitles.js        # Subtitle CRUD + SRT/VTT export (Phase 17)
│   │   ├── audio-deliverables.js # Audio deliverables + manifest (Phase 17)
│   │   ├── continuity.js       # Continuity reference board (Phase 18)
│   │   ├── credits.js          # Credits + title cards (Phase 18)
│   │   ├── marketing.js        # Marketing assets (Phase 18)
│   │   ├── budget.js           # Budget & cost tracking (Phase 18)
│   │   ├── backups.js          # Auto-backup system (Phase 18)
│   │   ├── flows.js            # Flow CRUD + graph validation (Phase 1)
│   │   ├── providers.js        # Provider registry, credentials, OAuth connect
│   │   ├── consistency.js      # Consistency profiles, locking, readiness audit
│   │   ├── takes.js            # Takes & selects (circle-take workflow)
│   │   ├── timeline.js         # Timeline assembly + reordering
│   │   ├── jobs.js             # Unified job queue view across pipelines
│   │   ├── budget-estimate.js  # Pre-flight cost estimation
│   │   └── demo-project.js     # Seeded demo project for first-run
│   ├── lib/
│   │   ├── fountain-parser.js     # Fountain markup parser (AST)
│   │   ├── fountain-renderer.js   # Fountain → HTML renderer
│   │   ├── fdx-parser.js         # Final Draft XML parser (import)
│   │   ├── fdx-generator.js      # Final Draft XML generator (export)
│   │   ├── nle-export.js         # NLE format generators (pure functions)
│   │   ├── screenplay-parser.js   # INT./EXT. scene heading parser
│   │   ├── scene-card-schema.js   # Scene card YAML validator
│   │   ├── storyboard-prompt.js   # Storyboard prompt engineering + style lock
│   │   ├── gridlight-client.js    # Shared HTTP client + request queue + 429 retry
│   │   ├── file-storage.js        # Shared file storage utilities
│   │   ├── dialogue-builder.js    # Dialogue extraction + voice payloads
│   │   ├── video-prompt.js        # Video prompt builder + camera control
│   │   ├── music-prompt.js        # Music/SFX/ambient prompt builder
│   │   ├── pipeline-engine.js     # Pipeline step sequencing + dependency resolution
│   │   ├── viseme-builder.js     # Phoneme-to-viseme mapping (MPEG-4)
│   │   ├── video-stitcher.js     # Multi-clip stitching for long shots
│   │   ├── audio-mixer.js        # Audio mix, ducking, stems, SRT
│   │   ├── qa-checker.js         # QA checks, continuity, acceptance rubric
│   │   ├── scheduling-engine.js  # Smart scheduling & GPU model residency
│   │   ├── project-bundle.js    # Project export/import (.tar.gz bundles)
│   │   ├── flow-graph.js         # Flow graph algebra: validate, cycles, topo, ports (Phase 1)
│   │   ├── flow-node-types.js    # Runtime node-type registry: ports, kinds, arity (Phase 1)
│   │   ├── flow-seed.js          # Built-in flow derived from PIPELINE_STEPS (Phase 1)
│   │   ├── capability-payloads.js # ONE provider payload path per capability (Phase 0)
│   │   ├── consistency-apply.js  # Pure consistency application (no DB import)
│   │   ├── consistency-context.js # Locked profiles → reference payloads
│   │   ├── provider-media.js     # Buffer-vs-URL normalisation + gateway origin check
│   │   ├── llm-client.js         # Shared LLM call helper
│   │   ├── budget-estimator.js   # Pre-flight cost estimation
│   │   ├── prompt-diff.js        # Prompt/parameter diffing for A/B compare
│   │   ├── provenance.js         # Provenance sidecar manifests
│   │   ├── timeline.js           # Timeline assembly logic
│   │   ├── docx-text.js          # DOCX → plain text extraction
│   │   ├── project-presets.js   # Aspect ratios, resolutions, delivery presets (Phase 15)
│   │   ├── subtitle-generator.js # SRT/VTT generation, parsing, conversion (Phase 17)
│   │   ├── audio-deliverables.js # 5.1 spec, M&E, stems, validation (Phase 17)
│   │   └── backup.js            # Project JSON export/import (Phase 18)
│   └── tests/
│       ├── nle-export.test.js          # NLE export unit tests
│       ├── storyboard-prompt.test.js   # Storyboard prompt unit tests
│       ├── dialogue-builder.test.js    # Dialogue builder unit tests
│       ├── video-prompt.test.js        # Video prompt unit tests
│       ├── music-prompt.test.js        # Music prompt unit tests
│       ├── pipeline-engine.test.js     # Pipeline engine unit tests
│       ├── viseme-builder.test.js     # Viseme builder unit tests
│       ├── video-stitcher.test.js     # Video stitcher unit tests
│       ├── audio-mixer.test.js        # Audio mixer unit tests
│       ├── qa-checker.test.js         # QA checker unit tests
│       ├── scheduling-engine.test.js  # Scheduling engine unit tests
│       ├── fdx-generator.test.js     # FDX generator unit tests
│       ├── project-bundle.test.js   # Project bundle export/import tests
│       ├── gridlight-client.test.js # Gridlight client + queue tests
│       ├── project-presets.test.js  # Project presets unit tests (Phase 15)
│       ├── subtitle-generator.test.js # Subtitle format tests (Phase 17)
│       ├── backup.test.js           # Backup export/import tests (Phase 18)
│       ├── flow-graph.test.js            # Graph algebra + PIPELINE_STEPS lockstep (Phase 1)
│       ├── flows-routes.test.js          # Flow CRUD against a real database (Phase 1)
│       ├── phase0-payload-parity.test.js  # One payload path per capability (60 tests)
│       ├── phase0-spec-coverage.test.js   # Phase 0 test-matrix completeness
│       ├── flows-node-taxonomy.test.js    # Flows canvas node palette coverage
│       ├── flows-canvas-plan.test.js      # Flows canvas plan/manifest conformance
│       ├── gateway-credential-scope.test.js # Gateway key never leaves the gateway
│       ├── asset-path-containment.test.js # DB file_name cannot escape project dir
│       ├── test-isolation.test.js        # No test may open the real database
│       ├── docs-drift.test.js            # CLAUDE.md matches the tree on disk
│       ├── providers.test.js             # Provider registry + resolution
│       ├── providers-api.test.js         # Provider settings/credentials API
│       ├── providers-runway.test.js      # Runway adapter (mock server)
│       ├── providers-openai-image.test.js # OpenAI image adapter (mock server)
│       ├── providers-elevenlabs.test.js  # ElevenLabs adapter (mock server)
│       ├── consistency-context.test.js   # Consistency context assembly
│       ├── consistency-routes.test.js    # Consistency profiles API
│       ├── consistency-verify.test.js    # Consistency verification
│       ├── pipeline-e2e.test.js          # Pipeline end-to-end (mock gateway)
│       ├── pipeline-readiness.test.js    # Pipeline consistency readiness gate
│       ├── video-gen.test.js             # Video generation integration
│       ├── music-gen.test.js             # Music generation integration
│       ├── threed.test.js                # 3D integration (mock Gridlight)
│       ├── threed-prompt.test.js         # 3D payload builders
│       ├── timeline.test.js              # Timeline assembly
│       ├── editorial-routes.test.js      # Editorial routes
│       ├── ops-compliance.test.js        # Ops/compliance jobs + provenance
│       ├── budget-estimator.test.js      # Cost estimation
│       ├── prompt-diff.test.js           # Prompt/parameter diffing
│       ├── fountain-parser.test.js       # Fountain parser
│       ├── docx-text.test.js             # DOCX text extraction
│       ├── integration.test.js       # Integration test suite (43 tests)
│       └── helpers.js                # Test utilities
├── docs/
│   ├── api-film.md         # Full API reference
│   └── adr/                # Architecture decision records (5 ADRs)
├── src/
│   ├── index.html          # Frontend SPA
│   └── app.json            # App config
├── data/
│   └── film-engine.db      # SQLite database (auto-created)
└── gridlight.json          # App manifest
```

## API Routes

All routes prefixed with `/film`:

| Category | Endpoints |
|----------|-----------|
| Projects | `GET/POST /projects`, `GET/PUT/DELETE /projects/:id` |
| Scripts | `POST /projects/:id/script`, `GET /projects/:id/scripts[/:ver]`, `PUT /projects/:id/script/:ver` |
| Scenes | `GET /projects/:id/scenes`, `GET /scenes/:id` |
| Shots | `POST /shots`, `GET /projects/:id/shotlist` |
| Characters | `GET/POST /projects/:id/characters`, `GET/PUT/DELETE /characters/:id` |
| Locations | `GET/POST /projects/:id/locations`, `GET/PUT/DELETE /locations/:id` |
| Props | `GET/POST /projects/:id/props`, `GET/PUT/DELETE /props/:id` |
| Notes | `GET/POST /shots/:id/notes`, `PUT/DELETE /notes/:id`, `POST /shots/:id/review` |
| Assets | `GET/POST /projects/:id/assets`, `GET/DELETE /assets/:id` |
| Dashboard | `GET /projects/:id/dashboard`, `GET /projects/:id/status-board` |
| Milestones | `GET/POST /projects/:id/milestones`, `PUT /projects/:id/milestones/:mid` |
| Render | `POST /shots/:id/render`, `GET /shots/:id/renders`, `GET /shots/:id/versions` |
| A/B Compare | `GET /shots/:id/versions/compare?a=X&b=Y` |
| Status | `POST /projects/:id/advance-status` |
| Call Sheets | `GET /scenes/:id/call-sheet`, `GET /projects/:id/call-sheet` |
| Breakdown | `POST /projects/:id/breakdown[/stream]` (SSE) |
| Screenplay AI | `POST /projects/:id/screenplay-ai[/stream]` |
| Text Convert | `POST /projects/:id/text-to-screenplay[/preview]` |
| Export | `GET /projects/:id/export[/fcpxml\|edl\|premiere\|fdx]` |
| Bundle | `GET /projects/:id/bundle`, `POST /projects/import` |
| Comments | `GET/POST /scripts/:id/comments`, `PUT/DELETE /comments/:id` |
| Storyboard | `POST /projects/:id/storyboard/generate[/stream]`, `GET /projects/:id/storyboard` |
| Storyboard | `POST /shots/:id/storyboard/regenerate`, `GET /storyboards/:pid/:file` |
| Voice | `POST /shots/:id/voice/generate[/stream]`, `POST /projects/:id/voice/batch[/stream]` |
| Voice | `GET /shots/:id/voice`, `GET /projects/:id/voice`, `GET /audio/:pid/:file` |
| Video | `POST /shots/:id/video/generate[/stream]`, `POST /projects/:id/video/batch[/stream]` |
| Video | `GET /shots/:id/video`, `GET /projects/:id/video`, `GET /video/:pid/:file` |
| Lipsync | `POST /shots/:id/lipsync/generate[/stream]`, `POST /projects/:id/lipsync/batch` |
| Lipsync | `GET /shots/:id/lipsync`, `GET /projects/:id/lipsync` |
| Music | `POST /scenes/:id/music/generate[/stream]`, `POST /shots/:id/sfx/generate` |
| Music | `POST /scenes/:id/ambient/generate`, `POST /projects/:id/music/batch[/stream]` |
| Music | `GET /projects/:id/music/jobs`, `GET /music/:pid/:file` |
| Post | `POST /shots/:id/post/[upscale\|face-restore\|color-grade\|composite]` |
| Post | `POST /projects/:id/post/batch[/stream]`, `GET /shots/:id/post`, `GET /projects/:id/post` |
| Pipeline | `POST /shots/:id/pipeline/run[/stream]`, `POST /scenes/:id/pipeline/run` |
| Pipeline | `POST /projects/:id/pipeline/run`, `GET /pipeline/:id` |
| Pipeline | `POST /pipeline/:id/[pause\|resume\|cancel]`, `GET /projects/:id/pipeline` |
| Ref Sheet | `POST /characters/:id/refsheet/generate`, `GET /characters/:id/refsheet` |
| Viseme | `POST /shots/:id/lipsync/viseme`, `GET /shots/:id/lipsync/viseme` |
| Viseme Sync | `POST /shots/:id/lipsync/viseme-sync` |
| Stitch | `POST /shots/:id/video/stitch` |
| Color Match | `POST /shots/:id/post/color-match`, `POST /projects/:id/post/color-match` |
| Encode | `POST /shots/:id/post/encode`, `POST /projects/:id/post/encode` |
| Audio Mix | `POST /shots/:id/audio/mix`, `POST /projects/:id/music/mix` |
| Stems/SRT | `GET /projects/:id/music/stems`, `GET /projects/:id/music/srt` |
| Schedule | `POST /projects/:id/pipeline/schedule`, `GET /projects/:id/pipeline/schedule` |
| QA | `POST /projects/:id/qa/run`, `GET /projects/:id/qa`, `GET /projects/:id/qa/latest` |
| QA | `GET /projects/:id/qa/continuity`, `GET /projects/:id/qa/rubric` |
| QA | `POST /scenes/:id/qa/run`, `POST /shots/:id/qa/run` |
| Settings | `POST /projects/:id/settings/preset` |
| Shots | `PUT /shots/:id/order`, `PUT /shots/:id/transition`, `POST /projects/:id/shots/reorder` |
| Acts | `GET/POST /projects/:id/acts`, `GET/PUT/DELETE /acts/:id`, `POST /acts/:id/assign` |
| Subtitles | `GET/POST /projects/:id/subtitles`, `PUT/DELETE /subtitles/:id` |
| Subtitles | `GET /projects/:id/subtitles/export/:fmt`, `GET /projects/:id/subtitles/languages` |
| Audio Dlv | `GET/POST /projects/:id/audio-deliverables`, `GET/DELETE /audio-deliverables/:id` |
| Audio Dlv | `GET /projects/:id/audio-deliverables/manifest` |
| Continuity | `GET/POST /projects/:id/continuity`, `GET /projects/:id/continuity/board` |
| Continuity | `GET/PUT/DELETE /continuity/:id` |
| Credits | `GET/POST /projects/:id/credits`, `POST /projects/:id/credits/reorder` |
| Credits | `GET/PUT/DELETE /credits/:id` |
| Title Cards | `GET/POST /projects/:id/title-cards`, `GET/PUT/DELETE /title-cards/:id` |
| Marketing | `GET/POST /projects/:id/marketing`, `GET/PUT/DELETE /marketing/:id` |
| Marketing | `POST /marketing/:id/generate` |
| Budget | `GET /projects/:id/budget`, `POST /projects/:id/budget` |
| Budget | `GET /projects/:id/budget/ledger`, `GET /projects/:id/budget/forecast` |
| Budget | `PUT /projects/:id/budget/limit`, `DELETE /budget/:id` |
| Music Rights | `GET /projects/:id/music-rights`, `PUT /music-cues/:id/rights` |
| Backups | `GET/POST /projects/:id/backups`, `GET/DELETE /backups/:id` |
| Backups | `GET /backups/:id/download`, `POST /backups/:id/restore` |
| 3D | `POST /characters/:id/model/generate[/stream]`, `POST /characters/:id/model/from-image[/stream]` |
| 3D | `POST /props/:id/model/generate[/stream]`, `POST /props/:id/model/from-image[/stream]` |
| 3D | `POST /models/:assetId/[rig\|retexture\|animate]`, `GET /models/:assetId/animations` |
| 3D | `POST /projects/:id/models/batch[/stream]`, `GET /projects/:id/models`, `GET /models/job/:jobId` |
| 3D | `GET /3d/:projectId/:filename` (serve .glb/.gltf/.fbx/.obj/.usdz) |

Full API documentation: [`docs/api-film.md`](docs/api-film.md)

## Key Concepts

### Scene Cards
YAML-formatted shot descriptions containing camera, lighting, characters, and style parameters. Validated by `lib/scene-card-schema.js`.

### Render Ledger
Full parameter capture for reproducibility: seed, sampler, steps, guidance, model hashes, LoRAs, controlnets. Supports locked (exact recreation) and creative (variation) modes.

### Production Status
State machine tracking project phases: `Concept` → `Script` → `PreProduction` → `Storyboard` → `Production` → `PostProduction` → `Review` → `Export` → `Complete`

### NLE Export
Export project timelines for professional video editors:
- **FCPXML 1.11** — Final Cut Pro native format with clips, markers, audio lanes, transitions
- **CMX 3600 EDL** — Universal edit decision list with drop-frame timecode for 29.97/59.94
- **Premiere Pro XML** — FCP 7 xmeml v5 format (works with Premiere, Resolve, etc.)

All three formats support dynamic project settings (resolution, fps, aspect ratio, color space), transition metadata (dissolve, fade, wipe), and rational frame durations for NTSC fps. Exports are registered in the asset registry.

### Project Settings
Per-project technical settings: resolution (8 presets + custom), frame rate (8 options including 23.976, 29.97), aspect ratio (12 presets including IMAX 1.43:1/1.90:1, anamorphic 2.39:1, Univisium 2:1), color space (sRGB, Rec.709, DCI-P3, Rec.2020, ACES), and 6 delivery presets (Theatrical DCP, IMAX, Streaming HD/4K, Social Media, Broadcast).

### Storyboard Generation
Transforms scene cards into SDXL-optimized image prompts via the prompt engineering module (`lib/storyboard-prompt.js`). Maps shot types, camera movements, and lighting from scene cards to descriptive prompt tokens. Supports character LoRA/TI injection, style presets (cinematic, noir, anime, documentary, horror, fantasy), and style locking (deterministic seed variation per scene for visual consistency). Images generated via ImageGen API (`POST http://localhost:8080/image`) and stored at `data/storyboards/{project_id}/{shot_code}.png`.

**Env vars:** `IMAGEGEN_URL` (default `http://localhost:8080`), `IMAGEGEN_API_KEY` (Bearer token)

### Voice & Dialogue Pipeline
Extracts dialogue from scene cards, matches characters to voice profiles, and generates speech audio via `POST /voice`. Supports per-shot and batch generation with SSE streaming. Audio stored at `data/audio/{project_id}/{shot_code}_{character}_{index}.wav`.

### Video Generation
Builds video generation payloads from storyboard keyframes + scene cards. Maps camera movements to `camera_control` objects (18 movement types). Uses storyboard keyframe as `init_image`. Videos stored at `data/video/{project_id}/{shot_code}.mp4`.

### Providers (pluggable generation backends)
Capabilities (`llm`, `image`, `video`, `music`, `voice`, `sfx`, `ambient`, `lipsync`, `post`, `model3d`, `stock`) each resolve to a provider adapter: per-project `provider_config` → `PROVIDER_<CAP>` env → Gridlight default. Adapters live in `lib/providers/` and are auto-loaded by filename, so adding one never means editing the registry.

**Runway** (`lib/providers/runway.js`) serves `video` + `image`. Unlike the other generators it is asynchronous: `POST /v1/{image_to_video,text_to_video,text_to_image}` returns a task id, and the adapter polls `GET /v1/tasks/:id` to completion so routes still see a finished asset. Video defaults to `gen4.5` (2–10s, ratio snapped to a documented value), images to `gen4_image`.

**Env vars:** `RUNWAY_API_KEY` (or Runway's own `RUNWAYML_API_SECRET`), `RUNWAY_BASE_URL` (default `https://api.dev.runwayml.com/v1`), `RUNWAY_VIDEO_MODEL`, `RUNWAY_IMAGE_MODEL`, `RUNWAY_POLL_INTERVAL_MS`

**ElevenLabs** (`lib/providers/elevenlabs.js`) serves `voice` + `sfx` + `ambient` + `music` — `POST /text-to-speech/:voiceId`, `POST /sound-generation` (one-shot), `POST /sound-generation` with `loop: true` on `eleven_text_to_sound_v2` (ambient beds), and `POST /music` (`music_v2`, 3s–10min, instrumental by default since film cues are underscore). All return raw audio bytes, so results are Buffers written straight to disk.

Ambient is a **loop, not a full render**: `buildAmbientPrompt` asks for a bed of at most 30s (`duration_s`) and records the length it must cover (`bed_duration_s`), then `buildMixPayload` emits `loop`/`loop_until_ms`/`loop_crossfade_ms` so the mix service tiles it across the shot. A mix service that ignores those fields will play the bed once and leave the rest dry.

No licensed-catalog *source* adapter ships today, so `stock` has no provider at all — nothing writes `film_assets.license_source = 'licensed_catalog'`, which the music-rights routes are built around. The `source` (search/license) contract and the OAuth/MCP connect flow both remain wired for the next provider that needs them.

### Flow Graphs (Phase 1)
The pipeline was always a DAG — it was just a module-level constant nobody could edit. `film_flows` / `film_flow_nodes` / `film_flow_edges` make it data, and `lib/flow-seed.js` seeds the existing 9-step pipeline as a read-only built-in flow **derived** from `PIPELINE_STEPS` rather than transcribed beside it, so a new step reaches the canvas with no migration.

`lib/flow-graph.js` is pure algebra — `validateGraph`, `detectCycles`, `topoSort`, `nextNodes`, `graphFingerprint` — with no DB or HTTP, mirroring the `pipeline-engine.js` / `routes/pipeline.js` split. `nextNodes()` deliberately matches `getNextSteps()` so the seeded flow walks in **lockstep** with `PIPELINE_STEPS`; that equivalence is what makes Phase 1 a provable no-op rather than a rewrite anyone has to trust.

Ports are typed (8 types) and most carry exactly one value, so the executor never arbitrates. The exception is **collector ports**, declared per node type as `multiInputs`: a final mix genuinely takes music, sfx and ambient at once, which the real pipeline does at `assembly`. Cycle detection runs on save and before every run — the hard-coded DAG was acyclic because a human checked once; a user-authored one is acyclic only if something checks every time.

Built-in flows are immutable through the API (the UI offers duplicate-to-edit), which keeps the equivalence guarantee true permanently. A flow with `project_id IS NULL` is a **library** flow, visible from every project — "save it once, reuse it across every project".

### Capability Payloads (one construction path)
`lib/capability-payloads.js` builds the provider payload for every orchestrated capability, so the per-domain routes, the pipeline orchestrator, and (later) the flow canvas cannot describe the same generation differently. `buildCapabilityPayload(capability, ctx)` takes a **context, not an id**, and returns `{payload, meta}`; `loadShotContext(shotId)` does the DB reading separately and lazy-requires the database, so payload construction stays testable without I/O.

Three asymmetries are deliberate and must not be flattened:
- **Cardinality** — `voice` and `sfx` are one-context-to-many and return **arrays** (one payload per dialogue line / per cue). A single-object return silently drops everything after the first.
- **Scope** — `music` and `ambient` are scene-scoped and build with **no shot** in context.
- **Sub-types** — `post` has four (`upscale`, `face_restore`, `color_grade`, `composite`); the orchestrated step defaults to `composite`.

Missing prerequisites throw with `err.code = 'PRECONDITION'`; the orchestrator converts that tag into a recorded **skip** rather than burning three retries on a condition no retry can change. Note the orchestrator does not yet persist generation results, so `lipsync` and `post` preconditions cannot be met mid-run — asset persistence is Phase 2 node-handler work.

### Gateway Credential Scope
`provider-media.isGatewayUrl(url)` decides whether a fetch may carry `Authorization: Bearer GRIDLIGHT_API_KEY`. It compares **parsed origins**, never string prefixes: with a gateway of `https://gw.example`, all of `https://gw.example@evil.tld/`, `https://gw.example.evil.tld/` and `https://gw.example-evil.tld/` pass a `startsWith` test while resolving to hosts the operator does not control. Since the URL comes from a provider's response, a prefix check turns any malicious provider into gateway-key exfiltration.

Related: `file-storage.getFilePath()` enforces that a DB-sourced `file_name` cannot resolve outside its project directory, and **throws** rather than silently correcting. `POST /projects/:id/assets` accepts `file_name` unsanitised, and several paths base64 whatever they read into a generation payload, so containment lives at the one function all callers route through.

### Lip-Sync
Combines raw video with dialogue audio to produce lip-synced video. Requires both `video_raw` and `audio_dialogue` assets. Output stored as `data/video/{project_id}/{shot_code}_synced.mp4`.

### Music & Sound Design
Generates music scores, sound effects, and ambient audio. Maps 14 moods to tempo/instruments/energy, 18 locations to ambient sound descriptions, 6 time-of-day modifiers. Stored at `data/music/{project_id}/`.

### Post-Production
Upscaling (Real-ESRGAN), face restoration (CodeFormer), and color grading (LUT presets). Supports individual steps or full composite pipeline. Final output at `data/video/{project_id}/{shot_code}_final.mp4`.

### Pipeline Orchestrator
9-step shot production pipeline: keyframe → video → voice → lipsync → music → sfx → ambient → post → assembly. Dependency resolution, auto-skip (voice/lipsync when no dialogue), retry with exponential backoff (3 attempts, 5s base), pause/resume/cancel support.

### Character Reference Sheets
Generates front/side/back character views via `POST /image` with pose-specific prompts. Stored at `data/refsheets/{project_id}/{character_name}_{view}.png`. Registered as `character_sheet` assets.

### Viseme Tracks
MPEG-4 standard viseme generation from dialogue text. Rule-based English G2P with digraph support maps text → phonemes → 15 visemes (sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, EE, ih, oh, ou). Timed tracks with consecutive-identical merging. Supports audio-aligned adjustment via word timings.

### Multi-Clip Stitching
Splits shots >5s into overlapping sub-clips (500ms overlap) for generation, then stitches back together via `POST /video/stitch`. Supports cross-dissolve, cut, and fade-through-black transitions.

### Audio Mix & Deliverables
Per-shot and per-project audio mixing: dialogue (0dB) + music (-8dB) + SFX (-4dB) + ambient (-12dB). Auto-ducking during dialogue regions (attack 100ms, release 500ms, -8dB reduction). LUFS normalization targets: streaming (-14), broadcast (-24), cinema (-27). Stem export and SRT subtitle generation.

### Smart Scheduling
Optimizes pipeline execution by grouping steps by GPU model to minimize VRAM swapping. Model profiles track VRAM requirements and load times for 10 models. VRAM budget management (default 24GB) with residency suggestions (keep frequent models loaded, evict rare ones).

### QA & Quality Gates
11 automated QA checks across shot/scene/project scopes with error/warning/info severity. Shot checks: keyframe, video, dialogue audio, lipsync, duration. Scene checks: music, ambient, shot completeness. Project checks: timeline, continuity, audio mix. Continuity checker validates lighting consistency and character presence across shots. Acceptance rubric: min 1024×576 resolution, 24fps, -24 to -14 LUFS, h264/h265 codec, 100% shot coverage.

### ProRes/DNxHR Encoding
Professional codec encoding via `POST /postprocess`. Supports ProRes 422 Proxy/LT/Standard/HQ and DNxHR LB/SQ/HQ. Per-shot and batch project encoding with asset registration.

### 3D Asset Generation
Proxies Gridlight `/3d` endpoints to turn characters and props into 3D models. Pure payload builders in `lib/threed-prompt.js` (text→mesh, image→mesh, rig, retexture, animate); route orchestration in `routes/threed.js`. Jobs tracked in `film_3d_jobs`; outputs stored at `data/3d/{project_id}/{name}.glb` and registered in `film_assets` as `asset_type='other'` with `metadata.kind` (`model_3d`/`model_rigged`/`model_animated`) — the `film_assets.asset_type` CHECK could not be widened in place (SQLite can't ALTER a CHECK and the migration runner can't disable FK enforcement inside its transaction), so `film_3d_jobs` is the typed source of truth. Supports per-subject + batch generation with SSE streaming (client-disconnect guarded) and an async job-handoff path (`GET /film/models/job/:jobId`) for slow mesh generation.

### Project Bundle (Export/Import)
Export entire projects as `.tar.gz` archives containing all database rows + asset files (storyboards, audio, video, music, reference sheets). Import on another machine creates new UUIDs for all entities with full foreign key remapping. Bundle format: `manifest.json` + asset subdirectories. Useful for sharing projects, backups, or migrating between machines.

**Env vars:** `GRIDLIGHT_URL` (default `http://localhost:8080`), `GRIDLIGHT_API_KEY` (default `dev-token`)

## Database

SQLite via `better-sqlite3`. Schema auto-migrates on startup (52 migrations).

**Core Tables:**
- `film_projects` — Project metadata + status
- `film_scripts` — Screenplay versions with Fountain content
- `film_scenes` — Extracted scenes with INT/EXT, location, time of day
- `film_shots` — Individual shots with scene card YAML
- `film_characters` — Characters with appearance prompts, LoRA/TI tokens
- `film_locations` — Locations with lighting defaults
- `film_props` — Props with scene assignments
- `film_costumes` — Per-character costumes
- `film_voice_profiles` — Speaker embeddings for TTS
- `render_ledger` — Full render parameter history
- `film_shot_versions` — Version history with thumbnails
- `film_shot_notes` — Direction, revision, approval notes
- `film_milestones` — Production timeline tracking
- `film_assets` — Asset registry (22 types including export formats)
- `film_music_cues` — Score/SFX cues
- `film_color_presets` — LUT/color grade presets
- `film_script_elements` — Fountain element-level queries
- `film_voice_jobs` — Voice generation job tracking
- `film_video_jobs` — Video generation job tracking
- `film_lipsync_jobs` — Lip-sync job tracking
- `film_music_jobs` — Music/SFX/ambient generation jobs
- `film_post_jobs` — Post-production job tracking
- `film_export_packages` — Export package tracking
- `film_pipeline_runs` — Pipeline orchestration runs
- `film_refsheet_jobs` — Character reference sheet generation jobs
- `film_viseme_tracks` — Viseme track data per shot
- `film_stitch_jobs` — Multi-clip stitching jobs
- `film_qa_runs` — QA check run results
- `film_audio_mix_jobs` — Audio mix job tracking
- `film_schedule_runs` — Pipeline schedule optimization runs
- `film_screenplay_comments` — Inline screenplay comments/annotations
- `film_acts` — Act/sequence structure
- `film_subtitles` — Subtitle cues with SRT/VTT support
- `film_audio_deliverables` — Audio deliverable specs (stereo, 5.1, stems, M&E)
- `film_continuity_refs` — Continuity reference board (visual, wardrobe, prop, lighting)
- `film_credits` — Credit roll entries by section
- `film_title_cards` — Title card sequences
- `film_marketing_assets` — Poster, key art, banner, social card assets
- `film_cost_entries` — Budget & cost tracking
- `film_backups` — Project backup metadata
- `film_3d_jobs` — 3D asset generation jobs (text→mesh, image→mesh, rig, retexture, animate)

## Epic Status

All 164 planned tasks (FILM-001 to FILM-164) are complete — backend and frontend.

| Phase | Tasks | Description | Status |
|-------|-------|-------------|--------|
| 1A | FILM-001–010 | Project & Story Foundation | Complete |
| 1B | FILM-082–089 | Production Management | Complete |
| 2 | FILM-011–016 | Character & Asset Registry | Complete |
| 3 | FILM-017–021 | Storyboard Generation | Complete |
| 4 | FILM-022–028 | Voice & Dialogue Pipeline | Complete |
| 5 | FILM-029–035 | Video Generation | Complete |
| 6 | FILM-036–040 | Lip-Sync & Performance | Complete |
| 7 | FILM-090–093 | Music & Sound Design | Complete |
| 8 | FILM-048–051 | Render Ledger & Reproducibility | Complete |
| 9 | FILM-052–058 | Post-Production Pipeline | Complete |
| 10 | FILM-059–064 | NLE Export & Integration | Complete |
| 11 | FILM-065–069 | Desktop App Integration | Complete (web SPA) |
| 12 | FILM-070–072 | Shot Pipeline Orchestrator | Complete |
| 13 | FILM-073–075 | QA & Quality Gates | Complete |
| 14 | FILM-076–081 | Testing & Documentation | Complete (897 tests + ADRs + guide) |
| Screenplay | FILM-094–131 | Screenplay Editor & Writing Tools | Complete |
| Extra | — | Project Bundle Export/Import | Complete |
| 15 | FILM-132–139 | Project Settings & Delivery Formats | Complete |
| 16 | FILM-140–147 | Timeline & Sequencing | Complete |
| 17 | FILM-148–153 | Subtitles & Audio Deliverables | Complete |
| 18 | FILM-154–164 | Production Polish | Complete |

### Architectural Decisions
- No Docker files for agents — proxy architecture (ADR-004) routes to external Gridlight services
- No Neo4j — SQLite-based continuity checking via QA checker
- No Tauri — web SPA architecture instead of desktop wrapper
- Request queuing with semaphore + 429 retry in `gridlight-client.js`

### Frontend (Phases 15-18) — Complete
- FILM-138: Project settings UI (aspect ratio, resolution, fps, color space, delivery presets, aspect preview)
- FILM-143: Transition picker (per-shot in/out transition type + duration in shot detail panel)
- FILM-146: Act management (collapsible acts, drag scenes between acts, unassigned section)
- FILM-147: Shot drag-drop reorder (HTML5 drag-drop on kanban board)
- FILM-155: A/B comparison (split-screen, crossfade slider, parameter diff panel)
- FILM-163: Continuity board (grid by ref_type with filter, icons, tags)
- FILM-164: Budget dashboard (spend vs limit bar, cost breakdown chart, forecast, ledger)

### Not Built (Future)
- Multi-user collaborative editing (requires WebSocket + CRDT infrastructure)
- Video preview player with frame-stepping transport controls

## Development Patterns

### Adding Routes
1. Create handler in `backend/routes/`
2. Import and register in `backend/server.js`
3. Add migration if new table needed in `backend/db/migrations/`

### Adding Migrations
Create numbered SQL file in `backend/db/migrations/` (e.g., `020_add_new_table.sql`). Migrations run automatically on startup via `schema.js`.

### Testing
```bash
# Run all unit tests
node --test backend/tests/*.test.js

# Run individual test files
node --test backend/tests/nle-export.test.js
node --test backend/tests/storyboard-prompt.test.js
node --test backend/tests/dialogue-builder.test.js
node --test backend/tests/video-prompt.test.js
node --test backend/tests/music-prompt.test.js
node --test backend/tests/pipeline-engine.test.js
node --test backend/tests/viseme-builder.test.js
node --test backend/tests/video-stitcher.test.js
node --test backend/tests/audio-mixer.test.js
node --test backend/tests/qa-checker.test.js
node --test backend/tests/scheduling-engine.test.js
node --test backend/tests/fdx-generator.test.js
node --test backend/tests/project-bundle.test.js
node --test backend/tests/gridlight-client.test.js
node --test backend/tests/project-presets.test.js
node --test backend/tests/subtitle-generator.test.js
node --test backend/tests/backup.test.js

# Run integration tests (spawns server with temp DB)
node --test backend/tests/integration.test.js

# Run all tests (unit + integration)
node --test backend/tests/*.test.js

# Health check
curl http://localhost:3100/api/health

# List projects
curl http://localhost:3100/film/projects

# Export EDL for a project
curl http://localhost:3100/film/projects/{id}/export/edl
```

## Screenplay Tasks (FILM-094 to FILM-131)

The screenplay epic provides a full-featured screenplay editor:

**Backend (complete):**
- **Fountain Parser** (FILM-094): `lib/fountain-parser.js` — full Fountain spec AST (~900 lines)
- **Fountain Renderer** (FILM-095): `lib/fountain-renderer.js` — HTML + industry CSS (~400 lines)
- **DB Migrations** (FILM-096): migrations 017 (Fountain storage) + 019 (revisions)
- **FDX Import** (FILM-122): `lib/fdx-parser.js` — Final Draft XML → Fountain (~400 lines)
- **Script API** (FILM-097): `routes/scripts.js` — versioning, element storage, revision tracking (~1000 lines)
- **AI Writing** (FILM-112): `routes/screenplay-ai.js` — brainstorm, write, rewrite, convert modes
- **Text Convert** (FILM-117): `routes/text-convert.js` — prose → Fountain conversion

**Frontend (built in `src/index.html`, ~10,600 lines):**
- **Editor** (FILM-098–101): Contenteditable with Fountain parsing, US Letter layout, element type styling
- **Scene Navigator** (FILM-100, 106): Sidebar with scene outline
- **Title Page** (FILM-128): Editable title/author/draft metadata
- **Revision Tracking** (FILM-129): Colored page indicators, revision history
- **Export** (FILM-121, 124–125): Fountain, plain text, PDF (print dialog)
- **Statistics** (FILM-116–120): Word count, dialogue %, scene counts via `analyzeScreenplay()`
- **AI Chat** (FILM-112): Panel with mode selector (brainstorm/write/rewrite/convert)
- **Suggestions** (FILM-121): Character/location detection from screenplay
- **Keyboard Shortcuts** (FILM-102): Formatting hotkeys with help overlay
- **Auto-save** (FILM-104): Save status indicator with version tracking
- **FDX Export** (FILM-124): `lib/fdx-generator.js` — Fountain AST → Final Draft XML v5
- **Inline Comments** (FILM-126): Add/view/resolve/delete comments anchored to script elements
- **Scene Nav Drag-Drop**: Reorder scenes via drag-and-drop in sidebar
