# FCC-016 — proving the Final Cut Camera on the phone

*The one task in this epic an agent cannot finish. Everything below is prepared
so the session succeeds first time rather than discovering a blocker on
location — the same shape `plate-camera-on-device-proof.md` took for PCC-012.*

**NOTHING BELOW HAS BEEN SHOT.** Every row is unshot and every box is empty.
This is a checklist, not evidence, and it must not be read as one until the
columns are filled in.

## The device, measured 2026-09-09

| | |
|---|---|
| Device | **iPhone 17 Pro** (`iPhone18,1`) |
| iOS | **26.6.1** |
| Identifier | `00008150-000908DC1188401C` (devicectl: `ACE6174C-7F0F-5369-906E-FA766D55A9A8`) |
| State | paired, available, **locked** |
| Signing | configured and valid — team `3AXRJ22S9P`, automatic, `ai.gridlight.filmengine` |

**This corrects the brief.** It was written when the only phone here was a 15
Pro Max, and it named the hardware tier as one of two things that genuinely
block parity. That is no longer true: ProRes RAW, Apple Log 2 and open gate are
iPhone 17 Pro features and a 17 Pro is what is paired. Genlock remains the one
exclusion, and it is a purchase rather than a code change.

## What actually blocks this

Three things, in the order they stop you, because a blocker that names the
wrong one costs the trip it was meant to save:

1. **The phone is LOCKED.** `xcodebuild -destination id=…` refuses with
   *"iPhone Manu may need to be unlocked to recover from previously reported
   preparation errors"*. Unlock it and leave it unlocked for the session.
2. **Nothing here can hold a camera.** Pointing it at a room, walking a
   turnaround and pressing record is a **person**. That is the whole of this
   task and it is not a limitation to work around.
3. **A drive, for six of the ten formats.** ProRes needs external USB-C storage
   — exFAT, USB-3, ≥220 MB/s. Without one those six are correctly refused with
   the remedy, and that refusal is itself worth photographing.

What is *not* a blocker, so nobody re-investigates it: **signing.** An Apple ID
is signed in, provisioning resolves automatically, and `ios/README.md` records
an archive and export run end to end. The build reaches the device the moment
it is unlocked.

## Install

```
xcrun xctrace list devices                       # confirm the phone is listed
xcodebuild -project ios/FilmEngine.xcodeproj -scheme FilmEngine \
  -destination 'id=00008150-000908DC1188401C' -allowProvisioningUpdates build
```

The Mac must be running the engine (`node backend/server.js`, port 3100) and be
reachable on the same network. The app asks for the address on first launch and
says whether it can reach it — a blank page is not an error message, so if it
cannot, it will say why.

## Before you shoot — which build is on the phone?

**Open the app, press any Shoot button, and look at the camera before you do
anything else:**

| | |
|---|---|
| a **format picker** naming `4k30`, `4k30-log`, ProRes | FCC build ✅ |
| a **record transport** — elapsed, remaining, a budget in seconds | FCC build ✅ |
| a shutter and nothing else | **the old build** — stop, install, start again |

**Because there is already a Film Engine on this device, and it predates this
entire epic.** `plate-camera-on-device-proof.md` records it: *"As of 2026-09-08 it is
built, signed and INSTALLED on the paired iPhone 17 Pro … as
`ai.gridlight.filmengine`."* That is the PCC-era camera — it takes photographs
and nothing else. Open it, shoot a turnaround, fill this sheet in, and the epic
reads as proven against code that was written before any of it existed.

That is the same failure the not-yet-shot rule at the top exists to prevent,
arriving by a different door — and a locked phone makes it MORE likely, because
the install is the step that will not have run.

None of those three exist in the pre-FCC camera: it has no recording at all, so
it has no transport, no budget and no format to choose between. Anything the
previous epic's sheet asks you to exercise — exposure lock, white balance,
focus, peaking, the level — is present in BOTH builds and cannot tell them
apart. Only recording can.

If it is the old build, run the install above. `xcodebuild … build` on a
connected device replaces what is there; it does not add a second app.

## Every format — shoot each one

Ten formats, derived from `capture-policy.js`. **Fill in the last three
columns.** The predicted durations come from the engine, so a measured file
size that disagrees is a real finding rather than a rounding error.

| Format | MB/min | max (footage) | max (world) | travels by | needs | shot | measured MB | actual seconds |
|---|---|---|---|---|---|---|---|---|
| `1080p30` | 45 | 200s | 133s | upload | — | ☐ | | |
| `4k30` | 135 | 66s | 44s | upload | — | ☐ | | |
| `4k60` | 400 | 22s | 14s | upload | — | ☐ | | |
| `4k30-log` | 200 | 45s | 30s | upload | — | ☐ | | |
| `1080p30-prores422hq` | 1741 | drive | — | external | — | ☐ | | |
| `4k30-prores422hq` | 6963 | drive | — | external | — | ☐ | | |
| `1080p30-prores422` | 1163 | drive | — | external | — | ☐ | | |
| `4k30-log2` | 200 | 45s | 30s | upload | apple_log2 | ☐ | | |
| `4k30-prores_raw` | 4653 | drive | — | external | prores_raw | ☐ | | |
| `4k30-prores422` | 4653 | drive | — | external | — | ☐ | | |

**What to check on every one.** The picker states MB/min and a maximum before
you press record (FCC-006). The countdown reaches zero and the take STOPS
itself (FCC-002, FCC-011) rather than running past a ceiling. The file plays
back with sound (FCC-003).

## Every control — exercise each at least once

- **FCC-001 · recording at all.** A take is written and plays. The stills
  shutter still works afterwards — the photo output stays active, and losing it
  would break every plate.
- **FCC-002 · the transport.** Elapsed climbs, remaining falls, and the warning
  lights before the end rather than at it. On `4k60` that is a 22-second budget:
  the one mode where the ceiling actually bites.
- **FCC-003 · sound.** A take has audio. Deny the microphone permission once and
  confirm the take says it will be silent BEFORE you shoot it, not after.
- **FCC-004 · the locks reach video.** Lock exposure, then start a take. The
  preset swap must not release it — a take metered automatically while the chip
  reads LOCK HELD is the failure this task exists to remove. Change lens mid-lock.
- **FCC-005 · Apple Log.** Shoot `4k30-log`. Confirm the footage is gradeable,
  and that after the take the stills shutter STILL WORKS — the log colour space
  forbids photo capture, and restoring it is what keeps the plate camera alive.
- **FCC-006 · the picker.** Every format shows its cost. A format needing a
  drive is greyed WITH the remedy. Photograph that screen: it is evidence.
- **FCC-007 · ProRes.** With a drive attached, shoot `1080p30-prores422hq`.
  Without one, confirm it is refused rather than offered.
- **FCC-008 · the hardware tier.** This phone should report all three
  capabilities. `apple_log2`, `prores_raw` and `open_gate` — confirm each is
  OFFERED rather than greyed, which is the first time this project has had
  hardware that can prove FCC-008 by execution rather than by structure. **If
  any is greyed on a 17 Pro running iOS 26.6.1, that is a genuine finding:
  record exactly what the picker said.**
- **FCC-009 · external storage.** Plug the drive in mid-session and confirm
  ProRes becomes available without restarting. Pull it out mid-take and record
  what happens — that is the case nobody has been able to test.
- **FCC-010 · the resumable upload.** Start a large upload and turn Wi-Fi off
  mid-transfer, then back on. It must RESUME rather than restart. Record how
  many bytes were already there.
- **FCC-011 · the budget.** The number the picker shows is the number the take
  stops at. Check one footage mode and one world capture — they differ, and
  that difference is the whole task.
- **FCC-012 · the controlled camera.** Every Shoot button in the app opens THIS
  camera rather than the OS picker: a character plate, a location plate, a prop
  plate, a storyboard frame, a mood-board image, a continuity reference, a world
  capture and footage on a shot. Eight surfaces.
- **FCC-013 · the walkthrough.** Shoot a world capture of a real room. Exposure
  must lock itself for the take. The budget shown must be the WORLD one (133s at
  1080p30, not 200s). Confirm the clip lands on the location.
- **FCC-014 · footage on a shot.** Record a take against a shot and confirm it
  appears in playback, in the conform, and in an NLE export — as `video_raw`,
  with its measured length rather than the card's guess.

## Recording the result

Fill the table above in, then write what surprised you. A session that produced
no surprises and no findings is worth saying so explicitly — it is the outcome
this whole epic is hoping for, and an empty findings section is ambiguous
between "nothing went wrong" and "nobody looked".

**Until the columns are filled, FCC-016 is BLOCKED and the epic is not proven.**
Fifteen tasks are verified by execution of their arithmetic and by structure;
what a simulator can never say is whether the phone behaves as the SDK
documents.
