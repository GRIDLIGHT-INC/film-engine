# Research Brief: Final Cut Camera parity for the Film Engine iOS app

*Researched 2026-09-08. Every number below is measured from this repo or cited to a
first-party source; the claims are held to the code by
`backend/tests/fcc-parity-brief.test.js`, so a brief that drifts fails rather than
misleads.*

## Executive Summary

Final Cut Camera 2.0's feature list is **almost entirely reachable by a third-party
app** — Apple opened Apple Log, ProRes and even genlock to `AVFoundation`, and the
monitoring tools were never Apple APIs at all, so shipping them is ordinary work
rather than blocked work. The two things that genuinely block parity are not camera
features: **the hardware tier** (ProRes RAW, Apple Log 2, open gate and genlock are
iPhone 17 Pro only, and this project's device is a 15 Pro Max) and **the transport**
— a shot video travels base64-encoded, so the **113 MB** file ceiling admits
**3 seconds** of ProRes 422 HQ at 1080p30 and **1 second** at 4K30.

The conclusion that matters: capture parity is cheap and useless until the file can
leave the phone. Fix the transport first, or build a camera whose output has
nowhere to go.

## Key Themes

- **The blocker is the pipe, not the lens.** Every capture feature is achievable.
  Delivering the result is not. This inverts the obvious build order.
- **Parity is device-tiered, and the target device sits below the top tier.** Four
  headline FCC 2.0 features cannot be demonstrated on the phone in this project at
  any price of effort — and genlock additionally needs a Blackmagic ProDock, a
  hardware purchase rather than an OS gate.
- **The monitoring tools are ours to build, all of them.** Apple ships no API for
  focus peaking, zebras, false colour or waveform. Third parties compute them per
  frame from `AVCaptureVideoDataOutput`. That is the largest single body of work
  and it is entirely under our control.
- **Plates and footage want opposite things.** A reference plate conditions every
  generated frame of its subject, so it should look like what the model must
  reproduce — log would actively hurt it. What a plate wants is *consistency across
  views*. Log and ProRes matter only for footage cut into the film.
- **The engine already speaks ProRes — outbound only.** `project-presets.js`,
  `qa-checker.js` and `spot-package.js` treat ProRes as a delivery codec, while
  `media-kinds.js` accepts `mp4` for an incoming shot. We can export it and cannot
  receive it.
- **None of this needs a model.** No part of this epic touches the goal's stated
  rabbit hole; it is device APIs and file transport.

## Top Ideas & Opportunities

1. **Chunked, resumable upload — the unblocking move.**
   *What:* replace whole-file base64 JSON bodies with a chunked binary transfer that
   can resume.
   *Why:* it is the only thing standing between every other idea here and a usable
   result. Measured: `1080p30 HEVC 133s / 4k30 44s / 4k60 14s` fit today; ProRes
   1080p30 fits for 3 seconds.

   *Which ceiling — this was got wrong once and is worth stating precisely.*
   `capture-policy.js` holds three: `transport_raw` 150 MB (the body we accept),
   `transport_base64` **113 MB** (the same body after base64 inflation — the number
   a director actually experiences), and `marble_video` 100 MB (World Labs' own cap).
   `bindingBytes()` returns the minimum, which is **Marble's 100 MB**, so raising the
   upload limit alone would not move it for a world capture. For a plain shot video
   the binding number is **113 MB**. The HEVC figures above are computed against the
   minimum; the ProRes figures against 113 MB, because footage does not go to Marble.
   *How:* extend `capture-policy.js`, which already models bytes-per-second against
   ceilings and computes `maxSecondsFor(mode)` — adding ProRes modes makes the
   engine state the problem in its own voice.

2. **Exposure and white-balance LOCK across a turnaround.**
   *What:* lock ISO, shutter and WB for the whole four-view plate session.
   *Why:* this is the single highest-value camera feature for *this* product. Four
   views shot on autoexposure disagree about brightness and colour, and the front
   plate is attached to every frame the character appears in.
   *How:* `setExposureModeCustom(duration:iso:)` and
   `setWhiteBalanceModeLocked(with:)`, held across the existing `PlateCameraView`
   walk. Small, self-contained, and it improves work already shipping.

3. **Explicit lens selection.**
   *What:* choose 13/24/48/120mm rather than the automatic virtual camera.
   *Why:* a plate shot on the ultra-wide is barrel-distorted, and a location plate
   is re-photographed from in every shot of that scene. Also the cheapest item on
   the list.
   *How:* `AVCaptureDevice.DiscoverySession` over `builtInUltraWideCamera`,
   `builtInWideAngleCamera`, `builtInTelephotoCamera`. Currently hardcoded to wide.

4. **Manual focus with peaking.**
   *What:* `setFocusModeLocked(lensPosition:)` plus an edge-detect overlay.
   *Why:* the plate that conditions a subject should not be soft, and autofocus on a
   featureless prop hunts.
   *How:* focus is one API call; peaking is a Core Image threshold-edge filter or a
   Metal shader over the preview — no Apple API exists, which is why it is work.

5. **Apple Log + ProRes capture for FOOTAGE.**
   *What:* `.appleLog` colour space, ProRes via `AVAssetWriter`.
   *Why:* real grading latitude for shots that reach the cut, and the engine already
   delivers ProRes.
   *How:* `activeFormat.supportedColorSpaces` must contain `.appleLog`, set
   `device.activeColorSpace`, pixel format
   `kCVPixelFormatType_422YpCbCr10BiPlanarVideoRange`. **Gotcha:** set
   `automaticallyConfiguresCaptureDeviceForWideColor = false` or the session
   silently overrides the colour space. Depends entirely on idea 1.

6. **Import from Final Cut Camera instead of reimplementing it.**
   *What:* let FCC record, and import from Files/Photos through the existing media
   importer.
   *Why:* it delivers ProRes RAW, Log 2, open gate and genlock *today*, on hardware
   that supports them, for a fraction of the code — and those are exactly the
   features we cannot otherwise reach.
   *How:* `media-kinds.js` gains a `.mov`/ProRes path; the importer already exists.

7. **Level, guides and remaining-time.**
   *What:* tilt/roll indicator, aspect guides, thirds grid, recording time.
   *Why:* cheap, and a crooked location plate is re-photographed from in every shot
   of that scene.
   *How:* `CMMotionManager` plus overlay drawing. No capture pipeline involved.

## Technical Approaches

**Manual controls** — all four live on `AVCaptureDevice` behind
`lockForConfiguration()`: `setExposureModeCustom(duration:iso:)`,
`setFocusModeLocked(lensPosition:)`, `setWhiteBalanceModeLocked(with:)`,
`setExposureTargetBias(_:)`. Reference implementation: Apple's AVCamManual.

**Log and ProRes** — `AVCaptureVideoDataOutput` + `AVAssetWriter`, not
`AVCapturePhotoOutput`. This is a different pipeline from the one we have, which is
why idea 5 is not a small change to the existing camera.

**Monitoring** — `AVCaptureVideoDataOutput` → Core Image or Metal → `MTKView`. Every
tool (peaking, zebras, false colour, histogram, waveform) is computed by us.

**What our camera is today** — `ios/FilmEngine/PlateCamera.swift`, 1142 lines:
`AVCapturePhotoOutput`, `sessionPreset = .photo`, one hardcoded wide lens, flash off.
Zero occurrences of `setExposureModeCustom`, `setFocusModeLocked`,
`setWhiteBalanceModeLocked`, `activeColorSpace`, `AVCaptureVideoDataOutput` or
`AVAssetWriter`. It is a starting point, not a base to extend.

## Open Questions

1. **Build a camera, or import from Final Cut Camera?** FCC already ships every
   feature, including the four we cannot reach. This is the decision that shapes the
   whole epic and it should be made before any Swift is written.
2. **What is the transport?** Chunked HTTP upload, recording to a shared folder the
   Mac watches, or AirDrop/Files as a manual step. Each has a very different cost.
3. **Is footage capture in scope at all,** or only plates? Plates need none of Log,
   ProRes or the transport work — they are photographs.
4. **Does the hardware tier get bought?** ProRes RAW, Log 2, open gate and genlock
   need an iPhone 17 Pro; genlock additionally needs a Blackmagic ProDock. If not,
   those four should be struck from "parity" rather than carried as debt.
5. **Where does log-encoded footage get graded?** The engine has no grade surface;
   log delivered into a pipeline that cannot grade it looks broken rather than flat.

## Recommended Direction

**Split the epic in two, and do the plate half first.**

*Phase A — plates (no transport work, no new pipeline).* Exposure/WB lock across the
turnaround, explicit lens choice, manual focus with peaking, level and guides. These
are photographs; they fit the existing upload comfortably; they improve a feature
that is already shipping; and they are the ones that measurably improve generated
output, because a plate conditions every frame of its subject.

*Phase B — footage, gated on a decision.* Before writing an `AVAssetWriter`
pipeline, answer question 1. Importing from Final Cut Camera plausibly delivers
*more* parity for *less* code, and reaches the four features that are otherwise
impossible on this hardware. If we still want native capture afterwards, the
transport is the first task and Log/ProRes the second.

The reason for that order is not caution. It is that Phase A has no blocking
dependency, and every item in Phase B is downstream of a 113 MB ceiling that admits
three seconds of the format the whole exercise is about.
