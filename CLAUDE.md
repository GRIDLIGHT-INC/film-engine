# Film Engine

AI film production pipeline for Gridlight. Transforms screenplays into editor-ready output through automated scene breakdown, storyboarding, and asset generation.

## Quick Start

```bash
cd backend
npm install
node server.js            # the API, on :3100

node backend/dev-server.js # the page, on :3200 — from the repo root
```

Server runs on `http://localhost:3100`. Database auto-initializes on first run (SQLite at `data/film-engine.db`).

## Architecture

```
film-engine/
├── backend/
│   ├── server.js           # HTTP server + routing (port 3100)
│   ├── mcp-server.js       # MCP stdio server (JSON-RPC, no SDK)
│   ├── preflight.js        # End-to-end readiness report (CLI, exits 1 if blocked)
│   ├── dry-run.js          # What every service would be sent, without sending it (CLI)
│   ├── spike-world.js     # Is a Marble world usable as a previs stage? Three answers, $0.20 (CLI)
│   ├── ableton-sidecar.js  # The Ableton sidecar: loopback-only, token-gated, an allowlist of typed AbletonOSC operations (run by hand)
│   ├── instrument-sidecar.py # The instrument sidecar: supervises plugin workers, loopback and token-gated (run by hand)
│   ├── instrument-worker.py # One plugin job in its own process: a real main thread for the editor, and a crash costs one job
│   ├── db/
│   │   ├── database.js     # SQLite connection (better-sqlite3)
│   │   ├── schema.js       # Auto-migration runner
│   │   └── migrations/     # SQL migration files (113 migrations)
│   ├── routes/
│   │   ├── projects.js     # Project CRUD
│   │   ├── project-storage.js # A project's folder: where its files are, choosing one, moving it
│   │   ├── production-graph.js # The Production phase as one graph: the graph, layout and Tidy, and the video/sound version pointers
│   │   ├── edits.js        # Cuts made in Premiere: import by version, attach the XML/EDL, serve the picture
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
│   │   ├── sounds.js          # Every audio file in the film, one card each, and one prompt to make another
│   │   ├── music-midi.js      # A cue’s notes: parts over a plan, written by the agent or played by the director
│   │   ├── post-production.js  # Post-production pipeline (Phase 9)
│   │   ├── pipeline.js         # Pipeline orchestrator (Phase 12)
│   │   ├── qa.js               # QA checks & quality gates (Phase 13)
│   │   ├── project-bundle.js   # Project export/import bundles
│   │   ├── subtitles.js        # Subtitle CRUD + SRT/VTT export (Phase 17)
│   │   ├── audio-deliverables.js # Audio deliverables + manifest (Phase 17)
│   │   ├── continuity.js       # Continuity reference board (Phase 18)
│   │   ├── credits.js          # Credits + title cards (Phase 18)
│   │   ├── marketing.js        # Posters and key art: upload one, or generate in the film's look
│   │   ├── budget.js           # Budget & cost tracking (Phase 18)
│   │   ├── backups.js          # Auto-backup system (Phase 18)
│   │   ├── flows.js            # Flow CRUD + graph validation (Phase 1)
│   │   ├── previs.js           # Previs blocking CRUD + framing solve (Phase 2)
│   │   ├── worlds.js           # Worlds, versions, calibration, pinning, lock
│   │   ├── generation-jobs.js  # Outstanding generations, and collecting them
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
│   │   ├── story-structure.js  # Beat sheets, holes, and house rules on the writing
│   │   ├── story-development.js # Treatment, screenplay analysis, and what a scene costs in time
│   │   ├── subject-gallery.js  # A character, location or prop as a workspace, not a form
│   │   ├── voice-casting.js    # The catalogue, the casting, the audition, the table read
│   │   ├── agent-presence.js   # Which path an AI request takes, and why
│   │   ├── story-bible.js      # What things ARE, and which entity was written from which section
│   │   ├── media-import.js     # Footage and sound made outside Film Engine: one route, all seven kinds
│   │   ├── uploads.js          # Resumable transfer: create, append, ask where you got to, finalise
│   │   ├── sequences.js        # Several shots, one continuous move: plan free, generate, or upload
│   │   ├── music-sessions.js   # The score session over a picture sequence: sessions, tracks, clips, batch, brief, drift, rebase
│   │   ├── deliverables.js     # The output list, and which ratios must be shot rather than cropped
│   │   ├── brands.js           # The brand library, the claims register, and the free compliance report
│   │   ├── approvals.js        # Decision packets: may I run this, and which of these is the take
│   │   ├── repair.js          # Run a repair — the half that spends, kept apart from the free plan
│   │   ├── frame-handles.js    # One frame, to whoever holds the id — the id IS the credential
│   │   ├── instruments.js      # The instrument library: capture a patch, scan NKS presets, keep what plays a part
│   │   └── demo-project.js     # Seeded demo project for first-run
│   ├── lib/
│   │   ├── fountain-parser.js     # Fountain markup parser (AST)
│   │   ├── fountain-renderer.js   # Fountain → HTML renderer
│   │   ├── fdx-parser.js         # Final Draft XML parser (import)
│   │   ├── fdx-generator.js      # Final Draft XML generator (export)
│   │   ├── nle-export.js         # NLE format generators (pure functions)
│   │   ├── screenplay-parser.js   # INT./EXT. scene heading parser
│   │   ├── screenplay-pagination.js # Where a page may break, and what it may not split
│   │   ├── screenplay-blocks.js   # An empty block is 32px of nothing, except where the caret is
│   │   ├── screenplay-timing.js   # Eighths, screen time and shooting effort are three numbers
│   │   ├── screenplay-analysis.js # The rubric, the note schema; the model does the reading
│   │   ├── subject-gallery.js     # Reference, concept, inspiration: only one reaches a prompt
│   │   ├── voice-casting.js       # Cast a voice, hear a line, before anything is shot
│   │   ├── dialogue-delivery.js   # How a line is SAID, and how long to hold after it
│   │   ├── scene-score.js        # A score for THIS scene, from facts the engine already holds
│   │   ├── music-sections.js     # A cue that changes over its own length
│   │   ├── midi.js               # Notes in milliseconds, validated against the cue; a Standard MIDI File written and read back
│   │   ├── instrument-render.js  # Notes become sound: FluidSynth probed, a SoundFont whose licence is known, a render judged by its volume
│   │   ├── instrument-host.js    # The director’s own plugins, held by a sidecar: loopback, token, an allowlist, a render finished by the shared rule
│   │   ├── instruments.js        # One SOUND out of one library: a plugin and the state that recalls the patch
│   │   ├── instrument-presets.js # An NKS preset read without opening anything: its PCHK chunk IS the patch
│   │   ├── instrument-catalogue.js # The director’s own sounds, read LIVE out of Kontakt’s index and never copied
│   │   ├── music-session.js      # What a score session IS, and the one read model every consumer receives
│   │   ├── music-context.js      # Everything the engine knows about a picture unit, compiled once and fingerprinted per field
│   │   ├── music-stems.js        # A composer's stems, aligned: the original is sacred, the placement shares one start
│   │   ├── music-renderer.js     # The deterministic bounce: what the session says is what the file holds
│   │   ├── music-capabilities.js # Six music workflows; every provider answers for each, and "no" has a reason
│   │   ├── music-emotion.js      # The model proposes the arc, a person accepts it, nothing paid rests on a proposal
│   │   ├── music-separation.js   # A recording split into stems: a derivative, aligned under its source, from an untrusted ZIP
│   │   ├── music-generation.js   # Compose, parts, reference, picture, inpaint: every output a new take, nothing replaced
│   │   ├── music-jobs.js         # One parent, ordered children, and a parent status derived so it cannot lie
│   │   ├── music-package.js      # The portable score package: one byte-stable archive any DAW can open and Film Engine reads back
│   │   ├── music-approval.js     # The approved score: selected once, placed once at its picture's offset, and no scene music under it
│   │   ├── music-rights.js       # Origins declared not assumed, derivatives carry their sources, one lineage, one warn/block policy
│   │   ├── music-health.js       # Every score operation by area, what is stalled and how to recover — no secret, no path
│   │   ├── daw-adapter.js        # The DAW contract and the driver: acknowledged, idempotent, bounded to Film Engine's own tracks
│   │   ├── daw-registry.js       # Which DAW adapters the engine can reach, how each is configured, and the seven Ableton tools
│   │   ├── daw/                  # DAW adapters behind the contract
│   │   │   ├── memory.js         #   the reference DAW, in memory, that can be told to misbehave
│   │   │   ├── ableton.js        #   Ableton Live through the sidecar: marker-named tracks, tempo, supervised transport
│   │   │   └── fake-live.js      #   the AbletonOSC subset over real UDP, for testing the sidecar — no Ableton in it
│   │   ├── osc.js                # OSC 1.0, the subset AbletonOSC speaks: a codec that refuses what it cannot read
│   │   ├── ableton-osc.js        # The AbletonOSC client: pinned, handshaken, correlated, heartbeat-supervised, allowlisted
│   │   ├── character-sheet.js     # Four official views, four reference categories, six regions
│   │   ├── scene-card-schema.js   # Scene card YAML validator
│   │   ├── storyboard-prompt.js   # Storyboard prompt engineering + style lock
│   │   ├── reference-images.js    # Tagged reference plates: data URIs, tags, ≤3 selection
│   │   ├── reference-plates.js    # Location + prop plate generation (shared implementation)
│   │   ├── image-fallback.js      # Walk credentialed image providers on refusal
│   │   ├── gridlight-client.js    # Shared HTTP client + request queue + 429 retry
│   │   ├── file-storage.js        # Shared file storage utilities
│   │   ├── project-folders.js     # One folder per film, laid out in the order the film is made
│   │   ├── project-storage.js     # Choosing a project's folder, reading it, and moving it — files first, rows second, both or neither
│   │   ├── edits.js               # An editor's cut brought home: versioned, measured, never overwritten
│   │   ├── edit-cut.js            # Final Cut Pro XML and EDL read back into which shot plays where
│   │   ├── uploads.js            # A transfer that survives losing the connection
│   │   ├── media-imports.js       # Every external asset: plates, board images, footage and sound
│   │   ├── orientation-plans.js   # One current plan scan; prior scans move to recoverable storage
│   │   ├── media-kinds.js         # Where a generated media file goes, said once
│   │   ├── capture-policy.js      # What a capture may be, from the ceilings that actually bind it
│   │   ├── capture-settings.js    # What a plate was shot at — a bad field is dropped, never the photograph
│   │   ├── plate-consistency.js   # Exposure is ISO x shutter; colour is mired, not kelvin
│   │   ├── capture-to-world.js    # A capture nobody can generate from is a file, not an input
│   │   ├── video-sequence.js      # N shots -> N-1 interpolated segments, planned without spending; a cut join makes nothing
│   │   ├── production-graph.js    # Every node, edge and group read in one pass; linked frames resolved to the selected version
│   │   ├── inbetweens.js        # A shot as a strip of stations, not a still
│   │   ├── inbetween-run.js     # Walking a strip: each station refined from the one before it
│   │   ├── ffmpeg.js              # Finding an encoder, and joining clips into one file
│   │   ├── clip-coverage.js       # One clip containing several shots, read by all five assemblies
│   │   ├── running-order.js       # The order the film plays in, said once for all five assemblies
│   │   ├── dialogue-builder.js    # Dialogue extraction + voice payloads
│   │   ├── video-prompt.js        # Video prompt builder + camera control
│   │   ├── motion-prompt.js    # A video model is sent MOTION, not a description of the picture it was given
│   │   ├── music-prompt.js        # Music/SFX/ambient prompt builder
│   │   ├── pipeline-engine.js     # Pipeline step sequencing + dependency resolution
│   │   ├── viseme-builder.js     # Phoneme-to-viseme mapping (MPEG-4)
│   │   ├── video-stitcher.js     # Multi-clip stitching for long shots
│   │   ├── audio-mixer.js        # Audio mix, ducking, stems, SRT
│   │   ├── qa-checker.js         # QA checks, continuity, acceptance rubric
│   │   ├── scheduling-engine.js  # Smart scheduling & GPU model residency
│   │   ├── project-bundle.js    # Project export/import (.tar.gz bundles)
│   │   ├── quality-tiers.js      # Draft/Standard/Precision → a provider and a model
│   │   ├── image-standard.js     # The house rule: Nano Banana Pro at the project's own resolution — outranks every tier and pin
│   │   ├── angle-explore.js      # Four angles on one shot, one camera each; pick one and it is the frame
│   │   ├── generation-override.js # What a director chose for THIS generation, read once
│   │   ├── dry-run.js           # Every capability described from its own builder, nothing sent
│   │   ├── thumbnails.js        # A 260px card should not cost 1.5MB
│   │   ├── waveform.js         # What a sound LOOKS like, so a card can be read at a glance
│   │   ├── audio-features.js  # What a sound file actually IS, read from the file
│   │   ├── board-raster.js   # A frame is stored at the size it was ASKED for, not the size it came back
│   │   ├── image-raster.js   # What size a picture on disk actually IS, read from its own header
│   │   ├── plate-delivery.js # Filing a plate from either road, and adopting the ones made before this
│   │   ├── sequence-delivery.js# Where a leg's finished clip goes, said once for both roads it arrives by
│   │   ├── flow-cost.js          # Projected cost + the budget gate (Phase 3)
│   │   ├── flow-templates.js     # Six ready-made flows, validated at load (Phase 5)
│   │   ├── flow-executor.js      # runFlow / executeNode / resolveNodeInputs (Phase 2)
│   │   ├── node-handlers/        # Per-node execution, autoloaded by filename (Phase 2)
│   │   │   ├── index.js          #   registry (mirrors lib/providers autoload)
│   │   │   ├── port.js           #   the { type, value } envelope an edge carries
│   │   │   ├── input.js          #   in.prompt, in.asset, in.subject, in.scene
│   │   │   ├── generate.js       #   all 10 gen.* nodes, one implementation
│   │   │   ├── transform.js      #   tf.mix, tf.stitch, tf.encode
│   │   │   ├── control.js        #   tf.fanout, tf.select
│   │   │   └── output.js         #   out.asset, out.assembly, out.timeline
│   │   ├── flow-graph.js         # Flow graph algebra: validate, cycles, topo, ports (Phase 1)
│   │   ├── flow-node-types.js    # Runtime node-type registry: ports, kinds, arity (Phase 1)
│   │   ├── flow-seed.js          # Built-in flow derived from PIPELINE_STEPS (Phase 1)
│   │   ├── mcp-tools.js          # MCP tool surface, generated from the registries
│   │   ├── mcp-build.js         # Which build a connection is actually serving
│   │   ├── shot-motion.js       # A camera move, seen over the still you already have
│   │   ├── subject-sheets.js    # A location and a prop are workspaces too
│   │   ├── previs-camera.js      # Previs optics: FOV, framing distance, DOF (Phase 0)
│   │   ├── previs-blocking.js    # Previs blocking: rigs, movement paths, shot solving (Phase 1)
│   │   ├── previs-primitives.js  # Stage primitives: standing figure, box, sphere (Phase 5)
│   │   ├── previs-pick.js        # Unproject + hit test for direct manipulation (Phase 6)
│   │   ├── nav-flow.js           # Sidebar order, derived from PROJECT_PHASES (Phase 6)
│   │   ├── e2e-preflight.js      # Screenplay→final-shot readiness, derived from PIPELINE_STEPS
│   │   ├── capability-payloads.js # ONE provider payload path per capability (Phase 0)
│   │   ├── annotation-prompt.js   # Markup a director drew, said in words a model can act on
│   │   ├── shot-anchor.js        # The frame you are currently shooting from
│   │   ├── shot-staging.js       # Where things stand, said from the camera about to shoot them
│   │   ├── prompt-lint.js        # Language that describes what is NOT in the frame
│   │   ├── shot-references.js    # The plates a shot generates with, gathered once for every path
│   │   ├── decision-contract.js  # Which stored choices are the same director decision, seen twice
│   │   ├── beat-sheets.js        # Four story frameworks, and the holes in a structure
│   │   ├── agent-presence.js     # Is an agent host attached, and what it would replace
│   │   ├── artefact-fingerprint.js # What a generated artefact was made from (staleness)
│   │   ├── screenplay-drift.js    # Which shots a rewrite left behind, and what was built on them
│   │   ├── impact.js              # One change, all the way down: redo now vs waiting on something above
│   │   ├── scene-splice.js        # Replace one scene in a screenplay, byte-identical elsewhere
│   │   ├── story-bible.js         # Bible sections, and the link back from what was written from them
│   │   ├── subject-scale.js       # How big a thing is, said so an image model can act on it
│   │   ├── home.js                # The six blocks the home page renders, all derived
│   │   ├── production-reports.js  # Sides + DOOD, over repaired scene presence
│   │   ├── run-plan.js            # Strips, model-swap ordering, projected cost (above the orchestrator)
│   │   ├── repair-plan.js        # Marks in, plan out — and a floor that is named before it is met
│   │   ├── playback-marks.js     # A mark on the film is an offset in a file, and they are not the same number
│   │   ├── frame-handles.js      # A frame a provider can fetch: opaque, scoped, expiring
│   │   ├── repair-run.js         # Extract, host, generate, splice, register — and every failure names its stage
│   │   ├── video-edit.js        # Keep the actor, change the background — priced from the SOURCE
│   │   ├── repair-bridge.js      # A fault that lives BETWEEN two shots: a bridge, not a splice
│   │   ├── look-development.js    # Style presets carry a look, not a subject
│   │   ├── board-grouping.js      # Board groups for reading, setups for working
│   │   ├── conform.js             # Shots → one film: pure plan, probed executors
│   │   ├── export-package.js     # The XML plus the media it names, and what is wrong before you hand it over
│   │   ├── deliverables.js       # A commercial is a fan-out: one row per file that leaves the job
│   │   ├── brand-kit.js         # A brand outlives a project; every field says what it reaches
│   │   ├── draft-video.js       # Draft while working, finish at the end — and what 480p actually costs
│   │   ├── compliance.js        # Checks that must run BEFORE spend, never after
│   │   ├── spot-package.js      # The Premiere handoff, planned but not written
│   │   ├── consistency-apply.js  # Pure consistency application (no DB import)
│   │   ├── consistency-context.js # Locked profiles → reference payloads
│   │   ├── provider-media.js     # Buffer-vs-URL normalisation + gateway origin check
│   │   ├── providers/worldlabs.js # World Labs Marble: a location's plates become a navigable world
│   │   ├── providers/fluidsynth.js # A cue's written notes played through local instruments; composes nothing, never a default
│   │   ├── worlds.js            # A world, its versions, and which one a shot is framed inside
│   │   ├── world-scale.js       # A reconstruction has no unit until somebody measures one thing in it
│   │   ├── world-assets.js      # What a world ships, and which parts we keep rather than link
│   │   ├── cinematography.js    # Facts out, proposal in, validated — the engine never decides
│   │   ├── camera-validate.js   # Can this camera be shot? Six checks, and one that only warns
│   │   ├── generation-plate.js  # Geometry truth handed over; the model owns everything else
│   │   ├── reference-match.js  # A composition you want, from marks you made — never from pixels
│   │   ├── data-paths.js      # A profile that moved repairs itself; a working path is never touched
│   │   ├── approval-envelope.js # Everything needed to decide, as free data — warnings included
│   │   ├── approval-guard.js  # An approval must not outlive the inputs it was given for
│   │   ├── review-proxy.js    # A clip small enough to look at, or nothing at all
│   │   ├── shot-complexity.js # How likely is this shot to come back wrong, before it is paid for
│   │   ├── world-export.js    # Seven files, and every one names the geometry it came from
│   │   ├── llm-client.js         # Shared LLM call helper
│   │   ├── budget-estimator.js   # Pre-flight cost estimation
│   │   ├── provider-pricing.js  # What a generation costs, in the provider's own units
│   │   ├── generator-costs.js   # Which generator to use: every price, one comparable unit
│   │   ├── prop-categories.js   # What a prop may be, said once for the picker, the tool and the CHECK
│   │   ├── plate-views.js       # Which view of a subject carries identity
│   │   ├── character-orbit.js   # A turnaround from ONE orbit, not three separate rolls
│   │   ├── plate-isolation.js   # A subject plate is the subject and nothing else
│   │   ├── style-book.js        # The director's own shots, applied to a film's
│   │   ├── usage-meter.js       # Every provider call, metered and attributed
│   │   ├── mcp-usage.js         # The agent host is the model; its traffic is the LLM meter
│   │   ├── spend-backfill.js    # What a project spent before anything was tracking it
│   │   ├── provider-config.js   # One provider-config reader, carrying the project id
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
│       ├── provider-tiers.test.js      # Every adapter declares its contract; every tier resolves
│       ├── image-standard.test.js      # Nano Banana Pro at every decision point, sized from the project's resolution, in the body MuAPI receives
│       ├── angle-explore.test.js       # Four cameras, four generations, nothing on the board until one is picked
│       ├── gridlight-optin.test.js     # The local gateway is off until switched on, for all 10 capabilities
│       ├── dry-run.test.js             # The report shows the real request, no keys, no printed pictures
│       ├── paid-image-controls.test.js # Every image AND video button: pick the generator, read the prompt, edit it
│       ├── thumbnails.test.js         # Boards fetch thumbnails; bundles survive subdirectories
│       ├── shot-motion.test.js       # The move plays over the frame, and says what showing it costs
│       ├── director-controls.test.js # Redo the dialogue, direct the score, read the toolbar
│       ├── subject-sheets.test.js  # Every region of a location and prop sheet is drawn and fillable
│       ├── subject-sheet-design.test.js # The sheets, against the designs they were drawn from
│       ├── subject-sheet-fidelity.test.js # ...and against the designs' GEOMETRY, not just their labels
│       ├── previs-storyboard.test.js   # Blocking shapes the keyframe, and round-trips
│       ├── previs-loop.test.js         # Every edge of the storyboard↔previs iteration loop
│       ├── decision-parity.test.js     # Every director decision, held to five links across both surfaces
│       ├── previs-decisions.test.js    # Each decision tried, applied, locked or stale — and the one-screen console
│       ├── previs-views.test.js        # Look / 360° / Depth / Plan, the splats endpoint, and From Previs in Production
│       ├── previs-boundary.test.js     # Paid routes share one payload path and honor the Apply boundary
│       ├── screenplay-to-entities.test.js # A screenplay creates the entities generation reads
│       ├── storyboard-prerequisites.test.js # Plate medium, panel captions, previs over MCP
│       ├── glb-parser.test.js          # A synthetic .glb parses, transforms apply, decimation bounds hold
│       ├── world-spike.test.js     # The Marble request this engine would actually send
│       ├── world-engine.test.js    # A world exists, is versioned, is pinned — and knows it has no scale
│       ├── world-console.test.js   # The console renders what the design draws, and nothing when the flag is off
│       ├── previz-console-placement.test.js # ...and in which column — derived from the handoff's own headings
│       ├── world-flags.test.js   # A flag turned off hides its region, instead of being declared and ignored
│       ├── direct-the-shot-panel.test.js # An intention is stated, the MODEL proposes, the engine validates
│       ├── explore-shot-panel.test.js # Six cameras, one world, and a comparison the page does not compute
│       ├── console-regions.test.js # Every region the design draws, fed from real state rather than demo data
│       ├── console-layout.test.js # The handoff's own geometry, computed rather than grepped
│       ├── adr-spark.test.js     # A decision record that fails when the facts it rests on change
│       ├── cinematography.test.js  # The model directs; the engine hands over facts and refuses the impossible
│       ├── world-timeline.test.js  # A surface over the move model that already existed, driving no second one
│       ├── generation-plate.test.js # The plate leads, travels as bytes, and spends nothing
│       ├── reference-match.test.js # Marks not pixels, a confidence that is earned, and seven traceable exports
│       ├── data-paths.test.js   # Every path column, a real move, and a registry that cannot go stale
│       ├── project-folders.test.js # Every kind of file has its folder, lands in it, is found, served, and moved
│       ├── edits.test.js           # Every cut format round-trips; every reader of a score's picture follows the edit
│       ├── warnings-clear.test.js  # Every storyboard warning is cleared by the button it offers
│       ├── redo-between-frames-brief.test.js # A plan whose facts drifted is worse than no plan
│       ├── ios-previz-brief.test.js  # ...and so is a brief whose facts drifted
│       ├── ios-previz-epic.test.js   # An epic is a registry: held to itself and to the code
│       ├── plate-camera-epic.test.js # A gap pinned as permanent makes an epic fail for succeeding
│       ├── capture-affordance.test.js # Shooting is not uploading, and arming the upload would cost the library
│       ├── upload-size-guard.test.js  # An oversize upload must say so, not look like a dead server
│       ├── marble-contract.test.js   # A field name asserted in a comment is one nobody can re-check
│       ├── world-capture-import.test.js # A capture is three media under one target, and the bytes say which
│       ├── is-pano.test.js          # The input Marble calls most accurate, and nothing could ask for it
│       ├── capture-policy.test.js  # Three ceilings, and the one that actually decides
│       ├── location-plate-provider.test.js # Reaching the floor is a provider choice, not a setting
│       ├── view-anchoring.test.js   # An edit cannot move the camera, and the director should learn that first
│       ├── capture-to-world.test.js # Three kinds of capture, and they do not map the same way
│       ├── aleph-contract.test.js  # A reseller's description of somebody else's API is a secondary source
│       ├── aleph-adapter.test.js   # The first video-to-video path, held to the contract not the epic
│       ├── aleph-pricing.test.js   # An estimate that is not a number is not a gate
│       ├── redo-between-frames-epic.test.js # Every task well formed, every claim still true
│       ├── epic-scoping-copy.test.js # A scoped epic that is not the epic is worse than no copy
│       ├── rbf-001-video-edit-probe.test.js # A paid answer nobody can re-read will be paid for twice
│       ├── rbf-002-verdict-recorded.test.js # A question answered in one file and still asked in three
│       ├── frame-extraction.test.js  # One frame, one moment, one clip — and one implementation
│       ├── splice.test.js           # Head, new, tail — and a join that must not move every cut after it
│       ├── media-inspect.test.js    # What a clip actually IS, read from the file rather than the row
│       ├── repair-plan.test.js      # A plan that spends cannot be raised speculatively
│       ├── playback-marks.test.js   # Two marks, two units, and a mirror that must not drift
│       ├── frame-handles.test.js    # Handing a local file to the internet, and everything that must not be
│       ├── repair-run.test.js       # A repair is an attempt; the take it improves must survive it
│       ├── repair-tools.test.js     # A capability with no MCP surface is one the model cannot use
│       ├── repair-audio.test.js     # A repaired master that lost its sound is a broken deliverable
│       ├── range-requests.test.js   # A suffix range is the END of the file — the black screen in playback
│       ├── background-replace.test.js # Every stage names itself; every entry point one runner
│       ├── seedance-video-edit-retired.test.js # A measured trap must not read as the cheap option
│       ├── repair-bridge.test.js    # Across a cut, neither shot is the one at fault
│       ├── editor-transport.test.js # A mark you cannot place on the frame you meant is not a mark
│       ├── repair-dispatch.test.js  # Every path that starts a repair must tell a bridge from a splice
│       ├── bridge-retrieval.test.js # A deliverable nobody can list is one nobody receives
│       ├── approval-envelope.test.js # A packet you can decide from, and an approval that cannot outlive its inputs
│       ├── take-candidates.test.js # Which attempt is the take, newest first, and why each exists
│       ├── review-proxy.test.js  # Null rather than oversized, and never re-encoding what has not changed
│       ├── handover-commands.js    # Every command in the handover, executed — a doc nobody runs is typos
│       ├── spec-consumption.test.js    # Every mood board spec changes a real payload, not just a column
│       ├── shot-card-edit.test.js      # A scene card can be edited, merged not replaced, and goes stale
│       ├── script-revision.test.js     # Revising a story does not cascade the production away
│       ├── screenplay-drift.test.js    # A rewrite flags the shots written from the old draft
│       ├── impact.test.js              # A changed frame warns that the footage built on it is behind
│       ├── mcp-no-server-llm.test.js   # No MCP tool hands the reasoning back to a server-side LLM
│       ├── mcp-staleness.test.js  # A connection that predates the capability it is asked for
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
│       ├── mood-board-images.test.js   # A picture pinned to the board is a picture you can see
│       ├── storyboard-annotation.test.js # Every shape round-trips; markup survives regeneration
│       ├── annotation-feedback.test.js # Marks steer a prompt only when asked, and say when they cannot
│       ├── shot-anchor.test.js   # One anchor, held deliberately; it carries the set and replaces the plates
│       ├── shot-staging.test.js  # The words agree with the render; an unnamed object stays silent
│       ├── blocking-and-directing.test.js # Both jobs, on both surfaces, from one panel each
│       ├── direct-shot-ui.test.js  # The director's surface: screenplay, blocking, cinematography, no machinery
│       ├── board-lock.test.js      # A finished board refuses everything that would replace a frame
│       ├── frame-send.test.js      # A picture moves to another shot as a copy, never a move
│       ├── reference-limit.test.js  # How many plates fit is the provider's answer, not a constant
│       ├── oversize-references.test.js # A plate too big to inline is resized, never silently dropped
│       ├── current-frame.test.js   # Every surface paints the version you selected, not the newest
│       ├── shot-insert.test.js    # A shot goes in mid-scene without renaming a single thing
│       ├── playback-start.test.js # Playback opens on the shot you were working on
│       ├── anchor-plate-override.test.js # An anchor covers where a subject stands, not who they are in close-up
│       ├── location-views.test.js  # A location has views; a shot picks the one it is pointed at
│       ├── recompose.test.js       # Keep the performance from one frame, take the place from another
│       ├── recompose-payload.test.js # What the provider actually receives, in order
│       ├── board-grouping.test.js      # Every axis groups the whole board; setups share conditioning
│       ├── look-specs.test.js          # Board specs reach previs and project settings; images become references
│       ├── conform.test.js             # Every shot contributes one clip; a missing shot refuses
│       ├── conform-sound.test.js       # The master carries the film's own dialogue, score and ambience — measured, not grepped
│       ├── bug-hunt-fixes.test.js      # The bug hunt's fix plan held to the code: every dispatch awaited, every stream guarded
│       ├── project-delete.test.js      # A worked-on project deletes, and takes every child with it
│       ├── prompt-budget.test.js       # Plates are photographs, not documents; prose drops only where tags bind
│       ├── provider-prompt-limit.test.js # Each provider's own ceiling; allowances scale with it
│       ├── image-prompt-ceiling.test.js  # The ceiling every image prompt is built against, pinned to evidence
│       ├── prompt-quality.test.js       # Is the request we send a good one: fallback ceilings, one resolver, full accounting, priority, negatives
│       ├── prompt-contributors.test.js  # A contributor collected and never emitted, dropped in silence
│       ├── camera-units.test.js        # "1.6 metres" must mean 1.6 metres above the floor, in any world
│       ├── media-imports.test.js        # Registry-derived persistent Storyboard, Previs image, and GLB import contract
│       ├── plate-upload.test.js         # Every kind of reference can be uploaded, not only generated
│       ├── video-sequence.test.js       # Keyframe ceilings per adapter; N shots plan N-1 segments in order
│       ├── inbetweens.test.js        # What a shot's stations are, derived from its own blocking
│       ├── inbetween-plan.test.js    # The strip, planned for free, capped by the model's own contract
│       ├── inbetween-run.test.js     # The chain, the refusal, the correction and the approval
│       ├── clip-coverage.test.js        # One clip, several shots, honoured by every assembly surface
│       ├── production-graph.test.js     # Joins, linked frames, version pointers, playback order and pinned layout, through a real server
│       ├── nle-import-validity.test.js  # The export an NLE will actually open, not merely well-formed XML
│       ├── export-package.test.js      # A handover that opens with the picture online
│       ├── spot-duration.test.js       # A spot is a length, not an approximate length
│       ├── deliverables.test.js        # Fourteen to twenty-two files, planned before anything is boarded
│       ├── shot-aspect.test.js         # A vertical hero shot is generated vertical, or it is lost
│       ├── brand-kit.test.js           # A kit that reaches the frame, not a form nobody consults
│       ├── compliance.test.js          # An unsubstantiated claim cannot start a run
│       ├── spot-package.test.js        # A handoff whose every path stays inside it
│       ├── staleness-cost.test.js      # A report nobody waits six seconds for
│       ├── draft-video.test.js        # The smallest raster a model will actually accept
│       ├── prompt-visibility.test.js   # Every prompt, before every spend
│       ├── paid-preview.test.js         # Nothing spends without showing what it will send
│       ├── generation-controls.test.js # Provider, model, tier and size, on the dialog that spends
│       ├── every-generate-button.test.js # The denominator is discovered, not typed into a list
│       ├── preview-reachability.test.js # A preview that answers 200 with the wrong body is not a preview
│       ├── grid-children.test.js       # A grid child that is not a card takes a card's place
│       ├── upload-anywhere.test.js     # Anywhere a picture can be generated, one can be uploaded
│       ├── aspect-consistency.test.js   # The board and the footage are the same shape
│       ├── resolution-trickle.test.js   # One resolution, set once, reaching every creative
│       ├── staleness-accept.test.js     # A warning you cannot act on is one you learn to ignore
│       ├── dev-server.test.js           # An edit you cannot see is an edit that did not happen
│       ├── mobile-shell.test.js         # The shell on a 390px screen, computed rather than grepped
│       ├── page-handlers.test.js       # A button wired to nothing, and a modal shown with a class the CSS ignores
│       ├── page-route.test.js          # A refresh keeps the page you were on; every page is reachable by URL
│       ├── live-after-write.test.js    # The page's OWN writes reach the screen; a throttle coalesces rather than dropping
│       ├── ios-app.test.js              # The iOS wrapper ships the real page, and can reach a Mac
│       ├── plate-lens.test.js          # The API the ticket named does not exist; the maths is executed, not read
│       ├── plate-exposure.test.js      # A lock that survives a lens change, or crashes on one
│       ├── plate-white-balance.test.js # Normalised to the MINIMUM channel, which is Apple's own rule
│       ├── plate-focus.test.js        # The point survives a lens change; the lens position must not
│       ├── plate-guides.test.js       # A level that is confidently wrong where it is most used
│       ├── plate-capture-settings.test.js # Absent means absent; a bad field never costs an upload
│       ├── plate-frames.test.js       # A stride of zero is not a wrong number, it is a hang
│       ├── plate-peaking.test.js      # A defocused edge must NOT peak, or racking focus shows nothing
│       ├── plate-clipping.test.js     # A warning that fires on every specular highlight is one nobody reads
│       ├── plate-consistency.test.js  # A turnaround with nothing recorded must not claim to agree
│       ├── storage-never-throws.test.js # An accessor that RAISES must not take every function below it
│       ├── nothing-covers-the-page.test.js # A closed drawer's backdrop must not swallow every tap
│       ├── fcc-parity-brief.test.js # A research brief whose facts are pinned to the code it describes
│       ├── film-engine-camera-brief.test.js # ...and whose FRAMING error is stated, not buried
│       ├── fcc-parity-epic.test.js    # An epic that refuses to re-split by medium, and labels its assumptions
│       ├── fcc-recording.test.js     # The camera records at exactly the rate the budget was computed from
│       ├── fcc-transport.test.js     # Fourteen seconds at 4K60, said before the take rather than at upload
│       ├── fcc-audio.test.js         # A clip that lost its sound writes, plays, and says nothing
│       ├── fcc-locks.test.js         # A preset swap releases every lock while the chip still reads LOCK
│       ├── fcc-log.test.js           # Apple Log costs half again as much, and the session overrides it silently
│       ├── fcc-format-picker.test.js # Every format states its cost, and one with no transport is refused
│       ├── fcc-prores.test.js        # ProRes exists, is priced, and is refused until there is a drive
│       ├── fcc-hardware-tier.test.js # Ask the phone what it can do; a model string is the wrong gate
│       ├── fcc-budget.test.js      # A ceiling belongs to a route, not to the engine
│       ├── fcc-system-camera.test.js # The controlled camera, wherever the world is photographed
│       ├── fcc-previz-capture.test.js # A walkthrough is budgeted against Marble, not the upload
│       ├── fcc-footage-to-shot.test.js # A take lands as video_raw, and every assembly picks it up
│       ├── fcc-epic-record.test.js  # Every task the epic did is recorded, or the record has a hole
│       ├── fcc-on-device-proof.test.js # The shoot list has no hole, and claims no shoot that has not happened
│       ├── fcc-external-storage.test.js # The drive is checked before the take, because after costs it
│       ├── fcc-resumable-upload.test.js # A transfer that survives losing the connection
│       ├── card-overflow.test.js        # A button drawn outside its own card
│       ├── generator-costs.test.js     # Comparing what a generator costs, before using it
│       ├── manual-edit.test.js          # If the app stores it, a person can type it
│       ├── muapi-models.test.js        # MuAPI is the house provider: its models must be pickable, and reach MuAPI
│       ├── generation-handles.test.js  # A generation the host abandons is not lost
│       ├── image-weight.test.js       # A 48px avatar should not cost 824 kilobytes
│       ├── sound-library.test.js      # A scene has SOUNDS, not one score and one ambient
│       ├── sound-library-files.test.js # EVERY sound file is a card, and one button makes a new one
│       ├── audio-cards.test.js       # An audio file is a card: what it is, how long, how big
│       ├── audio-format.test.js  # A file called .wav has to be a WAV
│       ├── generation-recovery.test.js# The two ways a paid generation gets lost, and what closes them
│       ├── music-cue-generation.test.js # The cue you wrote is the cue that gets generated
│       ├── music-cue-fields.test.js  # The fields the cue contract promises must reach the generator
│       ├── seedance-image-fields.test.js # Each Seedance workflow names its pictures differently
│       ├── seedance-workflow.test.js # A reference is not a keyframe: plates never become the ending frame
│       ├── modal-stacking.test.js     # A modal opened on top of another must paint on top of it
│       ├── generation-busy.test.js    # While a generation runs, the thing you clicked says so
│       ├── sheet-layout-fidelity.test.js # The three sheets, laid out as the reference images draw them
│       ├── entity-create-fields.test.js # Creating a subject and updating one accept the same fields
│       ├── provider-resolution-visible.test.js # Spend that goes somewhere nobody chose says so
│       ├── provider-config-merge.test.js # A save must not drop the choices it was not asked about
│       ├── credentials-global.test.js   # A key is entered once, for the machine, not once per film
│       ├── plate-views.test.js         # A turnaround is three pictures, and the app used the wrong one
│       ├── plate-medium.test.js        # A character plate takes the film's medium, not a hardcoded photograph
│       ├── ffmpeg-consumers.test.js    # Everything that spawns the encoder reads the field it returns
│       ├── character-orbit.test.js     # Frames of one motion cannot disagree with each other
│       ├── character-orbit-surfaces.test.js # ...and it is reachable everywhere a plate is
│       ├── character-sheet-guide.test.js # Five views, and an orbit is a bootstrap not an anchor
│       ├── character-orbit-surfaces.test.js # ...and it is reachable everywhere a plate is
│       ├── style-book-research.test.js # The style book design covers every surface it touches
│       ├── style-book-plan.test.js     # The implementation plan wires into every registry it must
│       ├── style-book.test.js          # A director's shots, reusable across films
│       ├── style-book-gaps.test.js     # The unproven half: deletes, merges, ceilings, NEVER_WRITES
│       ├── style-book-path-containment.test.js # A path out of the database is not a path you may act on
│       ├── style-book-qa.test.js       # The QA case set, derived from the code it audits
│       ├── plate-viewer.test.js        # A plate you cannot see full size is one you cannot judge
│       ├── location-plate-resolution.test.js # A location plate is 2K or better, or says why not
│       ├── orientation-plan-reaches-the-plate.test.js # The plan a director draws must reach the plate prompt
│       ├── requested-size.test.js       # A resolution that reaches nothing is worse than none
│       ├── style-book-media.test.js    # A visual arrives as a file or a link, and both must work
│       ├── headline-plate.test.js      # A compass side is an extra view, never the headline plate
│       ├── loading-never-sticks.test.js # A spinner that never resolves is worse than an error
│       ├── cue-length.test.js          # A cue is written to the length of the cut, not a default
│       ├── music-cue-mcp.test.js       # An agent can write the music direction, not only press generate
│       ├── mobile-feasibility.test.js  # Could a Film Engine project be worked from a phone
│       ├── screenplay-entities.test.js  # A transition is not a character; a first name is not a second person
│       ├── runway-readiness.test.js     # Exact Runway request, motion, models, costs + sequence modes
│       ├── runway-verdict.test.js       # All ten readiness recommendations, as a set, mutation-proven
│       ├── runway-parity-brief.test.js  # The Runway parity brief, every number derived from the adapter and a dated spec snapshot
│       ├── runway-parity-epic.test.js   # The epic held to its brief, its milestones, its assumptions and the code
│       ├── dialogue-builder.test.js    # Dialogue builder unit tests
│       ├── video-prompt.test.js        # Video prompt unit tests
│       ├── motion-prompt.test.js    # Motion, the spatial locks, and the eight techniques
│       ├── video-model-contracts.test.js # Rates, reference contracts, tiers, and the picture an agent can see
│       ├── seedance-post.test.js       # The 4K finishing pass: a provider for post at all
│       ├── seedance-tiers.test.js      # 480p draft and 4K finish, traced to a real Seedance 2.5 URL
│       ├── video-surfaces.test.js      # A capability with no control does not exist
│       ├── provider-image-encoding.test.js # A bare base64 blob is not an image a provider accepts
│       ├── music-prompt.test.js        # Music prompt unit tests
│       ├── pipeline-engine.test.js     # Pipeline engine unit tests
│       ├── pipeline-scope.test.js      # A scene's score is not a property of one shot
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
│       ├── nav-reorg.test.js              # Four groups, nothing orphaned, nothing left behind
│       ├── previs-camera.test.js         # Optics vs published lens charts (Phase 0)
│       ├── previs-blocking.test.js       # All 18 moves sample, all framings solve (Phase 1)
│       ├── previs-plan.test.js           # 3D previs plan conformance (18 moves, 18 shots, 12 ratios)
│       ├── previs-camera-freedom.test.js  # 6-DOF camera, authored paths, models, preset compatibility
│       ├── previs-camera-contract.test.js # Camera-key units, seams, browser/server parity, staged controls
│       ├── e2e-readiness.test.js         # Preflight covers every stage screenplay→final
│       ├── e2e-first-film-plan.test.js    # The plan for the first finished film, held to the stage registry
│       ├── fixtures/thirty-second.fountain # 30-second E2E test screenplay
│       ├── fixtures/thirty-second.score.json # ...and its score: shots, the arc, the cue, the stems, the Live return
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
│       ├── screenplay-structure.test.js # Every element is reachable, and an outline survives export
│       ├── story-structure.test.js  # Beats find their holes; a scene's history is derived, not stored
│       ├── screenplay-polish.test.js # Export fidelity, and an edit batch that is all-or-nothing
│       ├── screenplay-pagination.test.js # No page ends between a cue and its dialogue
│       ├── screenplay-timing.test.js # Eighths, screen time and shoot effort, kept apart
│       ├── screenplay-analysis.test.js # Thirteen dimensions, seven fields, and no server-side model
│       ├── subject-gallery.test.js  # A sketch must never condition a frame
│       ├── gallery-thumbnails.test.js # A reference you cannot see is an empty square
│       ├── sheet-counters.test.js   # A progress counter cannot exceed its own total
│       ├── sheet-and-board-affordances.test.js # Sections that breathe, a ratio you can see, a shot you can move
│       ├── dialogue-audition.test.js # Hearing a line before anything is shot
│       ├── dialogue-playback.test.js # Watching the scene AND hearing it
│       ├── dialogue-delivery.test.js # How a line is said, and what makes it regenerate
│       ├── scene-score.test.js     # Every scene fact must change the cue it produces
│       ├── music-direction.test.js # Hearing the score, shaping it over time, directing the room
│       ├── character-sheet.test.js  # Two buttons on the card, and everything else has a home
│       ├── character-sheet-authoring.test.js # A region with no way in is a label
│       ├── screenplay-empty-blocks.test.js # The extra space while typing, and why it healed itself
│       ├── screenplay-furniture.test.js # The editor's own furniture is not content
│       ├── screenplay-mutators.test.js # Every way a screenplay is written leaves the editor sound
│       ├── screenplay-continuous.test.js # The editor scrolls; pages are for the count and the print
│       ├── mcp-first-writing.test.js # MCP is the default path; HTTP says it cost you something
│       ├── act-structure.test.js   # Acts are sections; the table and its readers are gone
│       ├── frame-versions.test.js  # Which attempt is which, and which can be chosen
│       ├── mcp-guide.test.js       # The Claude Desktop guide, held to the tool registry
│       ├── prompt-control.test.js  # Who gets the prompt when there is not enough of it
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
│       ├── threed-provider.test.js       # Mesh generation goes to the provider the project chose
│       ├── threed-prompt.test.js         # 3D payload builders
│       ├── timeline.test.js              # Timeline assembly
│       ├── editorial-routes.test.js      # Editorial routes
│       ├── ops-compliance.test.js        # Ops/compliance jobs + provenance
│       ├── budget-estimator.test.js      # Cost estimation
│       ├── ai-spend.test.js              # Every provider call is metered, priced and attributed
│       ├── prompt-diff.test.js           # Prompt/parameter diffing
│       ├── fountain-parser.test.js       # Fountain parser
│       ├── docx-text.test.js             # DOCX text extraction
│       ├── integration.test.js       # Integration test suite (43 tests)
│       ├── music-workstation-editor.test.js # Every field the score validators accept has a control that saves; the mix is heard, not spent
│       ├── music-bounce.test.js         # Every rendered file is measured: silence, overlap, fades, solo/mute, pan/gain, failures, versions
│       ├── music-capabilities.test.js   # Six workflows, every music adapter answers for each, and a refusal names the reason
│       ├── music-emotion-proposals.test.js # Every bound refused out of range, coverage validated, and a proposal reaches nothing until accepted
│       ├── music-separation.test.js # Two and six stems land aligned with lineage; a bad ZIP or a provider error registers nothing
│       ├── music-generation.test.js # Five workflows: the contract decides, no unaccepted arc, every output a new take, parts are not stems
│       ├── music-jobs.test.js # A truth table over child states: no parent is complete over a failed or missing child
│       ├── music-ai-controls.test.js # Every AI action: plan first, one confirmation, the provider's own "no", free ones spend nothing
│       ├── music-package.test.js # Every manifest section, every broken arrival refused by name, the same bytes twice, and the round trip
│       ├── daw-adapter.test.js # Seven operations, every misbehaviour a recorded failure, and nothing outside Film Engine's own tracks
│       ├── ableton-sidecar.test.js # Over real UDP: correlation, timeouts, reconnect, the allowlist, and the DAW contract through the sidecar
│       ├── ableton-mcp.test.js # One tool per DAW operation, none that can set anything else in Live, and the pull gate through the tools
│       ├── daw-sync-ui.test.js # Every DAW operation on the Score page with its portable twin, every connection state rendered, and an editor that never waits on Live
│       ├── approved-score.test.js # The approved mix consumed once at its offset by all six assembly surfaces, measured in the master
│       ├── music-bundle.test.js # A scored project carried to a clean machine: every table, every id new, every file hashed, then reopened, played, rebounced and reassembled
│       ├── music-rights.test.js # Every origin, every derivative writer, every gate × status: rights follow the music and the policy acts where it is stated
│       ├── music-docs-ops.test.js # The workstation documented from its own registries; health readable without a secret or a path
│       ├── music-e2e.test.js # Screenplay → final movie, scored, through MCP: once with no DAW, once through Ableton; recovery, bundle, opt-in real Live
│       ├── instrument-render.test.js # A render the cue's length and not silent; a missing SoundFont caught on volume; licence recorded
│       ├── instrument-host.test.js # Loopback, token and allowlist before any plugin loads; a part rendered through a fake host and a real one
│       ├── instruments.test.js   # A preset built byte by byte and read back; a patch kept and forgotten; a part played, and every refusal
│       ├── score-instruments.test.js # A lane with its own part and its own sound: four refusals by name, a take that joins rather than replaces
│       ├── music-midi.test.js # Parts over a plan survive the file within a frame; a played part replaces one part and outlives a rewrite
│       ├── music-registries.test.js # Every role, clip kind, file kind, workflow, tool, package section and DAW mutation held to its consumers; page and agent editing one session
│       └── helpers.js                # Test utilities
├── docs/
│   ├── claude-desktop-guide.md # Every MCP tool, in the order the work is done
│   ├── ableton-sidecar.md  # Installing AbletonOSC at the pinned commit, running the sidecar; nothing of Ableton's is bundled
│   ├── instrument-sidecar.md # Installing the plugin host, running it, and the two things no plugin host can do
│   ├── music-workstation.md # The score workflow, configuration, provider capabilities, rights, health, backup/restore, migrations
│   ├── api-film.md         # Full API reference
│   ├── plans/              # Design research (previs camera, style book)
│   └── adr/                # Architecture decision records (8 ADRs)
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
| Edits | `GET /projects/:id/edits`, `POST /projects/:id/edits/import`, `GET/PUT/DELETE /edits/:id`, `POST /edits/:id/cut[/rematch]`, `GET /edits/:pid/:file` |
| Folders | `GET /projects/:id/storage`, `POST /projects/:id/storage/move`, `GET /storage/{layout,suggest,browse}` (free), `POST /storage/choose` (the Mac folder dialog) |
| Scripts | `POST /projects/:id/script[/append\|/insert]`, `GET/POST /projects/:id/outline`, `GET /projects/:id/scripts[/:ver]`, `PUT /projects/:id/script/:ver` |
| Scenes | `GET /projects/:id/scenes`, `GET/PUT/DELETE /scenes/:id`, `GET/PUT /scenes/:id/card`, `GET /scenes/:id/history`, `POST /scenes/:id/edit` |
| Story | `GET/POST /projects/:id/beats`, `PUT/DELETE /beats/:id`, `GET/PUT /projects/:id/directives` |
| Bible | `GET/PUT /projects/:id/bible`, `DELETE /projects/:id/bible/:section`, `GET /projects/:id/bible-drift` |
| Shots | `POST /shots`, `GET /projects/:id/shotlist`, `GET/PUT/DELETE /shots/:id`, `GET /card-vocabulary` |
| Characters | `GET/POST /projects/:id/characters`, `GET/PUT/DELETE /characters/:id` |
| Locations | `GET/POST /projects/:id/locations`, `GET/PUT/DELETE /locations/:id` |
| Plates | `POST/GET /locations/:id/plate[/generate]`, `POST/GET /props/:id/plate[/generate]` |
| Props | `GET/POST /projects/:id/props`, `GET/PUT/DELETE /props/:id` |
| Notes | `GET/POST /shots/:id/notes`, `PUT/DELETE /notes/:id`, `POST /shots/:id/review` |
| Assets | `GET/POST /projects/:id/assets`, `GET/DELETE /assets/:id` |
| Dashboard | `GET /projects/:id/home`, `GET /projects/:id/dashboard`, `GET /projects/:id/status-board` |
| Conform | `GET /projects/:id/conform` (free plan), `POST /projects/:id/conform` (the project master) |
| Production graph | `GET /projects/:id/production-graph`, `PUT …/layout`, `POST …/tidy`, `POST\|DELETE /shots/:id/video/select`, `POST\|DELETE /sequences/:id/video/select`, `POST\|DELETE /music-cues/:id/select` |
| Score Sessions | `GET/POST /projects/:id/music-sessions`, `GET/PUT/DELETE /music-sessions/:id` |
| Score Sessions | `GET /music-sessions/:id/{brief,drift}` (free), `POST /music-sessions/:id/{rebase,batch}` |
| Score Sessions | `GET/POST /music-sessions/:id/{tracks,clips,markers,emotion-ranges,automation}`, `PUT/DELETE …/:kind/:childId` |
| Score Sessions | `POST /music-sessions/:id/stems` (aligned import), `GET /music-sessions/vocabulary` (free: enums, ranges, lifecycle) |
| Score Sessions | `GET /music-sessions/:id/bounce/plan` (free), `POST /music-sessions/:id/bounce`, `GET /music-sessions/:id/bounces[/:opId]` |
| Score Sessions | `GET /music-sessions/:id/emotion/brief` (free), `GET/POST …/emotion/proposals`, `POST …/emotion/proposals/:pid/accept` |
| Score Packages | `POST /music-sessions/:id/package`, `GET /music-sessions/:id/packages`, `POST /projects/:id/music-packages/import` (`validate_only` is free) |
| Score Approval | `POST /music-sessions/:id/{approve,unapprove}`, `GET /projects/:id/music-score` (free), `GET /music-sessions/:id/lineage` (free) |
| Score Health | `GET /music-sessions/health[?project_id=&session_id=&probe=true]` (free: every operation area, stalled and failed with recovery, encoder, DAW adapters) |
| DAW | `GET /daw/:adapter/{status,session}` (free), `GET /music-sessions/:id/daw/:adapter/{push,pull}/plan` (free), `POST /music-sessions/:id/daw/:adapter/{push,pull,transport}`, `GET /music-sessions/:id/daw/:adapter/audit` (free, no connection needed) |
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
| Angles | `GET\|POST /shots/:id/storyboard/angles-preview` (free), `POST /shots/:id/storyboard/angles`, `GET /shots/:id/storyboard/angles[/:token]`, `POST …/angles/:token/pick` |
| Voice | `POST /shots/:id/voice/generate[/stream]`, `POST /projects/:id/voice/batch[/stream]` |
| Voice | `GET /shots/:id/voice`, `GET /projects/:id/voice`, `GET /audio/:pid/:file` |
| Video | `POST /shots/:id/video/generate[/stream]`, `POST /projects/:id/video/batch[/stream]` |
| Video | `GET /shots/:id/video`, `GET /projects/:id/video`, `GET /video/:pid/:file` |
| Lipsync | `POST /shots/:id/lipsync/generate[/stream]`, `POST /projects/:id/lipsync/batch` |
| Lipsync | `GET /shots/:id/lipsync`, `GET /projects/:id/lipsync` |
| Music | `POST /scenes/:id/music/generate[/stream]`, `POST /shots/:id/sfx/generate` |
| Music | `POST /scenes/:id/ambient/generate`, `POST /projects/:id/music/batch[/stream]` |
| Music | `GET /projects/:id/music/jobs`, `GET /music/:pid/:file`, `GET /projects/:id/music/capabilities` (free) |
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
| Settings | `POST /projects/:id/settings/preset`, `GET/PUT /settings`, `GET /agent` |
| Shots | `PUT /shots/:id/order`, `PUT /shots/:id/transition`, `POST /projects/:id/shots/reorder` |
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
| Marketing | `POST /marketing/:id/{generate,import}`, `GET /marketing/:id/preview` |
| Budget | `GET /projects/:id/budget`, `POST /projects/:id/budget` |
| Budget | `GET /projects/:id/budget/ledger`, `GET /projects/:id/budget/forecast` |
| Budget | `PUT /projects/:id/budget/limit`, `DELETE /budget/:id` |
| Spend | `GET /projects/:id/spend`, `GET /projects/:id/spend/usage` |
| Spend | `POST /projects/:id/spend/backfill`, `GET/PUT/DELETE /spend/rates` |
| Spend | `GET /spend/subscription` |
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

### One Folder Per Film
*"When we start a new project I'd like to be asked where to save the assets, to be able to change this in the middle of a project, and the folder should be well structured so I can easily find things."*

Every file used to be stored kind-first, `data/<kind>/<project id>/…`, so one film was spread across fifteen UUID-named folders inside a hidden directory. A project now has **one folder** (`film_projects.assets_dir`, migration 113), chosen in the New Project dialog (defaulting to `~/Film Engine/<Title>`, or the `projects_root` setting), laid out in the order the film is made: `01 References`, `02 Storyboard`, `03 Previs`, `04 Video`, `05 Edit`, `06 Sound`, `07 Delivery`, with a note at the top saying what each holds. `05 Edit` arrived later and pushed Sound and Delivery down one; `LAYOUT_RENAMES` renames folders made before that at boot and rewrites their records the way a move does, and every kind still answers to its former folder name, so a path recorded under it resolves either way.

**Only the disk moved.** `PROJECT_LAYOUT` is keyed by the `subdir` every storage call already passes, which is also the URL segment the file is served from, so no serving route changed. `file-storage.dirFor` is the one place that decides; it asks the database on every call rather than caching, because the HTTP and MCP servers are two processes and a project moved by one would keep being written to its old folder by the other. It consults the database only if something in the process already opened it, so a unit test asking for a path cannot open the real database. A project with no folder (every project made before this) keeps the old layout, unchanged.

**Five places read a file's kind off its folder names**, "two directories up is the subdir", which is only true of the old layout. They ask `file-storage.locate` now. **Three calls passed their arguments swapped**: auditions (written to `data/<project>/auditions`, which the old layout kept as-is), `shot_review` (read frames from a path that never existed) and gallery inspiration images (written where nothing served them). A move gathers those strays into their kind's folder, the first time they become reachable.

**A move is files first, rows second, both or neither.** The files are renamed (or copied across disks and verified), counted at the destination, and only then is every stored path rewritten: every TEXT column of every table, not a list of path columns, because paths also live inside JSON and lists go stale. If the rewrite fails the files are put back. The destination must be new or empty. The folder cannot be edited as a field; `PUT /projects/:id` refuses `assets_dir` and names the move.

`tests/project-folders.test.js` derives every kind that reaches storage from the source (every storage call and `subdir` declaration, plus the media registries) and holds each to its own folder: landing in it, round-tripping through `locate`, being served, and arriving after a move from either layout. The rollback is proven with a trigger that refuses the rewrite.

**Browse… opens the Mac's own "Choose Folder" dialog.** A browser cannot hand a page a folder's path, so the server, a process on the Mac, runs `osascript` and returns the POSIX path chosen (`POST /storage/choose`). Only for a request whose socket is loopback: from a phone or another machine the dialog would open on a screen nobody is looking at, so those get 501 and the page falls back to its own folder list. The prompt and starting folder are passed to the script as arguments, never spliced into its text. No MCP tool opens it; an agent has `storage_browse`.

### An Edit Made in Premiere Comes Home
*"Let's say I grab all the clips into Premiere, finish an edit — where do I place this in the folder structure so we can see it in Film Engine, and possibly compose a score for it?"*

Nowhere, before this. Film Engine exported to Premiere and read nothing back, and a score session was written against the ASSEMBLY — shots in running order at their own lengths — while the film that will play is the editor's cut: trimmed, reordered, shots dropped. A score timed to the assembly is timed to a film that does not exist.

**An edit is a version, never an overwrite** (`film_edits`, migration 114). The exported picture (H.264 or ProRes) lands in the project's `05 Edit` folder as `edit_v1.mp4`, `edit_v2.mov`…, measured by the encoder; a container is recognised from its first bytes and the encoder must then read a picture and a length out of it, or nothing is written. A large export travels as a resumable upload that is **moved into place** (`uploads.claimUpload`), never read into memory. It is recorded external/unknown, like any upload: an edit is made of clips whose rights may not be cleared.

**The XML or EDL is read into a cut list** (`lib/edit-cut.js`, no dependency). Premiere's File → Export → Final Cut Pro XML (xmeml) or a CMX 3600 EDL; FCPXML is refused by name rather than misread. The picture is the lowest video track with anything on it; higher tracks are overlays. A clip item carrying `-1` beside a transition is cut at the transition's centre; a disabled clip is no picture. Every event is matched to a shot **by the clip file** Film Engine stored, else **by shot code as a whole token** (`2AA_v3` is 2AA, never 2A; `SC2A` is nothing), else it is **none** — a title or a stock shot, kept and named, because it is still time the score has to cover. Each format is round-tripped through this engine's own exporter for it in the test.

**A score session can be written against an edit** (`film_music_sessions.edit_id`). Every reader of a session's picture follows the cut: the brief's shots are the cut's events at the cut's times; the session is exactly the edit's length, so a bounce's stems line up with the edit's first and last frame in Premiere; the score package carries the edit as its reference picture and names it; the Score page plays the edit above the lanes, following the playhead. **Approval never lays an edit-scored mix on the assembly** — its timing is the editor's — it is reported `on_edit` and delivered with that edit. A newer edit version is **reported** on the session (`newer_edit`) and applied only when asked; an edit a score is written against is not deleted out from under it without `force`.

Served on the **Edit** page (Post), at the routes above, and as `edit_list` / `edit_get` / `edit_import` / `edit_cut_import` / `edit_cut_rematch` / `edit_update` / `edit_delete`.

### The House Image Standard: Nano Banana Pro, at the Project's Resolution
*"For each image, let's follow the standard of the project (Resolution in the technical settings). So if I select 4K then the picture is 4K… it shouldn't be hardwired."*

The first version of the standard hardwired the size — boards fitted inside 3840x2160, every plate a 2048 long edge — whatever the project said, so a 1080p project paid 4K rates for every frame and a director who chose 8K could not get it. **The model stays fixed; the size is now the project's.** `lib/image-standard.js` is read at the four places a picture is decided:

| | |
|---|---|
| **vendor** | `resolveIdWithReason('image')` answers `house_standard` before any pin, env, tier or account default: MuAPI, then Google, then Meshy — the same model sold three ways. A pin to Google or Meshy is honoured; a pin to anyone else is overruled |
| **model** | `withTierModel` names Nano Banana Pro for whichever vendor of it runs (`nano-banana-pro` / `gemini-3-pro-image`), over a pinned model or a tier. The fallback chain renames it per vendor too |
| **walk** | `imageProviderChain` walks a refusal only to another vendor of the same model |
| **raster** | every picture — board, plate, turnaround, refine, angle exploration — takes the **long edge of `film_projects.target_resolution`** in its own shape: 16:9 on a 4K UHD project is 3840x2160, on a 2K project 2048x1152; a 9:16 shot turns it (2160x3840). Long edge rather than fitted-inside, because "2K" means a 2048 edge to the person who picked it |

`projectResolution()` reads the project row or, by id, the database — only if something in the process already opened it, so a unit test cannot open the real one. `callImageGen` fills it on any request that did not carry it, so a route that built its payload by hand still gets the project's size. A project with no readable resolution is **2K** (`DEFAULT_RESOLUTION`), and a new project is created at 2K. MuAPI serves 1k/2k/4k tiers, so a setting above 4K is asked at 4K and the clamp is reported. Marketing posters keep their own format's size — a poster is a deliverable with its own dimensions, not a picture of the film. `tests/image-standard.test.js` changes the setting and requires every picture to follow; a constant would pass any single case.

### Four Angles on One Shot
*"Generate boards of 4 different angles to explore options… then be able to say I love option B and this becomes the shot."*

**Four separate generations, not one 2x2 grid** — the director's choice, because a panel cut from a grid is a quarter of a picture and would need a second paid pass before a video model could use it. Nano Banana Pro has no "give me four" on any vendor, and the vendors that return several return variations of ONE prompt — four near-copies of one framing — so the variety is asked for one camera per request. `lib/angle-explore.js` holds the four defaults (A as written, B reverse, C low and wider, D high and tighter), each a change to a **copy** of the card's camera — never to the action, cast or place — and a named set of four replaces them.

Each angle goes through `regenerateShot` itself with a server-only `capture` option, so it carries the same references, anchor and resolution a regenerate would. **Nothing reaches `{code}.png` until a pick**: candidates are `film_assets` rows (`other`, `kind: angle_candidate`) under `storyboards/<project>/angles/`, and ffmpeg joins them into a free contact sheet (A B over C D). The run answers at once with a token and continues in the background, because four generations outlast the sixty seconds an MCP host waits; the first angle runs before answering so a refusal a regenerate would give arrives as that refusal. The rest run one at a time, and a provider that starts refusing stops the run with the untried angles named. A candidate never records a generation handle, so an abandoned one can never be collected onto the board frame.

**A pick is a file copy**: the frame on the board is archived, the candidate becomes a new version recording `angle_from`, and the other three stay, so changing your mind is another pick rather than another purchase. It is deliberately unfingerprinted (it was generated with a different camera from the card as it stands). A locked board refuses the pick, not the exploration. Served on the board card, the frame viewer and the Production drawer as **4 angles**, and as `storyboard_angles_preview` (free), `storyboard_angles`, `storyboard_angles_list` and `storyboard_angles_pick`.

### Project Settings
Per-project technical settings: resolution (8 presets + custom), frame rate (8 options including 23.976, 29.97), aspect ratio (12 presets including IMAX 1.43:1/1.90:1, anamorphic 2.39:1, Univisium 2:1), color space (sRGB, Rec.709, DCI-P3, Rec.2020, ACES), and 6 delivery presets (Theatrical DCP, IMAX, Streaming HD/4K, Social Media, Broadcast).

### The Old Previs Stage Is Removed
The Previs page is the **World Engine console** and nothing else. The old stage below it — the inspector, the grey-box two-pane canvas, the textured model pane and the twelve-button toolbar — was removed from the page, with its script (99 functions) and its UI tests, at the director's request; a new previs is being designed.

**What stays, because other things read it.** The blocking data model and every `/shots/:id/previs` route (generation still reads applied blocking, the console reads and writes it, and the `previs_*` MCP tools still drive it); the projection maths the console paints with (`previsProject`, `previsAim`, `previsFrameView`, `previsFullView`, `previsAspect`); and `PREVIS.taxonomy`, which the console's timeline names moves from.

**Two things the removal exposed.** The console's shot rail had always been empty: `worldLoadShots` existed and nothing called it, because the old stage's dropdown was the real shot picker. The page loader now loads the console's own shots and opens one, and selecting a shot in the rail loads that shot's world (the old stage used to). The console also painted from the old stage's blocking; it paints from its own now.

Surfaces that were only on the old stage are named, not dropped: uploading a previs image (`previs-image`) is reachable through `previs_image_upload`; staging objects is done through `previs_set`, whose description now says unnamed objects never reach a prompt; camera pose is authored in the console's Camera Operate panel. With `world_engine` off the page says the console is switched off rather than showing nothing.

### Exploring Shots on the Previs Page
The blocking loop was reachable two ways — raw HTTP, or an MCP tool from an agent host — and both are *conversations about* a shot. Neither is standing at the monitor trying the 85 and then the 24 and knowing, in your eye, which one is the shot. Seven operations existed in `routes/previs.js`; the page offered **two**, solve and save. So a director could compute a framing and store it, and could not seed the stage from what was written, see the frame an angle would generate, keep an angle, or say "this one" in a way the pipeline respects. The interesting half of the tool had no surface.

The toolbar now runs the loop in the order you use it: **From card** (seed the stage from the scene card, asking before it overwrites hand-made blocking — re-seeding is exactly the action that would bin it) → **Solve framing** → **Preview frame** → **Apply to card** → **Approve**. `previsPreviewFrame()` shows the prompt this blocking would generate and **spends nothing**, which is what keeps exploration from being rationed: generating each candidate to find out is how trying three lenses becomes a budget decision. A stale approval is caught here and explained, rather than surfacing later as a 409 the director did not know they had earned.

The generated keyframe is shown over the camera pane, because the question previs exists to answer is whether the shot you staged is the shot you got. An approval badge reads `approved` or `approved · stage changed since`, and the button becomes **Re-approve** or **Withdraw approval** — withdrawing is a normal part of changing your mind and should not need a different screen.

*(Superseded: the old stage and this test were removed — see **The Old Previs Stage Is Removed**.)* The explore-UI test was set-based over the operations and checks three separate things per operation: a control exists, it reaches its route, and it is bound to something clickable. The page *did* work for the two it had, so any check written against solve passes in exactly the state this catches — and a handler wired to nothing looks identical to a working page until clicked, which is the bug the flows work shipped once already.

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

### The Keyframe Was Never a Data URI
Zero video has ever been generated through this engine. `promptImage: Invalid input` blocked every attempt, and the two clips that exist were made on Runway's website by hand. The cause was one line, and its correct twin sits one file away:

```
lib/reference-images.js:97   `data:${mime};base64,${…toString('base64')}`      plates    ✅
lib/capability-payloads.js   initImage = fs.readFileSync(p).toString('base64')  keyframe  ❌
```

A **bare base64 blob is not a URL, not a data URI and not a provider handle**, so the API rejected it. The reference plates were always right; the keyframe — the one thing every image-to-video call depends on — never was.

**It was not the size cap**, which is where the reasoning naturally goes and where the external research landed: Runway documents 5MB encoded for an inline image, and a real keyframe here is 1.51MB, about 2.01MB encoded — comfortably inside. The bytes were fine and the envelope was missing.

Built in **`loadShotContext`** rather than at a call site, because the per-domain route, the orchestrator and the flow canvas all read `ctx.initImage`; fixing one would leave the other two sending a blob.

The ceiling is now declared anyway (`DATA_URI_LIMIT`, `tooLargeForDataUri`), because a 2K location plate can approach it — and an oversize frame is **refused with the remedy named** (Runway's ephemeral upload endpoint, `POST /v1/uploads` → a `runway://` URI, 200MB) rather than sent to buy a rejection whose message reads like a credential problem. That endpoint is not implemented yet and the refusal says so.

`tests/provider-image-encoding.test.js` is set-based over every site in `lib/` that inlines bytes with `toString('base64')`, so the next one is covered. `providers/oauth.js` is exempt **by file with a reason** — base64url for a PKCE verifier, never sent as media.

Also corrected from the same research: `hailuo3` was registered with a 10-second ceiling and Runway documents **15**, so a legitimate 15-second request was being clamped.

### A Video Model Is a Rate Card, a Reference Contract and a Tier
The storyboard side had tiers, a fallback chain, per-adapter contracts and a cost comparison. The video side had `DEFAULT_VIDEO_MODEL = 'gen4.5'` and nothing else — nine models declared and nothing that ever chose between them.

**The registry was describing Seedance 2.0 under a name everyone was reading as 2.5.** Runway exposes both, at different rates; `seedance2` here has always been 2.0. It is **not renamed** — renaming it would silently reprice every estimate already made against it — and `seedance2_5` is added beside it with its own card: 20/30/68 credits a second at 480/720/1080p, an **80-credit minimum**, free image references, and reference **video billed at half the output rate per second**.

**`hailuo3` is the interesting one, and the reason is the reference economics.** H3 charges **2 credits per reference image**, so a nine-picture role package costs 18 credits. A 10-second 768P shot with the full package is **118 credits — two credits cheaper than Gen-4.5 carrying no references at all**. That is what makes it the production tier rather than the cheap option.

**References are semantic, not a list.** `lib/video-reference.js` gives each picture a **role** — keyframe, character, creature, prop, location, style, motion, audio — and each model a contract declaring which roles it takes and how many, with the reason stated, the same series `promptLimit`, `maxReferenceImages`, `referenceMode`, `maxKeyframes` and `sizeControl` already follow. **Gen-4.5 stays keyframe-only**, which is the decision being protected: plates were removed from image-to-video deliberately, because the keyframe was already generated from them and re-sending them asks the model which picture is the truth. What changed is that H3 and Seedance can *name* a reference, and `recompose` already proved that references work when they have jobs and fail when they compete. Over-budget references are **reported**, never dropped in silence.

**Tiers are policy, not aliases** (`lib/video-tiers.js`). `draft = gen4_turbo` at 5 credits a second makes a five-second blocking check cost **25 credits**, so trying three angles is a question of taste rather than budget. `production` prefers H3 768P with the role package. **`hero` deliberately has no preferred model**: the most expensive generation in a production should be a decision, not a default — and eventually a router's, from real acceptance data.

**The estimate is computed locally and first.** `lib/video-cost.js` reads the rate card rather than calling a provider's estimate endpoint: a local estimate works before you have an account, works when the network does not, and cannot fail in the way that would block the check it exists to provide. It models the three things that make an estimate wrong — resolution changing the rate, reference **video** billed per second, and minimum charges — and returns the **lines**, because a total with no breakdown cannot be checked and the line a director needs to see is the one they did not expect.

**And an agent can finally see the shot.** Every MCP tool result was `[{type:'text'}]`, so a model could generate a clip and had no way to look at it — "compare this against the board" was blocked at the transport rather than the prompt. `toolResult` now emits image content when a tool returns `images`, and `shot_review` (**180 tools**) hands over the selected board frame plus frames sampled across the clip with the bundled ffmpeg. This is what makes validation free: the connected model **is** the LLM here, so nothing calls a server-side model to do it.

**Every attempt is recorded before the next real shots are generated** (`lib/video-attempt.js`, `film_video_attempts`, migration 087). The router is deliberately **not** built: one tuned on no acceptance data is a guess with extra steps. Recording the shot's shape alongside the outcome is what makes the next ten shots of the actual film into the benchmark — *"H3 is strong on single-character wides and weak on two-character interaction"* is what routes a shot, and it cannot be recovered later if nobody wrote down what the shot was.

### Nothing Has Ever Been Taken All the Way Through
Preflight reports **15 stages: 12 ready, 3 finished in the NLE, 0 blocked**. Nothing is in the way — and no project has ever been run through. Measured: *From the Mist* has 61 shots and **no assets at all**; *Wingfall* has 82 storyboard frames and 2 raw clips; *The Glass Harbour* has 20 frames. Total spend ever recorded is **$14.12**, every cent of it images, which is also how we know the two Wingfall clips were made on Runway directly rather than through the engine.

`docs/plans/e2e-first-film.md` is the plan for closing that, and its useful number is the cost: **≈ $2.04**. The breakdown is free because `anthropic:llm` is a subscription window reached over MCP rather than a bill — 458 calls and 11.3M tokens recorded at $0. The spend is five keyframes at the **measured** $0.15 (93 Meshy calls, 708 credits → 7.61 credits each), 25 seconds of video at $0.05/s, and a few cents of audio. The whole acceptance criterion can be proven for about the price of a coffee.

It runs on `tests/fixtures/thirty-second.fountain` rather than finishing Wingfall, because 13 shots through every stage costs several times more to prove the same sentence — on a board that already carries creative decisions worth protecting.

Two ceilings are stated up front rather than discovered: Meshy is **ratio-only** and returns 1376×768, and Runway's `image_to_video` documents 1280:720. **The first finished film is a 720p short**, and that proves the claim exactly as well as a 4K one would.

`tests/e2e-first-film-plan.test.js` derives its denominator from `lib/e2e-preflight` — the same registry preflight walks — so a plan naming 12 of 15 stages fails rather than reading as complete and leaving the film unfinished at the point nobody checked.

### A Path Out of the Database Is Not a Path You May Act On
A security pass over the previous change found that fixing one bug had created a worse one.

`addMedia` accepted `file_path` from the request body **verbatim**, and the `dropMediaFile()` added an hour earlier unlinked whatever the row held. So two unauthenticated calls — register the path, delete the visual — **removed any file the server process could write to**. Demonstrated end to end: a file outside the style book, gone, `200 OK`. The API binds every interface and answers `Access-Control-Allow-Origin: *`, so it was reachable from the network and cross-origin.

**The leak was the safer bug.** Before the delete was wired up the same two calls left the file alone; adding the unlink turned a resource leak into a **file-deletion primitive**. That is the general lesson: closing a "nothing happens" bug can promote an unvalidated input into an action, and the input needs re-examining at the moment the action is added, not before.

**`serveMedia` had the containment check and the delete did not.** One rule written twice with only one copy correct — the shape this codebase keeps paying for. `stylebookPath()` is the single rule now, used by the read, the write and the delete, and it **throws** rather than silently correcting, the contract `file-storage.getFilePath()` already states: a caller that handed us an outside path has a different idea of what it is doing than we do, and quietly rewriting it hides that. The boundary refuses an outside `file_path` at the write with a 400 that names the two legitimate ways in; the containment behind it is defence in depth for rows written before the check existed.

**The row still goes when the bytes do not.** A media row is ours to delete even when the file it names is not ours to unlink — refusing the whole delete would leave a row nobody can remove.

Two details are load-bearing and both were got wrong first:

**Real-path BOTH sides.** On macOS `/var` is a symlink to `/private/var`, so a file under a temp root resolves to `/private/var/…` while an unresolved root stays `/var/…`. Every legitimate upload was then refused as an escape — and a containment check that breaks the happy path is deleted within a day, taking the protection with it. Worse, it made the test pass for **entirely the wrong reason**: with the root unresolved, *everything* looks outside, so the check appeared to work while doing nothing. The sibling-prefix case is now built with both directories present on disk, which is what makes dropping the trailing separator fail.

**Real-path the nearest ancestor that exists.** A file being written does not exist yet, so resolving only what is there compares a resolved root against an unresolved target.

`tests/style-book-path-containment.test.js` is set-based over **every filesystem call in the module**, derived from the source — and the detector counts `require('fs').unlink(…)` as well as `fsx.unlink(…)`, because the first version missed exactly the call site that was vulnerable. A call site the detector cannot see is one it cannot police.

### A Declared Constant That Nothing Consults
Closing the style book's 21 unproven cases found **six real defects**, and eleven cases where the code was already right and only the test was missing. The split matters: writing the tests is what separated them, and reading the code would not have.

**`NEVER_WRITES` was declared and consumed by nothing.** `aspect_ratio`, `resolution`, `frame_rate` and `color_space` are the mood board's **delivery** decisions about a whole film, and a per-shot template writing one would be two systems fighting over the frame size. The constant naming them existed, was exported, and was referenced by no code at all. They were excluded only *because* `mergeableFacets()` is derived from the scene card's own camera facets and none of these is one — an accident that ends the day a delivery spec is added to the card, at which point the thing named to prevent this does nothing. `applyEntryToShot` now consults it explicitly and reports each as `skipped`, so the protection is stated rather than incidental.

**Both deletes removed the row and left the bytes.** `deleteEntry` relied on the media rows CASCADEing from the entry — which they do — and never touched the files, so an uploaded visual became bytes on disk nothing points at: unreachable and unfindable. `deleteMedia` had the same shape one visual at a time. `dropMediaFile()` is the one rule, and it deliberately leaves alone what it does not own: a link has no bytes, and a row carrying an `asset_id` belongs to the asset registry and is only *referenced* here. It never throws — a file already gone is the state we wanted, and failing the delete over it would leave a row nobody can remove.

**A style-book visual was capped at the 10MB JSON default.** `lib/body-limit.js` states the rule once: the ceiling is **derived from the URL shape**, and the shape that carries a file is a last segment of `import` **or `media`**. A visual is posted to `/film/style-book/:id/media`, which ends in `media`, so it missed a rule written when only `import` existed — and a 4K frame grab, which is the *normal* reference for a shot, base64-encodes well past 10MB. Refused, it reaches the page as a network error, which `api()` reports as **"Backend offline"**: indistinguishable from a dead server, on the one feature where large files are the point. It is a `lib/` module rather than a function in `server.js` because that file calls `start()` at import, so requiring it to read one rule would boot a listener on the live port.

**The modal hardcoded a second copy of `MEDIA_NOTE`.** The sentence explaining that a style still is the lowest-ranked reference — dropped before the request is built on any shot with a cast and a location — was served by the API *and* typed again into the page. Two literals is exactly how a page and its API come to disagree about what a feature does. One `styleBookNoteInto()` paints the served note, and it is painted **where visuals are added**, not only under the grid: a 260px card is not where that is read.

**And the QA specification was wrong twice, in the same direction — asserting a plausible behaviour against a deliberate one.** It expected over-long fields to be **truncated**; `validateEntry` refuses, and refusing is right, because trimming a name discards words the director typed and shows them something they did not write. It expected a project delete to **remove** that project's entries; the FK is `ON DELETE SET NULL` on purpose, so an entry is **promoted to the library** — an angle recorded while a film was open must outlive that film, which is the `film_refsheet_jobs` trap of migration 067 not being repeated. The code was right both times and the specification was corrected.

`tests/style-book-gaps.test.js` is set-based over the registries that fail **partially**: the four `NEVER_WRITES` fields (a rule catching three is indistinguishable from one that works), the three length-limited fields, and the seven row lookups in the router (a 404 on six teaches a caller to trust the seventh).

### A Plate Is the Shape of Its Subject

Reported three times as *"the location and prop plates are still not fixed"*,
and every previous pass checked that the regions RENDER — which they did. The
fault was one line: all three sheets reused `.cs-views`, the CHARACTER's grid of
two 3/4 portraits. That is right for a turnaround and wrong for both others, so
a **location plate was shown in a portrait crop** — the wrong picture of the
right place, which is exactly what a plate exists to prevent.

Each shape is now the one its own handoff declares: a location leads with a
**16:9 hero** (the establishing plate is not one of four, it is the one every
shot in the scene is re-photographed against) followed by three 4/3 tiles; a
prop is **five 1/1 tiles auto-fitting**, because a prop fills its own frame from
every side and there is no hero among them.

`tests/subject-sheet-design.test.js` reads the aspect ratios out of the DESIGN
FILES and requires the page to declare a matching rule per kind, so a design
that changes fails the test rather than the page quietly disagreeing with it.

### Choosing "Commercial" Sets the Format, Not Just the File List

Applying a package set the client, the campaign, the brand, the runtime and the
deliverables — and left `aspect_ratio`, `target_resolution` and `target_fps` at
whatever a FILM defaults to. Those three decide the shape and rate every frame
is generated at, and a spot generated at 24fps for a 29.97 buy cannot be
conformed afterwards.

`settingsForPackage` derives them from the package's own profiles: the MASTER is
the longest landscape profile, and where a **broadcast** profile is present its
rate wins, because an air rate is contractual while a social one is a
convention. Derived rather than written down twice, so a package that gains a UK
profile moves the project to 25fps with nothing to remember.

The rule is split into `settingsFromProfiles` for a reason worth recording:
every package that ships today has a master at the same rate as its air profile,
so replacing `air || master` with `master` was **invisible against all three** —
a rule nothing can distinguish is one nobody can trust, and this one decides
whether a spot can be aired.

### Draft While Working, Finish at the End

*"When we create video clips while we're working we'll always do 480P to save,
then add an upscale to 4K pass at the end."*

The intent is right — most generated clips are thrown away, so paying delivery
rates for them is the largest avoidable cost here — and **480p is a provider
choice, not a setting**, which took two corrections to get straight.

Runway's `image_to_video` takes a **ratio string**, so the size IS the ratio,
and the smallest gen4.5/gen4_turbo ratio is `1280:720`. There is no 480p. I then
wrote a floor table claiming `854:480` for Seedance, and the test caught it
against Runway's own documented ratio list. The second correction went the other
way: I had recorded that Seedance's 480p tier was "not wired here" — and
`lib/providers/seedance.js` **already existed**, reaching ByteDance through
MuAPI, documenting 480p at **$0.17/s against $0.85 at 1080p** and taking
`resolution` as an explicit keyword. A claim derived from one provider's model
list, about a different provider.

So the floor is per MODEL, from each adapter's own table. On Runway the floor is
720p and the saving is the model (`gen4_turbo`, 5 credits/second); on Seedance it
is 480p and the saving is fivefold — **$25.50 against $127.50** for thirty
five-second shots. `video_draft` defaults ON, which is safe rather than
presumptuous: Runway already returned 720p-class footage whatever the project
asked for, so draft mode there makes the REQUEST honest rather than changing the
result.

Three things the tests forced out, each a case that would have shipped:

**A draft is never larger than what it drafts for.** A 9:16 shot in a project
whose delivery raster is landscape fits to 608×1080, and a 720p floor applied to
that shape gives 720×1280 — bigger. Drafting would have cost more than
delivering, visible only on the bill.

**Two projects of one shape must draft identically.** A fitted raster is rounded
to even at its own scale, so a 4K and an HD project both set to 2.39:1 arrive as
3840×1606 and 1920×804 — ratios differing in the fourth decimal, and draft frames
2px apart. The draft follows the **stated aspect**, not the fitted raster.

**A 480p draft cannot reach 4K in one pass.** 480×4 is 1920 against 2160, and
Real-ESRGAN takes whole factors. Reporting that as finished would deliver 1920p
against a 4K spec and look successful. It is named instead, with both remedies —
a second pass, or drafting at 720p, which reaches 2160 in a single 3× pass.

And the finishing pass now derives its factor from the **delivery size**. It was
`scale_factor: 2` regardless of what it was scaling, so a 480p draft finished at
960×540 — not a deliverable, and indistinguishable from a successful post pass.

### A Modal Opened On Top of Another Must Paint On Top of It

Asked four times: *"I still don't get the modal with the prompt that will be
sent."* Then, mid-session: *"the prompt pops up BEHIND the character modal."*

**The confirmation was never missing.** It opened correctly every time, with the
prompt, the provider, the model, the quality and the size — underneath whatever
sheet it was launched from, where it could be neither read nor clicked.

Every `.modal-overlay` carried the same `z-index: 1000`, so paint order fell to
DOM order, and `confirmGenModal` is declared at DOM index 3 with **31 overlays
after it**, both subject sheets among them. Measured in the running page: with
the sheet and the confirmation open, `document.elementFromPoint()` at the
confirmation's own centre returned `characterSheetModal`.

**This is why five test files passed throughout.** `every-generate-button`,
`paid-preview`, `generation-controls`, `prompt-visibility` and
`loading-never-sticks` all check the confirmation is *invoked* and that its
markup is right. None could see it was invisible — and a gate nobody can read is
a gate that is not there, so the generation went ahead anyway, which is the
spend the whole mechanism exists to prevent.

`showModal` assigns a **depth**, not a running counter: a counter works on the
day it ships and climbs for the life of the session until it clears the top bar.
The stack holds what is actually open, `restackModals()` re-numbers all of it on
every change — assigning only the modal that moved leaves the one it was raised
above holding the same number, and equal z-index falls straight back to DOM
order — and closing gives the depth back. The base `z-index: 1000` stays in the
stylesheet: a modal opened by something this does not reach must still *appear*.

**Fifteen sites set the class directly** and would have escaped any rule the
helper applied, so they are routed through it — the same reasoning as *"a caller
that cannot choose the class cannot get that wrong."* The detector that finds
them resolves each receiver against the real modal id set: `exportDropdown` uses
`open` too, and a bare regex reported four working dropdown handlers as
escaping, which is four cries of wolf out of ten and how a check gets switched
off. It also falls through on an id absent from the markup rather than returning,
because `showCostInputModal` and `showModalHtml` **build** theirs at run time.

### While a Generation Runs, the Thing You Clicked Says So

*"As it generates I still don't see a spinner until we get the content back."*

`every-generate-button.test.js` already asks every generating function to show
that it is working — and its predicate accepts `setStatus(msg, true)`, the
**bottom status bar**. Measured across the 29 functions it discovers: **6** put
any state on the control that was clicked, **19** wrote to the status bar alone,
**4** said nothing at all. The test's standard was weaker than the codebase's
own, which had already recorded the lesson for storyboard frames — *"feedback
belongs on the thing you touched"* — and never generalised it.

**The mechanism lives in `api()`**, the single call all 29 reach, rather than in
23 function bodies: threading a flag through 23 call sites is how 21 of them end
up without it, and a function added next month is covered with nothing to
remember. The origin is the control that **opened** the confirmation, never the
dialog's own Generate button — `confirmGenResolve` closes the dialog before the
work starts, so marking that button decorates something already hidden.

Refcounted, because a batch fires several generations from one button and the
first to finish would otherwise clear the state while the rest still run.
Released in a `finally`, so a **failed** generation frees the control too — a
spinner that never resolves is worse than none. Only a POST to a generating
endpoint counts: a busy state on every read is noise, and noise is what makes a
real one unreadable.

Three of that test's assertions were too loose and each survived a mutation:
asserting after both requests resolved passed against no refcount at all (it is
checked **between** the two completions now); testing only a free GET left the
URL predicate carried by the method check alone (a non-generating **POST** is
tested too); and matching `readonly` anywhere in the page passed against a
`.cs-spec` rule that lives inside a `@media` block while the base rule said
something else.

### The Three Sheets, Laid Out as the Reference Images Draw Them

*"The biggest issues are at the bottom where the images are too big, sections
aren't organized properly on all three."*

The screenshots in the repo root are the spec, and where the HTML disagrees the
image wins — the checked-in `.dc.html` handoff is **not** the authority, since
70 tests already passed against it while the render was wrong. Those tests are
about PRESENCE (*every element the design labels is on the sheet*) and
declaration; the complaint is about ORDER, COLUMN and SIZE, which nothing
measured.

Measured in a real browser on THE MAN's own sheet before the fix: `PHYSICAL
SPEC` rendered in the **right** column as three equal columns where the design
puts it in the **left** as a 2×2; `PALETTE` sat bottom-right where the design
has it under the spec on the left; `DESCRIPTION` and `PERSONALITY` were stacked
full width where the design sets them side by side — which is what made the
right column run long and pushed the reference strip below the fold. The bottom
strip was a row of 239px cards where all three references show a compact strip
of small uniform thumbnails.

**View mode / edit mode is new behaviour, in neither the design nor the
handoff.** A sheet opens read-only, because a page of input boxes is a form and
not a sheet; an EDIT button sits with the other header actions. The same element
is used in both modes with only `readonly` and a border changing — swapping an
input for a paragraph would reflow the column on every toggle, and **no layout
shift** is the acceptance bar. **Pictures are not part of the mode**: uploading
and generating stay available in both, because looking at a sheet is exactly
when you notice a plate is wrong.

And `.cs-up` — the upload affordance on a pending plate — had **no CSS rule at
all**, so it rendered in normal flow at the tile's top-left and overprinted the
view label: "upload" and "RIGHT" on the same pixels, which reads as the tile
being broken.


### A 48px Avatar Should Not Cost 824 Kilobytes

*"Every once in a while when I load a project or an area the data takes time
loading. This has been a repeating issue."*

**It was never the API.** Every endpoint answers in 1–12ms, including on the
largest project, and the staleness report — once six seconds — is 2ms since its
cache. It is the PICTURES. Measured on the live install: reference plates total
**77MB**, single files run **668KB to 1.2MB**, and a character card paints one
at **48x48**. `loadCharacters` took **863ms cold and 4ms warm**, which is
exactly why the symptom was intermittent and never reproduced on demand — the
second look is the browser's cache, not the app.

`file-storage.js` has served a cached thumbnail for any `?w=` since it was
written, and falls through to the original on any failure so it can never take
down the picture it is optimising. **Nothing had ever asked**: four thumbnails
existed on the whole install, all under `storyboards/`.

`plateSrc` mirrors `frameSrc` rather than inventing a second idiom, because the
cache buster and the width share one query string and a plate URL already
carries `?v=`.

**Two things the scan got wrong first**, both corrected before anything was
built on them. It required a literal `API_BASE` or `/film/` in the src and found
**19** sites; there are **33** — the character sheet's tiles go through
`csImg()`, so the origin is already inside the variable and the scan could not
see the very files that prompted the complaint. And a general transform mangled
`${API_BASE}${esc(x)}`, which is TWO expressions, into invalid JS; it was
reverted and done per-pattern instead.

**The viewer is deliberately untouched, and now guarded.** A tile hands its own
`src` to `openPlateViewer`, so thumbnailing the tile would have thumbnailed the
full-size viewer — *"a plate you cannot see full size is one you cannot judge."*
A test asserts no handoff carries a width.

The remaining sites are exempt **by name with a reason**: `frameSrc` already
takes a width, `thumbnail_path` already points at one, marketing posters are
judged full size, and style-book media is author-supplied and served whole.

### A Scene Has Sounds, Not One Score and One Ambient

*"The music and sound area is horrible. I'd like to generate and/or add
manually several sounds and categorize them. Right now we can only have one
score and one ambient."*

**The data model was never the limit.** `film_music_cues` has declared **five**
cue types since migration 016 — `score`, `source`, `sfx`, `ambient`,
`transition` — and carries no UNIQUE constraint, so several sounds per scene
have always been storable. **Four separate sites selected one and threw the rest
away**, and a director who wrote three effects was told nothing.

`cueOfKind` took `LIMIT 1`. The page kept the first cue of each type per scene.
`sceneBeds` laid out ONE asset for each of TWO kinds — so `source`, `sfx` and
`transition` could never be heard however they were generated. And
`routes/timeline.js` mapped all five types down to two before the beds were
even built, with an asset query that excluded `audio_sfx`.

**I found the third and fourth only by reading `cueOfKind`'s callers.** My own
test had named two, and its comment warned that fixing one leaves the other.
Fixing the route and the page alone would have generated the right sounds,
displayed them, and played none of the three new types.

The link each cue already carries is what makes several of a kind possible:
`generated_asset_id` points at the audio THAT cue produced, so two scores in one
scene are two files rather than one row winning a tie-break. A cue with no link
falls back to the scene's newest asset of its type, so beds made before the link
existed still play rather than vanishing the day this shipped.

**SFX was refused outright**, with a hint to the shot route. The reasoning was
sound as far as it went — effects are normally read from a scene card, and no
builder took a cue — but a director who writes *"a screen door two streets
over"* on a cue wants THAT sound, and being sent elsewhere to describe it again
is the feature not existing. It reuses `buildSFXPrompts` by making the cue a
one-entry card, so a cue-written effect and a card-written one cannot describe
different sounds.

**An upload was an asset, never a cue.** `media_upload` landed audio correctly
and an asset carries no level, no fades, no offset and no place on the sheet —
so an uploaded bed never reached the mix, the playback or the export. *"Add
manually"* produced a file nobody heard. `POST /film/music-cues/:id/audio` goes
through the same import machinery and links the cue; the capability is derived
from `cue_type` rather than asked for, because a cue that says ambient and
stores music disagrees with itself. `server.js` dispatches it explicitly — the
music handler matches `music-cues` and would otherwise swallow it, the
`/film/locations/:id` trap that already cost once.

The surface is `renderSoundSheet`: one `ssSection` region per category, the same
furniture as the three subject sheets. The categories ARE the schema's
vocabulary, and the test reads the migration's own CHECK, so a sixth type cannot
be added without a home.

**Three of that test's assertions reported working code as broken** and had to
be rebound: one matched the deliberate back-compat path in `sceneBeds`, one
matched input validation rather than a refusal, and one read the wrong file. A
fourth was worse — it searched the whole page for `{ type: 'x', label: ... }`,
which is also the shape of the SCREENPLAY element list, where `transition`
appears again; deleting a sound category left the screenplay one and the check
passed. Only a mutation found it.

### A Column Is Not a Style, It Is Where the Words Go

The prop sheet rendered its two columns **inverted** against
`design-ref-prop.png`: the 1936-character object description — the text every
plate is generated FROM — sat in a scrolling **400px** rail, while a single
reference thumbnail owned the **1152px** column.

**The CSS was already right.** `.ps-grid` is `minmax(0, 1fr) 400px`, identical
to the value `Prop Card.dc.html` declares. Nothing needed re-tuning; five
`ssSection(...)` calls were in the wrong `.ss-col`. Touching the grid would have
broken a correct rule to compensate for a markup-order fault.

**Nothing had ever measured column membership**, which is why 70 passing tests
coexisted with a visibly wrong sheet. `subject-sheet-design` asserts every
element the design LABELS is present; `subject-sheet-fidelity` asserts each
layout declaration is declared and worn. Both are about PRESENCE — and every
section here was present, in the wrong half of the page.

The test is set-based over **all 9** `ps-*` regions, read out of
`renderPropSheet`'s own markup and placed by counting the `.ss-col` openings
before each. Section order is expressed **only** by markup order — there is no
registry, enum or ordering array anywhere to read — so it reads the rendered
structure rather than a list, and refuses to run if the scan sees fewer than
five regions: a renderer refactored to a loop would otherwise yield zero
literals and make every membership assertion pass over an empty set.

**The description is bound to the STYLESHEET's geometry, not to a column
index.** It asserts the description lands in whichever track `.ps-grid` makes
flexible, so it survives the grid being re-declared. Swapping the tracks to
`400px minmax(0, 1fr)` flips it from fail to pass — which is what proves it
reads geometry rather than always failing.

**A move script needs its own containment guard, and this one cost 10,850
lines.** Cutting each block by balanced braces is right — a retyped field is how
a dropped `esc()` on `description` or `materials` becomes stored XSS — but the
first version bounded only the START of the region and scanned for the closing
`</div>` to **end of file**. It swallowed everything to the last one in the
document, `renderCharacterSheet` included. The block-level check passed, because
all 8 blocks were still present exactly once; what was missing was everything
else. A move changes order, not content, so the script now asserts the line
count does not move and the region is under 200 lines. **The character tests
failing was the only signal** — the prop tests all went green over a gutted
file.

Measured in a real browser before and after: the description moved from the
400px rail to a 1090px box in the 1152px column, and stayed `readOnly` in view
mode. The **location** sheet is measured correct against its own reference —
560/992 columns, 1158+300 bottom rail, Lighting / Atmosphere / Sound sharing
`y=1192` — and is byte-identical afterwards, pinned so a prop change cannot leak
into it.

**And an assertion coupled to a call SHAPE failed the day the call improved.**
`shot-anchor` matched the literal `frameVersionsModal').classList.add('open')`,
so routing `openFrameVersions` through the shared `showModal()` helper — which
adds that same class *and* stacks the overlay above whatever opened it — read as
the modal never being shown. It now derives the display class from the
stylesheet and accepts either the inline call or the helper, **and checks the
helper really adds that class**, which the literal match never could. Strictly
stronger than what it replaced: it catches a modal nothing opens, and one the
helper shows with the wrong class.


**Three more gaps closed in review, and one of them was in this test itself.**

The **character sheet had no column protection at all** — `characterSheetHtml`
makes **zero** `ssSection` calls against location's 10 and prop's 9, so it
carries no `data-region` and moving a section between its columns failed
nothing, on the one sheet the original complaint named. It is keyed on the
section **label**, which `design-ref-character.png` and `subject-sheet-design`
already treat as the contract, rather than on a class, which is styling.
Converting the sheet to `ssSection` is tidier and was rejected: it wraps every
region in new `.ss-region` markup and changes the cascade on a layout measured
against its reference image days earlier. Closing a test gap is not worth
risking the design it exists to protect.

**A modal rule had silently stopped policing anything.**
`page-handlers.test.js`'s *"every modal is shown with the class its own CSS
displays"* scans for a modal opened at a CALL SITE, and once the stacking work
routed all **35** overlays through `showModal()` there were **zero** call sites
left to scan. It matched an empty set and passed, across 49 sites. It checks the
helper itself now, bounded by that function's own body rather than a character
window.

**A location field ignored view mode.** The set-description textarea was written
inline because it saves through `saveSheetSection`, so it stayed editable on a
sheet that opens read-only. Routing it through `ssField` was tried and is
**wrong**: `subject-sheets` requires every `ssField()` call to name a literal,
registry-declared field, and a section's name is built at run time — those
sections sit outside that registry on purpose. It carries the same mode lock
inline instead.

**And the column scan ignored where a column CLOSES.** It assigned each section
to the last column that *opened* before it and never read the closing tag. The
character sheet's concept band spans full width **below** both columns —
measured in a browser at **1496px** against columns of 467 and 978 — and the
test recorded it as column 1. Worse than a wrong label: the test claimed to
catch a section moving between columns and already held the wrong answer for
that one, so moving the band *into* a column would have passed silently. Found
only because the browser disagreed with two artefacts that agreed with each
other — **my test and my verification probe shared the same wrong model, so they
could not check each other.**

**Every column check rests on a precondition that is now enforced.** They read
the renderer's SOURCE and place a section by where its literal sits between the
column divs; that equals where it RENDERS only while every section is emitted
unconditionally. Short-circuiting one section so it rendered nothing left the
file passing **20/20** while the browser showed **8 regions instead of 9**. A
DOM assertion is the direct fix and is unavailable — [ADR-002](docs/adr/002-vanilla-http-no-framework.md)
means no bundler and no jsdom — so the precondition is asserted instead: a
section that becomes conditional fails with *"their position in the source no
longer proves where — or whether — they render"*.


**What this sprint is worth repeating for, and what it is worth avoiding.**

*A pattern to repeat:* **mutation-prove the pins, not only the failing tests.**
Three of the ten checks added here pass by design — they guard behaviour that is
already correct. A pin that cannot fail is worse than none, because it reads as
coverage. Each was made to fail on the defect it guards before being trusted,
and two were found too weak that way and rewritten. One accepted any mention of
`sheetEditable()` while the control it guarded had lost its `readonly`.

*An anti-pattern, and the fourth of its family:* **never bound a scan by a
character count.** The widened `shot-anchor` assertion used
`function showModal[\s\S]{0,600}?classList\.add(...)` against a function that
runs **469 characters** to that call — **131 characters of slack** before one
added guard would push it out of range. This file already records *"third time
this codebase has paid for a bounded character class"* (`[^)]`, `[^\]]`); a
bounded character *window* is the same mistake wearing a different hat. Bound by
brace or paren depth from the declaration instead.

**Its early-detection signal is specific and worth memorising: the test starts
reporting that the FEATURE is broken while the feature demonstrably works.** A
bounded scan does not fail loudly when it goes out of range — it silently stops
matching, and then blames the code it can no longer see.

*A second anti-pattern with a signal:* **a refactor that removes a pattern
disarms every audit that scans for it.** After routing 35 overlays onto one
helper, the rule policing how modals are shown matched **zero** call sites and
passed across 49 of them. The signal is a green test whose subject count has
quietly gone to zero — which is why the scans here now assert they found
something before asserting anything about it.

*A taste decision worth restating:* when a test gap and the design conflict,
**the design wins and the test takes the weaker identity.** Keying the character
sheet on its section labels is objectively weaker than `data-region`, and it was
chosen anyway, because the alternative restructures markup that had just been
measured against its reference image. Closing a test gap is not worth risking
what the test exists to protect.

*A caveat about this repo specifically:* there is **no jsdom and no bundler**
([ADR-002](docs/adr/002-vanilla-http-no-framework.md), zero devDependencies), so
a test cannot assert against a rendered DOM. Where a check needs runtime truth,
assert the **precondition** that makes source equivalent to runtime and say so
in the failure message — and take the real measurement in a browser once, by
hand, recording the number.

The full retrospective, written for retrieval by failure mode rather than by
feature, is [`docs/solutions/sheet-fidelity-and-generation-feedback.md`](docs/solutions/sheet-fidelity-and-generation-feedback.md)
— the first entry in that directory.

### A Capability Is Twelve Registries, Not a String in a List

Spatial reconstruction — a place a camera can stand in, built from a location's
own plates — needed a provider, and World Labs' Marble is it. The adapter was
the easy half. The instructive half is what happened when `world` was added to
`CAPABILITIES`: **the server stopped booting.**

`lib/flow-cost.js` asserts at module load that every capability has a projected
cost, and threw *"no cost estimate for capability 'world'"* — taking `run-plan`,
then `server.js`, then **71 integration tests** down with it. The suite went
from 17 failures to 88, and almost none of them named the cause: they said
*health check returns ok* and *creates a project*.

**That guard is the feature, not the obstacle.** A capability with no cost
estimate would be silently free, and the budget gate would wave through exactly
the fan-outs it exists to stop. Failing at load — loudly, on the first import —
is what turned a silent hole into a five-minute fix. `CAPABILITIES` is read by
**twelve** registries (the cost gate, the canvas node types, the taxonomy and
interfaces manifests, the rate book, the readiness brief, provider resolution,
the settings payload, dry-run, and four derived test denominators), and the ones
that fail at load are the ones that cannot be half-added.

**`world` is deliberately not `model3d`.** That capability turns one SUBJECT
into a mesh; this turns a PLACE into somewhere to shoot. Folding them would put
a dragon and a street behind one provider choice, and they are different
purchases from different vendors. It is also deliberately **not** an
orchestrated pipeline step: a world is built once per location, not once per
shot, which is why `phase0-payload-parity` — keyed on the steps rather than the
capabilities — correctly does not demand a payload builder for it.

**A hand-written list of `gen.*` ids was the real defect found on the way.**
`lib/node-handlers/generate.js` registered its ten generators by name, beside a
comment saying every `gen.*` node shares one implementation. A node type added
to `NODE_TYPES` and forgotten there is listed on the canvas, exposed as an MCP
tool, and dispatches to nothing — which reads as the node being broken rather
than unregistered. The set is derived from the registry now, so the eleventh
arrives wired with nothing to remember.

**And the pins were vacuous the moment the adapter was extracted.** The spike
script and the adapter each held their own compass→azimuth map and their own
four-image ceiling, and the tests read the *spike*. Mutating the **adapter's**
own map from 90 to 0 — which builds every world facing the wrong way, silently,
because every world still generates — left the whole file green. The adapter is
the single statement of both rules now, the spike reads them, and the test
asserts *neither file keeps a second copy*.

Its first version of that copy check matched `slice(0, 300)` and
`slice(0, 2000)` — the spike truncating an error body and a response dump — and
reported both as second copies of the image cap. **A check that cries wolf twice
is one nobody runs a third time**; it is bound to the ceiling's own value now.

`spike-world.js` answered the three unknowns for **$0.20 and 37 seconds** on a
real location: the collider mesh is **53,841 triangles**, parses with the
existing `glb-parser`, decimates to the stage's 20,000 budget, and its extent is
**39.6 × 9.0 × 47.9** — a street, not a bubble. The scale is reported as
uncalibrated rather than in metres, because Marble promises no unit and a size
stated confidently in the wrong unit is worse than one that says it does not
know.

### Each Seedance Workflow Names Its Pictures Differently

Found while verifying an unexplained uncommitted change to the adapter, and it
is a **live blocker on video**. Probed against MuAPI's own endpoints, which
report their required fields for free:

| workflow | field |
|---|---|
| image-to-video | `image_url` — one URL, not a list |
| first-last-frame | `images_list` |
| omni-reference | `images_list` |
| video-edit | `images_list` (+ `video_url`) |
| text-to-video | no image field at all |

The adapter sent **three** names and two of them exist nowhere in that table:
`first_frame_image` / `last_frame_image`, and `reference_images`. Both are
refused outright — `{"loc":["body","images_list"],"msg":"Field required"}` — so
the **two-keyframe path and the thirty-reference path could not generate at
all**. Omni-reference is the reason this adapter is here: Runway takes two
keyframes and Seedance takes thirty.

Only `image_url` on image-to-video was right, which is why single-frame
generation worked and made the other two look like a different problem.

**The tempting fix is also wrong**, and was the change sitting in the tree:
standardising every workflow on `images_list` repairs three and breaks the one
that worked, because image-to-video does not accept it. MuAPI is not uniform
here, and assuming it is fails whichever way you guess.

`images_list` is **ordered**, and on first-last-frame the order is the meaning:
[0] is the frame the clip starts on, [1] is the frame it ends on. Reversed, the
move runs backwards — and it would read as a generation problem rather than a
field-order one.

The map is the **only** statement of the field name. The first implementation
special-cased `image_url` and hardcoded `images_list` for everything else, which
made every other entry decorative: changing one to a name MuAPI refuses still
emitted `images_list`, so the table could be corrected while the request stayed
wrong. Two mutations survived on exactly that before it was written out.

Also confirmed: MuAPI accepts **no `resolution` field** on any Seedance
endpoint — the tier is in the path (`-480p`, `-1080p`, `-4k`), which the adapter
already does. Pinned, because sending one would be a setting that silently
reaches nothing.

### The Fields the Cue Contract Promises Must Reach the Generator

*"Look at the prompt it actually sent — description, genre, instruments, and the
project genre. That's it. No mood, no tempo_bpm, no key_signature, no
reference_track. So 'D major, 60bpm, horns rather than trumpets, delicate
becoming grand' was written, stored, and dropped."*

Measured on the real DRIVE-IN cue: **four of the seven** fields
`music_cue_create` names as reaching the generator reached nothing. Two separate
causes, which is why it was four rather than one.

**Three were payload FIELDS on an endpoint that reads a string.** `mood`,
`tempo_bpm` and `key_signature` came back as `payload.mood`,
`payload.tempo_bpm`, `payload.key` — and ElevenLabs' `/music` takes a prompt,
so anything not in that string is a knob the director watches reach nothing.
The mood was consulted only as an **index into a table** of default instruments
and a tempo range; it was never spoken.

**The fourth was a positional accident.** `reference_track` *was* in the prompt,
and `fitMusicPrompt` summarises `parts[0]` and keeps the tail whole. Its own
comment says why — *the description is the longest part and the least musical* —
which was true, and the description was not `parts[0]`: the reference was pushed
before it. So the trim ate the reference, and with the remaining tail already
over the ceiling it returned that tail whole: **1039 characters against a 600
limit**, missing the single clearest note a director gives.

**The parts are RANKED now**, the way `fitAdditions` ranks an image prompt and
for the same reason — with limited room, what to cut is a judgement and a
positional accident is not one. Description 0 (trimmable, with a floor), key and
tempo 1 (tiny, exact, unguessable from prose), genre 2, mood 3, instruments 4,
reference 5, the project's genre 6.

Two things the fit needed, and one it did not:

**The description keeps a floor.** Once the facts were spoken they came to more
than the ceiling on their own, and the old fallback returned them and dropped
the description — the field the contract calls the one that matters most. That
regression was introduced *while fixing this* and caught by measurement.

**The reference is capped to a phrase.** The real one runs to 232 characters —
longer than every other fact combined — and carrying it whole pushed the prompt
past its ceiling, so it was dropped entirely. Cut at a **clause** boundary, not
a word: a word cut left it ending *"…opens with one fragile instrument and"*,
and the last thing a model reads should be a complete thought.

**And a second pass was written and then deleted.** It existed to reclaim the
description's reserve, and once the reference was capped nothing was ever
skipped for size again — it never fired on any cue that could be constructed,
including a maximal one with fourteen instruments. Unexercised code that looks
like a safeguard is worse than none: it reads as covering a case nobody checked.

Result on the real cue: **1039 characters with four fields missing → 507 with
all seven present.**

**The sections 500 is NOT reproduced, and is not claimed fixed.** Reported as
two consecutive `elevenlabs 500: Internal Server error` on a four-section plan.
The exact body this adapter builds for that plan was sent to the live API while
investigating and **generated successfully**; probing the endpoint found no
length limit on styles, on chunk text, or on chunk count. Two things were done
anyway, both defensible on their own terms. A **style is a tag, not a
paragraph** — the cue's full description was travelling as one 785-character
style, copied onto every chunk, so a four-section plan sent it four times and
the body came to 7KB; it is capped at 200 characters, kept from the front. And
an upstream **5xx is retried once**, because a failed generation bills nothing
and the alternative is what happened: a transient error read as *"sections do
not work"* and the workaround was to stop using them. **5xx and 429 only** — a
4xx is our own request, and replaying it buys the same refusal twice.

The denominator is **the tool's own sentence**, parsed from the description
`music_cue_create` publishes. A hand-written list would be a third statement of
the same contract and the one that goes stale; this way, promising a field and
not sending it fails, and so does quietly dropping a promise.

### The Cue You Wrote Is the Cue That Gets Generated

Reported with the line number: `routes/music-gen.js:222` selected the scene's
score with `ORDER BY start_ms LIMIT 1` and **no `cue_type` filter**.

Every cue on a scene legitimately starts at 0 — a score, a room tone and a
stinger all begin when the scene does — so that is not a tie-break, it is a coin
toss: SQLite may return any row when the sort key is equal. On the real DRIVE-IN
scene, which carries three cues all at `start_ms 0`, an ambient bed called
**"Lot Air" (crickets and highway) was used as the orchestral score**. Nothing
errored, the file played, and the only signal was a director listening to it.

**The bug is independent of which tool was reached for**, which is the important
half: the correct route selected its cue the same way, so the same forest
recording would have come back either way.

`CUE_KIND_FOR` states the mapping once and `cueOfKind()` is the only selector.
The ambient lookups already filtered correctly — in **two separate literals**,
which is exactly how the third came to have no filter and how a fourth would
drift again. The tie-break is now deterministic (`start_ms, created_at, id`)
rather than left to the engine.

**`source` and `transition` are deliberately not the score.** Diegetic music
from a radio in shot, and a stinger across a cut, are different pieces of music
with different lengths and different jobs; folding them in is the same
conflation being fixed, one step milder. And a cue that is **declined is
named** — `other_cues` on both branches — because deriving a score while an
ambient cue sits unused is *correct*, and doing it silently is precisely what
made the original defect invisible.

**Nothing could generate a written cue.** `music_cue_create`, `_update`,
`_list` and `music_brief` all existed, and then there was nothing to generate
with — so the only generation surface an agent could see was `node_gen_music`,
which derives its own prompt from the scene and never reads the cue. Reaching
for it produced a scene-derived bed instead of the score that had been written
out in full. Cue-authoring no tool can act on is the *capability with no
control* case that `tests/manual-edit.test.js` exists to catch, pointed the
other way.

`music_cue_generate` is **addressed by CUE, not by scene**, and that is the
point: a scene holds several cues at once, so a scene-addressed call has to
guess which one was meant — the defect above, one level up. It routes on the
cue's own kind through the same builders the briefs use, so a cue previewed for
free and a cue generated cannot describe different music. An **SFX cue is
refused and told where to go**: effects are built from a shot's scene card by
`buildSFXPrompts`, which takes a card and not a cue, so there is no builder that
could honour that row.

**`generated_asset_id` had existed since migration 016 and was written by
nothing.** A scene could hold a cue and an audio file with no link between them,
and *"has this cue been generated"* had no answer at all. All five generating
paths link it now, and the check is **per site** rather than a total — counting
calls passes while one path has stopped linking, which a mutation proved.

**And a `gen.*` node run alone stores nothing.** In a graph that is `out.asset`'s
job, deliberately; executed on its own through MCP there is no `out.asset`
downstream, so the bytes come back in the tool result and reach `film_assets`
never — a paid generation that exists only in a transcript, which is how an MP3
ended up being pulled out of raw tool output by hand. Every capability node now
says so in its own description, derived rather than written per node, and
`gen.music` names `music_cue_generate` as the thing to use instead.

### A Generation the Host Abandons Is Not Lost

*"A tool call through the MCP host is abandoned at sixty seconds. Any generation
still polling at that moment is not slow — it is LOST. The handler is torn down
mid-await, nothing is written to `film_assets`, and the caller is told:*
`Device 'mannys-mac-pro-local' did not respond within 60s.` *Which reads like a
connection fault. It is not. The provider very likely finished the job and
billed for it; the result had nowhere to be delivered."*

Measured across every adapter that polls:

| | | |
|---|---|---|
| meshy | 900s | **15× over the window** |
| seedance | 900s | **15× over** |
| bfl | 300s | 5× over |
| runway | 300s | 5× over |
| muapi | 48s | under |

**No timeout value fixes this**, which is the whole point: no budget is both
longer than a 4K render and shorter than the abort. Shortening them alone trades
a lost result for a failed one and still burns the money.

**The fix is a handle.** Every one of these providers returns an id the moment
it accepts the job, and that id lived only in a local variable inside the poll
loop — so the abort took the only reference to work already being billed for.
Writing it down **before** polling means the process can die, the host can
abort, and the job is still collectable. The happy path is deliberately
unchanged: the adapter still polls and still returns bytes.

**The budget belongs to the caller, not the adapter.** An HTTP request can wait
fifteen minutes for a mesh and nothing abandons it; a tool call has sixty
seconds whatever the adapter would prefer. So every async adapter now takes
`opts.timeout` and passes it through `budgetFor()`, and the window is declared
by **`backend/mcp-server.js`** — that process is the one with the constraint,
and it is a different program from `backend/server.js`, so an env var set at its
own startup cannot leak into the browser path. The margin is not politeness: the
adapter has to notice the deadline, stop, write the handle and return a sentence
the model can act on, all before the host stops listening.

**`onHandle` is injected at `resolve()`**, the one funnel every generation goes
through, for the same reason the provenance stamp is — threading a callback
through the per-domain routes, the orchestrator and the flow canvas is how two
of the three end up recording nothing. The project, shot and scene come from the
config the caller already tagged, so a handle is attributed exactly as its cost
is, from one source.

**A timeout is reported as `pending`, not as a failure.** The symptom was *"the
device did not respond"*, which sends the reader to the network. Naming the
handle and the way to collect it is the difference between a lost render and one
that is simply not finished yet. Collecting is **free and idempotent** — it
polls a job already paid for, and a job still running answers *"not finished
yet"* and stays collectable.

Served at `GET /film/projects/:id/generation-jobs`, `POST
/film/generation-jobs/:id/collect`, and as `generation_pending` /
`generation_collect` (**235 tools**). The route is registered **before** the
project catch-alls, on the trap `/film/locations/:id` already cost once: a
handler that exists and is never reached looks exactly like a missing feature.

`tests/generation-handles.test.js` derives the async adapters **from the
source** — a sleep inside a bounded loop against a poll URL — and holds the
declaration two ways, so an adapter that starts polling later is caught and one
that declares it without polling is caught too. Three of its checks had to be
scoped to the **generate path, following one call level**: `collect()` polls and
computes a budget by design, so a file-wide search was satisfied by the recovery
path while the path that actually spends ignored the window, and meshy delegates
its whole submit-and-poll to `run(...)` so its own body mentions neither. Both
were proven by mutation rather than by reading. The handle check requires a
**call** rather than the `typeof` guard beside it, for the same reason.

### Creating a Subject and Updating One Must Accept the Same Fields

Reported as *"`prop_create` accepted `height_m`, `width_m`, `length_m` and
stored all three as `null`, while `prop_update` with the identical values
persisted them"* — correct, and those two names are a **symptom**.

Each create handler carried **its own INSERT column list**, written when the
table was smaller and never grown, so every column added since reached the
update path and nothing else. Measured against the schema before the fix:
**character dropped 3, location 5, prop 12 — twenty fields**. The dimensions
were simply the ones somebody noticed, because they are the ones that produce
the scale clause in an image prompt:

```
Scale: DRIVE-IN SPEAKER POST is roughly 1.7 times the size of a car tyre,
1.1m tall, 0.12m long, 0.55m wide
```

A subject created and never updated generates at whatever size the model
imagines, and nothing reports it. The location gap is the same shape and worse
to discover: `orientation_plan` never survived a create, and a plate carries no
information about what is behind its own camera, so each side of a room was
generated from prose that could not say.

**One builder per entity, used by both paths.** `characterFields` /
`locationFields` / `propFields` return a SET clause rather than performing the
write, so create INSERTs its identity and then applies exactly what update
would. Every non-identity column already carries a schema default — including
`lighting_default`, whose `'natural'` fallback was typed into the handler *and*
is the column default — so the identity-only INSERT is byte-equivalent. A second
list is how the first one went stale.

**The test is a property, not a field list:**

```
create(body)  ==  create({name}) then update(body)
```

A test enumerating the fields it knows about is only as complete as the
afternoon it was written, and the column added next is exactly the one that
would be dropped again. This compares the two code paths against each other over
every column the table actually has, read from the schema at run time. A column
the update path does not accept either is not a failure — both store the default
and agree; the test asks only that the two paths cannot **disagree**.

Three probe values had to be shaped from the routes' own validators rather than
typed — `continuity_states` wants `{name, what, scene}`, `description_sections`
an object, `category` a value from `PROP_CATEGORIES` — because a probe the route
**refuses** proves nothing about the two paths agreeing and reads as a defect
that is not there.

`tests/manual-edit.test.js` derives its denominator by parsing `body.x` out of
each `update*` handler, and the delegation made those handlers look like they
accepted nothing — reported as *"updateCharacter is gone"*, which would have
taken the whole denominator with it. It **follows one call level** now, to a
`*Fields(body)` builder, which is the rule `screenplay-mutators` already
follows; one level rather than an unbounded walk, because an unbounded walk
eventually finds a `body.x` in something unrelated.

### Spend That Goes Somewhere Nobody Chose Says So

*"`film_projects.provider_config` lost its `image` key mid-session. Nothing
failed and nothing was reported. Image generation fell through the resolution
order onto Google, billed against a personal Gemini key rather than the Meshy
account the project was configured for — discovered only when Google's billing
rejected it."*

**The reason was already computed.** `resolveIdWithReason` returns a `source`
(`project` / `env` / `quality_tier` / `account_default` / the preference walk)
and an `explicit` flag, and `describeResolution` turns them into exactly the
right sentence. `describeResolution` had **zero consumers** — declared,
exported, wired to nothing, the same shape as `NEVER_WRITES` and `scope` on
`PIPELINE_STEPS`. Every generation went through `resolveId`, which throws the
reason away on its only line. The engine's own comment predicted this:

> the picker said every tier used Meshy while the project resolved to OpenAI,
> and both were telling the truth about different code.

**`explicit` is the load-bearing field, not the provider name.** A project
pinned to Google is fine; a project that pins nothing and silently lands on
Google is the failure — and both resolve to the string `google`. That is why
this was invisible on every surface that printed the name.

Stamped in **`resolve()`**, the one funnel every generation goes through, so the
per-domain routes, the orchestrator and the flow canvas cannot disagree about
it; **non-enumerable**, exactly as `__project_id` is, because a `provider_config`
is round-tripped through the settings panel and a diagnostic that rode along
would be written back into the column on the next save. Surfaced on the settings
payload (`resolution`, `unpinned`), on the free `dry_run`, on the **run plan**
beside the projected cost — a plan that projects a total and does not name the
account it will be billed to is half a plan — and beside the picker on the page.

Warnings are named **per capability**: on the real Wingfall project `video` and
`post` both fall through to Seedance, which produced two identical sentences
until each carried its own capability — the rule `SHOTS_DROPPED` already
follows.

Three things the mutation pass forced out, each of which had the test passing
while the feature was broken. The dry-run check asserted *"if it says fallback,
it warns"* and therefore passed against a report claiming every provider was
explicitly chosen — the comfortable lie, and the one this exists to catch; it
asserts **positively** now. The run-plan probe pinned `image` and, in an
isolated database where nothing else holds a credential, produced **no fallback
row at all**, so every assertion about the warning passed vacuously — there is a
second project that pins nothing, and **a credential has to exist for anything
to fall through to**. And the settings check called `resolutionReport` directly,
which proves the helper works and says nothing about the payload a page
receives; it drives `handleProviders` now.

A provider string that names no registered adapter is **not a vendor**: with no
credentials `llm` reports *"the MCP host"*, which spends nothing and is the
architecture rather than a silent reroute. Derived from the registry rather than
exempting `llm` by name.

### A Model List Means Nothing Except Relative to a Capability

*"Relabel the Seedance 2.5 key in setup muapi (that's actually the key from
muapi) and add muapi's video and image models in the appropriate prompt
selections. I will use muapi from now on for almost everything (especially
images)."*

The relabel was the ask. Deriving the set found two things behind it, and the
second is the one that was costing money.

**`modelList()` read ONE flat `adapter.models`, and four adapters here serve
more than one capability.** So the VIDEO dialog was offered Runway's IMAGE
models — `gen4_image`, which Runway refuses for a clip — while the eleven video
models the adapter already validates against were on no menu at all; the 3D
dialog answered *"which model should this mesh use"* with `nano-banana-pro`; and
Seedance, declaring no models, offered an **empty menu**, which is
indistinguishable from MuAPI being unavailable for footage. That empty menu is
what was reported. `modelsFor(adapter, capability)` is the one rule, because
**five call sites were each doing `Object.keys(adapter.models)`** to answer the
same question — which is how two of them come to disagree about whether a pinned
model is legal.

**And every reference image sent to MuAPI was silently dropped.** MuAPI serves
text-to-image and editing on SEPARATE endpoints — `nano-banana-2` and
`nano-banana-2-edit` — and only the second takes pictures, under the name
`images_list`. The adapter posted everything to the first and attached
references as `image_urls`, a field neither endpoint has. FastAPI **ignores** an
unknown field rather than refusing it, so every character plate, location plate
and shot anchor was serialised, sent, billed for, and thrown away. The frame came
back plausible and conditioned on nothing — indistinguishable from conditioning
being weak, on the provider the whole production is moving to.

**The provider was asked rather than read about.** MuAPI publishes a live
`/models` catalogue, and the accepted-field set for an endpoint can be read from
a **422 on an all-wrong-types body** — free, because validation refuses before it
bills. That is how `images_list`, the lowercase `1k/2k/4k` tier, and the absence
of any `seed` field were established. `supportsSeed` was declared **true** and
MuAPI accepts no seed on any nano endpoint, so *"same seed, same frame"* was
never true here: a claimed control that reaches nothing is worse than an absent
one, because it gets relied on.

**Three rate-book rows were fiction and one was over-reported.** Nano Banana Pro
was held at Google's $0.134 and flagged `inferred` on the belief MuAPI quotes
rather than lists it — MuAPI lists it at **$0.12**, so the flag made
over-reporting look like diligence. The `-2k` and `-4k` rows described products
that do not exist: resolution is a FIELD on one endpoint, not a separate model,
and the code that would have produced those names compared a lowercase tier
against uppercase literals so it never fired. Two mistakes cancelling is not a
working price list.

**On Seedance the model IS the price tier**, which is why the video menu is the
four resolutions rather than the six workflows. The workflow is *derived* from
what is attached — a payload with four pictures IS an omni-reference request,
and letting a caller declare otherwise sends four images to an endpoint that
reads one — so it is not a choice and must not be offered as one. The resolution
is, and it ranges from **$0.17 to $1.70 a second**. The ids match the rate book's
own keys exactly, so the dialog's estimate is the number that will be charged,
and they are derived from `RESOLUTIONS` rather than typed twice. `resolutionFor`
now reads the chosen model: the dialog has always been able to send `model` and
this adapter read only `resolution`, so picking *"Seedance 2.5 — 1080p"* changed
the confirmation's label and nothing about the request.

`tests/muapi-models.test.js` derives its denominator from `providers.list()`
crossed with declared capabilities, and from MuAPI's catalogue snapshotted with
its date by `tests/refresh-muapi-contract.js`. The reference field is derived as
**the one the editing endpoint accepts and its text-to-image twin does not** —
that difference IS what makes an edit an edit. Reading the probe's `required`
flag instead is wrong, and was wrong on the first attempt: the probe supplies
every field, so a supplied one returns a type error rather than a missing one,
and all four models reported as having no reference field while the routing was
already correct.

### A Report Nobody Waits Six Seconds For

Reported as *"why does the server sometimes take a while showing items?"* — and
the first half of the answer was not the server at all: it was not running. That
is worth recording because the symptom was an **empty project list**, which is
indistinguishable from lost data and was reasonably alarming. All four projects
were in the database the whole time.

The second half was real and measurable. Every call on the board takes 2–10ms
**except the staleness report, which takes six seconds**. The cause is a
consequence of a decision that is otherwise right — *the payload IS the
fingerprint* — because building an image payload **inlines every reference plate
as a base64 data URI**. Fingerprinting 76 keyframes read 19 distinct files
**314 times** and moved **487MB** off disk to produce one JSON report;
`MAYA_front.png` alone was read 61 times.

**A cache, not a cheaper formula.** Weakening the fingerprint to make it fast
would mark every existing artefact stale — the *"warning you cannot act on"*
this codebase has already paid for once — so the same bytes still produce the
same hash and only the reading is avoided. Keyed on **size and mtime, never the
path alone**: a plate is written to the same per-view filename and overwrites,
so a path is not an identity, and a regenerated plate served from cache would
fingerprint as its old self and make the staleness report quietly wrong. Bounded,
because a server runs for days and an unbounded cache of megabyte strings is a
memory leak that looks like a performance fix. That took the report from 488MB
to 124MB of disk.

**But the fix that mattered was in the page.** `loadStoryboard` **awaited** the
drift report and the impact report before writing a single frame into the grid.
The comment sitting there already said the right thing — *"the board still
renders; the warning is additive"* — and the awaits made it untrue. Additive
means it arrives **later** and changes nothing about whether the pictures appear.

Measured on the real board: **frames ready in 51ms**, banners a second later,
over an empty grid that used to sit there for the whole wait. The per-frame
drift and impact marks are repainted when the reports land, because a banner
saying six shots are behind while no frame carries a mark is a warning with
nothing to point at.

The remaining six seconds is the honest cost of the formula on 76 shots — each
shot's own frame is a distinct file that no cache can share — and it now happens
where nobody is waiting on it.

### Commercial Mode — a Spot Is a Fan-Out, Not a Short Film

`docs/plans/commercial-mode-implementation.md`, built in its five milestones. A
film has ONE shape and this engine was built around that: one aspect ratio, one
resolution, one delivery preset. A commercial resolves to **fourteen to
twenty-two files**.

**M1 found a live defect where a tidy-up was expected.** `const FPS = 24` was
the default of every conversion helper — but the real fault is a level down:
**NTSC rates are nominal** everywhere timecode exists. 29.97 is a timebase of 30
with an ntsc flag, and drop-frame drops *numbers*, not frames, so a :30 spot is
**900 frames**. Multiplying 30.000s by 29.97 gives 899.1 → 899. Both generators
already wrote `timebase = Math.round(fps)` with `ntsc TRUE` and then computed
durations against 29.97, so a :30 exported one frame short. It shows at
**exactly** thirty seconds — :15 and :06 round back — which is the commonest
spot length there is, and a station rejects a short :30. A rate is now
**required**: there is no rate that is right for an unstated one, and 24 is right
for precisely the medium a commercial is not.

**The deliverable set is decided before anything is boarded**, and that ordering
is the point: it is what says which shots must be SHOT vertical rather than
cropped later. A 9:16 centre crop of a 16:9 frame keeps **32%** of its width;
4:5 keeps 45%; 1:1 keeps 56%. Auto Reframe follows a subject inside the pixels it
has — it cannot invent the two-thirds that were never generated. `native` is the
load-bearing field, and **1:1 is the deliberate exception** because 56% is a
usable crop of a centred composition.

**A shot's own ratio is a COLUMN**, because it is a decision about how the shot
is *shot* rather than something the writing says. `buildVideoFrame(project,
override)` is the one place the shape is decided, exported so the image payload
and the video payload cannot compute it differently — the board/footage
mismatch this engine already fixed once at project level and would otherwise
have reintroduced per shot. A shot override is not a crop of the delivery frame,
it is a **separate deliverable**, so it keeps the raster's SHORT edge and lands
exactly on what the profiles ask for: 1080×1920, 1080×1350, 1080×1080. Fitting
it inside the landscape frame would generate 608×1080 — a vertical picture at a
third of the resolution it is delivered at.

**The runtime is a target, not an outcome.** A film runs as long as it runs; a
commercial is BOUGHT by the second. `planConform` **refuses** rather than
trimming — the doctrine it already follows for a missing shot — and names the
overage. A target of 0 is "no target", which is every film ever made here, and
the QA check is not merely passed for one, it is **not run**: a green tick
against a rule that was never applied is worse than silence.

**Compliance refuses before spend, never after.** An automated pipeline can put
"clinically proven" into a paid advertisement in seconds, and afterwards the
money is gone and the frames exist — so the gate lives in the FREE run plan
beside the budget refusal, for the same reason. **Errors block; warnings do
not**: a warning that stops a run makes the check something people switch off,
and the real one goes with it. Only a **substantiated** claim row clears a
claim; a row that merely exists is a record, not evidence. Claim patterns are
whole phrases with a named prose-noun exception list, because `the best` fires
on *"she is the best friend he has"* — and a detector that flags a screenplay
line gets switched off within a day.

**A brand outlives a project**, like the style book: one client buys many spots.
No `project_id`, and it survives a project delete — the `film_refsheet_jobs`
trap of migration 067 not being repeated, now held by its own test. Every field
declares what it **reaches** — prompt, compliance, handoff, or person — and the
test holds each declaration to being true, because a brand kit is exactly the
shape of thing that becomes a form nobody consults. Only **tone and palette**
reach a generation: a CTA, a legal line and a font are words and type placed in
Premiere, and asking a diffusion model for legible text bakes a smudge into a
frame that cost money.

Two fixed-window test slices broke on contact with this work and were bounded by
their own structure instead — a 4000-character window over the storyboard tile
that stopped containing `description`, and a 1400-character window over the rail
that stopped containing the glossary. Both read as the feature having lost
something, which is the opposite of what happened. And the decision-parity
detector matched `film_projects:client` because a bare `\bclient\b` finds
`gridlight-client` in an import: a column is read as a property or in SQL, and
everything else is prose.

### An Export You Can Hand to Somebody Else

An NLE export references its media by **absolute path**. On the machine that
made it that works and looks finished; hand it to an editor — a different Mac, a
shared drive, a zip — and every clip is offline: the timeline opens, the cuts are
right, and there is no picture. Nothing errors, which is why it survived.

**The preflight matters more than the package**, and it exists because of what
happened when the packaging was first run against a real project. *The Glass
Harbour* exported **zero clips**: every shot on it has `duration_ms = 0`, so
`shootableShots` disqualified all thirteen and the export was a perfectly
well-formed file describing **nothing**. A blank timeline is not something an
editor can report back usefully — it just looks like the tool does not work.

Blocking is what makes the handover pointless; warnings are what an editor
should be told and can work around. Blocking on an **empty audio lane** would
make the export unusable for exactly the workflow it exists to serve, since a
lane that is empty today is where the sound pass lands tomorrow.

The warning worth having is the one measured second: *Wingfall* reports
**ready** with 13 shots and **two** of them shootable — a two-clip film with the
other eleven silently absent, which is worse than the blocked case because it
looks like it worked. `SHOTS_DROPPED` names them (`2AA, 2B, 2C, 3A…`), because a
count sends you to the database.

**Packaging refuses exactly what the preflight blocks.** One rule, not two: a
package that builds happily from an export the preflight would refuse makes the
preflight advisory, and an advisory check is one people skip. Media is **copied,
never moved** — the project's own files have to survive being handed over — and
the paths are rewritten on the **asset list** before generation rather than by
editing the XML afterwards, because a find-and-replace over generated XML is how
one of the three formats ends up missed. An **EDL carries no media** and says
why: it names reels rather than files, so it is a conform list for an assistant
who has the footage elsewhere.

Served at `GET /film/projects/:id/export/{preflight,package}`, listed among the
export formats so they are discoverable, and as `export_preflight` /
`export_package` (**214 tools**).

### The Register That Was Removed, and the Station Nobody Could Correct

Two of the remaining gaps closed, and one of them is a reversal worth stating.

**`rights` was removed as "delivery paperwork" and is rebuilt.** The rule for
all nine removed pages is *what was removed is the screen, not the data* — the
route, `film_rights` and the MCP tools stayed. For eight of them that is fine.
For this one it left **thirteen fields reachable by curl and by nothing else**,
and left an orphaned handler calling a `loadRightsPage()` that no longer
existed. A register nobody can write to is not paperwork you decided to skip; it
is paperwork you discover missing at delivery. It is **recorded, never
enforced**: nothing on it blocks a generation or an export, because a gate on
rights is switched off the first time it stops a director mid-shot, and the
record goes with it. `nav-reorg`'s REMOVED list carries the reversal and its
reason rather than quietly losing the entry.

**Correcting one station of a strip had no control.** `PUT
/sequences/:id/stations/:shot/:index` shipped with the in-between work and was
agent-only, so a wrong in-between could only be fixed from a conversation. The
consequence is stated **where the choice is made**: correcting station 2 of 5
re-runs 2, 3 and 4, because a chain re-inherits from the frame that changed —
discovering that on the bill is the failure the surface exists to prevent.

`NOT_BUILT` is now **empty and kept**, which is a stronger claim than deleting
it: the audit fails an entry that no longer describes reality, so an empty
object asserts on every run that every field a route accepts can be typed by a
person.

**And the dangling-onclick check reported its own stripper as the bug.**
Explaining in a comment that `loadRightsPage()` no longer exists made the loader
check report the comment; stripping comments with the obvious block-comment
regex then ate the declaration of `importStoryboardImage`, because a `/*` inside
a string opens a comment that runs to the next `*/`. The stripper is line-based
now — every comment in this page is a whole-line one, so no line carrying code
is ever touched.

### If the App Stores It, a Person Can Type It — the Rest of the List

The standing `NOT_BUILT` list in `tests/manual-edit.test.js` named eight route
handlers whose fields had no control. Working it found that four of them were
not missing controls at all — the screens they belong to never opened.

**Three modals were shown with a class the stylesheet ignores.**
`.modal-overlay` is `display:none` and exactly one class turns it back on:
`open`. The screenplay's **Title Page** dialog, the screenplay importer and the
live-action cost editor all added `active`, so none of them ever appeared.
Nothing threw and nothing was logged; the button did nothing, which reads as a
dead feature. This file has claimed for months that *"the toolbar's Title Page
button was always the real way to edit it"* — it did not open. It is also why
nobody noticed the cost form was missing its travel allowance and prep days:
**the form they belong to never opened.** `showModalHtml()` is one helper, so a
caller that cannot choose the class cannot get it wrong.

**Nine page loaders were called and never defined**, left by the nine-page
removal. Eight were unreachable and merely dead — three of those still had a
Save button in an orphaned modal, which is the same bug pointed the other way.
**The ninth was live**: `saveLocation` calls it on the SUCCESS path, so renaming
a location that appears in the screenplay saved correctly, updated the
screenplay correctly, and then threw `loadScreenplay is not defined` into the
surrounding catch — reporting a successful write as `Error: …`.

**Seven of the eight gaps are now built.** Music-cue rights was the one that
mattered: `PUT /music-cues/:id/rights` had existed since the rights work with no
control for **any** of its six fields, so who owns a piece of music and until
when could only be recorded by curl — and delivery is the wrong moment to find
that out. `titles` (credits and title cards) and `subtitles` are two new pages
in **Post**; both routes shipped with the delivery work and neither had a page.
Vocabularies are **served** — `sections`, `card_types`, the licence statuses —
on the `card-vocabulary` rule: the route refuses a value it does not know, so a
page holding its own copy offers options that are rejected on save, and the
refusal reads as saving being broken.

**Three entries were CORRECTED rather than removed**, and all three were wrong
in the direction that made the app look more finished than it is: credits and
subtitles claimed a list *"renders"* when no such page existed, and the Rights
register claimed to offer four fields when its page was among the nine deleted.
The rights entry stays as the one open gap: rebuilding that page would undo a
removal that was asked for.

`tests/page-handlers.test.js` is the standing check, derived from the page
rather than from a list — the list is exactly what nobody updates. It holds four
rules: no handler calls a loader nothing defines, no `onclick` names a function
nothing defines, every modal is shown with the class its own CSS displays, and
every page in the menu has a loader. **The third of those later stopped
policing anything** — it scanned for a modal opened at a call site, and the
stacking work left zero call sites to scan; it checks the shared helper now.
See *A Column Is Not a Style, It Is Where the Words Go*. That last one immediately caught
`jobsqueue`, which was filled by its own nav button and by nothing else — so
arriving from the home page's run report landed on a panel nobody filled. The
vendored 3D library is excluded **by region**, not by name: including it produced
233 false positives, and a check that cries wolf 233 times is one nobody runs
twice.

### The App Shell on a Phone
*"like neoncore (codebase) would it be possible to create a mobile version that allows us to work on a film engine project"*

The assessment (`docs/plans/mobile-feasibility.md`) measured six media queries, **none of which touched the app shell**: `.fe-panel` is a fixed 232px, `.main` and `.status-bar` are offset past it, and `body.fe` is `overflow:hidden`. At 390px that left **232px of menu and 128px of page**. Measured in a real browser at 386px, `.main` is now **362px** wide.

**The offsets are not overridden one by one — `--fe-panel` goes to zero and all three collapse arithmetically.** That is exactly what the variable was kept for when the rail was removed: *one arithmetic expression beats five hand-edited numbers that can disagree*. So the phone rule sets a variable and the shell follows, rather than restating three `left:` values that would then need re-editing together.

**The panel becomes a drawer, and the phase track MOVES into it.** Hiding the track was the obvious first move and is wrong: the panel lists the **current phase's** pages and the track is what changes the phase, so hiding it strands you in whichever phase you loaded on. Rendering a second track in the drawer is the other obvious move, and it is how two navigations come to disagree about which phase you are in — so `applyShellMode()` **relocates the one node** (`appendChild` moves rather than copies, so handlers and state survive) and puts it back on resize. `navigateTo` closes the drawer, because otherwise you tap a page and keep staring at the menu.

**The blocker that would have made every other fix invisible was the API base.** `DEFAULT_API_BASE` was the literal `http://localhost:3100`, so a page opened on a phone called the **phone's** own localhost, failed every request, and surfaced as *"Backend offline"* — indistinguishable from a dead server, which is the same misdiagnosis the oversize-upload 413 produced. It follows `location.hostname` now: correct on the laptop, correct on a phone, nothing to configure, and the explicit `film_api_url` override still wins.

**The page server binds loopback and stays that way unless told.** `FILM_ENGINE_HOST=0.0.0.0` opts in, prints the LAN addresses, and warns that the server is **unauthenticated** — anyone who can reach the machine can read and change the project. An env var rather than a stored setting because `dev-server.js` deliberately has no database import and no dependency ([ADR-002](docs/adr/002-vanilla-http-no-framework.md)), and a setting a server cannot read at bind time is one more thing declared and never consumed.

`tests/mobile-shell.test.js` evaluates **computed values at a viewport width** — a small cascade evaluator with media-query filtering, `!important` and source order — rather than grepping for a breakpoint. A grep passes the moment a query exists and says nothing about whether it wins; it would not have caught that `.fe-burger { display:none }` written *after* the query beat the query on source order, which is the bug the first build shipped. Writing the evaluator also found that slicing one span from the first `<style>` to the last `</style>` swept up the vendored 3D library and the page markup between them, so selectors arrived carrying HTML and `:root` never matched `:root`.

The shell offsets are **derived** from the CSS — every declaration positioning something by `var(--fe-panel)` or `var(--fe-rail)` — so a fourth one added later is in the denominator with nothing to remember. `.fe-panel` itself is exempt **by name with a reason** (it is `position:fixed`, so its own width never pushes the page), and the test asserts the exemption set is exactly that one and that the panel is still out of flow.

Above 700px not a single computed value changes: verified in a real browser at 1920px (panel 232, `.main` at 262, status bar at 262, burger hidden, track in the top bar).

### iOS Is the Same Page, Not a Second One
*"I want a full replica of the app for mobile iOS ready to send for TestFlight."*

**Full replica means the actual `src/index.html`, all 28 pages, inside a
WKWebView** — not a native re-implementation of them. The mobile assessment
already argued the shape and it holds harder here: option C's real cost is never
the framework, it is **a second surface**, and this codebase has paid for two
surfaces disagreeing three times in one week — the plate pointer, the frame
pointer, `effectiveCamera`. One surface cannot drift from itself. The phone shell
was built for exactly this and is already measured at 362px of page on a 390px
screen.

**What is native is what a browser cannot do.** Three things, each with a reason:

`file://` was the obvious way to load a bundled page and is **wrong**: WKWebView
gives it an opaque origin with **no localStorage**, and the SPA keeps the project
selection, the API address and every editor preference there — it would come up
blank on every launch and read as data loss. A `WKURLSchemeHandler` on
`film-engine://` serves the same bytes from the bundle with a real origin.

`DEFAULT_API_BASE` follows `location.hostname`, which is correct for a laptop and
for a phone on the LAN and **meaningless for a custom scheme** — `film-engine://app`
would derive a base pointing at nothing. `defaultApiBase()` returns `''` for a
non-`http(s)` origin, and the shell injects `film_api_url` at
`.atDocumentStart` so the explicit override that already existed is the one that
wins. It is the same rule as the browser, with the one case a browser never has.

The engine runs on a Mac over plain HTTP on a LAN address, which iOS blocks. The
app declares `NSAllowsLocalNetworking` — deliberately not
`NSAllowsArbitraryLoads`, which would permit any cleartext host — plus
`NSLocalNetworkUsageDescription`, without which iOS 14+ silently drops LAN
traffic and the failure surfaces as a connection error rather than a permission
prompt.

**The setup screen is native because a blank page is not an error message.** The
app has to be told where the engine is, so it normalises what a person actually
types (`192.168.4.40`, with or without a scheme or port), probes `/api/health`,
and says *reachable* or *why not* — the same reasoning that replaced
*"Backend offline"* with something a director can act on.

**The bundled page is a copy, and a copy is the risk.** `ios/FilmEngine/Web/index.html`
is `src/index.html`; `tests/ios-app.test.js` fails if they differ by one byte,
because a drifted copy is precisely the second surface this design exists to
avoid. The test also derives the page list from the SPA's own `data-page`
attributes rather than counting to 38, and checks the bundle carries every one.

**TestFlight needs one thing this repo cannot supply.** The project builds and
runs — verified on an iPhone 16 Pro simulator against the live API, showing all
three real projects — and every setting an upload requires is set. Archiving
fails with *"No Accounts: Add a new account in Accounts settings"*: Xcode holds
no signed-in Apple ID, which needs a password and 2FA. `ios/README.md` carries
the three steps and the exact commands. Stated rather than worked around, because
a wrapper that cannot be signed is not shippable and pretending otherwise is
discovered at upload.

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

### Every Dial the Route Accepts Has a Control
`regenerateShot` accepts **eight** parameters — `direction_mode`, `mode`, `negative_prompt`, `prompt_override`, `seed`, `style_override`, `use_anchor`, `use_annotations` — and the SPA posted an **empty body**. Every one of them was reachable only from an agent host or from curl, which is the literal content of *"it does a lot without my control in the background"*: the controls existed, on the far side of the app.

**Direct this shot** puts all eight in one place, on both surfaces a frame is judged on — the grid card and the full-screen viewer, because a 260px thumbnail is not where you decide a shot is wrong.

**The free preview leads rather than hiding behind a toggle.** `GET /shots/:id/prompt` spends nothing and reports the assembled prompt, the ceiling, the headroom and every contributor with what it wanted and what survived — so the budget is a set of bars you read *before* paying, and the mode that costs money to try is the one you can look at first. Choosing a mode re-reads it, which is why the preview had to learn `direction_mode` in the first place. A mode that cannot run — camera mode with no anchor attached — says so **where it is chosen**, rather than as a 409 after the click.

`tests/direct-shot-ui.test.js` **derives** the parameter set from the route, including the two read through shared helpers (`activeAnchorFor_` → `use_anchor`, `annotationsFor` → `use_annotations`). A hand-written list is only ever as complete as whoever wrote it that afternoon, and the next parameter added to the route would be silently unreachable again with nothing failing. It also checks each sent parameter has a control **a person can operate**, since sending a hardcoded value is not the same as offering control over it.

### Recompose: Keep the Performance, Change the Place
*"V6's framing and reaction are perfect, but not the background — it should be the opposite side, as she's looking at the dragon."*

No existing operation could express that. `regenerate` rebuilds the whole frame from the card and loses the performance. `refine` sends one picture and a negative that refuses `different composition, different framing` — and on a close-up **the background IS most of the composition it is told to preserve**, so refine is structurally incapable of replacing it. Every path treated references as *things to be consistent with*; none assigned them **roles**.

`recompose` sends two ordered references: **[0]** the frame whose performance is kept, **[1]** the plate whose place is adopted. Roles are **positional, never tagged** — only Runway preserves `@tags`, while Meshy and Gridlight flatten the array and OpenAI's edit input has no tag syntax, and this project runs Meshy.

**The change leads.** Three separate failures in one day had continuity language outranking the change, and each time the model returned the source unchanged. So the prompt opens *"Replace the entire background in the FIRST reference image with the location shown in the SECOND"*, and what is preserved follows.

**One source of truth per role.** The FIRST supplies identity, face, expression, pose, eyeline, wardrobe, scale, crop, composition, camera position, lens and framing. The SECOND supplies architecture, set dressing, time of day, **lighting and colour grade**. Claiming the original lighting while adopting a new place asks one question twice and lets the model pick. The negative refuses **both** directions — `original background, unchanged background` and `different person, different pose, different framing, extra person`.

**The background must belong to this shot's own location.** A plate from elsewhere is a different film, and a named-but-absent one is **refused rather than fallen back**, since falling back would silently use a different place than the one asked for.

Reachable from **both** directing surfaces — the board's version list and previs — through **one** runner and **one** confirmation, because two separately written confirmations are how two surfaces come to disagree about what they are about to buy. The confirmation leads with **film facts** (what is kept, which background, what is held, what is adopted) and puts the prompt, the negative and the reference ordering under a collapsed *Technical details*: the mechanics stay available because they are the only free feedback loop, but they are not the directing interface.

**Revised after review.** Nine issues came out of the critique pass and all nine are closed. The ones worth recording:

A failed preview left **Generate armed** — a gate whose whole purpose is inspection before spending, permitting the spend when the inspection fails, is worse than no gate because it teaches people the check happened. All three confirmations now disarm before loading and arm only on success.

`listPlateViews` selected no `file_path` and manufactured an `image_url` for every row, so a plate whose file was gone was offered as a normal choice — and the picker's filter on "has an image_url" was filtering on something **always truthy**. Views now report `available` from the disk, and an unusable one is shown **disabled with its reason** rather than dropped, because a view a director photographed should never silently vanish.

`servedUrlFor` derived the serving subdir positionally, two directories up. That is right for a plate at `…/refsheets/<project>/x.png` and **wrong for an archived frame** at `…/storyboards/<project>/versions/x.png`, which is three — so it returned the project id as the directory. The behavioural payload test could not catch it (it proves the bytes, not the thumbnail) and asserting non-null would not have either, because the broken URL was a perfectly good string. There is now a test that **fetches** the URL and requires a 200.

Naming the current version and omitting it described **the same picture and gave opposite answers** — four shots on a real board were in that state. And the cost was presented as definitive while `callImageGen` walks the chain past a refusal, so it is labelled first-attempt-only with the fallback chain disclosed.

A recomposed frame is **deliberately unstamped**: the keyframe fingerprint means "the card's current image payload", and this frame was never generated from that. `skip_fingerprint` is an explicit documented exception rather than a quiet omission, and `input_refs` records the true provenance as identifiers — never data URIs, because two megabytes of base64 in a provenance column is a copy, not a record.

### A Spinner That Never Resolves Is Worse Than an Error
Three compass plates were generated, stored correctly and served correctly by the API — and reported as **missing**, because the panel that shows them sat on *"Loading views…"* forever.

The cause was mine, introduced with the plate viewer: the render built its card markup with `r.location`, and there is no `r` in `renderLocationViews` — it was a leftover from the character turnaround, where `r` *is* the response. The template threw mid-build, nothing caught it, and the placeholder stayed. **From the outside that is indistinguishable from the plates not existing**, which is exactly how it was reported. A source check for `openPlateViewer` passed the whole time, because the text was all present.

Two things fixed, and the second is the general one. The renderer now takes the whole response and reads the location's name off it. And **any renderer that paints a loading placeholder must have a path that replaces it** — the render is wrapped, and a failure says *"the plates are still there, this is a display fault"* rather than leaving a spinner.

The test is over **every** renderer that writes a placeholder into a panel, so the next one is covered. Two versions of it were wrong first: it matched any `Loading…` string and swept in nine `setStatus('Loading scenes…')` calls, which write to the status bar and cannot leave a panel stuck — nine false positives is how a check gets switched off, taking the one real case with it. And it looked for a recovery after the **first** `catch`, which is the fetch's, with the whole main render sitting after it; a mutation replacing the render's own handler with `setStatus()` passed. It reads the **last** catch now.

### A Compass Side Is an Extra View, Never the Headline Plate
Reported with the evidence: after a compass sweep wrote east then south, the location's `reference_image_url` pointed at **south** — the last side written, and it would have been west had west completed. The master plate on disk was untouched; only the pointer moved.

**Three sites answered "which plate is this subject's" and two were wrong the same way.** The locations list, the props list and `getSubjectPlate` all took `ORDER BY created_at DESC LIMIT 1` — the newest row. `gatherShotReferences` did it correctly, falling back to the view-less default.

**So no frame was ever mis-anchored**, which is the reassuring half and worth stating first: generation already used the master. The DISPLAY was wrong, and a director reading a card cannot tell those apart — which is exactly why it was reported as mis-anchoring the scene. Two paths answering one question differently is the same shape as the storyboard-frame pointer and the character turnaround before it.

`headlinePlate(rows, { view })` is the one rule: the view asked for, else the **default, view-less** plate, else anything rather than nothing — a location whose master was deleted should not lose its plate entirely.

**`film_locations.reference_images` is vestigial.** It is written by the update route and read by nothing — not the gather, not the payload builders, not the page. Populating it with the view set would create a second source of truth that nothing reads and that could disagree with `film_assets`; `GET …/plate/views` already answers that question from the rows themselves.

Two vacuous tests were caught by mutation before this shipped, both worth recording. The fixture built rows **oldest-first** while the query returns newest-first, so `list[0]` happened to be the master and a mutation replacing the entire rule with `list[0]` passed — a fixture disagreeing with reality in exactly the direction that hides the bug. And the shared-rule check grepped for `headlinePlate`, which the **import line alone** satisfies; it now requires a call, and at least three of them in the locations route. The comment quoting the query it replaced also had to be stripped before counting, or the file that fixes the bug reports the bug.

### A Location Has Views; a Shot Picks One
A location had exactly **one** plate, selected with `ORDER BY version DESC LIMIT 1`, with no record of which way it faced. On Wingfall that plate looks from the entrance **into** the cul-de-sac — so 1A and 2A had a photograph, and 2B and 2AA, which shoot back the other way, were handed a picture of what was **behind** the camera and invented the rest. Every wrong road, missing kerb and misplaced car traces to it.

Which view a shot needs is a property of the **shot**: the location owns a growing set of views, and the card's `location_view` says which one it is looking at. Chosen from a dropdown of what exists rather than typed, because a typed view matching nothing falls back silently and looks like it worked.

Three things had to change together. **Plates are named per view** (`location_STREET__from_the_far_kerb.png`) — they were one file per subject, so a second view overwrote the first and the set could never grow past one; the default keeps *exactly* its old name, or every project loses the plate it already has. **Replacement is scoped to the same view**, for the same reason. And **selection is by view** with the default as an explicit fallback: a card naming a view somebody deleted must still get its location, since a silent gap replaces a wrong reference with no reference.

**A new view is anchored on an existing one.** Generated independently, four views of a cul-de-sac produce four different cul-de-sacs — the blue house on the right of one is not the blue house you see when you turn. The existing plate travels as the first reference and the prompt says *the same location, photographed from a different position — same buildings, same materials and colours, same driveways, same streetlights*. It is the shot anchor's mechanism pointed at plates.

Generated **on demand** rather than as a fixed compass set: you pay for angles you actually shoot, there is no 45° error because the plate is made at the angle you are using, and the set grows to fit the film. The cost is one extra generation the first time you shoot a new angle — and the second shot at that angle is free.

### One Picture Becomes Four Sides
*"All the views are on the same side. We don't have a single picture of the opposite side, which is what is needed for 2AA."*

Views were already per-location and already anchored on an existing plate, and every one still came back the same half of the street. The anchoring is not the bug — it is the reason four views are four sides of **one** place rather than four different streets — but a plate contains no information about what is behind its own camera, so a model asked to turn round re-photographs what it can see, because that is the only thing it has.

**It was never the wording, and finding that out cost one image.** The first fix stated the bearing and added the clause nobody had said — *"…is now directly BEHIND the camera and is NOT in this frame"* — and the plate came back as the establishing view with a colder grade. Pixel-for-pixel the same hoop, the same seven houses, the same storm drain. Opening the two prose views the director had already generated showed the same thing: three differently-worded prompts, three regrades of one photograph. Three different prompts producing one identical composition is what proves the prompt is not the variable.

**An edit cannot move the camera.** `lib/providers/meshy.js` routes *any* reference to `/openapi/v1/image-to-image`, and OpenAI's to `/images/edits`; both hand back a modified copy of the picture they were given. Runway's `gen4_image` does the opposite — it *generates* a new image conditioned on references it can name with tags. So whether attaching a reference means **"condition on this"** or **"edit this"** is a property of the **provider**, and the plate code assumed the first for all of them: correct on one adapter, structurally incapable on the other three. Every image adapter now declares `referenceMode`, with its endpoint as the reason, and an adapter that declares nothing falls back to `edit` — over-trusting is what produced four copies of one street.

A **new view** is precisely the thing an edit cannot produce, so on an edit-mode provider a view drops **every** reference and is generated from words. Every reference, not just the anchor: one mood-board image is enough to route the call to the edit endpoint, so dropping the anchor alone would leave a view that is an edit of the *look* plate instead. A subject's **first** plate is untouched — it has no view and no anchor.

Continuity then comes from the location's **description** and the project's style, which is the honest place for it: the existing plate's geometry says nothing about what is behind its own camera. On the real production the reverse side came back as a different camera position with different houses in a different arrangement — and the same era, the same wet asphalt, the same blue-hour fog, the same practicals. It is a usable reverse angle and it is **not** geometrically continuous with north, which is stated rather than implied: the result reports `anchored: false` and names the lever, since the fuller the location description, the closer the sides look.

**The compass is a convention, not a survey.** We cannot know true north, and the prose views a director actually writes — *"looking back across the bulb"*, *"looking at MAYA's house"* — are positions relative to a scene the model cannot see, which is why they resolved to whatever it could see. So the plate that already exists **is** north, and east, south and west follow by right-hand quarter turns: arbitrary, consistent, and sayable by a card, a picker and an agent alike. Prose views still work and still lead with the turn; they simply cannot carry a bearing.

**One press, three generations.** On a conditioning provider every side is anchored on the **default** plate, never on the previously generated one, so drift introduced in `east` cannot compound into `south` — each side is exactly one turn from the picture the director approved. Sides generate in **sequence**: three concurrent image calls against one provider is how a queue earns a 429, and the retry costs more than the wait. A provider that has started refusing stops the sweep rather than being asked twice more, and the sides not attempted are **named**, because a partial sweep reported as success is how a reverse angle gets shot against a plate that was never generated.

The anchor side is never regenerated — buying a duplicate of the picture we were handed for free is the one certain waste — and a location with **no** plate is **refused** rather than swept, since four independently generated views are four different places and attempting it looks exactly like it worked. `GET …/plate/compass/plan` prices the sweep for **free** through the same planner the sweep runs, so the number in the confirmation is the number that will be charged.

**A view set that could only grow is not a set you can curate.** Four views were generated on the real production, all four were the same side, and removing the three duplicates meant editing the database by hand — while the sweep *skips* a side that already exists, so a bad side was permanent **and** blocked the good one from ever being bought. `DELETE …/plate/views/:view` removes the row and the file together (half a delete lists a view whose picture is gone, or leaves disk nobody can find), and `__default__` names the original plate, which has no view string and so cannot travel in a URL path otherwise.

It **reports** the scene cards that named the deleted view rather than rewriting them. Which side a shot looks at is a decision the director made, and silently repointing it at another direction is precisely the class of bug views exist to prevent; left alone the card falls back to the default plate, which is documented and visible in the shot's own prompt preview.

Served at `POST /film/locations/:id/plate/compass`, `GET …/compass/plan`, `GET|DELETE …/plate/views[/:view]`, on the Locations page beside the views, and as `plate_compass` / `plate_view_list` / `plate_view_delete` (**141 tools**). The delete tool arrived with no reader, which `tests/mcp-tools.test.js` caught as *"these can delete by id and cannot find one"* — an agent that can remove a view and cannot list them is one that deletes by guessing.

### A Reference Can Be Photographed, Not Only Generated
*"Everywhere I can generate plates or boards, I should be able to upload one too, say I'm working outside of film engine."*

Every reference in this pipeline could only be born inside it. That is a strange constraint for a tool whose job is keeping a film consistent with itself: the most authoritative picture of a place is usually a photograph of it, and the most authoritative picture of a character is often the one the art department already made.

The set is **derived from `KIND_SOURCE`**, the registry of what can be a reference at all — three `entity` kinds (character, location, prop), one `frame` (the storyboard anchor) and one `project` (the look). The frame, the previs image and the GLB already had imports; none of the four reference kinds did. Deriving the denominator there is what makes a sixth kind fail the test rather than arrive silently generate-only.

**An upload lands exactly where a generation lands** — same table column, same filename from `plateFileName`, same per-view replacement — so `gatherShotReferences` picks it up without knowing where it came from. Anything else is a picture that lists and never reaches a prompt.

**It is deliberately not fingerprinted.** A fingerprint says *this was generated from that payload*; an uploaded plate was not generated from anything, so stamping it would mark it stale the moment somebody edits the subject's description and ask the director to regenerate over their own photograph. NULL means "outside the workflow", which is precisely what an upload is. `imported: true` records it, and `style_applied: false` is honest: the film's look was never applied to a picture that arrived finished.

**The extension follows the bytes.** `plateFileName` always ends `.png` because everything this engine generates is a PNG, and the first working version wrote an uploaded JPEG under that name — the same lie the storyboard target refuses to tell, caught by uploading a real JPEG to a real prop rather than by any test. Replacement is therefore scoped to the **subject and view across extensions**, not to an exact filename: scoped to the filename, an uploaded JPEG lands *beside* the generated PNG of the same view and the gather picks whichever row comes back first — a subject with two current plates and no way to tell which one a shot used.

**JPEG, not only PNG.** Everything this engine generates is PNG, so PNG was the only thing the validator knew — but "outside Film Engine" means renders and phone photographs. A JPEG is walked by its segment markers the way a PNG is walked by its chunks, because checking the two-byte SOI would accept any file starting `FF D8 FF`, and a plate that cannot be decoded later is a shot that generates with no reference and no error. The **storyboard frame stays PNG-only** and says why in the registry (`pngOnly`): the live frame is addressed as `{shot_code}.png` in thirteen places, so accepting a JPEG means changing all of them or storing a JPEG under a `.png` name — a lie a decoder eventually calls. Stated rather than omitted, so the gap cannot be quietly re-labelled a decision.

`server.js` decided the 150MB media limit from a hand-written list of three path shapes — already the kind that rots, and the four new targets would each have inherited a 10MB ceiling and refused a normal photograph, surfacing as a destroyed connection rather than a message. It is derived from the URL now: any `/import` endpoint carries a file.

One `uploadControl()` builds all four controls, on the precedent `markupToolbar()` set. The test **executes** it rather than grepping for `data-import-target`, because the attribute is produced at runtime and appears nowhere in the source — a grep reports a working page as broken. Served at `POST /film/{characters/:id/refsheet,locations/:id/plate,props/:id/plate,projects/:id/mood-board}/import`, and as `plate_upload` (**142 tools**).

### Several Shots, One Move
*"We must be able to send multiple pictures to generate a specific sequence and details… I should be able to select which shots, and then enter details for the scene so it's as accurate as possible."*

Video generation took exactly **one** picture — the shot's own keyframe as `init_image` — so the only thing a director could say about motion was whatever fitted in one still plus a movement word from a list of eighteen. Where the shot is **going**, and what it looks like when it arrives, was unsayable. That is why a move across a street had to be described rather than shown.

**The ceiling is the provider's.** `lib/providers/runway.js` collapsed everything to one image (`promptImage = p.promptImage || p.init_image || p.image_url || refs[0].uri`), while `image_to_video` documents `promptImage` as a string **or** an array of `{uri, position}` with `first` and `last`. So two per generation, not N — and each adapter declares `maxKeyframes` with its endpoint as the reason, falling back to **1** when it declares nothing. Gridlight is held at 1 because a swappable local agent's endpoint is unknowable from here, and over-claiming sends a destination the service ignores while the director is told nothing. Frames beyond the ceiling are **reported**, never dropped quietly — the failure `maxReferenceImages` and the prompt ceiling each hit once already.

**N shots become N−1 segments**, each travelling between two frames the director has already approved, stitched afterwards. `lib/video-sequence.js` plans and generates nothing: the split that lets the cost, the ordering and the refusals all be shown before a credit is spent, exactly as `lib/run-plan.js` does. Press order **is** play order, and reordering the shots reorders the move.

Three refusals carry it. A shot with **no keyframe refuses the whole sequence** rather than being skipped — skipping silently joins the shots either side, through a moment nobody has seen, and the result looks like a success. A provider that takes one keyframe produces a **degraded** plan (a still per shot, motion in words) which is *reported* rather than presented as what was asked for. And the ceiling lookup no longer swallows every error into "this provider takes one keyframe": a wiring mistake used to become a silent degrade whose only symptom was N segments where there should have been N−1, so an unresolvable provider is now named as unresolved.

The description leads every segment, because it is what is true of the *whole* sequence; what follows is which shot this segment starts on and which it arrives at. Without that, every segment of a five-shot sequence asks for the same thing and the result is five copies of one move.

A clip made elsewhere can be dropped straight onto a sequence (`POST /film/sequences/:id/import`), which attaches it to the sequence's first shot — a clip has to belong to a shot for the timeline and the export to find it. Deleting a sequence **keeps its clips**: they are on their shots, they cost money, and deleting a plan must not delete the footage it produced.

Served at `GET|POST /film/projects/:id/sequences`, `GET|PUT|DELETE /film/sequences/:id`, `GET …/plan`, `POST …/generate`, `POST …/import`, on the Video Shots page, and as six tools (**150 tools**).

### Everything a Person Can Import, an Agent Can Import
*"There is no general storyboard_upload MCP tool, even though the underlying import route already exists."*

Correct, and it was **three** tools rather than one. `MEDIA_IMPORTS` has thirteen targets: the four plates reach an agent through `plate_upload` and the seven media kinds through `media_upload`, while `storyboard-image`, `previs-image` and `three-d-model` reached it through nothing at all — the routes had existed the whole time.

That matters more than convenience, because of what this pipeline is. **The connected model IS the LLM here** — that is the whole reason `tests/mcp-no-server-llm.test.js` exists — so a capability an agent cannot reach is one that must be done by hand or paid for at a provider. Generating a frame in the conversation and putting it on the board is the difference between spending image credits and not spending them.

`storyboard_upload` goes through the same route a person's upload does, so it inherits everything that route already guarantees: the frame it replaces is **archived as a recoverable version**, and a **locked board refuses it** with the same `BOARD_LOCKED` and the same explicit override. An agent path that skipped the lock would be a hole in the lock rather than a convenience.

The test derives from `MEDIA_IMPORTS` and requires a **named** covering tool per target, failing on an unknown rather than assuming coverage — that assumption is precisely how three of them stayed unreachable while the surface looked complete.

### A Shot as a Strip of Stations, Not a Still
`lib/video-sequence.js` already travels between pictures a director approved — but the unit is the SHOT. A five-second push-in reaches the provider as **one picture and a sentence**, so seconds two, three and four are the model's opinion, and the model's opinion is what drifts.

**There is no second pipeline here, and that is the design.** `planSequence(shots, opts)` operates on an *ordered list* and does not know its entries are shots, so feeding it a denser list makes `buildSegment`, the segment loop and `sequence_stitch` work unchanged. And the in-between poses are not invented: `lib/shot-motion.js` already samples the camera across a shot from the film's own optics, so a station is **a fact about the blocking rather than a guess about the action**.

**The chain is the feature.** Each station is generated from the station *before* it through the existing refine path — picture in, no scene card, one instruction. Generating each independently from the shot's keyframe would be N rolls of the dice off one picture, which reinvents exactly the drift a strip exists to remove. That makes the walk **serial by construction**, which is a real cost and the right one.

**Station 0 is never generated.** It is the frame that was approved, and a frame made from itself could only reproduce itself — the rule `lib/shot-anchor.js` already states. A station also never lands on `{code}.png`: it is written as `{code}.s{n}.png`, because writing the shot's own filename would destroy the approved keyframe the strip was refined from.

**No new table.** A station is a storyboard frame like any other and lives in `film_assets`, which gives it the `shot_frames` archive for free: a bad in-between is a re-roll you keep rather than one you lose. Migration 096 indexes it by sequence, shot and station, because the strip is read on every plan, run and approval and each asks the same two questions.

**Everything is capped by the model's own contract, never a literal.** Seedance 2.5 documents 30 images and they are **free** while the video is billed per second; Hailuo 3 takes 9 at 2 credits each. So the same strip plans differently per model, a thinned strip **says it was thinned and what it wanted**, and `'inbetween'` is added to `ROLES` and ranked **between `keyframe` and `character`** — a face is noticed before a grade across a whole film, but within one clip the frame a second away is what holds the shot together. `hailuo3` and `KEYFRAME_ONLY` are deliberately left alone: over-sending is a provider rejection that costs a generation.

**A refusal stops the walk and names what was not attempted**, on the rule `generateSequence` already sets — a provider that has started refusing will refuse the next one, and a partial strip reported as a success is how a sequence gets joined through moments nobody has seen. **Correcting station 2 of 5 redoes 2, 3 and 4**, because a chain re-inherits from the frame that changed and leaving the rest would leave a strip whose second half descends from a picture that no longer exists.

**And the strip that shot is the strip that was signed off.** `sequence_inbetweens_approve` fingerprints the *ordered* stations and their instructions — ordered because a strip is a sequence and not a set — and video generation refuses **409 STALE_APPROVAL** when it has changed, passable with `ignore_approval` exactly as the budget and lock gates are. Approving a strip with ungenerated stations is refused: signing off pictures nobody has seen is not an approval. A sequence with **no** approval is unaffected, which is what every sequence that exists today is.

The whole thing is **opt-in**: without `expand=inbetweens` the plan is byte-identical to what it always was, and a shot whose move will not READ contributes exactly one station and costs nothing.

### Nothing Is Cut From a Motion Prompt While It Still Fits
*"Film Engine sends each shot's action field to Runway as the primary motion instruction, capped at roughly 500 characters. Why are we capping the main motion instructions?"*

Substantially correct, and the cap had no justification. `buildVideoPrompt` sliced `motion.subject` to **500** and `motion.environment` to **300** unconditionally; `buildRunwayMotionPrompt` then assembled them and applied the real ceiling of **1000**. A real shot sent **503 characters against a 1000 limit** — half the budget unused, with the director's motion description pre-cut on the way in.

This is the same defect the image prompt had, fixed there once already: *an allowance is a rule for deciding what to cut when something must be cut, and it was being read as a target to shrink every field to.* The pieces now travel whole and the **provider** applies its own ceiling, because the ceiling is the provider's fact.

When it genuinely does not fit, things go in order of what matters least: the atmosphere note, then the framing boilerplate, and the **subject last** — cutting what the shot is *about* to keep a note about rain is the wrong trade every time. The camera move survives with the subject: it is short, and without it the clip has no move. The subject is then cut at a clause boundary, so the last thing the model reads is a complete instruction.

**What the 1000 actually rests on, stated because it was not.** Runway documents 1000 characters for `text_to_image`, which is where the adapter's `promptLimit` comes from. The **video** endpoints' own limit is not documented in anything this adapter was written against, and the previous code applied the same 1000 with no source stated at all. `VIDEO_PROMPT_LIMIT` now says so: it mirrors the image limit deliberately rather than being independently verified, and holding it there is the conservative direction — over-sending is a rejection that costs a generation, under-sending costs some description.

### Playback Plays the Frame the Board Is Showing
*"It played the videos, then for the other shots it played the first image we had for each instead of the selected one on the board."*

`routes/timeline.js` selected every asset for a shot with **no version and no ordering**, and `pickAsset` took `.find()` — so it returned whichever row the table produced first, which is the oldest by insertion. On a real shot with **twenty-eight versions**, playback showed `2B_v1.png` while the board showed the selected frame. The board and previs had both been fixed to resolve the pointer; playback was never in that set, and it is the surface where being wrong is most visible, because you watch it.

It now follows the same rule, unchanged: `current_frame_version` when a version has been chosen, otherwise the highest. NULL means *the newest*, which is what a freshly generated shot shows and what every shot showed before selection existed, so there is nothing to backfill. A row with no version sorts last rather than winning by accident.

`tests/current-frame.test.js` gains playback to its `SURFACES` list — the whole point of that list being that a surface not in it is a surface nobody checked — and the new assertion is **behavioural**, because the fault was not a wrong query but *no* query: no version selected, no ordering, and a `.find()` that took whatever came back first.

**And a second bug found while reading it.** `loadPlayback` computed the shot to open on and then called `loadShotIntoStage(0)`, discarding it on the next line — so playback always opened at the top of the film however carefully the mark had been kept. The mark was working; the thing that read it was not.

### A Save Must Not Drop the Choices It Was Not Asked About
Two projects lost their image and video providers. The tell was that `image_quality` **survived the same write** that dropped the other two — a partial reconstruction, not a UI-state problem. Two independent causes, and either alone would have been visible.

**`defaultProviderConfig()` read a preference table that had changed shape under it.** When `image` and `video` became ordered *walks* — `["google","meshy","bfl","openai"]` — `isProviderConfigured()` was handed an **array**, looked it up in the registry, got `undefined` and answered false. So every project created after that change was written with the six string-valued capabilities and **no image or video choice at all**. `firstConfigured` is now shared with `resolveId` rather than reimplemented; two readings of one table is exactly how they came to disagree.

**An empty string meant "delete this".** The page sends every capability on every save, so any moment a select read blank — rendered before its options arrived, rendered for another project — silently removed a pin. `null` now clears and `""` means *no opinion*; the two states are genuinely different and were spelled the same. The page also stamps the panel with the project it was built for and refuses to write across a switch.

**Then a second failure hid the first.** With nothing pinned, resolution fell through to the same vendor ranking and picked a company the account had never named, and the error read `google: API_KEY_INVALID` — which blames a credential. `resolveIdWithReason` reports **where the answer came from** and whether anyone chose it; `explicit` is the load-bearing field, and a failure carrying it says *resolved provider: google (FALLBACK: this project pins no image provider)* instead of quoting an upstream 401. `default_image_provider` / `default_video_provider` in app settings give the fallback an owner: the built-in walk is a defensible default for a shipped product and the wrong one for a person's own machine, which has an obvious right answer.

**And `provider_config` was not writable over MCP** — `project_update` refused it, so an agent could create a project and neither configure nor repair it, which is the wrong constraint for a pipeline whose reasoning happens in an agent host. Merged there too, with `null` clearing, so one payload cannot mean two things.

**A placeholder is not a credential.** Six providers were stored holding the single character `k`. Everything downstream reported them configured — `isProviderConfigured` asks only whether the string is non-empty, the panel showed `set ••••k`, readiness passed — and the first sign was a **401 at generation time**, on a job already committed to, with a message blaming the vendor. Refused at the write, where it is cheap and unambiguous: no real key is under eight characters, so this cannot reject something legitimate. Rows written earlier are **flagged rather than treated as unset** — the key IS stored, and saying "not set" to someone looking straight at it is its own confusion.

### The Style Book — a Director's Shots, Reusable Across Films
A named shot with the camera details you know and reference visuals, kept across every project. `film_style_book` follows the **`film_flows` precedent**: `project_id` is nullable and NULL means the director's **library**, listed alongside a project's own (`WHERE project_id = ? OR project_id IS NULL`, `scope: project | library`). Every other reference collection here — mood board, continuity, bible, marketing — is `project_id NOT NULL`, because each answers a question about *one film*. A style book is the opposite: it accumulates.

`ON DELETE SET NULL`, **never CASCADE**. A library entry authored while a project happened to be open must outlive that project; cascading would delete the director's own library as a side effect of tidying up a film — the `film_refsheet_jobs` trap from migration 067.

**The value is the apply, not the notes.** `applyEntryToShot` merges an entry's camera facets onto a shot's scene card, and the card is *already* what `buildStoryboardPrompt` and `buildVideoPrompt` read — so a favourite angle reaches the next generation with no new plumbing. Merged **per facet**, not as a camera block: an entry that says nothing about the lens must leave the lens alone, which is the bug `previsFacets` shipped once where blocking a shot made its keyframe *vaguer*. It reports `applied` and `skipped`, because *"I applied my low-angle"* and *"it carried nothing this shot could use"* are indistinguishable otherwise.

**Precedence is unchanged.** An entry writes **onto** the card rather than becoming a fourth level in `effectiveCamera()`. A thing consulted at generation time is a display that eventually disagrees with the generator.

**A stage pose is not carried.** `position` and `rotation` are six degrees of freedom in one previs stage's coordinate space; the same numbers put the camera somewhere else entirely in another scene. They are in `POSE_FACETS`, reported in `skipped` — an omission that is stated is a decision, one that is silent is a bug. The carried set is **derived from the scene-card schema source**, so a facet added to the card later is carried with nothing to remember.

**The visuals are for a person, and the UI says so.** `KIND_RANK` is `anchor 0, character 1, location 2, prop 3, style 4` against three references on Runway and five on Meshy — a style still already ranks last and is dropped before the request is built on any shot with a cast and a location, and a clip reaches no generator at all. Saying it outright is the difference between a reference library and a director attaching five pictures believing the frame is conditioned on them.

**Visuals arrive two ways, and both had to be built.** The table and the route shipped with **no way in** — no upload control, no link field, and the entry card linked to a serving route that was never written, so an attached picture would have rendered broken. A reference lives in both places: a frame grab on this machine, and a clip that shows a move a still cannot.

An upload has bytes and needs a route; a **link has neither and must not be given a fake `file_path`**, or the serving route 404s on something that was never a file — hence `source_url` as its own column (migration 086). `classifyLink` decides once on the server what a URL points at — `youtube`, `vimeo`, `image`, `video` or a bare `link` — with an `embed_url` where one applies, so the page does not guess and an agent reading the entry knows too. Only `http(s)` is accepted: a `javascript:` URL in something the page renders is a script injection with extra steps.

The section is shown on a **new** shot as well as a saved one. Hiding it until the entry existed meant pressing *+ Shot* offered no way to add a picture at all — which reads as the feature not existing, and was reported as exactly that. The invariant it protected is real (an upload needs an owner, or a cancelled entry orphans the file) and is satisfied by **creating** the owner: *Add visual* saves the shot first and stays open. "Save it, re-open it, then attach" is three steps to do one thing.

Cross-project, so the page is in `ALWAYS_AVAILABLE` rather than one of the nine `PROJECT_PHASES`: a library that outlives every project does not belong inside the workflow of one. Served at `GET|POST /film/style-book`, `GET|PUT|DELETE /film/style-book/:id`, `POST /film/shots/:id/style-book/:entryId`, on a rail button between Setup and Terms, and as six tools (**175 tools**).

### A Resolution That Reaches Nothing Is Worse Than No Resolution
Measured from the file: a prop plate came back **1376×768** on a project set to **2048×1080**. The size calculation was correct and the provider never saw it. Meshy's text-to-image documents `ai_model`, `prompt`, `aspect_ratio`, `generate_multi_view`, `pose_mode` and `remove_background` — and **no width, height, size or quality**. The adapter turns a requested width and height into an aspect ratio because that is the only field the API has.

So "the project's delivery size" is not one behaviour, it is **three**, and nothing said so:

| | | |
|---|---|---|
| `exact` | the adapter sends pixels and gets them | bfl, openai |
| `snapped` | it is told a size and answers at the nearest one it offers | runway (pixel-pair list), google (512px/1K/2K/4K **tier**) |
| `ratio-only` | it cannot be told a size at all; the provider chooses | **meshy**, gridlight |

Declared per adapter with its source, the same rule `promptLimit`, `maxReferenceImages` and `referenceMode` already follow. An adapter that declares nothing is read as **ratio-only**: over-promising is precisely what produced a confident 2048×1152 arriving as 1376×768.

**And this corrects the 2K location floor shipped an hour earlier.** It computed 2048×1152 for Meshy, saw it under Meshy's ceiling, and reported the floor as **met** — on the provider both real projects use, where the number is discarded. A floor that cannot be honoured and says it was is the one outcome worse than having no floor. `honoured: false` now forces `below_floor: true` with the reason, and the plate result carries `requested_size_ignored` so the width and height in the response cannot be read as what was generated.

**This is not a plate problem, it is a provider problem, and it applies to storyboard frames identically.** Both go through the same adapter, so on a ratio-only provider *every frame in a production* comes back at whatever that provider chooses — and since the plates are what the video model draws from, resolution lost here is lost everywhere downstream.

**Can Meshy do 2K? No.** Three independent checks agree. Its API documents no width, height, size or quality field. Its changelog through Aug 2026 shows every resolution change was an **aspect-ratio** addition, never a size control. And every image it has actually returned here is **1376×768** at 16:9 or **1024×1024** at 1:1 — about one megapixel — for `nano-banana-2` and `nano-banana-pro` alike. The models behind it reach 2K; Meshy does not expose it.

That corrected a wrong declaration of our own: `meshy.maxImagePixels` said `2048*2048` with the note *"held at what the models it proxies actually reach"*. The models are not the service. It is now `1376*768`, measured, so the comparison table stops promising 4.2MP from a provider that returns 1.06.

What a location plate really gets at 2048×1080: **bfl and google reach 2K**; runway caps at 1920×1080 and openai at 1536×1024; **meshy returns 1376×768 and gridlight ignores the size entirely**. The remedy is a provider choice, not a setting — so the Compare Generators table carries an **"ignores your resolution"** badge with the reason, beside the price. It changes which generator you should pick and is invisible from cost alone: the only way to find out used to be opening the file and reading its pixels.

The test that caught my own mis-declaration is worth keeping: it reads each adapter's SOURCE and refuses a claim of `exact` from an adapter that sends no pixel dimensions. Google was declared `exact` and sends `image_size: '2K'` — a tier, not a pixel pair.

### A Location Plate Is Generated at 2K or Better
A location plate is the one reference that is **re-shot from**. A character or prop plate is a close-up filling its own frame, so the subject occupies most of the pixels; a location plate's subject is the whole environment, and any given shot uses a *fraction* of it — a corner of the street, one house front, the far kerb. Detail that is adequate on a portrait is mush on a crop, and the plate is what every shot in that scene is built against.

`LOCATION_MIN_EDGE = 2048`, applied **only to locations**: a character or prop already fills its frame, so a bigger canvas buys detail nobody crops into and costs more on every provider that prices by the megapixel.

**Four of six providers reach it; two cannot, and say so.** Meshy, BFL, Google and Gridlight serve exactly 2048×1152 for a 16:9 project. Runway tops out at 1920×1080 and OpenAI at 1536×1024 — neither reaches a 2048 long edge, which is a fact about them rather than something to work around here. The result carries `below_resolution_floor` with the reason and names which providers can serve it, because a floor that quietly delivers less is worse than no floor: the director stops checking.

**The floor holds whether or not the project states a resolution.** Elsewhere a project with no resolution deliberately gets *nothing* — the provider's own default is the right answer when nobody has said, and inventing a size would silently reframe every existing plate. A floor is a different kind of statement: somebody *has* said, for this kind of plate. Characters and props keep the old behaviour exactly.

Two things were wrong in the first attempt and both are pinned. `imageBudget(…, null)` does **not** mean "no ceiling" — it falls back to a default one, so the base for a 16:9 1920×1080 project came back **1672×944**, already shrunk, and the floor was computed from it. And scaling both edges by a factor and rounding each to a multiple of eight **overshoots**: 2048×1160 instead of 2048×1152 is 16k pixels over a provider whose ceiling is exactly 2048×1152, so the clamp fired and delivered 2040×1152 — under the floor, for eight pixels. The long edge is now set exactly and the short edge derived from the ratio.

The floor note is stripped from the payload before the request is sent: `basePayload` is spread straight into `provider.generate()`, so an unrecognised field would travel to Runway or Meshy with it.

### A Plate You Cannot See Full Size Is One You Cannot Judge
Every plate was rendered at the width of whatever box it sat in — a 48px avatar on a character card, a 120px banner on a location, a ~340px column in the detail panel. A reference plate is the picture that conditions **every frame its subject appears in**, and it could not be seen at the size it was generated at. The storyboard has had a full-screen frame viewer since it shipped; the plates had nothing.

`openPlateViewer(src, title)` is one opener for all **six** surfaces — the detail panel, the character turnaround, the location views and the three cards. Deliberately **not** the frame viewer: that one carries a markup canvas and shot-to-shot stepping, both meaningless for a plate, so reusing it would mean either dead controls or a second set of conditions inside it. It shows the picture with `object-fit: contain` — `cover` is right for a thumbnail and wrong for a viewer, since it fills the frame by cutting exactly the edges a director is checking — and reports the real pixel size, which is what a plate is being judged on when someone opens it that large.

**The bug worth recording is the one my own test missed.** The title was built with `JSON.stringify`, which emits **double quotes** — and inside `onclick="…"` a double quote ends the attribute. The browser kept `openPlateViewer('…', ` and silently discarded the rest, so every plate click did nothing while the card's own handler opened the inspector instead. Every source check passed, because all the text is present in the template; only the **rendered attribute** was broken, and it took clicking one in a real browser to see it. `jsAttr()` produces an attribute-safe literal, and the test now **executes** it and refuses `JSON.stringify` at any call site.

Clicking a card's plate calls `stopPropagation` — the card is itself clickable and opens the inspector, so without it you get both and the one you asked for is underneath.

### A Regenerated Plate Has to Look Regenerated
*"I had to hard refresh to see the picture of a character plate, generated through MCP."*

Not a DOM problem. A plate is written to the same per-view filename and **overwrites**, so the URL never changes and the browser serves the copy it already has — a successful, paid-for regeneration leaves the page byte-identical, which reads as nothing having happened and invites pressing the button again.

The storyboard frame learned this once and busts on `asset_version`. **Every plate URL was built with no buster at all**, so the same bug lived one subsystem over, silently, for characters, locations and props alike. `getFileUrl` now takes a version, and the set-based test found **seven more sites in `locations.js`** after the three obvious ones in `characters.js` — which is the whole argument for the test being over the call sites rather than over the case that was reported.

Keyed to the row's own **timestamp**, never to the clock: busting on every render would re-download every unchanged plate on the board on each refresh. Media imports are deliberately **not** busted and say why — that URL is resolved back to a path on disk by the import contract, and a query string breaks the lookup.

**And it was still broken after that fix, in two more ways, both of which the first test passed.** The location and prop queries selected only `file_name` and `project_id`, so the fourth argument resolved to `undefined` — a four-argument call silently degrading to three, and the test checked the *call* had four arguments rather than that the argument resolves. Then the buster read `version || created_at`, and **every plate row is written with `version` 1 as a literal**: the URL gained a query string, looked busted, and was `?v=1` forever. `created_at` is what actually moves when a plate is regenerated.

Both replacement tests were themselves vacuous on the first attempt and are worth recording. One bounded its regex with `[^"'`+"`"+`]`, which cannot cross the quotes in `asset_type = 'reference_image'`, so it matched nothing and passed. The other asked the *database* whether `version` was constant — and the test database is empty, so the query returned nothing, the guard was skipped, and it passed against the bug it was written for. **A check that only runs when there happens to be data is a check that does not run.** Both are mutation-proven now.

**The page itself was never the problem.** `PAGE_RELOAD` is the current page's own loader and the SSE fires on any write from another connection, so the locations page *was* refreshing when Claude generated through MCP — it re-requested a byte-identical URL and the browser served its cache. Verified end to end: an external `UPDATE` from a separate connection produced *"Updated — changed elsewhere"* and a changed `?v=`.

**And deleting a view no longer destroys the picture.** A plate cost money and a turnaround puts three of them behind three Delete buttons; the bytes now move to a `deleted/` folder rather than being unlinked. The row still goes, so the view stops being listed and stops reaching a prompt — a row pointing at nothing was the half-delete the original guarded against, and it still is.

### A Turnaround Is Three Pictures, and the App Used the Wrong One
*"We just generated plates for a character with front, side, back — but have no place to put them."*

They were stored correctly: three files, three asset rows, each carrying its view in metadata. Two things were wrong with what happened next.

**Which one attaches.** Both places that pick *the* plate ordered by `created_at DESC LIMIT 1`, and a turnaround is generated front, side, back — so the newest row is always the **back**. Every frame a character appeared in was conditioned on the back of their head, and the card showed the same. Generating three views cost three times as much as one and made the result **worse than not bothering**, while the symptom — a plausible stranger in the frame — reads as conditioning being weak rather than as the wrong picture being sent. `lib/plate-views.js` ranks front first; `LIMIT 1` is deliberate and unchanged, because the reference budget is three on Runway and five on Meshy and is shared with the location, the props and the anchor.

**Where to see them.** Locations have had `plate/views` since the compass work; characters, the subject a turnaround is *for*, had nothing. `GET|DELETE /characters/:id/refsheet/views[/:view]`, and the whole turnaround renders **in the character's own detail panel** — the place a person looks. A separate Views button was the first attempt and was the wrong shape: clicking the character still showed one picture, so two of the three plates just paid for stayed invisible unless the director found another control. One renderer feeds both surfaces, since two copies is how the board and the viewer came to disagree about their own markup tools. The identity plate is named outright — three plates exist and exactly one is attached, so the other two look like they are working when they are not.

**A regenerated view replaces its row.** The file is written to the same per-view name and overwrites, so a second generation inserted a NEW asset row pointing at the same picture: Ray was regenerated once through MCP and the list showed **six entries for three files**, with three more every time after. Not merely cosmetic — two rows for one view means "the plate" is whichever the query returns, the fingerprint is stamped on one of them, and accepting staleness on the visible row leaves the other still reported as behind. The row goes and the **file stays**, because it is the same path the generation just wrote.

A mutation caught the test being vacuous: it grepped each module for `orderByViewSql`, which the **import line alone** satisfies, so removing it from the ORDER BY left the test green while every frame went back to the back of the head. It now reads inside the clause.

### A Turnaround From One Orbit
A three-view turnaround is **three independent generations** — front, side and back, each its own roll of the dice — so they can disagree about the face, the wardrobe and the build. This codebase has already paid for that: the newest of the three rows was the **back** view, and it was the picture attached to every frame the character appeared in.

The alternative is the *360 video character trick*: generate one clip that orbits the character and take the frames as the sheet. **Frames of one continuous motion cannot disagree with each other** — that is the whole argument, and it is structural rather than stylistic. It is also cheaper: a 5-second Gen-4 Turbo orbit is **25 credits** against roughly **45** for three plates.

`lib/character-orbit.js` is the pure core. Two decisions carry it:

**The camera moves and the subject does not.** A character who walks or turns gives you different *poses*, which is not a turnaround — a turnaround is one pose seen from several angles. The prompt says so explicitly, and the test asserts it does.

**It is still a plate**, so the same isolation applies: empty frame, no room, no scenery. Whatever is behind the character in a turnaround is dragged into every frame that references them.

Views are named with the **existing plate vocabulary** (`VIEW_RANK`) rather than in degrees, because `headlinePlate` and the shot gatherer select by view name — a frame labelled "72°" is a picture nothing can choose. Front is frame 0 exactly, because the orbit is **seeded from the approved front plate** (without it the orbit invents a new person) and because front is the view that attaches to a shot.

**Reachable the four ways a plate already is**, because a capability with no control is indistinguishable from one that does not exist: `POST /film/characters/:id/refsheet/orbit`, a **free** `GET …/orbit/preview`, the `refsheet_orbit` and `refsheet_orbit_preview` tools (**182 tools**), and an *Orbit Sheet* button beside *Regen Image* going through the same pre-spend confirmation every other paid button uses.

Frames are stored **exactly as generated plates are** — same per-view filename, same per-view replacement — so `gatherShotReferences` and `headlinePlate` pick them up with nothing to change. Re-running replaces each view rather than accumulating rows, which is the bug that once left six entries for three pictures.

**An orbit with no front plate is warned about, not refused.** Without one the clip invents a new person rather than turning the one already approved; that is a legitimate thing to want on a character with no plate yet, and a silent invention is not.

**Two of the video's other methods are not built** — the blacked-out-faces technique for multi-character bleed, and first-frame vs omni — because their verdicts are in chapters I cannot watch (*"Did It Make A Difference?"*, *"The Real Secret"*). Named rather than dropped; the bleed one looks the most valuable, since our reference package sends several character plates at once and has no defence against features crossing between them.

Five of the first seven mutations against this survived, and all five for the same reason: the assertions were **file-wide** where they should have been **bound**. `/'orbit'/` matched the preview line after the POST was deleted; the tool check matched `refsheet_orbit_preview` after the generating tool was renamed away; the per-view replacement matched the *still-plate* path's identical clause. Each is now bound to the specific dispatch, the specific tool name, or the enclosing function body.

### A Character Plate Takes the Film's Medium, Not a Photograph
*"Location plates come back painted. Character plates come back photographic. Same project, same preset, same model."* Reported after three paid attempts, and the deduction from outside was exactly right.

Character and prop plates are **isolated**: they take only the MEDIUM from the look, never the whole style preset, because a real preset is largely a description of a **scene** and appending it produced plates that were full rooms. That reasoning stands. What was wrong is where the medium came from — the mood board's `medium` entry, else `DEFAULT_MEDIUM = 'photoreal, shot on a real camera'`. **The style preset was never consulted.**

So on a real project whose preset opens *"A PAINTED DIGITAL ILLUSTRATION. Hand-painted concept art. NOT a photograph, NOT photorealistic"*, and which has no board entry, every character plate was explicitly told **"photoreal, shot on a real camera"**. No wording could win because the preset was not in the prompt at all — which is exactly why three attempts with stronger and stronger negations changed only the colour. Locations were unaffected because they are not isolated and receive the whole preset: painted places, photographic people, one film.

The chain is now **board entry → the medium named in the style preset → the photoreal default**, and the default only when neither says anything. Inventing a medium would silently restyle every project that never named one.

**It takes the director's own words, not a label.** `mediumFromStyle` returns the clauses that name a medium and nothing else — *"NOT a photograph, NOT photorealistic"* is the instruction, and a tidy summary like "painted" throws away the negation the model most needs to hear.

**Clauses, not sentences**, and that distinction is the whole fix. A real preset is usually one long comma-separated string with no full stops: the first version split on sentences and returned the entire forty-clause preset as the "medium" — colour, lighting, lens and period all bound for a character plate, which is precisely the leak isolation exists to prevent. On the three real projects it now yields the painted instruction, the photoreal default, and `"photographic, not CGI, not a 3D render, not illustration"` — the medium clauses only.

Matching is **whole-word** against a short concrete vocabulary, on the precedent the style subject-check already set: substring matching turns "grainy" into "rain", and a detector that fires on ordinary description gets switched off within a day.

**And two encoder call sites were broken.** `resolveFfmpeg()` returns `{ available, bin, source }`; the character orbit's frame cutting and the `shot_review` tool both read `bin.path`, which is `undefined` — so `execFileSync(undefined, …)` throws at the moment the feature is used. `tests/ffmpeg-consumers.test.js` derives the field set from the module's own returns and checks every consumer, because calling the resolver once only samples the branch this machine takes: on a box with an encoder you never see `reason`, which the unavailable branch sets, and a consumer reading it would be reported as broken.

### A Subject Plate Is the Subject and Nothing Else
*"When we do character or prop plates let's make sure we don't include backgrounds."*

Both builders already asked for a *plain seamless backdrop* and both came back with full rooms. The instruction was not missing, it was **outranked**. The style preset **leads** — deliberately, because that is what stops a plate coming back as clip art — and a real style preset is largely a description of a **scene**: the one that produced these plates reads *"hard low-sun key raking through glass, practical tungsten warmth blooming in frame, light visible as shafts in heavy haze"*. Those are rooms with windows and lamps, stated first and at four hundred characters, against three trailing words. And the negative said *background clutter*, which asks for a **tidy room** rather than for no room.

**A subject plate takes the MEDIUM and nothing else from the look.** Scoping the preset with a *"read this only as colour and grade"* instruction was the first attempt and it is a hedge — it hands the model the rooms and asks it not to build them. A plate needs exactly one thing from the look: **what kind of picture this is**. Photoreal, 3D render, cel animation, stop-motion. That is what has to match across a production, and leaving it unsaid is what made a plate come back as a flat vector cutout with a shrug emoji.

The mood board already records it — `medium` is the **first** entry in `KIND_ORDER`, ahead of palette, precisely because it decides what kind of picture this is. So the board is the source, the scene description stays on the frames where it belongs, and a project with no board entry gets `photoreal, shot on a real camera` rather than nothing.

The **empty frame opens the prompt**, before any look is applied, and the negative refuses concrete nouns a model can act on — `background, room, interior, furniture, window, street, scene` — rather than *"background clutter"*, which asks for a **tidy room**. The framing noun is neutral (*studio image*, not *photograph*) so it cannot contradict the medium: hardcoding "photograph" produced *"stylised 3D animation … full-body studio PHOTOGRAPH"*, two incompatible mediums in one clause.

Measured on the prompt that shipped these plates: the empty frame moved from character **276** to character **63**, and the style preset — 276 characters of rooms and windows — no longer reaches a subject plate at all.

**Location plates are exempt and must stay so** — a location plate *is* an environment, and asking one for "no scenery" would ask for a picture of a place with no place in it. Its own constraint is the opposite one. One shared `ISOLATION_CLAUSE`, because two literals is exactly how the two came to ask for isolation with different force: one said *backdrop*, the other *background*, and neither held.

### A Key Is Entered Once, for the Machine
*"So none of the keys I added are stored anywhere?"* — correct, and the reason is worth recording because nothing about it was visible.

`getCredential()` reads `<PROVIDER>_API_KEY` from the **environment first** and falls back to the database. Images generated on Meshy for days because the process running the server had those variables; the stored row had held the placeholder `k` since 26 July. Restarting that server from a shell without them dropped resolution to the placeholder, and the failure arrived as `meshy 401: Invalid API key` — a message that blames the vendor for a credential that was never there.

The settings page was not at fault and was checked: a 40-character value typed into it stores correctly, `last4` and all. What the page did do was **show `set ••••k`**, so a placeholder wore the same green badge as a working key.

Three things close it. A key under **eight characters is refused at the write** — no real key is shorter, the shortest here being an ElevenLabs `sk_` plus 48 — so this cannot reject something legitimate while it does stop the state that made every readiness signal lie. Rows written earlier are **flagged, not disguised as unset**: the value IS there, and saying "not set" to someone looking straight at it is its own confusion. And the placeholders were deleted, so those providers now read *not set*, which is true.

**Credentials were already global and the page implied otherwise.** `film_provider_credentials` is keyed by provider and has no project column — a key cannot be scoped to a film because there is nowhere to record which film. But API keys and per-project provider *choices* sat under one heading, and the lower half needs a project open, so the whole card read as project-scoped and a key entered once looked like it might need entering again per film. Both halves now say which they are. The test asserts the absence of a project column **structurally**, since that absence is the guarantee: add one and every "enter it once" claim on the page becomes false at the same moment.

### A Transition Is Not a Character
`FADE OUT` was listed as a character with a scene count, so every report built on scene presence carried a phantom; and RAY MERCER (introduced in action) and RAY (cued in dialogue) became two people, as did JUNE MERCER / JUNE.

**Three faults, and the third is why the obvious fix did nothing.** The detector matches *two* capitalised words while the stopword list held `FADE` and `OUT` separately, so each was rejected alone and the pair sailed through — a name made **entirely** of transition words is now refused. Re-typing the line as `> FADE OUT.` changed nothing because the parser only honoured a forced transition **after a blank line**, so a `>` written directly under an action paragraph was swallowed into it as prose: a force that only works in some positions is not a force. The unforced check stays gated, since a bare capitalised line mid-action may be a shout, and `> THE END <` is still centred.

**A first name is the same person as the full name.** Collapsed on a **word-boundary** prefix, never a substring — `RAY` starts `RAY MERCER` and does not start `RAYMOND`, and a substring rule merges strangers. The canonical form is the one that already **has a character record**, because the point is to reach the row carrying the description and the plate; with no record either way the fuller name wins, since that is what the action line established. Applied once the whole screenplay has been read rather than per scene: a character can be introduced in full in scene 1 and cued by their first name in scene 9.

On the reported screenplay: five characters, three of them phantoms, became **two real ones with nothing undescribed**.

**And a picker must not offer what the database refuses.** There were three answers to what a prop may be and no two agreed — the CHECK allowed ten values, the page offered nine including `clothing` and `personal` which the constraint **rejects**, and the MCP tool typed it as a free string so an agent learned the legal set from a constraint violation. `lib/prop-categories.js` states it once; the picker is filled from `card-vocabulary` and the test reads the **migration**, since that is what actually rejects a value.

### If the App Stores It, a Person Can Type It
*"I should be able to edit everything in the app manually (text) like the character description."*

A field a route **accepts** and the database **stores**, with no control on any page, is settable only from an agent or curl. That is the failure this codebase has paid for repeatedly under other names — camera mode built, tested and then removed from the page; eight `regenerateShot` parameters reachable only from an agent host; `previs/apply` with no button. Measured against the routes' own field lists:

| | | |
|---|---|---|
| character | 9/13 | no ethnicity, build, hair, distinguishing |
| location | 6/7 | no sound_notes |
| prop | 7/8 | no notes |
| project | 5/6 | **no style_preset** |

**The last one is the serious one.** `style_preset` is appended to **every** image prompt in a production, plates included, and the only ways to set it were the mood board's *Apply look* — which **composes** it, so it cannot be hand-corrected — and curl. The single string that decides how every frame looks could not be read by the person responsible for it. This is the field that once put a flayed quadruped in an establishing shot whose card reads *"Empty, ordinary, still."*

It now sits in Settings with the subject check rendered beside it. The route has returned `style_warning` on every style write since look development shipped and **nothing rendered it** — a warning nobody displays is a warning that does not exist. It is `{subjects, detail}` rather than a string, so printing it directly gives `[object Object]`, which is a warning that teaches the reader to ignore warnings.

The four character fields are grouped and **labelled as what they are**: notes for a person, read by no prompt builder. Saying so is the point — a field beside *Appearance Prompt* that looks like it conditions generation and does not is worse than one that is absent.

**The denominator is derived from the routes** — every `update*` / `set*` handler and the fields it accepts — so a field added later is covered or the test fails. Machine fields are excluded **by named shape** (identifiers, timestamps, percentages, orderings, arrays the app assembles from an upload or a drag), never by a list of exceptions.

Two things the audit got wrong first, both worth keeping:

**A control need not be named after its field, and four are not.** The transition `<select>` is built at runtime with no `data-field`, `budget_total` is sent from a control called `budget_limit`, `template` comes from `budgetTemplateSelect` and `annotation_feedback` from `annotFeedbackToggle`. The first detector reported all four as missing — and a check that cries wolf four times out of five gets switched off, taking the one real gap with it. They are exempt **by name, with the control named**, so the exemption is checkable rather than a story.

**Scope matters more than presence.** `data-field="notes"` exists in more than one modal, so an app-wide search reported the *prop* modal as having a notes control when the control belonged to continuity — and the mutation deleting the prop one passed. The entity check now walks each modal's own `<div>` nesting.

The remaining gaps are **named rather than dropped from the denominator**, because a gap written down is work and a gap silently excluded is one nobody finds again: music-cue rights (the Music Cues page renders no controls at all), title cards (no page exists), per-credit fields, subtitle language/speaker/style/position, three fields on the Rights register, and two on the live-action estimate. A stale entry fails too — an exemption claiming a gap that no longer exists makes the whole list a lie.

### Which Generator Should I Use
The rate book has carried per-model prices, source URLs and checked dates since metering shipped — 7 image/video pairs plus a `gridlight:*` wildcard, every one sourced and dated. None of it could answer *which one should I use*.

**The Rates panel rendered one card per provider**, so ranking meant expanding seven cards and sorting in your head. **And the per-model table printed `1 image(s) per image` for every row** — the renderer used `native_per_unit` where the route was already serving `usd_per_native`, so the one table that could compare models showed no money at all. Declared, served, and thrown away at the last step.

**The units are not the same, which is the whole difficulty.** Runway and OpenAI bill per **image**, Meshy per **call**, BFL per **megapixel**, and video per **second** — so $0.030 and $0.042 are not comparable numbers. Every row is priced against one unit of real work (a frame, a clip) and against a scene of ten, because a few cents an image is invisible until multiplied by a board.

I got that wrong on the first pass and it is worth recording: pricing a megapixel as a frame put `flux-2-pro` at **$0.030** when a 1920×1080 frame is 2.07 MP and really costs **$0.062**, which moved BFL to the top of a table whose only purpose is ranking. Wrong at the top of a ranked table is worse than no table. Megapixels therefore depend on the delivery size, so `project_id` prices the comparison against *that film's* frame and the frame used is reported back — a per-megapixel row is only as true as the size it was priced at.

Three things keep it honest. **Uncredentialed providers are listed and marked, never hidden**: hiding them answers "which of these should I use" while withholding "and this one is half the price if you sign up". **A self-hosted zero sorts last, not first** — it is zero because nobody bills for it, and at the top of a ranked table that reads as a recommendation. And **cheapest is not best**, so each row carries the tier it serves and that tier's stated purpose: a draft model exists to be rolled repeatedly, a precision one to be right once.

The denominator is **derived from `providers.list()`** — every adapter declaring the capability — so an adapter added later is in the comparison or the test fails. An adapter that can generate and cannot be priced is **named**, since an unpriced generation reports as free.

The credential rule is probed **by removing the credentials**, not by reading the rows: every provider is credentialed on a working install, so "if unavailable then it says why" is vacuously true and passes just as happily against a filter that drops them. The first version of that test did exactly that, and the mutation inserting `continue` for uncredentialed providers did not fail it.

Served at `GET /film/spend/compare`, on the Budget page's **Compare Generators** tab, and as `spend_compare` (**169 tools**).

### The Editor Scrolls; Pages Are for the Count and the Print
*"I don't think the page number is important when we're editing… would it solve the issue if we're not trying to do page breaks? Just one continuous screen scroll as we edit."*

Yes — and it removes the **class** of bug rather than defending against it. A page-break indicator is a `<div>` with a class, no element type and no text, which is indistinguishable from an empty block, so while it lived inside the contenteditable the orphan-adoption loop kept turning five of them into 32px of nothing on every keystroke. Two passes were taught to recognise furniture; taking the furniture out of the editor entirely is better.

**But they were doing a second job, and dropping them blindly would have been a silent regression.** `generatePrintHTML` carries `.page-break-indicator { page-break-after: always }` — those same nodes are what break the pages in an exported PDF. Without them the browser breaks wherever it likes, including between a character cue and its dialogue, which is exactly what `MAY_END_PAGE` exists to prevent.

So pagination moved rather than went: `paginateInto(container)` takes a **container** instead of reaching for the editor, and `exportToPDF` runs it on a **detached clone**. The editor is a continuous scroll and never holds furniture; the PDF is paginated correctly; and nothing is typing into the markers while they are inserted.

**The page count stays**, because it is genuinely useful — one page is about one minute — and `calculatePageEstimate` counts **blocks**, so it never needed the markers. It also carried a dead filter skipping `page-break-indicator` among a block's *children*; indicators are inserted as **siblings** (`blocks[at].after(…)`), so that clause could never have fired. Removed.

The furniture defences stay even with no furniture to defend: a contenteditable will still hand back bare `<div>`s, and removing the recognition because the indicators left would re-open the empty-block bug the moment anything else inserts a node.

Verified in a real browser: **0 indicators in the editor**, 189 blocks steady through 25 keystrokes, 0 empty blocks, no JavaScript errors — and the print clone still gets its **5 page breaks**.

The test's walk-up assertion was written with a `[^\]]` class that cannot cross the `]` inside `MAY_END_PAGE[blocks[at].dataset.elementType]`, so it matched nothing and passed against a paginator with the rule deleted. **Third time this codebase has paid for a bounded character class**; it is non-greedy now, and the mutation fails.

### Every Way a Screenplay Is Written, Not Just Typing
*"you fixed probably just this screenplay, what we must fix and how we do all this… when a screenplay is being written or edited."*

Correct, and it was the right thing to push back on. Both previous fixes landed in `onEditorInput` — the **typing** path. Derived from the source, the editor is written to by **19 functions**, of which **13 mutate its structure and normalised nothing**:

`acceptConversion` · `appendAIContent` · `editorRedo` · `editorUndo` · `insertAIContentAtCursor` · `insertAITextAtCursor` · `loadLatestFountain` · `loadScriptVersion` · `onEditorKeydown` · `renderFountainToEditor` · `reorderScenes` · `setElementType` · `updateEditorTitlePage`

**A programmatic DOM change does not fire `input`.** So the AI writing into the screenplay, accepting a prose conversion, undo, redo, pressing Enter, reordering scenes, loading a version, rewriting the title page and changing an element's type all left whatever they made and waited for the writer's next keystroke to tidy up. That is the reported bug one level above where it was fixed.

`normalizeEditor()` is the one repair, and it does **three** jobs in an order that matters: leave the editor's own furniture alone, adopt orphan **text** into a block while dropping an orphan that has none, then sweep any block that is empty and not under the caret. It is idempotent, because several of these paths call one another.

**Honest about what it corrects and what it merely guards.** On the typing and Enter paths it is corrective — that is where the empty blocks were manufactured. On the AI paths it is currently a no-op, because `parseFountainToHTML` already emits well-formed blocks; its value there is that they cannot silently stop being well-formed. Saying so is the difference between a guarantee and a claim.

`tests/screenplay-mutators.test.js` **derives the writers from the source**, so the fourteenth way in fails the test rather than shipping. Exemptions are named with reasons: two functions only READ `innerHTML` (the undo snapshot, the PDF export) and three are `execCommand` on a selection, which fires a native `input` event and is therefore already covered. A stale exemption fails too — it must name a function that exists.

Verified in a real browser on the live document: load, AI append, AI insert at cursor, element-type change, undo and redo all leave **189→194 blocks with 0 empties, 5 page breaks intact and the estimate steady at ~6 pages**, with no JavaScript errors.

### The Editor Ate Its Own Page Breaks
The empty-block sweep stopped the space growing while typing and did not explain where the blocks came from. They came from the editor eating its own furniture.

`updateEditorStats()` paginates at the **top** of `onEditorInput`, so by the time the orphan-adoption loop walks the editor's children the page-break indicators are already sitting there — and an indicator is a `<div>` with a class, **no `data-element-type` and no text**, which is precisely the shape the loop was written to adopt. Measured in a real browser on a 189-block screenplay: **five indicators, and the loop treated all five as orphans on every keystroke.**

So each keypress turned five indicators into five empty `action` blocks. Those were then counted as lines, which inflated the page estimate — **6 → 9 → 15 pages on an unchanged 1,451 words** — which inserted *more* indicators, which became more empty blocks. That is the "huge space that is left", and it is why it grew the longer you typed and why the estimate climbed with it.

The empty-block fix made the loop **delete** textless nodes instead, which stopped the growth and silently removed the pagination display: 5 indicators to 0 on the first keystroke. Better, and still wrong. **Furniture must be invisible to both passes**, not adopted by one and eaten by the other.

`FURNITURE_CLASSES` names it — `page-break-indicator` today — mirrored on the page as `SP_FURNITURE`, skipped by the orphan loop *before it decides anything* and by the sweep, and the two lists are compared element by element.

The denominator is **derived from the page**: every `<div>` the SPA creates with a class and inserts among the editor's own children. The first version of that scan matched every `createElement('div')` in a 2MB file and reported the sidebar's `nav-group` as editor furniture — so it is scoped to insertions whose target is `editor`, a `block`, or `blocks[…]`, which is what "among the editor's children" actually means.

A test also pins the ordering that makes this necessary: pagination runs before the orphan loop, so reordering would "fix" it by accident and break again the next time something inserts during input.

Verified end to end: 20 keystrokes on the real document leave the block count at 189, empties at 0, **page breaks at 5**, and the estimate steady at ~6 pages.

### An Empty Block Is 32px of Nothing
*"there is still an issue when we are typing in the screenplay where it adds extra space… As soon as we type away or click away from the screen it fixes it."*

Measured in a real browser on The Glass Harbour. The correct gap between a line of dialogue and the next character cue is **16px** — one blank line, drawn by `.sp-character { margin-top: 1em }`. Each stale **empty block** sitting between them adds exactly **32px**: its own line, plus the margin its type carries.

| | |
|---|---|
| correct | 16px |
| + 1 empty block | 48px |
| + 2 | 80px |
| + 3 | **112px** |

The reported screenshot showed roughly 130px between every dialogue and the cue after it — three or four of them.

**They mean nothing, which is why it healed itself.** `serializeElement` opens with `if (!text) return;`, so an empty block writes **nothing** to the Fountain. The moment anything re-parses the document and rebuilds the editor, every one of them vanishes at once. The screenplay was never wrong; only the DOM was. That is exactly the "click away and it fixes itself" — and it is also why this was easy to dismiss as cosmetic.

**They accumulate because the editor manufactured them.** `onEditorInput`'s orphan-adoption branch called `createBlock(text, defaultType)` **even when `text` was `''`**, so every bare `<div>` the browser leaves behind in a contenteditable became a permanent empty `action` block. Nothing ever removed one.

Two changes. The orphan branch now **drops** a textless node instead of adopting it — unless the caret is in it, in which case it becomes a real block so the cursor survives. And `sweepEmptyBlocks()` clears anything still empty after each input.

**The caret is the exception, and it is the whole safety of this.** The block you are typing into is empty precisely because you have not typed yet; sweeping it would delete the line being written. `blockHoldsCaret()` reads the live selection, and the test follows the call to make sure the predicate it delegates to actually does.

`lib/screenplay-blocks.js` holds the rule and the SPA mirrors it, on the `screenplay-pagination.js` precedent — the page cannot require a node module (`build.target: single-html`), and two rules that disagree is how a fix survives in the tests and not on the screen. The exemption list is **named** (`title-page`: no body text and entirely meaningful) and the two copies are compared element by element.

`tests/screenplay-empty-blocks.test.js` is set-based over **every type the editor can put on a block** — derived from `ELEMENT_TYPES` unioned with the editor's own `nextType` map, 12 of them — because a sweep that cleans `action` and leaves `character` fixes the reported case and leaves eleven others. Verified end to end in a real browser: three planted empty blocks took the gap to 112px, one input returned it to 16px with zero empties left, and typing `RAY` then a line of dialogue produced the correct 16/0/16 spacing.

One of the checks was vacuous first and is worth recording: the guard regex was bounded with `[^)]`, which cannot cross the `)` in `blockHoldsCaret(node)`, so it matched nothing and passed against the bug — the same character-class mistake the headline-plate work already paid for.

### The Title Page Is Not Body Pages
Found by enumerating the element types the **editor** emits rather than the ten this module happened to list. The editor emits **eleven**; `MAY_END_PAGE` answered ten. The eleventh is `title-page`, and the paginator read it as an ordinary block.

It is `display:none` on screen and its own page in print, and `film_script_elements` has **no row for it** — index 0 is the first scene heading. Two consumers already excluded it by name and three did not, so one cause produced two defects:

**Pagination counted a block nobody can see.** Measured on The Glass Harbour: the block reports `display: none` and still scores **2 lines** (46 characters of stored title data) against the 55-line budget — so every page break in every screenplay was placed two lines early. After the fix all five breaks on that file moved, and all five are still legal.

**Every inline comment was anchored one element late.** The anchor was `blocks.indexOf(block)` over a list whose index 0 is the title page. Read and write were off by the *same* one, so it looked correct in the editor while the `element_index` written to the database pointed at the **previous** element — wrong for the server, the export, and every reader that is not that one function. Nothing had been stored yet (0 rows live and in the repo), so there was nothing to migrate.

`bodyBlocks()` is the one accessor. Five sites asked this question and the two that were right were right because someone remembered — which is precisely why the other three were not.

The test **exempts by name with a reason, never by pattern**: the dual-dialogue columns cannot contain a title page, and the remaining queries iterate for styling or compute an index relative to the list they built, where a constant offset cancels. An exemption matching on text would quietly excuse the next site that gets it wrong. Four mutations — dropping the exclusion from the accessor, and each of the three sites rebuilding its own list — all fail.

### A Button Drawn Outside Its Own Card
*"the delete button leaks out of the card"* — on Characters, which is where it was noticed.

One line caused it: `.entity-card .card-actions` is `display:flex` with **no `flex-wrap`**, and the card is `overflow: visible`. Four buttons (`Regen Image | Upload | Edit | Delete`) measure **233px inside a 222px row**, so the fourth is simply painted 11px past the card's own border rather than being clipped or wrapped.

Measured in the real page before the fix: characters 1 overflowing row, locations 1, props 4 — **every one of them the same row, every one over by exactly 11px**. Characters looked like the case because its three-button row fits with 6px to spare and the report came from that page; it was never a Characters problem.

**Wrapping, not clipping or shrinking.** A clipped Delete is unreachable and a shrunk one loses its label; a second line is the only option that keeps every action usable at any card width. `min-width: 0` goes on **both** the row and the card, because a flex item and a grid item each default to `min-content` — without it on the card, an unbreakable row pushes the card wider than its own grid track and wrapping alone does not save it.

**The audit found two more the eye did not.** Continuity's `Replace | Delete` row and consistency's voice row were written as inline `display:flex` literals with no wrap — the same defect, one screen away from the one being fixed, invisible in the browser sweep because they fit at *that* window width. That is the argument for the row being **one class rather than a per-page literal**: a page that writes its own row opts out of the wrap silently.

**Why the test is a source test.** There is no layout engine here — jsdom computes no box geometry, so `scrollWidth` is 0 for everything, and the SPA has no bundler to add one. The 11px was measured in a real browser and is recorded above; what a test can hold permanently is the two invariants that measurement rests on — every flex row inside a card wraps (**derived** by walking each `entity-card` template, so a card added later is in the denominator), and the row rule exists exactly once. Five mutations were run against it: removing the wrap, removing either `min-width`, un-wrapping an inline row, and a page substituting its own literal all fail.

### An Edit You Cannot See Is an Edit That Did Not Happen
The page was served by `python -m http.server`, which sends `Last-Modified` and **no `Cache-Control`**. A browser reads that as licence to reuse its stored copy without asking, so every change to `index.html` needed a forced reload.

The failure mode is what made it worth replacing rather than remembering, because it is silent *and* misleading: a new control is in the file on disk and absent from the page that is loaded, so pressing it calls a function that does not exist and **nothing happens at all**. That reads as a broken feature. It cost a round trip — *"that button does nothing"* — and had been costing one after nearly every change; the phrase *hard-refresh* closes most of this week's reports.

`backend/dev-server.js` sends `no-store` and **no validator at all**. `no-cache` would not have been enough: it still permits a stored copy revalidated by ETag, and a revalidation answering 304 is exactly the stale page this exists to prevent. The file is read on every request rather than held, since caching it here would reintroduce the same staleness one layer down.

It is still a server, so containment is by **resolved path** — the database, the git directory and every provider credential sit one level above `src/` — and the URL is **decoded before resolving**, because `%2e%2e` is the same escape as `..` and a check on the raw string misses it. No dependency: Node's own `http` and `fs`, which is precisely what [ADR-002](docs/adr/002-vanilla-http-no-framework.md) is about.

### A Warning Must Be Clearable by the Button It Offers
*"What are those warnings and how can I remove them? I clicked twice on 'This is all still current'."*

The storyboard shows two warnings: the screenplay moved on without some shots (drift), and generated work is behind its inputs (impact). The only button accepted ARTEFACT staleness, and the impact report is rooted one level higher, in the shot cards the screenplay moved on without — which nothing on the page could answer except editing every card or deleting the shots and breaking the scene down again. On The Glass Harbour, measured on a copy of the real database: 12 cards behind, 12 to redo, 12 waiting, and pressing the button twice changed none of them.

`acceptDrift` (`POST /projects/:id/screenplay-drift/accept`, `screenplay_drift_accept`) is the missing answer: *I re-read the scene and the cards still hold.* It stamps only the shots that are behind, to their scene as it stands, changes no card, and is narrowed by `scene_id` or `shot_ids`; a later rewrite warns again. It differs from the baseline on purpose — the baseline adopts shots that were never tracked and refuses to silence a known one; this is the director answering a known one. The drift banner now has its own button, and **"This is all still current" answers both halves, cards first**, because the cards are the root of the chain. On the same copy it went 12/12/12 → 0/0/0.

`tests/warnings-clear.test.js` is set-based over `WARNINGS` — every banner, the report it is drawn from, and the route its own button sends — and asserts each report is empty afterwards, and that the "all" button sends every route in root-first order.

### A Warning You Cannot Act On Is One You Learn to Ignore
*"I got shots for all my views, but it still says generated work is behind what it was made from… what does that mean?"*

It means what it says, and it is true. **The payload is the fingerprint**, so a week of genuine improvements to how prompts are built — references, plates, the anchor, the prompt ceiling, the frame size — moves every stamp. A frame generated five days ago would come back different if generated today. On the real project that read **74 stale, 0 fresh**.

Correct, and useless. `POST /assets/:id/accept` has existed since fingerprinting shipped and is unusable at that scale: seventy-four items, each individually acceptable. Seventy-four clicks is not a workflow, it is how a report gets dismissed permanently — and then the real warning is dismissed with it, which is the failure the drift work already paid for once.

**The fingerprint is not weakened to make the number smaller.** It would have been easy to drop the frame size from it and halve the count, and it would have been a lie: regenerating today genuinely does produce something different. Whether the work is still the film you want is a claim only a director can make, so accepting is one deliberate act with the consequence stated — the same reasoning that makes `screenplay-drift/baseline` explicit rather than something the engine decides.

Unstamped assets are left alone: NULL means *outside the workflow*, and stamping them would pull every hand-made or uploaded picture into a tracking system nobody opted them into. An artefact whose inputs can no longer be read — a deleted subject — is **named** rather than failing the batch, because that is the one case that genuinely cannot be accepted.

The banner also now says what "behind" means, which it never did: the inputs changed, **not** that the picture is wrong.

Served at `POST /projects/:id/staleness/accept`, on the storyboard banner, and as `staleness_accept` (**158 tools**).

### One Resolution, Set Once, Reaching Every Creative
*"We need to send the proper resolutions to Runway… what if I want to do 4K? We need to set it at the project level and then it trickles down to all creatives (boards, plates, shots)."*

Measured first: the delivery size reached **one** of the three things it was chosen for.

| | |
|---|---|
| footage | sized from `target_resolution` ✓ |
| board frame | sized from a fixed **1024×1024** budget ✗ |
| plate | never saw a resolution at all ✗ |

So a 4K project boarded at one megapixel and plated at whatever the provider defaulted to, while its clips were 1920×1080.

Both now take the project's size, reshaped to its aspect — one budget, so a plate cannot disagree with the frames that reference it. A plate at a different size from those frames is either detail nobody asked for or a soft reference on a sharp board.

**And there is a ceiling that must not be papered over: nothing here generates 4K.** Each image adapter declares `maxImagePixels` with its reason — runway 1920×1080 (its largest documented `gen4_image` ratio), openai 1536×1024 (the Images API's documented sizes; anything larger is a 400 that costs a request and returns nothing), meshy 2048×2048 (no published limit, held at what the models it proxies actually reach), gridlight 1536×1536 (a swappable local agent, held conservative). An adapter that declares nothing gets the **strictest** default, on the same asymmetry that decides `promptLimit`: over-asking is a rejection that costs a generation, under-asking is a smaller picture generated here where the clamp can be reported.

The clamp **preserves the shape** — changing the aspect to fit would put the board and the footage straight back out of step — and it is **reported** in the payload meta. *"I set the project to 4K"* and *"my boards are 4K"* are different claims, and a director who is not told will believe the second because they did the first. A 4K project asks for 3840×2160 and gets 1920×1080 on Runway, 2728×1536 on Meshy, and is told so.

Video has the same ceiling and it is the provider's: Runway's `image_to_video` documents `1280:720` and `1584:672`, so a clip generates at 720p-class whatever the project says. The route to a 4K deliverable is the **upscale in post**, not a larger ask here.

### The Board and the Footage Are the Same Shape
*"Does the aspect ratio and resolution for the board shots and then for the footage stay consistent, and is it derived from the mood board? It needs consistency and already had some issues there."*

It did. The **image** payload derived its shape from `film_projects.aspect_ratio`; the **video** payload derived its shape from `film_projects.target_resolution`. Two independent columns with nothing reconciling them, agreeing only because 16:9 and 1920×1080 happen to be the same shape. Measured across the eleven ratios the settings offer, **ten produced a storyboard in one format and footage in another**:

```
2.39:1   board 1584x664 (2.39)   clip 1920x1080 (1.78)
1.85:1   board 1392x752 (1.85)   clip 1920x1080 (1.78)
9:16     board 768x1368 (0.56)   clip 1920x1080 (1.78)
```

None had been used yet, so the defect was armed and waiting for a director to use a feature already shipped — pressing **Apply look** with the mood board's 2.39:1 would have produced a scope board and widescreen footage silently.

The aspect ratio is the **creative decision** and the resolution is the **delivery size**, so the frame is the aspect **fitted inside** the delivery raster: 2.39:1 in a 1920×1080 delivery is 1920×804, and 9:16 is 608×1080. *Fitted* rather than area-preserved, because preserving the pixel budget gives 2226×932 for scope — wider than the frame the operator chose, which is not a size anyone asked for. Dimensions are forced even, since h.264 rejects odd ones and a rejection there is a paid generation that fails at the provider.

An absent or unparseable aspect **reshapes nothing**. Absent means *use what is delivered*, which is what every project had before a mood board could set one, and a guess would silently reframe existing work. A 16:9 project at 1920×1080 is byte-identical, which is what makes this safe to ship.

Two things the measurement found that are **not** defects and are worth stating rather than hiding. A board spec reaches the project only when **Apply look** is pressed — `applyProjectSpecs` runs inside the apply branch of compose, not on every board edit, which is the same preview-versus-commit split the style preset has. And Runway **snaps to its own documented ratio list**, so a 1920×1080 request generates at 1280×720 and is scaled afterwards; that is the provider's ceiling rather than ours, and the preview reports the ratio it will really use.

### Nothing Spends Without Showing What It Will Send
*"I generated the first two videos directly on runway and not through the engine as credits are super precious and didn't want to waste them."*

That is the whole feature failing for a reason unrelated to generation quality. CLAUDE.md already claimed *every paid path goes through one confirmation* — which was true of the image paths and **was never true of video, audio or 3D**. Enumerating the controls that reach a paid generator found **six silent and six warned**: `generateVideoFor`, `generateAllVideos`, `generateModelFor`, `generateAllModels`, `generateScoreFor` and `generateAmbientFor` all spent money with nothing said.

`GET /shots/:id/video/preview` is the free preview video never had. `/previs/to-video` existed and is previs-scoped — it refuses on a stale approval and assumes the shot has been blocked, which most never are — so the ordinary question *what would this clip cost and contain* had no answer at all. The preview reports the provider, the model, the length, the size, **whether the storyboard frame is attached**, whether a camera path is going, and what is missing. The keyframe line is the one that matters: a prompt reads perfectly while the frame that would have made the clip match the board is absent, so the words look right and the footage comes back a different place.

Two corrections came out of review, both about honesty rather than mechanism. The confirmation showed **500 characters** of the prompt under the heading *"what it will be asked for"*, which is a confident lie about the rest — it shows the whole thing and states its length. And it printed the generator's own **fps** beside the resolution, which reads as *your film is 8fps*; that number is a fact about the model, the delivery rate is a project setting applied afterwards, so it is not shown at all.

**The gate has to be inside the function, and text matching cannot see that.** Two of the six were one-line functions, and inserting the confirm after the opening line put it *outside the body*: a top-level `return` that breaks the whole SPA at load. Source-text matching reported both as gated because the text was adjacent. The check now bounds the body by **brace depth** from the declaration, and the SPA-parses test caught the breakage independently — which is the argument for having both.

### Runway Receives Motion, Not Film Engine Coordinates

Runway's image-to-video request has no `camera_control` field. The approved Previs path remains the canonical reproducibility record, but the provider receives a concise motion prompt: subject action, environmental motion, and camera choreography derived from the path. The free video preview is built from the adapter's actual request builder and shows the sanitized outbound body, final model/ratio/duration, whether first/last images travel, and the exact credit estimate. Image bytes and credentials are never displayed.

`RUNWAY_VIDEO_MODELS` is the dated provider contract: every currently documented image-to-video id declares its operation, duration, ratios, credit rate, status and source. Unknown or removed ids fall back visibly to Gen-4.5 instead of becoming a provider 400. The ordinary safe path remains one approved board per independently edited shot. A continuous sequence uses adjacent first/last pairs with durations derived from the source shots and can buy one unfinished leg at a time. The separate `generate-native` route invokes Runway's `2026-06` multi-shot recipe for 3–5 real editorial cuts; it is clearly labelled less deterministic than per-shot rendering.

### An Encoder Probe Is a Subprocess
`resolveFfmpeg()` probed on **every call**, and each probe is a spawn: `FFMPEG_PATH`, then five `PATH` candidates that mostly do not exist, then the bundled binary — up to six subprocesses to answer a question whose answer cannot change while the process runs. Under load one of those probes fails, the resolver reports **no encoder**, and the caller silently falls back.

That is how duration measurement returned 0 in roughly one full-suite run in two while being perfect in isolation. Two wrong diagnoses came first and both are worth recording: the fixture was blamed (it builds real files, so it *looked* like contention), then `spawnSync` returning EAGAIN was blamed and a retry added. Neither was it. The failing spawn was the **probe**, several layers below the thing being measured.

Cached on the **available** answer only. An unavailable result is not cached: an operator who installs ffmpeg mid-session should not be told for the life of the process that there is no encoder.

### A Plate Can Be Refined, Not Only Rolled Again
A plate could only be regenerated wholesale from words, so *"the same street but wetter"* was a fresh roll of the dice on a picture that conditions every frame its subject appears in. `routes/locations.js` dispatched generate, import, views and compass, and nothing else.

**And this is the operation an edit-mode provider is actually for.** A new *view* had to drop every reference and be painted from words, because `/image-to-image` hands back a modified copy of what it is given and an edit cannot move the camera. A *refine* keeps the camera and changes one thing — precisely what that endpoint does well. The provider semantics that defeated the compass sweep are the ones that make refine the right tool, and it was the one never built.

The instruction **leads** and the subject is **not re-described**: the picture is attached and already carries the place, and saying it again in words pulls the result back toward a fresh generation, which is the entire difference between a refine and a regeneration. It **replaces** the plate for that view — two plates of one view is a subject with two current references and no way to tell which a shot used — and the confirmation says so, because the previous picture is gone.

### An Export That Will Not Import Is Not an Export
*"I got a file import failure in the import."* — Premiere, on a file this engine had just produced, for a project with two perfectly good clips.

The file was well-formed XML, had the right root element, listed both clips with correct durations and real paths that resolved on disk. Every existing check passed, because every existing check asserted on **content**. Two structural faults:

**Seven of the nine `<clipitem>`s had no `<file>` element at all.** They were shots with no footage yet, emitted as zero-length items. A clipitem without a file is not a clip, and Premiere rejects the **whole file** rather than skipping the item — so one unshot shot loses the entire export.

**The sequence never declared its own format.** Premiere builds the timeline's resolution, rate and pixel aspect from `<media><video><format><samplecharacteristics>`, and the block was absent, so there was nothing to build even had every clip been valid.

`shootableShots()` is the shared rule, and it is deliberately **per format** rather than uniform, because the formats differ in what they can express. **Zero duration** disqualifies everywhere: an item of no length is invalid in all three, and it is what every unshot shot becomes. **No media** disqualifies only in Premiere — xmeml has no gap element, while FCPXML has `<gap>`, which is the correct way to say *nothing here for four seconds* and preserves the timing of everything after it. Omitting is safe in xmeml precisely because each clip carries its own `<start>`.

And *"you told me nothing about assets"* is not *"there is nothing"*: an EDL authored from shot durations alone, with no media registered, is a real conform list handed to an assistant editor who has the footage elsewhere. So the media test applies only when assets were actually supplied.

**One fix was tried and reverted, and the revert is the point.** Skipping empty audio tracks looked tidy, and it broke the guarantee `AUDIO_LANES` exists for: Premiere XML once laid out three lanes where FCPXML laid out four, so every Premiere export silently dropped the ambient bed — nothing failed, the file opened, and the missing layer looked like a creative choice. A lane that is empty today is where the sound pass lands tomorrow. It was also a **guess**: the evidence pointed at the fileless clipitems and the missing format block, and nothing pointed at empty tracks. An established guarantee is not worth trading for a hunch.

### The Order the Film Plays In
Found by running the real project rather than by reading it. There were **three** running orders and they disagreed:

| | |
|---|---|
| `lib/timeline.js` | scene_number, then sort_order, then shot_code |
| `lib/conform.js` | **sort_order**, then scene_number, then shot_code |
| `routes/nle-export.js` | **sort_order**, then scene_number, then shot_code |

`sort_order` is **per scene** and resets to 0 for each one, so putting it first interleaves the scenes. On a real twelve-shot project:

```
playback : 1A 1B 1BA 1C 2A 2AA 2B 2C 3A 3B 3C 3D
conform  : 1A 1B 2A 3A 3B 3C 3D 2AA 1BA 2B 1C 2C   ← and all three NLE exports
```

So the master file and every NLE export were assembling the film **in a scrambled order** while playback showed it correctly. Nothing failed — the exports opened and played, in the wrong sequence, which is a defect only an editor finds and only after they have started cutting.

It also makes coverage unsound, which is how it surfaced: a run validated as consecutive in one order is not consecutive in the other, so `[1A, 1B, 2A]` was accepted on a project whose running order has 1BA and 1C between them.

`lib/running-order.js` is the one place that decides, and a film plays scene by scene, so **scene leads**. `shot_code` last is what makes an inserted shot land where a director expects — 2AA sorts between 2A and 2B by ordinary string comparison, which is precisely why inserts are additive rather than a renumber.

**Assembly, display, or generation order** — every surface that touches the shot list is one of the three, and the distinction is now written down rather than held in someone's head, which is how the third and fourth wrong orderings survived. **Assemblies** build the film: the timeline, the conform, the three exporters. **Displays** are what a director reads and expects to match it: the storyboard board, board grouping, the shot list. Both use the shared order. **Generation order** — the eight batch queries in video-gen, voice, music, post, lipsync and pipeline, and run-plan's strip ordering — is deliberately left alone: the order you generate in does not change the film, and rewriting them to no behavioural effect is churn that makes the next real divergence harder to spot in a diff.

The displays were fixed a round later than the assemblies, and the reason is worth keeping: the set handed over was *"surfaces that turn shots into a running film"*, and a board does not turn shots into anything. That is true and it is not the question a director is asking, which is *does the thing I am looking at match the thing I get*. `loadProjectShots` is exported so a test can read what the board is actually ordered by — a display whose order nothing can check is how this survived three rounds of fixing the assemblies beside it.

`orderBySql()` takes the **aliases** rather than assuming them. `conform.js` aliases shots `sh` and scenes `s`; `routes/nle-export.js` does the exact opposite. A fixed string plus a regex rewrite at the call site silently produced `s.scene_number` there — a column that does not exist, and a 500 on every export, caught by the integration suite one minute after it was written.

### Production Is One Graph (behind `production_graph`)
`design_handoff_production_graph/` replaces the eight production pages with one: shots, sequences, SFX/ambient/music and every generated version as nodes on a canvas, a 420px drawer for whichever is selected, and the cut playing underneath. **Off by default** (the `production_graph` setting, switched in Settings). With it off, Production is its eight pages exactly as before; with it on, every one of them is still reachable by address. The Score workspace stays in the menu either way, because a Music node opens it rather than replacing it.

**Every node is a view of rows that already exist.** `lib/production-graph.js` reads the shot and its frames, the sequence, the music cue and the assets a generation made, in one pass (`GET /projects/:id/production-graph`). Every paid action goes through the functions the old pages use (`regenerateStoryboard`, `refineFrame`, `generateSequence`, `confirmPaidImage`), so the graph cannot describe a generation differently from the board.

**A version is an asset, and "selected" is a pointer the player reads.** `film_shot_versions` looked like the home and holds no rows — only the render ledger writes it — so selecting through `/versions/:id/select` would have changed nothing on screen. A frame already had `current_frame_version`. A clip had nothing: playback took the best clip TYPE, so a second generation could not be chosen over the first. Migration 115 adds `film_shots.selected_video_asset_id` and `film_sequences.selected_video_asset_id`, read by the timeline and the conform before their type ranking; a cue's pointer is the `generated_asset_id` it always had. Selecting a **sequence** clip records its coverage (`lib/clip-coverage.js`) — the one mechanism the timeline, the conform and the NLE exports already honour — so it plays once across its members.

**Versions had to be kept to be chosen.** A shot's clip was always written to `{code}.mp4` and a cue's sound to one name per cue, so every regeneration overwrote the file while the rows counted "three versions". The first clip keeps its old name; later ones are `_v2`, `_v3`. A new clip becomes the selected one, as a new frame does. `video/generate` also takes `prompt_override`, so the drawer's edited prompt is the one sent.

**Joins and linked frames.** A sequence's `joins_json` holds one `{ type, prompt }` per adjacent pair — `cut`, `continuous`, `dissolve`, `match_cut`, `whip_pan`, `morph`. **A cut generates nothing**; every other join is one clip, with its type and its words in the request; no joins plans byte-identically to before. `start_frame_ref` / `end_frame_ref` borrow a frame from another sequence (`shot_image` or `video_last_frame`), resolved at **generate** time to the source's *selected* version and travelling as a keyframe, never as membership; `link_fingerprint` records what it resolved to, so a changed source marks the receiver stale. **A shot belongs to one sequence**: a second claim is refused `SHOT_IN_SEQUENCE` unless `move: true`.

**Layout.** Placed automatically from the shot list — one group per sequence, versions right of their parent, sound under it. A node a person drags is pinned in `production_node_layout`; Tidy forgets only the unpinned rows.

Served at `GET /projects/:id/production-graph`, `PUT …/layout`, `POST …/tidy`, `POST|DELETE /shots/:id/video/select`, `POST|DELETE /sequences/:id/video/select`, `POST|DELETE /music-cues/:id/select`, and `GET /music-cues/:id/generate` (the cue's free preview). `tests/production-graph.test.js` drives it through a spawned server, because the dispatch order is part of what breaks.

### One Clip, Several Shots
*"I generated a video that includes 1A-B-C… when playing a video in playback it should be playing the entire video, not a few seconds and then switch to the next image. And if I option select which other shots are part of the video, it shouldn't play any of the images that are part of the video."*

Three faults, one cause each.

**A clip plays for the length its card asked for.** `shotDuration()` read `shot.duration_ms` — the *card's* number, an intention written before anything existed — and fell back to `DEFAULT_SHOT_MS = 4000`, never asking the file. So a ten-second upload was held for four seconds and playback cut to the next still mid-shot. That was true of **every** uploaded clip, not only multi-shot ones. The measured length now wins; a still-only shot keeps the card's duration, because there is nothing measured to prefer and a still has no opinion about how long it is held. Length is measured **at import** and stored, since the timeline repaints on every scrub and a subprocess in that loop is not a fix. A clip that will not probe falls back silently: it is still a clip the director paid for.

**An asset belonged to exactly one shot.** `film_clip_coverage` (migration 084) is a join table rather than a JSON column: *is this shot covered* becomes an indexed lookup instead of a scan over every asset, the cascades do the right thing without cleanup code anyone has to remember, and a unique index on `shot_id` makes two clips claiming one shot impossible — that would be a timeline with no answer to *what plays here*, and the failure would be silent, since whichever row came back first would win.

**Coverage is validated in canonical running order, not submitted order.** A caller listing `1C, 1A, 1B` describes a perfectly good run; `1A, 1C` does not, however it is sorted. Gaps, duplicates, cross-project ids and a coverage excluding the clip's own shot are all **refused rather than repaired** — a caller whose list is wrong has a different model of the clip than we do, and quietly fixing it hides that until the film is cut.

**The measured length reaches every assembly, not only a covered lead.** Found by exporting the director's own project to Premiere and reading the file: 1A came out 530 frames and 2A came out **zero**, with a ten-second clip on it. 1A was right only because it *had* coverage — `foldShots` moved the measured duration onto a covered lead and nothing moved it onto anything else. So an ordinary uploaded clip exported as a zero-length item: present in the XML, invisible on the timeline, and every later cut wrong. `buildTimeline` had been fixed and the three exporters plus the conform still read `shot.duration_ms`, which is **0 on every real shot** because nothing writes it — the same playback-is-right-while-Premiere-is-wrong split the running order already cost a round. `measuredDurations()` is one query read by all of them, and it ranks `video_final > video_synced > video_raw` so a graded shot is never measured from its raw clip.

**Five surfaces, one fold.** `buildTimeline`, `planConform` and the three NLE exporters each walk the shots independently, so fixing the visible one leaves the others wrong in ways nobody sees until delivery: playback would be right while the conform *refuses to build a master* — reporting 1B and 1C as missing footage the director is told to generate and already has — and Premiere receives a three-second film with two gaps. `foldShots` is the one place that decides, and it does **two** things: drops the covered shots *and* moves the clip's measured duration onto the lead. Dropping without moving the duration is a worse bug than the original, because a nine-second clip laid into a three-second slot pulls every cut after it six seconds early, and that is invisible until someone watches the whole thing. The three NLE formats fold **once** in the route rather than three times inside the generators: a fix applied to two of three means two formats agree with the film and the third does not, and only the editor who opened that one ever finds out.

**Nothing blocking stands between the file and the upload.** The coverage question was first asked with a native `prompt()` *before* the file was sent, and cancelling it abandoned the upload with nothing said — so pressing Escape on an unexpected dialog silently discarded the clip, and the reported symptom was *"when I play the playback it doesn't include the video"* for a file that had never reached the server. A native modal also cannot be seen in a screenshot, so the page merely appears to have stopped; the browser check hung on it twice before the cause was obvious.

The question is asked **afterwards**, on the shot card, against a clip that is already stored — a better shape regardless, since a director who has watched the clip back knows what is in it better than one who has not yet seen it upload. `PUT /film/assets/:id/coverage` sets or clears it, with the same validation, so the late path cannot accept what the early one refuses.

The test that catches this **follows one call level and strips comments first**, both learned in the doing: the first version read only the runner's own body and passed while the bug was live, because the `prompt()` was inside `askClipCoverage()`; the second matched the word inside the comment explaining the removal; and an unbounded walk followed the refresh callback into every button those functions *render*, since an `onclick` string looks exactly like a call, and reported a `confirm()` on an unrelated delete as a gate on the upload.

A refused coverage is reported **alongside a successful upload**, never instead of it — the file is already on its shot and failing the whole request would lose an upload the director just waited to send. The picker offers only the shots that consecutively **follow**, because offering shots the server would then reject is how a picker teaches people to distrust it.

Served on the upload control, at `POST …/media/video/import` with `covers`, and through `media_upload`.

### Every Join Was Silent

`stitchClips` decided whether a clip carried audio with

```
/Stream\s+#\d+:\d+(?:\([^)]*\))?:\s+Audio:/i
```

and this ffmpeg prints `Stream #0:0[0x1](und): Audio:`. The `[0x1]` is not
optional-parenthesis and not a colon, so the pattern matched **nothing on any
real file**. `hasAudio` was false for every clip ever joined, and
`buildConcatArgs` — doing exactly what it was told — synthesised `anullsrc`
silence for all of them.

**Measured: two clips carrying a 440Hz tone at −21.2 dB joined to a file at
−91 dB, which is digital silence.** Every sequence stitch and every whole-film
conform has been dropping its audio.

**Nothing failed.** The output plays, and it has a perfectly good audio stream —
the synthesised one — so every check that asks *is there audio* passes. That is
why it survived: the only honest test is **measuring the volume**, and the
`AUDIO_LANES` note above records the same shape of loss one layer up, where a
missing lane read as a creative choice.

Found while building `inspectMedia` for RBF-005, by copying that pattern into a
new reader and having a test assert against a real audio file. It is now one
reader: `stitchClips` and `measureDurationMs` both consult `inspectMedia`, which
matches anything between the stream index and the kind, and the regression is
pinned by **volume**, never by the presence of a stream.

The same reader also refuses **attached pictures**. An audio file with cover art
carries `Video: mjpeg ... 300x300 ... 90k tbr (attached pic)` — a raster *and* a
rate — so a guard requiring one or the other accepts it: measured, an audio file
reported a 300×300 raster at 90000fps. A mutation surviving is what exposed
that; the first fixture had no video stream at all, so the guard it was written
for was never exercised.

### One File
*"Wire the stitcher so I get one file."*

A sequence produced N−1 clips and told the director to join them in an NLE, which makes the last step of the pipeline happen outside the pipeline. **The blocker was never the code**: `lib/conform.js` has had a working concat since it was written, and there was no encoder on the machine — no ffmpeg on `PATH`, none in `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` or `/usr/bin`, and no Homebrew to install one. So `availableExecutors()` correctly reported nothing and `runConform` correctly refused, which is why this was deferred rather than shipped as a button that always fails.

**`ffmpeg-static` is a deliberate exception to [ADR-002](docs/adr/002-vanilla-http-no-framework.md).** That decision is "one dependency, no framework", and its reasoning is about not pulling a large *abstraction* over something the standard library already does. This is not that: Node genuinely cannot mux MP4. Joining clips from different generators means rebuilding `moov`/`stbl` sample tables, and a hand-rolled muxer that is subtly wrong writes files that play in QuickTime and fail in the NLE — the worst failure available for a delivery step, because it is discovered last. The alternative was making the pipeline's final output conditional on a system tool installed outside it.

It is the **floor, not the default**: `FFMPEG_PATH` → the system `PATH` (including the package-manager directories a server process's `PATH` usually omits) → the bundled binary. An install that already has ffmpeg keeps the build its operator chose. Missing entirely stays a legitimate answer and carries the remedy, because *"no executor"* is not something a director can act on.

**One concat, two callers.** `buildConcatArgs` in `lib/ffmpeg.js` is shared by the sequence stitch and the whole-film conform; two concat filters is how one of them acquires the `pix_fmt` fix and the other does not, and the one that misses it plays everywhere except the NLE that matters. What stays in `conform.js` is the clip *selection*, which is a statement about the film rather than about encoding. `availableExecutors()` now asks the shared resolver too — it ran its own `execFileSync('ffmpeg')` and so could only ever see one of the three places an encoder lives, meaning an install with `FFMPEG_PATH` set would be told nothing was available while the stitch beside it worked.

Two refusals carry it, and both are the same rule. An **incomplete** sequence is refused with the missing segments **named**, because joining what is there produces a shorter film that plays perfectly — the failure nobody notices until they watch all of it. And joining twice **replaces** rather than accumulating: a folder of near-identical masters is how the wrong one gets delivered.

The tests **produce a file and read it back** — build two clips of different lengths, join them, decode the result, and check the duration is the sum. Asserting the argument array is the same mistake as asserting a serving URL is non-null: arguments that look right and produce an unplayable file pass every string check there is. Writing that found a real defect the same day: the route read `film_projects.frame_rate`, a column that does not exist, so every join silently fell back to 24fps and a 25fps production would have been conformed at the wrong rate.

Served at `POST /film/sequences/:id/stitch`, on the Sequences card, and as `sequence_stitch` (**151 tools**). It is **free** and says so, because every other button on that card spends money.

### Footage and Sound From Outside
*"Are we able to upload videos if we generate outside... we need to be able to easily add assets from external sources if we want to."*

Every media file in this pipeline could only be born inside it — a clip cut in Runway or Kling, dialogue recorded properly, a licensed music bed all had to be re-made here or not used. The set is **derived from `MEDIA_KINDS`**: the eight orchestrated capabilities that produce a file, minus `image`, which arrives as the storyboard frame. Seven targets.

**The storage registry existed three times before it could be derived from once.** `PERSIST_EXT` and `ASSET_TYPE` in `routes/pipeline.js` and `SUBDIR`/`serveDir` in `lib/capability-payloads.js` each said where a generated file goes — and the comment above `ASSET_TYPE` already recorded the cost of a mismatch: a value the CHECK refuses turns a successful, paid-for generation into a failed step. `lib/media-kinds.js` states it once, and `scope` is not stated at all — it is read from `PIPELINE_STEPS`, so an importer cannot decide that a scene-wide music bed belongs to one shot. Posting one at a shot is **refused with where it should have gone**, because attaching a whole scene's score to a single shot reads as working.

**One route, not five.** `POST /film/{shots,scenes}/:id/media/:capability/import` covers all seven. An import endpoint bolted onto each of video-gen, voice, lipsync, music-gen and post-production is how four of them get the format sniffing and the fifth silently accepts anything.

**The bytes decide, never the name.** A renamed file passes any extension check, and a clip that cannot be decoded is a shot that plays black in the cut with no error anywhere, because nothing opens it until an editor does. Video is MP4/MOV/WebM/MKV by container magic; audio is WAV/MP3/M4A/FLAC/OGG. An MP4 brand of `mp42` or `isom` is **video** and is refused as audio — an earlier version accepted it, which would have attached a silent video file as a music bed. The stored extension follows the bytes too: a `.mov` whose contents are `isom` is stored as `.mp4`.

**An oversize upload now says 413.** `readBody` destroyed the request and *then* tried to write a 400 — and a destroyed request surfaces in the browser as a network error, which `api()` maps to *"Backend offline"*. So an upload that was merely too big was indistinguishable from a dead server, on the one feature where large files are the norm. It answers first and hangs up second, states the limit, and says why 150MB of upload is about 112MB of file. That ceiling is the base64 inflation and is **named rather than discovered**: raw binary upload would remove it, and `readBody` accumulates into a string, so that is separate work.

**The serving URL had to be fetched to be believed.** It was built from `serveDir` — which is what `persistProviderMedia` calls the *gateway's* directory (`videos`) — while the HTTP route is `/film/video/`, singular. A perfectly good string and a 404: the upload succeeds and the clip will not play. Asserting the URL was non-null would have passed, so the test resolves it to a path on disk. Same mistake `servedUrlFor` made once already.

Uploaded media is **not fingerprinted** and is recorded `license_source: 'external'` with rights `unknown` — a generated file's rights are known and a supplied one's are not, and delivery is the wrong moment to find that out. Served at `GET /film/media-kinds`, and as `media_upload` / `media_kinds` (**144 tools**).

### A Refused Import Has to Say Which File and Why
Two GLB imports "never showed". The importer is sound — a 4.4MB Meshy GLB round-trips through the real browser path, lands in `film_assets` and lists — so what was met was a **refusal nobody saw**: one line on the status bar at the bottom of the screen, and then the file input was cleared. Indistinguishable from nothing having happened, which is precisely how it was reported.

The reason was also useless. `parseGlb` ignored `extensionsRequired`, and glTF's contract is that it may not be: a Draco-compressed file keeps its `POSITION` accessor as a stub with no `bufferView`, so reading on regardless died three functions later on *"accessor has no bufferView"* — true, unactionable, and identical to what a corrupt file produces. Required extensions are now refused **by name with the remedy** (Draco and meshopt are export switches you turn off; anything else is a file previs cannot read), and the import layer carries that reason out instead of flattening every cause into `invalid GLB`.

The refusal is rendered **on the page**, and stays until it is read or another import is tried — the same rule the markup toolbar and the regenerate spinner already follow: feedback belongs on the thing you touched. A successful import clears a stale banner, or the warning outlives the problem.

### An Anchor Covers Where a Subject Stands, Not Who They Are
Anchoring drops a subject's plate when the anchor's card names them, on the reasoning that the frame already shows them. That is true of **placement** and false of **identity** the moment the anchor does not show a face.

2A has MAYA with her back to camera. It carries her position, her wardrobe colour and the light, and not one pixel of what she looks like — so a close-up reaction built on it had nothing to go on, and three attempts each came back as a different woman.

Two things follow, and both are needed. A director can force a plate through explicitly with `keep_plates` (📌 beside each subject in the Blocking panel) — *anchor the scene, and pin the subjects too*. And a **close-up keeps its character plates automatically**: `IDENTITY_FRAMINGS` is close-up, extreme-close-up, over-the-shoulder and insert, because those framings are nothing *but* the subject, and leaving it to be remembered means the next close-up fails the same way. It stays deliberately narrow — a wide genuinely is covered, and forcing plates there spends reference slots on subjects the anchor shows perfectly well.

Threaded through **all three** places coverage is computed — the shared payload path, the plate gatherer and the per-shot regenerate — because an override honoured by two of them is worse than none: the prompt would shorten a subject to a name while the picture that gives the name meaning was dropped, which is precisely the state the contract-shortening revert exists to prevent.

On the shot that reported it, 2AA went from `[2A]` to `[2A, MAYA]` with her full 817-character appearance surviving.

### Playback Opens on the Shot You Were On
`loadPlayback` set `pb.index = 0` unconditionally, so watching the shot you had just spent an hour on meant scrubbing past everything before it — every time, on a board that only gets longer.

Nothing on the board recorded which shot a director was working on, which is why the page had nothing better to start from: the frame viewer tracks its own index, the Direct modal knows its own shot, and neither left a mark anyone else could read. `markCurrentShot()` is that one mark, dropped by every action that means *"I am on this shot now"* — opening a frame, stepping through the viewer, directing, generating — because a mark left by some of them and not others gives playback a stale answer, which is worse than always starting at the top: right often enough to be trusted, wrong without saying so.

An unknown or missing mark falls back to the first shot **explicitly**, since a mark can name a shot the timeline does not contain — deleted, or in a scene with nothing cut — and starting nowhere is worse than starting at the top. There is also a ▶ on each frame card, because the mark is a convenience and *"start here"* is an instruction.

The first version looked up `pb.items`, which is always `undefined` — the timeline returns **`entries`** — so it silently returned 0 every time and the fix did nothing. The test now pins the shape, and the resolver was run against the real timeline: selecting 2B opens at index 5, 2AA at 4, 3B at 8.

### A Warning You Cannot Clear Is Worse Than No Warning
Two banners sat on a real board permanently: *"the screenplay moved on without 11 shots"* and eleven items to regenerate. Every shot carried a fingerprint that **matched** its scene's stored one, and the report said they were all behind anyway.

`sceneFingerprint` was widened to include dialogue — correctly, since rewriting a character's lines used to change nothing the report could see. Everything stamped before that carries the pre-dialogue hash. `stampScene` already recognised the case and re-baselined the **scene** silently, and two things were left behind: `drift()` compared against the **new** formula while the shots still held the **old** one, and `stampShot` writes the scene's stored value — so re-stamping wrote the old hash straight back and the warning could not be cleared by doing the work it asked for.

Permanently on, pointing at work that is fine. Acting on it means redoing eleven cards for nothing; learning to ignore it means ignoring the real thing when it happens.

`matchesScene()` is the one rule now: a stamp is current if it matches the scene as it stands under **either** formula. That is not an amnesty — a genuinely rewritten scene changes both hashes, since both cover the description, so a stale stamp still matches neither. The single case it forgives is a scene where only the **dialogue** changed and whose shots predate the widening: those shots were stamped by a formula that could not see dialogue, so reporting them asks a director to act on a distinction the data cannot make. And `stampScene`'s re-baseline now **carries the shots with it**, so the next screenplay save cannot recreate the mismatch.

On the project that reported it: 3 scenes and 11 shots behind became **0**, and the impact report went from 11 redo / 7 waiting to 6 redo / 0 waiting — six real keyframes whose cards genuinely moved.

### A Refine Previews What a REFINE Sends
The pre-spend confirmation was added for every paid path, and for refine it showed the **wrong thing**: it called the regeneration preview, so a director about to refine saw a ~3,800-character prompt and a list of five plates that a refine does not send.

A refine carries the **picture plus one instruction** — no scene card, no subject descriptions, no style preset, because the picture already holds all of that and repeating it in words pulls the result back toward a fresh generation. On a real shot the difference is **165 characters and one picture** against 3,864 characters and five. A dialog whose entire purpose is *"see what will be sent"* being confidently wrong is worse than not having one.

`buildRefinePayload` is now the single place that text exists, and `GET /shots/:id/storyboard/refine-preview` returns exactly what would go — free. The test asserts the phrase appears **nowhere outside** the builder, because one occurrence inside a two-branch function is correct and a stray copy elsewhere is how a preview becomes a plausible fiction.

Refine also takes a **version** from the page now. The route always accepted one and the button never sent it, so reaching an earlier attempt meant selecting it first — which works, and changes what the whole board shows as a side effect of wanting to try something. Each row in the version list carries its own Refine.

### A Missing Anchor Is the Loudest Thing on the Confirm
Wingfall 2B v19 came back with the road in the wrong place and the car parked where no kerb was, and the cause was not the prompt: it generated with **no anchor at all**. The street was built from words and a location plate, neither of which says where the driveway is in *this* cul-de-sac.

The anchor had been put down. The anchor button is a **toggle** — pressing it on the shot that is already the anchor clears it, which is correct behaviour and one accidental click away — and nothing between that click and a generation mentioned it. A missing plate among five is hard to spot; a missing anchor changes the whole street.

So the confirmation leads with **Continuity**: either *"Built from 2A — its location, dressing and subject placement, re-shot on this shot's own lens and angle"*, or a warning that the location may not match the rest of the scene, with the fix stated (cancel, press the anchor on the frame whose staging you want, generate again). An observation a director cannot act on is not worth the line.

### Inserting a Shot: 2AA, Not a Renumber
A director adding a reaction shot after 2A wants it to come **next**. The tidy answer is to call it 2B and shift 2B→2C, 2C→2D, and that is what a clean-slate tool would do.

Production does not do it, and the reason applies here **literally rather than by analogy**. On a set the existing codes are already on the slate, the call sheet, the continuity notes and the editor's bins. In this app they are also **filenames** — `2B.png`, `2B_v11.png`, with thirteen places deriving a path from the code — rows in the render ledger, and the word a director has been using for that shot all day. A renumber means moving every file every renamed shot ever generated, and a half-applied rename orphans frames on a shot nobody touched.

So an insert is **additive**: after 2A comes **2AA**, exactly as a script supervisor numbers one, and nothing else changes. A second insert after the same shot walks the suffix to 2AB, so repeated inserts stay in the order they were made.

**What does move is `sort_order`.** Order is the thing that actually changed; the codes deliberately did not. An insert that left the running order alone would just be a shot appended with a confusing name.

The renumbering path was built first, complete with back-to-front renaming and file moves that rolled back on failure, and then deleted — the convention removes the need for all of it, which is the strongest argument for the convention.

### Nothing Generates Before You Have Seen What Is Sent
Wingfall 2B took an afternoon of purchases, and every cause was visible in the assembled prompt before a credit was spent: a camera note contradicted by a staging line, a subject description overriding the anchor, and plates dropped for want of a slot. `GET /shots/:id/prompt` costs nothing and shows all of it — and it had no control on the page, so the only way to learn what a shot would send was to generate it and study the picture.

Every paid path now goes through **one** confirmation. Not a button you remember to press: the check that matters is the one you cannot skip by accident.

**It names the pictures.** That is the half that kept being missed — a prompt reads perfectly while the plate that would have made the car a 1970s sedan was silently dropped, so the words look right and the frame comes back wrong. A shot sending **no** references says so loudly rather than showing an empty list, because that is the case most worth warning on.

**And it flags language that draws what it excludes.** `lib/prompt-lint.js` catches the phrases a screenplay uses and an image model cannot honour — *off frame*, *behind camera*, *we never see*, *past camera*, plain negatives. 2B's card contained **five**: it described the struck house in detail and said it was *"just off frame"*, and every attempt drew that house in frame; it said *"We never see its face"* and an attempt drew the face. Nothing was broken — the prompt was asking for them, because a diffusion model draws what you NAME and negation is the least reliable instruction it takes.

Matched as whole phrases, never single words: *past* and *never* appear in ordinary description constantly, and a check that fires on those is switched off within a day and then protects nothing — the same asymmetry the style-preset check is built around. It **warns, never blocks**, and names the offending phrase with what to write instead.

A preview that cannot be read does **not** block a generation the director has already decided on; it says so and lets them choose, because failing closed on a diagnostic would make the diagnostic the problem.

### Camera Mode Belongs on the Board
It was built, tested against the shot it was designed for, and then **removed from the page** during the simplification — leaving the single best tool for *"put the camera on the other side of the street"* reachable only from an agent host. A capability with no control is indistinguishable from one that does not exist.

It is back as a **directing choice** rather than a dial on a control panel, which is what it was the first time: *are you directing the action, or the camera?* Camera mode is disabled with an explanation when no anchor is set, said **where the choice is made** — meeting a 409 after filling in a form is worse than being told while deciding.

### Every Surface Paints the Version You Selected
Selecting a version moves `current_frame_version` and copies that picture to the live file. Every surface that paints a frame still asked for `ORDER BY version DESC LIMIT 1` — the **highest** version — and keyed its image URL to that number. So after selecting v13 of 17 the picture on disk was v13 and the page requested `?v=17`, which the browser already had cached from when v17 *was* current: it served the frame you had just moved away from.

Silent, and indistinguishable from selecting not working — reported twice from use before it was found.

The board and previs now resolve the shot's **pointer** and key the URL to it. The check is **function-aware** rather than pattern-based: `archiveExistingFrame` and `registerStoryboardAsset` ask the same SQL question and are exempt by name, because for them "the newest" genuinely is the question — an exemption matching on text would quietly excuse the next surface that gets it wrong.

### How Many Plates Fit Is the Provider's Answer
`MAX_REFERENCES = 3` was a single constant applied to every provider, and it is **Runway's** documented limit for `gen4_image`. Meshy accepts **five**; OpenAI's edits endpoint accepts many more. So a shot naming two characters, a location, a car and a bag silently dropped the last two plates before the request was built — whichever provider was actually running.

On Wingfall 2B that is exactly what happened: DRAGON, MAYA and SUBURBAN STREET took the three slots, and the SEDAN's plate and the grocery bag's plate were discarded. The car came back a modern saloon and the bag came back generic — **not because conditioning failed, but because their pictures were never sent**. Reported from use as "none of the plates influenced the image", which was true of two of them and the most misleading possible symptom, since the three that *did* attach made it look like conditioning was simply weak.

Same defect the prompt ceiling already had, one level over: *"the strictest of the providers wired here"* frozen as though it were a fact about the world. Each adapter now declares `maxReferenceImages` with its reason — runway 3 (documented), meshy 5 (documented), openai 8 (the endpoint takes 16; held lower because each reference is inlined as a multi-megabyte data URI), gridlight 3 (a swappable local agent, held strict rather than guessed upward). An adapter that declares nothing falls back to the strict default, **never** to unlimited: over-sending produces a rejection at the provider, which is worse than trimming here where it can be reported.

The clamp mattered as much as the constant. `Math.min(opts.limit || MAX_REFERENCES, MAX_REFERENCES)` meant a caller passing a higher limit got three anyway — a ceiling that cannot be raised is a constant with extra steps. `providerReferenceSupport` now carries the number alongside `canAttach` and `canTag`, so the shared payload path and the per-route paths cannot disagree about how many plates fit.

Ranking is untouched: with limited room, identity still outranks place and place outranks objects.

### Sending a Frame to Another Shot
*"There is a shot I'd like to put to 2A from 2B."* Generation is a coin flip you already paid for, and the picture that came back on one shot is sometimes the right shot for another. The only route there was to regenerate the target and hope — paying a second time for a frame already sitting on the board.

`POST /shots/:id/frames/:version/send` is a **copy**, in all three senses that matter. The **source keeps every version it had**: moving the file would take the picture off the shot that generated it, a destructive verb hiding inside a helpful one. The **target gains a version** rather than overwriting — on the receiving side this genuinely is a new attempt, and whatever the target was showing has to survive, or a send destroys work in the one direction nobody is watching. And the **file is duplicated, never shared**: two rows on one path means deleting or regenerating either shot breaks the other, and the damage surfaces on the shot nobody touched.

It archives **twice** for one write — the target's outgoing frame, then the arriving one, which is the live file and its own version at the same moment and would otherwise be overwritten before anything kept a copy. That is what moved `tests/storyboard-annotation.test.js` from comparing two totals to checking **per function** that nothing writes the live frame without archiving; equal totals was always a proxy for that.

Refused across projects (a different project is a different film, and the asset would land where nothing expects it), refused to the shot it is already on, refused for a version whose own picture was never kept aside, and refused by the **board lock** — a send lands a picture on a board, which is exactly what a lock protects.

The target records `sent_from`, because a frame on 2A generated from 2B's card is not stale and not wrong — it is **borrowed**, and a director looking at it later needs to know that without reconstructing it. The response says so too, as a `caution` rather than an error.

### Refining Against a Scene the Frame Cannot See
Refine sent exactly **one** picture — the frame being changed — so *"make the street match 1A"* was unsayable: the only thing the model could look at was the shot being refined. The anchor existed and every other generation path used it; refine was the one that could not.

`use_anchor` attaches it as a **second** reference, and the prompt names each picture by its **job**: the first is the frame to keep, the second is the scene to match *for continuity only* — same location, dressing, time of day and grade, explicitly **not** its composition or camera angle. Two pictures with no jobs named is worse than one, because the model cannot tell which it is supposed to be reproducing.

**Off by default, and that is the whole safety argument.** Refine's contract is *keep this picture, change one thing*, enforced by a negative that refuses a different composition — a second image arriving uninvited is exactly what pulls a refine back toward a fresh generation. Asking to match an anchor that does not exist is **refused** (`NO_ANCHOR`) rather than succeeding silently, and the response names what it matched against, because *"matched against 1A"* and *"matched against nothing"* produce different pictures and look identical afterwards.

### A Version Is a Generation; Which One Shows Is a Pointer
Selecting an earlier frame created a **new highest version** — v3 chosen became v6 — on the reasoning that history must never be destroyed. The history was safe and the **count became a lie**: five generations plus one selection read as six attempts, and *"which am I on"* stopped having an answer. `shows_version` was added to explain the confusing number, which is a label apologising for a model rather than fixing it.

Versions are the **generations**: immutable, countable, one per image paid for. Which one is on the board is `film_shots.current_frame_version` (migration 079), and moving a pointer creates nothing. Select v3 and the board shows v3, the count stays at five, and every attempt survives.

**NULL means "the highest"**, which is what a freshly generated shot shows and what every shot showed before selection existed — so there is no backfill and nothing changes for a shot nobody has selected on. A new generation **clears** the pointer rather than setting it to the new number, so one rule covers both cases and there is no second place for them to disagree.

Two details are load-bearing. The live frame is still **written**, because every consumer — board, viewer, previs, the video pass — reads `{code}.png`; what is not written is a *row*. And the outgoing picture is **archived first**, since a freshly generated frame lives only at `{code}.png` until something copies it aside — switching away without archiving would lose the newest attempt, which is the one thing this list exists to prevent.

A version whose row still names the **live file** is refused. Its own picture was never kept, so `existsSync` says yes and a copy would silently write the current frame onto itself and report success — `listShotFrames` already calls these `overwritten` and hides Restore, and the route now agrees rather than accepting what the UI knows is impossible.

### Locking a Board
A storyboard is finished work. Every frame on it was paid for, judged and kept — and every one sits behind a Regen button that costs money and **replaces** the picture. Nothing distinguished *"this is a draft"* from *"this is the shot"*, so the only protection was remembering.

`film_projects.board_locked_at` (migration 078) is that distinction, made explicit and reversible. **NULL means unlocked**, which is what every existing project is: a feature that retroactively froze work nobody chose to freeze would be switched off the day it shipped. A timestamp rather than a boolean, because *when did we call this done* is the useful half of the answer.

**One helper, five paths.** `boardLocked()` guards `generateStoryboard`, `generateStoryboardStream`, `regenerateShot`, `refineShot` **and** `restoreShotFrame` — derived from the call sites of `registerStoryboardAsset` rather than listed, because a lock that catches Regen and misses "Generate All" teaches a director the board is safe and then lets one button replace all of it. Restore is included even though it is free and forward-only: it changes which picture the shot *shows*, which is exactly what a lock exists to hold still.

**It protects the pictures, not the planning.** Editing a card, previewing a prompt and reading the board stay free — otherwise "done" means "frozen" and a director stops locking anything. `getStoryboard` is deliberately unguarded, and a test asserts the free prompt preview is too. The refusal is **HTTP 423** with `BOARD_LOCKED`, names the unlock, and takes `ignore_lock` for the one frame on a finished board that genuinely needs redoing — a refusal you cannot get past is a reason never to lock at all.

### Directing a Shot Is a Creative Act, Not a Control Panel
The first version of this surface exposed every parameter the route accepts — seed, ledger mode, negative prompt, style override, prompt override, and a character-budget chart. All of that is the **machinery**. A director looking at a frame that came back wrong does not want to tune a sampler; they want to say who is in the shot, where the camera is, and what else should be true. The complexity actively worked against the thing it was built for.

The surface is now exactly the work:

| | |
|---|---|
| **description** | what the SCREENPLAY says. Nothing else. |
| **anchor** | keep the previous shot as reference (unchanged) |
| **Direct** | *Blocking* — who and what is in it, plus a direction box; then *Cinematography* — where the camera is |
| **refine / regen / version** | keep a frame and change one thing; make it again; which attempt am I looking at |

**`description` is the writing and `direction` is what a director adds on top** (migration-free, validated in the scene-card schema, capped at 2000). They are two fields rather than one blended string because a screenplay revision must be able to replace **its own half** without discarding the direction — and because a board showing a composed description is showing a paraphrase of the film. The screenplay **leads** in the prompt; the direction follows, because it modifies what is already there. The modal never sends `description` at all: the route merges, so the writing survives untouched, and changing what a shot IS means revising the script.

**Blocking became a picker over what the project has.** Two free-text boxes meant typing `Maya` where the project says `MAYA` silently invented a subject with no plate, no size and no locked profile — the card stores any string. Choosing from the project's own cast makes that unsayable, and the list shows the fact that actually decides a frame: **which subjects have no plate**, and will therefore be invented fresh in every shot they appear in.

**Every camera facet the schema validates has a control** — all **8**, derived from `card.camera.*` rather than the 4 the first version happened to offer — and each states what it would inherit if left blank (`↳ mood board: 40mm anamorphic`). A blank field that silently inherits is indistinguishable from one that reaches nothing, which is exactly how the mood board's specs sat validated and consumed by nobody.

**Previs was painting the browser's cache.** A regeneration overwrites the file at a fixed name, so the URL never changes; the board learned to bust this with `?v=asset_version` and previs did not, so the stage kept showing the frame you had just replaced — which reads as previs being broken rather than as a cache. The version is now stamped into `src` **server-side**, because three surfaces paint this and only two of them remembered.

**And directing in previs writes back.** `applyBlockingToCard` wrote six camera facets and nothing else, so a director who stood MAYA and the DRAGON on the stage had blocked the shot and the card did not know. Named staged subjects now **union** into the card's characters and props — union rather than replace, since a director may have named a subject they have not placed yet, and applying an angle must never delete part of the blocking.

`tests/direct-shot-ui.test.js` is set-based over three registries — `KIND_RANK` for what can be blocked, the schema's own `card.camera.*` for cinematography, and `SPEC_KINDS` for what an unset facet inherits — and it asserts the machinery is **absent**, not merely collapsed behind a disclosure.

### Blocking a Shot and Directing It Are Two Jobs
*"There is blocking the shot with the characters, location and the props… and then there is directing the shot (camera selections, angles, movement). I should be able to do this on both the storyboard and the previs."*

Neither surface did both. The storyboard card editor offered **four** directing fields — framing, lens, movement, lighting — and **no blocking fields at all**, so there was no way to say who was in a shot; the card's `characters` and `props` could only be written by whoever created it. Previs had the whole camera and staged **one anonymous 1.7m figure at the origin** regardless of who the card named, so a two-hander opened as a single nameless proxy.

**And previs blocking never left previs.** `applyBlockingToCard` writes six things back and all six are camera; `previsPromptParts` emitted framing, focal length, angle, movement and distance — every one a fact about the *camera*. So a director could put the dragon in the near foreground with its back to us and MAYA across the road facing camera, and the image prompt said nothing about where either of them was. Previs was a camera calculator wearing the name of a blocking tool, which is the real reason a shot like 2B took twelve attempts: a *blocking* problem being solved with *directing* tools, on a surface that had neither.

`lib/shot-staging.js` closes it. Positions become phrases from **this** camera — *"DRAGON in the near foreground at frame left, with its back to camera; MAYA in the mid-ground at frame right, facing camera"* — so the same blocking read from a new angle says something different, which is the point. Depth is measured against the framing subject's distance rather than in metres, because three metres is the foreground of a close-up and the background of a landscape.

Three decisions carry it. **Only NAMED objects speak**: an unnamed staged object is scaffolding — a proxy wall, a mark on the floor — and describing it would put a literal box in the frame, so the rule is the one markup already follows (geometry says *where*, never *what*), and unnamed objects are **reported** as unsaid rather than dropped silently. **The basis comes from `previs-pick`**, the same function the renderer projects with: recomputing it here would be four lines and one sign, and a mirrored `right` vector produces perfectly fluent prose describing the opposite of what the director staged. And it **never throws** — an unknown sensor falls back rather than taking a paid generation down with it, the rule `stampAsset` already documents.

Staging ranks with the **shot**, protected, below the written direction and above the camera: where a subject stands is what the frame *is*, not decoration on it. It is naturally short — bounded by the number of named objects — so it cannot do to the budget what an unbounded field did once already.

**Location is the third thing a shot is blocked with, and the only one that is not a shot field.** It is the scene HEADING, so every shot in a scene inherits it — which is the sole reason one location plate means the same street in all of them. It is shown in the blocking panel with its source named, and reachable, but deliberately **not** an input: two shots in one scene claiming different places is precisely the drift the plate exists to prevent.

`from-card` now seeds the real cast by name, with heights from the subject-scale columns where they exist and the default where they do not (an invented size is indistinguishable from a declared one). The storyboard editor and previs build their controls from **one** `blockingPanel()` / `directingPanel()` each, on the precedent `markupToolbar()` set — two literals is exactly how the grid and the viewer came to disagree about their own tools.

`tests/blocking-and-directing.test.js` is set-based over **(surface × job)** because the failure was partial in exactly that shape, and it **executes** the panel builders rather than grepping for their ids: the ids are produced from `${p}Characters`, so a grep for the literal reports a working editor as broken and a grep for the template reports a broken one as working.

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

### A Connection That Predates the Capability
*"Claude on trying to analyze the screenplay: Those two tools don't exist. I checked by name, searched the film-engine catalogue by keyword, and re-queried the server to be sure it wasn't a stale tool list — 289 tools, nothing added, no `analysis_*` of any kind."*

Every step of that reasoning was sound and the conclusion was wrong. The tools existed, were served over the wire, and could be listed from a process spawned with **the same node binary the host uses** — 206 tools, `analysis_brief` and `analysis_write` among them. What the host was reading was a tool list fixed at **Fri 28 Aug 13:54**, and the tools shipped at **Sat 29 Aug 08:26**: nineteen hours older than the capability it was asked for.

An agent host spawns `backend/mcp-server.js` once, at app start, and keeps that process. So `tools/list` is answered from a registry built when the process loaded, and a tool shipped afterwards is invisible — **indistinguishable from one that was never built**. The connected model even considered staleness and ruled it out, because re-querying the same stale process returns the same list.

**Nothing in the tool list can warn about this**, and that is the whole design constraint: a stale process serves a stale list, so a diagnostic *tool* would be missing from exactly the connections that need it. Two channels do reach a stale process, and both are used. `initialize` now reports the build — `0.1.0+206tools.<when the process started>` instead of a constant nobody updates — so the age of a connection is answerable without reading a process table. And calling a name the build does not have returns an error that **names the tools on disk it is missing** and says to reconnect.

`lib/mcp-build.js` does a real **diff**, not a timestamp comparison: it re-reads the registry from disk and compares the names a fresh process would serve against the ones this one is serving. *"Something changed"* would fire on every save and be ignored within a day; *"this connection does not have analysis_brief, analysis_write"* is a sentence someone can act on. Only the two modules that decide **which tools exist** are watched — route modules change behaviour, and including them would flag every backend edit.

Two details are load-bearing. The check **restores the require cache exactly**, because a diagnostic that leaves the process in a different state than it found it is worse than no diagnostic. And an unreadable registry reports **cannot-tell**, not "everything is missing" — reading the live list as empty compares as *"this connection is missing all 206 tools"*, which is the same class of failure as the one being fixed: a confident wrong answer. That one was found by mutation, not by reading.

The test also spawns the server **the way a host does** and asserts the tools a client receives are the tools the registry declares — the other half of the same failure, and one a registry test cannot see.

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
`buildStoryboardPrompt` reads `sceneCard.description || sceneCard.action` (a still is built from the look; `action` is the motion layer, which video reads first) plus the written `direction`, and **nothing else** from the writing. The scene's screenplay text is loaded into context and never used. That is the right rule — a card is *this shot*, and pasting the whole scene would describe things out of frame and spend the prompt budget on them — but it makes the card the only place a nuance can live, and whoever edits one was working blind.

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

### Four Groups, and Nine Pages Gone
The sidebar was **derived from `PROJECT_PHASES`** — nine groups, matching the status machine — so the menu and the phase a project reported itself in could not drift apart. That derivation is deliberately **given up**, and the reason is worth recording rather than discovering later from a diff: the four groups asked for **cut across the phases**. Consistency is pre-production and belongs under Plan; Milestones and Budget are production and belong under Plan; Assets is an export surface and belongs under Post beside the job queue. No merge of the nine produces these four, so keeping the derivation would have meant bending either the menu or the status machine to fit the other — and the menu is what a person uses every day.

**Write & Design → Plan → Production → Post**, ordered as a film is made. `GROUP_ORDER` is the single statement of sequence, because object key order and an explicit list is two lists that can disagree depending on which the reader trusts.

What is **not** given up is the invariant that was doing the work: every page in the build sits in **exactly one** group, and no group names a page that does not exist. An orphaned page — still in the build, unreachable from the menu — looks exactly like a deleted feature until somebody asks where it went, and `applyNavFlow`'s stray-catcher would quietly file it under *Other*.

**Nine pages removed**, eight deleted and one moved: continuity, selects, dubbing, provenance, rights, delivery QC, colour grading and the colour pipeline are gone; **Plan & Shoot moved onto the home page**. Removal is checked as a **set over every surface a page occupies** — nav button, panel, loader, reload map, nav map, and any `navigateTo` pointing at it — because a page removed from four of five is still in the build: the button is gone and the panel is still rendered under *Other*, which is the stray-catcher doing exactly what it exists to do. 247 lines of orphaned loader went with them, swept iteratively, since removing one loader orphans the helpers only it called.

**Every home panel carries its way in.** The instruction was *only the things that are clickable and bring me to the other section*, and it is the right rule: a read-only figure on a landing page is something to look at, while this list is meant to be the route to the work. That drops the conform panel — *Film master* had no `go` because conforming is an **action rather than a place**, and it is reached from Export where the other delivery actions are. The panels load **after** the rest of home and are not awaited by it: nine endpoints answering in series is slower than the one `/home` call, and blocking the greeting on them would make the whole page feel like the slowest report.

**`musiccues` was in no requested group and was not on the removal list.** It is the only surface where a cue's *direction* is written — the description that actually reaches the generator — so dropping it would have been a capability loss disguised as a tidy-up. It sits beside Music & Sound, and the decision is stated rather than silent.

**What was removed is the screen, not the data.** `routes/continuity.js`, `film_rights`, the provenance manifests and the broadcast QA gate are untouched and still reachable over HTTP and MCP. That leaves `continuity-ref` as a live import target with no page to import from, which `tests/media-imports.test.js` records as an exemption **by name with a reason** rather than dropping from its denominator — a gap named is work, a gap silently excluded is one nobody finds again, and a stale exemption fails the test.

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

### The Budget Is Compute, Not Crew
`lib/budget-estimator.js` prices a live-action shoot. Catering at $35 per head per day, a grip package, transportation, SAG day rates by talent tier, location permits, a 10% contingency. It is a careful and complete model of a production this pipeline does not run: there is no crew to feed, no van to hire, and no actor to pay scale. Meanwhile the thing that *does* cost money — every call to Anthropic, Meshy, ElevenLabs and Runway — was recorded **nowhere**.

`film_cost_entries` existed from migration 037 and had exactly **one writer**: a manual `POST` a human had to fill in by hand. So a project could generate forty images and report a spend of **$0.00**, which is indistinguishable from a project that generated nothing. The only price list in the repo was `lib/flow-cost.js` — eleven round numbers, deliberately on the high side, which says of itself that "nothing here claims to be a price list". It exists to refuse a run before it starts, and it was never billing.

**The meter is installed at one place, and that is the whole design.** Thirty-one call sites across `routes/` and `lib/` reach a provider. Instrumenting thirty-one call sites is how twenty-nine end up instrumented, and the gap is invisible — an untracked generation looks exactly like one that never ran. Every one of those sites gets its adapter from `resolve()` / `resolveGenerator()`, so `meterAdapter` wraps there and a route added next month inherits it with nothing to remember. Same reasoning as `lib/shot-references.js` gathering plates once for four paths.

Attribution rode in on a decision made years earlier and never used. Every call site already writes `resolve('video', parseProjectConfig(scene.project_id))` — the project id is *right there*, and was thrown away one line before it was needed. That function existed **seven times**, byte-identical, in lipsync, video-gen, music-gen, post-production, locations, characters and voice; it is now one implementation in `lib/provider-config.js` that tags the config with the project id, **non-enumerably** so it cannot leak into the Provider Settings panel or round-trip into `provider_config` on the next save. Not one of the thirty-one call sites changed shape.

**Two units per capability, and the distinction is the point.** `unit` is what the adapter can *measure* from a real request or response — tokens returned in `usage`, characters of text sent, seconds of media requested, or the call itself where a provider charges flat. `native_unit` is what the provider *bills* in, which is what the user tops up and watches drain. Runway meters in seconds and bills in credits; ElevenLabs meters in characters and bills in credits. Reporting only dollars hides the number that actually runs out mid-render. Keeping them apart means an adapter never has to know a price and the rate book never has to guess a quantity.

Every rate carries its **source URL and the date it was checked**, and a test enforces both. A rate with no source cannot be re-verified when a provider changes pricing, and an un-recheckable number does not stay approximately right — it decays into a confident lie, which is worse than no tracking at all because it gets budgeted against. Where a figure is genuinely not published it is marked `inferred` rather than quietly averaged, and `film_provider_rates` overrides any entry per install — Meshy publishes what an operation costs in credits and *not* what a credit costs, so its dollar figure is the Pro-plan rate and a user on another plan corrects their own book without editing code.

Three rules the tests pin, each because the opposite costs real money:

**A failed generation is not billed.** A provider that refused produced nothing and charged nothing; recording it would make the image-fallback chain — which deliberately walks *past* providers that decline — look like three purchases for one image.

**A throwing meter never fails a generation.** By the time metering runs the request has been made and the money is gone. Turning a paid, successful generation into an error the caller reports as a failure is the worst available trade, and it is the trap `stampAsset()` already documents for fingerprinting.

**Self-hosted is priced at zero deliberately, and says so.** Gridlight bills nothing per call, and an *unpriced* pair also reports zero — the two are indistinguishable unless one of them is explicit. It still writes a usage event, so "the local gateway made 40 keyframes" stays answerable, and writes no cost entry, because a stream of $0.00 rows is noise in a ledger a person reads.

**Cost per minute is measured against the shots' own durations, not against rendered clips.** A project storyboarded but not yet shot has real spend and a real intended running time, and "what will the rest of this cost" is exactly the question that figure answers. Measuring only finished video would report `Infinity` for every project before its first clip — the moment the number is most useful.

**And history is reconstructable, once.** Metering starts the day it ships, and Wingfall had already generated 34 storyboard frames, 5 reference plates and 2 character sheets. A tracker that can only count forward reports $0.00 for all of it. `lib/spend-backfill.js` prices what survives — every row in `film_assets` is a file that exists because a provider was paid to make it, and the project's own `provider_config` says who. Each reconstructed event carries a `source_ref` of the asset it came from under a unique index, so pressing "reconstruct my spend" twice cannot double the history. Everything it writes is flagged `estimated`, and the report totals measured and estimated **separately**: "we measured $41" and "we think it was about $41" are different claims and only one should be defended in a meeting. It is a **floor** and says so — a generation that failed cost money and left no asset to count.

Two pre-existing breaks surfaced while wiring the page, both shipped and neither ever hit, because the tab they were on had never worked: the SPA called `/budget/summary` where the route is `/budget` (a 405 on every load), and read `budget_limit` / `by_type` / `total_amount` where the route returns `budget_total` / `breakdown` / `amount`. `saveBudgetLimit` posted `budget_limit` to a route that only reads `budget_total`, so setting a budget silently did nothing.

`tests/ai-spend.test.js` is set-based over the **21 (provider, capability) pairs** in `providers.list()` — never a list typed into the test, or the next adapter arrives unpriced and silently free. It checks four separate things per pair, because the failure is partial: a book covering Anthropic and Runway while leaving Meshy unpriced reports a plausible number that is wrong by exactly the images, which is the largest line on a storyboard-heavy project, and an example test passes in that state. It also derives from the **source** that no `.generate()` call site obtains its adapter outside the registry, and that `parseProjectConfig` has exactly zero remaining copies.

**The LLM is not an API bill — it is a subscription window.** This pipeline reaches a model through an agent host: Claude Desktop, and soon ChatGPT Desktop, connected to `backend/mcp-server.js`. That is the whole reason `tests/mcp-no-server-llm.test.js` exists — a tool that hands reasoning back to a server-side LLM asks the user to hold a second key for a question the connected model has already read. So `anthropic:llm` is marked `subscription: true` and charges the project **nothing**. Pricing a feature-length breakdown at per-token list rates would invent thousands of dollars that were never billed, and it would be the *largest* line in the report — confidently wrong in the direction that makes AI filmmaking look unaffordable. The researched per-token rates are kept rather than deleted, so an install that genuinely pays per token switches them on with one rate override instead of having to find the numbers again.

**But the traffic is real, so it is metered anyway.** A director who runs out of Claude capacity halfway through a breakdown is blocked exactly as hard as one who runs out of Meshy credits; the resource is only denominated differently. `lib/mcp-usage.js` meters at `tools/call` — one choke point, the same choice made for providers, so a tool added later is covered with nothing to remember — recording inbound and outbound tokens separately and attributing to the project the arguments name.

Two honesty constraints shape that gauge, and both are enforced by test. The counts are **estimates and say so**: this process sees the JSON going out and coming back, not the host's system prompt, its history, or its tokeniser, so four characters per token is an approximation and what it counts is a **floor** on what the host actually processed. And there is **no published ceiling to gauge against** — Anthropic publishes plan *multipliers* (Pro at 5x free, Max 5x at five times Pro, Max 20x at twenty) plus a rolling five-hour session window and a weekly reset, and deliberately publishes no token count for any plan. So `allowance_tokens` starts NULL and the report shows consumption with **no percentage at all** until the user calibrates it from what they observe. A bar reading "62% of your Max plan" against a number this codebase invented would be worse than no bar, because it would be believed and planned around. Calibration is stored per person in `film_app_settings` beside `author` — one pool is shared across every film, so a per-project ceiling would let two projects each show comfortable headroom while the account is out of capacity — and a single Pro-equivalent baseline scales to every plan through those multipliers, so one measurement calibrates all of them.

Served at `GET /projects/:id/spend`, `GET /projects/:id/spend/usage`, `POST /projects/:id/spend/backfill` and `GET|PUT|DELETE /spend/rates`, plus `GET /spend/subscription`, and as `spend_report`, `spend_usage`, `spend_backfill`, `spend_rates`.

### Conform: shots into a film
`assembly` has been a no-op since it was written, returning `"use export endpoints to finalize"` — so an orchestrated run reports success and there is no movie, and the `video_master` QA check goes green on shot 1 of N.

`lib/conform.js` plans the film: which cut of each shot ships (`video_final` > `video_synced` > `video_raw`, so a graded shot is never conformed from its raw clip), in timeline order, with the project audio mix as master when one exists and the clips' own audio when it does not — inventing a silent track would deliver a mute film that looks successful. **A missing shot refuses the conform**: a film that renders while missing shot 7 plays fine and is wrong, and nobody finds out until somebody watches all of it.

**The master carries the film's own sound.** It kept only the sound inside the clips, so a film whose dialogue, score and ambience were all generated here was assembled SILENT — every file played in Playback and reached the NLE lanes, and none reached the master. `engineSound()` reads the placements off the same timeline Playback plays (`routes/timeline.loadTimeline`) and maps them onto the conform's own cut: each shot's lines from its start with the card's pauses, and each scene bed at its offset with the cue's level and fades, stopped where the scene ends. A shot's own sound effects (`audio_sfx` on the shot) go from that shot's start at the mix's SFX level, −4 dB. Dialogue is laid only under a clip with NO sound of its own — Playback does the same, because a clip can carry its own speech and laying both says every line twice. An approved score session keeps its own placement and the scene music it replaces is already out of the timeline; a finished project mix is the soundtrack and nothing is laid over it. One ffmpeg pass lays all of it (`scoreMixArgs`, which now takes a length, fades and a level per placement). `tests/conform-sound.test.js` MEASURES the file: silence before a line, the line where its shot plays, a bed's level in dB.

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


### One Decision, Two Surfaces
A director explores on the board and explores in previs, and expects a choice made in either to be true in the other. Some already were — camera facets round-trip through `/previs/apply` and `/previs/from-card` — which is exactly what made the gap hard to see: a test written against the lens passed while `direction`, `location_view`, `anchor`, `keep_plates` and `annotation_feedback` appeared **zero times** in `routes/previs.js`. Twenty percent green reads as working.

`lib/decision-contract.js` is a **projection map, not storage**. It says which stored choices are the same decision seen twice; `scene_card` stays the durable statement of intent and `film_previs_blocking` stays a workspace. Nothing renders a UI from it — previs's 3D beats a form for camera, the board's pickers beat a stage for cast, and a registry that tried to own both would make each worse.

**The Apply boundary is the load-bearing constraint.** Previs is where you *try* an angle; if trying it commits it, you stop trying. So applied decisions round-trip, and unapplied staging stays staged — visibly, in the surface and in the pre-spend confirmation, because the failure mode of an uncommitted choice is silence. This is why the parity matrix splits *rehydrates* into **3a** (applied decisions reappear on the other surface) and **3b** (unapplied intent is disclosed as staged): with a single link, the cheapest way to turn the suite green is to auto-apply every drag, which passes and deletes exploration.

Each decision is held to five links — operable on both surfaces, persists to its canonical home, 3a, 3b, appears in the pre-spend preview, and reaches both the image and video payloads. A decision the contract declares single-surface must state a non-empty `why`, which is what stops a gap being retro-labelled a boundary once closing it turns out to be work. Unnamed staging is such a rule and a real one: anonymous helpers are scaffolding, and serialising them puts literal boxes and markers in the frame — so naming or typing a `set_piece` is what makes geometry semantic, and the surface must *say* it dropped the rest.

**Director intent lives in its own column, and that was found by measurement.** The first draft stashed it in `camera_json`, which `blockingFingerprint()` hashes wholesale — so editing one sentence of direction on a shot whose camera never moved flipped an approval from fresh to stale, and `/to-video` and `/to-storyboard` would have refused it with a 409 the director could not explain. Migration 080 gives it `director_json`, outside the fingerprint by construction. Approval means *this is the angle I signed off*; prose must not revoke it.

Migration 081 fingerprints the applied stage and applied card separately. A mismatch can therefore say which side moved: stage-ahead invites Apply, while board-ahead disables Apply and asks the director to re-seed Previs. Treating both as merely “staged” invited the exact destructive action when the board contained the newer rewrite.

**Decisions you can lock, and the console as one screen.** Apply and approve were whole-shot fingerprints; `decisionParts` in `lib/decision-contract.js` cuts the same material along seven chips (camera, direction, lighting, location_view, characters, props, movement), `markApplied` stores them in `applied_parts_json` (migration 116), and `GET /film/shots/:id/previs` now reports each as none / trying / applied / card_ahead / conflict / locked / stale. `POST …/previs/lock` and `…/unlock` (MCP `previs_lock` / `previs_unlock`) take `decisions: [...]` or `all: true`; only an applied decision can be locked, and `all` also approves, so every guard downstream of approval is unchanged. The `previs_console` setting lays the SAME console regions out as one screen — the frame fitted to the view in script, the move under it, four tabs, and a Decisions strip — and is off by default; `tests/previs-decisions.test.js` holds both.

**The world itself in Previs ([ADR-008](docs/adr/008-spark-lazy-splat-viewer.md), superseding ADR-006).** With `previs_console` on, the frame has five views: **Look** (the world's Gaussian splats, from exactly the painter's pose), **360°** (look around from the camera — inside the splat, or on the panorama when a version has no splat), **Geometry** (the plate generation receives), **Depth**, and **Plan** (the collider from above with every camera's cone). Splats come from `src/vendor/splat-viewer.js` — three 0.180.0 + Spark 2.2.0 bundled by `scripts/build-splat-viewer.sh`, imported only when a splat view opens, served by `GET /film/vendor/splat-viewer.js` for pages not under `src/`; the page's own three r149 is untouched and no dependency was added. `GET /film/world-versions/:vid/splats` lists the tiers (smallest first, local copy before CDN) and says "off" rather than 404 while `world_splats` is false. Explore tiles render their accepted cameras from the same splat. The shot list moves into the app's side panel. Production's shot drawer gains **From Previs**: each decision's scene-card value and state, read-only, with Open in Previs; graph shot nodes show the lock count. `tests/previs-views.test.js` and `tests/adr-spark.test.js` hold it.

`tests/decision-parity.test.js` derives its denominator from three code sources — `EDITABLE` in `routes/shots.js`, the `film_previs_blocking` columns, and the `film_projects` switches the board actually reads — so a field added later is accounted for or fails. Its probes are behavioural where it matters: the round trip is **run**, and payload reachability is **differential** (change the value, assert what a provider would receive changes), because a stored choice and an applied choice look identical from the outside. Three of its early findings were the fixture's fault rather than the product's — a phantom plate path, byte-identical plate images, and a string accepted as `props` and then iterated character by character — and each was cheap to mistake for a real defect. Where the schema is loose, *what validates* and *what a field means* are different questions, so every sample the probe builds is now derived from something that constrains behaviour rather than from what the validator will tolerate.


### A Preview Is Built the Way Its Purchase Is
Parity made the two surfaces agree about what a director decided. It did not make the REQUEST agree with the screen, and that is where the money is: `routes/storyboard.js` called `buildStoryboardPrompt` directly for generate-all, the streaming generate and per-shot regenerate, and `routes/video-gen.js` had its own `loadShotContext` and four direct `buildVideoPayload` calls. Neither file mentioned previs anywhere in those paths, while `/shots/:id/prompt` and the previs previews went through `loadShotContext` + `buildCapabilityPayload` and did carry it.

So the free preview was not merely different from the purchase, it was **better** than it: the director was shown their staging honoured and paid for a frame that never received it. Same shape as the refine-preview lie, one level up. The fix is *share the builder*, not *pass previs into three more calls* — a fifth call site added next month would diverge again with nothing failing, which is why `tests/previs-boundary.test.js` counts direct builder calls rather than checking one of them.

**Durable generation reads APPLIED blocking; only an exploration preview opts into staged.** `loadShotContext` defaults to `previsMode: 'applied'`, and the previs previews pass `'staged'` explicitly because showing an experiment before it is committed is their whole job. The board's own prompt preview does **not** — it is a preview of a purchase, so it is built the way the purchase is. That distinction was got wrong once in the fix itself: the board preview opted into staged while board generation stayed applied-only, so a shot staged at 137mm and never applied showed `137mm lens, super35 sensor` in the confirmation and sent `50mm lens` to the provider. A warning that staging is unapplied is necessary and not sufficient — the prompt is the thing the director is being asked to approve.

**Four application states, not two.** `applied_fingerprint` and `applied_card_fingerprint` (migration 081) are hashed separately, so the answer says WHICH SIDE moved: `applied`, `staged` (the stage moved ahead — Apply), `card_ahead` (the board moved ahead — do NOT apply, re-seed), `conflict` (both). Two states was the first design and it was actively harmful: both directions reported `staged`, which is a sentence about the stage, and the surface offered Apply — so a director who applied an angle and then rewrote the direction on the board was invited to press the button that silently reverted their rewrite. Apply now refuses that with **409 CARD_AHEAD** before any card write.

The fingerprint covers only the **projected subset** — what Apply actually writes — for the reason screenplay drift was narrowed to four fields: a warning that fires on work nobody needs to redo is one people learn to dismiss, and then the real one is dismissed too. Staged subject names are normalised the way Apply matches them (registered cast and props only, case-insensitive, order-independent), so reordering the stage or renaming MAYA to Maya reports nothing.

**Staged blocking refuses a paid board action, and the refusal is passable.** `STAGED_PREVIS` is a 409 with `ignore_staged`, on the precedent of `ignore_lock`, `ignore_approval`, `ignore_budget` and `ignore_stale` — *a refusal you cannot get past is a reason never to lock at all*. Overriding **strips** the staged blocking and generates from the committed card rather than consuming the experiment, so exploring does not cost a director the ability to shoot the shot as written. The first version disabled the button with no way past, which was worse than it looks: the server never refused that request at all, so a dead button was blocking something safe and correct.

**Internal state never rides in on a request body.** `_seededFromCard` was read off the body while being set server-side, so any caller — MCP `previs_set` forwards its arguments verbatim — could mark staging as applied without the card receiving anything, and the whole boundary reported green. `tests/previs-boundary.test.js` probes this **differentially**: `from-card` legitimately marks applied, so the question is not "did this end up applied" but "did supplying the field change anything".

`lib/nav-flow.js` regroups all 34 pages into the nine `PROJECT_PHASES` the status machine already declares, so the sidebar and the phase a project reports itself in cannot disagree. Served over `GET /film/nav-flow`; the SPA **moves** the existing buttons rather than rebuilding them, keeping every tooltip and handler. **Two views, two questions, two technologies.** The wireframe stage answers *where does this stand and how does it read in frame* — that stays hand-rolled canvas 2D, and `lib/glb-parser.js` feeds it silhouettes with materials deliberately stripped. The textured pane answers *is that actually the character*, and a real material cannot be faked with a 4×4 matrix and a polygon painter, so it runs **three.js r149 + GLTFLoader, vendored inline** against the same `.glb`. Inlined rather than linked because `build.target: single-html` — index.html is ~1.6MB as a result, which is the price of the constraint. `GLTFLoader` ships ESM-only, so it is converted to a classic script by the same mechanical transform three's own `examples/js` build used to perform: the `three` import becomes a destructure from the global, the one helper it borrows from `BufferGeometryUtils` is inlined, and the export becomes an assignment.

`GET /models/:assetId/file` serves the .glb to the viewer; `GET /models/:assetId/geometry` serves decimated points and triangles to the stage. Two endpoints because they answer different questions — the geometry one strips exactly what the viewer exists to show.

**Phase 4 is built: a generated `.glb` can be staged.** It stayed unbuilt because loading a mesh looked like it required Three.js, which would have meant a bundler and the end of `build.target: single-html`. It did not. Previs already had the 4×4 projection and the polygon painter; the only missing piece was something to turn GLB bytes into points and triangles, and that is `lib/glb-parser.js` — glTF 2.0's positions, indices and node transforms, and nothing else. Materials, textures, normals, UVs, skins and animation are all skipped deliberately: previs is grey-box, what a director judges is where a subject stands and how it reads in frame, and a silhouette answers that completely.

Parsed and decimated **server-side** (`GET /models/:assetId/geometry`), because the browser has no bundler to read binary glTF with and a hundred-thousand-triangle character would otherwise cross the wire in full before being thrown away. Decimation samples evenly rather than taking the first N — the first N of an exported mesh is usually one limb, while an even stride keeps the whole silhouette — and it reports what it dropped. Vertices are kept whole so the bounds, and therefore where the model stands and how big it reads, do not move with the budget. A model that has not arrived or failed to parse draws as its bounding box rather than vanishing, since a silent disappearance reads as a failed click.

Design: [`docs/plans/previs-camera-implementation-plan.md`](docs/plans/previs-camera-implementation-plan.md), [`previs-camera-research.md`](docs/plans/previs-camera-research.md), machine-readable taxonomy in [`previs-camera-taxonomy.json`](docs/plans/previs-camera-taxonomy.json), conformance enforced by `tests/previs-plan.test.js`.

### Deciding a Move, and Then Seeing It
*"Mostly what I want from the previs is the ability to decide camera movements, and then see the movement with the static storyboard shot when we play it in playback."*

Deciding was never the gap. Previs solves optics, flies a six-degree-of-freedom camera, samples compound moves, approves them and writes them onto the card; the scene card has carried a `movement` since it was written. **Seeing it was the gap.** `loadShotIntoStage` set a background image and held it there for the shot's slot, so *"slow dolly push-in down the cul-de-sac"* and *"locked off"* played identically — and the only way to find out whether a move worked was to buy the clip.

`lib/shot-motion.js` turns a camera move into a transform over that still, and every number in it comes from the film's **own optics** rather than a feel-good constant: how far a 15° pan travels across the frame is a fact about the lens, so the same move on a 24mm and an 85mm produces different pictures — which is the thing a director is trying to see. The same pan needs a **1.55×** push-in on the 24 and **2.80×** on the 85.

**The still is a window onto the scene, not a photograph standing in it.** A projectively correct pan over a flat card keystones; a real pan does not keystone the world, and previs answers *how does this shot read*. So a pan translates, a crane translates, a dolly scales by the real distance ratio and a roll rotates. What a still cannot do is stated rather than discovered: **it holds no parallax**, so the subject comes out right and the background travels with it — the same limit the previs plate quad already carries.

**Precedence is `effectiveCamera`'s, not a fourth copy of it.** A blocked shot plays the path that was approved, with its own easing left alone; an unblocked shot — most of a real board — plays the word on its card, sampled through **previs's own `samplePath`** so the eighteen movements cannot mean one thing on the stage and another in playback; a shot that says nothing holds exactly as it does today.

**A movement WORD is a proportional intent, not a dolly track in metres.** Held at the registry's literal 0.6m, Wingfall 1A's push-in came out at **1.2% of the frame** on a 26-metre establishing wide — invisible — while the same word on a close-up sent the camera a metre *through* a subject 0.96m away. A word names a move; metres only mean metres once someone has said how far away the subject is, so a metre amount is scaled against the distance the registry's own numbers were written for and a rotation is not (thirty degrees is thirty degrees). An amount someone **typed** in previs stays metres — rescaling it would overrule the director.

**What it costs is reported, because a travelling move has to push in to have room.** `magnification` is the tightest the still is ever shown, and the crop alone was the wrong measure: a pan needs the frame pushed in and a dolly does not, so a dolly closing most of the distance enlarged the picture five times and reported as perfectly carried because no edge was exposed. Past 2× the label says **too big for a still** with the remedy; below 2% of frame it says **too small to read** with the number and the two ways out. Neither refuses — a director asking to see a 90° whip pan over one still is asking a fair question.

Three defects surfaced while building it, each invisible until something moved:

**The previs camera pane was mirrored.** `previsAim` built its direction as `+sin(yaw)` while `yawVector` — which `samplePath`'s orbit, `analyzePath`'s naming and `solveShot`'s azimuth all go through — turns the other way. So pressing pan-left swung the pane **right** while the provider was told pan-left, dragging the camera turned it against the mouse, and a shot solved at an azimuth pointed away from its own subject. Measured in the real page through the pane's own projection: pan left now moves what was centre to **+0.38 of a frame width**, where it was −0.38.

**The playback stage was not the shape of the film.** `width: 100%` beside `max-height: 52vh` defeated the `aspect-ratio: 16/9` next to it — the height clamped, the width did not, and a stage declaring 16:9 rendered **3.18:1**. Harmless while nothing moved; fatal once something does, because the visible region is the stage, so a move would have been watched through a wide slot with the top and bottom of the frame outside it. The width is derived from the capped height now, at the **project's** aspect rather than a hardcoded one.

**An orbit read as a dolly.** Measuring the dolly from travel along the camera's own Z doubled the subject on a 63° swing that never approached it — an orbit displaces the camera metres "forward" in its starting frame at constant radius. The scale is the real distance ratio to the plane being framed, measured **along the aim**, which previs's plate quad learned once already: a figure's stored position is its feet on the floor while the camera is at eye height.

`transformAt` and `cssTransform` are mirrored in the SPA and held equal by test over every movement at eight moments — the page cannot require a node module (`build.target: single-html`), and the composition order is pinned in both (**scale first, then translate**, in units of the original frame) because a transform assembled the other way puts every travelling move somewhere else on a shot that also scales.

Served on every timeline entry as `entry.motion`, at `GET /film/shots/:id/motion`, on the Playback transport as a **Camera move** switch naming the move and where it came from, and as `shot_motion` (**206 tools**) — free, because it reads rows and does arithmetic.

`tests/shot-motion.test.js` is set-based over `MOVEMENTS` because the failure is partial by nature: a dolly is a scale and a pan is a translate, so a conversion that handles one perfectly can do nothing at all for the other. Its sign assertions are written in **film language** — *"pan left and what was centre swings right"* — never in axis language, because a test that agrees with the code's own axes cannot catch a mirrored camera, which is exactly what was found. The page half is **executed** rather than grepped: a checkbox existing says nothing about whether it is read, and a transform left on the element by the previous shot crops the next one — both look like a working page in the source.

### Free Camera Paths

The shot camera is a full six-degree-of-freedom pose: position x/y/z and yaw/pitch/roll, with lens, sensor, stop and focus distance. It can be dragged on the frozen stage projection, turned with Shift-drag, entered numerically, and captured as ordered camera keys. The route already persisted nine of those ten components before this work; the limits were the page and the frontal-only solver. Focus distance was the missing validation and must remain positive and finite.

`camera_keys_json` is the authored source; `path_json` is the sampled result that was actually previewed. The original 18 movement presets remain shortcuts and compile byte-identically to their captured paths. One analyzer names a flown path twice: a provider-safe dominant movement id and honest compound prose for prompts. It accumulates every leg (endpoint subtraction makes an out-and-back move look static), converts world translation into camera space (world +X is not camera-right after a turn), and ranks physical magnitudes so centimetres of drift cannot outrank metres of travel. In its prose, **while** means concurrent axes in one leg and **then** means ordered legs; that distinction is generation intent, not style.

The browser samples keys locally because sending every drag and playback frame through an asynchronous route would make the camera network-dependent, and the app deliberately ships as one HTML file with no build step. That leaves two implementations by design, so `previs-camera-contract.test.js` holds browser and server to each other over the edge-case set while `previs-key-sampling.json` holds both to the corrected golden outcome. Key times are director-editable; rotations normalize to degrees at the route boundary, interpolate across the shortest angular seam, and ignore sub-half-degree noise in generation prose.

Previs remains scoped to an existing shot. **Render this angle** saves the keys, applies the blocking, and regenerates that shot's Storyboard frame. There is one saved blocking per shot: exploring is free until Save, and saving replaces the previously saved angle. The stage painter is intentionally grey-box: it has no occlusion and texture mapping is affine per triangle, so flying behind a wall may show through it; use the camera output and generated frame to judge final visibility.

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
Capabilities (`llm`, `image`, `video`, `music`, `voice`, `sfx`, `ambient`, `lipsync`, `post`, `model3d`, `world`) each resolve to a provider adapter: per-project `provider_config` → `PROVIDER_<CAP>` env → **`PREFERRED_WHEN_CONFIGURED`** → Gridlight default.

That preference table was consulted on every resolve, documented, and **empty**, so it never fired: a project created with no config pointed all eleven capabilities at a local Gridlight service whether or not it was running and whether or not a credentialed hosted adapter sat in the registry beside it. The only symptom was a connection refused at generation time, per capability. It is now populated for the eight capabilities that have a hosted adapter, applies only when that provider actually holds a credential, and is still overridden by an explicit per-project choice. `defaultProviderConfig()` writes the same choice into new projects so Provider Settings shows what generation will really use. Adapters live in `lib/providers/` and are auto-loaded by filename, so adding one never means editing the registry.

**Runway** (`lib/providers/runway.js`) serves `video` + `image`. Unlike the other generators it is asynchronous: `POST /v1/{image_to_video,text_to_video,text_to_image}` returns a task id, and the adapter polls `GET /v1/tasks/:id` to completion so routes still see a finished asset. Video defaults to `gen4.5` (2–10s, ratio snapped to a documented value), images to `gen4_image`.

**Env vars:** `RUNWAY_API_KEY` (or Runway's own `RUNWAYML_API_SECRET`), `RUNWAY_BASE_URL` (default `https://api.dev.runwayml.com/v1`), `RUNWAY_VIDEO_MODEL`, `RUNWAY_IMAGE_MODEL`, `RUNWAY_POLL_INTERVAL_MS`

**Anthropic** (`lib/providers/anthropic.js`) serves `llm` — `POST /v1/messages`, auth by `x-api-key` plus a pinned `anthropic-version` (not a Bearer token), default model `claude-opus-5`. Raw `fetch` rather than `@anthropic-ai/sdk`: the Messages API is one endpoint and the backend has exactly one dependency, so an SDK for a single adapter would reverse a deliberate stance ([ADR-002](docs/adr/002-vanilla-http-no-framework.md)). It lifts the system prompt into the API's own `system` field rather than concatenating it into the question, and treats `stop_reason: "refusal"` — an HTTP 200 with empty or partial `content` — as a result rather than reading `content[0]` blindly.

`llm` is preferred here while Gridlight's `/chat/intelligent` is unusable: that endpoint routes every question through `build_unified_query`, and all six of its routes reach Qdrant or Neo4j before a model, so with no vector store running it 500s on `vector length 768 != expected 0` regardless of payload.

**Env vars:** `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_LLM_MODEL`

**ElevenLabs** (`lib/providers/elevenlabs.js`) serves `voice` + `sfx` + `ambient` + `music` — `POST /text-to-speech/:voiceId`, `POST /sound-generation` (one-shot), `POST /sound-generation` with `loop: true` on `eleven_text_to_sound_v2` (ambient beds), and `POST /music` (`music_v2`, 3s–10min, instrumental by default since film cues are underscore). All return raw audio bytes, so results are Buffers written straight to disk.

Ambient is a **loop, not a full render**: `buildAmbientPrompt` asks for a bed of at most 30s (`duration_s`) and records the length it must cover (`bed_duration_s`), then `buildMixPayload` emits `loop`/`loop_until_ms`/`loop_crossfade_ms` so the mix service tiles it across the shot. A mix service that ignores those fields will play the bed once and leave the rest dry.

No licensed-catalog *source* adapter ships, so `stock` is **not a capability** — see *A Capability With No Provider Is a Claim the Preflight Cannot Check* below. Nothing writes `film_assets.license_source = 'licensed_catalog'` today; the rights model keeps that vocabulary independently of any capability, and the `source` (search/license) contract and the OAuth/MCP connect flow both remain wired for the next provider that needs them.

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

### An Audio File Is a Card, Not a Filename

*"Each audio file should be its own card with details about it, format, what it
is, etc. I should be able to add a new audio through either generate or
upload."*

The sound sheet listed cues as rows of text. A row cannot answer the question a
director actually has in front of a folder of takes — *which one is this, is it
the right length, and has it been generated yet* — so every answer needed a
click, and two files three seconds apart were indistinguishable.

**The details were already in the database and nothing read them.**
`film_assets` carries `format`, `duration_ms`, `size_bytes`, `provider` and
`created_at`; the card reads all five. `duration_ms` is the one that matters,
because it is the difference between a bed that covers the scene and one that
stops two thirds of the way through — invisible in a filename.

**A waveform, not an icon.** `lib/waveform.js` decodes to mono 8kHz and reduces
to 96 peaks, cached under `.waves` keyed on **mtime and size** — the same
identity rule the plate cache uses, because a regenerated cue is written to the
same path and a cache keyed on the path alone would draw the old sound for
ever. It is the only thing on the card that separates a take that is mostly
silence from one that clips, and both are *listen to it* problems a duration
cannot express. It never throws: a peak list that cannot be computed is a card
without a picture, never a card that fails to render.

**Both ways in are on every category.** Generate and upload sit on each of the
five cue types rather than once on the sheet — a single Add button forces the
director to say afterwards what the sound was, and this codebase has already
paid once for a coverage question asked at the wrong moment.

The test reads the detail set from the **schema**, across every migration that
touches `film_assets` rather than the CREATE alone: `provider` arrives in a
later ALTER, so a scan of the create statement reports a column the card
correctly shows as missing. And it requires `paintWaveforms` to be **called**,
not merely defined — the first build had it wired to nothing, and a test
checking only that it exists passes in exactly that state.

### A Cue Is Written to the Length of the Cut
*"If we generate a soundtrack for a clip, how do we know the final length and feed the right prompt?"*

We did not. `buildMusicPrompt` read `cue.duration_ms || scene.estimated_duration || 30000`, and `estimated_duration` is **0 on every scene in both real projects** — 0 is falsy, so every cue fell through to a hardcoded thirty seconds. Measured: Wingfall scene 1 holds **22.08s** of footage and scene 2 holds **10.05s**; both would have been scored at 30.

The engine already knew the number. `measuredDurations()` reads the real length of every clip off disk, and the conform and all three NLE exporters build the film with it — music was the one thing still guessing. `sceneCutLength()` sums it per scene, and the order is now **what the composer asked for → the measured cut → the estimate → thirty seconds**. An explicit `duration_ms` still wins, because an underscore running past a scene is a legitimate choice.

It returns **null when nothing has been shot, never 0**: "no footage" and "a zero-length scene" are different answers, and conflating them is exactly what let a 0 fall through to a default nobody chose. The default is still there and now **says why** — a director told *"30 seconds, because nothing has been measured for this scene"* can shoot it first or set the length by hand.

The handle is required **lazily** rather than threaded through the call sites. This module is used by the route, the orchestrator and the flow canvas; passing a database through all three to fix one number is how two of them end up still guessing.

**The NLE seam now runs both ways, for the score.** It was export-only, and a test pinned the absence of any importer so that building one would force this to be revisited — it was. An edit made in Premiere is imported with its Final Cut Pro XML or EDL (see *An Edit Made in Premiere Comes Home*), and a score SESSION written against it follows the cut. A scene CUE's length is still measured from the engine's own assembly: a cue is per scene, an edit is the whole film, and reading one scene's length out of a cut is a claim nobody has built. The test pins that too.

**And an agent can write the brief, not only press generate.** `node_gen_music` was reachable and the cue that carries the direction was not — the thing that spends money was fully exposed while the field deciding *what the music is* could only be typed by hand. Four tools close it (`music_cue_create`, `_list`, `_update`, `_delete`, **179 tools**), and the routes they needed did not exist either: only POST and GET, so a cue's direction could be written once and never revised. `music_cue_update` **merges**, because a cue is a whole brief and rewriting one sentence must not clear the instruments; deleting a cue **keeps the audio**, which is an asset on the scene that cost money.

The tool descriptions say which fields reach the generator and which do not — `notes` is production-facing and reaches nothing, and an agent not told that will write the brief into it. Music cues are now in `ENTITY_ROUTES`, so the next missing verb fails a derived test rather than being invisible: a cue absent from that registry is exactly how this gap survived.

**And there is a place for music direction.** `film_music_cues.description` is the free text that reaches the prompt, and it always did. Three fields did not: `instruments` and `key_signature` were **read by the generator with no control in the form**, and `reference_track` — *"sounds like X"*, the clearest music note a director gives — was stored and read by nothing. All three are wired now, the reference phrased as a style to match rather than a title to quote. Length is typed in seconds and stored in milliseconds, blank meaning *score the measured cut*; instruments are split from a comma list, because the route JSON-stringifies whatever it is handed and a raw string becomes one instrument called *"solo cello, brushed kit"*.

### Directing the Sound
*"Generating music worked but we need to be able to select an option to play it when we use playback… and how can we influence the music at specific timelines or even the overall generated music? Or even the ambient sound?"*

Three separate gaps, and the first one made the feature look broken.

**A generated score was invisible to the assembled film.** Music and ambient are **scene-scoped** — their assets carry a `scene_id` and no `shot_id` — and the timeline's asset query reads `WHERE a.shot_id IS NOT NULL`, which is right for a shot's picture and its dialogue and excludes a scene's beds entirely. So you could score a scene, press play, and hear only the dialogue. From the outside that is indistinguishable from the score having failed to generate.

A bed spans its whole scene, so it is laid out **once across that span** and seeded once when the playhead enters it — restarting a score at every cut is the one behaviour that would make a perfectly good cue sound broken. It comes with the cue's own **level, fades and offset**: `volume_db`, `fade_in_ms`, `fade_out_ms` and `start_ms` have been on `film_music_cues` since migration 016 and only the offline mixer ever read them, so a player ignoring them plays a different mix from the one being delivered. A cue that says nothing gets the delivered mix's own levels (music −8dB, ambient −12dB), because a player at unity is louder than the finished film. `start_ms` is an offset **into the scene**, which is what the mixer has always taken it as and the only reading that survives the scene being moved. A bed shorter than its scene simply stops and **says so** — *"music ends 176s before the scene does"* — rather than looping, which is a worse lie than ending where it ends.

**A cue could not change over its own length.** A film cue is sparse under the argument and opens out when he finally says it; `film_music_cues` carried one description for the whole thing. ElevenLabs' `/music` takes a `composition_plan` — named parts, each with its own direction, its own negatives and its own duration, honoured. **Sections are opt-in and that is the safety**: `prompt` and `composition_plan` are mutually exclusive at the provider, so a cue nobody has sectioned sends byte-identically to what it always has.

**Six rules govern that plan and every one is otherwise a paid request that fails.** All six were **probed against the live API with deliberately invalid bodies** — validation rejects those for free — rather than taken from memory, and **two are not in the documentation at all**:

| | |
|---|---|
| 1 | `You must provide exactly one of ` prompt ` or ` composition_plan `.` |
| 2 | `You must not provide ` music_length_ms ` when passing ` composition_plan `.` |
| 3 | a part's `duration_ms` must be 3000–120000 |
| 4 | `lines` is **required** on a v1 section, even for an instrumental cue |
| 5 | **undocumented:** `` `force_instrumental` can only be used with `prompt`. `` |
| 6 | **undocumented:** the shape is **per model** — `music_v1` takes `MusicPrompt {sections[]}`, `music_v2` takes `CompositionPlan {chunks[]}`; sending v1's shape to v2 is *"Invalid type of `composition_plan` used for model music_v2"* |

(6) is why the plan arrives at the adapter in a **neutral** shape and is converted there: which body a model wants is a provider fact, like `promptLimit` and `referenceMode`, and belongs beside the model ids. (5) would have silently lost the instrumental default — sung vocals over dialogue ruin a scene — so the plan says the same thing with a **negative** rather than abandoning it.

Sections are **refused, never rounded**: trimming a 130-second part to 120 gives the director a different piece of music than they asked for, and does it silently. A cue too long to be one section gets a **structural split** that says nothing about what any part should sound like — a 202-second scene cannot be one section and a director should not have to do that arithmetic, but inventing the shape of the music is the judgement this hands to whoever is directing.

**And the ambient bed had no direction at all.** `buildAmbientPrompt` read the location NAME and the time of day from lookup tables and nothing else. Two things it never read: **`film_locations.sound_notes`** — a column called sound notes, with a textarea on the Locations page placeholdered *"Traffic two streets over, a screen door, gulls..."*, stored since migration 006 and reaching nothing but the call sheet; the one field whose entire purpose is to describe how a place SOUNDS was invisible to the only thing that generates how a place sounds. And a **scene's own direction** — the room tone of a diner is a property of the diner, *"the fridge compressor cuts out halfway through"* is a property of the scene, and both were unsayable. An ambient cue is an ordinary `film_music_cues` row with `cue_type: 'ambient'`, so it inherits the negative, the level and the fades rather than getting a second table. The bed length is the **measured cut** through the same walk the score uses: `scene.estimated_duration` is 0 on every scene in every real project and 0 is falsy, so it fell to a thirty-second default for a scene of any length — the same defect the score had, one function over.

**Three sites built the music payload and three built the ambient one**, and the music batch did not even go through `cueForScene` — so a scene generated from the batch got a thirty-second default where the Music page got its measured length, and would have skipped the sections silently. One `musicPayloadFor` now serves the free brief and all three paid paths, because a preview built differently from its purchase is worse than no preview.

**`music_cue_update` and `music_cue_delete` had never been callable.** `routes/assets.js` has dispatched PUT and DELETE on `/film/music-cues/:id` since the update route was written, and `server.js` only ever forwarded `/rights` — so both tools were listed, described, schema'd, and answered 404 on every call. Found by pressing one.

Served as `beds` on the timeline, `sections`/`negative_prompt` on the cue routes and both cue tools, a **Score** and an **Ambient** switch on the Playback transport, a section editor on the cue form and an ambient direction on each scene of the Music page.

`tests/music-direction.test.js` exercises the route rather than grepping it — a source check for `sections_json` passes against a route that writes `'[]'` into it — and asserts the per-model plan bodies from the adapter's own builder, because sending the wrong shape is the failure that cost a real request.

### Music & Sound Design
Generates music scores, sound effects, and ambient audio. Maps 14 moods to tempo/instruments/energy, 18 locations to ambient sound descriptions, 6 time-of-day modifiers. Stored at `data/music/{project_id}/`.

### Post-Production
Upscaling (Real-ESRGAN), face restoration (CodeFormer), and color grading (LUT presets). Supports individual steps or full composite pipeline. Final output at `data/video/{project_id}/{shot_code}_final.mp4`.

### Pipeline Orchestrator
9-step shot production pipeline: keyframe → video → voice → lipsync → music → sfx → ambient → post → assembly. Dependency resolution, auto-skip (voice/lipsync when no dialogue), retry with exponential backoff (3 attempts, 5s base), pause/resume/cancel support.

### A Cue Has Notes: Parts Over a Plan, and a Part You Played
GRD-3994, the first instrument-render phase. The director’s answer to *editable notes or realistic timbre* was **both**: *"realistic instruments that I could play… I dig into melodies myself with AI providing instruments."* So a cue gets a note list the connected agent writes and any part of it can be replaced by MIDI the director performed. There is no renderer yet; a `.mid` with one track per part is already useful in Ableton, and turning notes into sound is the next phase.

**Parts over a harmonic plan, not a whole cue.** `music_midi_write` takes a `plan` (tempo, meter, key, chord changes, sections) and `parts[]`, each one instrument with a General MIDI program (or `drums`) and notes as `{start_ms, duration_ms, pitch, velocity}`. Whole-cue MIDI from a language model is the unproven step; a fixed plan with one part at a time is the honest scope, and it is what lets a played melody sit over written harmony.

**Milliseconds, never beats.** The cut is in milliseconds and the cue’s length is the contract, so beats would be a second clock that drifts from the picture the moment the tempo changes. Ticks exist only inside the file. The length is the same walk `cueSeconds` takes — the cue’s own duration, then the measured cut, then the measured dialogue — but kept in milliseconds, because a note list checked against a length rounded to whole seconds refuses a note that ends inside the real cut. A cue with no length is **refused (409)** before anything is written.

**A played part outlives a rewrite.** `music_midi_import_part` replaces ONE named part with a performed `.mid`, keeps the original bytes beside the rebuilt file, and marks the part `performed`. An agent rewrite keeps every performed part unless it names it in `replace_performed` — a rewrite that silently wrote over what somebody played is the failure this exists to prevent. A director who skips the agent entirely gets a plan taken from the file’s own tempo and meter, and the cue’s length.

**Written, then read back, before it is registered.** `lib/midi.js` is hand-rolled (ADR-002: four chunk types and a variable-length integer) and its parser reads MIDI the way a DAW writes it — format 0, running status, note-on at velocity 0 as a release, sysex — and refuses what would make the times wrong: an SMPTE time division, a chunk that runs past the file. Every stored file is parsed back and refused if its note count or length differs from the list it was printed from.

**Deliberately not a `MEDIA_IMPORTS` target, and not in `MEDIA_KINDS`.** The ticket asked for a `midi` entry in `MEDIA_KINDS`; eleven modules read that registry as a *capability’s* storage and MIDI has no provider, and `MEDIA_IMPORTS` is "a file stored where a generated one goes", pinned at eighteen targets by five epic documents. A performed `.mid` is neither: it replaces one part of a note list. So it has its own route on the cue, with its own sniffing, and a UI control on every sound cue card. Stored as `film_assets` `other` + `metadata.kind = 'midi'` (the 3D precedent: the CHECK cannot be widened in place), one note file per cue updated in place so its asset id is stable, served as `audio/midi`.

Served at `GET|PUT|DELETE /film/music-cues/:id/midi` and `POST /film/music-cues/:id/midi/parts/:part/import`, on a **MIDI** panel on each sound cue card, and as `music_midi_get` / `music_midi_write` / `music_midi_import_part` / `music_midi_delete` (**341 tools**).

### Every Screen Follows the Data, Including After Our Own Writes
*"The problem isn't just the score page, it's every screen that doesn't update
as soon as there is new data or a UI update."*

The transport was already right and the wiring was half-done.
`refreshCurrentPage()` existed and was driven by exactly two things: an SSE
`change` event, and window focus. SQLite's `data_version` moves only when
**another** connection commits — which is deliberate, and is what stops the page
fighting the user's typing — so the live channel correctly says nothing about
this page's own POSTs. That left every write to be followed by a re-read the
calling function had to remember.

**Measured: 81 of 236 mutating call sites did not.** A third of the app's own
writes left the screen showing the state before them, which is exactly what
"every screen doesn't update" describes.

It is fixed in **`api()`**, the one funnel every call goes through, for the same
reason the busy spinner lives there: threading it through 236 call sites is how
81 of them end up without it. A successful POST, PUT, PATCH or DELETE schedules
a coalesced refresh of the current page.

**The throttle was half the defect.** `refreshCurrentPage` returned early inside
its 3-second window, so a *burst* of changes produced **no** refresh at all — the
throttle turned "too often" into "never". It now schedules a trailing refresh
instead of dropping one.

**Deferred, never dropped**, on the rule the live channel already follows: a
refresh that lands while a field is focused or a modal is open is held and
flushed on the next blur or click, because a page skipped for the life of a
modal is a page that is wrong when the modal closes.

**The project list is a page too.** The guard read `!state.currentProject`, so
creating or deleting a project could never refresh the screen that lists them.

**Two paths opt out with `refresh: false`, each saying why**: the workstation
autosave fires on every tick of a slider and repaints its own lanes, and the
screenplay autosave runs while somebody is typing — reloading either would
rebuild the thing being dragged or the editor under the caret. An unexplained
opt-out is how a screen quietly goes back to being stale, so the test caps how
many there may be and requires each to carry its reason.

`tests/live-after-write.test.js` EXECUTES `api()` against a fake fetch, because
a grep cannot tell a refresh that is scheduled from one a throttle drops — and
the dropping was the half nobody could see. Both defects were re-introduced as
mutations and both fail it.

**An extractor trap worth recording.** The sandbox reads functions out of the
page by brace depth, and taking the first `{` after the name reads a DEFAULT
PARAMETER as the body: `function api(path, opts = {})` truncated to
`function api(path, opts = {}`, which fails as a syntax error inside the sandbox
and reads as the page being broken rather than the test. The parameter list is
skipped by paren depth first.

### A Refresh Keeps the Page You Were On
*"Whenever I refresh in a page it goes back to the project list."*

Nothing recorded where you were, so every reload cost the page being worked on
and getting back meant the project list, the project, then the page. That is
tedious, and it is worse than tedious: it makes a shipped change read as not
shipped. A piano roll built under the lane was reported missing by somebody who
reloaded onto the project list and never arrived back at the Score page to see
it.

The hash carries **the project and the page and nothing else**, so it is also a
link that can be pasted: `#/<project id>/musicws`. `navigateTo` writes it,
`applyRoute` puts the app where it points, and `hashchange` honours back and
forward.

**`replaceState`, not an assignment to `location.hash`.** Clicking through four
pages inside one project must not put four entries in the back button, and the
guard (`ROUTE.writing`) is what stops write → hashchange → navigate → write
being a loop.

**A URL naming a project that is gone falls back to the list and says why**, and
a hash the app does not recognise is left alone rather than acted on — an
unparsed fragment must not navigate anywhere.

`tests/page-route.test.js` EXECUTES the router against a fake location and
history, because a grep cannot tell a hash that is written from one that is read
back, and the loop between them is the whole risk. Its page set is **derived
from the app's own loader map**, so a page added later is reachable by URL or
the test fails.

### A Track's Details Live Under the Track, and the Part Is a Piano Roll
*"All the details about a track should be below each track, able to expand or
close, with tabs for each section."* And: *"let's add a piano roll we can expand
from below the track to play the notes manually."*

Everything about a lane was in one column in the side inspector, so editing the
lane you were looking at meant reading a form somewhere else. A chevron beside
the name opens the lane's own details underneath it, in six tabs —
**Part, Instrument, Mix, Takes, Automation, Lane** — declared once in
`MW_TRACK_TABS`.

**Every pane is rendered and the inactive ones are hidden with a class.** A
control that exists only while its tab is open cannot be found by a person, by
find-in-page, or by the editor audit — and that audit is what guarantees every
field the validator accepts has a control that saves. Switching tabs repaints
nothing: it toggles classes, because a re-render would lose the roll's scroll
position and anything half-typed in another pane.

**It MOVED; it was not copied.** The first build mounted the same builder
under the lane *and* left it in the side inspector, which is two live copies of
one set of controls — the shape this codebase keeps paying for — and it is not
what was asked for. The side panel now carries no track control at all: it says
which lane is selected and offers a way back down to it. Selecting a lane opens
its details, because selecting something and seeing nothing appear anywhere
reads as a dead click.

**The audit followed the controls.** `music-workstation-editor` executes the
renderers and requires a saving control for every field a validator accepts; it
used to find the track's fields in the inspector and now renders the lane with
its details OPEN. A test that keeps checking the old surface would pass while
the feature moved out from under it.

**The roll shares the ruler's x-axis.** Notes are positioned with the same
`mwX` the clips above them use, so a note sits directly under the audio it made
— which is the entire reason to put the roll under the lane rather than in a
window. The key column is sticky-left like the lane heads; the settings panes
are sticky-left too, so they stay readable while the timeline scrolls, while the
roll deliberately scrolls WITH it.

**Milliseconds are the storage; beats are only the grid.** Snap is derived from
the session's own tempo map (1/4, 1/8, 1/16, or off) and converted to
milliseconds at the moment a note lands. Click the grid to add, drag to move,
drag the right edge for length, double-click to remove.

**Every gesture saves the WHOLE part, once.** The validator takes a part, not a
note, so a half-written list refused mid-drag would leave the lane holding
something it cannot play and the refusal would arrive with nothing to point at.
It goes through `mwSave` — the same validator an agent's `music_track_update`
meets — so a pitch outside 0–127 or a note past the picture is refused by name
here exactly as it is there.

**The key preview is a plain tone and says so.** Clicking a key sounds a
triangle wave, because placing notes by ear needs immediate feedback and the
lane's real sound is a sample library rendered offline through the sidecar. A
sine pretending to be Kontakt would be a worse lie than silence, so the tooltip
names it: *a reference tone, not your instrument*.

### It Says Play, So It Plays
Two defects, reported as *"if I click play it doesn't work"* — and the button
was working perfectly. Both renders had gone through Kontakt and landed.

**A new take had no take group.** `mwHeard` falls back to *is it selected* when
a clip carries no `take_group`, so a candidate was never played, and
`mwTakeGroupHtml` reported *no group*, so it could not be switched to either.
The take was landed and **unreachable** — from the page, indistinguishable from
the render having done nothing. One lane is one part, so its takes are one
group: the track id.

**And a button called Play did not play.** It rendered a file, landed it as a
candidate (correctly — what is playing keeps playing until somebody selects it)
and left the lane looking identical. Pressing Play now **auditions** the new
take in its group's place and plays from its head, through the mechanism
MUS-014 already built: what is HEARD changes, what is SELECTED does not, so
nothing that ships moves. An `AudioContext` created during a click is suspended
by the time an awaited render returns, so `mwPlay` resumes it — without that,
playing is silence with no error.

### The Score Is Where a Composition Is Built
*"First of all the score should be where this all happens."* Right, and the first
build put it on the wrong page. A cue's MIDI panel can play one part of one cue;
a **composition** is several lanes against the picture, each with its own sound,
each re-played until it is right — and the score session is the only place that
has the lanes, the ruler, the mixer and the takes. Everything else was already
there and the one thing missing was that a **track had no part and no sound of
its own**.

Migration 112 gives `film_music_tracks` its `notes_json`, and 110 already gave it
`instrument_id`. So a lane carries the two facts that make it playable, and
`POST /music-sessions/:id/tracks/:tid/render` (`music_track_render`, **351
tools**) plays it: the notes through the instrument, into that lane. It is
**free and says so** — it runs on the director's own machine through the
instrument sidecar and no provider is billed — so there is no confirmation to
pass, which is the difference between trying four melodies and rationing them.

**A play is a take, never a replacement.** On a lane that already holds
something the new clip lands as a `candidate`, so what is playing keeps playing
until somebody selects it — the rule every other generated output on a score
session follows (MUS-013), and the whole reason exploring is safe.

**The part is validated by the same code a cue's MIDI is.** `trackNotes` runs
`midi.validateScore` over the lane's notes against the session's own length and
its tempo map, so a pitch of 999 is refused with *"note 0 pitch 999 is not
0–127"* rather than stored and discovered at render time. Times are
**milliseconds, never beats**, which is what makes a part land where the cut is.

**Four ways a lane cannot play, and each is a different sentence.** No notes
(412, naming how to write them), no instrument (400, listing what is in the
library and where to find more), an instrument whose plugin has been
uninstalled (409, naming it), and a render that came back silent (422, naming
the stage). They all look like *"the button does nothing"* from outside, which is
exactly why the Play button on the lane head is **disabled with the reason
rather than hidden**: a control that vanishes reads as the feature not existing,
which is how this was reported in the first place — *"the side menu is music
cues and there are no MIDI button"* (the MIDI panel was on **Music & Sound**,
never on Music Cues).

**Where the sound came from travels with the audio.** The registered asset
carries `instrument`, `library`, `source_ref` (`kontakt:1423`) and `source_file`
in its metadata, so a file made in September is still traceable to the patch it
came from in March — the same reasoning that made a capture read its name out of
Kontakt's own index.

**And two fields an agent could not see.** `musicSchemaFor` derives a tool's
schema from the validator's own defaults, and both `notes` and `instrument_id`
are optional — so the validator dropped them from an empty seed and
`music_track_update` advertised neither. A field a route accepts and a schema
does not mention is one the model never tries, which is the *capability with no
surface* failure pointed at an agent instead of a page. They are seeded now.

`tests/score-instruments.test.js` is set-based over the four refusals, because
the failure is partial by nature — a route that refuses an empty lane and
silently keeps a silent take passes any test written against the first. The
audio path runs against a fake sidecar serving real WAV bytes, so nobody's
library has to be installed, and the take semantics are proven by playing the
same lane **twice** and reading the clips back.

### The Name Comes From Kontakt, and the Library Holds Only What You Used
*"You should dynamically have the library name and the patch name when we load it into Film Engine so I know the source of the file in the future."* A capture called "Kontakt capture (rename me)" is useless in six months.

**Every route to detecting it was a dead end, and each was measured rather than assumed.** The state is compressed binary — no readable paths in 547KB. The plugin's **4145 parameters** carry no text values. Kontakt writes no log of what it loaded, and touches nothing in its preferences when it does. Access times are stamped by NI's own scan (12:59 on every snapshot), not by loading.

**Kontakt already knows.** `komplete.db3` indexes every sound it can play — 844 on the director's machine, across Action Strings, Ethereal Earth, Maximo, Indie and Kontakt's factory content — with the name, the product, the bank, what kind of sound it is and the file it lives in. `lib/instrument-catalogue.js` reads it **read-only and live**, so an instrument is created FROM that row: "Vortex Bells, Ethereal Earth, tags Percussion/Bell/Metallic", with `source_ref` (`kontakt:1423`) and `source_file` recorded (migration 111).

**Nothing is copied into Film Engine, and that is the point.** *"Are you sure you want to index all sounds into our DB? We'll have hundreds of thousands of entries... maybe we add the patch when we use it."* Right, and the first build got it wrong: `instrument_scan` inserted a row per preset it found. Browsing is now **live and storage-free** — the catalogue reads Kontakt's index on every request, and the NKS scan lists rather than indexes — while `film_instruments` holds **one row per sound actually used**. A preset can be played by path (`preset_path`) and joins the library at that moment, once; a test asserts that browsing 100,000 presets writes zero rows.

**What still needs a person, stated plainly:** a plugin exposes its state and not its browser, so a captured sound is one somebody loaded in Kontakt. Choosing it from the catalogue first is what makes the result self-describing; without a `sound_id` the capture is kept but says so.

### A Plugin Is Somebody Else's Code, and It Falls Over
Three things were learned by running Kontakt rather than reading about it, and each changed the design.

**A plugin window opens only on the main thread.** `open_editor()` from an HTTP worker thread raises *"Plugin UI windows can only be shown from the main thread"*. The first design answered requests on worker threads, so capture could not work at all.

**A plugin can take its host down.** Kontakt logged `PresetSlotManager::selectSlot: slot not found` while being re-stated and killed the sidecar mid-render. A segfault cannot be caught in Python, so the containment is a process boundary: `backend/instrument-worker.py` does ONE job and exits. It gets a real main thread for the editor, it loads the plugin fresh so it inherits nothing from the job before, and when it dies it costs one job rather than the host. The sidecar supervises and reports what is running, because a queue nobody can see reads as a sidecar that has died.

**An exit code is not a verdict.** Kontakt rendered six seconds of audio, wrote the file, and THEN segfaulted while being unloaded — so a non-zero exit was reported about work that had finished, and a good render was discarded. Two rules followed: the worker writes its answer to a FILE (Kontakt prints its own log lines into stdout, which corrupts JSON on that channel) and leaves through `os._exit`, skipping the destructors that crash; and the sidecar decides on the answer, noting `plugin_crashed_on_exit` rather than losing the take.

**And the client cannot use `fetch`.** Node's fetch gives up after five minutes waiting for response headers. A capture waits on a person standing at a plugin window; the first real capture took longer than that, and the patch came back to a closed socket and was lost. The client speaks plain `node:http` with only the ceiling each operation declares, and the sidecar now keeps the last capture at `GET /last-capture` so a dropped connection costs nothing — the rule the provider handles already follow.

**Measured end to end on the director's Mac**, 2026-09-14: a captured Kontakt patch is **547KB** of state; four notes written by Claude rendered through it in **5.4s** to a 6.000s file peaking at **-12.8 dB**. No DAW open, nothing billed.

### One Sound Out of a Library, Playing a Part
The sidecar holds the plugins; this is what makes 248 libraries usable. An **instrument** here is not a library — it is one SOUND: a plugin path plus the state blob that recalls that patch, because a plugin exposes its state and not its browser. Migration 110 keeps them in `film_instruments`, **not project-scoped** on the style-book precedent: a library outlives a film, and re-capturing a patch per project is exactly the time this exists to save. `film_music_tracks.instrument_id` is `ON DELETE SET NULL` — an instrument removed from the library must not take the arrangement with it.

**Two ways a patch arrives, and the row records which.** `captured` is a person at the plugin's own editor (supervised, blocking, a window in front of somebody); `nks` is a preset this engine read. `lib/instrument-presets.js` walks the RIFF chunks of an `.nksf` — NISI (what it is, as MessagePack), NICA, PLID, **PCHK (the plugin state)** — and returns the state with NKS's four-byte envelope stripped, because what a plugin wants is the chunk it wrote. Metadata it cannot parse costs the sound its NAME, never the sound: the file name is the fallback and the patch still loads. **Unverified and stated as such:** whether Kontakt accepts a PCHK payload through the host's own `load_state` can only be proven against a real preset, and no library was installed when this was written — it is checked the one way it can be, by rendering and listening for silence.

**A part is played, not a cue.** `POST /film/music-cues/:id/midi/parts/:part/render` takes one part of the note list, writes it as its own single-track SMF against the cue's plan, plays it through the chosen instrument, and keeps it as that part's audio — so a composition is built part by part inside Film Engine. Re-rendering **replaces** that part rather than piling takes up, and `GET …/midi` reports `renders` per part, so the panel can say what has been played and by what. A render that comes back silent is refused (422) rather than kept: silence is what a patch-less plugin produces, and a take of nothing is worse than no take.

**A scan indexes, it does not copy.** Every row points at the preset where Native Access installed it; a library that is not NKS-ready ships no `.nksf` and is **reported** rather than skipped, because those patches need capturing and a silent omission reads as the scan having worked. Scanning twice adds nothing.

Served at `GET|POST /film/instruments`, `GET /film/instruments/{host,plugins}`, `POST /film/instruments/{capture,scan}`, `GET|PUT|DELETE /film/instruments/:id`, on the cue's MIDI panel (an instrument per part, a Play button, the audio beside it), and as `instrument_list` / `instrument_get` / `instrument_scan` / `instrument_update` / `instrument_delete` / `music_midi_render_part` (**349 tools**).

### Your Own Libraries, Inside Film Engine
*"I want to use those libraries INSIDE Film Engine without having Ableton Live open... I generate a MIDI melody with AI, apply it to a library sound and can hear the result in its own track... building a full composition directly in Film Engine, not leveraging ElevenLabs for this."* The director owns **248 sample libraries**, and the complaint is time.

**Node cannot host a plugin, so a sidecar does.** `backend/instrument-sidecar.py` is the Ableton sidecar's shape (MUS-017) with a stronger reason: it loads third-party plugin code into itself. Started by a person, 127.0.0.1 only, token-gated, three typed operations (`instruments`, `capture`, `render`) and no generic call into a plugin — and a **plugin path outside the folders macOS installs plugins into is refused**, because "any path the caller likes" behind a localhost port is arbitrary code execution.

**Measured before it was designed, not after.** Kontakt 8 VST3 loads headless in **0.9 s** (4145 parameters, 64 outputs), `save_state` is **5344 bytes** and `load_state` reads it back, and three seconds render in **0.1 s**. That last pair is the load-bearing one: **a plugin exposes its state, not its browser**, so state IS how a patch is recalled without a GUI. An NKS preset's `PCHK` chunk is exactly that state, which is what makes choosing a sound by name possible across 248 libraries; anything older is captured once through `capture`.

**Two things are stated as impossible rather than left to be discovered.** No plugin host can browse a library and load an `.nki` by path, and none of this plays live from the page — it renders offline (far faster than real time) and the take is heard in the Score page like any other clip. Both are in `UNSUPPORTED`, the shape `lib/ableton-osc.js` already uses.

**One rule finishes every render.** `finishRender` — cut to length, read back, refuse silence — moved out of the SoundFont renderer so the plugin host shares it rather than keeping a second copy; a test asserts the volume measurement exists exactly once and that the plugin host does not measure its own. Silence is the normal answer from a plugin holding no patch, so the refusal says so.

`tests/instrument-host.test.js` proves the boundary with no plugin at all (loopback, token, allowlist, an unknown operation refused **before** any request is sent) and the audio against a fake sidecar serving real WAV bytes, so it runs anywhere. The real test spawns the sidecar, loads Kontakt, and refuses a plugin outside the plugin folders — it skips with its reason where no plugin is installed.

### The Notes, Played Through Instruments on This Machine
GRD-3995. Phase 1 gave a cue notes; this plays them through a sample library, offline, for nothing per render. The shape is the conform’s: an executable **probed at runtime and never bundled** (a library is gigabytes and operator-installed), reported when absent, and every result **read back before it is believed**.

**A render is judged on its volume, never on an exit code.** A SoundFont that loads but holds no instrument for a part — a drum part on a font with no percussion bank — renders, exits 0 and writes silence, so `renderMidi` measures the file: read back with `inspectMedia`, length within one frame of the cue (it pads, then cuts, because a release tail runs past the last note), and a peak above -60 dB, refused at stage `silence` otherwise. The research assumed a MISSING SoundFont renders silence too; FluidSynth 2.6 refuses that path outright (exit 255, no file), found by running it, and it is refused at stage `renderer`. The stitcher’s audio sat at -91 dB for months while every "is there an audio stream" check passed.

**A render is made of somebody’s samples, so the licence travels with it.** `resolveSoundfont` names the library (VSCO 2 CE is `cc0`, FluidR3 GM is `mit`) and a library it cannot name is **refused** unless whoever installed it states `FILM_SOUNDFONT_LICENSE` (`cc0`, `mit`, `ni_eula`, `third_party`). The licence is recorded on the rendered `audio_music` asset as `library_license`, so the rights report can say what a cue is made of.

**The adapter composes nothing, and says so.** `lib/providers/fluidsynth.js` serves `music`, answers all six workflows `unsupported` with the reason, and is never a default — `PREFERRED_WHEN_CONFIGURED` still names ElevenLabs. With no notes on the request it answers `PRECONDITION`, and the orchestrator now treats an adapter’s PRECONDITION exactly as a builder’s: a skip, not a failure retried three times. Priced at zero **explicitly** (`fluidsynth:music`, `self_hosted`). `sfz-render` is named and not wired: the sfizz project was archived in June 2026.

**A keyless adapter is ready only when its probe says so.** `isProviderConfigured` read every no-key adapter other than Gridlight as ready, which would have reported go for a render that produces silence; an adapter with `available()` is now asked. The preflight’s `fluidsynth` checker lives in `DEPENDENCY_CHECKS` but deliberately **not** in `STEP_EXTERNAL_DEPENDENCY`: the music step needs it only on a project whose music resolves to the renderer, so `checkCapability` consults it through `ADAPTER_DEPENDENCY` — declared on the step, it would block every project’s music stage — and reports what is missing instead of "has no credential".

The render route resolves through the registry with music pinned to FluidSynth **for that call only**, so it is metered and attributed and the project’s stored choice is untouched; it is in `MUSIC_CALL_SITES` naming **no** workflow, because it performs none of the six. The test builds a few-kilobyte SoundFont of sine wave, so it needs FluidSynth and nothing downloaded, and skips with the reason where FluidSynth is absent.

Served at `GET /film/music-cues/:id/midi/render/plan` (free) and `POST /film/music-cues/:id/midi/render`, as a **Render with instruments** button on the MIDI panel, and as `music_midi_render_plan` / `music_midi_render` (**343 tools**). Environment: `FLUIDSYNTH_PATH`, `FILM_SOUNDFONT`, `FILM_SOUNDFONT_LICENSE`, `FILM_SOUNDFONT_DIR`.

### The Model Proposes the Arc; a Person Accepts It
The emotional arc of a picture is the judgement the whole score hangs on, and
the connected agent **is** the model here — so MUS-010 is not a "run the
proposer" route that hands the brief to a server-side LLM
(`tests/mcp-no-server-llm.test.js` exists to refuse exactly that). It is the
screenplay-analysis precedent pointed at music (`lib/music-emotion.js`):
`music_emotion_brief` hands over the ScoreBrief, the arc already accepted,
the proposals still waiting, the range schema with the contract's own bounds,
the coverage rule and the instructions, for nothing; the model reasons;
`music_emotion_propose` writes what came back.

**A proposal is proposed, never accepted.** It lands as ranges with
`status: proposed`, `source: ai_proposal`, one proposal id for the batch, a
confidence, and a **rationale** per range naming what in the picture or the
screenplay earns it — a range with no rationale is refused, because a number
nobody can argue with is a number nobody should accept (migration 106 adds
`rationale` and `proposal_id`). Proposals and the director's arc share one
table and are kept apart by status and source: the brief, the bounce and
generation read `status = 'accepted'` only, so a proposal cannot reach
anything paid by being in the wrong list, only by being accepted.
`emotionForGeneration` is the gate a generator reads: the accepted arc, or
`EMOTION_NOT_ACCEPTED` naming what is still only proposed.

**Bounds and coverage are validated with the field named.** Every bounded
field in the contract's `RANGES` is refused out of range; a range past the
picture is refused with the length named; overlapping ranges are refused
naming both; a proposal covering under 80% of the picture is refused; a gap
is reported, not refused — music genuinely stops sometimes. A new proposal
supersedes the last one's still-proposed ranges (retired to `rejected`, not
deleted, so the lineage reads) and leaves accepted ranges alone.

**Acceptance is explicit and per range** (`music_emotion_accept`): the named
ranges move to accepted with edits applied on the way in, the rest are
rejected on request, an edit outside the bounds refuses the whole acceptance,
and the operation records what was accepted, rejected and edited. The
workstation's emotion lane draws a proposal dashed, counts the pending ones
in its own head, carries the rationale in the range's tooltip, and gives the
inspector a rationale control beside the status picker — the only way from
proposed to accepted on the page is a person changing that picker.

Served at `GET /film/music-sessions/:id/emotion/brief`, `GET|POST
…/emotion/proposals`, `POST …/emotion/proposals/:pid/accept`, and as four tools
(**308 tools**). `tests/music-emotion-proposals.test.js` is set-based over the
contract's `RANGES` (every bound refused both sides, naming the field) and
over the lifecycle in both directions: what a proposal must not reach, and
what an acceptance must.

### A DAW Is an Editor Film Engine Talks To, Never the Place the Score Lives
MUS-016 defines the contract every DAW integration implements, and the
engine-side driver that holds each adapter to it whatever the transport. An
adapter implements six methods (`status`, `sessionRead`, `push`,
`pullAvailable`, `pull`, `transport`), and `lib/daw-adapter.js` turns them into
the seven operations of `DAW_OPERATIONS`: status, session read, push plan,
push, pull plan, pull and supervised transport. Each operation declares its
ceiling, whether it mutates, and, for mutations, that it needs an
acknowledgement and leaves an audit record.

**Seven rules, enforced by the driver rather than trusted to the adapter.**
- **Acknowledged.** A mutation is confirmed only by an acknowledgement that
  echoes the request id; no answer, a wrong id or a refusal is a failure.
- **Idempotent.** A push is keyed by adapter and plan, a pull by adapter and
  the hash of the render. The same key returns the recorded result without
  reaching the DAW, and the key travels to the adapter so a retry after a
  timeout cannot apply twice.
- **Stable external ids.** `film_music_daw_links` (migration 108) maps each
  Film Engine key to one DAW item per adapter in both directions, written only
  from an acknowledged write, so a second push updates what the first created.
- **Conflicts reported, not resolved.** A Film Engine track whose DAW revision
  moved since the last write was edited in the DAW. The plan names it and the
  push refuses with `CONFLICTS` until each is decided, `overwrite` or
  `keep_daw`. A push against a plan the session or the DAW has moved past is
  refused with `STALE_PLAN`.
- **Bounded.** A plan never names a track Film Engine does not own. A Film
  Engine track the DAW no longer attributes to Film Engine is a conflict that
  cannot be overwritten, and an acknowledgement claiming a change to a foreign
  track fails the push as a boundary violation with no links written.
- **Timed and audited.** Every operation has a ceiling. A mutation that times
  out is recorded as failed with an unknown outcome and the key to retry it by.
  Every mutation is an operation row (`push` or `pull`, `params.kind: 'daw'`)
  with the adapter, request id, key, outcome and duration. Reads leave no
  record.
- **Supervised transport.** Play, stop and locate only, and only when the
  caller says a person asked for it.

The push carries the portable score package (MUS-015), and a pull brings a DAW
render back as a package that is validated by hash and alignment and imported
as candidate takes. So every DAW action has a portable-package equivalent by
construction. `lib/daw/memory.js` is the reference DAW: the contract in memory,
with no transport, which `tests/daw-adapter.test.js` tells to misbehave in each
way a real one can. It answers without an acknowledgement, echoes the wrong
request, hangs, touches a foreign track, or returns bytes other than those it
advertised. There is no route or tool yet: the Ableton sidecar (MUS-017), its
MCP tools (MUS-018) and the sync UI (MUS-019) are the surfaces built on this.

### Ableton Through a Sidecar You Start Yourself
The first real DAW behind the contract is Ableton Live over
[AbletonOSC](https://github.com/ideoforms/AbletonOSC), and it runs in its own
process (MUS-017): `backend/ableton-sidecar.js`, started by a person, never by
the server. It listens on 127.0.0.1 only, refuses a caller without its token,
refuses a non-loopback OSC host at startup, and does only what `SIDECAR_OPS` in
`lib/ableton-osc.js` lists. Those are typed operations over a reviewed set of
fourteen OSC addresses, with no generic address, no property setter and no
delete. Status codes say which rule answered: 401, 403, 400, 503, 409, 504,
502. Installation is `docs/ableton-sidecar.md`, and nothing of Ableton's is in
the repository.

**Pinned, and honest about what the pin proves.** AbletonOSC `0ca6821` and Live
12.4.5. AbletonOSC reports major and minor only, so the handshake proves 12.4
and says it cannot prove the bugfix. Another version is connected, readable,
and refused every change (409).

**UDP has no request id, so correlation is the client's job.** A reply is
matched by address plus the track id AbletonOSC echoes on per-track queries,
first in, first out per key. A lost reply fails its own request on its own
timer. `/live/error` carries only text, so it goes to the waiting request it
names, else the oldest. A heartbeat marks two misses as a disconnect, fails
pending work, refuses new work and backs off. An answer afterwards, or Live's
own `/live/startup`, is a reconnect and a fresh handshake.

**A track has no stable id over OSC, so Film Engine's tracks carry one in their
names.** `strings ⟨fe:3a9c01b2d4⟩`: the marker is derived from the Film Engine
key, and it is the external id `lib/daw/ableton.js` hands the driver. The
revision is a hash of the name, the one property the adapter writes. A rename
in Live that keeps the marker becomes a conflict, and a track without a marker
is only ever read. Creating by key is idempotent, so a retry after a timeout
cannot make a second track.

**What AbletonOSC cannot do is said on every answer.** It places no audio from
a file, so a push creates and names the tracks, sets the tempo, and
acknowledges each track with `audio: 'manual'` and the stem to drag in at
1.1.1. It exports no render, so the pull plan is empty with the reason, and a
Live render comes back through the package import. Locate converts
milliseconds to beats at Live's tempo.

`tests/ableton-sidecar.test.js` runs over real UDP against
`lib/daw/fake-live.js`, which speaks the same subset and can go silent, reply
out of order, drop a reply, report another version and restart on the same
port. It proves the protocol, not Live: no real Live was in the loop.

**Seven tools, one per operation of the contract** (MUS-018): `ableton_status`,
`ableton_session_read`, `ableton_score_push_plan`, `ableton_score_push`,
`ableton_mix_pull_plan`, `ableton_mix_pull` and `ableton_transport`
(**331 tools**). `lib/daw-registry.js` holds the map from tool to operation and
is the one place that knows where the sidecar is: `ABLETON_SIDECAR_URL`
(loopback only, `http://127.0.0.1:3190` by default) and `ABLETON_SIDECAR_TOKEN`,
read from the Film Engine process's environment and never stored, because the
token is a secret. An unconfigured adapter answers 503 with what to set and the
guide, never with a connection error that reads like Live being broken. The
tools dispatch through `routes/music-sessions.js` into the driver, so an agent
gets the driver's rules and nothing more. No tool takes an OSC address or a
Live property, and `tests/ableton-mcp.test.js` holds that set-wise. It also
proves the pull gate through the tools with the reference DAW standing in,
because Ableton itself has no render to pull: bytes that fail the hash import
nothing, and the same render is fetched once.

**The Score page has a DAW panel, and the editor never waits for it** (MUS-019).
`DAW_ACTIONS` in the page is one action per contract operation, and each names
its **portable twin**: exporting a score package stands in for a push, importing
one (validated first, then landed as candidate takes) stands in for a pull, and
the workstation's own playback stands in for Live's transport. So nothing on the
panel needs Live. The panel is fetched **after** the editor renders and paints
only `#mwDaw`, so a missing sidecar, a closed Live or an unreviewed version
changes that region and nothing else. It shows five connection states, each with
its own recovery step: not set up (the environment variables and the guide),
sidecar unreachable, Live not answering (the Control Surface setting), readable
but not the reviewed version, and connected. A push is reviewed as a diff
(create, update, left alone, left in place) and every conflict is decided in a
select. Overwrite is offered only where the contract allows it, and the push
button stays disabled until each conflict is decided. Progress is shown on the
panel while an operation runs. The history comes from
`GET …/daw/:adapter/audit` (and `music_daw_audit`, **332 tools**), which needs
no connection. A push whose outcome is unknown carries the recovery step, "plan
again", which is safe because a marked track is never created twice.
`tests/daw-sync-ui.test.js` executes the renderers in every state rather than
grepping them.

### The Approved Score Reaches the Film Once, and Nothing Plays Under It
A score session becomes the film's music by an **explicit act** (MUS-020):
`POST /music-sessions/:id/approve` (`music_session_approve`) selects a bounce as
the session's mix. It is allowed only from review, and a bounce rendered before
the session last changed is refused with `STALE_MIX`, because approving a mix
that no longer matches the lanes signs off something nobody is looking at. A
plain status write can no longer approve: the PUT answers 409 `USE_APPROVE`.
`approved_mix_asset_id` and `approved_at` are never taken from a request body.
Unapproving returns the session to review and every consumer stops reading its
mix.

`lib/music-approval.js` is the **one reader** every consumer asks.
`approvedScores` answers which mixes can be consumed and reports the rest by
name: unapproved, stale (still the approved mix, and said so), missing (not
consumed, so the scene music stays), unplaced, overlapping (only the newest
approval is consumed, so a mix never plays twice) and shadowed. `placeScores`
puts each mix at its **canonical offset**: the start of its picture's first
shot, in each consumer's own running order and durations. Every scene the
picture touches loses its legacy scene **music**; ambience and effects stay.
`SCORE_CONSUMERS` names the six surfaces:
- the timeline, with one bed at the offset;
- playback, which plays those beds;
- the audio mix, where the project plan names the score and a per-shot mix
  takes the score's slice with `source_offset_ms`;
- the pipeline, which skips the scene `music` step under a score and says why;
- FCPXML and Premiere XML, where the mix is a bed laid on its first shot that
  spans its own length;
- the conform, which runs one ffmpeg pass that delays each mix to its offset
  and sums it with nothing normalised.

**It found a real defect in the conform.** A score bounce master is an
`audio_mix` belonging to no shot, so `findProjectMix` read it as the film's
finished soundtrack. The moment any session was bounced, the master's whole
audio, dialogue included, was replaced with one session's music. Bounce masters
and stems are now excluded, and a genuine project mix still shadows the score,
which is taken to be inside it and reported as such. The NLE route also never
selected `scene_id`, so no scene bed had ever reached an export through it; it
does now.

`tests/approved-score.test.js` runs one real film through all six consumers,
iterating `SCORE_CONSUMERS`, and **measures** the conformed master: silent
before the score, the score's tone after, and the film's length unchanged.

### Rights Follow the Music, and the Policy Acts Where It Is Stated
Four things, each stated once in `lib/music-rights.js` (MUS-022).

**Origins are declared, never assumed.** Source material is `original`,
`generated`, `licensed`, `public_domain` or `unknown`. A person declares the
origin at stem import (`rights.origin`) or in the rights register (migration
109 adds `film_rights.origin`). The engine records `generated` only when it
witnessed a provider make the file, and then as status `unknown`, never
cleared, because a provider's terms are not a clearance anyone here read. An
undeclared import is `unknown`.

**Every derivative carries its sources.** A take generated over a source, a
separated stem, a bounce master or stem, and a stem returned from a DAW or a
package each call `recordDerivative`. It links the sources and records the most
encumbered of their statuses (blocked > expired > restricted > unknown >
cleared) in the file's own `derived` row. That row is a snapshot. The lineage
itself is computed **live**, so a source cleared or blocked later reaches every
derivative at once without re-rendering. A person's own record on a file (the
status a package manifest declared, say) still counts; the engine's `derived`
row never does. `DERIVATIVE_WRITERS` names the four writers, and the test holds
each to calling it.

**One lineage.** `assetLineage` walks a file to its sources, and `scoreLineage`
(`GET /music-sessions/:id/lineage`, `music_score_lineage`, **336 tools**) walks
every clip and the mix. Each node carries origin, status, owner, provider,
model, operation and hash, and the report names every issue.

**One policy, at approval and final export.** Each gate maps each status to
allow, warn or block. The default is stated, pending the epic's Open Question 3:
- unknown and restricted warn at both gates;
- expired warns at approval and blocks final export;
- blocked blocks both.

The `music_rights_policy` setting replaces any part of it, and is validated
before it is stored. A block refuses approval (409 `RIGHTS_BLOCKED` with the
items), refuses the conformed master (conform state `rights_blocked`,
permanent, refused at the plan before anything is encoded) and blocks the NLE
export preflight (`SCORE_RIGHTS`, so the handover refuses it too).
`ignore_rights` passes a block and is recorded; a warning travels with the
approval. The rights register page gains an Origin field; a derived file's
origin is shown, not editable.

**It found a defect in MUS-020's score mix.** A film with no audio stream (a
single silent clip) made the mix filter reference an audio input that did not
exist, so the conform failed. The score is now laid over silence the film's own
length.

### The Workstation Is Documented From Its Own Registries, and Its Health Has No Secret in It
MUS-023 adds two things: documentation that cannot drift from the code, and
one report of what the workstation is doing.

**The documentation is held to the code.** `docs/music-workstation.md` covers
the production workflow, configuration, the provider capability table, rights,
what consumes an approved score, health, backup and restore, and migration
notes. `docs/api-film.md` gains the score-session section, and
`docs/ableton-sidecar.md` gains a troubleshooting entry for every status code
the sidecar can answer. `tests/music-docs-ops.test.js` derives every
denominator from the code rather than from a list:
- the routes the router's own header names;
- the environment variables the music, DAW and sidecar source reads;
- each music provider's live contract, checked cell by cell against the
  capability table;
- `DEFAULT_POLICY`, checked gate by status;
- every origin, consumer and report state;
- the score tables the bundle carries;
- every migration of the epic that touches a score table.

A table typed once goes stale the first time a provider wires a workflow, and
this test makes that a failure. Writing the docs also recorded a real limit:
the older JSON backup (`/projects/:id/backups`) does not include score
sessions. The bundle and a database snapshot do, and the guide now says so.

**Health (`lib/music-health.js`, `GET /music-sessions/health`, `music_health`,
337 tools).** It reports every score operation by area:
- `render`, `generation`, `separation`, `package`, `daw`, `import`, `record`;
- counts per status;
- what is running and what is stalled;
- recent failures, each with its session and how to recover;
- the encoder's availability and source;
- each DAW adapter: configured or not, and why.

`probe=true` also asks each configured DAW whether it responds. An area claims
operations by `kind:params.kind` first and `kind:*` second, so a package (a
push whose params say `package`) and a DAW push land in different areas. An
operation no area claims is reported as `unclassified`, never dropped.

A generation or separation is stalled when it reads running and no process
owns it. Anything else is stalled after 30 minutes, far past every ceiling.

**Nothing leaves with a secret or a path in it**, because a health report is
what gets pasted into a ticket.
- Error text is kept: it is the only thing that says what went wrong.
- Every absolute path is cut to its file name. URLs and relative doc
  references survive.
- Every credential the environment holds is removed.
- The encoder's path and the sidecar token never appear.

Three mutations each fail the test: dropping the path cut, dropping the secret
cut, and treating an orphaned job as live.

### The Whole Film, Scored, Twice — and Every Vocabulary Held to Its Consumers
MUS-024 is the proof, and it runs only through the MCP tools, the path this
engine's reasoning takes. `tests/music-e2e.test.js` takes the 30-second
fixture, extended by `fixtures/thirty-second.score.json`, from screenplay to
a final movie:
1. The screenplay is written and cut into shots.
2. A picture sequence is made over the shots, and footage is uploaded for
   each.
3. A score session is created. Its brief names the exact screenplay version
   and passage.
4. An arc is proposed and explicitly accepted. Nothing generates before that.
5. A cue is generated through a registered fake provider, and two stems are
   uploaded.
6. The session is bounced, approved and conformed.

**Path A** never touches a DAW. **Path B** takes the same project through
Ableton. A fake Live speaking AbletonOSC over real UDP sits behind the real
sidecar, found through the registry's own environment. The session is planned
and pushed. The pull plan says AbletonOSC exports nothing, so the Live mix
comes back as a stem import, and the film is re-approved and conformed. Both
masters are **measured**: 30 seconds, with the score in them, and the tone
that came back from Live is in path B's master and not in path A's. The same
file covers two more things:
- a provider failure named once by the health report and retried to a
  candidate take;
- a bundle round trip whose imported film still consumes its approved score.

An opt-in test runs against a real Live 12.4 when `FILM_LIVE_SMOKE=1` is set,
and skips with its reason otherwise.

`tests/music-registries.test.js` walks each registry, derived from the code,
through each consumer that has to handle it:
- track roles: storage, rendering (audible, or a guide with its reason),
  bundle, docs;
- clip kinds: storage, rendering, rights lineage, bundle, docs;
- the file kinds the writers stamp: docs;
- workflows: discovery, and a refusal carrying the provider's own reason;
- every score tool: a route the router names and the API reference documents;
- package manifest sections: a built manifest, and docs;
- the three DAW mutations: an agent tool, a page control with its portable
  twin, an audit record, and docs.

**Synchronized editing is executed, not grepped.** The Score page's own save
and reload functions run against the real route while an agent edits the same
clip over MCP. Neither edit is lost, a refused value reloads the truth, and a
clip the agent deletes is let go of on the next reload.

**It found two defects.**
- **A refused save named nothing.** The route put the field and the rule in
  `errors`, and the page shows only `error`, so a person read "Save failed:
  Invalid clip". Every session and child refusal now carries the rule in
  `error` itself, for example "gain_db must be between -96 and 24 dB".
- **MUS-023's health report counted a failed generation twice**, once as the
  job and once as its child, and listed the child's operation id, which
  nobody can retry. A child now folds into its job.

### A Scored Project Travels Whole
The project bundle (MUS-021) carries every score-session table: sessions,
tracks, clips, emotion ranges, markers, automation, operations with their job
children, and DAW links. It also carries the picture sequences the sessions sit
on, and `manifest.files` lists every carried file with its sha256. Import is
built so that nothing points back at the machine it came from:
- **Files are verified first.** A damaged file refuses the whole import,
  naming it, and nothing is written.
- **Every exported id is replaced wherever it appears**, in a column, inside
  JSON (operation params, asset metadata, a sequence's shot list) or inside a
  path. The old importer remapped only declared foreign-key columns, so a
  scene-scoped asset's `scene_id` was never remapped. Its insert failed
  silently, and scene music vanished from every bundle.
- **Every path column is rebuilt under this machine's data directory**
  through `data-paths`' own `tailOf`.
- **Foreign keys are checked over the inserted rows inside the transaction.**
  Rows can land in any order, which matters because clips and operations
  reference each other. A broken score reference rolls everything back, while
  older tables keep their tolerance: a reference to something the bundle does
  not carry is cleared or dropped, and reported.
- **Mtimes are kept, and bounces are re-stamped.** A file's identity is part
  of the bounce fingerprint, so a copy that reset it would read as new work.
  Each bounce that was current in its stems mode at export is re-stamped
  against the new ids, so an approved score is not reported stale for having
  moved. Without the re-stamp it is, and the test holds that.

`tests/music-bundle.test.js` proves it by doing it. A real scored film is
exported, the original's rows and files are deleted, and the bundle is
imported. The copy then reopens with its approval still `ok`, plays its score
bed from this machine, refuses an unforced rebounce as unchanged and renders a
forced one, still validates its score package, and reassembles a master with
the score measured where it belongs.

### A Score That Leaves Film Engine and Comes Back: the Portable Package
The epic puts **portable interchange first**: before any DAW adapter there is a
package any DAW, or any person, can open. `lib/music-package.js` (MUS-015)
builds one archive per session state: a versioned, DAW-neutral `manifest.json`
beside equal-length 48 kHz / 24-bit **Broadcast WAV** stems aligned at sample 0,
the master, and the reference picture when the film has a conformed master.
`MANIFEST_SECTIONS` is the manifest's own registry: format, version, package,
session, operations, picture, timing, markers, tracks, stems, master, emotion,
rights, provenance, files and matching. Every one is written, and a package
missing any one is refused by name.

**The stems are the session's own bounce.** The package reuses the
instrument-mode bounce whose fingerprint is the session as it stands, and
renders one only when there is none. A package that mixed on its own would be a
second statement of what the session sounds like, and the two would come to
disagree. Each stem gains a `bext` chunk with time reference 0 and a description
that leads with the stem's matching key (`fe:track:<id>`). The key goes in the
256-byte Description because the 32-byte OriginatorReference cannot hold it.

**Deterministic.** Stored entries in sorted order, the DOS epoch as every
timestamp, a manifest with sorted keys and nothing that varies with the clock:
the BWF origination stamp is the bounce's own completion time. The same session
therefore packages to the same bytes, and a rebuild finds the package it already
made by hash and registers nothing. A build is recorded as a `push` operation
with `params.kind: 'package'`; `film_music_operations.kind` cannot be widened in
place, and a package is the DAW-neutral push.

**Validation is the gate.** Every listed file must be present with its hash and
size, nothing unlisted may be in the archive, every stem must be a WAV at the
package's sample rate and exactly its length, and the format and version must be
ones this engine reads. An import validates first and writes nothing on any
refusal. **The round trip lands takes, never replacements.** Into the session a
package came from, each stem finds its track by key and lands as a candidate
take in that track's group, and a key whose track is gone gets a new track. Into
a new session, the tempo and time-signature map, markers and accepted arc are
restored and every stem is aligned at the start, stored byte-identical with its
hash and its most-encumbered source's rights.

Served at `POST /film/music-sessions/:id/package`, `GET …/packages` and
`POST /film/projects/:id/music-packages/import` (with `validate_only`), and as
`music_package_build`, `music_package_list`, `music_package_validate` and
`music_package_import` (**324 tools**).

### Every AI Action on the Score Page Shows Its Plan, and "No" Names the Provider's Reason
The workstation could generate, separate, inpaint and regenerate over HTTP and
MCP, and a director at the Score page could do none of it. MUS-014 adds an **AI
actions** panel and a **Jobs** panel. `SCORE_AI_ACTIONS` is the one registry:
the arc proposals, a whole score, the selection (a track, or an emotion range's
span), native parts, separation, a cue from a reference, a cue from the
picture, inpainting at the playhead, regenerate-as-a-new-take, A/B audition and
take approval. Each entry says what it does, whether it spends, and what it
needs selected.

**Three rules, held set-wise by `tests/music-ai-controls.test.js`.** A spending
action goes through the **one shared confirmation**. That confirmation reads the
free plan first and shows the provider and model, the direction, tempo, meter,
key and accepted arc, the length, the outputs and their kind, where they land,
the cost, and the take behaviour. `confirmPaidImage` learned two things to do it:
a plan whose input is structured is read with a POST (`previewBody`), and a
caller can `describe` its plan instead of being offered image dials that would
reach nothing. A failed plan read still leaves the gate disarmed, which is how an
unaccepted arc or an unsupported workflow is refused before any spend. An action
the project's provider cannot do is **disabled with that provider's own reason**,
never hidden and never attempted; one that needs a selection says what to
select. A free action reaches no paid endpoint.

**Proposing the arc stays the agent's job.** The panel lists pending
proposals with their rationale, and a person accepts or rejects them there. The
engine calls no model. **A/B audition changes what is heard, not what is
saved**: `mwHeard` plays the auditioned take in its group's place, and nothing
is written until a take is approved. Regenerating reads the recorded input of
the job that made the clip and lands the result as a candidate on the same
track. The jobs panel shows each job's children with take number and
acceptance, offers **Check** on a running job and **Retry** (through the same
confirmation) on a failed one.

The spending functions are `scoreAi*`, never `mw*`. The MUS-007 rule that the
workstation's editing and playback functions reach no paid endpoint still holds
over every `mw*` function, and the new test re-asserts it.

### A Job Is a Parent With Ordered Children, and the Parent Cannot Lie
A generation that makes three parts, or a separation that returns six stems,
used to be one operation row with its outputs folded into a JSON blob. That
made two questions unanswerable: which output a failure belonged to, and
whether a row reading `complete` actually had every output behind it.
Migration 107 lets an operation be a **child**: `group_id` points at its parent
(CASCADE — a child means nothing without it), `seq` orders the siblings, and
each child carries its provider, model and provider job id, its cost, the
`attempt` it belongs to, the `source_fingerprint` and `context_fingerprint` of
what it was made from, its `take_number`, and the clip it became
(`output_clip_id`, SET NULL so deleting a take keeps the record that it was
made). `group_id` is deliberately not `parent_id`: `parent_id` is already the
lineage of a retry or a supersession, and one column holding two relations is
how "retried" gets read as "is part of".

**The parent's status is derived** (`lib/music-jobs.js`, MUS-013).
`deriveStatus` is the one rule: complete only when there is at least one child,
every child is complete and none the parent expected is missing; running while
any child is open; failed otherwise, with a reason naming the child. The stored
status is a cache of that answer — `readJob` reports the derived status, flags
a stored one that disagrees, and `rollup` repairs it — so a failed child cannot
leave a parent reading as complete however the row was written.
`tests/music-jobs.test.js` proves it as a **truth table** over every combination
of the five operation states for up to three children and every expected count,
because a rollup that gets "two done, one failed" right and "all done, one
missing" wrong passes any example written against the first.

**Acceptance is read, not copied.** A child's acceptance is its clip's own
`take_status` — selected is accepted, candidate is pending, rejected is
rejected, a deleted clip is removed — so the job record cannot disagree with the
arrangement. The **take number** is the clip's place in its take group: a
second take on an occupied track is take 2. One bad part fails its child with
the reason and **cancels** its siblings, naming the part that failed, because
registration stays all or nothing; a provider failure fails every child.

**Resumable.** A run this process owns is registered while it is in flight.
Polling a job no process owns any more — the server restarted mid-run — reports
it **interrupted** and fails its open children, rather than leaving a row that
says running for ever. Retrying a failed job runs it again as the next attempt
from the input it recorded, with `parent_id` naming the attempt it retries; a
running or complete job is refused. Every music provider wired today answers
synchronously, so there is no provider handle to collect after a restart; one
that returns a handle would be polled through the same record.

The listings of generations and separations show parents only. Served at
`GET /film/music-sessions/:id/jobs[/:opId]`, `POST …/jobs/:opId/poll` (free) and
`POST …/jobs/:opId/retry`, and as `music_job_list`, `music_job_get`,
`music_job_poll` and `music_job_retry` (**320 tools**). The cue-generation job
table, `film_music_jobs`, is the older per-cue path and is unchanged.

### Five Ways to Make Music, and a Take Is Added, Never Swapped In
`lib/music-generation.js` (MUS-012) is one free plan and one runner for the
five generating workflows of the `music` capability: a whole cue, the
provider's native parts, a cue conditioned on an audio or melody reference, a
cue conditioned on the picture, and a range of an existing clip regenerated in
context. Separation is the sixth and stays in its own module, because it is a
derivative of a recording rather than a new performance.

**The provider's own contract decides.** A workflow the project's provider
does not declare available is refused with that provider's reason and never
attempted. Today every registered provider serves composition and nothing
else, and the test holds each workflow to being planned exactly when the
contract says available, so the other four arrive the day a provider declares
them, with nothing to rewire.

**Nothing is generated from an arc nobody accepted.** The accepted emotional
arc is the context and a proposal never reaches a request, which the test
checks by planting a proposal with a label that must appear in no payload. With
no accepted arc the plan refuses `EMOTION_NOT_ACCEPTED`; `ignore_emotion` goes
without one and the plan says so in its warnings.

**The session's context travels.** The opening tempo and meter from the
session's tempo map, the key the caller states, the arc as time ranges, and —
where the provider declares section limits, as ElevenLabs does — the arc as
the composition plan's sections, so the cue changes where the director said the
feeling does. A range under the provider's minimum folds into its neighbour, a
gap is held as its own section, and the sections always sum to the length.

**A take is added.** Every output is a new file, asset and clip. On a track that
already holds something the new clip is a **candidate** in that track's take
group, so what was heard is still what is heard until a person selects
otherwise; on a new track it is selected, since there is nothing to replace. An
inpainted range lands on the source track over exactly the range it rewrites,
with the range translated into the source file through the clip's offset. The
source file, asset and clip placement are never touched. **A native part is not
a separated stem**: `source_kind` and `metadata.kind` come from the registry's
own output taxonomy. A provider error, bytes that are not audio, or a failed
registration leaves a failed `generate` operation and nothing else.

Served at `POST /film/music-sessions/:id/generate/plan` (free; a POST only
because its input is structured), `POST …/generate` and
`GET …/generations[/:opId]`, and as `music_generate_plan`, `music_generate`
and `music_generation_list` (**316 tools**). `tests/music-generation.test.js`
is set-based over the generating workflows derived from the registry, against a
fake provider with a full contract and against every real one.

### Separating a Recording Makes a Derivative, and the Recording Is Kept
A clip on a score session can be split into two stems (vocals, instrumental)
or six (vocals, drums, bass, guitar, piano, other) by ElevenLabs — the only two
`stem_variation_id` values the live endpoint accepts, established by a 422
probe that costs nothing. `lib/music-separation.js` (MUS-011) is built around
one rule: a separation ADDS beside the source and never edits it. The source
file, its asset row and its clip are untouched; each returned stem becomes one
asset (`kind: separated_stem`, `derived_from` the source, lineage naming the
operation and variation), one track with a role, and one clip at the SOURCE
CLIP'S placement — same start, same offset into the file, same length —
because a separation is sample-aligned with what it came from and a stem
placed anywhere else is the recording moved. Rights follow: the stem's asset
takes the source's licence status and gets a rights row copied from the
source's, noted as derived.

**The provider answers with a ZIP, and a ZIP is untrusted bytes.** It is read
by its own central directory, not by a library that would write where the
archive says: an absolute or `..` entry name refuses the batch; an entry whose
declared size passes the per-stem cap is refused before it is inflated, and
inflation runs with a ceiling one byte past the declared size so a lying header
cannot expand past it; a length or CRC that disagrees is refused; every
entry's bytes decide what it is. A non-audio entry (a README) is ignored and
named; an entry named as audio that is not refuses the batch and names it. A
compression RATIO is deliberately not a refusal — a silent stem compresses a
thousand to one, and a bomb check that fires on silence fires on every vocal
stem with rests in it. A stem the variation did not promise is registered and
named rather than dropped.

**All or nothing, and retryable.** One `separate` operation per attempt. A
provider error, a bad archive, a stem the encoder cannot read or a failed
registration leaves it FAILED with the reason, with no asset rows, no tracks
and no files. A retry is a new operation whose `parent_id` names the failed one,
and only a failed separation can be retried. The start answers at once with a
running operation — the provider takes as long as it takes — and the status
catches up.

`music_separate` flips from planned to **available** in the ElevenLabs
contract with its limits: stem counts `[2, 6]`, `max_input_ms: null` because
the provider publishes no input ceiling (null is the stated absence, not an
invented number), and the formats the stem importer sniffs. The multipart call
shares the adapter's retry-once rule (5xx and 429, never a 4xx) and is metered
as music seconds at the variation's multiplier: two stems are documented at
half a generation's cost, six are not separately priced and are held at the
full rate, marked inferred. Output is held to `mp3_*`, because a `pcm_*` entry
inside an archive may be headerless samples the sniffer cannot identify, and
that shape is unverified.

Served at `GET /film/music-sessions/:id/separations/plan` (free), `POST
…/separations`, `GET …/separations[/:opId]` and `POST
…/separations/:opId/retry`, and as five tools (**313 tools**).
`tests/music-separation.test.js` is set-based over both variations and over
the failure set — traversal, an absolute name, an inflation past the cap,
a mislabelled non-audio entry, an empty archive, bytes that are not a ZIP, a
provider 5xx — each of which must leave a failed operation, no assets, no
tracks and no files. The adapter half runs against a stubbed fetch with the
real endpoint contract, so nothing is bought to prove a ZIP is unpacked.

### Six Ways to Make Music, and "No" Is an Answer With a Reason
The engine had one music capability — a whole cue from a prompt — and the
workstation needs six ways of making music: compose a cue, generate its native
parts, separate a recording into stems, condition on a reference, condition on
the picture, regenerate a selected range. Which of those a provider serves is a
**fact about the provider**, and it has to be discoverable before anything
spends: a workflow silently unsupported is a button that fails at the provider
with a message that reads like a credential problem.

**They are workflows of the `music` capability, not six new capabilities**
(`lib/music-capabilities.js`, MUS-009). A capability here is twelve registries
— the cost gate, the canvas node types, the taxonomy, the rate book, the
readiness brief and four derived denominators — and five of these six have no
provider serving them today; adding them there would put five nodes on the
canvas and five rate rows describing things that do not exist, which is the
`stock` mistake already paid to undo. Instead every adapter that serves
`music` declares a contract answering for **all six**: `available` with its
limits and their source, `planned` (the provider offers it, the adapter has
not wired it — the next task, named) or `unsupported`, each with a reason.
`validateContract` refuses a seventh workflow, an unknown status, or an
available workflow with no limits, and `tests/music-capabilities.test.js`
derives the adapters from `providers.list()` so a music adapter added later
must answer or fail.

**Discovery is per project and free** — `GET /projects/:id/music/capabilities`,
`music_capabilities`, and a Provider panel on the Score page. For the
project's own provider it answers every workflow with status, limits, a cost
hint that is the rate book's own row (or an honest null with the reason — a
self-hosted gateway bills nothing, a planned workflow is not priced), the
neutral plan and result schemas, and which other providers could do it. A
pinned provider that does not resolve today (the local gateway is opt-in) is
still the one answered for, and the answer says it did not resolve.
`unsupported()` is the one refusal shape every caller returns: workflow,
provider, status, reason, alternatives — and `null` for a workflow the
provider serves.

**The schemas are neutral and the taxonomy is the clip table's own.** A plan
speaks in the session's terms — a session, a track, a length in milliseconds,
a range, an asset — never a provider's field names. Every output kind lands
as one of `film_music_clips.source_kind`, held equal in both directions: a
generated part, a separated stem and a rendered delivery stem are three
different things and must stay three words. `validatePlan` refuses a plan
outside the provider's own limits with the field named — a cue past `max_ms`,
a stem count the provider does not offer, an inverted inpaint range.

**Every call site of the music capability is named.** `MUSIC_CALL_SITES`
lists each place that resolves `music` with the workflow it performs, and the
test derives the set from the source in both directions, so a fifth call site
arrives named or fails — the gap-named-is-work rule.

The browser monitors a score session through an audio context; the film is
delivered from a **file**, and the two must not disagree. `lib/music-renderer.js`
(MUS-008) renders the session's rows into one ffmpeg graph: a 48 kHz, 24-bit
stereo master plus the chosen delivery stems, registered with the parameters
that made them.

**Planning is pure and separate from rendering**, the split the conform
already makes. `planBounce` reads the read model, decides what is audible and
why the rest is not, groups the stems, fingerprints everything, and touches no
file — so `GET …/bounce/plan` and `music_bounce_plan` can say what a bounce
WOULD do for nothing. `buildBounceArgs` turns the plan into an argument array
(names come from the database, never a shell string) and `runBounce` runs it,
validates every output before registering anything, and records it.

**What is audible is one rule, and it is the page's rule.** Track and clip
gain sum in dB along the routing chain; a mute anywhere on the chain silences
the clip; a solo anywhere in the session silences everything not soloed; only
the **selected** take plays; reference and picture tracks are guides that
never reach the mix. Every clip left out is **named with its reason**, because
a bounce that quietly dropped a muted track and one that quietly dropped a
broken one look identical afterwards.

**Nothing is normalised.** `amix` scales its inputs by their count by default,
so two tones would come back 6 dB down and a lone clip's level would move
whenever a clip was added beside it. `normalize=0`, and the session length is
carried by a silent base input per output, so the master and every stem are
exactly the session's length — the equal-length interchange baseline is a
property of the graph rather than a check afterwards. Loops repeat the source
region with `aloop`; fades are `afade` ramps inside the clip; a pan is a
channel coefficient; gain and mute **automation** are rendered as per-frame
`volume` expressions. Pan, send and filter curves have no per-frame filter
here and are **reported as not rendered** with the static value used.

**A bounce is a take.** Each render is a new operation with a new version and
new files; earlier masters stay registered and on disk, and the new one names
what it supersedes. The fingerprint covers everything the render reads —
placements, levels, fades, loops, automation, the files' own identity — so an
unchanged session is **refused with 409 `UNCHANGED`** rather than rendered
again, and a changed one renders without anyone saying what changed. `force`
renders it anyway as a new version. A failure leaves a **failed** operation
naming why, registers nothing and deletes what it wrote.

`tests/music-bounce.test.js` **produces a file and measures it** for every
case the epic names — silence, overlap, fades, solo/mute, pan/gain, failures,
rerender versioning — and is set-based over `STEM_MODES`: silence is a level
below the noise floor, a fade is the head measured against the body, a pan is
a channel that is silent while the other is not, and two equal tones sum to
+3 dB, which is what proves nothing is normalised. Its first "heard"
threshold was typed from memory (−12 dB) and wrong: ffmpeg's sine source plays
near −24 dB, so a heard clip measures −30 — the threshold now sits between
what the fixture produces and what silence measures.

Served at `GET /film/music-sessions/:id/bounce/plan`, `POST …/bounce`,
`GET …/bounces[/:opId]`, and as `music_bounce_plan` / `music_bounce` /
`music_bounce_list` (**303 tools**).

### The Score Has a Keyboard
The score session had a route (MUS-004), thirty tools (MUS-005) and an
importer (MUS-006), and no page: every track, clip, range and marker could be
written by an agent and by curl and by nobody at a keyboard. `manual-edit`
could not see the gap — it derives editable fields from handlers that read
`body.x`, and this route goes through validators — so the **Score** page
(`musicws`, in Production beside the cue sheet; MUS-007) is held to the
validators themselves: the value keys each one returns are the fields the
database will take, and `tests/music-workstation-editor.test.js` EXECUTES the
inspector over a fixture session with one row of every kind and requires a
control, bound to the autosave, for every one of them. A grep for the literal
would report the working editor as broken, because the controls are built as
`data-mw="${table}:${field}"` at run time — the same reason the blocking
panels are executed rather than grepped.

**One rule for every control.** It carries `data-mw="<table>:<field>"`, its
change reaches `mwFieldChanged`, and that reaches `mwSave`, which PUTs the row
through the session route — the same validator the agent's write meets, so a
refusal names the field here exactly as it does there. Saves are per row and
debounced (a slider fires dozens of changes a second), and the status line says
*Saving / Saved / Save failed: <reason>*; a failed save reloads the session,
because a director who believes a mix is kept when it is not is the failure the
line exists to prevent.

**Nothing is decided on the page.** Enums, ranges and the lifecycle table come
from `GET /film/music-sessions/vocabulary`, on the `card-vocabulary` precedent:
a page holding its own copy offers values the route then refuses, and the
refusal reads as saving being broken. The status picker offers the current
state and only the moves `TRANSITIONS` allows from it. An AI emotion proposal
is drawn dashed and stays `proposed` until a person changes its status in the
inspector; the page never writes `accepted` on its own.

**One ruler.** The shots come from the brief (`/brief`), the hit markers from
the session, the emotion ranges sit on the same scale, and one playhead moves
by clicking the ruler or double-clicking a lane. A clip is positioned by
`start_ms` and sized by `duration_ms`; dragging it moves it, dragging an edge
trims it (the start edge also moves `source_offset_ms`, so trimming never
touches the file), and each carries the sound library's own waveform canvas —
a second painter is how two surfaces come to disagree about what a file looks
like. Takes in a group are one click apart, through the batch route so the
old selection and the new one change together.

**Playback spends nothing.** Clips are decoded once into an `AudioContext`
and scheduled from the playhead with their own source offset, gain, pan, fades
and loop policy. `mwClipLevel` is the one rule for what a clip plays at — track
and clip gain summed in dB, mute, solo across the session, pan — and the test
executes it: a track is silent while another is soloed, −6 dB is half
amplitude, a fade is a ramp in seconds inside the clip. A mixer change while
playing re-schedules from where the playhead is.

**Stems are dropped on the lanes**, aligned at the playhead, through the
MUS-006 importer with the 48 kHz working copy as a checkbox, after
`checkUploadSize` refuses an oversize file on the page rather than as a dead
server. An existing audio file — a generated cue, a library sound — can be
placed on a track whole. Drift is a banner with the rebase beside it; the
brief is the context panel: shots with timings and cameras, the exact
screenplay passages, the cast, the cues written, the accepted emotion.

**Two of the test's own checks were wrong first.** The stripper used a
block-comment regex, and the import control's `accept="audio/*"` opened a
"comment" that ran to the next `*/` and swallowed the session selector — the
trap the page-handlers stripper already recorded; it is line-based now. And
a first mutation that "removed" the pan control matched nothing because the
text sits mid-line; the pan control lives in two places, and only removing
both fails the audit, which is what proved it reads the rendered set.

### The Original Is Sacred; the Placement Is Aligned
A composer hands over stems — several equal-length files sharing one start —
and the one thing an importer must never do is help. `lib/music-stems.js`
(MUS-006) is built around four refusals to help.

**The bytes decide.** `STEM_FORMATS` sniffs WAV/BWF (`RIFF`/`RF64` + `WAVE`),
AIFF (`FORM` + `AIFF`/`AIFC`), FLAC (`fLaC`), MP3 (ID3 or a frame sync) and
M4A (an `ftyp` whose brands name M4A — `isom` alone is what a VIDEO carries),
and the stored extension follows the bytes. A `.wav` that is an MP3 decodes as
noise the day something reads it as PCM; a `take.bin` that is a BWF is a
perfectly good stem. The declared name and MIME are recorded and trusted for
nothing, which is the rule `media-imports.js` already follows for footage.

**The original is stored byte-identical**, hashed with sha256, under a unique
name so nothing ever overwrites it, and every technical fact — duration,
channels, sample rate, bit depth, codec, bitrate — is read from the file by the
encoder. Bit depth is a fact only about a lossless container: a lossy codec
reconstructs its samples rather than storing them, so an MP3 reports `null`
rather than a number somebody would budget a mix against.

**The working copy is optional and recorded.** `normalize_48k` writes a
48 kHz / 24-bit PCM derivative BESIDE the original with `derived_from` and the
resampling (`{ from, to }`) in its metadata, and the clip plays the working
copy so the session runs at one rate. A lossless file already at 48 kHz gets
none and says so — resampling a file to itself is a copy with a lie attached.

**The placement is aligned.** One track and one clip per file, every clip at
the same `start_ms` with `source_offset_ms` **0** and the measured length, in
the order the files were given. Leading silence survives because nothing
touched the bytes; the validator's own comment on `source_offset_ms` says the
same thing from the other side.

**Rights are recorded, never assumed.** A `film_rights` row per original
(`music` / `music_license`); no declaration is written as `unknown`, which is a
recorded answer rather than an absence, and a status the register does not
know is refused naming the field rather than stored as prose. **A stem is
deliberately NOT put on a scene**: `film_assets.scene_id` is what the sound
sheet and the timeline read to lay a scene's bed, and a stem with a scene id
would be picked up as the scene's newest music and played under the cut. It
belongs to its session through the clip and `metadata.session_id`, and reaches
the film only through a bounce.

**One operation, one transaction, or nothing.** A batch is one `import`
operation and every row lands in one transaction; a refusal — one unreadable
file, one illegal rights status — writes no rows and leaves no files, and names
the file. The test plants a file that SNIFFS as a WAV and decodes as nothing,
so the good file beside it is already on disk when the batch is refused —
which is what makes the cleanup assertion real; a garbage file refused at the
sniff never exercises it, and the first version of the test did exactly that.

BPM and key are hints — from tags first, the filename second — stored as
hints, so nothing paid rests on a `120bpm` somebody once typed into a name. A
bare `C` in a filename is not read as C major: `take_C` is take C, and a hint
that fires on every capital letter is one nobody trusts. A role is inferred
from a short instrument vocabulary in the name and an explicit `role` wins.

Served at `POST /film/music-sessions/:id/stems` (the path carries files, so it
takes the file ceiling rather than the JSON one — added to
`FILE_CARRYING_SEGMENTS` and to the page's mirror of it) and as
`music_stem_import` (**300 tools**). `tests/music-stem-import.test.js` is
set-based over `STEM_FORMATS`: every format is built for real with ffmpeg at
44.1 kHz with 250 ms of leading silence, imported under a name that lies about
it, and held to the same rules — byte-identical, true extension, measured,
hashed, offset zero, common start.

### The Score Session Over MCP Is Derived, Not Typed
Twenty-nine tools (**299 tools**) put the score session in front of an agent:
nine for the session and, for **every** child kind the HTTP route exposes,
list / create / update / delete. The set is generated from the route's own
`CHILD_KINDS` and the contracts' own vocabulary, so a kind added to the route
arrives on MCP with its schema, and a schema cannot say something the database
refuses: every enum is `VOCABULARY`'s list and every bound is `RANGES`'. Each
table's fields come from its validator's own defaults rather than a second
list. All twenty-nine dispatch **through** `handleMusicSessions` by the same
in-process shim every route tool uses — nothing is reimplemented beside it, and
no tool here calls a model, so `mcp-no-server-llm` stays green by construction.

Three of the repo's standing rules shaped the set. A delete with no list or
get is *blind* — an agent can remove only what it created in the same
conversation — so every kind has a list. Every create is paired with its delete
in the decision list. And the session entity is in the entity-route registry,
so a verb the route dispatches and no tool reaches fails there rather than
being noticed months later.

Reads and the brief say **free**; mutations say what they write; drift
promises it changes nothing and rebase says it is the explicit act.

`routes/music-sessions.js` is the first consumer of the contracts and the
brief, and it adds nothing of its own: a write is a validator's verdict from
`lib/music-session.js`, a read is `readScoreSession`, drift is `sessionDrift`
and the rebase is `stampSessionContext`. A route that re-derived any of those
would be the second shape of one thing this epic exists to prevent, and the
MCP tools (MUS-005) will dispatch *through* this handler rather than beside it.

**Every write is scoped.** A session belongs to a project; a child belongs to
a session, directly or through the track it sits on. A row reached through
another session's URL is **not found** — not forbidden — and a clip cannot be
placed on a track of another session. `CHILD_KINDS` is the registry of child
URL segments, each naming its table and its owner, and the test holds it equal
to the schema's child tables so a table added to the migration arrives on the
API or fails.

**A session is stamped on create** with the brief it was written against, so
drift is sayable from the first read; the brief may carry warnings (no
screenplay yet) and they travel with the answer rather than stopping the
create. The lifecycle goes through `canTransition`: a draft cannot be
approved, and the refusal is a **409** naming both states.

**The batch is ordered and atomic.** Ops run in one `better-sqlite3`
transaction, `$n` in an op's `id` or `data` names the id produced by op *n* —
so a track and the clips on it are made together — and any refusal rolls back
everything and is reported with `failed_at`. The test builds a batch whose
third op is a zero-length clip and holds the first two unwritten.

**One audit deliberately does not see this route yet.** `manual-edit.test.js`
derives editable fields from handlers that read `body.x` directly; these
handlers go through the validators, so their fields are outside its
denominator. The controls belong to the multitrack editor (MUS-007), and that
task must wire a control for every field the validators accept.

### The Score Brief Is Compiled Once, and Every Field Says Where It Came From
`music_brief` reads a handful of scene facts. A score session is written
against an **ordered sequence**: the exact screenplay version and passage of
every scene it covers, the shots in the sequence's own order with their
measured or written timings and the camera each is actually generated with,
the cast and how much they talk, the film's look and optics, the cues already
written with their sections, the accepted emotional arc, and the themes
already made anywhere in the project. `lib/music-context.js` compiles all of
it into one neutral `ScoreBrief` and decides nothing about what it should
sound like — the connected agent is the model, and a brief is facts.

**`BRIEF_FIELDS` is the registry.** Every field declares its source tables,
what it is, and whether it bears drift; the compiler returns exactly those
fields, a provenance entry per field naming the rows it was read from, and a
fingerprint per field. Three coarse fingerprints sit over them — `script`,
`picture`, `context` — so drift can say **which side moved**: a screenplay edit
moves `script` and not `picture`; a reorder does the opposite.

**A change that reaches no music does not move the fingerprint.** A project
rename, a scene's status, a session's name, and above all an AI emotion
**proposal nobody accepted** are non-inputs, and the test holds each of them
to leaving the fingerprint alone. A warning that fires on work nobody needs to
redo is one people learn to dismiss, and then the real one is dismissed with
it. Ids and file names are identity, not content, and are hashed out: a motif
re-registered under a new asset id is the same music.

**Drift is reported, never applied.** `sessionDrift` compares what a session
was stamped with against a fresh compile and writes nothing; a session with no
fingerprints is `tracked: false` and not drifted, or the warning would fire on
every session on the day this shipped. `stampSessionContext` is the explicit
rebase, on the precedent `screenplay-drift/baseline` set. Durable generation
reads **applied** previs blocking only; an experiment on the stage is not the
camera a shot will be generated with.

`tests/music-context.test.js` derives its denominator from the registry: every
drift-bearing field has a real mutation — a new script version, a reorder, a
new name on a card, a line of dialogue, a look change, a cue edit, an accepted
range — that must move the field's own fingerprint and be named by
`compareContext`, and every non-input must not. The first version's cast
mutation added a name already in the cast through another shot, which moved
nothing and would have passed as a defect in the compiler; it adds a stranger.

### The Music-Domain Contracts Are the Schema's Own Vocabulary, Read Once
`lib/music-session.js` says what a session, a track, a clip, a tempo map, an
emotion range, an automation curve and an operation *are*, provider-neutrally
— nothing in it knows ElevenLabs, Ableton or ffmpeg — and `readScoreSession`
is the **one** read model every consumer receives: HTTP, MCP, the page, the
bounce, bundles and DAW adapters. Two shapes of one thing is how the board
and the viewer came to disagree about their own markup tools.

**The vocabulary is not typed twice.** Migration 105 declares every lifecycle
value as a CHECK and every bound as a range CHECK; the library's `VOCABULARY`
and `RANGES` are the same sets, and `tests/music-session-contracts.test.js`
reads the CHECKs out of the migration file and holds the two equal in **both
directions**. A value the validator accepts and the database refuses is a 500
on save; one the database accepts and the validator refuses is a row nobody
can write through the API.

**Lifecycles are transition tables, and every state is in them.** A session is
signed off from review, never straight from a draft, and approval can be
reopened — a lock nobody can get past is a lock nobody sets. A finished
operation is terminal: a new attempt is a new row, with its own lineage. A
refusal names both states and what the current one may become.

Three rules the validators hold that the schema cannot. **A clip is whole
milliseconds with a positive length and fades that fit inside it** — the cut
is in milliseconds, never beats. **A tempo map starts at zero, is sorted, and
has no two changes at one instant.** **An AI emotion proposal defaults to
`proposed`, never `accepted`**: nothing paid may rest on a curve no person
reviewed, and the default is exactly where that would slip through.

Serialisation is one pair, `toRow` / `fromRow`, and `JSON_COLUMNS` is the
registry of which columns hold JSON; the test derives every `*_json` column
from the migration and round-trips each. A JSON column that will not parse
reads as **empty and named** in `warnings`, never thrown — a corrupt tempo map
must not take the whole session read down.

### The Score Session Is a Schema, and the Schema Is Held to Itself
`film_music_cues` models one cue: a type, a direction, a length, one generated
asset. A soundtrack is not one cue. Migration 105 (numbered 105 rather than
the epic's 103, which had landed under the pipeline work) adds the seven
tables a score session needs — sessions, tracks, clips, emotion ranges,
markers, automation, and an operation lineage — and three rules run through
every one of them.

**Every foreign key declares what happens on delete.** A key with no action is
the `film_refsheet_jobs` trap of migration 067: a project delete that 500s the
first time the project has real work in it. CASCADE where the child is
meaningless without its parent (a track without its session); SET NULL where
the child is work that cost money and must outlive a pointer. So a session
whose picture sequence is deleted keeps its arrangement and its fingerprints,
and a clip whose asset is deleted keeps its placement and says the source is
gone — the arrangement is the work, the file is replaceable.

**Every lifecycle value is a CHECK**, because a free-text status is three
spellings of one state within a week. Session status, clip source kind (the
three stem meanings the epic requires to stay explicit — native part, separated
derivative, rendered delivery stem — plus a whole generated cue and an import),
take status, emotion source and status, marker kind, automation parameter,
operation kind and status. Ranges are CHECKs too: pan in −1..1, valence in
−1..1, arousal, intensity and confidence in 0..1, and an emotion range that
ends before it starts is refused at the row.

**`film_assets` is not touched.** Its `asset_type` CHECK cannot be widened in
place, so what a clip's audio *is* lives on the clip and in asset metadata, the
way the 3D work types a mesh.

`tests/music-workstation-schema.test.js` is set-based over the **migration
file**: every table it creates gets a row built with its parents on demand,
every `CHECK (col IN (...))` has each value accepted and an unlisted one
refused, every range CHECK is probed at both ends and one past each, every
foreign key is read from `PRAGMA foreign_key_list` and its declared rule is
exercised by deleting the parent. A column added later is in the denominator
with nothing to remember. The parser first read only quoted enum values, which
would have left the numeric CHECKs — sample rate, the mute and solo flags —
outside the set; it reads both now.

### A Capability With No Provider Is a Claim the Preflight Cannot Check
`stock` sat in `CAPABILITIES` from the day the provider layer was written and
**no adapter ever served it**: nothing searched a catalogue, nothing licensed a
track, nothing wrote `license_source = 'licensed_catalog'`. It still reached
twelve registries — a `$0.00` row in the cost gate, an `in.stock` node on the
canvas that executed to a skip, a settings-panel label, a canvas colour, a
readiness row, a dry-run line — and every one of them described a thing that
did not exist. A capability the preflight reports as *configured: none* on
every project forever is not a gap it can check; it is noise that teaches the
reader to skip the row, and the real gap goes with it.

The epic's choice was fill or remove. **Removed**, because the cheaper answer
here is also the honest one: an adapter is a licensing relationship with a
catalogue, and a capability should arrive with its first provider rather than
wait years for one. `stock` is gone from `CAPABILITIES`, the cost table, the
node types, the input handler, the dry-run, the dashboard filter that
special-cased it, the page's label and colour maps, and the docs. What is
deliberately **kept** is the rights model: `license_source` and
`licensed_catalog` are facts about where a file's rights came from, not about
which vendor generated it, and `tests/stock-capability.test.js` asserts they
stay independent of any capability.

That test is set-based over `CAPABILITIES` — every advertised capability must
have at least one registered adapter, so the next capability declared without
a provider fails at once — and its runtime scan is **derived** over every
`lib/`, `routes/` and entry-point file plus the page. The first version listed
two files by hand and passed while the page still carried two copies.

### A Failed Conform Says What Was Tried, What Was Not, and Why
`lib/image-fallback.js` reports `_chain` on failure — every provider, tried or
skipped, with its reason — because a message quoting only the first refusal
sends the reader to the wrong fix. The conform had the same shape one level
down and did not follow the rule. Two executors are probed, the local encoder
and the provider stitch, and a failure named only whichever one was reached: a
refused join said *"cannot read 1B.mp4"* and nothing about the provider path
sitting untried beside it, a no-executor refusal listed the probe while a
stitch failure did not, and the orchestrator dropped even that on the way to
the run row — a failed project run recorded `assembly` in a list of ids and
nothing else.

**Every failure carries `walk`.** One entry per probed executor, in the probe's
own order: tried with its error, or not tried with the reason (unavailable, or
*"not tried: ffmpeg was chosen first"*, or the provider stitch's own *"no
provider adapter implements a whole-film conform yet"*). A refusal at the
**plan** — a shot with no footage — carries an empty walk and `walk_stage:
'plan'`, because no executor was consulted and pretending one was is the lie
this exists to end. The error a person reads names each executor and what
became of it. `runConform` takes an injectable `probe`, the same reason
`preflight` takes `resolvers`: the encoder probe caches an available answer for
the life of the process, so the no-executor path is otherwise unreachable on a
machine that has one.

**And every surface forwards it.** The assembly step passes `walk` through
rather than flattening it to a line; `failureOf` is the one shape a failed
step is recorded as — id, code, error, walk — collected by both step loops;
the JSON runners answer `failures`, the SSE `step_failed` event carries it,
and migration 104 gives the run row a `failures` column plus one readable line
per failure in `error_message`, so a run read back later still says which
executor was tried.

`tests/conform-walk.test.js` is set-based over every failure state
`CONFORM_STATES` declares — each constructible one is built for real, and the
two that cannot be built here (`failed`, `no_clips`) are named rather than
silently untested — over the probed executors, and over the two `runConform`
callers derived from the source, through the route, the stream, the JSON
response and the run row.

### The Conform Is Projected, Not Omitted
Both projections that feed the 402 gate — `projectedCost` for a flow graph and
`buildRunPlan` for an orchestrated run — priced only the steps that call a
provider. `assembly` calls none, so it appeared in **neither**: not as a line,
not as a zero, not at all. Today that is free in provider credits, because
ADR-007 made local ffmpeg the sole executor. The moment a priced executor
arrives — a Gridlight endpoint, a provider stitch — the largest single
operation in the product would be waved through the gate that exists to stop
exactly that, and nothing would fail, because **an absent line is
indistinguishable from a free one**.

`LOCAL_STEP_COST` in `lib/flow-cost.js` prices every pipeline step that reaches
no capability, with its executor and its reason, and refuses to boot with one
left unpriced — the stance `COST_PER_CALL` already takes for a capability.
`LOCAL_STEPS` is derived from `PIPELINE_STEPS` crossed with the node-type
registry, so a second local step arrives priced or fails at load. The flow
projection carries each as a `local` line multiplied along fan-out, and the run
plan carries it as a `film` section — once per run, project-scoped, after every
strip, and **summed into `projected_cost`** so the budget gate sees it. The
run plan's `GENERATIVE_STEPS` is derived from the same registry rather than
excluding `assembly` by name, which is how the film became the one operation
the plan never mentioned.

`tests/conform-cost.test.js` is set-based over the derived local steps and
proves the gate **differentially**: pricing the conform moves the projection by
exactly what was added and, with a budget set between, refuses the run. A line
that is listed and not summed is decoration.

### A Missing Encoder Refuses the Run Before It Spends
SHIP-001 declared that `assembly` depends on `ffmpeg` and the preflight probed
it — through a resolver nothing could inject, so the one branch that turns *no
encoder* into a blocked stage was never exercised: replacing its verdict with
`go` failed no test, and the branch was keyed on the literal `'ffmpeg'`, so a
second declared dependency would have fallen through to `go` with nothing to
say otherwise. And the preflight is a CLI a person may not run. The runner
itself spent every generation step and found out at the **end**, at assembly,
that the film could not be joined — the most expensive moment to learn it.

`DEPENDENCY_CHECKS` in `lib/e2e-preflight.js` is the registry: how each
declared dependency is checked, and how its presence is resolved. A dependency
declared in `STEP_EXTERNAL_DEPENDENCY` and absent from it reads as **blocked**,
never ready. `preflight({ resolvers })` injects a resolver per dependency, which
is the only way to exercise the blocked path on a machine that has the encoder,
because the probe caches an available answer for the life of the process.

**The runner asks first.** A run that will execute a whole-film step — a project
run, or a shot or scene run that passed `include_project_steps` — checks that
step's dependency through the same `checkStageDependency` the preflight uses and
answers **409 `PREFLIGHT_BLOCKED`** before the run row exists, carrying the
probe's reason and the three remedies. A run that will not make the film has
nothing to preflight. `ignore_preflight` gets past it, the way every other gate
here does: the generation is still worth having, the conform can happen later on
a machine with an encoder, and the refusal then arrives from the step itself,
honestly, at the end. On the SSE runner the gate sits before the stream opens,
because a stream that ends in one event is a run that looks like it started.

`tests/e2e-readiness.test.js` is extended set-based over the stages that declare
a dependency and over the four run entry points derived from the router: blocked
with the remedies named, go when present, refused before a run row is written,
and not refused when the film was not asked for.

### A Deliverable Is One Artefact, Not a Count of Pieces
The broadcast QC's `video_master` once passed by counting per-shot video rows
— green on shot 1 of N — and was corrected to read the conformed film.
`audio_master` was left counting: any dialogue line, any cue, any per-shot mix
made it pass, so a project with one line of generated speech reported an audio
deliverable registered.

**And the conform read the mix the same loose way.** `planConform` took any
`audio_mix` on the project, and every mix the engine writes today carries a
`shot_id` — it is one shot's mix. Laid under the whole film it would play that
shot's sound over every other shot, and nothing would error. The project mix
route itself is a stub that lists eligible shots and produces nothing, which is
why no project-level mix exists on any real project: finishing happens in the
NLE, and the master ships with the clips' own audio until one is registered.

**The rule is stated once and read twice.** `findProjectMaster` and
`findProjectMix` in `lib/conform.js` say what the project-level artefacts ARE —
a `video_final` marked `kind: project_master`, an `audio_mix` belonging to **no
shot** — and both the QC and the conform find them through those two functions,
so the two cannot disagree about which file is the film's. `PROJECT_DELIVERABLES`
in `routes/qa.js` is the registry the broadcast checks iterate; each entry names
its asset type, its finder, and its verdict for absence: a missing film
**fails**, a missing project mix **warns**. The per-shot pieces are counted in
the detail so the reader knows what was declined, and never toward the verdict.

`tests/qa-master-checks.test.js` is set-based over that registry — absent,
decoyed by three per-shot pieces, present — because this arrived with exactly
one of two fixed. It also holds the QC's finder and the conform's to be the
**same function object**, not two queries that happen to agree today.

### The Film Is Made Once, at the End
`assembly` stopped returning `use export endpoints to finalize` and started
calling the conform. That closed the lie in the step and opened three more one
level up, all from one fact: the registry declared assembly **`scope: 'shot'`**,
and the runner does what the registry says.

A project run conformed the **whole film once per shot**. On a fresh run the
first N−1 attempts necessarily refused — later shots had no footage yet — each
was retried three times with backoff, and the run ended `completed_with_errors`
even when the last conform made the film. A single-shot run conformed the whole
film too, and refused, so every shot run during production reported errors
about a film nobody had asked for yet: the warning you learn to ignore. And a
refusal was retried as if it were a provider hiccup, when the conform is local
and deterministic and the same files give the same answer.

**The rule is the one scene scope already established, one rung up.** A step
runs by default on runs *at or above* its scope, once, and is skipped **with a
reason** below it unless the caller opts in — `include_project_steps`, the
sibling of `include_scene_steps`. Assembly's product is the film, so its scope
is the **project**: a project run makes it once, after every shot; a shot or
scene run says *"belongs to the whole film, not this scene — pass
include_project_steps to make it here"*. `PROJECT_SCOPED` is derived from
`PIPELINE_STEPS`, so a second whole-film step arrives covered.

**A run without a film is `failed`, not complete.** `runStatus()` is the one
rule, read by all three runners — the JSON shot runner, the SSE shot runner and
the scene/project runner each decided this inline, which is how the stream once
said `complete` while the JSON runner said `completed_with_errors` for the same
work. A failed shot step leaves a film with a hole in it (`completed_with_errors`);
a failed whole-film step leaves no film, which is the stance `persistStepResult`
already takes for a step that generated and could not save.

**Every outcome the conform can return is classified.** `CONFORM_STATES` says
whether a second attempt could change it, and only an encoder crash can; a
missing shot is still missing five seconds later. `runConform` now passes the
stitcher's own state through rather than flattening it to `failed`, because the
verdict is read from the state. `attemptStep` is the **only** retry loop, so the
no-retry rule holds wherever a step runs. And migration 103 adds
`steps_skipped` to the run row: the scene and project runners computed the
skipped list and stored nothing, so the one thing that distinguishes *did not
run, on purpose, for this reason* from *nothing happened* was thrown away the
moment it was known.

`tests/assembly-once.test.js` is set-based three ways, because each failure was
partial: over the project-scoped steps from the registry, over the four run
entry points derived from the router's own dispatch, and over every `state:`
the conform and the stitcher can return. Three of its checks asserted over an
empty set on the first run and passed — the registry had no project-scoped
step yet — so each now refuses to run over nothing.

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

### The Sheets, Against the Designs They Were Drawn From
*"Look at the design we showed you for the location and props, and how complete the character sheet is — you didn't finish it exactly like the designs I provided. Finish it."*

Correct. The first build derived its regions from labels **grepped** out of the handoff files, which produced ten headings and none of the structure underneath: one textarea where the design has six named, folding, character-counted sections; four pills where it has a plan of the room; a text field where it has material rows with colour swatches. It looked like the design in a screenshot and was not it.

**So the denominator is derived from the design files themselves.** Every uppercase mono label in a handoff is an element that design asks for — **18 on the location card, 19 on the prop card** — and the sheets are held to rendering all of them. If the design changes, the test changes with it, and no reading of mine sits in between. The two labels that are genuinely one film's content (*"The north window"*, *"01 · Master wide — south to north"*) are excused **by name, each naming the feature that renders the structure they are an instance of** — requiring them as page strings would hardcode one diner into the app.

`DESIGN_FEATURES` carries the **38** things that are not headings, each citing the phrase in the handoff it comes from — and a test reads the handoff and fails a citation that is not there, because a stale citation makes the registry a story.

**What was missing, and why each matters.** The set description is six documents, not one: *3855 chars* in a single textarea is unreadable and un-editable, so it folds per section with its own kind and its own count. The **orientation plan** is a plan — a plate carries no information about what is behind its own camera, so without it each side of a room is generated from prose that cannot say. **Materials are rows** with a role and a hex, because the colour is the half a painter and an image model both need and a comma string cannot carry one. **Continuity flags and constraints are lists**, because *"chalkboard stays blank"* and *"lettering reads reversed"* are two things a person ticks off, not one paragraph they re-read. Plates are **numbered, named slots**, so a view nobody has generated is a labelled gap rather than an absence.

**And the sections had to compose into `description`, or the sheet wrote where nothing generates from.** `buildPlatePrompt` reads `film_locations.description` and nothing else — storing six sections and leaving that column alone would take a director's whole set description and send none of it: the fields would fill, the plate would generate from an empty string, and nothing would say so. They compose in the template's order, and only when something is written, so a location described before the sections existed keeps what it had.

The design says **four different ways** what reaches the generator — *canonical · fed to generation*, *prompt source*, *→ prompt*, *not sent* — and that distinction is the whole difference between a sheet and a form. All four are rendered, and the test requires that at least one thing be marked as NOT reaching it: a box beside the visual prompt that looks like it conditions a frame and does not is worse than one that is absent.

Two supersessions are stated rather than left ambiguous. `continuity_notes` and the flat `materials`/`constraints` columns are still **read** as fallbacks, so nothing typed before the structured columns existed is lost — the sheet shows those lines as flags and rows. `continuity_notes` is no longer **written**: two columns answering *"what must stay true here"* is how they come to disagree.

One route change was forced by a test rather than by taste: `constraints_json` and `keywords` were accepted inside a `for` loop over field names, and the manual-edit audit derives its denominator from `body.<field>` in the source — so a loop accepts fields no audit can see, which is precisely the gap that audit exists to catch. Written out.

### The Card Got Complicated for No Reason
A character card carried **eight buttons** — Regen Image, Orbit Sheet, Views, Upload, Gallery, Voice, Edit, Delete — and clicking the card itself did nothing. Every one of those is something you do *while looking at* the character, and a 260px tile in a grid of twelve is a worse place to do it than a sheet with room. **Two buttons now: Edit and Delete.** Clicking opens the sheet.

Removing a button is only a simplification **if the thing it did still has a home**. `RELOCATED_ACTIONS` lists the six that moved, and the test holds each to being reachable from the sheet — otherwise "simpler" quietly means "gone".

Built to `design_handoff_character_card`: official views top-left, everything written top-right, wardrobe and palette beneath, and a full-width concept band across the bottom. `SHEET_REGIONS` names all six with an anchor the renderer must contain, because a sheet that draws the plates and silently drops the palette looks finished in a screenshot.

**Four official views, and the fifth problem they solve.** `VIEW_RANK` shipped with a single `side`, which is half a turnaround: it cannot say which way the character is facing, so two shots from opposite sides both resolved to the same plate. `side-left` and `side-right` are the real profiles. **`side` is kept ranked between them** rather than deleted — real projects hold plates under it, and dropping the name would leave pictures that cost money on disk and unreachable from the sheet. `canonicalView` folds the legacy names onto the four, and reads a lone `side` as the LEFT profile because a 90° orbit is where every existing one came from.

**A category is orthogonal to a role.** The gallery already answers *does this condition a frame* with reference/concept/inspiration; `REFERENCE_CATEGORIES` answers *what does it show* — sketch, costume, face, mood. Collapsing them would mean a costume study could not be promoted, or a promoted plate could not also be a face study, so the test asserts the two vocabularies do not collide.

**Wardrobe and palette were already modelled and had no surface.** `film_costumes` has carried `character_id`, `color_palette` and `reference_images` since phase 2 with zero rows, no UI and no MCP tools — the same declared-and-unreachable shape as the voice column. The sheet reads them, and says what to do when they are empty rather than rendering a blank region.

**A region with no way in is a label, not a feature.** Three of the six were read-only dead ends: the reference band could only be filled from another modal, wardrobe said *"no wardrobe recorded yet"* with no way to record any, and the palette said *"set one on a costume"* — pointing at `film_costumes`, a real table with no UI and zero rows. `AUTHORING` declares the six ways in (upload / generate / manual, per region) and the test requires each to exist AND be bound to a control.

**Wardrobe items are gallery pictures filed under `costume`**, with the title as the note — one storage path, one upload flow, and the thumbnail is the same picture the reference band can show. A second table for the same thing is how one of them acquires a fix the other does not.

**The palette moved to the character** (migration 090, `palette_json`): it holds across every costume they wear and every frame they appear in. Swatches are `#rrggbb` only — a CSS colour NAME is refused, because the browser understands `red` and a print document, an export and a contrast calculation do not all agree what it means. Shorthand expands on the way in, and a value that is not a colour is **named as dropped** rather than silently discarded, since a swatch vanishing on save looks like the save failed. Lifting a palette from a picture samples the actual pixels on a canvas, quantised and counted so the answer is the colours that *cover* the image rather than the most saturated stray pixel — and a cross-origin image that taints the canvas says so plainly instead of surfacing a `SecurityError`.

**Gender is a picker now.** It was already on the card, in the form and in the sheet spec — as free text, which is why `voiceGender()` matches with a regex: `F`, `woman` and `female` were three values for one thing, and anything it did not recognise silently disabled gender-matched voice suggestions. The test asserts every option offered on the form is one the caster can actually read.

**Everything that spends shows a spinner.** A generation takes up to a minute, and without one the page looks exactly as it did before the click — which reads as the button not working and invites a second press on a paid action. `csBusy` clears in a `finally`: a spinner still turning after a failure is worse than none, because it says work is happening when nothing is.

**The export builds its own print document.** Printing the app's dark UI wastes a cartridge and reads badly, which is why the screenplay export already does the same: A4, serif body, the four plates across the top, the spec as a hairline grid, and the references as a contact strip.

Generating views is **all four or one**: a pending plate's own click generates just that view, and the header button asks before spending. It stops on a refusal rather than asking three more times — a refusal repeated is a refusal paid for.

### A Score for THIS Scene, Not for Any Scene
*"Could we send enough details of the scene to generate a score? We have this tool but it doesn't seem to work."*

It worked. It returned a file. The file was wallpaper. `buildMusicPrompt` read the cue and `project.genre` **and nothing else** — the `scene` it was handed was used solely to work out a duration — so a father meeting the daughter he left nine years ago produced *"calm ambient instrumental soundtrack, piano, acoustic guitar, ambient pad, Drama film score"*, which is what **every scene in every film** produced.

`SCORE_INPUTS` declares the eight facts a score is built from, and every one is asserted **differentially**: change the fact, and what the provider receives must change. Asserting that a field is *read* would not have caught this — the scene was passed in and ignored for four phases.

**One derivation is a craft judgement rather than a transcription.** Sixty-three lines of dialogue means the cue sits *under* two people talking, so it is scored as sparse underscore that never becomes melodic — a melody there fights the words, which is the commonest way a temp score ruins a scene. Energy drops as the dialogue count rises.

**Nothing is invented.** A scene with no time and no place gets neither in its brief: a confident wrong cue is worse than a plain one, because it sounds deliberate. `mood`, `genre` and `instruments` are left NULL rather than guessed — those are the judgement the feature exists to hand to the model.

**The length was 30 seconds for a 202-second scene.** `sceneCutLength` reads measured CLIPS, and a dialogue scene with no footage returns null and falls to a default. The Glass Harbour diner scene has no clips and 202 seconds of measured dialogue. `cueSeconds` walks cue → footage → dialogue → nothing, and **names which one answered**, because "202 seconds because that is how long the dialogue runs" and "30 because nothing was measured" are different claims.

**A music prompt is not a screenplay.** The first derived prompt came out at over **three thousand characters**, because `film_scenes.description` there is the whole scene's action — camera moves, blocking, every beat — with the instruments and genre at the very end where a truncating model drops them first. `MUSIC_PROMPT_LIMIT` is 600 and is **ours**, stated as such: ElevenLabs documents no limit for `/music`. The trim takes from the **front**, at a sentence boundary — the description is the longest part and the least musical, and cutting the instruments to keep a camera move would be the wrong trade every time. The real scene now sends 588 characters that describe the diner, the underscore and the film's amber look.

**The musical judgement is the model's.** `music_brief` hands over the facts, the real length and the prompt that would be sent, returns **no conclusion**, and spends nothing; `music_cue_create` stores what the model decided, and a cue somebody wrote always beats the derivation. The engine assembles and validates; it never asks a second LLM what the music should be.

Verified end to end: a 202-second, 3.2MB score for the diner scene, generated in 19 seconds.

### How a Line Is Said
The screenplay carries the direction — `(quietly)`, `(laughing)` — the parser extracts it, and `buildVoicePayload` even put it on the payload as **`emotion`**. It was never sent: **ElevenLabs has no `emotion` field**, so the writer's own delivery note was extracted, carried, and dropped one function short of the request. `phase0-payload-parity` required its *presence*, which is how a dead field survives a parity suite — the payload carried it, so the check passed, and nothing asked whether anything read it.

Three levers, and the first is dangerous. **Audio tags** (`[whispers] Say it.`) are honoured only by `eleven_v3`; on any other model they are not ignored, they are **spoken**, so `[thoughtfully] Hello` becomes the words "thoughtfully hello". A tag is therefore emitted only when the model understands one, and only from a declared vocabulary — a direction nobody mapped is **refused rather than guessed**, because the only way to discover an invented tag is to listen to a scene you have already paid for. **Style** (0–1 expressiveness) and **stability** work everywhere and were never sent and hardcoded respectively, so a non-v3 project still gets some of the direction.

The model is upgraded **per line**, not by changing the default: a line with no direction produces exactly the request it always did.

**`previous_text` / `next_text` cost nothing and help every line.** They are used for prosody and are not spoken. Without them each of sixty-eight lines is read in isolation, which is why a generated scene sounds like a list rather than two people talking.

A character also carries a **standing delivery** — RAY is weary in every scene — merged into `voice_params` rather than replacing it, because that object also holds stability and speed and rewriting it to set one field would drop the rest. A parenthetical on a line **overrides** it: a cast voice is how somebody always sounds, a direction is how they say *this* line.

### Nothing Regenerates That Did Not Change
*"If I change the screenplay, or change the voice through cast, will it regenerate?"*

It regenerated **everything, on every press**. `prompt_hash` was stored against each line and covered the **text alone**, so recasting a character — the change most likely to need a new recording — produced an identical hash and was invisible. Nothing read it in any case.

The hash now covers **text, voice, delivery and model**: the four things that change what comes back. Measured on shot 1B (RAY, JUNE, RAY, JUNE): recasting RAY regenerated **his two lines and reused JUNE's two**. An unchanged shot regenerates nothing. `regenerate: true` forces a new take, because a director who wants a different reading of an unchanged line must not be told the line is already correct.

The table read follows the same rule through its filename, which used to carry a **random suffix** — so nothing could ever find the previous one and a 68-line scene was bought again in full every run.

### A Scene Should Sound Like People Talking
Generated lines butt against each other, and played that way a scene is a list being read. `pauseAfter` gives each line the hold that follows it, from the card rather than a constant:

| | |
|---|---|
| a new speaker answering | 700ms |
| the same person carrying on | 300ms — they have not stopped speaking |
| the writer marked `(a beat)` | +1400ms |
| the line trails off `…` | +900ms |
| a question | +250ms |
| the line ends on an em-dash | **0** |

The last is the one that matters most: an em-dash means the next speaker **cuts in**, and a polite gap there destroys the effect the writer wrote. An ellipsis **mid-line** is deliberately not a pause — the model already speaks that rhythm, and holding for it doubles the effect.

Measured across The Glass Harbour's diner scene: 53 turn gaps, 6 continuations, 2 interruptions at zero, one question at 950ms and one same-speaker question at 550ms. The timeline holds each shot long enough for its own pauses, dropping the last line's — that silence belongs to the next shot.

**It needed one more column.** `attachPauses` reads the dialogue TEXT to decide, and the timeline's shot query selected everything except `scene_card_yaml` — so every pause silently fell back to the plain turn gap, and all 63 came back identical.

### Watching the Scene and Hearing It

**A shot holds for its dialogue.** The card's `duration_ms` is what a shot ASKS for, written before the lines existed, and it is 4000ms on every shot here. So a four-second slot carrying 24.6 seconds of dialogue played four seconds of it and cut away: measured across The Glass Harbour's diner scene, **26% of the dialogue was audible** — 44 seconds of 168. The same fault an uploaded clip had when it was held for the length its card asked for, one media type over.

The measured audio is the fact, so a still-only shot now holds for `max(card, spoken + gaps)`. A **longer card still wins**, because a director holding on a face after the last line has said so and shortening to the dialogue would overrule them. A measured **clip** beats both: it already contains its own dialogue. A shot with no dialogue is byte-identical, which is what makes this safe for every project that has generated none.

**Durations were all zero.** `routes/voice.js` only set `duration_ms` when the provider returned an object, and ElevenLabs returns raw bytes — so every dialogue asset stored 0 and the sum was always 0. Measured from the file with the same `measureDurationMs` the media importer uses, because a second duration probe is how one of them acquires the stderr fix and the other keeps reporting zero.

**Playback never generates.** Asked directly, and derived from the source rather than asserted: no playback function posts or calls a generate endpoint. Audio is made once and read thereafter. The table read reuses too — its filename now carries a hash of the line's TEXT and VOICE, so an unchanged line is found and reused while a rewrite or a recast generates. It used to carry a random suffix, so nothing could ever find the previous one and a 68-line scene was bought again in full every run.

**The scene page no longer offers a table read.** It produced a separate set of audition files attached to no shot, so a director who then generated the shots' dialogue paid twice for the same lines and threw one set away. The row now generates the take the film actually uses — shot by shot from the client, so the count moves rather than one request running silently for a minute. The route and the MCP tool stay: reading a scene aloud before it is broken down is a real thing to want, and `why_no_ui` records the decision.
*"We should be able to read the dialogue along with the shots in playback, so we can see the scene play with dialogue."*

`lib/timeline.js` has picked an audio asset per shot since it was written and **playback ignored it entirely** — so a director could watch the whole cut in silence with the dialogue sitting on disk. Wiring it found four more faults, none of which the API could see.

**The cue and the character were two people.** `routes/voice.js` matched `c.name.toUpperCase() === line.character.toUpperCase()` in three places, so `RAY` never resolved to `RAY MERCER`: thirty of his lines got no profile, no `voice_id`, and the adapter fell back to its hardcoded default — a voice that is not even in this account's list, which came back as **`402: Free users cannot use library voices`**. A casting fault wearing a billing error, and a paid plan would have *hidden* it by letting the wrong voice through. The rule is not reinvented: `canonicaliseCharacterNames` already collapses a first name onto the full name it prefixes, on a word boundary so RAY does not match RAYMOND. The table read now uses it too — one question, one answer, or the take that ships is cast differently from the read that approved it.

**`batchVoice` enumerated the work and performed none of it.** Same shape as the scene and project pipeline runners: a plausible 200, nothing generated, and the button reporting "0 lines". `generateVoiceForShotId` is now the one implementation both the single route and the batch call, and `plan_only` keeps the free listing that used to be all it did.

**One asset per shot is right for a mix and wrong for dialogue.** A shot holds one file per LINE, so attaching one spoke the first line of a four-line exchange and fell silent. `audio_lines` carries them all, **deduplicated by filename with the newest row winning** — regenerating writes over the same per-line names while inserting a row each time, and one four-line shot had **seventeen rows for four files**. Ordered by the line index in the name, never `created_at`: that records when a line was *made*, so re-doing line 2 would move it to the end of the scene. Playback chains them on `ended` rather than against the clock, because a card's duration was written before the dialogue existed and timing against it talks over the next line.

**And the file served perfectly to curl while no browser could play it.** `serveFile` piped with no `Content-Length`, so Node fell back to chunked — and a media element given a chunked response with no length cannot compute a duration and stalls at `readyState 0`. It now sends the length, advertises `Accept-Ranges`, answers a range with a real `206`, and refuses an unsatisfiable one with `416`. The test scopes its assertion to the **plain 200 branch**: the first version checked the whole function for the string, the range branch sets one too, and the mutation that deletes it passed.

`mediaUrl` also mapped everything non-image to `/film/video/`, which is right for a clip and 404s for dialogue. The serving route is read from the file's own directory now — not guessed from the extension, because `.mp3` is served from two places: dialogue from `/film/audio` and a score from `/film/music`.

### Hearing the Dialogue Before Anything Is Shot
*"Where do we generate the dialogue in any of the sections? If I want to do a test run and see how it feels… this should be part of the planning phase."*

The honest answer was **nowhere in the app**. `POST /shots/:id/voice/generate` shipped in phase 4; `grep -c` for any voice control in the SPA returned **0**, and `film_voice_profiles` held **0 rows**. So a line could only be heard by curl or by an agent, and only for a SHOT — which means only after a breakdown, which is after the point where hearing it would change what you write.

**And it would have been the same voice every time.** `buildVoicePayload` reads `voiceProfile.voice_id`; the column **did not exist**, so that branch was dead, the `voice_params` fallback was written by nothing, and the ElevenLabs adapter fell through to `DEFAULT_VOICE_ID`. A whole cast in one voice, silently, with no way to change it. Migration 089 adds the column the builder was already reading rather than bolting a parallel casting system beside it — the same shape as `scope` on `PIPELINE_STEPS` and `NEVER_WRITES` on the style book: declared, exported, and consumable by nobody.

**Casting is a planning act, so the surfaces are.** `GET /film/voices` returns the account's catalogue with gender, age, accent and the **preview the provider hosts** — which costs nothing to play, and is what makes a list a casting session rather than a dropdown of names. Without it a director casts by pasting an opaque id copied from another website.

**An audition is deliberately not a generation.** It attaches to no shot and registers no asset, written under `auditions/` with its own serving route: an audition that looked like a take would be picked up by the pipeline and ship a reading the director was only trying out. `POST /film/audition` takes a line and a voice — or a `character_id`, and uses whatever that character is cast in.

**The table read** is the scene, out loud, before the breakdown. A **parenthetical travels beside its line as direction rather than inside it**, because read aloud *"(quietly) Get inside."* becomes *"quietly, get inside"*. Uncast characters are **named**, since the failure being replaced was silent: every line generated, nothing errored, and the film came back in the provider's default voice — which sounds like a decision rather than an omission. The casting report orders the uncast **by line count**, so the list is ordered by what it costs to leave uncast rather than alphabetically.

Three faults were found by running it rather than by reading it:

**`getCredential` returns `{apiKey, meta}`, not a string.** Passing it as the header made it `[object Object]` and the catalogue 401'd — with a key that works perfectly. Diagnosed by calling ElevenLabs directly with the same key and getting 200, which is what separated *my bug* from *a dead key*.

**The audition was written as `.wav` and was an MP3.** `normalizeOutputFormat` only honours `mp3_*` and `pcm_*`, so asking for `wav` silently returns the adapter default. `file` on a real audition said *"Audio file with ID3 version 2.4.0, MPEG ADTS"* under a `.wav` name — the same lie an uploaded JPEG stored as `.png` already cost. The extension follows `result.format` now.

**Only `scene_heading` rows carry a `scene_number`** in `film_script_elements`; every other element stores NULL. Filtering a scene's elements on it returns the heading alone — which holds no dialogue — so a scene with lines read as a scene with none, and a `matched.length ? … : all` fallback never fires because one row is not zero rows. Measured on Wingfall: one dialogue row in the script, zero found. A scene is sliced **from its heading to the next**.

`tests/dialogue-audition.test.js` is set-based over the six scopes dialogue exists at, and each is required to be **bound to something clickable** rather than merely defined — a handler called from nowhere looks identical to a working page until somebody clicks it, which is precisely the state this feature was fixing. That check immediately caught three unbound handlers, including the shot and batch voice routes that had never had a control at all. The casting assertions are **differential**: cast a voice, and what the provider receives must change.

**And the character sheet chooses the voice.** A flat list of twenty-one voices makes a director re-derive by ear what the engine already knows: `film_characters` records `gender` and `age_range`, so the catalogue is ordered for THIS character with the reason on each row — *matches female + young*. **Ranked, never filtered**: a director may want a voice the sheet does not predict, and removing it would make that choice unavailable without saying so.

`ageBand` parses the numbers rather than matching phrasings, because a writer types "30s", "20-30" or "late 40s" and a parser that handles one silently stops suggesting for half the cast. Gender is **read, never inferred from the name** — both characters on the real project had none recorded, and DRAGON is not a woman because a regex reads the name that way. What is missing is **named on the surface with the way in**, since filtering on a guess is worse than not filtering and an unexplained flat list looks broken.

**A voice already cast to another character is flagged and pushed last, not hidden.** Two characters in a scene sounding identical is the failure this exists to prevent; one performer doubling two small parts is a real choice, and hiding the voice would make it unsayable. Verified end to end: casting MAYA (female, 30s) as Sarah re-ordered her list to female/young first, and Sarah then appeared on DRAGON's list at position 21 of 21 marked *already MAYA*.

The character card showed age and gender already — and rendered an **empty line** when both were absent, which reads as the fields not existing and was reported as exactly that. It now names what is missing and links to the form, because these are not decoration: voice casting ranks on them.

Served at `GET /film/voices`, `GET|PUT|DELETE /film/characters/:id/voice`, `GET /film/projects/:id/casting`, `GET|POST /film/audition`, `GET|POST /film/scenes/:id/table-read`, and as seven tools (**204 tools**).

### A Subject Needs a Sketchbook, Not Just a Plate
Every stored image of a character, location or prop **was** a candidate reference: `gatherShotReferences` selected on asset type and `headlinePlate` picked one. There was nowhere to put an image that **informs** the work without **being** it — the film still you are chasing, a photograph of the real street, four versions of a face you are choosing between. So an artist had one slot per view and every exploration overwrote the approved plate.

Three roles, in order of commitment: **reference** (approved — the only thing that conditions a frame, one per view, which is what `headlinePlate` already assumes), **concept** (an exploration, kept and comparable, reaching no prompt until promoted), **inspiration** (gathered rather than made). The inspiration case is not a ranking, it is a **different act**: a gathered image is usually somebody else's frame, and looking at it is not the same as sending it to a provider as conditioning input — so it is excluded outright and promoting one has to be stated.

**THE invariant: adding a gallery must not silently start conditioning shots on sketches.** Every row that exists today IS a plate, so an unlabelled image reads as `reference` — the opposite direction from `input_fingerprint`, where NULL means "outside the workflow", because here the existing rows are very much inside it. A **declared but unrecognised** role is a third case and is returned verbatim rather than folded into the default: absent means "written before roles existed", while declared-but-unknown means somebody wrote an intent this version does not understand, and reading that as *approved for sending* is the wrong direction.

**The rule exists twice — in JS and in SQL — and the two are held to each other.** `roleOf` decides in JavaScript; `sendableSql` filters in SQLite so the plate queries keep their `LIMIT 1` and their view ordering. Two implementations of one rule is precisely what this codebase keeps paying for, so the test runs both against the same rows, including the ones that break a naive version: absent metadata, metadata that is not JSON at all, and an undeclared role. It found a real divergence — JS was trusting an unknown role into the send list and SQL was not — and SQL was right. `json_valid` guards the extract, and that guard is load-bearing: `json_extract` **throws** on malformed JSON, and a throw there would take down the query that decides what a paid generation is conditioned on.

**An exploration never takes the plate's filename.** A plate is written to a per-view name and overwrites, so an exploration sharing it would replace the approved picture on disk the moment it was generated — the image every frame of that subject is conditioned on, gone, with nothing said. Explorations also carry a token so they do not overwrite *each other*, or "try three looks" keeps one. They go through `generatePlate` in explore mode rather than a second generator, so they inherit the style, the look-board image, the size rules and the provider fallback chain — the trap `reference-plates.js` was created to close for locations and props. A **character** has no `PLATE_KINDS` entry, because its plate is a turnaround built by its own prompt builder, so `generateExploration` resolves that in one place rather than at each call site.

Promotion **demotes rather than deletes** whatever held that view: the picture it replaced cost money and may be the one you come back to. Only the same view is demoted, or promoting a side plate would strip the front one. Demoting the last reference is **allowed and said**, because a subject with no plate has every frame invent it, and that is invisible until the next generation comes back with a stranger in it.

Served at `GET /film/{characters,locations,props}/:id/gallery`, `POST …/explore` (free preview at `…/explore/preview`), `POST …/inspiration`, `PUT /film/gallery/:id/role`, `DELETE /film/gallery/:id`, on a **Gallery** button on all three entity cards, and as six tools (**197 tools**).

### Three Numbers About a Scene, and They Are Not Each Other
A production measures a scene three ways and this engine had none of them: **page eighths** (how much printed page it occupies — objective), **screen time** (how long it plays — an estimate), and **shooting effort** (how hard it is to film — independent of both).

Keeping them apart *is* the feature. *One page ≈ one minute* is a rule of thumb that holds across a whole conventionally formatted screenplay and is badly wrong for a single scene: `The armies collide.` is 1/8 of a page and minutes of film, while a dense page of overlapping dialogue plays in well under a minute. Multiplying eighths by 7.5 seconds and calling the answer a runtime is confidently wrong exactly where it matters — and a schedule then gets built on it. So `lib/screenplay-timing.js` reports **both** numbers and, when they diverge, a `disagreement` naming which method said what and why. Averaging them would produce one number that is wrong in a new way and hides which method produced it; the divergence is itself the signal, because it says *this scene is not what its page count suggests*.

Eighths are written the way a stripboard writes them — `4/8`, never `1/2` — so a column of scene lengths adds without converting between halves, quarters and eighths on the way down, and **1/8 is the floor**: a scene occupying almost no page still occupies a strip.

Nine **action classes** each carry their own uncertainty, and each carries a `why` — a duration with no reason is a magic number nobody can argue with later. A single seconds-per-word constant would give `John opens the door.` and `They fight.` the same confidence, which is the specific lie this exists to avoid. Confidence is computed from the **spread**, not the mean: a scene whose maximum is several times its minimum is not something to schedule against however plausible the middle number looks. Ambiguous phrases (`They fight.`, `Time passes.`) are **flagged with the phrase quoted**, never corrected — none of them is bad writing, and a low confidence that cannot name its cause is one nobody can act on.

Shooting effort is scored from nine complexity factors, and each declares a `probe` — a line of action that must trigger it — which the test runs through the real estimator. A factor no text can ever fire looks like coverage and provides none.

**And it found a divergence nobody had noticed.** The editor writes `data-element-type="scene-heading"`; the parser and `film_script_elements` store `scene_heading`. Both are in the build, neither is wrong, and they had never met — pagination only ever ran on the editor's DOM. The moment anything measured a screenplay from the **database**, `elementLines('scene_heading', n)` missed every case and fell to the default, billing a heading as a paragraph of action. Normalised at the module that owns `ELEMENT_TYPES`, because a second mapping is how the two spellings arose in the first place.

### Reading a Screenplay Without the Engine Doing the Reading
A screenplay analyzer should not ask *does this obey one famous beat sheet*. It should ask whether the story creates a coherent, emotionally engaging experience through character, conflict, causality and cinematic writing. `lib/screenplay-analysis.js` carries **thirteen dimensions** merged from the Academy Nicholl scoring rubric (Story, Voice, Characters, Craft, Meaning and Magic) and the Sundance curriculum (stakes, objectives, causality, scene function, subtext, setup and payoff, tone, visual storytelling).

**The engine never reasons.** The connected agent *is* the model here, so there is no "run analysis" route: `analysis_brief` hands over the screenplay, the rubric, the output schema and every fact the engine can compute for free, and `analysis_write` stores what came back. A route that called a server-side LLM would ask for a second API key to answer a question the attached model has already read the material for, and would fail with a billing error the model cannot act on — which is what `tests/mcp-no-server-llm.test.js` has always existed to prevent.

**Mechanical and interpretive are declared per dimension.** Counting parentheticals, finding a slugline that will not parse, spotting two character names that differ by one letter — that is arithmetic the engine does exactly, for free, every time, and asking a model to count is slower, costs tokens and is less reliable than a regex. Asking whether a premise generates difficult choices is the entire point. Declared rather than assumed, so the split cannot quietly drift into *ask the model everything*.

**Diagnose before prescribing.** *"Add an inciting incident on page 12"* tells a writer what story to write. *"The protagonist's goal is not identifiable until scene 14 — if that delay is deliberate the earlier curiosity may need strengthening, and if not the disruption may need to arrive sooner"* tells them what a reader experienced and hands the decision back. Every note therefore carries seven fields — observation, evidence, effect, question, strategies, confidence, kind — and is **refused** without them: a note with no evidence cannot be checked, and one with no question is a verdict.

Two refusals are structural. **An overall score is rejected**, because a number gets quoted without the reasoning that produced it. **Drafted prose is rejected**, and that one is practical as well as creative: the Nicholl rules prohibit AI-generated dialogue, characters and scene description, so a tool that silently rewrites the author's work can disqualify the screenplay it was helping.

A stored analysis records **which draft it read**, `ON DELETE SET NULL` rather than CASCADE — a reading of a draft outlives that draft, and a report shown beside a screenplay it no longer describes is worse than none, because every note still reads as current. `GET /projects/:id/analysis` says `of_current_draft` outright.

### A Treatment Is Not a Screenplay
Prose that states what happens, in order, without dialogue or format — what the screenplay gets written *from*. Stored in its own table rather than as a `film_scripts` row, because the Fountain parser would read its paragraphs as action and manufacture scenes from nothing, and every report built on scene presence would then describe a document that has no scenes. Versioned for the reason screenplays are, and an unchanged save writes nothing and reports `changed: false` — *did that apply?* has to be a free question, and a version recording no change makes the version list useless as a record of what changed.

Drafting the screenplay from it happens **in the conversation**: Claude reads the treatment, writes the Fountain itself, and saves it with `script_write`. Nothing here generates a screenplay.

### Four Things a Director Asked For
*"Could we add a full regenerate dialogue button on playback… are we also sending the details of the scene so the emotions of the dialogue are accurate? Still don't have a way to add details to the music generator when we want (do not regenerate it again though). How does the camera movements saved in previs? What are all the buttons on the top right… Also, like we did for the character cards, we have the location and prop card HTML."*

**The scene reached nothing.** `buildVoicePayload(line, voiceProfile, character)` took no scene at all, so "the details of the scene" was answered by the writer's parenthetical or by nothing — a line in a tense scene was read exactly as neutrally as a line in a calm one. `film_scenes.delivery_direction` sits **between** the character and the line: more specific than how somebody always sounds, less specific than how they say this one line. Empty applies nothing, so a project that never writes one builds byte-identical requests. Three sites built a voice payload independently and one `sceneContext()` now feeds all of them — a direction honoured by two of three means the same line is read differently depending on which button generated it.

**`regenerate` had no control.** `routes/voice.js` has accepted it since the reuse-by-hash skip shipped, and nothing on any page sent it — so after a rewrite, a recast or a change of direction, pressing Generate reused the old file and looked like it did nothing. **Redo dialogue** is scoped to the scene on screen rather than the film, because a feature's dialogue regenerated from a transport button is a bill nobody meant to run, and it says outright that it buys a new take of every line including unchanged ones.

**The music details were behind the wrong door.** They lived only in the cue form on the Music Cues page, reachable through a button called *+ Music Cue* — the wrong door for a scene that already has a score. The direction now sits on the scene, where the score is, and **generates nothing**: the next Regen picks it up, and so does the free brief.

**Twelve buttons, three of them saying "save" about three different things** — the blocking, the scene card, and a PNG. Nothing said which one keeps a camera move, which is what was asked. *(Superseded: the toolbar and its registry were removed with the old stage.)* A toolbar registry was the answer and was **derived**: a control on the page that is not in it, or an entry with no control, fails. Grouped by the job — stage it, look at it, commit it, take something out — and one line under the bar says plainly that a camera move is kept by **Save blocking**, that **Apply to card** writes the angle onto the shot, and that **Save frame** and **Record move** write files and change nothing.

**A location and a prop are workspaces too.** The character card became a sheet and these stayed a form in a modal — the same gap seen from two other subjects. `lib/subject-sheets.js` declares **10 location regions** and **9 prop regions** from the design handoffs, each with an `anchor` the renderer must contain, so a sheet cannot draw the plates and silently drop the continuity states. Migration 092 adds what a design department actually keeps: what a prop is made of, what state it is in for this scene, what it must never be, whether it has to *work* on camera. Read-only regions state what they are derived FROM — an omission that is stated is a decision.

The cards drop to **two buttons** and everything else moves onto the sheet, held by `RELOCATED` to still having a home: removing a button is only a simplification if the thing it did is still reachable. The sheet's upload is the **same** `uploadControl` a card used, with the target written as a literal per kind — the media-import contract is derived by looking for that call, and a computed target is invisible to it.

Three existing derived tests caught real regressions in one pass — `scene_update` advertising an argument its body builder never forwarded, both plate uploads losing their registered control, and two fields with no control and no stated reason. That is what those tests are for.

### Reading a Reading
*"Can we remove this weird text in the screenplay analysis and present the analysis better?"* — with a screenshot of `Read by round-trip test · draft v15 · 2026-08-29 12:07:03` above a heading saying **Map** and a block of raw JSON.

The weird text was **mine**: a hand-written round-trip probe from the session that shipped the feature, verified against the live server and left in the director's project. Removed, and the reason it could only be removed by hand is the third fault below.

Three faults, and none of them cosmetic.

**The least important thing led.** Who typed it and when is provenance; it opened the panel as a raw `analyst` string and a raw SQLite timestamp. It sits at the bottom now and reads as English — *"Read today against draft v1 · Claude Opus 5"*.

**A whole LAYER was rendered as debug output.** `LAYERS[0]` describes the map as *"characters, scenes, locations, chronology, goals, turning points, setups and payoffs — what is in the script, before any judgement about it"*, and the panel printed `JSON.stringify(map, null, 1)` into a `<pre>`. It renders as labelled rows of chips now, **from whatever the map holds** rather than from a fixed field list: that layer is described loosely on purpose, so a reading carrying something this page has never heard of must still show it or the page silently drops part of the report.

**The thirteen dimensions were declared, exported, briefed — and recorded on nothing.** `DIMENSIONS` is the entire rubric and `NOTE_FIELDS` had no `dimension`, so a reading came back as one undifferentiated list and a writer working on dialogue could not find the dialogue notes. The same declared-and-unconsumed shape as `scope` on `PIPELINE_STEPS` and `voice_id` on a character.

`dimension` is **optional and validated**: a reading stored before the field existed must not become invalid the day it arrives, and an *unknown* dimension is refused rather than filed nowhere — a note under a name nothing recognises renders nowhere, which is worse than one under *"Not filed"*. Untagged notes are **shown**, never dropped; and a reading with nothing tagged renders as a flat list rather than one heading announcing that nothing is filed.

Groups run in the **rubric's own order** (premise → structure → … → format), not by how many notes each collected — that is roughly how a reader experiences a script, while sorting by count puts whatever the model happened to say most about at the top. The titles are **served with the reading** from the registry rather than mirrored into the SPA, because thirteen titles copied into a page go stale the first time one is reworded.

**And nothing could delete a reading.** `DELETE /film/analysis/:id` has existed since the feature shipped with no control calling it — which is why a probe row could only be removed from the database by hand, and is exactly the state this was reported in.

`tests/screenplay-analysis.test.js` **executes** the page's renderers rather than grepping for them: a grouping function that drops untagged notes and one that keeps them look identical in source, and so do a map that renders content and one that renders JSON.

### The Gutter, and Index Cards You Can Work In
The screenplay page now carries a **gutter**: per scene, its eighths, its likely screen time (amber and marked `?` when confidence is low) and **the shot codes broken down from it**. Absolutely-positioned markers aligned to each scene heading's own `offsetTop`, rather than a column beside the page — the screenplay is one flowing contenteditable, so a column would have to re-derive its own line breaks, which is a second layout that drifts from the one on screen and drifts differently at every zoom level. The gutter is a **sibling** of the page, never a child: anything inside the contenteditable is content the editor will adopt, normalise and eventually sweep, which is exactly why the page-break indicators had to be taken out of it.

Index cards were a read-only contact sheet — draggable to reorder, double-click to jump, and a single click did nothing. They now open. Editing a card writes **into the screenplay** — the heading, and the action beneath it — because the cards are a view of the script, and a card holding its own text would be a second document that disagrees with the one being shot. The action is replaced up to the **next heading** rather than the first paragraph only: a scene's action is however many paragraphs it has, and rewriting one would leave the rest describing the old version. Deleting a scene names what it does *not* do — the shots already broken down from it stay on the shot list, with their generated frames, which cost money.

Every card operation goes through `afterCardEdit`, which normalises then saves: a programmatic DOM change fires no `input` event, so without it the repair waits for the writer's next keystroke. `tests/screenplay-mutators.test.js` caught exactly that on the first build, and now **follows one call level** — a writer may normalise directly or delegate to a helper that does, and refusing to follow the call reports a correct function as broken. One level rather than an unbounded walk, which would follow refresh callbacks into every function the page renders and eventually find a `normalizeEditor` somewhere unrelated.

### A Scene's Score Is Not a Property of One Shot
Every entry in `PIPELINE_STEPS` declares a `scope`, and `routes/pipeline.js` contained **no reading of it**. The runners walked shots and ran the whole plan on each one, so `music` and `ambient` — both scene-scoped, both built from `ctx.scene` and byte-identical for every shot in it — were generated once **per shot**. Measured on a real 13-shot, 3-scene project: **13 music payloads and 13 ambient payloads** where 3 and 3 were the work. Nothing failed; the spend was 4.3× on those two steps and the surplus rows accumulated, because `persistStepResult` inserts rather than replaces.

Declared, exported, consumed by preflight, `media-kinds`, the media importer and the MCP layer — and never read by the thing it was written for. `SCENE_SCOPED` is derived from the registry, so a tenth scene-scoped step is covered with nothing to remember.

**Two rules, both from `scope`.** On a run over several shots a scene-scoped step executes **once per scene**, keyed by scene id. On a **single-shot** run it does not execute at all: you asked for this shot, and running five shots one at a time would otherwise buy five scores exactly as the bug did. `include_scene_steps` opts in. Skipping is **reported**, never silent — a step that quietly does nothing is indistinguishable from one that ran, which is precisely how this went unnoticed: the run said complete either way. A scene-scoped step that **fails** releases its key, or one bad attempt on the first shot means the scene silently never gets its score.

**And the defect sat in a path that never ran.** `runScenePipeline` and `runProjectPipeline` inserted a run row, answered **202 "running"**, and executed nothing at all — the row stayed at `running` for ever, every progress field empty, no asset produced. Same shape as the assembly step that once returned a hardcoded success. Both execute now, **sequentially** (concurrent generations against one provider is how a queue earns a 429, and the retry costs more than the wait), over the project's own running order so a paused run has produced the front of the picture rather than a scatter of it.

`runShotPlan` is the one loop. Three runners needed it: two had their own copy and the third had none, and a gate applied to two of three is worse than none — the surface that skipped correctly would make the one that did not look like a data problem. The SSE runner also reported `complete` unconditionally while the JSON runner beside it said `completed_with_errors` for the same work.

`tests/pipeline-scope.test.js` counts the **assets** a run registers, because that is the only evidence that survives every way of getting this wrong: a source check for the word `scope` passes against a runner that reads it and ignores it, and counting gateway requests cannot separate music from ambient — the Gridlight adapter posts all three audio capabilities to `/music`. It resolves step → capability → asset type rather than indexing `ASSET_TYPE` by step id, which works for `music` and `ambient` and silently returns `undefined` for `keyframe` (the `image` capability) — a count of `undefined` is 0, which reads as "the step did not run" for a step that ran perfectly. Four mutations fail it: a gate that always allows, a shot run that claims nothing, a scene runner that executes nothing, and one that dedupes shot work too.

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

SQLite via `better-sqlite3`. Schema auto-migrates on startup (113 migrations).

**Core Tables:**
- `film_projects` — Project metadata + status
- `film_scripts` — Screenplay versions with Fountain content
- `film_scenes` — Extracted scenes with INT/EXT, location, time of day
- `film_shots` — Individual shots with scene card YAML
- `film_characters` — Characters with appearance prompts, LoRA/TI tokens
- `film_locations` — Locations with lighting defaults
- `film_props` — Props with scene assignments
- `film_costumes` — Per-character costumes
- `film_voice_profiles` — Which voice a character is cast in (and speaker embeddings)
- `render_ledger` — Full render parameter history
- `film_shot_versions` — Version history with thumbnails
- `film_shot_notes` — Direction, revision, approval notes
- `film_milestones` — Production timeline tracking
- `film_assets` — Asset registry (22 types including export formats)
- `film_music_cues` — Score/SFX cues
- `film_color_presets` — LUT/color grade presets
- `film_script_elements` — Fountain element-level queries
- `film_treatments` — Prose before the screenplay, versioned
- `film_screenplay_analyses` — A reading of a draft, as the four layers
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
- `film_subtitles` — Subtitle cues with SRT/VTT support
- `film_audio_deliverables` — Audio deliverable specs (stereo, 5.1, stems, M&E)
- `film_continuity_refs` — Continuity reference board (visual, wardrobe, prop, lighting)
- `film_credits` — Credit roll entries by section
- `film_title_cards` — Title card sequences
- `film_marketing_assets` — Poster, key art, banner, social card assets
- `film_cost_entries` — Budget & cost tracking (money)
- `film_usage_events` — What each provider call consumed, in the provider's own units
- `film_provider_rates` — Per-install corrections to the published rate book
- `film_backups` — Project backup metadata
- `film_3d_jobs` — 3D asset generation jobs (text→mesh, image→mesh, rig, retexture, animate)
- `film_video_attempts` — every video generation attempt: model, references, cost, acceptance
- `film_music_sessions` — a score session attached to a picture sequence (or a scene), with fingerprints, tempo map and approved mix
- `film_music_tracks` — lanes with a role and mixer state
- `film_music_clips` — an immutable asset placed on a track: offset, fades, loop/warp policy, take, source kind
- `film_music_emotion_ranges` — the emotional arc as time ranges; proposals until accepted
- `film_music_markers` — shot boundaries, hit points, sections, sync points
- `film_music_automation` — a parameter over time, per track or per clip
- `film_music_operations` — every generate, separate, bounce, import, push, pull, rebase and approval, with lineage
- `film_music_daw_links` — one DAW item per Film Engine key per adapter, with the DAW revision last written

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
#
# --test-concurrency=4 is NOT optional on a many-core machine. The default is
# one worker per core (48 here), which spawns dozens of API servers and
# synchronous ffmpeg processes at once; the event loop of a blocked server
# stalls long enough for the TCP backlog to reset an in-flight poll, and the
# suite then reports four to twenty failures in DIFFERENT files each run —
# accusing code that passes perfectly in isolation. Capped, it is deterministic
# and costs nothing: 87s against 83s.
node --test --test-concurrency=4 backend/tests/*.test.js

# Run individual test files
node --test backend/tests/nle-export.test.js
node --test backend/tests/storyboard-prompt.test.js
node --test backend/tests/reference-images.test.js
node --test backend/tests/reference-plates.test.js
node --test backend/tests/image-fallback.test.js
node --test backend/tests/reference-capability.test.js
node --test backend/tests/provider-tiers.test.js
node --test backend/tests/image-standard.test.js
node --test backend/tests/angle-explore.test.js
node --test backend/tests/gridlight-optin.test.js
node --test backend/tests/dry-run.test.js
node --test backend/tests/paid-image-controls.test.js
node --test backend/tests/thumbnails.test.js
node --test backend/tests/shot-motion.test.js
node --test backend/tests/director-controls.test.js
node --test backend/tests/subject-sheets.test.js
node --test backend/tests/subject-sheet-design.test.js
node --test backend/tests/subject-sheet-fidelity.test.js
node --test backend/tests/previs-storyboard.test.js
node --test backend/tests/previs-loop.test.js
node --test backend/tests/decision-parity.test.js
node --test backend/tests/previs-boundary.test.js
node --test backend/tests/screenplay-to-entities.test.js
node --test backend/tests/storyboard-prerequisites.test.js
node --test backend/tests/glb-parser.test.js
node --test backend/tests/world-spike.test.js
node --test backend/tests/reference-match.test.js
node --test backend/tests/data-paths.test.js
node --test backend/tests/project-folders.test.js
node --test backend/tests/edits.test.js
node --test backend/tests/warnings-clear.test.js
node --test backend/tests/redo-between-frames-brief.test.js
node --test backend/tests/ios-previz-brief.test.js
node --test backend/tests/ios-previz-epic.test.js
node --test backend/tests/plate-camera-epic.test.js
node --test backend/tests/capture-affordance.test.js
node --test backend/tests/upload-size-guard.test.js
node --test backend/tests/marble-contract.test.js
node --test backend/tests/world-capture-import.test.js
node --test backend/tests/is-pano.test.js
node --test backend/tests/capture-policy.test.js
node --test backend/tests/location-plate-provider.test.js
node --test backend/tests/view-anchoring.test.js
node --test backend/tests/capture-to-world.test.js
node --test backend/tests/aleph-contract.test.js
node --test backend/tests/aleph-adapter.test.js
node --test backend/tests/aleph-pricing.test.js
node --test backend/tests/redo-between-frames-epic.test.js
node --test backend/tests/epic-scoping-copy.test.js
node --test backend/tests/rbf-001-video-edit-probe.test.js
node --test backend/tests/rbf-002-verdict-recorded.test.js
node --test backend/tests/frame-extraction.test.js
node --test backend/tests/splice.test.js
node --test backend/tests/media-inspect.test.js
node --test backend/tests/repair-plan.test.js
node --test backend/tests/playback-marks.test.js
node --test backend/tests/frame-handles.test.js
node --test backend/tests/repair-run.test.js
node --test backend/tests/repair-tools.test.js
node --test backend/tests/repair-audio.test.js
node --test backend/tests/range-requests.test.js
node --test backend/tests/background-replace.test.js
node --test backend/tests/previz-console-placement.test.js
node --test backend/tests/world-flags.test.js
node --test backend/tests/direct-the-shot-panel.test.js
node --test backend/tests/explore-shot-panel.test.js
node --test backend/tests/console-regions.test.js
node --test backend/tests/console-layout.test.js
node --test backend/tests/adr-spark.test.js
node --test backend/tests/previs-views.test.js
node --test backend/tests/seedance-video-edit-retired.test.js
node --test backend/tests/repair-bridge.test.js
node --test backend/tests/editor-transport.test.js
node --test backend/tests/repair-dispatch.test.js
node --test backend/tests/bridge-retrieval.test.js
node --test backend/tests/approval-envelope.test.js
node --test backend/tests/take-candidates.test.js
node --test backend/tests/review-proxy.test.js
node --test backend/tests/spec-consumption.test.js
node --test backend/tests/shot-card-edit.test.js
node --test backend/tests/script-revision.test.js
node --test backend/tests/screenplay-drift.test.js
node --test backend/tests/impact.test.js
node --test backend/tests/mcp-no-server-llm.test.js
node --test backend/tests/mcp-staleness.test.js
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
node --test backend/tests/mood-board-images.test.js
node --test backend/tests/storyboard-annotation.test.js
node --test backend/tests/annotation-feedback.test.js
node --test backend/tests/shot-anchor.test.js
node --test backend/tests/shot-staging.test.js
node --test backend/tests/blocking-and-directing.test.js
node --test backend/tests/direct-shot-ui.test.js
node --test backend/tests/board-lock.test.js
node --test backend/tests/frame-send.test.js
node --test backend/tests/reference-limit.test.js
node --test backend/tests/oversize-references.test.js
node --test backend/tests/current-frame.test.js
node --test backend/tests/shot-insert.test.js
node --test backend/tests/playback-start.test.js
node --test backend/tests/anchor-plate-override.test.js
node --test backend/tests/location-views.test.js
node --test backend/tests/plate-upload.test.js
node --test backend/tests/video-sequence.test.js
node --test backend/tests/inbetweens.test.js
node --test backend/tests/inbetween-plan.test.js
node --test backend/tests/inbetween-run.test.js
node --test backend/tests/clip-coverage.test.js
node --test backend/tests/production-graph.test.js
node --test backend/tests/nle-import-validity.test.js
node --test backend/tests/export-package.test.js
node --test backend/tests/spot-duration.test.js
node --test backend/tests/deliverables.test.js
node --test backend/tests/shot-aspect.test.js
node --test backend/tests/brand-kit.test.js
node --test backend/tests/compliance.test.js
node --test backend/tests/spot-package.test.js
node --test backend/tests/staleness-cost.test.js
node --test backend/tests/draft-video.test.js
node --test backend/tests/prompt-visibility.test.js
node --test backend/tests/paid-preview.test.js
node --test backend/tests/generation-controls.test.js
node --test backend/tests/every-generate-button.test.js
node --test backend/tests/preview-reachability.test.js
node --test backend/tests/grid-children.test.js
node --test backend/tests/upload-anywhere.test.js
node --test backend/tests/aspect-consistency.test.js
node --test backend/tests/resolution-trickle.test.js
node --test backend/tests/staleness-accept.test.js
node --test backend/tests/dev-server.test.js
node --test backend/tests/mobile-shell.test.js
node --test backend/tests/page-handlers.test.js
node --test backend/tests/page-route.test.js
node --test backend/tests/live-after-write.test.js
node --test backend/tests/ios-app.test.js
node --test backend/tests/plate-lens.test.js
node --test backend/tests/plate-exposure.test.js
node --test backend/tests/plate-white-balance.test.js
node --test backend/tests/plate-focus.test.js
node --test backend/tests/plate-guides.test.js
node --test backend/tests/plate-capture-settings.test.js
node --test backend/tests/plate-frames.test.js
node --test backend/tests/plate-peaking.test.js
node --test backend/tests/plate-clipping.test.js
node --test backend/tests/plate-consistency.test.js
node --test backend/tests/storage-never-throws.test.js
node --test backend/tests/nothing-covers-the-page.test.js
node --test backend/tests/fcc-parity-brief.test.js
node --test backend/tests/runway-parity-brief.test.js
node --test backend/tests/runway-parity-epic.test.js
node --test backend/tests/film-engine-camera-brief.test.js
node --test backend/tests/fcc-parity-epic.test.js
node --test backend/tests/fcc-recording.test.js
node --test backend/tests/fcc-transport.test.js
node --test backend/tests/fcc-audio.test.js
node --test backend/tests/fcc-locks.test.js
node --test backend/tests/fcc-log.test.js
node --test backend/tests/fcc-format-picker.test.js
node --test backend/tests/fcc-prores.test.js
node --test backend/tests/fcc-hardware-tier.test.js
node --test backend/tests/fcc-budget.test.js
node --test backend/tests/fcc-system-camera.test.js
node --test backend/tests/fcc-previz-capture.test.js
node --test backend/tests/fcc-footage-to-shot.test.js
node --test backend/tests/fcc-epic-record.test.js
node --test backend/tests/fcc-on-device-proof.test.js
node --test backend/tests/fcc-external-storage.test.js
node --test backend/tests/fcc-resumable-upload.test.js
node --test backend/tests/card-overflow.test.js
node --test backend/tests/generator-costs.test.js
node --test backend/tests/manual-edit.test.js
node --test backend/tests/muapi-models.test.js
node --test backend/tests/generation-handles.test.js
node --test backend/tests/image-weight.test.js
node --test backend/tests/sound-library.test.js
node --test backend/tests/sound-library-files.test.js
node --test backend/tests/audio-cards.test.js
node --test backend/tests/generation-recovery.test.js
node --test backend/tests/audio-format.test.js
node --test backend/tests/music-cue-generation.test.js
node --test backend/tests/music-cue-fields.test.js
node --test backend/tests/seedance-image-fields.test.js
node --test backend/tests/seedance-workflow.test.js
node --test backend/tests/modal-stacking.test.js
node --test backend/tests/generation-busy.test.js
node --test backend/tests/sheet-layout-fidelity.test.js
node --test backend/tests/entity-create-fields.test.js
node --test backend/tests/provider-resolution-visible.test.js
node --test backend/tests/provider-config-merge.test.js
node --test backend/tests/credentials-global.test.js
node --test backend/tests/plate-views.test.js
node --test backend/tests/plate-medium.test.js
node --test backend/tests/ffmpeg-consumers.test.js
node --test backend/tests/character-orbit.test.js
node --test backend/tests/character-orbit-surfaces.test.js
node --test backend/tests/character-sheet-guide.test.js
node --test backend/tests/character-orbit-surfaces.test.js
node --test backend/tests/style-book-research.test.js
node --test backend/tests/style-book-plan.test.js
node --test backend/tests/style-book.test.js
node --test backend/tests/style-book-qa.test.js
node --test backend/tests/style-book-gaps.test.js
node --test backend/tests/style-book-path-containment.test.js
node --test backend/tests/plate-viewer.test.js
node --test backend/tests/location-plate-resolution.test.js
node --test backend/tests/orientation-plan-reaches-the-plate.test.js
node --test backend/tests/requested-size.test.js
node --test backend/tests/style-book-media.test.js
node --test backend/tests/headline-plate.test.js
node --test backend/tests/loading-never-sticks.test.js
node --test backend/tests/cue-length.test.js
node --test backend/tests/music-cue-mcp.test.js
node --test backend/tests/mobile-feasibility.test.js
node --test backend/tests/screenplay-entities.test.js
node --test backend/tests/recompose.test.js
node --test backend/tests/recompose-payload.test.js
node --test backend/tests/screenplay-port.test.js
node --test backend/tests/scene-append.test.js
node --test backend/tests/scene-insert.test.js
node --test backend/tests/screenplay-structure.test.js
node --test backend/tests/story-structure.test.js
node --test backend/tests/screenplay-polish.test.js
node --test backend/tests/screenplay-pagination.test.js
node --test backend/tests/screenplay-timing.test.js
node --test backend/tests/screenplay-analysis.test.js
node --test backend/tests/subject-gallery.test.js
node --test backend/tests/gallery-thumbnails.test.js
node --test backend/tests/sheet-counters.test.js
node --test backend/tests/sheet-and-board-affordances.test.js
node --test backend/tests/dialogue-audition.test.js
node --test backend/tests/dialogue-playback.test.js
node --test backend/tests/dialogue-delivery.test.js
node --test backend/tests/scene-score.test.js
node --test backend/tests/music-direction.test.js
node --test backend/tests/character-sheet.test.js
node --test backend/tests/character-sheet-authoring.test.js
node --test backend/tests/screenplay-empty-blocks.test.js
node --test backend/tests/screenplay-furniture.test.js
node --test backend/tests/screenplay-mutators.test.js
node --test backend/tests/screenplay-continuous.test.js
node --test backend/tests/mcp-first-writing.test.js
node --test backend/tests/act-structure.test.js
node --test backend/tests/frame-versions.test.js
node --test backend/tests/mcp-guide.test.js
node --test backend/tests/prompt-control.test.js
node --test backend/tests/board-grouping.test.js
node --test backend/tests/look-specs.test.js
node --test backend/tests/conform.test.js
node --test backend/tests/conform-sound.test.js
node --test backend/tests/bug-hunt-fixes.test.js
node --test backend/tests/project-delete.test.js
node --test backend/tests/prompt-budget.test.js
node --test backend/tests/provider-prompt-limit.test.js
node --test backend/tests/image-prompt-ceiling.test.js
node --test backend/tests/prompt-quality.test.js
node --test backend/tests/prompt-contributors.test.js
node --test backend/tests/camera-units.test.js
node --test backend/tests/dialogue-builder.test.js
node --test backend/tests/video-prompt.test.js
node --test backend/tests/motion-prompt.test.js
node --test backend/tests/video-model-contracts.test.js
node --test backend/tests/seedance-post.test.js
node --test backend/tests/seedance-tiers.test.js
node --test backend/tests/video-surfaces.test.js
node --test backend/tests/provider-image-encoding.test.js
node --test backend/tests/music-prompt.test.js
node --test backend/tests/pipeline-engine.test.js
node --test backend/tests/pipeline-scope.test.js
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
node --test backend/tests/conform-contract.test.js
node --test backend/tests/project-master.test.js
node --test backend/tests/assembly-once.test.js
node --test backend/tests/qa-master-checks.test.js
node --test backend/tests/conform-cost.test.js
node --test backend/tests/conform-walk.test.js
node --test backend/tests/music-workstation-epic-scope.test.js
node --test backend/tests/music-workstation-research-brief.test.js
node --test backend/tests/music-workstation-research.test.js
node --test backend/tests/music-workstation-schema.test.js
node --test backend/tests/music-session-contracts.test.js
node --test backend/tests/music-context.test.js
node --test backend/tests/music-sessions-routes.test.js
node --test backend/tests/music-session-mcp.test.js
node --test backend/tests/music-stem-import.test.js
node --test backend/tests/music-workstation-editor.test.js
node --test backend/tests/music-bounce.test.js
node --test backend/tests/music-capabilities.test.js
node --test backend/tests/music-emotion-proposals.test.js
node --test backend/tests/music-separation.test.js
node --test backend/tests/music-generation.test.js
node --test backend/tests/music-jobs.test.js
node --test backend/tests/music-ai-controls.test.js
node --test backend/tests/music-package.test.js
node --test backend/tests/daw-adapter.test.js
node --test backend/tests/ableton-sidecar.test.js
node --test backend/tests/ableton-mcp.test.js
node --test backend/tests/daw-sync-ui.test.js
node --test backend/tests/approved-score.test.js
node --test backend/tests/music-bundle.test.js
node --test backend/tests/music-rights.test.js
node --test backend/tests/music-docs-ops.test.js
node --test backend/tests/music-e2e.test.js
node --test backend/tests/music-registries.test.js
node --test backend/tests/music-midi.test.js
node --test backend/tests/instrument-render.test.js
node --test backend/tests/instrument-host.test.js
node --test backend/tests/instruments.test.js
node --test backend/tests/score-instruments.test.js
node --test backend/tests/stock-capability.test.js
node --test backend/tests/e2e-readiness.test.js
node --test backend/tests/e2e-first-film-plan.test.js
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
node --test backend/tests/nav-reorg.test.js

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
