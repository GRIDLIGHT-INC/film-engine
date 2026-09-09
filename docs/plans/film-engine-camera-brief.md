# Research Brief: a Final Cut Camera-grade video camera for Film Engine

*Researched 2026-09-08. Every number is measured from this repository or cited to
a first-party source; the claims are held to the code by
`backend/tests/film-engine-camera-brief.test.js`, so a brief that drifts fails
rather than misleads.*

*This brief replaces `final-cut-camera-parity-brief.md`, which framed the work as
plates-first and produced an epic that shipped twelve tasks of stills. The
correction is stated in Executive Summary rather than buried, because the
framing is what went wrong, not the execution.*

## Executive Summary

Final Cut Camera is a **video** app, and the previous brief split it into "plates
now, footage later" and recommended plates. That split was the error: it steered
twelve tasks into still photography when the request was footage. This brief does
not phase by medium.

Two measurements decide everything. **HEVC Apple Log is ~200 MB/min at 4K30
against ProRes Log's 6–12 GB/min for nearly the same grading latitude** — a
thirtieth of the size — so a ten-second shot is about 33 MB and fits the pipe
Film Engine already has. And **the previz path already exists**: `world-capture`
is the one import target that accepts video, it feeds Marble, and
`capture-policy.js` already computes what may be shot against a real 100 MB
ceiling. It is fed today by `<input type="file" capture="environment">` — the
iOS system camera, which is precisely what was ruled out.

The work is therefore narrower than it looks: replace one function's camera, on
three surfaces, with HEVC Log as the default.

## Key Themes

- **The transport was never the blocker; the codec choice was.** The previous
  brief concluded "fix the transport first, or build a camera whose output has
  nowhere to go". That is true of ProRes and false as a general claim. HEVC Log
  sidesteps it entirely, and ProRes becomes an opt-in that needs external
  storage rather than a prerequisite that blocks everything.

- **The defect is one function, not a missing app.** `shootControl()` renders a
  system-camera file input. It is what `world-capture` and every video target
  use. The native camera reaches five targets and shoots only stills.

- **"Only these areas" is a real, countable scope.** 18 import targets exist.
  Pictures, video and previz is a subset, and several image targets plainly do
  not want a phone camera — a marketing poster is not photographed on set.

- **The hardware premise that struck four features is dead.** ProRes RAW,
  Apple Log 2, open gate and genlock require an iPhone 17 Pro, and the device
  paired to this Mac is one.

- **Most of the previous epic's arithmetic survives.** Peaking, the exposure
  warning, the level and aspect maths and the lock-fitting functions are
  format-agnostic and already mutation-proven. The spine does not survive.

- **A plate is not footage, and both are wanted.** Since iOS 16 a video-data
  output and a photo output can be active simultaneously, so this is not a
  choice between them.

## Top Ideas & Opportunities

1. **HEVC Apple Log as the default recording format.**
   *What:* 10-bit 4:2:0 Log via `AVAssetWriter`, ~200 MB/min at 4K30.
   *Why:* it is the only format that is both gradeable and small enough to
   travel the existing import path. A 10s shot ≈ 33 MB against a 100 MB ceiling.
   *How:* `device.activeColorSpace = .appleLog` with
   `automaticallyConfiguresCaptureDeviceForWideColor = false`, or the session
   silently overrides it.

2. **Replace `shootControl()`, do not add a second camera.**
   *What:* one function decides which targets get a controlled camera.
   *Why:* it is the single site where the system camera enters, so replacing it
   fixes every surface at once and cannot leave one behind.
   *How:* it already receives the target; the native bridge already exists for
   stills.

3. **Feed `world-capture` properly — this is previz visualisation.**
   *What:* shoot the orbit clip with controls, against the ceiling
   `capture-policy.js` already computes.
   *Why:* a world is reconstructed from coverage, and the current path offers no
   exposure lock, no level and no idea how long a clip may be.
   *How:* the policy module already answers `maxSecondsFor(mode)`; the camera
   should show it as a remaining-time budget rather than failing at upload.

4. **A shot-scoped video camera for `video-media`.**
   *What:* footage attached to a shot, which is what `video_raw` already means.
   *Why:* it is the difference between a pipeline that can only generate footage
   and one that can also be shot.
   *How:* the import route exists; only a controlled camera and a codec choice
   are missing.

5. **ProRes as an explicit opt-in with its own transport.**
   *What:* record to external USB-C storage; do not attempt the JSON upload.
   *Why:* 7 GB/min cannot travel a 100 MB pipe, and pretending otherwise is how
   a director loses a take. Requires USB-3 at 10 Gbps, exFAT, ≥220 MB/s.
   *How:* offered where the hardware is present, refused with a reason where it
   is not.

6. **Three surfaces, not thirty-three pages.**
   *What:* the app addresses the picture targets, the video targets and previz.
   *Why:* the WebView ships the whole SPA, which was never asked for.
   *How:* an open question below — it is a decision, not a finding.

## Technical Approaches

**Recording** — `AVCaptureVideoDataOutput` + `AVAssetWriter`, not
`AVCaptureMovieFileOutput`, because monitoring needs the frames anyway. Since
iOS 16 both a video-data output and a photo output may be active at once, so
stills are not lost.

**Manual controls** — already built and mutation-proven for stills, all on
`AVCaptureDevice` behind `lockForConfiguration()`:
`setExposureModeCustom(duration:iso:)`, `setWhiteBalanceModeLocked(with:)`,
`setFocusModeLocked(lensPosition:)`. The refit arithmetic for a lens change is
done: exposure is refitted per format, white balance normalises to the minimum
channel, and focus carries the POINT rather than the lens position because a
position is not comparable across devices.

**Monitoring** — `FocusPeaking` and `ExposureWarning` already read a luma plane
with the correct `bytesPerRow` discipline and are proven against padded buffers.
They are format-agnostic and need no change.

**What must be built new** — the asset writer, the Log colour space, the codec
choice, a recording transport (start/stop/duration/remaining budget), audio
capture, and the surface decision.

## Open Questions

1. **Which of the 18 targets does the app serve?** Pictures, video and previz is
   the direction, but `marketing-asset` and `orientation-plan` do not want a
   phone camera, and audio targets are out of scope by the request. This needs a
   decision, not an inference — inferring it is what produced the last epic.

2. **What replaces the 33-page WebView?** A focused native app, a trimmed page,
   or the same page with a different entry point. This is the part of the last
   design that was never requested and it should be decided explicitly.

3. **Is ProRes wanted at all, given HEVC Log?** The grading difference is chroma
   subsampling. If the answer is no, external storage and its constraints leave
   scope entirely.

4. **Does footage need audio?** `voice-media` exists separately and dialogue is
   generated. Recording sync sound is a different pipeline from a silent plate.

5. **Live Multicam — in or out?** Final Cut Camera streams up to four devices
   into Final Cut Pro for iPad. Not researched, and possibly irrelevant to a
   single-operator pipeline, but it is a real FCC feature and excluding it should
   be a decision.

6. **Genlock and open gate.** Available on this hardware now. Genlock
   additionally needs a Blackmagic ProDock — a purchase, not a code change.

## Recommended Direction

**Build one controlled camera that records HEVC Apple Log, and wire it to the
three surfaces the request named — pictures, video, and `world-capture` for
previz. Do not phase by medium.**

The reasoning is that the previous phasing is exactly what failed. A "stills
first, footage later" plan looks prudent and delivers the wrong half, because
the request was footage and the stills work does not lead to it — the spine has
to change either way. What DOES carry over is the arithmetic, and it carries
whether it is done first or last, so there is no sequencing benefit to repeating
the split.

HEVC Log as the default is the decision that makes this shippable rather than
blocked. ProRes should be offered only where external storage is present, and
refused with its reason elsewhere, so that the format that cannot travel never
silently becomes the one a director shot on.

The one thing that genuinely should be settled before implementation is the
surface question — which targets, and what replaces the WebView. That is a
decision about product shape, and guessing it is what produced an epic that
solved the wrong problem.
