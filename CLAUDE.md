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
│   │   └── migrations/     # SQL migration files (72 migrations)
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
│   │   ├── production-reports.js # Staleness, sides, DOOD, run plan, breakdown summary (reports)
│   │   ├── mood-board.js       # Look development: references → style preset
│   │   ├── annotations.js      # Markup on a storyboard frame (arrows, shapes, notes)
│   │   ├── providers.js        # Provider registry, credentials, OAuth connect
│   │   ├── consistency.js      # Consistency profiles, locking, readiness audit
│   │   ├── takes.js            # Takes & selects (circle-take workflow)
│   │   ├── timeline.js         # Timeline assembly + reordering
│   │   ├── jobs.js             # Unified job queue view across pipelines
│   │   ├── budget-estimate.js  # Pre-flight cost estimation
│   │   ├── app-settings.js     # Settings that belong to the person, not the project
│   │   ├── events.js           # SSE: tell the page when another process wrote to the database
│   │   ├── story-bible.js      # What things ARE, and which entity was written from which section
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
│   │   ├── annotation-prompt.js   # Markup a director drew, said in words a model can act on
│   │   ├── shot-anchor.js        # The frame you are currently shooting from
│   │   ├── shot-references.js    # The plates a shot generates with, gathered once for every path
│   │   ├── artefact-fingerprint.js # What a generated artefact was made from (staleness)
│   │   ├── screenplay-drift.js    # Which shots a rewrite left behind, and what was built on them
│   │   ├── impact.js              # One change, all the way down: redo now vs waiting on something above
│   │   ├── scene-splice.js        # Replace one scene in a screenplay, byte-identical elsewhere
│   │   ├── story-bible.js         # Bible sections, and the link back from what was written from them
│   │   ├── subject-scale.js       # How big a thing is, said so an image model can act on it
│   │   ├── home.js                # The six blocks the home page renders, all derived
│   │   ├── production-reports.js  # Sides + DOOD, over repaired scene presence
│   │   ├── run-plan.js            # Strips, model-swap ordering, projected cost (above the orchestrator)
│   │   ├── look-development.js    # Style presets carry a look, not a subject
│   │   ├── board-grouping.js      # Board groups for reading, setups for working
│   │   ├── conform.js             # Shots → one film: pure plan, probed executors
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
│       ├── glb-parser.test.js          # A synthetic .glb parses, transforms apply, decimation bounds hold
│       ├── spec-consumption.test.js    # Every mood board spec changes a real payload, not just a column
│       ├── shot-card-edit.test.js      # A scene card can be edited, merged not replaced, and goes stale
│       ├── script-revision.test.js     # Revising a story does not cascade the production away
│       ├── screenplay-drift.test.js    # A rewrite flags the shots written from the old draft
│       ├── impact.test.js              # A changed frame warns that the footage built on it is behind
│       ├── mcp-no-server-llm.test.js   # No MCP tool hands the reasoning back to a server-side LLM
│       ├── scene-edit.test.js          # One scene changes; every other scene survives byte-identical
│       ├── live-events.test.js         # Another process's write reaches the page; our own does not
│       ├── story-bible.test.js         # A section revised flags only what was written from it
│       ├── subject-scale.test.js       # Nothing is invented; every surface can set a size
│       ├── nav-chrome.test.js          # Global actions in the top bar; nothing orphaned by moving them
│       ├── home-page.test.js           # Six design blocks: each renders, is fed, and is served
│       ├── app-settings.test.js        # Author is set once; the title page is printed, not edited inline
│       ├── artefact-staleness.test.js  # All 12 generated kinds fingerprint and notice input changes
│       ├── production-reports.test.js  # Sides + DOOD, and neither omits a non-speaking character
│       ├── run-plan.test.js            # Strip ordering, dependency safety, cost, budget refusal
│       ├── look-development.test.js    # A style preset naming a subject is caught, real styles are not
│       ├── shot-tagger.test.js         # A screenplay line becomes a shot, with who is in it
│       ├── mood-board.test.js          # The board composes a style preset, and warns about subjects
│       ├── storyboard-annotation.test.js # Every shape round-trips; markup survives regeneration
│       ├── annotation-feedback.test.js # Marks steer a prompt only when asked, and say when they cannot
│       ├── shot-anchor.test.js   # One anchor, held deliberately; it carries the set and replaces the plates
│       ├── board-grouping.test.js      # Every axis groups the whole board; setups share conditioning
│       ├── look-specs.test.js          # Board specs reach previs and project settings; images become references
│       ├── conform.test.js             # Every shot contributes one clip; a missing shot refuses
│       ├── project-delete.test.js      # A worked-on project deletes, and takes every child with it
│       ├── prompt-budget.test.js       # Plates are photographs, not documents; prose drops only where tags bind
│       ├── provider-prompt-limit.test.js # Each provider's own ceiling; allowances scale with it
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
│       ├── screenplay-port.test.js     # The screenplay port plan, held to the code it describes
│       ├── scene-append.test.js       # A chapter is added without disturbing a byte above it
│       ├── scene-insert.test.js       # A scene goes in the middle without rewriting the tail
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
| Projects | `GET/POST /projects`, `GET/PUT/DELETE /projects/:id`, `GET/PUT/DELETE /projects/:id/anchor` |
| Scripts | `POST /projects/:id/script[/append\|/insert]`, `GET /projects/:id/scripts[/:ver]`, `PUT /projects/:id/script/:ver` |
| Scenes | `GET /projects/:id/scenes`, `GET/PUT/DELETE /scenes/:id` |
| Bible | `GET/PUT /projects/:id/bible`, `DELETE /projects/:id/bible/:section`, `GET /projects/:id/bible-drift` |
| Shots | `POST /shots`, `GET /projects/:id/shotlist`, `GET/PUT/DELETE /shots/:id`, `GET /card-vocabulary` |
| Characters | `GET/POST /projects/:id/characters`, `GET/PUT/DELETE /characters/:id` |
| Locations | `GET/POST /projects/:id/locations`, `GET/PUT/DELETE /locations/:id` |
| Plates | `POST/GET /locations/:id/plate[/generate]`, `POST/GET /props/:id/plate[/generate]` |
| Props | `GET/POST /projects/:id/props`, `GET/PUT/DELETE /props/:id` |
| Notes | `GET/POST /shots/:id/notes`, `PUT/DELETE /notes/:id`, `POST /shots/:id/review` |
| Assets | `GET/POST /projects/:id/assets`, `GET/DELETE /assets/:id` |
| Dashboard | `GET /projects/:id/home`, `GET /projects/:id/dashboard`, `GET /projects/:id/status-board` |
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
| Frames | `GET /shots/:id/frames`, `POST /shots/:id/frames/:version/restore` |
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
| Settings | `POST /projects/:id/settings/preset`, `GET/PUT /settings` |
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
| 3D | `POST /locations/:id/model/generate[/stream]` (a previs stage) |
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

### Artefact Staleness (Phase 1 of the parity epic)
Nothing recorded what a generated artefact was made from. Edit a character's appearance, a location description, a style preset or a scene card, and every frame already generated from the old version stays valid-looking forever — the only signal is a director noticing. That is affordable at eight shots and impossible at fifteen hundred, and it already cost once: a character plate generated in a stock clip-art style survived the fix to its own builder by fourteen hours, because it was cached and nothing knew it was out of date.

**The payload is the fingerprint.** Every generated artefact already has one honest description of what it will be — the payload the provider would receive, from the single construction path in `capability-payloads.js`. If that payload changes the output would change; if it does not, it would not. Hashing it means there is no second enumeration of "the inputs" to drift from the first, which is exactly how a hand-written input list rots. Two kinds cannot use their payload and say so: `lipsync` and `post` build from artefacts that may not exist yet, so their builder throws `PRECONDITION` rather than describing anything — they fingerprint their **dependencies** instead, which is the right semantics anyway, since a lip-synced clip is stale exactly when its video or its dialogue is. Those dependencies are read from `PIPELINE_STEPS.depends`, never re-declared.

`lib/artefact-fingerprint.js` registers the **12 generated kinds**: the 8 orchestrated capabilities, 3 plate kinds, and the scene card. Migration 063 adds `input_fingerprint` / `artefact_kind` / `fingerprinted_at` to `film_assets`, NULL-defaulted — and **NULL means "outside the workflow", not "stale"**. Treating an absent fingerprint as stale would retroactively invalidate every asset in every existing project, which is both wrong and the fastest route to the feature being switched off; it is also what keeps the byte-identical golden fixture true. `stampAsset()` never throws: a fingerprint that cannot be computed must not fail a generation that already succeeded and cost money.

A shot-scoped file whose shot has been **deleted** is reported as `detached`, not stale. `film_assets.shot_id` is `ON DELETE SET NULL` on purpose — deleting a shot must not silently unregister a file that exists on disk and cost money — but the report then read those rows as stale with *inputs could not be read*, which is true and useless: you cannot regenerate a shot that does not exist. Worse, it made two reports disagree about one question. After two shots were deleted mid-revision, staleness said eight keyframes were behind while the impact report, which walks shots, said six, and both were describing the same project. `detached` says the only actions available — delete the file or leave it — and keeps the stale count to work someone can actually do.

`GET /projects/:id/staleness` and the `staleness_report` MCP tool (65 tools) report **stale / fresh / unknown** as three distinct answers. Unknown is named rather than folded into fresh, because an unstamped asset is a gap in coverage and hiding it would make the report look better than it is. An artefact whose inputs can no longer be read — a deleted character — is reported stale, since something it was built from is gone.

Two real defects surfaced while writing the set-based test, both invisible to an example: `buildPlatePrompt` never read a prop's `visual_prompt`, so the one field written for generation never reached the plate generated from it; and scene presence was keyed on **dialogue cues only**, so a character introduced in action was present in no scene — on Wingfall that made the DRAGON, the title creature, invisible to every report built on presence. Presence now reads action through the same detector the entity suggestions use, wrapped rather than duplicated so the two cannot disagree about who is in a screenplay.

### The Stale Gate, Sides and DOOD (Phase 1 close-out + Phase 2 start)
**The gate refuses to build on a rotten foundation.** `staleInputs(kind, ids)` asks whether the artefacts a step is generated *from* still match what they were made from, and `executeStep` refuses with `STALE_INPUTS` when they do not — generating a clip from a keyframe that no longer matches its character, or a lip-sync from a clip regenerated afterwards, spends money to produce something already known to be wrong. It fires **only** when a dependency was stamped and its inputs have since changed, so a project that predates fingerprinting is never gated; `ignore_stale` overrides it exactly as `ignore_budget` does.

Writing that gate caught the design flaw it was built on. Dependencies were **hand-declared** in the artefact registry and were already wrong on their first day: `video` takes the keyframe as its `init_image` and the list said it had no inputs at all, so a clip built on a stale frame would have passed the gate silently. They are now **derived from `PIPELINE_STEPS.depends`** at module load — the orchestrator's own graph, never a second copy — and a test asserts the two agree for every step.

**Sides and DOOD** (`lib/production-reports.js`) are the two reports StudioBinder names and the first Phase 2 work, unblocked by the presence repair. Sides are what a director reviews before spending on voice generation; DOOD answers which subjects need a reference plate and how many shots each commits us to. A character with no dialogue still gets a sides entry with `line_count: 0`, because omitting them makes "has no lines" indistinguishable from "is not in this film" — and the non-speaking case is exactly what the old dialogue-only presence lost. DOOD's `needs_plate` is the actionable line: a character in 40 shots with no plate is 40 frames that will each invent their own version of them. Both unions scene presence with what the shot cards name, since either source alone has been wrong. Scene numbers are normalised to strings because `film_scenes.scene_number` has INTEGER affinity and returns `2` for `'2'` but `'2A'` for `'2A'` — one column, two types, which a report should absorb rather than pass on.

**The run plan** (`lib/run-plan.js`) is the stripboard, rotated. A shooting schedule minimises travel and cast idle time; this minimises **model swaps, plate re-generation and spend**. It **sits above the orchestrator and never replaces it** — the open question the epic refused to assume. `PIPELINE_STEPS` orders steps within one shot and the flows engine orders nodes within one graph; neither orders shots against each other, so this is a genuinely empty slot rather than a third sequencer. The plan emits ordered `(shot, step)` work items that the existing `executeStep` consumes unchanged, and generates nothing itself.

The ordering is not tuned — it falls out. Strips are steps in topological order, each covering every shot needing that step; since `STEP_MODELS` is keyed per step, **one strip is one model**, so the arrangement that satisfies dependencies is the same one that minimises swaps. Two objectives, one answer. Work already fresh is skipped (which is why Phase 1 came first — a plan that cannot tell what is current re-generates everything or nothing), and skipped work is *reported*, since a plan that hides its savings looks more expensive than it is.

Two orders, and the trade is real rather than a preference: on 8 shots, `order=model` costs **5 model switches** and `order=shot` costs **47**, for identical work at identical cost — shot-major buys a finished shot early with 42 extra model loads. Cost is summed **per item from that item's own step**, never from the strip's: a shot-major strip walks a shot through every step, and pricing it at the first step's rate made the same work cost different amounts depending on how it was ordered. An estimate that moves when you reorder the plan is not an estimate. Swaps are counted over the flattened item sequence for the same reason. Over budget, the plan returns **HTTP 402** with `refused: true` before anything generates, overridable with `ignore_budget`; an unset budget is unlimited, never a ceiling of zero.

**Breakdown summary, elements list and run report** complete the set. The elements list unions the locations table with what the scene headings name, because a heading whose row was never created is exactly the state a fresh screenplay upload leaves — reporting only the table would silently omit locations the film shoots in. `undescribed` is its actionable line, and `has_record` distinguishes "no row" (needs `entities_create`) from "row with no description" (needs `entities_describe`). The **run report** is the call sheet reinterpreted: there is no crew to notify and no mail dependency to add, but a director still needs to know whether the day happened, what failed and what it cost. Failed steps are **named individually** rather than counted — "3 steps failed" sends you to the database.

Served at `GET /projects/:id/{staleness,sides,dood,run-plan,breakdown-summary,elements-list,run-report}` and as seven MCP tools (71 total).

### Every Spec Changes Something (the board is not a form)
A board that collects choices nobody reads is a form. `tests/spec-consumption.test.js` iterates all **8** `SPEC_KINDS` and, for each, changes the value and asserts that a real payload — what a provider or an editor receives — comes out different. It does not check that a spec is *stored*; storage was never the problem.

Where each one lands:

| Spec | Reaches | When |
|---|---|---|
| `lens` | the image prompt | on any shot whose card names no lens — including shots nobody has blocked |
| `sensor` | previs | seeds a stage's sensor, and the delivered-frame crop that follows from it |
| `aperture` | previs | seeds the stop, which sets depth of field |
| `aspect_ratio` | the image payload | sizes the frame that is generated, and the NLE export |
| `resolution` | `target_resolution` | the video payload's width/height, the conform, the NLE export |
| `frame_rate` | `target_fps` | the video payload's target rate, the NLE timebase, the stitcher |
| `color_space` | `color_space` | the NLE export and the QA rubric |
| `style_preset` | the image prompt | the look every frame is generated in |

Writing that test found the eighth broken. `calculateVideoParams` hardcoded `target_fps: 24` and `1024x576` and never read the project, so a production set to 25fps generated clips targeting 24 and was only *relabelled* at NLE export — a mismatch that surfaces as drift in a cut, long after the frames were paid for. The generator's own `fps` stays a constant, because that is a fact about the model rather than a choice about the film.

The precedence rule is also pinned: a spec never outranks the scene card. The board says what the production shoots on; the card says what *this* shot does, and a default that beats an explicit choice is worse than no default.

### The Film's Optics Reach Every Shot
`lens 40 / super35 / T2.8` sat on the board, validated, and reached nothing. They were only consulted by `previs/from-card`, so they applied to whichever shots someone had opened the 3D stage for — one of eight in practice — and the other seven generated on a generic 50mm super35 default belonging to no production. A spec a director deliberately chose was decoration.

Blocking is optional; the lens the film shoots on is not. `filmOptics()` reads the board's specs and `buildStoryboardPrompt` uses them as the last fallback, giving a precedence of **staged → written → what the production shoots on**. A project with no specs gets `{}` rather than an invented default, because a made-up lens would be indistinguishable from a deliberate one and would override the scene card.

### Look Development (Phase 3)
A style preset is appended to **every** image prompt in a production, is a free-text column, and was validated nowhere. So `"…teal/amber, wet streets, mist, anatomical beast, anamorphic, grain"` put a flayed quadruped in the establishing shot whose scene card reads *"Empty, ordinary, still."*, and a gargoyle at the base of a sprinkler insert. Nobody wrote those shots; the style did, in every frame, silently.

`lib/look-development.js` catches a style that names a **subject** rather than a look, and the asymmetry drives the design: a validator that rejects real cinematographic vocabulary gets switched off within a day and then protects nothing, so it matches bare words and simple plurals against a short concrete list (creatures, people, animals, drawn objects) with an exception set — substring matching turns "grainy" into "rain" and every style into a failure. It **warns, never blocks**, on the precedent previs set: a creature film may genuinely want a creature in every frame, and refusing the save would overrule the author. The warning names the offending word, since "your style may contain a subject" just sends the director back to re-read their own string. Wired into `POST`/`PUT /projects`, returned as `style_warning`.

Tested against a corpus rather than examples: 8 real styles that must all pass (noir, Portra, cyberpunk, documentary, golden hour…) and 5 subject-carrying ones that must all fail — including the exact string that shipped the defect.

### Revising a Shot, Not Just Producing One
Three things a director could not do in the app, all found by using it.

**The scene card could not be edited.** `PUT /shots/:id/order` and `/transition` existed; the card itself — what every keyframe, clip and report is built from — could only be written by whoever created the shot. So a frame that came back wrong could be regenerated from exactly the same words, forever. `PUT /shots/:id` **merges** rather than replaces, because a card is a whole document and a swap would drop the dialogue every time someone fixed a typo in the action, and it validates like every other write, since an edit route that skipped validation would be the one way to get a broken card in. Editing correctly makes what was generated from it stale.

**The markup buttons worked and looked like they didn't.** Arming a shape set `pointer-events` and wrote a line to the status bar at the bottom of the screen, so pressing one appeared to do nothing. The frame you are about to draw on now says so, where you are looking.

**Previs stopped one step short.** You could stage an angle, preview the prompt and write the camera back to the card — then had to leave previs, find the shot on the board and press Regen. The question previs exists to answer is *how would this look*, and it could only be answered somewhere else. **Render this angle** saves, applies and regenerates in that order (regenerating before applying would generate from the previous angle) and reloads the pane, so the answer is the new picture rather than the one it replaced.

### Drawing On a Frame, and Seeing the Camera Move
Three things that looked broken and were, in different ways.

**The markup buttons drew nothing because the gesture was wrong.** Arming a shape waited for two separate clicks with no feedback in between, so the first click appeared to do nothing and the second placed a shape you had never seen. It is a drag now — press where the arrow starts, release where it points, with the shape drawn live under the cursor — and the release position is the end point rather than the last position the mouse happened to report on its way there. All **six** kinds the route has always accepted are offered; the grid had four and quietly dropped `line` and `freehand`.

**Markup was missing from the surface where a frame is actually judged.** The full-screen viewer had no tools at all, which is backwards: a 260px card is not where you decide a shot is wrong. Both surfaces build their controls from **one** `markupToolbar()`, because two literals is exactly how they came to disagree. The viewer letterboxes its image with `object-fit` and the grid does not, so coordinates are normalised against the **picture's** rect rather than the canvas's — normalising against the element looks perfect on the grid and puts every mark in the wrong place in the viewer, on the surface nobody tested. A press on the letterbox bars is ignored rather than clamped to the frame edge.

**The camera pane looked dead because the picture was stapled to the viewport.** `previsDrawKeyframeBackdrop` painted the generated frame at a fixed rect no matter where the camera was, and the only geometry over it was a ground grid at a fifth opacity — so changing the lens or dollying in recomputed everything and showed none of it. A flat picture cannot be re-rendered from a camera it was not taken with, so it is stood in the world instead: `previsPlateQuad()` builds it as a card at the subject's **depth along the aim** (the straight-line distance puts it behind the subject the moment the camera tilts), sized to exactly fill the delivered frame from its own pose with its own lens. Zoom, dolly, pan and tilt then all come out right for the subject; parallax against the background does not, which is the stated limit of a card rather than a bug. The anchor is the **saved** blocking, never the inspector — an anchor that followed the controls would hold the picture still against every change made to them — and a shot that was never blocked, which is the common case, anchors to the inspector as it opened. The frame's own edge is drawn in amber, so a longer lens reads as a measured crop into the picture you already have.

**And a card can now be read as well as written.** There was a `PUT /shots/:id` and no `GET`, so the editor could only show whatever fields the storyboard panel happened to carry, and an agent had to list a whole project to read the one row it was about to change. The description editor is a modal with a real textarea and a live character count rather than a one-line `prompt()`: a shot description is a paragraph, and you cannot revise words you cannot see.

### Previs Is Where You Experiment; the Board Has to Show It
Blocking already reached generation — `previsFacets()` into the image prompt, `camera_control` into the clip, `previs/apply` back onto the card. What it did not reach was the **board**, which is where a director looks to find out whether any of it happened. Lock a move in previs and the storyboard was byte-identical: same tags, same everything.

Worse, the tags it showed were the **card's** camera. On a blocked shot those are precisely the values generation ignores, so the board displayed the wrong lens with total confidence — 1C reads `close-up · 85mm` from the stage while its card still says what it was written as. `effectiveCamera()` is now the single precedence rule (**staged → written → what the production shoots on**, merged per facet), consulted by `buildStoryboardPrompt` *and* by the board, because two copies of a precedence rule is exactly how a display comes to disagree with the generator. Every facet carries its `source`, which is the thing a director cannot otherwise see: a lens reading 50mm means something different when it came from the stage than when it is the film's default. Staged facets render in cyan and open **previs**; written ones open the card. The way in should be the place the value actually comes from.

`GET /projects/:id/storyboard` gains `effective` and `previs` per frame, and the frame carries a badge with **three** states — `block in previs`, `staged`, `approved`, and `staged · changed since approval`. Three rather than two, because "approved" and "approved, then restaged" is the distinction the iterate-until-happy loop turns on, and folding them together is how a director meets a 409 at generation time for a shot the board told them was signed off.

**What markup does *not* do by default.** Arrows, rectangles and notes are **notation** unless a project says otherwise — stored, drawn, kept with the shot, and read by nothing in generation. An arrow drawn to mean "dolly in" changes no prompt and no payload; the movement that does is `camera_control`, set on the card or staged in previs. Turning on `annotation_feedback` makes *noted* marks reach the prompt — see **Markup That Steers a Frame** below — and leaves an unnoted arrow exactly as decorative as it was.

### The Frame You Are Shooting From
Board generation never looked at another frame. A keyframe was conditioned on character plates, a location plate and a mood-board image — every one a picture of something *in the abstract* — so 1B rebuilt the street from scratch and put the well, the cart and the light somewhere else than 1A had. The only shot-to-shot chaining that existed was `POST /shots/:id/post/color-match`, on the finished **clip**, long after the frames were paid for.

**Point at the frame that has the scene right, and the next shot is generated FROM it**: the same location, the same set dressing, the same subjects standing where they stand in it, re-shot on whatever lens and angle that shot's own card asks for. 1A establishes the square; 1B is that square from a 24mm at a low angle with the dragon's shadow across it. `anchor_set` / ⚓ picks it up, `anchor_clear` puts it down.

Two versions of this were wrong before it was right, and both mistakes are pinned as tests:

**It was attached for GRADE**, with a negative refusing to reuse its composition, on the reasoning that a scene of eight copies of the establishing shot is worse than the drift. That failure is real and it is not the one worth designing against: a director who wants 1B to keep 1A's street with the cart exactly where it was cannot get there from a colour swatch, and telling the model to ignore the placement throws away the only thing the frame was attached for. **The camera change is what stops it being a duplicate**, stated in the prompt from the shot's own card — if two shots genuinely name the same framing, two similar frames is the correct output. The negative refuses **discontinuity** instead: `different location, rebuilt set, rearranged props, different time of day`.

**It was a standing property of every SCENE**, derived automatically from the first shot in it with a frame — so anchoring 1A lit up an anchor badge on 2A as well, because scene 2 had quietly appointed its own. Nothing was wrong on screen; the model was. Anchoring is not a property a scene has, it is something a director picks up while working on 1B and 1C and puts down afterwards to go back to plates. Migration 074 makes it **exactly one active anchor per project** (`film_projects.anchor_shot_id`), set explicitly, replaced by setting another, cleared in a click — and retires the separate on/off switch, because **setting one IS turning it on** and a pinned frame that reached nothing while a checkbox elsewhere sat clear is the state nobody can hold in their head. `use_anchor: false` skips it for one generation without putting it down, which is a different action from stopping.

**It leads the prompt, and that placement is the decision.** *"Whatever leads a prompt is what the image is of"* is the rule this codebase learned expensively, and here the leading statement is true: the image **is** of that location with those things in those places. What follows is the new camera on it. The lead phrase names re-shooting explicitly, because without it *"same scene as this picture"* reads as *"reproduce this picture"* and the camera facets arrive as decoration on a copy.

**It replaces what it makes redundant — pictures *and* words.** Three reference slots is the whole budget, and a plate of a character standing in the attached frame is a slot taken from a subject who is *not* in it. `subjectsCoveredBy` reads the anchor shot's own card, so a covered subject loses its plate, and the location plate stands down entirely (the anchor **is** the location, rendered).

Dropping the plates was only half of it, and the missing half cost the whole budget. The locked profile contracts are appended later by `applyConsistencyToImagePayload`, which knew nothing about the anchor — so a real 1B anchored on 1A sent **3,990 characters against a 4,000 ceiling, 2,517 of them describing a cul-de-sac, a sprinkler and a sedan all plainly visible in the frame travelling beside them**. Two pictures saved, and then the entire prompt spent re-describing what they showed. A covered subject now keeps its **name** and its opening clause and loses its paragraph: the same shot came back at **2,460 characters with 1,540 of headroom** — SEDAN 1936→92, sprinkler 653→95, location 856→89.

Three things keep that honest. It shortens against the **anchor**, never against a plate — a plate may or may not win one of three slots, while the anchor ranks 0 and is attached whenever there is one at all, which is why this is not the bet the contract shortening was reverted for. The subject keeps its **name**, so it never travels as nothing. And the **location** is covered only when the anchor is in the same scene: across scenes the anchor is a picture of a different place, and dropping that description would strip the one thing the frame does not show.

The anchor ranks **0**, ahead of every plate, because it is not one. Since it ranks first, an untaggable provider can use it too — the prompt says *"the first reference image"*, unambiguous precisely because of the rank. The gate is whether the picture can be **sent**, not whether it can be named.

The anchored shot **generates from its own card**: a frame conditioned on itself could only reproduce itself, so the one frame a director most wants to revise would be the one they cannot. Anchoring a shot with no generated frame is **refused** rather than accepted and ignored, since accepted-and-ignored looks exactly like the feature not working. A cross-scene anchor is **allowed and reported** — two scenes in one location is a real reason to do it, two scenes in different locations is how you get the wrong street back and cannot see why, and only a director knows which. `ON DELETE SET NULL`, so deleting the anchored shot puts the anchor down rather than refusing the delete.

`KIND_SOURCE` declares where each reference kind comes from (`entity` / `frame` / `project`), because `tests/reference-plates.test.js` derived "every subject kind" from `KIND_RANK` by excluding `style` by name — and the moment a fifth kind arrived it demanded a table and a plate generator for a *generated frame*.

Served on the board (`anchor.is_anchor` per frame, `anchor_shot_id` per project), at `GET|PUT|DELETE /film/projects/:id/anchor`, reported by `GET /shots/:id/prompt`, and as `anchor_get` / `anchor_set` / `anchor_clear` (**119 tools**). All four generation paths attach it — see below.

### A Low-Angle Wide Was Unsayable
`VALID_SHOT_TYPES` mixes three independent axes — framing (`wide`, `medium`, `close-up`), angle (`low-angle`, `high-angle`, `dutch-angle`) and rig (`tracking`, `dolly`, `handheld`) — and `camera.shot_type` holds exactly one. So a card cannot say *"a low-angle wide"*: you pick the framing or the angle and silently lose the other. The previs plan recorded this as a finding on day one; the consequence in production is a director writing *"Locked-off low-angle wide on three house fronts"* in the action, setting `shot_type: wide`, and getting a frame at eye level.

`camera.height_m` is the second axis, and the scene-card schema has **validated it since previs phase 0** — while `buildStoryboardPrompt` read camera height from previs blocking **only**. A director could write it, the card would save, and it reached nothing unless somebody had also opened the 3D stage. Same defect class as the mood-board specs that validated and were consumed nowhere, and the same fix: the card's own height is the fallback under the blocking. `≤0.9m` reads as *low angle, camera looking up*, `≥2.2m` as *high angle, looking down*, and blocking still wins where a shot has been staged — the card is what was written, the blocking is what was approved.

So there are now three ways to get a low-angle wide, in ascending order of effort: put `height_m: 0.4` on the card, block it in previs and let the solved geometry say it, or keep the frame you have and change it with `storyboard_refine`.

### Every Attempt, and the Way Back to One
`archiveExistingFrame` has copied the outgoing picture to `{code}_v{n}.png` and repointed its asset row since the day regeneration started overwriting a fixed filename — so on a real shot the disk held `1B_v1`, `1B_v2`, `1B_v3` and the live `1B.png`, and **nothing could look at any of them**. Kept and unreachable is barely better than not kept: the reason to keep them is that generation is a coin flip you already paid for, and v2 is often the one you wanted.

`GET /shots/:id/frames` lists them and `POST /shots/:id/frames/:version/restore` puts one back. **Forward, never backward**: the restored picture becomes a NEW highest version rather than truncating history to the one restored. Rewinding would destroy the attempts made after it — the same mistake as deleting a frame in order to regenerate it — and would make *restore* a destructive verb on the one list whose entire purpose is that nothing is lost. The frame being replaced is archived *first*, or the attempt you were on is the single thing the history drops. It costs nothing: a file copy, not a generation.

`is_current` is reported per version rather than inferred from "highest", because after a restore the highest version is not the newest picture — and *which of these am I looking at* is the question the list exists to answer. `tests/storyboard-annotation.test.js` counts frame writes by **destination** now (`writeFileSync` takes it first, `copyFileSync` second), since matching a buffer variable name missed refine when it arrived and would have missed restore too.

### A Blocked Sequence Reported Itself as Static
`film_previs_blocking` has a single `movement` column *and* a `moves_json` array, written independently — `movement: body.movement || 'static'`. Block a two-leg *"dolly in, then pan right"* without also naming a single movement and the column stored `static`, which is what **both** consumers read: the video payload went out as `camera_control.type: "static"` beside a path that plainly moves, and the keyframe asked `MOVEMENT_MAP['static']`, which is `''` — so the sequence was invisible to the still entirely.

Two fixes. `movement` is now derived from the **heaviest leg** when a sequence is saved without one — weight is proportional to time, so the dominant motion is the honest single-word answer for a field that can hold only one, and an explicit movement still wins. And the legs reach the prompt: `loadShotContext` carries `moves`, `previsFacets` exposes them when there is more than one, and the prompt says *"camera moving closer, then camera panning right"*. Naming only the first leg, or only the dominant one, describes a different shot — *"moving closer"* and *"moving closer, then panning right"* end in different places. A still can only ever show the **start** of a move, so this is a phrase naming what the camera does rather than an attempt to depict motion.

### A Background Refresh Must Not Eat the Spinner
Refresh-on-focus calls `loadStoryboard`, which rewrites `grid.innerHTML` — destroying the busy veil painted on the card being watched. Alt-tab during a one-minute refine and the spinner vanished while the generation carried on; the image still arrived and the page simply stopped saying so, which reads as the spinner being broken. A `BUSY` count is now held while any frame is generating, and a background refresh during that window is **deferred, not dropped**, on the precedent the live-events refresh already set — dropping it leaves the board stale for as long as the work runs. The clear function is guarded against being called twice, since a negative count would suppress every background refresh for the session.

### What Conditions a Clip Is the Board, Not the Plates Again
Video generation was sending `reference_images: consistencyContext.references` — consistency rows carrying `file_path` and no `uri`, which every adapter drops on the floor (`if (!uri) continue`). The obvious reading is the bug that was fixed on the single-shot image path and never fixed here, and the obvious fix is to make the references resolve.

**That fix would have been wrong.** This is image-to-video: the keyframe is the `init_image`, and that frame was already generated FROM the plates, so everything they contribute is baked into it. Attaching them again puts a T-pose studio photograph on a seamless backdrop beside a composed street and asks the model which one is the truth — a plate is a picture of a subject *in the abstract*, which is exactly what a clip must not drift toward. So the line was **removed**, not repaired, and a dead payload field went with it.

What conditions a clip is the board and the blocking: the keyframe as `init_image`, the camera path and rig from previs as `camera_control`, and the director's **markup**. Markup is the one thing the picture cannot carry — an arrow means *"then dolly past the mailbox"*, which is about what happens NEXT, and a still has no room for it while a clip is nothing but room for it. `Direction: dolly left past the mailbox as the shadow crosses (from the centre of frame toward the left of frame)` now travels with the clip, on the same opt-in switch as the frame.

### A Size Belongs on the Plate, Not Only in the Frame
Declared dimensions reached the **keyframe** prompt and never the plate, which is backwards. A plate is a close-up filling its own frame and conditioning transfers appearance rather than scale, so the model reproduces what it was shown — a thirty-centimetre sprinkler plated at full frame came back the size of the car beside it. Fixing that downstream means arguing with the plate in every shot the subject appears in; fixing it on the plate fixes it once, for every frame that references it.

Both builders now carry it. No **frame fraction** is emitted: that is a statement about composition needing a lens, a distance and something else in shot, and a plate has none of the three — what applies is the anchor and the plain measure, which is what `scalePhrase` falls back to when no coverage is passed. An undeclared size still says nothing at all, because an invented default is indistinguishable from a deliberate one and would be wrong silently on the one surface every later frame is built from.

### Closing the Last Four Gaps in the Loop
An audit of the intended workflow — screenplay → plates → look board → storyboard ↔ previs → footage — found seven breaks. Three were fixed as bugs; these are the four that were simply never wired.

**Describing entities from the screenplay was not in the app.** `POST /projects/:id/entities/describe` has existed since the screenplay-to-entities work, reachable only over HTTP: no button, and deliberately no MCP tool, since it hands the reasoning to a server-side LLM while the agent host *is* the model. So descriptions were typed by hand — and an entity with no description generates a bare name, which is how a character becomes a different person in every frame. A **Describe from screenplay** button now sits on all three entity pages (per page, because a button on characters alone leaves locations and props hand-typed), fills only what is blank, and **names what stayed blank** rather than reporting a count.

**The look board reached the plates as words only.** It has composed into `style_preset` from the day it was built and its pinned images reached storyboard frames — never the plates. That is backwards: a plate conditions every frame its subject appears in, so a plate generated outside the film's look drags all of them with it and the look has to be re-argued in every shot. Both builders now attach **one** board image, tagged and named in the prompt for its light and grade where the provider can hear it. One, not three: a plate has exactly one subject, and a second look plate starts voting on what that subject *is*. On a moderation refusal the look drops **whole** — words and picture — because retrying with the reference still attached re-sends what may have been refused and reports `style_applied: false` while the look is in fact still applied.

**Locations had no 3D.** Characters and props could become meshes; the place they stand in could not. A location mesh is a **stage**, not a subject: `normalizeSubject` gives it `category: 'set'` and asks for an environment with a walkable ground plane rather than an object on a turntable, and drops the lighting defaults, since baked light fights whatever the blocking decides and previs strips materials to grey-box anyway. Its fidelity is beside the point — what previs needs is where the ground is, where the walls are, and how far the far side is.

`server.js` matches `/film/locations/:id` **before** any 3D dispatch, so the new route had to be registered ahead of it — the same trap the frames route fell into hours earlier, where a handler existed and nothing ever reached it. `tests/threed.test.js` now derives `MODEL_SUBJECTS` from the module and requires the server to route every one.

**Markup was invisible in previs.** It reached the prompt, and the previs payload previews already carried it (both `/to-video` and `/to-storyboard` build through `loadShotContext`) — but it never appeared in the one place you go to *restage* a shot. Previs stands the generated frame in the world so a new angle can be judged against it, and the arrows drawn on that frame, which are the reason you are there, were not on it. They are drawn now, mapped bilinearly across the plate quad's four projected corners — affine per edge, the same approximation the textured quad already makes, exact at the corners and consistent with the picture underneath. **Read only**: an arrow stays notation, because the thing that moves a previs camera is the blocking, and two systems claiming to set the same camera is precisely how they come to disagree.

### One Gatherer, Four Paths
`lib/capability-payloads.js` exists so that "the per-domain routes, the pipeline orchestrator and the flow canvas cannot describe the same generation differently", and it could not honour that: the gatherer that decides which plates a shot generates with lived in `routes/storyboard.js`, so only the three board paths could reach it. **The orchestrated `image` payload gathered no references at all.** A pipeline run generated keyframes with no plate conditioning while the board conditioned correctly — the same shape of divergence `regenerateShot` had already shipped once — and every reference feature added since (prop plates, mood-board style images, the scene anchor) reached three paths out of four. Nothing failed and nothing was logged; the prose contracts carried the subjects until the day they were shortened on the correct assumption that a picture was attached.

`lib/shot-references.js` is the gatherer, plus the matchers and `providerReferenceSupport`. **`loadShotContext` reads; the builder does not.** That split is not tidiness — `buildCapabilityPayload` takes a context rather than an id precisely so a payload can be built with no I/O, which is what makes the parity suite testable, so the database is required lazily and the gather happens in the loader. `image(ctx)` then reads `ctx.references` / `ctx.tagged` / `ctx.anchorTag` and puts the pictures on the payload. `applyConsistencyToImagePayload` already deferred to references the caller attached, so the locked contracts now see the set that is genuinely going rather than the profiles that might have.

**`regenerateShot` converged too.** It attached the pictures and then described the subjects in prose anyway, so two shots on one board — one generated by "Generate All", one by "Regen" — sent differently-shaped prompts for the same subject. It now passes `references` and `tagged` like the board does. That is only safe because it gathers the plates first and puts them on the payload: `@maya` may replace an appearance **only** when the reference that gives it meaning is in the same request, which is the invariant behind the contract-shortening revert and is now pinned as a rule rather than remembered as a story.

`tests/reference-capability.test.js` is set-based over **four** entry points across two files, because a gap that lives in a different file is exactly the one a per-file test cannot see — and it checks the payload really carries the plates, not merely that something called the gatherer. A gather whose result never reaches the request produces a prompt naming `@maya` with nothing to point at, which is strictly worse than having used prose.

### Markup That Steers a Frame (PAR-026, and it is off)
Markup shipped as **notation**: arrows and notes stored against the shot, drawn on the frame, read by nothing in generation. Whether it should drive the next prompt was the epic's Open Question 3, left open because the answer is not obviously yes — a stale arrow from three revisions ago becomes a standing instruction on every frame generated afterwards, and nothing on the page said so.

The answer is **yes, opt-in, off**. `film_projects.annotation_feedback` (migration 072) defaults to `0`, which is the whole safety argument: every project that exists today, and every project created without an opinion about this, builds byte-identical prompts with markup all over its frames. A feature that changes what an existing board produces the moment it ships is one nobody can adopt deliberately. `storyboard_regenerate` and `storyboard_refine` take `use_annotations` to apply marks for a single call, so trying it does not mean committing the production to it.

**Geometry says where, never what.** An arrow at (0.2,0.3)→(0.7,0.6) is a place and a direction, and a model asked to act on it has nothing to act on — so a mark becomes a direction **only when it carries a note**. A shape with no words is still stored and still drawn; it simply reaches no prompt, and it is **reported** as reaching no prompt rather than dropped quietly. Silence is what makes a director believe their three arrows changed the frame when nothing did. `annotation_list`, the frame's own badge, and `GET /shots/:id/prompt` each name the marks they cannot use and why.

Normalised coordinates turn out to be the whole reason this is sayable. `0..1` means the same thing at 1024px and at 4K, so a point converts honestly to *"the bottom right"* where a pixel could not — the payoff of a decision made in migration 065 for an entirely different reason (surviving a regeneration at another resolution).

**The same marks are read two ways, because the two paths are not the same question.** `refine` attaches the picture, so *"move the car to the kerb"* has something to move and somewhere to move it; a regeneration from the card has no previous frame, so the same words are a description of a target state, folded in as a labelled `Direction:` clause. One builder each rather than one that pretends the difference away. A hand-typed instruction still **leads** on the refine path: the marks were drawn earlier, and the sentence someone just wrote is the current thought.

Placement in the prompt is decided by two failures already paid for. It sits **after the action** because whatever leads a prompt is what the image is *of*, and *"remove the sprinkler"* at the head makes the sprinkler the subject of the frame it was asking to be rid of. It sits **before the camera and the look** because a provider truncates the tail, and a director's explicit instruction is the last thing that should be lost to a ceiling. It has an allowance — an unbounded field ate the budget once and amputated location and style — which binds only when the prompt overruns.

`prompt_override` never receives markup: an override is the whole prompt, the composer had the marks in front of them in `shot_prompt`, and stapling them on afterwards is the bug `promptIsFinal` already exists to stop. Staleness follows for free, because the fingerprint **is** the payload: a mark that changes the prompt changes the fingerprint, and an unnoted one changes neither — otherwise every stray arrow would mark its frame stale for a change that reaches no model.

`tests/annotation-feedback.test.js` is set-based over the six shape kinds, since the failure would be partial: an arrow that converts to words while a freehand silently produces an empty clause passes any test written against arrows.

### The Card's Own Vocabulary Is Editable
The board showed `establishing · 40mm anamorphic · push-in · blue-hour` and offered no way to change any of it. `GET /film/card-vocabulary` serves the validator's own `VALID_SHOT_TYPES` / `VALID_CAMERA_MOVES` / `VALID_LIGHTING` / sensors, so the editor cannot offer a value the validator refuses — typing the lists into the page would work exactly once, until somebody added a shot type. `lens` is deliberately **not** a select: "40mm anamorphic", "50mm" and "24-70 at 35" are all things a director writes, and a dropdown refuses two of the three.

Camera and lighting **merge** into what the card already holds rather than being rebuilt from the four visible fields — a card carries sensor, aperture and height the editor does not show, and rebuilding would drop whatever previs wrote the last time the shot was blocked. A value the card carries that the current list does not is kept and labelled, never silently reset.

### Revising a Story From an Agent (98 tools)
The MCP surface could generate a film and could not **change** one. `script_get` existed with no write, so a screenplay was readable and immutable; there was no breakdown tool, so even a screenplay edited by hand could not be re-derived into scenes and shots; and `shot_create`/`shot_delete` existed while the scene card — the thing every frame is generated from — had no update. An agent could build a production from scratch and then had to watch a human revise it.

Nine tools close it, all dispatching through the existing routes rather than reimplementing them: `script_write` (a new **version**, so the previous draft survives a rewrite), `breakdown_run`, `shot_get`, `shot_update`, `card_vocabulary`, `storyboard_regenerate` (one frame, not the board), and `consistency_list` / `consistency_lock` / `consistency_unlock`.

Two descriptions carry warnings the tool cannot enforce, because both failures are silent. `script_write` says plainly that editing the screenplay does **not** update the scenes, shots or frames derived from it — an agent that rewrites a draft and stops has left a shot list describing the previous story. And `consistency_list` says a **locked** profile is what generation conditions on while a draft one reaches nothing, since "I created a profile" and "the subject is now consistent" look identical from the outside.

`storyboard_regenerate` is per-shot on purpose. The only regeneration tool was project-wide, so changing one line of one card meant paying to regenerate every frame in the film.

### A Revision Must Not Cascade the Film Away
`film_shots.scene_id` is declared `ON DELETE CASCADE`, and `uploadScript` cleared **every scene in the project** by default. On a first upload that is correct and costs nothing — there is nothing hanging off the scenes yet. On the second it takes the whole production: every shot, scene card, previs blocking, annotation and asset row. Nothing errors; the only signal is a shot list that has quietly become empty, found by whoever next opens the board.

It was reachable from the UI, and once `script_write` shipped it was reachable from an agent — the worse of the two, because *"rewrite scene 3"* is a sentence a director says casually. `sync_scenes` reconciles instead, through the FILM-120 reconciler that already existed and was only wired to `PUT /script/:version`: match by number, then by location and time, update what moved, add what is new, mark what is gone as `removed`. **Scene ids survive, so the shots hanging off them survive too.** It is opt-in rather than the new default because changing the default would change what a first upload does, and a first upload has no shots to protect — the *tool* defaults to it, since that is where the casual sentence arrives. The destructive path stays, renamed to `replace_everything` and described as what it destroys.

`breakdown_run` takes `scene_id`, which is the surgical path and was there all along — the tool sent an empty body and did the whole screenplay. Without `auto_save` it is a preview that writes nothing, and with it, it **skips** any scene that already has shots rather than duplicating them.

`tests/script-revision.test.js` is set-based over the child tables a revision must not orphan, because a cascade is only safe if *every* child survives: a test that checks shots alone passes while previs blocking is swept away with them.

### The Title Page Is for Printing
It sat at the top of the editor as a non-editable slab you scrolled past on every open and clicked by accident when you meant to put the cursor on FADE IN. It is now `display: none` on screen and `display: block` in `@media print`, which is the one moment a title page is read. Hidden rather than removed — the block carries the data the Fountain serialiser writes back, so deleting it would lose the title page itself — and the toolbar's **Title Page** button was always the real way to edit it.

The **author** moved with it. It was free text on every title page, retyped per project and per draft and blank whenever anyone forgot, which on a title page is the field a reader looks at first. It is not a fact about a screenplay; it is a fact about whoever is writing them here, and it is the same answer every time. `film_app_settings` (migration 068) is a key/value table with an allow-list — an open store returns 200 for a misspelled key and nothing ever reads the row again — served at `GET/PUT /film/settings`. It fills a **blank** author and never overwrites one: a screenplay can have been written by someone else, and a setting that quietly reassigns authorship is worse than one that does nothing.

### A Rewrite Has to Say What It Broke
Artefact staleness answers *does this frame still match its scene card*. It is structurally blind to a rewrite, because rewriting the screenplay **does not touch the card** — which is the whole problem. Revise scene 3 and its shot cards stay valid, correctly fingerprinted, and quietly about a different film. On eight shots a director notices; on a feature nobody does, and the first sign is a cut that makes no sense.

`lib/screenplay-drift.js` is the missing edge, screenplay → card. Migration 069 gives a scene a `source_fingerprint` of the text a card is built from, and a shot the fingerprint it **was** built from; they differ exactly when the screenplay moved on without the shot. It is a **separate signal** rather than folded into the artefact fingerprint, because "the frame no longer matches its card" and "the card no longer matches the script" need different work — telling a director to regenerate a frame whose card is wrong buys them a better picture of the wrong shot.

Four decisions carry it. The fingerprint covers only `int_ext`/`location`/`time_of_day`/`description`, so reordering scenes or advancing a status does not fire — **a warning that goes off on work nobody needs to redo is one people learn to dismiss**. `shot_update` re-stamps, so fixing the card *clears* the warning: one that cannot be cleared by doing the work it asks for is noise within a day. NULL means "outside this workflow", never stale, so the feature's debut is not a wall of false alarms — and `POST /projects/:id/screenplay-drift/baseline` lets a director adopt existing work as current, which is a claim only they can make and so is an explicit action, and which deliberately **never silences a shot already known to be behind**. And it **warns, never blocks**, on the precedent previs set: a card that diverged may be a deliberate choice.

**A scene's status is not overwritten.** `complete` was true when someone advanced it, and reverting it automatically would erase a decision a person made. But left alone it is the most misleading thing on the Scenes page — the scene is complete and its shots are about a different story — so the drift is shown **beside** the status, and the two together say the true thing: *you finished this, and then the script moved.*

The banner also states the part everyone assumes wrong. **Re-running the breakdown is not destructive, and also does nothing**: `autoSaveShots` skips any scene that already has shots rather than duplicating or replacing them. The destructive step is deleting the shots first, which is what loses their generated frames — named on the page rather than left to be discovered, and asserted against `routes/breakdown.js` so the page cannot go on claiming it after the behaviour changes.

The report is per scene, because the work is per scene — you re-read the new text once and then fix every shot in it — and each shot names **what was generated from it**, since "this card is out of date" and "and a frame and a blocking were built on it" are different sizes of problem. The board carries it where the frames are: a banner naming the scenes, and a `script changed` tag on each affected frame that opens its card.

`tests/screenplay-drift.test.js` is set-based over the ways a shot can be created, and asserts no `INSERT INTO film_shots` exists outside that list — one unstamped path is a class of shots that can never be flagged, and the gap shows up as the report cheerfully saying nothing is wrong.

### One Change, All the Way Down
Every link in **screenplay → scene card → keyframe → clip → lip-sync → post** was already tracked, and none of them were tracked *together*. `staleInputs` looks exactly one level up, and only at generation time, so it answers *may I generate this* and never *you just changed the storyboard, and 1B's footage was built on the old frame*.

One level is not enough, for a precise reason. Change a keyframe and the clip's inputs are visibly stale — but the lip-sync's are **not**, because its input is the clip, and the clip has not been regenerated yet, so its fingerprint has not moved. Every stage below the second looks current right up until you fix the one above it, at which point the next warning appears. A director discovers the work one layer at a time, in the worst possible order, having already re-run half of it.

`lib/impact.js` walks it transitively and reports **two states**, which is the whole value of the thing:

- **redo** — out of date, and everything it is built from is current. Do it now.
- **waiting** — out of date *only* because something above it is. Regenerating now would build on the same old inputs and cost money to produce something still wrong.

Without that split, one rewritten scene reports forty red items and reads as "start again" — which is wrong, and the fastest route to the warnings being switched off. Stages that were never generated are not reported at all, since an absent clip is not behind; and an unstamped artefact is outside the workflow rather than suspect, the same rule every other fingerprint here follows.

The chain is derived from `PIPELINE_STEPS.depends`, with `scene_card` prepended as the root — nothing generates a card, a person writes it, so it is not in the orchestrator's graph, but it is what every generated stage ultimately reads. Steps with no pipeline dependency are wired to the card rather than left rootless, which is what makes a screenplay revision reach the whole shot.

Served at `GET /projects/:id/impact` and as `impact_report` (**113 tools**). The board shows both reports in one banner and marks each affected frame, because a director does not care which subsystem noticed.

### Editing One Scene
The screenplay is the source and `film_scenes` is a projection of it, so writing a scene's description directly puts the two out of step: the row says one thing, the document another, and every report built on either is right about the wrong text. But requiring a whole-document rewrite to change one scene is its own bug, and a quiet one — the caller has to reproduce every *other* scene faithfully from memory, and the cost of one stray reflow is invisible: scene 1's shots get marked as behind and a director redoes work nobody asked for.

`PUT /film/scenes/:id` splices. `lib/scene-splice.js` finds the scene's span in the Fountain, swaps those lines, and hands the whole document to the same reconciler a full rewrite uses — one new version, scenes reconciled, ids preserved, shots intact, and every other byte identical, so the drift report stays honest because it is comparing text that genuinely did not move. On a real edit to scene 3 of an 8-shot project: `drift → scene 3: 3A, 3B`, `impact → scene_card: redo, keyframe: waiting`, and scenes 1 and 2 untouched.

Three details are load-bearing. The title page is **not** a scene, or scene 1 could not be spliced without destroying it. A leading `.` forces a heading and `..` escapes a line that genuinely starts with a full stop — backwards, that splits a scene mid-dialogue. And the old scene's **trailing blank lines are put back exactly**: trimming and appending a fixed separator looks tidier and is wrong at the end of a document, where the last scene's trailing newline vanishes, so re-saving a scene with the text it already has produces a new version and a false warning. *Did that apply?* has to be a free question — an unchanged save returns `changed: false` and writes nothing.

Scenes reach MCP as `scene_get` and `scene_update`, and `script_get` now returns the **screenplay** rather than the version list it used to fetch while its description promised the source — worse than a missing tool, because the model believes it has read the script and rewrites from a summary. The listing moved to `script_versions`.

### What Actually Reaches an Image Prompt
`buildStoryboardPrompt` reads `sceneCard.action || sceneCard.description` and **nothing else** from the writing. The scene's screenplay text is loaded into context and never used. That is the right rule — a card is *this shot*, and pasting the whole scene would describe things out of frame and spend the prompt budget on them — but it makes the card the only place a nuance can live, and whoever edits one was working blind.

`GET /shots/:id` now returns `scene_text` beside `card`, with the rule stated in the response: only the card reaches the prompt, so anything the screenplay says that the card does not restate will not appear in the frame.

### The Page Follows the Database
The SPA went stale whenever an agent wrote through MCP, and the obvious diagnosis — *it has no framework* — is wrong. React re-renders when state in the **same process** changes; these writes come from a different process against the same SQLite file, which no client framework can observe. What was missing is a transport, and the codebase already speaks one: every long generation streams over SSE.

`PRAGMA data_version` is the whole mechanism, and its asymmetry is the design. SQLite moves it when **another** connection commits and leaves it alone for the connection doing the writing — so the SPA's own POSTs, which go through this server, raise no event (it already knows about those, and echoing them back would fight the user's typing), while an MCP write does. Cost is a header-page read, not a query.

The alternatives were worse. Browser polling spends a request per client per interval to learn nothing, almost always. A file watcher on the `.db` is unreliable under WAL, where commits land in the `-wal` and the main file may go untouched for minutes.

`GET /film/events` streams `hello` then `change`. Saying the current version first matters: a client that cannot tell *here is where we are* from *something just happened* reloads on every reconnect, which on a flaky connection never settles. A refresh that arrives while a modal is open or a field is focused is **deferred, not dropped** — dropping it leaves the page wrong for as long as the modal is, and the user closes it expecting to see what they just did.

### Locking a Subject Is Not the Same as Plating One
Generating a plate does **not** create a consistency profile, and that is deliberate: a plate is evidence of what a subject looks like, a profile is the commitment that generation conditions on. But there was no way to create one from an agent — `consistency_list`, `consistency_lock` and `consistency_unlock` existed with nothing to lock, so an agent that plated a new prop reached step "now lock it" and found the profile it needed did not exist and could not be made. `consistency_create` closes it, idempotent per subject so a second call returns the first profile rather than a duplicate.

### The Story Bible Is a Source, Not a Notes Field
A bible is prose and **no prose reaches an image model**. Four fields do — a character's `appearance_prompt`, a location's `description`, a prop's `visual_prompt`, and the project's `style_preset` — and everything else in this database is decoration as far as a generated frame is concerned. A place that merely *stores* a bible would repeat the mood board's first mistake: collect writing nobody reads, call it a feature, and let a director paste sixty pages in believing their frames are now conditioned on it. Every response and every tool description says so outright.

What earns it a table is the **link back**. `film_story_bible` (migration 070) holds sections keyed by heading, and a character, location or prop records which section its description was written from — passed on the update by whoever wrote the words, because only they know which section they were reading. Revising that section then flags the entity *and reports whether a plate was generated from it*, since "MAYA's section changed" and "and her plate was built from the previous version" are different sizes of problem.

Sectioned rather than one document, and that is the whole reason it is usable: a single fingerprint over the bible would mark every character in the film as behind the moment someone fixed a typo in the world rules. Writing **merges**, so fixing one section cannot lose a chapter to a retry. NULL means *not written from the bible*, never stale. And deleting a section does **not** unlink what came from it — the entity keeps saying where it came from and the report names the deletion, because losing the record that a description came from something that no longer exists is worse than the gap itself.

`bible_get`, `bible_write`, `bible_delete`, `bible_drift`, plus `bible_section` on the three entity update tools.

### A Regenerated Frame Has to Look Regenerated
Regenerating a frame overwrites the file at the same name, so the URL never changes and the browser served the cached image. A successful, paid-for regeneration left the board byte-identical — the screen literally showed *nothing happened*, and the honest response to that is to press the button again and pay twice. `frameSrc()` keys the URL to `asset_version`, which increments per generation, rather than to a timestamp: busting on every render would re-download every unchanged frame on the board on each refresh, which on a feature-length board is a lot of bytes spent hiding one bug. Both surfaces use it, or the viewer shows a stale frame over a fresh grid and it looks like the regeneration half worked.

The button gave no feedback either. `Regenerating...` went to the status bar at the bottom of the screen while the card you clicked looked exactly as it had a moment before — for up to a minute, since the image call may walk past a provider that declines before one accepts. The frame being generated now says so **on the frame**, with an elapsed count, and the card's own buttons are disabled while it runs, because the one thing a slow generation invites is a second click on a paid action. Same reasoning as arming a markup shape: feedback belongs on the thing you touched.

### The Trimmer Has to See the Whole Prompt
Locked consistency profiles append their `prompt_contract` **after** `buildStoryboardPrompt` has assembled against the provider ceiling — so the ceiling was enforced on a string that then grew by thousands of characters. On a real establishing shot: a ~1,500-character base plus three locked profiles adding **3,445**, for **4,946** against a 4,000 ceiling.

Three symptoms, one cause, and every one of them looked like the model misbehaving. The provider truncates the **tail**, and the tail was the location — so the street stopped looking like the street. A 653-character description of a lawn sprinkler sat **first**, right after the quality tags, so it was drawn the size of the car beside it. And the style preset was outweighed three to one by object prose, so the look went with it.

`fitAdditions` holds the ceiling and orders by `ADDITION_RANK`, which mirrors the reference selector's `KIND_RANK` for the same reason it exists there: with limited room, identity and place outrank objects. The base prompt — the action, the camera, the look — is **never** cut to make room for a description of an object in the frame, and a trimmed description keeps its opening, which is what the thing *is*.

**A subject travels as a picture AND its description. Both, always.** Shortening a described subject to a name because its plate is attached was tried and reverted. The reasoning was sound — a plate shows what a subject looks like, so describing it again is redundant — and it was wrong in practice for one reason: **the picture does not always arrive**. A provider takes three references and a shot can want five; one generation path was attaching none at all. Every time the picture was missing, the shortened subject travelled with neither words nor image, and the model built whatever was still described at length — which is how an establishing shot came back as a product photograph of a car on grey seamless. A redundant description costs room; a missing one costs the shot.

The flat `prompt_additions` array is left untouched alongside `prompt_addition_items`, because the video path and `routes/video-gen.js` read it — established by auditing the consumers before changing anything.

**But this is a safety net, not the plan.** The engine can hold a ceiling; it cannot decide what matters. Cutting at a clause boundary has no way of knowing that *"one wheel trim missing"* is worth keeping and *"bench seats in cracked tan vinyl"* is not — whoever is composing does. `GET /shots/:id/prompt` (`shot_prompt`) hands over the whole picture and **spends nothing**: the assembled prompt, the ceiling, the headroom, which plates travel as images, and every contributor with how much it wrote and how much survived. `storyboard_regenerate` takes that composition back as `prompt_override`. A subject whose picture is attached needs **naming, not describing at length** — which is where most of the room was going.

### How Big Is It
An image model has no metric understanding — nothing in it knows a lawn sprinkler is thirty centimetres. A reference plate makes this **worse rather than better**: a plate is a close-up filling its own frame, and conditioning transfers appearance rather than size, so the model reproduces what it was shown. The sprinkler plate produced a sprinkler the size of the car beside it. The plate was doing its job; nothing was telling the model how big the thing is.

Three levers work, in descending order of strength. **Frame fraction** — *"about one 25th of the frame width"* — is strongest, because it is a statement about composition rather than about the world; it needs a lens and a distance, which is what previs supplies, and it applies to the **framed subject only**: everything else is at some other distance, and pricing a mid-ground car at the subject's coverage said a five-metre car fills most of a seven-metre frame. **An anchor** — *"roughly 1.4 times smaller than a car tyre"* — works on any shot. **A plain measure** is the floor. A person is the anchor everything else is measured against, so a person is given a height and not compared to a doorframe.

Migration 071 adds `height_m` to characters and `height_m`/`width_m`/`length_m` to props, NULL by default — and **undeclared means the prompt says nothing about scale** rather than guessing, because an invented default is indistinguishable from a deliberate one and would be wrong silently. The negative is built from the size too, and names a **tight** bound: things come out too big, never too small, and *"larger than a house"* is a bound a wrong image can satisfy.

**The size is usually already written down.** Every prop on the first production that needed this stated its own size in its description — *"about forty centimetres tall"*, *"roughly seventy centimetres across"*, *"about five and a half metres nose to tail"* — and nothing was reading them, so the person filling the field was being asked to invent a number that sat two lines above. `scale_check` surfaces those sentences per subject, in words or in figures. **Surfaced, not parsed**: word-numbers, ranges and mixed units make a parser that is right most of the time, and a size that is silently wrong is worse than one that is absent, because it reaches every frame the subject appears in looking deliberate. Whoever reads the report converts it in one step.

`GET /projects/:id/scale-check` (`scale_check`) reports the gap as work rather than as a status — each subject with the number of shots it appears in, ordered by that count, and flagged harder when it has a plate, since plate-without-size is the exact combination that fails. On Wingfall it opened at **6 subjects, 28 shot appearances at risk**, every one of them plated.

### Chrome Should Not Charge Rent
Five buttons — Home, Jobs, Notes, Guide, Setup — held a 64px column down the full height of the screen, on every page, permanently. They are global actions, and a global action belongs beside the other global furniture rather than in a column of its own; they now sit at the right of the top bar. The rail width survives as a variable set to **zero** rather than being deleted, because the panel, the main pane and the status bar all offset by it — one arithmetic expression beats five hand-edited numbers that can disagree.

The **"Search anything"** pill went with it, because it never searched anything: its only behaviour was opening the glossary. Which is exactly the trap in removing it — the glossary's other link lives in the old sidebar, which is `display:none` in this layout, so deleting the pill left a modal in the build with no way to reach it. A removal is finished when everything that was reachable still is, so the glossary became the sixth rail button. `tests/nav-chrome.test.js` checks every rail button resolves to a page or an explicit handler, since a button wired to nothing looks identical to a working one until it is clicked.

### The Home Page Answers Four Questions
The dashboard reported on the project — a quick-nav button row, a stat grid, a shot-status bar, a milestone list. That is a summary, and a summary leaves the reader to work out the next action and then go and find the page it lives on. The submitted design is six blocks that each answer something and carry the way in: **greeting** (who is here, which film, how big), **resume** (what you were doing), **needs you** (what is blocking it, each linked), **phases** (the whole film, six real fractions), **activity**, **running now**.

Everything is **derived**, never stored: the phase fractions count real shots and assets, *needs you* is assembled from reports that already exist — keyframes missing, unresolved notes, scenes never broken down, subjects without a size, cards behind the screenplay — so an item can never disagree with the page it links to. The greeting's name is the app-settings author, the one place a name is recorded.

`tests/home-page.test.js` is set-based over the six blocks and checks each **three** ways: it renders into a container, it reads `home.<field>` from the payload, and the API serves that field. A block hardcoded with the design's own sample text passes any check that only looks for markup — which is exactly how a home page gets half-built and read as finished.

### A Prop In The Shot Gets Its Plate
Characters were matched from `sceneCard.characters` and props from `sceneCard.props`. On a real production every card came back with `props: []` while the descriptions plainly named a sprinkler and a grocery bag — so the prop plates a director had generated, accepted and locked **attached to nothing**, and both objects were invented per-frame instead. The plate system worked; nothing was feeding it.

The card's array is a hint, not the truth. `matchProps()` unions it with any project prop the description names, so a plate attaches because the object is in the shot rather than because somebody remembered to list it — the same reasoning that made scene presence read action lines rather than only dialogue cues. Whole-word matching only: "bag" inside "baggage" is not the grocery bag, and a plate attached on a coincidence puts the wrong object in frame.

### Shot Tagger and the Mood Board (Phase 3)
**`POST /scripts/:id/tag`** turns selected screenplay lines into shots — the fastest path from a script to a shot list, and the one that was missing: shots were created by hand, or by an agent composing a scene card from scratch. Selecting the line is quicker *and* more faithful, since the line **is** the description and nothing is paraphrased on the way. It also captures presence at the only moment anyone is actually looking at the line; deriving "who is in this shot" later from the scene as a whole is what produced a DRAGON that appeared in no scene. Only `action` and `dialogue` become shots — refusing sluglines and transitions is the feature, because a tagger that accepts everything produces a list a director has to clean up, which is worse than typing it. Idempotent per element (the card records `source_element_id`), so clicking a line twice means "did that work", not "make another".

**The mood board** (`routes/mood-board.js`, migration 064) is where a look is decided before anything generates, and its **output is the style preset** — a board that sits beside generation is a scrapbook; one whose output feeds generation is look development. Entries carry a `kind` (palette, lighting, lens, framing, texture, image) and a `note`, and composing orders them by facet rather than by insertion: medium and palette lead, grain trails, the same front-to-back rule the plate builders learned when appending the look last let boilerplate decide the medium. Image-only entries contribute no words, and say so, rather than silently dropping out of a style that claims to represent the board.

Composing **does not apply**. Previewing a look and committing to it are different decisions, and applying silently would rewrite every future frame from something the director was only trying out; `apply: true` commits. An empty board composes `''` with a message rather than writing an empty style, since applying that would strip the look from a project that already had one. And composing runs the style check, so the "anatomical beast" class of defect is caught **at the moment the look is decided** rather than after eight frames have been paid for.

A separate table from `film_continuity_refs` on purpose: continuity refs answer "did this match what we already shot" — a question about the past — while a mood board answers "what should this look like", a question about work not yet done. Same shape, opposite direction, and conflating them would make both queries lie.

### Storyboard Markup and Grouping (Phase 3 close-out)
**Markup** (`routes/annotations.js`, migration 065) puts a director's fastest notation on a frame: arrow, line, rect, ellipse, freehand, text. Two decisions carry it. Geometry is stored **normalised** — `[[x,y], …]` in 0..1 of the frame, never pixels — so a frame regenerated at another resolution, or a board read on a phone, keeps every arrow on the thing it points at; a pixel coordinate sent by mistake is **refused** rather than stored silently to draw nowhere. And markup attaches to the **shot, not the asset**: a note is about the shot and the PNG is one attempt at it, so keying it to an asset id would erase the direction at the exact moment it was acted on. Whether markup should later *feed* the next generation was PAR-026 and Open Question 3; it is answered below, opt-in and off by default. The board draws it on a hand-rolled overlay canvas, same as previs and the flows canvas.

**Panel grouping and setups are different questions that look alike.** Grouping by scene, location or time of day is for *reading* — a flat grid of two hundred frames is a contact sheet. Every frame lands in exactly one group, and frames missing the axis value collect under an explicit `(no location)` rather than vanishing, since a frame that disappears when you change how you read the board looks like data loss.

**Setups are for working, and the set metaphor has to be translated rather than copied.** On a set you group by camera position because *moving* is what costs. Here nothing moves — the cost is conditioning, so a setup is shots sharing a location plate, a framing and a lens, which reuse the same references and the same look. Location leads the key because the plate is the most expensive thing to be wrong about. The key is deliberately narrow: widening it would merge shots whose frames genuinely differ and claim a reuse that does not exist, and `reused_shots` is a number a run plan is meant to trust.

Served at `GET /projects/:id/{board-groups,setups}`, `GET|POST /shots/:id/annotations`, `DELETE /annotations/:id`, and as three more MCP tools (77 total).

### The Mood Board, Properly (words + images + specs)
The first version was a text composer with a photo album bolted on — its own comment admitted that "image-only entries contribute nothing to the words", so a frame pinned to the board changed no output anywhere, and every technical choice on it was free text that could reach a prompt string and nothing else. It now produces **three** outputs, each wired to the subsystem it belongs to.

**Words** compose into `style_preset`, as before, with the subject check.

**Images become style references on generation.** `lib/reference-images.js` has had a `KIND_RANK` of `style: 3` since it was written and **nothing ever filled it**. Board images now do, through `gatherShotReferences`, so a pinned frame conditions every keyframe rather than describing one. Ranked below character and location deliberately: with three reference slots, a look plate displacing the actor would be the wrong trade every time, because a viewer notices a different face long before a different grade.

**Specs are picked from the engine's own registries and land somewhere real.** Eight kinds, each declaring a target: `lens`/`sensor`/`aperture` → **previs** (so a card that specifies nothing opens on the film's own optics rather than a generic 50mm super35), `aspect_ratio`/`resolution`/`frame_rate`/`colour_space` → **project settings** (the same columns the settings UI writes, so a look decided here and one typed there cannot disagree about what is delivered), and `style_preset` → the prompt. The registries are *referenced*, never copied — a local list of focal lengths would drift from `LENS_KIT` the first time a lens was added, and the drift would surface as a lens the board offers and previs refuses.

One translation is load-bearing: `resolution` is picked as a preset **id** (`"1080p"`) and stored as **dimensions** (`"1920x1080"`), because `target_resolution` is what every exporter parses. Writing the id would pass validation and break the export.

### Conform: shots into a film
`assembly` has been a no-op since it was written, returning `"use export endpoints to finalize"` — so an orchestrated run reports success and there is no movie, and the `video_master` QA check goes green on shot 1 of N.

`lib/conform.js` plans the film: which cut of each shot ships (`video_final` > `video_synced` > `video_raw`, so a graded shot is never conformed from its raw clip), in timeline order, with the project audio mix as master when one exists and the clips' own audio when it does not — inventing a silent track would deliver a mute film that looks successful. **A missing shot refuses the conform**: a film that renders while missing shot 7 plays fine and is wrong, and nobody finds out until somebody watches all of it.

**Planning is pure and separate from executing**, which is what makes the feature testable at all: conforming needs a media tool this repo deliberately does not depend on, and ffmpeg is not installed on the machine this was written on. `availableExecutors()` probes rather than assumes — local ffmpeg, or the provider stitch path — and reports why each is unavailable. `buildFfmpegArgs` returns an argument **array**, never a shell string, since file paths and titles come from the database.

### Deleting a Project (and a bug that hid behind empty ones)
`DELETE /projects/:id` returned **500 on any project that had generated a character reference sheet**. `film_refsheet_jobs` declared both foreign keys with no `ON DELETE` action, so removing a character it referenced was refused, and the refusal cascaded up to the project delete. It stayed invisible because the only projects ever deleted were empty ones — the first attempt on a project with real work in it hit it immediately, and the failure mode was the bad kind: the rename meant to accompany the delete succeeded, leaving two projects with the same name and no way to remove either.

Migration 067 rebuilds the table with `ON DELETE CASCADE` — a refsheet job records an attempt to draw a particular character, so without the character it is a row that can never be interpreted again rather than an orphan worth keeping (both columns are `NOT NULL`, so `SET NULL` could not be honoured anyway). It hits the same trap 057 documented: `film_unified_generation_jobs` SELECTs from the table, so the view is dropped and **recreated verbatim from 057's own definition** rather than retyped, since a rebuilt view that differs from the one it replaced is a silent behaviour change.

`tests/project-delete.test.js` is set-based over the nine tables a worked-on project accumulates, because a delete is only safe if *every* child goes with it — one that leaves rows behind is a slow leak surfacing much later as orphaned assets.

**The warning now states the stakes.** "This cannot be undone" tells the reader the rule, not what they are about to lose; the confirm names the scenes, shots, characters and generated assets that go with it, and says plainly that generated media cost money and cannot be recovered. If the counts cannot be read it warns *harder*, not softer. A failed delete now says nothing was removed, rather than surfacing a generic error that leaves the user unsure whether half of it went.

### A Plate Is a Photograph, Not a Document
The first real plate generated after the medium fix came back photoreal, correctly dressed — and covered in **sheet furniture**: a handwritten `FRONT / mid 30s` caption, a colour-swatch chart labelled in gibberish, a strip of tape. The person underneath was right; the document drawn around them was not. The cause is the phrase itself — `character reference sheet` is an instruction an image model follows literally — and the negative said only `text, watermark`, which covers almost none of what actually appeared.

All three builders now ask for the photograph (`Full-body studio photograph`, `Photograph of the location`) and refuse the furniture explicitly: labels, annotations, captions, handwriting, charts, swatches, arrows, callouts, measurement marks. The **view is still named**, because without it three plates are three unrelated pictures rather than a turnaround. This matters more than a cosmetic blemish: a plate conditions every frame its subject appears in, so anything printed on it bleeds into all of them.

**And a correction, caught by a test rather than by reasoning.** The obvious next move — "a picture is attached, so drop the paragraph describing it" — is right for a provider that reads `@tags` and **wrong** for one that takes an untagged array. With two references and no names, nothing tells the model which picture is the woman and which is the street, so the prose is the only thing carrying identity; dropping it trades a redundancy for a wrong subject. That distinction was already correct in the code and this nearly broke it. `tests/reference-capability.test.js` is what stopped it.

### Nothing Is Trimmed While It Still Fits
The per-field allowances applied unconditionally, so a 570-character style was cut to 560 inside a prompt totalling 2,085 against a ceiling of 4,000 — throwing away the tail of a director's look with 1,900 characters of headroom going unused. The clause that vanished was *"wet reflective ground with specular sheen"*, which is exactly the sort of thing someone puts on a board deliberately.

An allowance is a rule for deciding **what to cut when something must be cut**. It was being read as a target to shrink every field to. So the prompt is now assembled **whole** first, and the carve-up only happens if the result overruns the provider's ceiling.

The first pass has to be *genuinely* untrimmed — neither per field nor at the ceiling. Leaving the ceiling trim in place made it cut the untrimmed assembly back at a clause boundary, which came in under budget, so the second pass never ran and the prompt ended up as one enormous field and nothing else. At 1000 the fields carve up as before (appearance 240, everything present); at 4000 they all survive whole.

### The Prompt Ceiling Belongs to the Provider
`MAX_PROMPT_CHARS` was a single constant — 1000, chosen as "the strictest of the providers wired here", which is **Runway's** `text_to_image` cap. Every prompt in the product was cut to it regardless of who was generating. A production running on **Meshy** — whose text-to-image documents no prompt limit at all, and which routes to `nano-banana` and `gpt-image-2` underneath — had its character descriptions trimmed to fit a ceiling belonging to a provider it never called.

Each image adapter now declares its own `promptLimit`, with the reason attached: runway 1000 (documented, and the number the old constant was really about), openai 4000 (the Images API's documented prompt length), meshy 4000 (no stated limit, matched to the models it proxies rather than invented), gridlight 1000 (a swappable local agent, held strict rather than guessed upward — over-guessing produces a rejected request at the provider, which is worse than trimming here where it can be reported). An adapter that declares nothing falls back to the strict default, never to unlimited.

The per-field allowances had the same problem one level down. 240 for an appearance and 200 for a location were never facts about appearances and locations; they were a **carve-up of that 1000**. Held fixed, a provider with four times the room received exactly as much of what the director wrote and the extra went unused. `allowancesFor(ceiling)` makes them shares — the old numbers divided by the old ceiling — so at 1000 they reproduce exactly and no existing project's prompts change shape. The remaining 12% is the fixed vocabulary (shot type, lens, movement, lighting, quality tags), which does not scale because it is a phrase list rather than prose.

**Descriptions themselves were never limited** and still are not: a plate prompt carries the full `appearance_prompt` or `description` untrimmed, which is the point of a plate. Only the *keyframe* prompt trims, because there the description is one ingredient among action, camera, lighting and style that must all fit one request.

### Screenplay → Entities (the step that was never wired)
A screenplay upload created **no entity rows at all**. `GET /projects/:id/screenplay/suggestions` detected characters and locations and returned `suggested_action: 'create'`, and nothing ever acted on it — `INSERT INTO film_characters` existed only in the manual CRUD route and the demo seeder. So every character, location and prop had to be typed by hand, and whatever the user forgot was re-invented by the image model on each shot, silently.

Worse, detection only read **dialogue cues** (`el.type === 'character'`). A character introduced in an action line in caps — which is exactly how screenplays introduce one — was invisible. On Wingfall that was the DRAGON, the title creature: never suggested, never created, no description, and therefore a different animal in each of eight frames while the location, which did have a description, stayed rock solid across all of them. The project's `style_preset` contained the words "anatomical beast", which filled the vacuum with a flayed quadruped in the establishing shot the scene card describes as "Empty, ordinary, still."

Three routes close it. `actionIntroducedCharacters()` finds caps entities in action, behind a stoplist rather than a cleverer regex (sluglines, transitions, sounds and camera instructions are also caps); it leans permissive, because a wrong suggestion is declined in a second while a miss is a subject re-invented per shot. `POST /projects/:id/screenplay/suggestions/apply` creates the rows, idempotent on name so a script revision adds what is new rather than duplicating what is there, and it deliberately does **not** invent descriptions — a plausible-but-unauthored placeholder is the thing it exists to replace (`"EXT location (3 mentions in screenplay)"` was reaching image prompts as though it described a place). `POST /projects/:id/entities/describe` then writes what is blank, via the LLM, from the screenplay: a separate pass rather than more fields on the scene-card call, because card parsing is load-bearing and re-runnable matters as a script is revised. It fills **only empty** fields unless forced — a hand-written description is a decision — and reports `still_blank`, since an entity that stays blank generates a bare name and must not look like success.

MCP gains `entities_create`, `entities_describe`, `character_create`, `location_create` and `prop_create` (57 tools at the time). `character_update` and `location_update` both required an existing id and nothing created one, so an agent host could describe entities it was powerless to bring into existence — the reason the manual data entry happened in the first place.

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

`lib/nav-flow.js` regroups all 34 pages into the nine `PROJECT_PHASES` the status machine already declares, so the sidebar and the phase a project reports itself in cannot disagree. Served over `GET /film/nav-flow`; the SPA **moves** the existing buttons rather than rebuilding them, keeping every tooltip and handler. **Two views, two questions, two technologies.** The wireframe stage answers *where does this stand and how does it read in frame* — that stays hand-rolled canvas 2D, and `lib/glb-parser.js` feeds it silhouettes with materials deliberately stripped. The textured pane answers *is that actually the character*, and a real material cannot be faked with a 4×4 matrix and a polygon painter, so it runs **three.js r149 + GLTFLoader, vendored inline** against the same `.glb`. Inlined rather than linked because `build.target: single-html` — index.html is ~1.6MB as a result, which is the price of the constraint. `GLTFLoader` ships ESM-only, so it is converted to a classic script by the same mechanical transform three's own `examples/js` build used to perform: the `three` import becomes a destructure from the global, the one helper it borrows from `BufferGeometryUtils` is inlined, and the export becomes an assignment.

`GET /models/:assetId/file` serves the .glb to the viewer; `GET /models/:assetId/geometry` serves decimated points and triangles to the stage. Two endpoints because they answer different questions — the geometry one strips exactly what the viewer exists to show.

**Phase 4 is built: a generated `.glb` can be staged.** It stayed unbuilt because loading a mesh looked like it required Three.js, which would have meant a bundler and the end of `build.target: single-html`. It did not. Previs already had the 4×4 projection and the polygon painter; the only missing piece was something to turn GLB bytes into points and triangles, and that is `lib/glb-parser.js` — glTF 2.0's positions, indices and node transforms, and nothing else. Materials, textures, normals, UVs, skins and animation are all skipped deliberately: previs is grey-box, what a director judges is where a subject stands and how it reads in frame, and a silhouette answers that completely.

Parsed and decimated **server-side** (`GET /models/:assetId/geometry`), because the browser has no bundler to read binary glTF with and a hundred-thousand-triangle character would otherwise cross the wire in full before being thrown away. Decimation samples evenly rather than taking the first N — the first N of an exported mesh is usually one limb, while an even stride keeps the whole silhouette — and it reports what it dropped. Vertices are kept whole so the bounds, and therefore where the model stands and how big it reads, do not move with the budget. A model that has not arrived or failed to parse draws as its bounding box rather than vanishing, since a silent disappearance reads as a failed click.

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

**A route that ships without a tool is a thing the app can do and an agent cannot.** `POST /film/projects` worked from the first week and had no `project_create` for months, so an agent could write a screenplay into a project and could not bring one into existence. Nothing failed — the capability was simply absent, which is the hardest gap to notice because there is no error to read. A test over the tool list can only confirm what someone remembered, so `tests/mcp-no-server-llm.test.js` derives the expectation from the **routes**: for each entity it reads which HTTP methods the module actually dispatches and requires a tool for each. Both `req.method === 'X'` and `req.method !== 'X'` count — `annotations.js` guards its delete with the negated form, and a detector that saw only `===` reported a gap where there was none. A derived test that is wrong about the code is worse than a hand-written one, because it is believed.

**No MCP tool may call a server-side LLM.** The agent host *is* the model — that is what lets the pipeline reach an LLM with no API key of its own. A tool that hands the reasoning back breaks it twice: it asks the user to hold a second key for a question the connected model has already read, and when that key has no credit it fails with a billing error the model cannot act on and will simply retry. It is an easy mistake, because the route exists, works over HTTP, and wrapping it looks like closing a gap — `breakdown_run` was added for exactly that reason and came straight back out, taking the pre-existing `entities_describe` with it. The replacements are the plain data tools, and they are strictly better: a model composing a card or a description has the whole revision in context rather than one scene of it (`script_get` + `shot_create` + `card_vocabulary`; `character_update` / `location_update` / `prop_update`). `tests/mcp-no-server-llm.test.js` derives the forbidden set from the **source** — any route module that requires the LLM client — so a tool added later against one of them fails there rather than in front of a director halfway through a revision.

**Listed is not callable.** `plate_generate` sat in `BATCH_TOOLS` carrying `handler`, `path` and `handlerFor` — the shape of a *route* tool — and no `run()`. The batch branch of `callTool` calls `.run(a)` unconditionally, so every invocation died on `run is not a function` before reaching a route. It failed identically for every subject and every kind, which reads like a data problem and was not: the tool had never been callable once since the day it shipped. Nothing in the suite caught it, because every other check asks whether a tool is **listed** — and it was listed, described, schema'd and advertised. Three checks now close it: every batch tool has a `run()`, no batch tool carries route-only fields, and every listed tool resolves to a registry entry it can actually dispatch through. That last rule is written against `path` rather than `handler`, because the flow tools set `handler: null` deliberately and dispatch by path — asserting on `handler` reported two working tools as broken, which is how a guard gets relaxed until it protects nothing.

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

SQLite via `better-sqlite3`. Schema auto-migrates on startup (72 migrations).

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
node --test backend/tests/glb-parser.test.js
node --test backend/tests/spec-consumption.test.js
node --test backend/tests/shot-card-edit.test.js
node --test backend/tests/script-revision.test.js
node --test backend/tests/screenplay-drift.test.js
node --test backend/tests/impact.test.js
node --test backend/tests/mcp-no-server-llm.test.js
node --test backend/tests/scene-edit.test.js
node --test backend/tests/live-events.test.js
node --test backend/tests/story-bible.test.js
node --test backend/tests/subject-scale.test.js
node --test backend/tests/nav-chrome.test.js
node --test backend/tests/home-page.test.js
node --test backend/tests/app-settings.test.js
node --test backend/tests/artefact-staleness.test.js
node --test backend/tests/production-reports.test.js
node --test backend/tests/run-plan.test.js
node --test backend/tests/look-development.test.js
node --test backend/tests/shot-tagger.test.js
node --test backend/tests/mood-board.test.js
node --test backend/tests/storyboard-annotation.test.js
node --test backend/tests/annotation-feedback.test.js
node --test backend/tests/shot-anchor.test.js
node --test backend/tests/screenplay-port.test.js
node --test backend/tests/scene-append.test.js
node --test backend/tests/scene-insert.test.js
node --test backend/tests/board-grouping.test.js
node --test backend/tests/look-specs.test.js
node --test backend/tests/conform.test.js
node --test backend/tests/project-delete.test.js
node --test backend/tests/prompt-budget.test.js
node --test backend/tests/provider-prompt-limit.test.js
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
