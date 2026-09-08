# PCC-012 — proving the plate camera on the phone

*The one task in this epic an agent cannot do. Everything below is prepared so
the session succeeds first time rather than discovering a blocker on location.*

## Why this exists as its own task

Eleven tasks shipped with the same line in every commit: **not verified on the
phone**. That is not caution, it is the literal situation — a simulator has no
camera, no motion hardware and delivers no frames, so of everything built here:

| Proven by execution | Proven only by structure |
|---|---|
| the 35mm focal-length conversion | that any lens is discoverable |
| the exposure refit across formats | that a lock survives a real lens change |
| the white-balance normalisation | that gains read back as a sane temperature |
| the tap-point clamp | that a tap lands where the finger went |
| the aspect guide and level maths | that the level reads true in the hand |
| the focus-peaking detector | that peaking keeps up at the real frame rate |
| the clipping detector | that EXIF carries what PCC-006 expects |

The arithmetic is the half where the likely defects lived and it is proven. What
is unproven is whether the phone behaves as the SDK documents.

## Before you start

- **Device:** iPhone 15 Pro Max (the constraint the epic is scoped to).
- The app builds for real hardware: `xcodebuild -sdk iphoneos -configuration
  Release CODE_SIGNING_ALLOWED=NO build` → **BUILD SUCCEEDED**. Signing needs an
  Apple ID in Xcode; `ios/README.md` carries those steps.
- The Mac must be running the engine and reachable on the same network.

## What to shoot

One character turnaround — front, left, right, back — with **every** control
exercised at least once. Record which view you used each on.

1. **Lens (PCC-001).** Switch between all three; confirm the picker shows only
   the lenses this phone has and labels them in millimetres.
2. **Exposure lock (PCC-002).** Lock on the front view. Shoot all four without
   releasing. **Then change lens while locked** — this is the case the whole
   refit exists for, and the failure mode it guards is a crash, not a wrong
   plate.
3. **White balance (PCC-003).** It locks with exposure. Confirm the chip shows a
   temperature, and that it is plausible for the light you are in.
4. **Focus (PCC-004).** Tap the subject's eye. Confirm focus lands **where you
   tapped**, and that the lock survives all four views. Change lens while
   locked: the point should be re-focused, not a stored position re-applied.
5. **Guides (PCC-005).** Level, grid and aspect, each on and off independently.
   **Point the phone straight down at a prop** — the level must say roll cannot
   be read, not report level. If it says "no motion sensor" on a real phone,
   that is a genuine finding: report it.
6. **Peaking (PCC-008).** Rack focus and watch it appear and disappear. If it
   looks the same in and out of focus, the absolute threshold is wrong for this
   sensor and needs the measurement this session provides.
7. **Zebras and the warning (PCC-009).** Point at a window or a lamp. A specular
   highlight should stripe without warning; a blown face should warn.

## What to record

- Device model and **iOS version**.
- The four plates, uploaded through the app.
- `GET /film/characters/<id>/refsheet/consistency` — or ask Claude for
  `plate_consistency`. With the locks held it should report **agree: true**. If
  it does not, that is the most valuable single result of the session.
- Anything that behaved differently from the list above.

## What would count as a failure worth fixing

- A crash on a lens change while locked (PCC-002/PCC-003's refit).
- Focus landing away from the tap (PCC-004's use of the layer's own converter).
- The level reporting "no motion sensor" on real hardware — meaning
  `NSMotionUsageDescription` is required after all and something else is wrong.
- Peaking that does not change as you rack focus.
- `plate_consistency` disagreeing on a turnaround shot entirely locked.
