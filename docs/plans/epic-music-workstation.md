# Epic: Film Engine Music Workstation and DAW Integration

## Overview

This epic adds a sequence-first music-production workspace to Film Engine. A filmmaker will be able to open an ordered picture sequence, inspect the exact screenplay passage and visual context behind it, shape an editable emotional arc, generate or import instrument stems, arrange those stems on synchronized tracks, and render an approved score without leaving Film Engine. The score session becomes the durable source of truth for timing, creative direction, assets, versions, rights, and delivery state.

The work builds on the existing music-cue, provider, sequence, asset, playback, rights, and MCP systems instead of creating a parallel audio product. It closes the current gap between one-shot cue generation and a finished soundtrack by adding a canonical multitrack model, real backend bounce and delivery stems, picture-change detection, and insertion of the approved score into final assembly.

Ableton Live integration is an optional professional round trip, not a requirement for Film Engine to finish a movie. A DAW-neutral package is delivered first, followed by a permissioned local MCP bridge over AbletonOSC for stable Live 12.4.5. The beta-only Ableton Extensions SDK and a Pro Tools PTSL adapter remain replaceable implementations behind the same DAW contract.

## Business Goals

- **Complete the film pipeline in one product**: Let a filmmaker move from screenplay and storyboard through scoring, mixing, approval, and final movie assembly entirely inside Film Engine.
- **Make story drive the score**: Ground musical choices in the exact screenplay passage, character state, dialogue density, emotion curve, shot order, picture timing, and visual language.
- **Support human and AI collaboration**: Treat uploaded performances, generated music, native generated parts, and source-separated derivatives as equal but accurately labeled creative inputs.
- **Deliver an editable workstation**: Provide synchronized multitrack arrangement, essential mixer controls, takes, hit points, and deterministic bounce rather than another one-shot generation form.
- **Keep AI actions governable**: Use MCP and provider abstractions for AI analysis and generation, with free previews before spend, explicit approvals, provenance, and immutable prior takes.
- **Interoperate without lock-in**: Export portable, aligned score packages and integrate with Ableton through a narrow adapter without making a DAW or beta SDK mandatory.
- **Protect commercial delivery**: Carry ownership, license, provider, model, source, and derivative lineage from every stem into approved mixes and final exports.

## Current State

| Component | Current State |
|-----------|---------------|
| Music cue model | `film_music_cues` stores five cue types, scene/shot scope, musical direction, timing, gain/fades, rights, generated asset, negative prompts, and structured composition sections. It does not model sessions, tracks, clips, automation, sequence scope, or takes. |
| Picture sequences | `film_sequences` owns ordered shot IDs, generated clips, approval fingerprints, and a sequence master. Music has no durable relationship to this ordered picture unit. |
| Screenplay and picture context | `music_brief` exposes scene heading/action, characters, dialogue density, film look, shot count, and measured cut length. It is scene-scoped and does not compile a versioned sequence brief, local hit points, or an editable emotion curve. |
| AI music provider | The provider registry exposes `music`, `sfx`, and `ambient`; ElevenLabs Music v2 supports prompt and section-plan generation. Reference upload, video-to-music, inpainting, source separation, and native part capability are not represented in the common contract. |
| MCP tools | `music_brief` and cue create/list/update/delete/generate tools provide a sound agent workflow, including free inspection before spend. There are no score-session, stem, bounce, drift, or DAW tools. |
| User audio | Scene music and ambient assets can be uploaded through the generic media path. There is no aligned batch import, instrument/role tagging, waveform-derived technical inspection, warp policy, or session placement. |
| Stem handling | `buildStemExport()` groups project audio into dialogue/music/SFX/ambient/mix payloads. `POST /projects/:id/music/stems` returns a prospective payload and does not render downloadable instrument or delivery stems. |
| Mixing and rendering | Existing logic defines default levels, ducking, LUFS targets, and per-shot/project mix payloads. It does not persist an editable score arrangement or deterministically bounce its tracks and automation. |
| Production UI | Production includes Music, Music Cues, waveform previews, cue sections, score/ambient direction, rights, generation/upload controls, and separate playback buses. It has no shared music ruler/playhead, track lanes, mixer, emotion lane, hit points, clip editing, take comparison, or DAW state. |
| Assets and bundles | Audio assets, provider provenance, project bundles, and render ledger patterns already exist. Instrument-stem identity and lineage must currently be inferred from generic `audio_music` metadata. |
| Rights | Cue-level licensing and a general rights register exist, but final export does not consistently enforce or explain uncleared music lineage. |
| DAW integration | There is no Ableton or Pro Tools adapter, connection state, package manifest, synchronization plan, or MCP bridge. |
| Final assembly | Scene music can participate in existing playback and mix paths, but there is no explicit approval handoff from a score-session mix into the canonical final movie timeline. |

## Target State

| Component | Target State |
|-----------|---------------|
| Canonical score session | A `film_music_session` is attached to an ordered picture sequence or scene fallback and owns the script/picture fingerprint, frame and sample rates, tempo map, emotion curve, markers, lifecycle, and approved mix. |
| Track and clip model | Tracks hold flexible instrument/family/bus roles and mixer state; clips reference immutable assets/takes with source offsets, timeline placement, fades, loop/warp policy, and automation. Existing `audio_music` assets remain compatible while typed stem meaning lives in the music tables and metadata, avoiding unsafe in-place CHECK changes. |
| Screenplay and picture context | A single context compiler gathers exact script version, relevant Fountain passage, characters, dialogue density, ordered shots, timings, camera/visual data, existing motifs, and director intent. It returns a neutral brief plus a stable fingerprint and reports drift without silently changing music. |
| Emotion workflow | Director-authored and AI-proposed time ranges store valence, arousal, label, intensity, source, and confidence. Proposals require acceptance before they influence paid generation. |
| AI generation and separation | Capability discovery covers whole-cue composition, reference/melody conditioning, selected-range inpainting, native parts, video conditioning, and two-/six-stem separation. Long-running parent jobs expose child outputs and never overwrite earlier takes. |
| User stem import | A batch import accepts supported audio files, preserves originals and leading silence, extracts technical metadata and hashes, records rights, optionally normalizes working copies to 48 kHz, and creates aligned tracks/clips in one transaction. |
| Mixing and rendering | The browser provides synchronized draft monitoring and essential non-destructive edits. The backend renders deterministic 48 kHz score mixes and instrument/family or production-bus stems, registers every result, and records all render parameters. |
| MCP and DAW round trip | Intent-level MCP tools expose free session/context/sync plans and confirmed generate, separate, bounce, push, and pull operations. A DAW-neutral manifest drives a local AbletonOSC adapter with acknowledgements, idempotency, stable IDs, and no arbitrary object mutation. |
| Safety, rights, and provenance | Paid and mutating calls disclose cost/effect first; derivatives link to their sources; imported/generated/DAW-returned outputs retain hashes, rights, provider/model/job, operation ID, and audit history. |
| Delivery and testing | An approved score mix is selectable by final assembly, survives bundle export/import, and ships in professional delivery packages. Set-based tests cover every registry entry and an end-to-end fixture proves the screenplay-to-final-movie path with and without Ableton. |

## Constraints

- **Film Engine is authoritative**: Ableton and Pro Tools are editors/adapters; no essential score state may exist only in a DAW project.
- **No DAW dependency for completion**: A final score and movie must be producible when Ableton is absent, offline, unsupported, or disconnected.
- **Sequence-first scope**: New sessions attach to existing ordered `film_sequences`; scene sessions are a fallback for projects without a sequence. Arbitrary cross-project timelines are out of scope.
- **MCP-first AI access**: Story/emotion proposals and agent-driven generation must use Film Engine MCP tools and the provider layer wherever available; routes must not add direct vendor-specific AI calls.
- **Plan before spend or mutation**: Every paid generation/separation and DAW write must have a free preview/diff that identifies provider, inputs, duration, expected outputs, cost when knowable, and version behavior.
- **Director retains judgment**: AI emotion and orchestration are proposals. No model may silently approve an emotion curve, overwrite a cue, or replace an approved take.
- **Three stem meanings stay explicit**: Native generated parts, source-separated derivatives, and rendered delivery stems must use distinct kinds and UI language.
- **48 kHz picture workflow**: Working derivatives, mixes, and delivery stems target 48 kHz. Originals remain unchanged and all resampling is recorded.
- **Non-destructive editing**: Clip placement, trim, gain, pan, fades, automation, loop/warp choices, and take changes are stored as metadata; source assets are immutable.
- **Preserve alignment**: Batch imports and DAW returns retain leading silence and common start time. Automatic silence trimming and implicit warping are prohibited.
- **Asset CHECK migration trap**: Do not attempt to widen the SQLite `film_assets.asset_type` CHECK in place. Reuse compatible types plus validated metadata/music tables unless a separately proven table-rebuild migration is designed.
- **Provider capabilities are optional**: The UI and MCP schemas must discover and report supported operations; absence of native parts, inpainting, or separation must degrade honestly rather than synthesize false support.
- **Long-running jobs are recoverable**: Generation, separation, bounce, package, push, and pull operations require durable status, timeouts, retries where safe, and resumable/result lookup behavior.
- **Ableton stable baseline**: Initial automation targets stable Live 12.4.5 through a reviewed AbletonOSC/Live Object Model bridge. The Suite-only Extensions SDK remains beta and cannot be the release dependency.
- **Allowlisted DAW surface**: The MCP bridge may manage only Film Engine-owned groups/tracks/clips and supervised transport. Generic path/value setters and unrelated-track mutations are out of scope.
- **Portable interchange first**: Equal-length WAV/BWF stems, reference video, tempo/time-signature map, markers, and a manifest are the interoperability baseline for Ableton, Pro Tools, and manual workflows.
- **Rights remain traceable**: Source and derivative lineage must survive generation, separation, bounce, DAW pullback, project bundles, and final export; blocking policy must be explicit rather than silently inferred.
- **Frontend architecture stays compatible**: Extend the existing SPA and HTTP/MCP conventions; do not introduce a second application shell or require Tauri.
- **Test-first breadth**: Feature work begins with set-based registry and integration coverage so every audio kind, provider capability, track role, and DAW mutation follows the same path.

## Task Breakdown

### Phase 1: Native Score Workstation Foundation

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| MUS-001 | Add score-session schema | Add migration `103_music_workstation.sql` for sessions, tracks, clips, emotion ranges, markers, automation, operation lineage, indexes, foreign-key behavior, and constrained lifecycle values. Keep instrument-stem typing in these tables/asset metadata rather than altering `film_assets` CHECK in place. Add set-based schema tests covering every enum/relationship and deletion rule. | L | None |
| MUS-002 | Define music-domain contracts | Create provider-neutral validators and serializers in `backend/lib/music-session.js` for session state, track roles, clip timing, tempo maps, emotion ranges, automation, and lifecycle transitions. Define the canonical `ScoreSession` read model consumed identically by HTTP, MCP, UI, bounce, bundles, and DAW adapters. | L | MUS-001 |
| MUS-003 | Compile sequence score context | Create `backend/lib/music-context.js` to resolve ordered shots from `film_sequences`, the exact screenplay version/passage, character and dialogue context, picture assets/timing, camera/look data, cue sections, and existing motifs. Return the neutral `ScoreBrief` plus deterministic fingerprint and field-level provenance; add drift comparison tests. | L | MUS-001, MUS-002 |
| MUS-004 | Add session HTTP API | Add `backend/routes/music-sessions.js` and register it in `backend/server.js`. Implement project/session list/create, session read/update/delete, track/clip/marker/emotion CRUD, ordered batch operations, context brief, drift status, and explicit rebase. Validate project ownership and perform multi-row edits transactionally. | L | MUS-002, MUS-003 |
| MUS-005 | Add session MCP workflow | Extend `backend/lib/mcp-tools.js` with `music_session_create`, `music_session_list`, `music_session_get`, `music_session_brief`, `music_session_update`, `music_track_*`, `music_clip_*`, `music_emotion_*`, and `music_session_rebase`. Keep reads/briefs free, mark mutations, and ensure MCP schemas derive from the same vocabulary/contracts as HTTP. | M | MUS-004 |
| MUS-006 | Build aligned user stem import | Extend media storage with session-scoped single/batch import for WAV/BWF, AIFF, FLAC, MP3, and M4A. Inspect duration, channel count, sample rate, bit depth, hash, BPM/key hints and MIME; preserve originals/leading silence; create optional 48 kHz working derivatives; atomically create tracks/clips and rights/provenance records. | L | MUS-001, MUS-002, MUS-004 |
| MUS-007 | Build native multitrack editor | Replace the cue-card-only production experience with a score-session selector, story/picture context panel, editable emotion lane, shared ruler/playhead, waveform tracks, shot/hit markers, clip trim/move/loop, take choice, mute/solo/gain/pan/fades, autosave, drift warnings, and aligned drag/drop import. Reuse existing SPA styling and audio playback patterns. | L | MUS-004, MUS-006 |
| MUS-008 | Implement deterministic bounce | Create `backend/lib/music-renderer.js` and session bounce routes/jobs that resolve clips and automation into a repeatable backend render, normalize/validate 48 kHz output, generate a master plus chosen instrument/family or production-bus delivery stems, register assets and render parameters, and expose plan/status/download endpoints. Test silence, overlap, fades, solo/mute, pan/gain, failures, and rerender versioning. | L | MUS-002, MUS-004, MUS-006 |

### Phase 2: AI Composition and Stem Workflows

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| MUS-009 | Expand provider capability registry | Extend provider contracts and discovery for `music_compose`, `music_parts`, `music_separate`, `music_reference`, `music_video`, and `music_inpaint`. Define neutral plan/result schemas, feature limits, cost hints, output taxonomy, and explicit unsupported responses; audit all provider/config/UI/MCP call sites set-wise. | L | MUS-002 |
| MUS-010 | Add MCP emotion proposals | Add an AI proposal flow that sends the `ScoreBrief` through the configured LLM/MCP path and returns time-ranged valence, arousal, label, intensity, rationale, source, and confidence. Store proposals separately from accepted director emotion, validate coverage/bounds, and require explicit accept/edit before generation. | M | MUS-003, MUS-005, MUS-009 |
| MUS-011 | Add ElevenLabs stem separation | Extend `backend/lib/providers/elevenlabs.js` for two-/six-stem separation. Add asynchronous plan/start/status/result handling, safe ZIP validation/unpacking, source preservation, one registered asset and track per returned stem, derivative lineage, partial-failure cleanup, and retry semantics. | L | MUS-006, MUS-008, MUS-009 |
| MUS-012 | Add part, reference, and inpaint generation | Add common workflows for whole-cue composition, provider-native parts where supported, audio/melody reference conditioning, optional video conditioning, and selected-range inpainting. Maintain tempo/key/session context, create immutable takes, and label synthesized parts versus separated derivatives correctly. | L | MUS-008, MUS-009, MUS-010 |
| MUS-013 | Add grouped AI jobs and take lineage | Evolve music job tracking to represent one parent operation with ordered child outputs, provider/model/job identifiers, cost, retries, source asset/context fingerprints, take numbers, acceptance state, and resumable polling. Ensure failed children cannot make a parent appear complete. | M | MUS-009, MUS-011, MUS-012 |
| MUS-014 | Add AI workstation controls | Add free plan panels and confirmed actions for emotion proposal, whole score, selected track/section, separation, reference generation, inpainting, regenerate-as-new-take, A/B audition, and take approval. Hide or explain unsupported capabilities and show exact provider, inputs, duration, expected outputs, cost, and overwrite/version behavior. | L | MUS-007, MUS-010, MUS-011, MUS-012, MUS-013 |

### Phase 3: DAW Package and Ableton MCP Round Trip

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| MUS-015 | Define portable score package | Create a versioned DAW-neutral manifest containing session and operation IDs, reference picture, frame/sample rates, tempo/time-signature map, markers, equal-length aligned WAV/BWF stems, track/clip placement, rights/provenance, hashes, and round-trip matching keys. Add package build/validate/import APIs and deterministic archive tests. | L | MUS-008, MUS-013 |
| MUS-016 | Define DAW adapter interface | Add a transport-independent adapter contract for status, session read, push-plan, push, pull-plan, pull, and supervised transport. Specify acknowledgements, idempotency, stable external IDs, conflict reporting, timeouts, audit records, and the boundary that only Film Engine-owned tracks may change. | M | MUS-015 |
| MUS-017 | Build AbletonOSC local sidecar | Build a separately permissioned local sidecar pinned to a reviewed AbletonOSC version for stable Live 12.4.5. Implement localhost configuration, version handshake, typed request/response correlation, reconnect behavior, operation allowlist, health diagnostics, and a fake-Live protocol harness; document installation without bundling unsupported Ableton components. | L | MUS-016 |
| MUS-018 | Expose Ableton MCP tools | Add `ableton_status`, `ableton_session_read`, `ableton_score_push_plan`, `ableton_score_push`, `ableton_mix_pull_plan`, `ableton_mix_pull`, and supervised `ableton_transport`. Push idempotently into one named Film Engine group; pull immutable mix/stem versions only after hash and alignment validation; never expose an arbitrary Live Object Model setter. | L | MUS-005, MUS-016, MUS-017 |
| MUS-019 | Add DAW connection and sync UI | Add connection/version/compatibility state, package export, push/pull diff review, operation progress, conflict resolution, audit history, and recovery guidance to the workstation. Ensure every Ableton action has an equivalent portable package path and the editor remains fully functional while disconnected. | M | MUS-014, MUS-015, MUS-018 |

### Phase 4: Final Pipeline Integration and Hardening

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| MUS-020 | Integrate approved score with assembly | Add an explicit session approval/select workflow and update timeline, playback, audio mix, pipeline orchestration, NLE export, and final assembly to consume the selected score mix exactly once at its canonical offset. Report stale/unapproved/missing mixes and prevent duplicate legacy scene music from layering under an approved session mix. | L | MUS-008, MUS-014 |
| MUS-021 | Extend project bundles and recovery | Export/import every session, track, clip, emotion, marker, automation, job, operation, package, and associated asset with complete ID remapping and hashes. Verify an imported project can reopen, play, rebounce, and reassemble without the original machine or DAW. | L | MUS-015, MUS-020 |
| MUS-022 | Enforce rights and provenance gates | Propagate source rights to generated/separated/bounced/DAW-returned derivatives, expose a complete score lineage report, and implement the chosen warn/block policy at approval and final export. Distinguish original, generated, licensed, public-domain, and unknown material without assigning unsupported rights. | M | MUS-006, MUS-011, MUS-015, MUS-020 |
| MUS-023 | Complete documentation and operations | Update API and MCP guides, production workflow documentation, environment/config references, Ableton sidecar setup/troubleshooting, provider capability tables, rights semantics, backup/restore behavior, and migration notes. Add health/status observability for render and DAW operations without exposing secrets or local paths. | M | MUS-018, MUS-021, MUS-022 |
| MUS-024 | Prove the end-to-end movie workflow | Add set-based registry tests for all track roles, audio kinds, provider capabilities, MCP tools, package entities, and DAW mutations; integration tests for failure/recovery and bundle round trip; browser tests for synchronized editing; fake-Ableton contract tests; and a real opt-in Live smoke. Extend the 30-second fixture to prove screenplay passage → picture sequence → emotion → generated/uploaded stems → approved bounce → final movie both with no DAW and through Ableton push/pull. | L | MUS-019, MUS-020, MUS-021, MUS-022, MUS-023 |

## Open Questions

1. Which compact default track-role vocabulary should ship alongside flexible custom roles: production buses only, a small contemporary band set, orchestral families, or a combined starter set?
2. What cost and latency thresholds should the plan endpoint use to warn or require an additional confirmation for two-/six-stem separation and repeated per-track generation?
3. At what workflow gates should unknown or pending music rights warn, and at what gates should they block approval or final export?
4. Which backend renderer is the supported production dependency for clip automation and equal-length BWF/WAV output: the existing external audio-processing endpoint, direct ffmpeg orchestration, or a provider-selected hybrid?
5. Should v1 implement constant-tempo sessions only while preserving a tempo-map schema, or must tempo/time-signature changes be editable in the first release?
6. Is a reference `.mov` sufficient for initial Ableton scoring, or must the package also generate a low-bandwidth proxy format for machines whose Live video codec support is limited?
7. Can the Ableton bridge vendor a pinned third-party AbletonOSC distribution, or must Film Engine maintain its own reviewed Remote Script package after studying the protocol?
8. What constitutes an acceptable real-Live smoke environment in CI/release operations, given Ableton licensing and GUI requirements? The fake protocol suite remains mandatory regardless.
9. When the official Ableton Extensions SDK reaches stable release, what adoption threshold—edition coverage, API stability, and missing capabilities—justifies adding it as a second adapter or replacing the OSC bridge?
10. Should Pro Tools PTSL round trip enter this epic after Ableton proves the neutral contract, or be tracked as a follow-up epic? The architecture supports it, but it is not required for the accepted Ableton-first direction.

## Success Metrics

- A filmmaker can create or open a score session from every valid Film Engine picture sequence, with scene fallback when no sequence exists.
- The session brief identifies the exact screenplay version, passage, ordered shots, picture duration, dialogue density, visual context, cue data, and fingerprint; changing any contributing input produces a visible drift result without altering the score.
- A director can author or accept an emotion curve and can generate music only after reviewing a free MCP/provider plan describing inputs, provider, duration, output count, cost when available, and take behavior.
- Users can import multiple aligned stems in one action; originals and leading silence remain byte-identical, working derivatives are 48 kHz, and every file has technical metadata, hash, role, rights, and provenance.
- The native workstation supports synchronized picture/audio playback, shot and hit markers, track mute/solo/gain/pan, clip placement/trim/loop/fades, take audition/approval, and reliable autosave/reload.
- Whole-score generation, every advertised provider capability, and two-/six-stem separation either complete into correctly typed immutable tracks or return an explicit unsupported/failed state; no partial job is reported as complete.
- Backend bounce produces a registered 48 kHz master and requested equal-length stems whose duration/alignment matches the session within one audio sample and whose render parameters permit an identical rerender.
- An approved session mix appears once—and only once—in playback, project audio mix, NLE export, pipeline assembly, and the final rendered movie; a project with no Ableton installation can complete this path.
- The portable package imports into a clean project with reference picture, tempo, markers, aligned audio, rights, hashes, and placement intact, and a Film Engine bundle round trip can rebounce the same session.
- Against a compatible Live 12.4.5 installation, the Ableton bridge can preview a diff, idempotently push Film Engine-owned tracks and markers, pull returned mixes/stems as new versions, recover from disconnects, and prove it never changes unrelated tracks.
- Every AI-facing score action is available through MCP with context/action parity to HTTP and UI, and no new route bypasses the provider abstraction for vendor-specific AI queries.
- Set-based tests enumerate 100% of music track roles, asset metadata kinds, provider capabilities, MCP tools, package entities, and DAW mutations across their required storage, bundle, rights, rendering, and documentation consumers.
- The extended 30-second fixture passes both required end-to-end paths: screenplay → final movie entirely in Film Engine, and the same project through Ableton plan/push/pull → final movie.
- Operational diagnostics expose failed/stalled generation, separation, render, package, and DAW operations with actionable recovery information and without secrets or unredacted local paths.
