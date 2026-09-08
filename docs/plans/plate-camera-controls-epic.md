# Epic: Plate Camera Controls

## Overview

The iOS app can already shoot a reference plate. `PlateCameraView` walks a
character's turnaround — front, left, right, back — with the view named on screen,
uploading each through the same import route the web page uses. What it cannot do
is control the camera. It is `AVCapturePhotoOutput` at `sessionPreset = .photo`,
autoexposure, autofocus, auto white balance, one hardcoded wide lens. Point and
shoot.

That matters more here than it would in a general camera app, because of what a
plate IS. A reference plate is not a photograph somebody looks at — it is the
picture every generated frame of that subject is conditioned on, and `headlinePlate`
attaches the front view to every shot the character appears in. Four views shot on
autoexposure disagree about brightness and colour, so a turnaround that should
describe one person describes four slightly different ones, and the model resolves
that disagreement however it likes. A plate shot on the ultra-wide is
barrel-distorted, and that distortion is inherited by every frame built from it.

This epic gives the plate session the four controls that decide whether a
turnaround describes one subject: **locked exposure and white balance held across
the whole walk**, **explicit lens choice**, **manual focus with peaking**, and
**level and framing guides**. It is deliberately the plate half only. The research
brief's Phase B — Apple Log, ProRes, footage capture and the transport work they
depend on — is out of scope by decision, and the four iPhone 17 Pro features
(ProRes RAW, Apple Log 2, open gate, genlock) are struck from parity rather than
carried as debt.

## Business Goals

- **A turnaround that describes one subject.** Four views that agree about
  exposure and colour, so the reference package is internally consistent and the
  model is not asked to reconcile four different-looking people.
- **Plates that are not distorted by accident.** The lens is a deliberate choice
  rather than whatever the automatic virtual camera picked, because that geometry
  is inherited by every frame generated from the plate.
- **Plates that are sharp on the subject.** Autofocus hunts on a featureless prop
  and can settle on the backdrop; a soft plate conditions every frame softly, and
  nothing downstream can recover it.
- **Fewer reshoots.** A crooked or badly framed location plate is re-photographed
  from in every shot of that scene, and today the only way to find that out is to
  generate a frame and look at it.
- **A native surface worth having.** App Store guideline 4.2 can reject a thin web
  wrapper. This is the second real capability the app has that a browser cannot
  provide, after the guided turnaround itself.

## Current State

| Component | Current State |
|-----------|---------------|
| `ios/FilmEngine/PlateCamera.swift` | 669 lines. `AVCapturePhotoOutput`, `sessionPreset = .photo`, flash off |
| Exposure | Automatic, re-metered per shot. Nothing held across the session |
| White balance | Automatic, re-metered per shot |
| Focus | Automatic. No manual control, no peaking, no confirmation the subject is sharp |
| Lens | **Built 2026-09-08 by PCC-001 (GRD-3652).** All three rear cameras discovered with `DiscoverySession`, labelled in 35mm-equivalent millimetres derived from `videoFieldOfView`; the picker is hidden on a one-lens device. |
| Framing aids | None. No level, no grid, no aspect guide |
| Preview | `AVCaptureVideoPreviewLayer` — a layer, with no access to frames |
| Manual-control APIs used | Zero occurrences of `setExposureModeCustom`, `setFocusModeLocked`, `setWhiteBalanceModeLocked`, `activeColorSpace`, `AVCaptureVideoDataOutput`, `AVAssetWriter` |
| Session walk | Works: views from the page, upload per view, failures named per view, Skip and Retake |
| Fidelity claims | `fcc-parity-brief.test.js` holds two `gap` claims that this epic closes |

**Built 2026-09-08 by PCC-002 (GRD-3653):** the exposure lock. Metered once and
held for the whole turnaround, releasable per view. `ExposureLock.fit` refits it
to each lens's own format on a lens change — the ranges belong to
`AVCaptureDeviceFormat`, so an exposure metered on the wide can be ILLEGAL on the
telephoto, and passing it raises NSInvalidArgumentException. Clamping alone would
make that view a stop darker, so the shortfall moves into the other term and any
residual is reported in stops rather than delivered silently.

## Target State

| Component | Target State |
|-----------|---------------|
| Exposure | Metered once, then LOCKED for the whole turnaround; the lock is visible and releasable |
| White balance | Same: locked across the walk, shown as a temperature a person can read |
| Focus | Tap to focus, then locked; a peaking overlay shows what is actually sharp |
| Lens | Chosen from what the device actually has, named in millimetres, recorded with the plate |
| Framing aids | Tilt/roll level, thirds grid, and the project's delivery aspect drawn as a guide |
| Preview | Frame-accessible, so peaking can be computed — the one pipeline change in this epic |
| Provenance | Each plate records the lens, ISO, shutter and white balance it was shot at |
| Consistency | A view shot with different settings from its siblings is flagged, not silently accepted |
| Fidelity claims | Both `gap` claims RESHAPED to pin what was built |

## Constraints

- **Plates only.** No footage capture, no Log, no ProRes, no transport work. Settled
  by the user, not an open question.
- **The four top-tier features are struck, not deferred.** ProRes RAW, Apple Log 2,
  open gate and genlock need an iPhone 17 Pro, and genlock additionally needs a
  Blackmagic ProDock. They are out of "parity" for this product; a later reader must
  not read them as unfinished work.
- **A plate is not log.** A reference plate should look like what the model must
  reproduce. Log or a flat profile would actively harm it, so this epic deliberately
  ships none of the colour-science features FCC is known for.
- **One surface.** The page keeps deciding the subject, the views and the route;
  native only shoots. A control that let the app choose what it is photographing
  would be the second surface the iOS design exists to avoid.
- **The device is an iPhone 15 Pro Max.** Everything here works on it. Anything that
  would not is out of scope by the constraint above.
- **No simulator verification of capture.** A simulator has no camera. Every task
  must degrade with a stated reason rather than a black screen, and the acceptance
  evidence for the camera itself needs the real phone.
- **Existing tests bind.** `ios-app.test.js` requires the bundled page to stay
  byte-identical to `src/index.html`; `fcc-parity-brief.test.js` fails until its two
  `gap` claims are reshaped; every new `we-*`/CSS class needs a rule.
- **Nothing here needs a model.** No task touches the MCP rabbit hole.

## Task Breakdown

### Phase 1: Controls that need no new pipeline

**PCC-001 leads, and that is a constraint rather than a preference.** Selecting a
lens replaces the `AVCaptureDeviceInput`, and every lock in 002–004 is set on the
`AVCaptureDevice` it replaces — so a lock taken before a lens change is silently
dropped, and the next plate is metered automatically while the UI still shows LOCK.
Building lens selection first means re-applying the locks is designed in; building
it last means retro-fitting it into three finished controls and discovering the
gap on a turnaround that has already been shot.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PCC-001 | Lens selection from what the device has | Discover `builtInUltraWideCamera` / `builtInWideAngleCamera` / `builtInTelephotoCamera` with `DiscoverySession`, offer only those present, label in millimetres from `focalLengthIn35mmFilm`. A device with one lens shows no picker rather than a broken one | M | None |
| PCC-002 | Lock exposure across the turnaround | `setExposureModeCustom(duration:iso:)` metered once at session start and held for every view; a visible LOCK affordance, releasable per view for a subject that genuinely needs re-metering | M | PCC-001 |
| PCC-003 | Lock white balance across the turnaround | `setWhiteBalanceModeLocked(with:)`, shown as a readable temperature. Locked and released together with exposure by default, because a plate that matches on brightness and not colour still disagrees | M | PCC-001, PCC-002 |
| PCC-004 | Tap to focus, then lock | `setFocusModeLocked(lensPosition:)` with a tap target; the lock survives the walk so four views share a focal plane | S | PCC-001 |
| PCC-005 | Level, grid and aspect guide | Tilt/roll from `CMMotionManager`, thirds grid, and the project's delivery aspect drawn as a guide — the page already knows the aspect and can send it | M | None |
| PCC-006 | Record what each plate was shot at | Carry lens, ISO, shutter and white balance with the upload and store them on the asset, so a plate that looks wrong can be diagnosed rather than re-shot blind | M | PCC-001, PCC-002, PCC-003 |

### Phase 2: The preview pipeline, and what it enables

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PCC-007 | Frame-accessible preview | Replace `AVCaptureVideoPreviewLayer` with `AVCaptureVideoDataOutput` feeding a Metal/`MTKView` preview. The one pipeline change in this epic, and it is a prerequisite rather than a feature — nothing about the picture changes | L | None |
| PCC-008 | Focus peaking | Threshold edge detection over the preview frames, drawn as an overlay. No Apple API exists; this is ours to compute | M | PCC-007 |
| PCC-009 | Exposure warning | Zebras or a clipping indicator over the same frames, so an overexposed plate is caught before it is uploaded rather than after a frame is generated from it | M | PCC-007 |

### Phase 3: Close the loop

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| PCC-010 | Flag a turnaround whose views disagree | With PCC-006's provenance stored, report when views of one subject were shot at materially different settings. A warning, never a refusal — a director may have had a reason | M | PCC-006 |
| PCC-011 | Reshape the two `gap` claims | `fcc-parity-brief.test.js` pins the camera's absent APIs as gaps naming this epic. Reshape both to pin what was BUILT. Pinning a gap as permanent makes the epic fail for succeeding | S | PCC-002, PCC-004 |
| PCC-012 | Prove it on the real phone | Shoot a turnaround on the iPhone 15 Pro Max with every control exercised; record the device, iOS version and the four plates. A simulator cannot do this | M | PCC-001..PCC-009 |

## Open Questions

1. **Does the lens choice belong to the subject or to the session?** A location may
   want the ultra-wide and a character the 48mm — should the page carry a per-kind
   default rather than the director choosing each time?
2. **Should a released lock be recorded?** If a director unlocks exposure for one
   view, is that a decision worth storing with the plate, or noise?
3. **What is the peaking threshold, and is it adjustable?** A fixed threshold is
   simpler and will be wrong for some subjects; an adjustable one is another control
   on a screen that should stay quiet.
4. **Does provenance (PCC-006) need a migration?** `film_assets` may take it in
   existing metadata rather than new columns — to be settled when the task is picked
   up, not assumed here.
5. **Should PCC-007 land before Phase 1 ships?** It touches the preview every other
   task draws on. Sequencing it first is safer for rework and delays every visible
   improvement; the plan above chooses visible progress first.

## Success Metrics

- **A turnaround is internally consistent.** Four views of one subject, shot in one
  session, agree on exposure and white balance — verifiable from the stored
  provenance rather than by eye.
- **Every control is reachable and does something measurable.** For each of lens,
  exposure, white balance and focus, changing it changes the resulting plate or the
  request that produced it. A control that stores a value and reaches nothing is the
  failure this codebase has paid for repeatedly.
- **A device that cannot do it says so.** No black screens, no dead shutters: the
  simulator, a denied permission and a single-lens device each produce a sentence.
- **The existing session still works.** Skip, Retake, per-view failure naming and
  the upload contract are unchanged; the page still decides the subject and route.
- **Both `gap` claims are reshaped, not deleted,** and the full suite is green.
- **Shot on the real phone once,** with the device and iOS version recorded — the
  only evidence that any of this works.
