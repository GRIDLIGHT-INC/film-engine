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
│   ├── mcp-server.js       # MCP stdio server (JSON-RPC, no SDK)
│   ├── preflight.js        # End-to-end readiness report (CLI, exits 1 if blocked)
│   ├── db/
│   │   ├── database.js     # SQLite connection (better-sqlite3)
│   │   ├── schema.js       # Auto-migration runner
│   │   └── migrations/     # SQL migration files (60 migrations)
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
│   │   ├── previs.js           # Previs blocking CRUD + framing solve (Phase 2)
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
│   │   ├── reference-images.js    # Tagged reference plates: data URIs, tags, ≤3 selection
│   │   ├── reference-plates.js    # Location + prop plate generation (shared implementation)
│   │   ├── image-fallback.js      # Walk credentialed image providers on refusal
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
│   │   ├── flow-cost.js          # Projected cost + the budget gate (Phase 3)
│   │   ├── flow-templates.js     # Six ready-made flows, validated at load (Phase 5)
│   │   ├── flow-executor.js      # runFlow / executeNode / resolveNodeInputs (Phase 2)
│   │   ├── node-handlers/        # Per-node execution, autoloaded by filename (Phase 2)
│   │   │   ├── index.js          #   registry (mirrors lib/providers autoload)
│   │   │   ├── port.js           #   the { type, value } envelope an edge carries
│   │   │   ├── input.js          #   in.prompt, in.asset, in.subject, in.scene, in.stock
│   │   │   ├── generate.js       #   all 10 gen.* nodes, one implementation
│   │   │   ├── transform.js      #   tf.mix, tf.stitch, tf.encode
│   │   │   ├── control.js        #   tf.fanout, tf.select
│   │   │   └── output.js         #   out.asset, out.assembly, out.timeline
│   │   ├── flow-graph.js         # Flow graph algebra: validate, cycles, topo, ports (Phase 1)
│   │   ├── flow-node-types.js    # Runtime node-type registry: ports, kinds, arity (Phase 1)
│   │   ├── flow-seed.js          # Built-in flow derived from PIPELINE_STEPS (Phase 1)
│   │   ├── mcp-tools.js          # MCP tool surface, generated from the registries
│   │   ├── previs-camera.js      # Previs optics: FOV, framing distance, DOF (Phase 0)
│   │   ├── previs-blocking.js    # Previs blocking: rigs, movement paths, shot solving (Phase 1)
│   │   ├── previs-primitives.js  # Stage primitives: standing figure, box, sphere (Phase 5)
│   │   ├── previs-pick.js        # Unproject + hit test for direct manipulation (Phase 6)
│   │   ├── nav-flow.js           # Sidebar order, derived from PROJECT_PHASES (Phase 6)
│   │   ├── e2e-preflight.js      # Screenplay→final-shot readiness, derived from PIPELINE_STEPS
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
│       ├── reference-images.test.js    # Tag safety, data URIs, reference selection
│       ├── reference-plates.test.js    # Every referenceable kind can produce a plate
│       ├── image-fallback.test.js      # Image generation survives a provider refusal
│       ├── reference-capability.test.js # Tags only reach providers that can read them
│       ├── previs-storyboard.test.js   # Blocking shapes the keyframe, and round-trips
│       ├── previs-loop.test.js         # Every edge of the storyboard↔previs iteration loop
│       ├── screenplay-to-entities.test.js # A screenplay creates the entities generation reads
│       ├── storyboard-prerequisites.test.js # Plate medium, panel captions, previs over MCP
│       ├── previs-explore-ui.test.js   # Every previs operation has a control on the page
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
│       ├── mcp-tools.test.js             # MCP tool generation, dispatch, JSON-RPC wire
│       ├── previs-routes.test.js         # Previs API + single-file viewer guarantees (Phase 2)
│       ├── previs-to-video.test.js        # Blocking reaches camera_control; unblocked byte-identical (Phase 3)
│       ├── previs-moves.test.js           # Move amounts, sequences, stage primitives (Phase 5)
│       ├── pipeline-readiness.test.js     # Unconfigured projects resolve to credentialed providers
│       ├── readiness-brief.test.js        # The readiness brief covers every capability and stage
│       ├── previs-pick.test.js            # Project/unproject round trip, hit testing (Phase 6)
│       ├── nav-flow.test.js               # Every page in exactly one production phase (Phase 6)
│       ├── previs-camera.test.js         # Optics vs published lens charts (Phase 0)
│       ├── previs-blocking.test.js       # All 18 moves sample, all framings solve (Phase 1)
│       ├── previs-plan.test.js           # 3D previs plan conformance (18 moves, 18 shots, 12 ratios)
│       ├── e2e-readiness.test.js         # Preflight covers every stage screenplay→final
│       ├── fixtures/thirty-second.fountain # 30-second E2E test screenplay
│       ├── phase6-live-runs.test.js       # SSE streaming, orchestrator persistence (Phase 6)
│       ├── flow-branches.test.js         # Fan-out, select gate, budget guard (Phase 3)
│       ├── flow-templates.test.js        # Every template validates (Phase 5)
│       ├── flow-executor.test.js         # Typed-port execution, all 23 handlers (Phase 2)
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
│       ├── providers-anthropic.test.js   # Anthropic adapter (mock server)
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
| Plates | `POST/GET /locations/:id/plate[/generate]`, `POST/GET /props/:id/plate[/generate]` |
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

`AUDIO_LANES` is the single source for which audio elements leave on their own track — dialogue, music, SFX, ambient (`audio_mix` is excluded: it is the finished master, and laying it beside its own stems would double every element). It exists because there were two lists: FCPXML laid out four elements and Premiere XML laid out three, so every Premiere export silently dropped the ambient bed. Nothing failed — the file opened and played, and the missing layer looked like a creative choice. Since finishing now happens in the NLE, a lane that never arrives is work that cannot be done at all.

### Project Settings
Per-project technical settings: resolution (8 presets + custom), frame rate (8 options including 23.976, 29.97), aspect ratio (12 presets including IMAX 1.43:1/1.90:1, anamorphic 2.39:1, Univisium 2:1), color space (sRGB, Rec.709, DCI-P3, Rec.2020, ACES), and 6 delivery presets (Theatrical DCP, IMAX, Streaming HD/4K, Social Media, Broadcast).

### Exploring Shots on the Previs Page
The blocking loop was reachable two ways — raw HTTP, or an MCP tool from an agent host — and both are *conversations about* a shot. Neither is standing at the monitor trying the 85 and then the 24 and knowing, in your eye, which one is the shot. Seven operations existed in `routes/previs.js`; the page offered **two**, solve and save. So a director could compute a framing and store it, and could not seed the stage from what was written, see the frame an angle would generate, keep an angle, or say "this one" in a way the pipeline respects. The interesting half of the tool had no surface.

The toolbar now runs the loop in the order you use it: **From card** (seed the stage from the scene card, asking before it overwrites hand-made blocking — re-seeding is exactly the action that would bin it) → **Solve framing** → **Preview frame** → **Apply to card** → **Approve**. `previsPreviewFrame()` shows the prompt this blocking would generate and **spends nothing**, which is what keeps exploration from being rationed: generating each candidate to find out is how trying three lenses becomes a budget decision. A stale approval is caught here and explained, rather than surfacing later as a 409 the director did not know they had earned.

The generated keyframe is shown over the camera pane, because the question previs exists to answer is whether the shot you staged is the shot you got. An approval badge reads `approved` or `approved · stage changed since`, and the button becomes **Re-approve** or **Withdraw approval** — withdrawing is a normal part of changing your mind and should not need a different screen.

`tests/previs-explore-ui.test.js` is set-based over the operations and checks three separate things per operation: a control exists, it reaches its route, and it is bound to something clickable. The page *did* work for the two it had, so any check written against solve passes in exactly the state this catches — and a handler wired to nothing looks identical to a working page until clicked, which is the bug the flows work shipped once already.

### Storyboard Prerequisites (plate medium, panel, exploring angles)
Three gaps sat between "entities exist" and "a board a director can work from".

**The plate builders decided the medium before the look was mentioned.** Both `buildRefSheetPrompt` and `buildPlatePrompt` appended `style_preset` **last**, behind their own boilerplate — `character reference sheet, front view, full body, T-pose, plain seamless background` leads, and that phrasing asks for a stock asset-library render. MAYA came back a flat vector cutout with a shrug emoji beside her head, and because a plate defines a subject's medium for every frame that references it, `@maya` then dragged whole photoreal streets into cartoon. The location plate had the same bug with weaker boilerplate and came out photoreal, which is why the fault looked like a character problem rather than an ordering one. The style now **leads** in all three builders, and a project with no style still names an explicit medium (`photoreal cinematic …`) — the absence of one is exactly what a model fills in with clip art.

**The panel was a contact sheet.** `GET /projects/:id/storyboard` has always returned `description` and `dialogue` per frame; the viewer rendered the action truncated to **80 characters** and dropped the dialogue entirely. A board that cannot answer "what happens here, and who says what" is not doing the job a board exists for. The frame card now carries the full action, the dialogue (character in caps, line beneath), lens, movement and duration.

**Blocking was unreachable from an agent.** `routes/previs.js` has seven director-facing operations and the MCP surface exposed **none** of them, so the explore-angles loop — the whole point of previs — could only be driven by hand. Seven tools now cover it (`previs_from_card`, `previs_solve`, `previs_set`, `previs_to_storyboard`, `previs_apply`, `previs_approve`, `previs_get`), which makes the iteration loop a conversation: seed the stage from the card, try an angle, preview the payload **without spending anything**, keep the one you want with `previs_apply`, and sign it off with `previs_approve` so a later restage cannot silently ship a frame nobody approved.

`tests/storyboard-prerequisites.test.js` is set-based over three registries — the plate builders, the panel fields, and the previs operations — because each failed partially: locations plated well while characters produced clip art, description reached the panel while dialogue did not.

### Screenplay → Entities (the step that was never wired)
A screenplay upload created **no entity rows at all**. `GET /projects/:id/screenplay/suggestions` detected characters and locations and returned `suggested_action: 'create'`, and nothing ever acted on it — `INSERT INTO film_characters` existed only in the manual CRUD route and the demo seeder. So every character, location and prop had to be typed by hand, and whatever the user forgot was re-invented by the image model on each shot, silently.

Worse, detection only read **dialogue cues** (`el.type === 'character'`). A character introduced in an action line in caps — which is exactly how screenplays introduce one — was invisible. On Wingfall that was the DRAGON, the title creature: never suggested, never created, no description, and therefore a different animal in each of eight frames while the location, which did have a description, stayed rock solid across all of them. The project's `style_preset` contained the words "anatomical beast", which filled the vacuum with a flayed quadruped in the establishing shot the scene card describes as "Empty, ordinary, still."

Three routes close it. `actionIntroducedCharacters()` finds caps entities in action, behind a stoplist rather than a cleverer regex (sluglines, transitions, sounds and camera instructions are also caps); it leans permissive, because a wrong suggestion is declined in a second while a miss is a subject re-invented per shot. `POST /projects/:id/screenplay/suggestions/apply` creates the rows, idempotent on name so a script revision adds what is new rather than duplicating what is there, and it deliberately does **not** invent descriptions — a plausible-but-unauthored placeholder is the thing it exists to replace (`"EXT location (3 mentions in screenplay)"` was reaching image prompts as though it described a place). `POST /projects/:id/entities/describe` then writes what is blank, via the LLM, from the screenplay: a separate pass rather than more fields on the scene-card call, because card parsing is load-bearing and re-runnable matters as a script is revised. It fills **only empty** fields unless forced — a hand-written description is a decision — and reports `still_blank`, since an entity that stays blank generates a bare name and must not look like success.

MCP gains `entities_create`, `entities_describe`, `character_create`, `location_create` and `prop_create` (57 tools). `character_update` and `location_update` both required an existing id and nothing created one, so an agent host could describe entities it was powerless to bring into existence — the reason the manual data entry happened in the first place.

`tests/screenplay-to-entities.test.js` is set-based over the three entity kinds a storyboard prompt reads, because the failure was per-kind and partial: locations worked, characters were half-done, props were absent entirely, and a test written against "the dragon" passes the moment one row exists.

### Storyboard Generation
Transforms scene cards into SDXL-optimized image prompts via the prompt engineering module (`lib/storyboard-prompt.js`). Maps shot types, camera movements, and lighting from scene cards to descriptive prompt tokens. Supports character LoRA/TI injection, style presets (cinematic, noir, anime, documentary, horror, fantasy), and style locking (deterministic seed variation per scene for visual consistency). Images generated via ImageGen API (`POST http://localhost:8080/image`) and stored at `data/storyboards/{project_id}/{shot_code}.png`.

**Env vars:** `IMAGEGEN_URL` (default `http://localhost:8080`), `IMAGEGEN_API_KEY` (Bearer token)

### Reference Images (continuity by picture)
`lib/reference-images.js` carries continuity as **plates** rather than paragraphs. A screenplay upload creates character and location rows that are name skeletons, so every keyframe invented its own subject; filling them with prose helped and then hit Runway's ~1000-character prompt cap, where a described character plus a described location plus an auteur style exceeds 2,000 before the shot action is added. Compressing prose is a treadmill, and the thing being compressed *is* the continuity information.

`gen4_image` takes up to **three** `{uri, tag}` references and lets the prompt name them, so `@maya` replaces 240 characters of wardrobe — exact instead of approximate, and the prompt drops from ~500 to ~270 characters. Three constraints shape the module: **three references maximum** (a fourth is a validation failure, so a whole batch fails together); **the provider cannot read our disk**, so local plates are inlined as base64 data URIs; and **tags are substituted into prompt text**, so they are bare lowercase words with collisions resolved centrally — two characters slugging to `maya` would make one silently shadow the other, which is the same wrong-subject bug one level down.

Selection ranks identity before place before everything else, because a viewer notices a different face long before a different porch. A subject with no plate falls back to its prose description, so a project that has never generated a reference sheet behaves exactly as before. `applyConsistencyToImagePayload` defers to references the route already attached rather than replacing them — a prompt carrying `@maya` with no matching image is strictly worse than having used prose.

Plates are generated per subject: characters through `POST /characters/:id/refsheet/generate` (a three-view turnaround — front/side/back — because identity needs one), locations and props through `POST /{locations,props}/:id/plate/generate` (a single establishing or product plate; a location has no side view). Locations and props share **one** implementation in `lib/reference-plates.js` — duplicating a generator per subject type is how the character path acquired a moderation fallback and a style fix the others would not have inherited. Migration 061 adds `film_assets.prop_id`, without which a prop plate had nowhere to link and the gather query could never find one.

A project's `style_preset` is applied to plates and **dropped on a provider moderation refusal**, reported as `style_applied: false` rather than silently: a look written for the film can be refused when it lands beside a literal subject description, and a director told nothing would believe their look was anchored when it was not. A location plate is framed deliberately empty of people — the plate defines the place, and a figure in it would be re-described by every shot that references it.

`lib/image-fallback.js` walks the credentialed image providers instead of betting a shot on one. Three adapters serve `image` (gridlight, openai, runway) and the pipeline used whichever `resolveGenerator` returned — so when Runway declined a prompt on moderation, all eight shots failed together while two other providers sat untried. That refusal is **not deterministic**: the same prompt for the same shot passed and then failed minutes apart, which makes "the provider said no" a condition to route around rather than a verdict on the shot, and is why this is a chain rather than a retry — re-sending to the same provider bets on a coin flip.

The project's explicit choice always leads (the chain never re-decides which provider a production uses), each provider is tried at most once so worst-case spend is bounded by the registry rather than a retry count, and a **malformed** request is never replayed — a 400 on a bad ratio is ours and would buy three identical failures and three bills. Exhaustion wording differs per provider ("no credits remaining" vs "do not have enough credits"), so matching one phrasing stopped the chain at the first empty account; `isRefusal` is pinned against every wording seen in practice. Failures report the whole walk, so a blocked shot names what each provider needs rather than only the first.

### Voice & Dialogue Pipeline
Extracts dialogue from scene cards, matches characters to voice profiles, and generates speech audio via `POST /voice`. Supports per-shot and batch generation with SSE streaming. Audio stored at `data/audio/{project_id}/{shot_code}_{character}_{index}.wav`.

### Video Generation
Builds video generation payloads from storyboard keyframes + scene cards. Maps camera movements to `camera_control` objects (18 movement types). Uses storyboard keyframe as `init_image`. Videos stored at `data/video/{project_id}/{shot_code}.mp4`.

### 3D Previs Camera (phases 0–3, 5–6 built)
A 3D stage for blocking a shot — ground plane, subject, camera with real lens and aperture — before it goes to video generation.

**Phases 0–1 are built.** `lib/previs-camera.js` is the optics (FOV, framing distance, depth of field, hyperfocal) as pure functions with no I/O, checked against published lens charts rather than against itself — full frame 50mm computes to 39.6° and focusing at hyperfocal yields exactly H/2 → ∞. `lib/previs-blocking.js` is blocking as data: 9 rigs with movement affordances, all 18 movement paths, and `solveShot()`, which turns "close-up on a 50" into a camera 1.21 m from the subject. Scene cards gained optional `camera.sensor`, `aperture`, `focus_distance_m` and `height_m`; `lens` stays a free string so every existing card still validates. **Phase 2** adds the API and the viewer: migration 058 (`film_previs_blocking`, `UNIQUE(shot_id)`, storing the movement **sampled to keyframes** rather than the parameters it came from), `routes/previs.js` (blocking CRUD, `POST /shots/:id/previs/solve`, `GET /previs/taxonomy`), and a Previs page in the SPA with a stage view and a camera view. The renderer is hand-rolled canvas 2D — a 4×4 projection and a polygon painter — for the same reason the flows canvas rejected React Flow: `build.target: single-html` and no bundler. The camera pane is not a second renderer, it is the same projection evaluated from the camera's transform, given the real vertical angle of view for its lens and sensor. The camera pane models the **delivered** frame, not the gate: 2.39:1 out of a 1.33:1 Super 35 sensor is width-limited, so the vertical angle is cropped and a close-up solved for 0.45m of subject height delivers 0.25m. Both numbers are shown, because `solveShot` frames against the sensor and a director reading one would frame loose. Errors block a save; **warnings do not** — telling a director a slider cannot crane is useful, refusing to save it is not. **Phase 3** makes blocking reach generation. `loadShotContext()` carries `ctx.previs`, so previs travels the **one** payload path and the orchestrator cannot describe a shot differently from the per-domain route; `buildVideoPrompt` adds `path` and `rig` to `camera_control` and leaves `type`/`intensity` exactly as the movement enum defines them. A stored path always wins over resampling — it is what was approved in the viewer. `POST /shots/:id/previs/to-video` previews the whole payload the generator would receive. The byte-identical guarantee for unblocked shots is pinned by `tests/fixtures/video-payload-golden.json`, 54 payloads captured from the code as it stood **before** phase 3; regenerating that fixture would delete the guarantee. **Previs and the storyboard are the same decision seen twice.** Blocking reached the *video* payload only, so a director could solve a close-up on a 50 — a camera 1.21 m from the subject — and then generate a keyframe from the scene card's text as though none of it had happened: the frame they approved was not the frame they blocked, and the difference surfaced later in the video pass. `image(ctx)` now carries `ctx.previs`, and `previsPromptParts()` expresses blocking in the prompt's own vocabulary (framing, focal length, camera height as angle, movement, and the solved distance — the number that makes framing a measurement rather than a word). **Blocking wins over the card**: the card is what was written, the blocking is what was staged and approved. The round trip closes with `POST /shots/:id/previs/apply`, which writes only the camera facets the stage actually determines back onto the scene card so description, characters and dialogue survive; `POST /shots/:id/previs/to-storyboard` previews the image payload the way `/to-video` previews the clip.

**Phase 5** makes moves measurable and the stage populated. Every movement now declares a `unit` (`m`/`deg`/`ratio`) and a `defaultAmount` **derived from its own vector**, so "dolly in two metres" is sayable where only an abstract 0–1 intensity existed; omitting the amount reproduces the old path exactly, which is what keeps blockings saved earlier unchanged. `sampleSequence()` runs compound moves leg by leg, each starting where the last ended, weighted by time. In a sequence an explicit amount **is** the magnitude — the movement's default intensity does not also scale it, or asking for 15° would give 7.5°. `lib/previs-primitives.js` adds a standing figure (8 boxes on life-drawing proportions, scaled so a 1.7m figure measures 1.7m), plus boxes and spheres; all rest **on** the floor at their position rather than being centred on it. Migration 059 stores legs and objects additively. **Phase 6** makes the stage editable and the menus follow the film. `lib/previs-pick.js` inverts the projection — screen point back to a point on the floor — so objects are dragged rather than typed; the round trip is asserted over four camera poses, because the obvious wrong inverse (a sign flip on the up axis) is correct for a level camera and only wrong once you tilt. Picking returns the **nearest** object, so clicking never edits something hidden behind what you are looking at, and a figure's pick box comes from its proportions rather than a typed width its arms reach past. Objects are also finally drawn in the camera pane — they were missing from the one view that answers "is it in the shot".

**The framing subject is no longer a box of its own.** It duplicated a silhouette and carried a height unrelated to the figure actually staged, so it became a *pointer*: `resolveTarget()` picks whichever staged object is marked, falling back to the first placed, and to a floor mark when the stage is empty (framing on empty space is real — a doorway, a mark for an actor). The target object is drawn pink and its own height is the subject height.

Moves carry a **duration** (migration 060), defaulting to the shot's own `duration_ms` — a 1.5m push over 1s is a lunge, over 8s a creep, and the geometry is identical. `legTimings()` splits it by weight and reports pace in the movement's own unit (m/s for a dolly, deg/s for a pan). Legs marked `with` run **concurrently**: `sampleGroup()` samples each from the same start pose and composes their deltas — translations add, rotations add, focal lengths multiply — so a push-while-panning is one move sharing one time slice, and a dolly-zoom comes out right. Chaining poses instead would zoom a camera that had already moved, which is a different shot.

**Playback interpolates.** It used to snap to the nearest keyframe, so a 24-key path repainted at 60fps moved 24 times and stood still between — every movement stepped, not just short ones, and a pull-out (30cm default travel) hopped 12mm at a time. `poseAt()` reads a pose at any moment by mixing the bracketing keys, so how densely a path was sampled is a storage decision rather than something visible in the shot. Legs also carry an `ease` (`linear` default, plus in/out/in-out): a move that starts and stops instantly has no dropped frames and is mechanical in every other sense.

A gesture is interpreted through the projection it **started** in, frozen at mousedown. The orbit focuses on the framing subject and the subject is now one of the staged objects, so dragging the target moved the camera, which changed the unprojection, which moved the object further — equal mouse steps produced 0.45m, 0.88m, 1.30m, 1.70m, 2.08m. A feedback loop, not a sensitivity problem.

Objects are dragged on the floor, selected by clicking (nearest wins), placed by double-clicking empty floor and removed with Delete. The **image card** primitive stands a generated keyframe, character sheet or reference image in the scene as a cutout: fixed in world space rather than billboarded, so it goes edge-on as you orbit, which is the truth about a flat stand-in. Canvas 2D has no perspective texture map, so the quad is split into two triangles and each affine-mapped — exact at the corners, imperceptibly wrong along the diagonal.

**The storyboard and the stage are now a loop, not a hand-off.** Blocking reached the image payload, but through a shape nothing produced: `previsPromptParts` read `previs.focal_mm` / `shot_type` / `distance_m`, while `loadShotContext` supplies the stored geometry — `previs.camera.focalMm`. Only `movement` matched, and because the camera facets were swapped as a GROUP, a blocked shot lost the card's framing and lens and was described by its movement alone. Blocking a shot made its keyframe *vaguer* than leaving it alone, and every test passed because each one hand-built the flat shape. `previsFacets()` now converts stored blocking into prompt facts in one place, deriving framing by inverting the optics — `frameCoverage` at the camera's real distance, matched to the nearest `SHOT_TYPES.subjectHeightM` — so the framing is what the lens actually covers rather than a label that goes stale the moment someone drags the camera. Facets merge **per facet**: blocking wins where it has an opinion, the card fills the rest.

Three edges closed the loop. `POST /shots/:id/previs/from-card` seeds the stage from the written shot (`/solve` took `shot_type` and `focal_mm` from the request body, so a card already saying "close-up on a 50" had to be retyped); it refuses to overwrite hand-made blocking without `overwrite`. `GET /shots/:id/previs` now returns the shot's own `keyframe` with a servable `src`, so the frame you generated can stand in the stage as an `imageplane` while you restage against it. And approval became a fact rather than a vocabulary: `film_shots.status` has always permitted `'approved'` and no generation path ever read it. `POST /shots/:id/previs/approve` stores a **fingerprint** (migration 062) of the camera, rig, movement, staged objects and the card's camera — not the sampled path, which is derived and would make a re-sample read as a creative change. That makes "approved" and "approved as it is now" different questions, which is the one distinction an iterate-until-happy loop turns on: `/to-video` and `/to-storyboard` refuse with **409 STALE_APPROVAL** when a shot was signed off and then restaged, overridable with `ignore_approval` exactly as the budget gate is. A shot that was never approved has no fingerprint and generates exactly as before.

`tests/previs-loop.test.js` is set-based over the loop's eight **directed** edges, because direction is the identity: `blocking → card` existing says nothing about `card → blocking`, and it was the second that was missing while the pair was called a round trip.

`lib/nav-flow.js` regroups all 34 pages into the nine `PROJECT_PHASES` the status machine already declares, so the sidebar and the phase a project reports itself in cannot disagree. Served over `GET /film/nav-flow`; the SPA **moves** the existing buttons rather than rebuilding them, keeping every tooltip and handler. Phase 4 (`.glb` subjects) remains designed only.

Design: [`docs/plans/previs-camera-implementation-plan.md`](docs/plans/previs-camera-implementation-plan.md), [`previs-camera-research.md`](docs/plans/previs-camera-research.md), machine-readable taxonomy in [`previs-camera-taxonomy.json`](docs/plans/previs-camera-taxonomy.json), conformance enforced by `tests/previs-plan.test.js`.

The vocabulary is already in the code and the plan must cover all of it: 18 `VALID_CAMERA_MOVES`, 18 `VALID_SHOT_TYPES`, 18 `CAMERA_CONTROL_MAP` entries, 12 `ASPECT_RATIO_IDS`. Two findings recorded there: `VALID_SHOT_TYPES` mixes three independent axes (framing from lens+distance, angle from height+pitch, rig from motion path), and six of the eighteen movements are the same 3D transform — `dolly-in`/`tracking-forward`/`push-in` all translate camera-local −Z — so the vocabulary has twelve distinct transforms, not eighteen. Neither matters to a text prompt; both are load-bearing in 3D.

Phases 0–3 need no 3D library (canvas 2D and a 4×4 matrix pipeline, same call as the Flows canvas rejecting React Flow against `build.target: single-html`). Only phase 4 — loading the actual generated `.glb` as the subject — needs Three.js, and that gets its own ADR.

### End-to-End Preflight
`node backend/preflight.js [project-id] [--no-dialogue] [--json]` answers one question: can a screenplay reach a finished shot **right now**? It checks all 15 stages from project creation to NLE export — the 9 `PIPELINE_STEPS` derived from code, plus breakdown, script parse, shots, audio mix and export — and exits non-zero if any is blocked, so it can gate a run rather than just describe one. It generates nothing; it reads config and opens sockets.

The failure it exists to catch: `resolveGenerator()` falls back to Gridlight when a project's `provider_config` names a provider that no longer exists, so a dead configuration **resolves successfully** and only fails at generation time. The preflight compares what the config asks for against what would actually run and reports the gap.

**Finishing happens in the NLE.** Lip-sync, post/grade and the audio mix are performed in Premiere (or by a third-party lip-sync provider) against the exported lanes, not generated in-engine — they have no adapter but Gridlight, which does not implement `/lipsync`, `/postprocess` or `/audio/mix`. The preflight reports them as `NLE`, not blocked. That exemption is only honest because the export carries the material: `AUDIO_LANES` in `lib/nle-export.js` is the single list of elements that leave on their own track, and `tests/nle-export.test.js` iterates it to prove each one lands in both FCPXML and Premiere XML. Pass `--in-engine` to hold those three to a real provider instead.

Capability coverage as it stands:

| Capability | Providers that serve it |
|---|---|
| llm, image | openai, gridlight (image also: runway) |
| video | runway, gridlight |
| music, voice, sfx, ambient | elevenlabs, gridlight |
| lipsync, post | **gridlight only** |
| model3d | meshy, gridlight |
| stock | **none** |

Test screenplay for an end-to-end run: `backend/tests/fixtures/thirty-second.fountain` — one location, one speaking character, ~30 seconds, sized to exercise every step at the lowest cost.

### MCP Server
`backend/mcp-server.js` exposes the flows engine to agents over MCP (stdio, JSON-RPC). Run it with `node backend/mcp-server.js` — a client spawns it; it does not talk to a human.

The tool list is **generated, never enumerated** (`lib/mcp-tools.js`), in three sets:

- **One tool per node type** — `node_<type>`, e.g. `node_gen_image`, built by iterating `NODE_TYPES` in `lib/flow-node-types.js`, the same registry the canvas palette reads. Input schemas are derived from each node's declared ports, so a new node type becomes a correctly-typed MCP tool with no edit here. Execution goes straight to `handlerFor(type).execute()`, with context from the run routes' own `runContext()`.
- **One tool per shipped flows route** — `flow_list`, `flow_run`, `flow_estimate`, and so on, dispatched *through* `handleFlows` via an in-process request shim rather than reimplemented. One budget gate, one validator, one set of bugs. `runFlowStreamRoute` is the single deliberate omission (`SSE_EXCEPTION`): a `tools/call` returns one result, so a stream has nothing to add over `flow_run`.

- **One tool per pre-production route** — `script_get`, `scene_list`, `shot_create`, `character_update`, `location_update`, `project_update`, `storyboard_generate` and the rest (`PRODUCTION_TOOLS`, 12). These exist because a flows-only surface let an agent **run** generation while being unable to give it anything to be consistent about: a parsed screenplay leaves `appearance_prompt` as an empty string and a location's description as `"EXT location (3 mentions)"`, so `buildStoryboardPrompt` looks both up, finds nothing to inject, and every keyframe invents its own character on its own street. The fix is filling those records before generating — agent work the flows tools could not reach. Dispatch is the same in-process shim, generalised to take the route handler, so validation, scene-card checking and asset registration behave exactly as they do over HTTP.

This is also how the LLM reaches the pipeline **without an API key**: an agent host (Claude Desktop, claude.ai, ChatGPT) connects to this server, and the model's own subscription does the reasoning while Film Engine keeps ownership of the data and the media. There is no Claude or ChatGPT MCP server exposing *inference* — those are MCP clients — so the connection only works in this direction, which is also the one that keeps assets in `film_assets` rather than in a chat.

`tests/mcp-tools.test.js` iterates both registries in both directions — a node type without a tool, a tool without a registry entry, a router handler without a tool, or a tool whose route does not actually dispatch all fail. Route results are unwrapped before reaching the model (`presentResult`), keeping the HTTP status only when it explains a refusal, since a 402 budget rejection a model reads as "failed" is a call it will retry unchanged.

**No SDK.** Hand-rolled JSON-RPC over newline-delimited stdio: four methods, and `@modelcontextprotocol/sdk` would be a larger surface than the thing it wraps. Same reasoning as [ADR-002](docs/adr/002-vanilla-http-no-framework.md); the backend still has exactly one dependency.

**Env vars:** `FILM_DATA_DIR` — the database the server reads/writes; defaults to the HTTP server's, so both see one project set.

### Providers (pluggable generation backends)
Capabilities (`llm`, `image`, `video`, `music`, `voice`, `sfx`, `ambient`, `lipsync`, `post`, `model3d`, `stock`) each resolve to a provider adapter: per-project `provider_config` → `PROVIDER_<CAP>` env → **`PREFERRED_WHEN_CONFIGURED`** → Gridlight default.

That preference table was consulted on every resolve, documented, and **empty**, so it never fired: a project created with no config pointed all eleven capabilities at a local Gridlight service whether or not it was running and whether or not a credentialed hosted adapter sat in the registry beside it. The only symptom was a connection refused at generation time, per capability. It is now populated for the eight capabilities that have a hosted adapter, applies only when that provider actually holds a credential, and is still overridden by an explicit per-project choice. `defaultProviderConfig()` writes the same choice into new projects so Provider Settings shows what generation will really use. Adapters live in `lib/providers/` and are auto-loaded by filename, so adding one never means editing the registry.

**Runway** (`lib/providers/runway.js`) serves `video` + `image`. Unlike the other generators it is asynchronous: `POST /v1/{image_to_video,text_to_video,text_to_image}` returns a task id, and the adapter polls `GET /v1/tasks/:id` to completion so routes still see a finished asset. Video defaults to `gen4.5` (2–10s, ratio snapped to a documented value), images to `gen4_image`.

**Env vars:** `RUNWAY_API_KEY` (or Runway's own `RUNWAYML_API_SECRET`), `RUNWAY_BASE_URL` (default `https://api.dev.runwayml.com/v1`), `RUNWAY_VIDEO_MODEL`, `RUNWAY_IMAGE_MODEL`, `RUNWAY_POLL_INTERVAL_MS`

**Anthropic** (`lib/providers/anthropic.js`) serves `llm` — `POST /v1/messages`, auth by `x-api-key` plus a pinned `anthropic-version` (not a Bearer token), default model `claude-opus-5`. Raw `fetch` rather than `@anthropic-ai/sdk`: the Messages API is one endpoint and the backend has exactly one dependency, so an SDK for a single adapter would reverse a deliberate stance ([ADR-002](docs/adr/002-vanilla-http-no-framework.md)). It lifts the system prompt into the API's own `system` field rather than concatenating it into the question, and treats `stop_reason: "refusal"` — an HTTP 200 with empty or partial `content` — as a result rather than reading `content[0]` blindly.

`llm` is preferred here while Gridlight's `/chat/intelligent` is unusable: that endpoint routes every question through `build_unified_query`, and all six of its routes reach Qdrant or Neo4j before a model, so with no vector store running it 500s on `vector length 768 != expected 0` regardless of payload.

**Env vars:** `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_LLM_MODEL`

**ElevenLabs** (`lib/providers/elevenlabs.js`) serves `voice` + `sfx` + `ambient` + `music` — `POST /text-to-speech/:voiceId`, `POST /sound-generation` (one-shot), `POST /sound-generation` with `loop: true` on `eleven_text_to_sound_v2` (ambient beds), and `POST /music` (`music_v2`, 3s–10min, instrumental by default since film cues are underscore). All return raw audio bytes, so results are Buffers written straight to disk.

Ambient is a **loop, not a full render**: `buildAmbientPrompt` asks for a bed of at most 30s (`duration_s`) and records the length it must cover (`bed_duration_s`), then `buildMixPayload` emits `loop`/`loop_until_ms`/`loop_crossfade_ms` so the mix service tiles it across the shot. A mix service that ignores those fields will play the bed once and leave the rest dry.

No licensed-catalog *source* adapter ships today, so `stock` has no provider at all — nothing writes `film_assets.license_source = 'licensed_catalog'`, which the music-rights routes are built around. The `source` (search/license) contract and the OAuth/MCP connect flow both remain wired for the next provider that needs them.

### Live Runs & Orchestrator Persistence (Phase 6)
`POST /film/flows/:id/run/stream` reports progress over SSE — `node_start` / `node_complete` per node, then a terminal event — because a fan-out is minutes of generation and a blocking response tells the user nothing until it is too late to stop. Same executor, callbacks wired to the response, so there is no second graph walk to drift. Every write is guarded on the client still being connected, and a client hanging up is treated as cancellation.

**The orchestrator now saves what it generates.** `routes/pipeline.js` called generators and discarded the results, so an orchestrated run produced no assets at all — which is why `lipsync` and `post` could never find their inputs and skipped. `persistStepResult()` stores each step's output and registers it in `film_assets`; a step that generated but could not save is reported **failed**, because a "complete" pipeline with no output is the worse outcome.

Two latent defects surfaced once steps could fail: `film_pipeline_runs` never permitted the `completed_with_errors` status its own code writes (so any partially failed run 500'd), and the audio asset types are `audio_music`/`audio_sfx`/`audio_ambient` rather than the bare names. Both are now guarded set-based against the schema's own vocabulary.

### Variants & the Budget Guard (Phase 3)
`tf.fanout` runs **once** and declares the branches its dependants run across, so no generator handler ever has to know it is being fanned — the executor replays everything downstream per branch key. Branches are rows (`film_flow_branches`), not in-memory state, so a paused gate survives a restart and cost can be attributed per variant. `tf.select` **pauses** the run when more than one branch reaches it; auto-selecting would make the gate decorative.

**The budget guard runs before anything generates.** A fan-out of 4 across a 200-shot feature is 800 calls, and a ceiling you discover on the ledger afterwards is not a ceiling. `lib/flow-cost.js` projects cost per capability, multiplying (not adding) along nested fan-outs, and the run is refused with **HTTP 402** if projected + already-spent exceeds `film_projects.budget_total`. An unset budget is unlimited, never an accidental ceiling of zero. The refusal is overridable via `ignore_budget`, because a wrong estimate must not make the feature unusable — but the user has to say so.

### Built-in Templates (Phase 5)
Six ready-made flows — prompt→image, multi-model video, character sheet, shot→clip, dialogue→lip-sync, scene soundscape — as **data**, so they stay versioned with the code and `validateGraph()` polices them at module load rather than at first use by whoever picked the broken one. Multi-model video fans across three providers; character sheet fans across four views driven by the subject's consistency profile.

### Flows Canvas (Phase 4)
A hand-rolled SVG canvas on the `flows` sidebar page — no graph library, because `gridlight.json` pins `build.target=single-html` and the SPA has no bundler, so a React-based canvas would mean adding a build system to ship one page.

Left: the node palette, served from `GET /film/flows/node-types` so the UI can never offer a node the server would refuse. Middle: pan/zoom canvas with draggable nodes and typed bezier edges, colour-coded per port type. Right: an inspector for the selected node, including a **per-node provider and model override** — the multi-model claim, exposed where you'd expect it.

Node geometry puts ports below a header band; laying them across the full node height put the first port label on the same baseline as the title and the two overlapped. Illegal wirings are refused as you draw (`text → video` will not connect), but the server still validates on save — the client check is convenience, not the guarantee. Built-in flows render read-only with a duplicate-to-edit path. Running paints per-node status onto the canvas, and a failed run lists which node failed and why.

### Flow Graphs (Phase 1)
The pipeline was always a DAG — it was just a module-level constant nobody could edit. `film_flows` / `film_flow_nodes` / `film_flow_edges` make it data, and `lib/flow-seed.js` seeds the existing 9-step pipeline as a read-only built-in flow **derived** from `PIPELINE_STEPS` rather than transcribed beside it, so a new step reaches the canvas with no migration.

`lib/flow-graph.js` is pure algebra — `validateGraph`, `detectCycles`, `topoSort`, `nextNodes`, `graphFingerprint` — with no DB or HTTP, mirroring the `pipeline-engine.js` / `routes/pipeline.js` split. `nextNodes()` deliberately matches `getNextSteps()` so the seeded flow walks in **lockstep** with `PIPELINE_STEPS`; that equivalence is what makes Phase 1 a provable no-op rather than a rewrite anyone has to trust.

Ports are typed (8 types) and most carry exactly one value, so the executor never arbitrates. The exception is **collector ports**, declared per node type as `multiInputs`: a final mix genuinely takes music, sfx and ambient at once, which the real pipeline does at `assembly`. Cycle detection runs on save and before every run — the hard-coded DAG was acyclic because a human checked once; a user-authored one is acyclic only if something checks every time.

Built-in flows are immutable through the API (the UI offers duplicate-to-edit), which keeps the equivalence guarantee true permanently. A flow with `project_id IS NULL` is a **library** flow, visible from every project — "save it once, reuse it across every project".

### Flow Execution (Phase 2)
`lib/flow-executor.js` generalises `routes/pipeline.js:executeStep`. The shape is deliberately the same — capability in, provider result out — and the one real change is that **inputs arrive as an argument** instead of being re-read from the database. That is what an edge carrying a value means in practice.

Node handlers autoload by filename from `lib/node-handlers/`, the same pattern as `lib/providers/`, so adding a node type is one new file and never an edit to a central switch. All ten `gen.*` types share **one** implementation, because the capability is data on the node type — which is also what delivers per-node model choice for free.

`out.asset` closes the gap carried out of Phase 0: the legacy orchestrator called generators and discarded the results, so an orchestrated run produced no assets at all. Handlers own persistence now, and `film_flow_runs.graph_snapshot` stores the graph **as run**, so a render-ledger entry cannot be invalidated by someone editing the flow afterwards.

Validation runs before anything executes — a cycle would otherwise spin the frontier forever, after billing you for whatever generated first.

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

SQLite via `better-sqlite3`. Schema auto-migrates on startup (60 migrations).

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
node --test backend/tests/reference-images.test.js
node --test backend/tests/reference-plates.test.js
node --test backend/tests/image-fallback.test.js
node --test backend/tests/reference-capability.test.js
node --test backend/tests/previs-storyboard.test.js
node --test backend/tests/previs-loop.test.js
node --test backend/tests/screenplay-to-entities.test.js
node --test backend/tests/storyboard-prerequisites.test.js
node --test backend/tests/previs-explore-ui.test.js
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
node --test backend/tests/mcp-tools.test.js
node --test backend/tests/e2e-readiness.test.js
node --test backend/tests/previs-plan.test.js
node --test backend/tests/previs-camera.test.js
node --test backend/tests/previs-blocking.test.js
node --test backend/tests/previs-routes.test.js
node --test backend/tests/previs-to-video.test.js
node --test backend/tests/previs-moves.test.js
node --test backend/tests/pipeline-readiness.test.js
node --test backend/tests/readiness-brief.test.js
node --test backend/tests/providers-anthropic.test.js
node --test backend/tests/previs-pick.test.js
node --test backend/tests/nav-flow.test.js

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
