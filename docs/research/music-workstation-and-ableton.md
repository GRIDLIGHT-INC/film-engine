# Film Engine Music Workstation and Ableton Integration

## Research Scope

The requested outcome is a production-area music workspace that turns screenplay and picture context into editable music, supports generated and uploaded instrument stems, sequences cues against shots, exports a final mix, and can hand work to or control a current DAW through MCP where practical.

The code-derived scope contains 20 integration surfaces: four music/audio schema families plus two later schema extensions; two music/audio domain libraries and two deliverable libraries; four routes; the provider/MCP/server registration layer; the SPA; and two user-facing documentation contracts. The exact set is enumerated under Local Findings. The validation test is `node --test backend/tests/music-workstation-research.test.js`; it iterates that set, five evidence categories, the three required report sections, and a minimum of 15 distinct sources.

## Executive Conclusion

Film Engine should own the canonical score timeline and treat Ableton or Pro Tools as optional high-end editors, not as its database. The application already has most of the lower-level primitives: scene-aware briefs, cue metadata, timed composition sections, ElevenLabs Music v2 generation, uploaded scene music, waveform previews, mix payloads, project stem manifests, rights metadata, and MCP tools. What is missing is the workstation layer between them: sequence-scoped score sessions, instrument-level tracks and clips, per-track generation/import, synchronized transport, automation, versions, actual rendered stems, and round-trip DAW synchronization.

Ship this in three increments. First, build a Film Engine multitrack score editor using native HTML/Web Audio for monitoring and the existing backend/provider architecture for durable generation and rendering. Second, add a local DAW bridge using an audited subset of AbletonOSC/Live Object Model operations exposed as MCP tools. Third, evaluate Ableton's official Extensions SDK once it is available in stable Live; it is the most attractive long-term integration but is beta-only as of Live 12.4.5. Keep Broadcast Wave/WAV stems plus a manifest as the universal interchange path throughout.

## Web Findings

### Ableton official

1. **Ableton, “Live 12 Release Notes.”** [Source](https://www.ableton.com/en/release-notes/live-12/)
   - **Key insight:** Live 12.4.5 is the current stable release dated August 26, 2026. The release line continues to update the Live Object Model and Max for Live API, while 12.3 added built-in stem separation and later GPU acceleration on supported macOS systems.
   - **Relevance:** Film Engine must target 12.4.5 compatibility, but must distinguish stable features from beta-only Extensions.

2. **Ableton, “Extensions SDK.”** [Source](https://www.ableton.com/en/live/extensions/)
   - **Key insight:** The new open JavaScript SDK can read and rewrite tracks, clips, MIDI, devices, tempo, and Set structure and can connect to external services. It requires Live 12 Suite 12.4.5 or later in the beta program; it is not available in Standard, Intro, or Lite.
   - **Relevance:** This is the cleanest long-term in-Live Film Engine companion, but edition and beta-channel requirements make it inappropriate as the sole shipping path.

3. **Ableton, “Ableton Extensions SDK — Public Beta.”** [Source](https://ableton.github.io/extensions-sdk/)
   - **Key insight:** The official SDK uses JavaScript/TypeScript and Node.js 24.16.0, is explicitly public beta, and does not work with earlier Live versions.
   - **Relevance:** A future Film Engine extension can pull a score manifest, create tracks/clips, and push edits back. The beta API should sit behind an adapter so it can change without destabilizing Film Engine.

4. **Cycling ’74, “Live API Overview.”** [Source](https://docs.cycling74.com/legacy/max8/vignettes/live_api_overview)
   - **Key insight:** Max for Live exposes Live through the hierarchical Live Object Model, including tracks, clips, devices, and control surfaces.
   - **Relevance:** This is the established supported control substrate behind Max devices and community OSC bridges. It is appropriate for controlled session manipulation, not for making the `.als` file format Film Engine’s database.

5. **Ableton, “Stem Separation.”** [Source](https://www.ableton.com/en/live-manual/12/stem-separation/)
   - **Key insight:** Live can locally split mono or stereo audio into Vocals, Drums, Bass, and Others; resulting clips are placed on separate tracks. High Quality improves SDR at increased processing cost, and separation artifacts/bleed remain possible. Output stems are 44.1 kHz.
   - **Relevance:** Ableton separation is useful after handoff, but Film Engine’s picture pipeline is standardized around 48 kHz. Imports therefore need explicit sample-rate normalization, provenance, and a warning that separated stems are not original multitracks.

6. **Ableton, “Working with Video.”** [Source](https://www.ableton.com/en/live-manual/12/working-with-video/)
   - **Key insight:** Live’s Arrangement View can score QuickTime video, align music to edits with Warp Markers, and export audio/video.
   - **Relevance:** A DAW handoff should include a reference `.mov`, timecode/hit points, cue markers, tempo, and stems aligned from zero. Film Engine remains responsible for reattaching the returned mix to the editorial timeline.

7. **Ableton, “Managing Files and Sets — Exporting Audio and Video.”** [Source](https://www.ableton.com/en/manual/managing-files-and-sets/)
   - **Key insight:** “All Individual Tracks” renders equal-length files that align in other multitrack programs; selected-track export and return/main-effects options are available.
   - **Relevance:** Equal-length 48 kHz WAV/BWF files are the safest round-trip contract. They work even when automation APIs or a DAW bridge is unavailable.

8. **Ableton Support, “Importing and exporting stems.”** [Source](https://help.ableton.com/hc/en-us/articles/360000843404-Importing-and-exporting-stems)
   - **Key insight:** Stem imports should preserve leading silence, disable automatic warping/fades when exact alignment matters, use a shared source tempo, and export all tracks over the same arrangement range.
   - **Relevance:** Film Engine’s handoff manifest should state start time, duration, tempo map, sample rate, bit depth, and whether warping is allowed; filenames alone are insufficient.

9. **Ableton, “Ableton @ GitHub.”** [Source](https://ableton.github.io/)
   - **Key insight:** Ableton publishes an official Live Set Export library in addition to Link-related SDKs.
   - **Relevance:** Live Set Export is worth prototyping for one-way `.als` creation, but a manifest-and-WAV export remains necessary for Pro Tools and recovery. Ableton Link is synchronization technology, not a session-editing API.

### Ableton MCP prior art

10. **ideoforms, “AbletonOSC.”** [Source](https://github.com/ideoforms/AbletonOSC)
    - **Key insight:** A mature MIT-licensed MIDI Remote Script maps OSC to the Live Object Model, supports Live 11+, uses ports 11000/11001, and covers Song, Track, Clip, Device, transport, and listeners.
    - **Relevance:** This is the best-established transport for a shipping bridge today. Film Engine should vendor or pin a reviewed version and expose only the operations it needs.

11. **Simon-Kansara, “ableton-live-mcp-server.”** [Source](https://github.com/Simon-Kansara/ableton-live-mcp-server)
    - **Key insight:** This project layers a Python OSC daemon and FastMCP server over AbletonOSC and maps its OSC addresses to MCP tools.
    - **Relevance:** It proves feasibility but adds two processes and broad low-level capabilities. It is better as architectural prior art than an unreviewed production dependency.

12. **lexi-personal, “ableton-live-mcp.”** [Source](https://github.com/lexi-personal/ableton-live-mcp)
    - **Key insight:** A Remote Script exposes the Live Object Model through TCP/JSON on port 9877, with a Python client and MCP layer.
    - **Relevance:** TCP request/response is easier to correlate than raw OSC, but the project remains community code running inside Live. A Film Engine adapter must include version handshake, allowlists, timeouts, and idempotency.

13. **ju5tinz, “ableton-mcp-server.”** [Source](https://github.com/ju5tinz/ableton-mcp-server)
    - **Key insight:** This TypeScript/Bun implementation provides typed `Song`/`Track`/`Clip`/`Device` objects, acknowledges mutations only after Live executes them, and tests the OSC protocol against an in-memory Ableton stand-in plus an optional real-session suite.
    - **Relevance:** Its acknowledgement and fake-session testing patterns are especially strong. Film Engine should copy the contract style—typed operations and observable completion—even if it does not adopt the package wholesale.

14. **Model Context Protocol, “Tools.”** [Source](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
    - **Key insight:** MCP tools have discoverable schemas and explicit invocation/result semantics.
    - **Relevance:** DAW mutations should be narrow tools such as `ableton_session_read`, `ableton_score_push`, and `ableton_mix_pull`, not a generic arbitrary Live-Object setter. Read/plan tools should remain free and mutation/spend tools must be clearly marked, matching Film Engine’s existing MCP conventions.

15. **Avid, “Pro Tools Scripting SDK.”** [Source](https://developer.avid.com/scripting/)
    - **Key insight:** Pro Tools exposes a language-independent scripting API for automated workflows.
    - **Relevance:** Pro Tools can follow the same adapter boundary as Ableton. It should not block the MVP, but a DAW-neutral score manifest avoids locking the model to Live.

16. **skrul, “protools-mcp-server.”** [Source](https://github.com/skrul/protools-mcp-server)
    - **Key insight:** An experimental MCP server maps MCP to Avid’s PTSL gRPC API and includes session, timeline, bounce, and audio-analysis operations.
    - **Relevance:** Pro Tools MCP is feasible and, because PTSL is official, may be more stable than current Ableton community bridges. The repository is early-stage, so it should be evaluated rather than embedded unreviewed.

### AI music and stems

17. **ElevenLabs, “Music API Reference.”** [Source](https://github.com/elevenlabs/skills/blob/main/music/references/api_reference.md)
    - **Key insight:** Music v2 supports prompt or structured composition-plan generation, detailed/streaming responses, upload, video-to-music, and inpainting. Prompt length generation covers 3–600 seconds; the API distinguishes model-specific plan shapes.
    - **Relevance:** Film Engine already adapts its neutral sections to ElevenLabs v1/v2. Next work should add provider capabilities for reference upload, video-to-music, inpainting, and stem separation rather than bypassing the provider layer.

18. **ElevenLabs, “Stem Separation.”** [Source](https://elevenlabs.io/docs/api-reference/music/separate-stems?explorer=true)
    - **Key insight:** The API accepts uploaded audio and returns a ZIP with either two or six stems; it may be high latency and supports multiple output formats.
    - **Relevance:** This is the fastest cloud route from an uploaded or generated mix to editable component stems. The job must be asynchronous, preserve the source asset and provider provenance, unpack safely, and register every returned file.

19. **Meta, “Demucs.”** [Source](https://github.com/facebookresearch/demucs)
    - **Key insight:** Demucs offers local two-, four-, and experimental six-source separation, is MIT licensed, and can export float32 or int24. The original repository was archived in January 2025.
    - **Relevance:** It is a useful offline fallback, but the archived upstream and weak piano result noted by its maintainers mean Film Engine should implement a generic separation provider contract rather than hardwire Demucs.

20. **Spotify, “Basic Pitch.”** [Source](https://github.com/spotify/basic-pitch)
    - **Key insight:** Basic Pitch converts polyphonic audio to MIDI with pitch bends, works best on a single instrument, and is available under Apache-2.0/GPL terms with platform-specific runtimes.
    - **Relevance:** After separating a melodic stem, optional audio-to-MIDI conversion enables genuine note editing in Ableton. It should be an explicit lossy derivative, never replace the audio master.

### Screenplay, emotion, and video conditioning

21. **Angert et al., “ScripTONES: Sentiment-Conditioned Music Generation for Movie Scripts.”** [Source](https://arxiv.org/abs/2401.07084)
    - **Key insight:** The two-stage method extracts continuous valence/arousal from a scene and conditions piano-MIDI generation on it. It identifies motif, emotion, orchestration, and shot-level fitting as separate creative problems.
    - **Relevance:** Film Engine should store emotion as editable data (`valence`, `arousal`, label, intensity, confidence/source), not flatten it into one prose prompt. The model’s inference must remain a proposal the director can override.

22. **Copet et al., “Simple and Controllable Music Generation.”** [Source](https://arxiv.org/abs/2306.05284)
    - **Key insight:** MusicGen supports both text conditioning and melodic conditioning, with human and automatic evaluation demonstrating controllability benefits.
    - **Relevance:** Per-track generation needs reference/melody conditioning capability flags. A melody or motif stem should be reusable across sequences without pretending every provider supports it.

23. **Tian et al., “VidMuse: A Simple Video-to-Music Generation Framework with Long-Short-Term Modeling.”** [Source](https://openaccess.thecvf.com/content/CVPR2025/html/Tian_VidMuse_A_Simple_Video-to-Music_Generation_Framework_with_Long-Short-Term_Modeling_CVPR_2025_paper.html)
    - **Key insight:** Long- and short-term visual cues improve both semantic and temporal alignment; the work evaluates on 360,000 video-music pairs across trailers, advertisements, and documentaries.
    - **Relevance:** A score brief should combine global sequence story/emotion with local shot motion and hit points. Passing only a scene synopsis loses the timing signal.

24. **Qi et al., “Customized Condition Controllable Generation for Video Soundtrack.”** [Source](https://openaccess.thecvf.com/content/CVPR2025/html/Qi_Customized_Condition_Controllable_Generation_for_Video_Soundtrack_CVPR_2025_paper.html)
    - **Key insight:** The method jointly aligns video, sound effects, and music and provides score-guided control rather than treating soundtrack generation as a single undifferentiated output.
    - **Relevance:** Film Engine’s existing separation of score, SFX, ambient, and dialogue is architecturally correct. The workstation should preserve these buses while allowing shared hit points and emotion curves.

25. **Zhuo et al., “Video Background Music Generation: Dataset, Method and Evaluation.”** [Source](https://openaccess.thecvf.com/content/ICCV2023/papers/Zhuo_Video_Background_Music_Generation_Dataset_Method_and_Evaluation_ICCV_2023_paper.pdf)
    - **Key insight:** The work uses semantic and color features to control musical harmony and targets both rhythm and style alignment with video.
    - **Relevance:** Film Engine already owns storyboard frames, shot timing, camera motion, and look/color metadata. These should be summarized into a provider-neutral “picture analysis” rather than sending full video to every model.

### Open-source audio infrastructure

26. **MDN, “OfflineAudioContext.”** [Source](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext/OfflineAudioContext)
    - **Key insight:** Browser audio graphs can render to an `AudioBuffer` without real-time playback and are broadly available.
    - **Relevance:** Web Audio can support non-destructive preview, gain/pan/fade automation, and draft bounce. Final deterministic delivery should still use the backend/ffmpeg path and register its exact parameters.

27. **wavesurfer.js, “Audio waveform player.”** [Source](https://github.com/katspaugh/wavesurfer.js/)
    - **Key insight:** wavesurfer.js provides performant waveform and timeline display, but explicitly does not aim to implement cutting, effects, or audio processing.
    - **Relevance:** It is suitable for the UI layer only. Film Engine should keep clip edits and automation in its own domain model and use Web Audio/backend rendering for sound.

28. **wavesurfer-multitrack, “Multitrack player.”** [Source](https://github.com/katspaugh/wavesurfer-multitrack)
    - **Key insight:** The companion project demonstrates synchronized multiple waveform tracks with timeline integration and a Web Audio player.
    - **Relevance:** It is strong prototype prior art for the workstation view, but its data structures should be adapted to Film Engine IDs, versions, frame time, and assets rather than becoming the persistence contract.

## Local Findings

### Schema and registries

1. **`backend/db/migrations/016_film_music_and_color.sql`** defines `film_music_cues` with five cue kinds (`score`, `source`, `sfx`, `ambient`, `transition`), scene/shot scope, musical facts, start/duration, gain/fades, notes, and a generated-asset pointer. It has no sequence ID, track identity, clip lanes, take/version relationship, automation curve, or per-instrument asset link.

2. **`backend/db/migrations/023_music_generation.sql`** defines durable music jobs for score/SFX/ambient/transition with prompt, model, timing, tempo, seed, output, and status. It has one output path and no parent/child job model for multi-stem generation or separation.

3. **`backend/db/migrations/033_audio_deliverables.sql`** stores planned stereo, 5.1, stems, M&E, dialogue, music, SFX, ambient, and master deliverables with technical format metadata. It describes deliverables but does not render or link their output assets.

4. **`backend/db/migrations/038_music_rights.sql`** adds license status/type/holder/cost/expiry/territory to cues. User uploads and separated/generated derivatives will also need rights/provenance at asset and stem level.

5. **`backend/db/migrations/043_film_assets_scene_id.sql`** makes scene-level audio assets directly addressable. That supports existing score/ambient playback but not sequence-scoped placement.

6. **`backend/db/migrations/091_music_sections.sql`** adds structured cue sections and negative direction. Sections shape a single generated cue over time; they are not DAW tracks or independently editable stems.

### Domain logic

7. **`backend/lib/music-prompt.js`** maps 14 moods to tempo, instruments, energy, and genre; builds score, SFX, and ambient payloads; includes scene/location/time context; and standardizes 48 kHz output. The fixed mood map is useful as a default but too coarse for an editable emotion curve.

8. **`backend/lib/music-sections.js`** validates 3–120 second sections, a 600 second total, global/local positive and negative styles, and cut-fit reporting. This should remain the high-level composition plan that seeds a workstation session.

9. **`backend/lib/audio-mixer.js`** defines mix levels, ducking, LUFS targets, SRT generation, and `buildStemExport()`. Its “stems” are grouped buses (`dialogue`, `music`, `sfx`, `ambient`, `mix`) and the function returns a payload only; they are not instrument stems and are not rendered files.

10. **`backend/lib/audio-deliverables.js`** produces stereo/5.1/M&E/stem delivery specifications. It is a delivery contract, not an interactive arrangement engine.

### HTTP, providers, and storage

11. **`backend/routes/assets.js`** implements cue CRUD, section validation, rights vocabulary, and five cue types. Cue creation accepts an instrument list as prompt metadata but does not create instrument tracks.

12. **`backend/routes/music-gen.js`** creates scene score/SFX/ambient assets, supports cue-addressed generation, batch generation, scene audio mix, SRT, and `POST /projects/:id/music/stems`. The stem endpoint only returns a prospective processing payload and explicitly says to send it to an audio processor; it does not produce downloadable stems. Generated output is a single music asset per cue.

13. **`backend/routes/audio-deliverables.js`** manages deliverable rows and returns a manifest. There is no bounce/render/approval workflow or asset link for completed deliverables.

14. **`backend/routes/sequences.js`** is a mature picture-sequence system with ordered shot IDs, generation/stitching, station assets, approval fingerprints, and output assets. Music has no equivalent sequence relationship even though this is the natural source of ordered shots and final picture duration.

15. **`backend/server.js`** registers the routes and MCP dispatcher. There is no Ableton/Pro Tools bridge, DAW connection state, or local-sidecar lifecycle.

The provider registry in `backend/lib/providers/base.js` includes `music`, `sfx`, and `ambient`; `backend/lib/providers/index.js` defaults music to ElevenLabs; and `backend/lib/providers/elevenlabs.js` already adapts neutral plans to `music_v2`. The next implementation should extend those capability contracts instead of calling AI vendors directly from routes, preserving the project’s MCP/provider-first rule.

### MCP and agent workflow

16. **`backend/lib/mcp-tools.js`** already exposes `music_brief`, `music_cue_create`, `music_cue_list`, `music_cue_update`, `music_cue_delete`, and `music_cue_generate`, alongside picture-sequence tools. `music_brief` supplies scene heading/action, characters, dialogue density, shots, film genre/look, cut length, and provenance without deciding the music. This is good MCP-first architecture and should be extended with score-session plan/read/write/render/DAW-sync tools.

17. **`backend/mcp-server.js`** is the existing MCP transport. A DAW adapter can either be composed behind this server or run as a separately permissioned local MCP server. Keeping it separate limits the blast radius of DAW mutations and permits version-specific bridges.

### Frontend and documentation

18. **`src/index.html`** already places Music and Music Cues in Production. It shows per-scene score/ambient sheets, generated/uploaded audio, waveform previews, score/ambient direction, delivery direction, cue sections, rights, and playback buses. It lacks multitrack lanes, a shared ruler/playhead, picture thumbnail/video synchronization inside the music page, per-track mixer controls, clip editing, loop/duplicate/split, automation, take selection, instrument stem creation/import, actual bounce/export, and DAW connection/sync state.

19. **`docs/api-film.md`** documents the asset types and current music endpoints. The asset enum has only `audio_music`, not `audio_stem`, `music_mix`, `midi`, or DAW project/manifest kinds; adding any requires a schema/registry/set-based audit rather than only changing the UI.

20. **`docs/claude-desktop-guide.md`** documents the MCP-first score workflow and correctly warns that `node_gen_music` derives its own prompt while `music_cue_generate` plays the written cue. New workstation tools must retain this free-plan-before-paid-action distinction.

## Key Ideas & Themes

### 1. Canonical model: score session, tracks, clips, and emotion curve

Add a DAW-neutral `music_session` for a Film Engine picture sequence or ordered set of scenes. A session owns frame rate, sample rate (48 kHz), tempo/time-signature map, picture asset/version, screenplay/script version, cut fingerprint, duration, status, and mix asset. Model `music_tracks` separately (instrument/bus/role, gain, pan, mute, solo, color, order) and place `music_clips` on them (asset, source offset, timeline start/duration, fades, loop/warp policy, take/version, generation provenance). Model automation and markers/hit points as explicit time series.

Store both semantic emotion and authorship: valence, arousal, label, intensity, confidence, source (`director`, `screenplay_analysis`, `picture_analysis`, `import`), and time range. AI can propose a curve from screenplay passage and shot/picture analysis through an MCP tool; the director confirms or edits it before paid generation.

### 2. Story-to-score context must be versioned and inspectable

Build one free `music_session_brief` from the exact script version, scene passage, characters, dialogue density, ordered shots, shot timing, storyboard thumbnails/video reference, camera motion, visual color/brightness, director intent, existing motifs, and hit points. Store a fingerprint. When picture or screenplay changes, report drift and require an explicit rebase; never silently regenerate or slide music.

The prompt should distinguish global narrative purpose from local timing. Global context establishes motif, instrumentation, harmonic language, and emotional arc; local sections/hit points establish entrances, exits, builds, drops, and accents. This follows the long/short conditioning evidence and fits the existing `music-sections` abstraction.

### 3. “Generate stems” has three different meanings

- **Native generated parts:** ask a capable model for separate instrument/role outputs sharing a seed/reference/tempo/key and session fingerprint. This is the most editable result but requires provider support and phase-coherence testing.
- **Source separation:** split a finished mix into estimated stems. It is fast to add through ElevenLabs or a local provider, but bleed/artifacts mean these are derivatives, not true multitracks.
- **Delivery stems:** render buses such as DX/MX/FX/ambient or orchestral families from the workstation. The repository currently implements only the manifest/payload for this meaning.

The UI and schema must name these explicitly. Calling all three “stems” will create incorrect expectations and provenance errors.

### 4. Import is a first-class creative path

Accept WAV/BWF, AIFF, FLAC, and optionally MP3/M4A for preview, but normalize final work to 48 kHz WAV while retaining originals. Each import needs file validation, duration/channel/sample-rate inspection, content hash, rights/source declaration, instrument/role tags, BPM/key if known, origin timecode or “starts at zero,” and a user choice about warping. Multiple equal-length files should support one operation that creates aligned tracks. Never infer that silence at the head should be trimmed.

### 5. Ableton strategy: bridge now, official extension later

There is no official Ableton MCP server. Community MCP implementations prove the path, while AbletonOSC is the most mature common substrate. Build or fork a small local sidecar with an allowlisted tool surface:

- `ableton_status` / `ableton_session_read` — version, open Set, tempo, track/clip inventory.
- `ableton_score_push_plan` — free diff showing tracks, clips, markers, and files to create.
- `ableton_score_push` — create/update a named Film Engine group with stable external IDs; never touch unrelated tracks.
- `ableton_mix_pull_plan` — show returned files and matching rules.
- `ableton_mix_pull` — import aligned bounces/stems and create new Film Engine asset versions.
- `ableton_transport` — optional play/stop/seek for supervised sessions only.

Mutations need explicit confirmation, an operation ID, idempotent upsert semantics, acknowledgement after Live executes, bounded localhost ports, connection/version handshake, timeouts, audit log, and undo guidance. Never expose an unrestricted `set_live_object(path,value)` tool to an AI client.

Once Extensions ships in stable Live, provide a Film Engine Extension that invokes the same manifest API. Do not discard the sidecar/file workflow: Extensions is Suite-only and run-once/context-menu oriented, while studios may use Standard, older Live, or Pro Tools.

### 6. Recommended delivery sequence

**Milestone A — Film Engine-native MVP**

Create the session/track/clip/marker schema, derive sessions from existing video sequences, add the free MCP brief and director-approved emotion curve, support aligned multi-file stem upload, and build synchronized multitrack playback with mute/solo/gain/pan/fades. Generate a whole cue using existing APIs, then separate it through a capability-based provider into tracks. Add a real backend bounce that produces and registers 48 kHz mix and stem assets.

**Milestone B — Generative composition**

Add per-track generate/regenerate, reference audio/melody, inpainting of a selected time range, reuse of project motifs, take comparison, and provider capability discovery. Every paid action gets a free plan showing prompt/context, provider/model, estimated count/cost, duration, and overwrite/version behavior. Route AI analysis/generation through existing MCP/provider abstractions wherever available.

**Milestone C — DAW round trip**

Ship a portable score package (reference video, aligned WAV/BWF stems, markers, tempo map, manifest), then a reviewed Ableton MCP sidecar using typed allowlisted operations. Add Pro Tools via PTSL as a later adapter. Promote the official Ableton Extension only after the SDK is stable and its edition/version support meets product requirements.

### 7. Acceptance tests for the eventual epic

The implementation should use set-based tests over registries rather than one happy-path instrument. At minimum, enumerate every audio asset type through storage/serve/bundle/rights/export; every provider stem capability through plan/generate/job/persist; every track role through upload/playback/bounce/manifest; and every DAW mutation through plan/confirm/idempotency/audit. An end-to-end fixture should go screenplay passage → ordered picture sequence → editable emotion curve → generated/imported stems → synchronized mix → registered final movie audio → final export, with an alternate no-DAW path proving Film Engine remains self-sufficient.

## Recommendation

Proceed with an epic centered on the Film Engine-native score session, not on embedding Ableton. Reuse the current cue, section, provider, sequence, asset, rights, playback, and MCP foundations; add the missing multitrack domain model and actual render pipeline first. In parallel, prototype the smallest AbletonOSC-based MCP bridge against Live 12.4.5, and gate adoption on reliable acknowledged clip import/update and mix pullback. Track the official Extensions SDK, but do not make a beta, Suite-only API a release dependency.

## Sources

Sources 1–28 are linked inline in Web Findings. Primary official documentation and papers were preferred; community repositories are identified as prior art rather than authoritative platform contracts.
