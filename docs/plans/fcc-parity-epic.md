# Epic: Final Cut Camera Parity — a real video camera inside Film Engine

## Overview

Film Engine can generate footage and cannot shoot any. Every video in the
pipeline arrives from a provider or from a file somebody made elsewhere, and the
one place the app offers to "shoot" renders
`<input type="file" capture="environment">` — the iOS system camera, with no
exposure lock, no focus control, no monitoring and no idea how long a clip may
be before the upload refuses it. This epic builds a controlled camera with
Final Cut Camera's capability set and wires it to the places footage and
pictures actually enter the pipeline.

It exists because the previous attempt solved the wrong problem. That brief
split the work into "plates now, footage later", recommended plates, and shipped
twelve tasks of still photography when the request was footage. The arithmetic
from those tasks survives and is reused here — peaking, the exposure warning,
the level and aspect maths, and the exposure/white-balance/focus fitting are all
format-agnostic and already mutation-proven. What does not survive is the spine:
`AVCapturePhotoOutput` becomes `AVCaptureVideoDataOutput` + `AVAssetWriter`.
**This epic is therefore NOT phased by medium** — that framing is the specific
mistake being corrected, and repeating it would produce the same outcome.

The user's direction is full parity on the hardware actually present, an
iPhone 17 Pro: HEVC Apple Log, ProRes, ProRes RAW, Apple Log 2 and open gate,
with the transport work that ProRes-class footage requires accepted as part of
the epic rather than struck from it. Nothing is excluded for hardware reasons,
because the hardware is here.

## Business Goals

- **A shot can be shot, not only generated.** `video_raw` is what the pipeline
  calls a shot's footage; today it can only arrive from a provider. This makes
  the phone a source, which is the difference between an AI pipeline and a
  production tool.
- **Previz gets real coverage.** `world-capture` reconstructs a location into a
  navigable world that previz stages shots inside. It is fed today by an
  uncontrolled camera with no exposure lock and no duration budget, which is why
  worlds come back inconsistent.
- **Footage that is worth grading.** Apple Log at 10-bit is the difference
  between footage that survives a grade and footage that falls apart in one.
- **Nothing is lost at the pipe.** A director must never shoot a take that
  cannot leave the phone. Every format states what it costs and how it travels
  before it is chosen, not after it is shot.
- **One camera, not two.** Stills and footage share the controls, the monitoring
  and the upload path, so a fix to either reaches both.

## Current State

| Component | Current State |
|-----------|---------------|
| Video capture | **None.** `AVCapturePhotoOutput` only; no `AVAssetWriter`, no `activeColorSpace` |
| Camera on video targets | `shootControl()` renders the iOS SYSTEM camera (`capture="environment"`) |
| Camera on plate targets | Native, controlled — 5 `uploadControl()` call sites — but stills only |
| Manual controls | Built and mutation-proven for stills: exposure lock, white balance lock, tap-to-focus, lens selection |
| Monitoring | `FocusPeaking` and `ExposureWarning` read the luma plane with correct `bytesPerRow`; format-agnostic |
| Frame access | `AVCaptureVideoDataOutput` present, one subscriber, one plane read per frame |
| Recording formats | None offered; the system camera decides |
| Transport | Raw binary body since FCC-010. `FILE_LIMIT` 150 MB binds a shot; the base64 path still admits ~112 MB; Marble's 100 MB binds a world capture only |
| Capture budget | `capture-policy.js` models 3 ceilings and 3 HEVC modes (1080p30/4k30/4k60) and answers `maxSecondsFor` |
| External storage | Not used |
| Audio with footage | Not captured; `NSMicrophoneUsageDescription` is declared |
| iOS app surface | WKWebView shipping all 33 SPA pages |

## Target State

| Component | Target State |
|-----------|---------------|
| Video capture | `AVCaptureVideoDataOutput` + `AVAssetWriter`, photo output still active alongside it |
| Camera on video targets | The controlled camera, via the same bridge the plates use |
| Recording formats | HEVC (SDR), **HEVC Apple Log (default)**, ProRes 422/HQ, ProRes RAW, Apple Log 2, open gate |
| Format choice | Shown with its cost: MB/min, maximum duration for the chosen transport, and how it will travel |
| Transport | HEVC Log over the existing upload; ProRes-class via external USB-C recording and/or chunked resumable upload |
| Capture budget | `capture-policy.js` extended to every format and every transport, so the budget is right for what was actually chosen |
| Audio | Captured with the footage where the target wants sync sound |
| Monitoring | Peaking, zebras, level, guides — unchanged, now over video frames |
| Surfaces | The camera reaches the targets that hold something PHOTOGRAPHED IN THE WORLD; the rest keep their file upload |

## Constraints

- **Full parity on the hardware present, by the user's direction.** "Use the
  hardware you actually have. ProRes RAW, Apple Log 2, open gate — plus HEVC
  Log. Accepts that ProRes-class footage needs external storage or a new
  transport, which becomes part of the epic rather than out of scope." Nothing
  is struck for hardware reasons.

- **NOT phased by medium.** The previous epic's "plates now, footage later"
  split is the mistake being corrected. Phases here are by capability — spine,
  formats, transport, surfaces — and every phase touches video.

- **Genlock is out, and it is the ONE exclusion.** It requires a Blackmagic
  Camera ProDock, which is a purchase rather than a code change. The user's own
  chosen option says so. If the dock is bought, this becomes a new task rather
  than a re-plan.

- **A format that cannot travel must never be silently chosen.** ProRes 422 HQ
  at 4K30 is ~7 GB/min against a 150 MB pipe. Offering it without its transport
  is how a director loses a take they cannot re-shoot.

- **ASSUMPTION, LABELLED — the surface question is answered by a rule, not a
  list.** The user said "integrated ONLY with the areas where we can add
  pictures and video and previz visualization" but did not enumerate targets.
  The rule applied here: **a target gets the camera if what it holds is
  PHOTOGRAPHED IN THE WORLD.** Under it, 8 of 18 targets qualify (the three
  plates, `continuity-ref`, `storyboard-image`, `mood-board-image`,
  `world-capture`, `video-media`) and 5 do not (`previs-image`, `lipsync-media`
  and `post-media` hold GENERATED artefacts; `orientation-plan` and
  `marketing-asset` hold AUTHORED artwork). `storyboard-image` and
  `mood-board-image` are the marginal calls — a hand-drawn board and a
  photographed reference are both real — and are named here so they can be
  overruled rather than discovered later.

- **ASSUMPTION, LABELLED — the WebView stays; the app opens on the camera.**
  The user said they did not want all of Film Engine in the iOS app. Rewriting
  33 pages into native is a far larger project than this camera and is not what
  was asked for. This epic changes the ENTRY POINT rather than the shell: the
  app opens on the capture surfaces, and the full page remains reachable. It is
  also Open Question 1, because it is a product decision and this is an
  architect's assumption.

- **Existing tests bind.** `ios-app.test.js` requires the bundled page to stay
  byte-identical to `src/index.html`. `film-engine-camera-brief.test.js` carries
  two `gap` claims that must be RESHAPED when this work lands, not deleted.

- **No simulator verification of capture.** A simulator has no camera, no motion
  hardware and delivers no frames. Every task must degrade with a stated reason,
  and the acceptance evidence needs the real phone.

- **Nothing here needs a model.** Device APIs, codecs and file transport; no
  task touches the goal's MCP rabbit hole.

## Task Breakdown

### Phase 1: The recording spine

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| FCC-001 | Record video at all | `AVAssetWriter` fed from the existing `AVCaptureVideoDataOutput`, writing HEVC to a file. The photo output stays active — since iOS 16 both may be, so stills are not lost | L | None |
| FCC-002 | Recording transport | Start, stop, elapsed, and REMAINING against the budget for the chosen format. A director must see the clip end coming, not discover it at upload | M | FCC-001 |
| FCC-003 | Sync sound with the footage | Audio capture written into the same file. `NSMicrophoneUsageDescription` is already declared; the capture is not | M | FCC-001 |
| FCC-004 | The manual controls reach video | Exposure, white balance and focus locks apply to a recording session, not only a photo one. The fitting arithmetic already exists and must not be re-derived | S | FCC-001 |

### Phase 2: Formats, and the hardware actually present

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| FCC-005 | HEVC Apple Log as the default | `activeColorSpace = .appleLog` with `automaticallyConfiguresCaptureDeviceForWideColor = false`, or the session silently overrides it. ~200 MB/min at 4K30 — the only gradeable format that fits the existing pipe | M | FCC-001 |
| FCC-006 | A format picker that states its cost | Every format shows MB/min, maximum duration on the current transport, and how it will travel. A format whose transport is absent is refused with the remedy, never offered silently | M | FCC-005 |
| FCC-007 | ProRes recording | ProRes 422 and 422 HQ via `AVAssetWriter`. ~7 GB/min at 4K30, so it is inseparable from FCC-009 and must not be offered without it | M | FCC-005 |
| FCC-008 | ProRes RAW, Apple Log 2, open gate | The iPhone 17 Pro features. Gated on the device reporting the capability rather than on a model string, so a 15 Pro Max degrades with a reason instead of failing | L | FCC-007 |

### Phase 3: Transport — the workstream the direction added

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| FCC-009 | Record to external USB-C storage | exFAT, USB-3 at 10 Gbps, ≥220 MB/s for 4K60. The drive is checked for speed and format BEFORE recording starts, because discovering it afterwards costs the take | L | FCC-007 |
| FCC-010 | Chunked, resumable upload | Replace the base64 JSON body for large media. Resumable because a phone loses Wi-Fi mid-transfer and a restart from zero on a multi-gigabyte file is a transfer that never completes | L | FCC-001 |
| FCC-011 | The budget knows every format and transport | `capture-policy.js` extends from 3 HEVC modes to every format above, and from one ceiling to one per transport. The number a director sees must be the number that binds | M | FCC-006, FCC-009, FCC-010 |

### Phase 4: Surfaces

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| FCC-012 | Retire the system camera | Replace `shootControl()` so a camera target gets the controlled camera. One function, so no surface is left behind — and the targets are derived from the rule in Constraints, not listed twice | M | FCC-002 |
| FCC-013 | Previz shoots properly | `world-capture` records with exposure locked and the duration budget visible, against the ceiling `capture-policy` computes. A world is reconstructed from coverage, so the budget is the feature | M | FCC-011, FCC-012 |
| FCC-014 | Footage attaches to a shot | `video-media` records to a shot as `video_raw`, so the timeline, the conform and the NLE export pick it up with nothing else to change | M | FCC-012 |
| FCC-015 | Reshape the brief's gap claims | `film-engine-camera-brief.test.js` pins the system camera and the absent recording APIs as gaps. When they close, the claims record what was BUILT — a gap pinned as permanent makes a document fail for succeeding | S | FCC-005, FCC-012 |
| FCC-016 | Prove it on the phone | Shoot in each format, on the real device, with every control exercised. Record device, iOS version, formats, file sizes and how each travelled. A simulator cannot do this | M | FCC-001..FCC-014 |

## Open Questions

1. **Does the WebView stay?** Constraints records an assumption — the app opens
   on the camera surfaces and the full page remains reachable — because
   rewriting 33 pages is a larger project than this camera. This is a product
   decision and the assumption should be confirmed or overruled.
2. **Are `storyboard-image` and `mood-board-image` camera targets?** They are the
   marginal calls under the photographed-in-the-world rule. A hand-drawn board
   photographed on a table is real; so is a mood reference shot on the street.
3. **Does `video-media` want sync sound by default?** Dialogue is generated
   elsewhere and `voice-media` exists separately, so recorded audio may be
   reference rather than production sound.
4. **Live Multicam — in or out?** Final Cut Camera streams up to four devices
   into Final Cut Pro for iPad. Not researched, and possibly irrelevant to a
   single-operator pipeline.
5. **Where does Log footage get graded?** The engine has no grade surface. Log
   delivered into a pipeline that cannot grade it looks broken rather than flat.
6. **Is external recording per-clip or per-session?** A drive that fills or is
   unplugged mid-take needs a defined behaviour.

## Success Metrics

- A clip is shot on the phone in HEVC Apple Log and arrives as a shot's
  `video_raw`, with the timeline and the NLE export picking it up unchanged.
- A `world-capture` clip is shot with exposure locked, within the duration the
  budget stated, and Marble reconstructs a world from it.
- Every format offered states its MB/min and maximum duration BEFORE recording,
  and a format whose transport is absent is refused with the remedy named.
- ProRes-class footage reaches the Mac by a path that is not the JSON body —
  external storage or a resumed chunked upload — and the transfer survives an
  interruption.
- ProRes RAW, Apple Log 2 and open gate record on the iPhone 17 Pro, and degrade
  with a stated reason on hardware that lacks them.
- No target that holds a generated or authored artefact offers a camera.
- The brief's two `gap` claims are reshaped to record what was built.
- The full suite is green, and every claim in this epic still matches the code.
