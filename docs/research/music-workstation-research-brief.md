# Film Engine Music Workstation Research Brief

## Research Brief: Film Engine Music Workstation and DAW Integration

### Executive Summary

Film Engine already contains strong music foundations—scene-aware briefs, structured cue sections, ElevenLabs Music v2 generation, cue and rights management, user audio upload, waveform playback, mix specifications, stem manifests, and MCP tools—but it does not yet provide an editable, sequence-scoped multitrack composition environment. The recommended product is a Film Engine-native score workstation that remains usable without a DAW, complemented by portable stem packages and a tightly permissioned Ableton MCP bridge; Ableton’s official Extensions SDK should be revisited after it leaves its current Live 12 Suite beta restriction.

### Key Themes

- **Film Engine must remain the source of truth.** Score timing, assets, context, versions, rights, and approval state should not live only inside an Ableton or Pro Tools session.
- **A film score needs two time scales.** Global screenplay context defines narrative purpose, motifs, instrumentation, and emotional arc; local shots and hit points define entrances, exits, builds, drops, and accents.
- **Emotion must be editable data.** Store valence, arousal, label, intensity, time range, source, and confidence instead of flattening every emotional judgment into prose.
- **“Stems” describes three products.** Native generated parts, AI-separated derivatives, and rendered delivery buses have different quality, provenance, and editing properties.
- **Imported material is equal to generated material.** User stems need aligned multi-file import, technical inspection, rights metadata, and non-destructive normalization.
- **MCP should expose intent-level operations.** Free read/plan tools should precede paid generation or DAW mutations; arbitrary Live Object Model setters create unnecessary risk.
- **DAW integration needs a universal fallback.** Equal-length 48 kHz WAV/BWF stems, reference video, markers, tempo data, and a manifest work across Ableton, Pro Tools, and disconnected workflows.
- **Picture changes create score drift.** Script, storyboard, shot-order, duration, or cut changes must invalidate or flag the score context rather than silently sliding or regenerating music.

### Top Ideas & Opportunities

1. **Canonical score session**
   - **What it is:** A sequence-scoped music session containing tempo/time-signature maps, tracks, clips, markers, automation, picture/script fingerprints, takes, and the approved mix.
   - **Why it matters:** Existing music cues describe and generate one piece of audio, but cannot represent editable instrument lanes or synchronize a composition to an ordered sequence.
   - **How it could apply:** Create a session from an existing Film Engine video sequence, seed it from `film_music_cues.sections_json`, and preserve stable relationships to the exact screenplay and picture versions.

2. **Screenplay and picture context engine**
   - **What it is:** A free, inspectable brief combining the screenplay passage, character state, dialogue density, sequence story, ordered shot timing, camera motion, visual tone, existing motifs, and director-authored emotion curve.
   - **Why it matters:** Research on script- and video-conditioned music shows that global narrative context and local visual timing contribute different information.
   - **How it could apply:** Add an MCP `music_session_brief` tool that returns context and provenance without making musical decisions or spending money; a separate MCP proposal tool can suggest an emotion curve for director approval.

3. **AI generation and separation pipeline**
   - **What it is:** Capability-based jobs for whole-cue generation, native part generation where providers support it, source separation into two/six estimated stems, reference/melody conditioning, and selected-range inpainting.
   - **Why it matters:** A provider may generate a coherent mix but not true instrument parts. Treating separated outputs as original stems would misstate their fidelity and provenance.
   - **How it could apply:** Extend the existing provider registry and ElevenLabs adapter, preserve the source mix, safely unpack each returned stem, create one asset per output, and group child jobs under one operation.

4. **User stem import**
   - **What it is:** Single or batch upload of WAV/BWF, AIFF, FLAC, and preview formats, with technical inspection, aligned placement, instrument/role tags, rights, BPM/key, and explicit warp policy.
   - **Why it matters:** Composers need to combine their recordings and licensed material with AI output. Leading silence and shared start time must be preserved for synchronization.
   - **How it could apply:** Drag several equal-length files into a session to create aligned tracks; retain originals, create normalized 48 kHz derivatives for Film Engine playback/rendering, and never trim silence automatically.

5. **Mixing and rendering inside Film Engine**
   - **What it is:** A synchronized waveform timeline with mute, solo, gain, pan, fades, clip trim/move/loop, markers, automation, take selection, and real backend bounce.
   - **Why it matters:** The current “stem export” returns a processing payload rather than downloadable audio. The end-to-end Film Engine acceptance criterion requires a final movie without depending on an external DAW.
   - **How it could apply:** Use wavesurfer/Web Audio for interactive monitoring, while a deterministic backend renderer produces registered 48 kHz mix and delivery-stem assets with captured parameters.

6. **MCP and DAW round trip**
   - **What it is:** A local Ableton bridge exposing a small set of typed, acknowledged operations to inspect a Set, preview a synchronization diff, push Film Engine tracks/clips/markers, and pull rendered mixes/stems.
   - **Why it matters:** Community projects show Ableton MCP control is feasible today through AbletonOSC or a Remote Script. The official Extensions SDK is promising but remains beta-only and Suite-only.
   - **How it could apply:** Build or audit a sidecar over AbletonOSC for Live 12.4.5, update only a named Film Engine track group using stable external IDs, and keep a manifest/file handoff as the baseline. Add Pro Tools later behind the same DAW-neutral contract using Avid PTSL.

7. **Safety, rights, and provenance**
   - **What it is:** Explicit confirmation for paid or mutating actions, operation IDs, idempotent synchronization, allowlisted DAW tools, audit logs, source hashes, license lineage, provider/model/job data, and versioned outputs.
   - **Why it matters:** AI generation spends money, DAW tools mutate creative work, and source-separated or uploaded music can carry rights restrictions that must survive into delivery.
   - **How it could apply:** Follow the existing Film Engine pattern of free planning before generation; reject unrestricted `set_live_object` tools; never overwrite an approved take; and propagate rights from source assets to derivatives.

8. **Delivery and testing**
   - **What it is:** Portable score packages and set-based coverage over every audio asset kind, provider capability, track role, and DAW mutation.
   - **Why it matters:** A working music editor is incomplete unless its approved mix reaches the assembled film, survives bundle export/import, and can be reproduced.
   - **How it could apply:** Export reference video, equal-length 48 kHz WAV/BWF files, cue markers, tempo map, and a manifest. Prove screenplay → sequence → emotion → generated/imported tracks → bounce → final movie with and without Ableton.

### Technical Approaches

1. **Data model**
   - Add `film_music_sessions` keyed to a project and optionally a picture sequence, with screenplay version, picture asset/version, cut fingerprint, frame rate, sample rate, tempo map, status, and approved mix.
   - Add `film_music_tracks` for instrument/bus/role, ordering, color, gain, pan, mute, solo, and grouping.
   - Add `film_music_clips` for asset/take, source offset, timeline placement, duration, fades, loop/warp policy, and generation/import provenance.
   - Add time-ranged emotion points, markers/hit points, and automation in normalized tables or validated JSON where update and query patterns justify it.
   - Extend asset types and bundle/export registries set-wise for instrument stems, score mixes, MIDI, manifests, and DAW artifacts.

2. **Context compilation**
   - Resolve ordered shots from `film_sequences`, not database insertion order.
   - Gather the exact Fountain/script version, scene action and dialogue, character states, storyboard/video assets, shot durations, camera motion, and look/color metadata.
   - Produce a neutral score brief and fingerprint it. Surface drift when any contributing input changes.
   - Keep AI emotion analysis behind MCP/provider abstractions and record model output as a proposal with source/confidence, never an automatic final decision.

3. **Provider architecture**
   - Add explicit provider capability metadata for `music_compose`, `music_parts`, `music_separate`, `music_reference`, `music_video`, and `music_inpaint`.
   - Extend the current ElevenLabs provider instead of calling its endpoints directly from routes.
   - Represent long-running separation/generation as parent jobs with independently persisted child outputs and resumable status.
   - Keep an interchangeable local separator provider boundary; Demucs is viable prior art but its archived upstream should not become a hard dependency.

4. **Audio engine**
   - Use waveform tooling for display and synchronized Web Audio nodes for draft monitoring.
   - Store edits as metadata and render final audio on the backend for repeatability, 48 kHz conformity, and reliable integration with the existing asset ledger.
   - Preserve original uploads; generate normalized working derivatives; record resampling, gain, fades, and automation in render parameters.
   - Render actual downloadable instrument/family and DX/MX/FX delivery stems rather than returning only a manifest payload.

5. **Frontend**
   - Replace the cue-card-only experience with a session selector, picture/story context panel, emotion lane, shared ruler/playhead, multitrack lanes, mixer controls, and generation/import actions.
   - Synchronize reference video/storyboard thumbnails to the audio transport and expose markers at shot boundaries and director-defined hit points.
   - Make every paid action preview its provider, prompt/context, duration, output count, estimated cost, and version behavior.

6. **DAW adapters**
   - Define a DAW-neutral score manifest before writing an Ableton-specific bridge.
   - For the current stable Ableton path, use an allowlisted local adapter over AbletonOSC/Live Object Model with version handshake, acknowledgements, timeouts, stable IDs, and plan/apply operations.
   - Prototype Ableton Live Set Export for one-way project creation, while retaining stem packages for recovery and cross-DAW compatibility.
   - Reassess the official Ableton Extensions SDK when it ships outside beta; target Pro Tools separately through PTSL without changing Film Engine’s canonical model.

7. **Milestones and dependencies**
   - **Milestone 1 — Native foundation:** schema, context/fingerprint service, session APIs/MCP tools, aligned imports, multitrack playback, and backend bounce. Depends only on existing Film Engine systems.
   - **Milestone 2 — AI composition:** provider capabilities, separation, per-track generation, reference/inpainting, takes, and cost previews. Depends on Milestone 1 persistence and rendering.
   - **Milestone 3 — DAW round trip:** portable package, Ableton plan/push/pull sidecar, supervised transport, and Pro Tools adapter exploration. Depends on stable session/manifest semantics from Milestones 1–2.

### Open Questions

- Should the first session scope be one existing video sequence, one scene, or a user-selected span of scenes? Recommendation: sequence-first with scene fallback.
- Is Ableton integration required for the first release, or can the native workstation and portable stem package ship first? Recommendation: do not block the MVP on Ableton.
- Which first stem taxonomy is most valuable: individual named instruments, orchestral families, or production buses? Recommendation: support flexible roles but ship production buses plus a small instrument vocabulary first.
- Should imported audio be copied into Film Engine storage or referenced in place? Recommendation: copy/hash originals for bundle integrity; optionally remember the external source path.
- Which edits are required in v1: trim/move/fade/gain/pan/mute/solo only, or also time-stretch, plugins, and MIDI piano-roll editing? Recommendation: keep advanced DSP/plugins and piano-roll editing out of the first milestone.
- What is the acceptable cloud cost and latency for six-stem separation and repeated per-track generation? The epic should add provider plan/cost probes before settling defaults.
- Must Ableton support Standard as well as Suite? If yes, the official Extensions SDK cannot become the only bridge under its current edition limits.
- Should DAW synchronization be bidirectional at clip level or push-project/pull-bounce only? Recommendation: start with managed push plus immutable pullback versions; add granular reconciliation after observing real workflows.
- What rights policy should block final export versus merely warn? Existing cue rights are recorded but not enforced, so this is a product decision for the epic.
- Are third-party MCP/OSC components acceptable as vendored dependencies, or must the bridge be implemented and maintained in-house after protocol study?

### Recommended Direction

Build the native Film Engine score workstation first around a canonical, sequence-scoped session model. Milestone 1 should deliver screenplay and picture context, director-editable emotion, aligned generated and imported tracks, synchronized preview, real backend mix/stem rendering, asset registration, and insertion of the approved mix into the final movie pipeline. This directly advances the product’s end-to-end acceptance criterion and leaves no DAW dependency.

Then add AI composition through the existing provider and MCP conventions: free context/plan calls before paid generation, explicit provider capability discovery, immutable takes, source separation clearly labeled as derivative, and full provenance. Finally, build a narrow AbletonOSC-based MCP sidecar for stable Live 12.4.5 with plan-before-apply synchronization and portable files as the fallback. Track the official Ableton Extensions SDK as the preferred future in-Live experience, but do not tie the release to a beta, Suite-only API.
