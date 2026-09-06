# Redo the video between two frames — what shipped, and what still needs a human

Written 2026-09-06. Covers epic GRD-3427 (RBF-001..011) and the hardening that
followed it. **Everything named here is committed and pushed** — film-engine at
`6a643a4`, suite green at 3541/3541, 0 skipped.

This document exists because "the code is written" and "the feature has been
used" are different claims, and only the second one is worth anything to a
director. Each section below says which of the two it is.

---

## 1 · What the feature is

Mark a bad stretch of a shot, generate a replacement for that stretch only, and
splice it back so the take survives with the fault removed. Two shapes:

| | |
|---|---|
| **splice** | the fault is INSIDE one clip — head + new middle + tail, one file |
| **bridge** | the fault is BETWEEN two shots — the tail of A and the head of B, delivered as footage plus two trim points |

A bridge deliberately does **not** splice. Across a cut neither shot is at
fault, so the engine hands the editor the footage and the two marks and lets
Premiere own the join.

---

## 2 · Proven on real footage — done, and it cost $0.85

Run end to end on Wingfall 1A: a 22.08s 2206×946 hevc source, marked 8–13s,
replacement generated at 480p through MuAPI/Seedance, spliced, registered as
version 2. **The source survived byte-identical** — a repair is an attempt, not
a replacement, and the take it improves must outlive it.

Estimated $0.85, spent $0.85. The seam measured 5 and 1 mean-RGB against 1 and 1
in the original, which is why no colour-match pass was added: it would have been
machinery for a problem that did not appear.

The result is on the Desktop at `~/Desktop/film-engine-repair-proof/` —
`OPEN-ME.html`, before, after, and the generated five seconds on their own.

---

## 3 · Built and tested in code, NEVER run against a live provider

**This is the honest gap.** These paths have unit and integration coverage and
have never spent a credit.

- **Bridge, end to end.** `planBridge` / `runBridge` are covered by
  `tests/repair-bridge.test.js` and `tests/bridge-retrieval.test.js`, and zero
  bridge outputs exist on disk. The planner, the six run stages and the
  retrieval are exercised; **a real cross-clip repair has never been generated.**
- **`runBridge`'s outer failure handler.** Defence in depth, unexercised.

---

## 4 · Needs a person at the keyboard

Nothing here can be proven by a test — they are judgements about whether the
tool is usable.

- **Frame-accurate transport in playback.** ← / → step one frame (41.67 ms
  measured at 24fps), shift for a second, `I` and `O` set the marks, space
  plays. Built after the note that the slider was too clunky to land on an exact
  frame.
- **The Repair button** on the playback transport, and the mark readout.
- **`bridge_list` has no page control.** A director cannot list bridge
  deliverables from the app — only over the API or by asking Claude. Named
  rather than quietly shipped as complete.

---

## 5 · The audio defect, and what it means for existing files

`stitchClips` decided whether a clip carried audio with a regex that **matched
nothing on any real file**, so every join ever made synthesised silence instead
of carrying the track. Fixed, and now guarded by volume rather than by the
presence of a stream — a silent file still has a perfectly good audio stream,
which is why every earlier check passed.

Measured on the archived footage, three repairs of ONE source
(`1A_video.mp4`, audio at −33.9 dB):

```
1A_repair_mtojqk9a.mp4   0 audio streams      before the fix
1A_repair_mtokuzf0.mp4   0 audio streams      before the fix
1A_repair_mtojs4h5.mp4   1 stream, −35.0 dB   after
```

**Worth knowing:** the fix was never applied backwards. Any master conformed or
stitched before it may be silent. Nothing in the live data directory is
affected — it holds no video — but anything kept from the archived profile
should be checked by ear before it is delivered.

`2A_video.mp4` and every `sequence_*` output are legitimately silent: Seedance
runs with `generate_audio` off here because Film Engine owns dialogue, music,
SFX and ambient. Those are not defects.

---

## 6 · The test you asked for, not yet run

> *"when she gets out of the car, she should be coming out of the front driver
> door, and then walk around the car to land where she starts looking up"*

Gated on your go-ahead, and **nothing has been spent on it.** It is the right
first real exercise of the loop, because it is a genuine directorial note
rather than a synthetic fault: the generated take has her leaving by the wrong
door, which is exactly the class of thing this feature exists to fix.

Expected cost at 480p draft is a few tens of cents; at delivery raster it scales
with the model tier.

---

## 7 · Open, not resolved

- **Nothing in CI calls `run-all.sh`** (gridlight repo). There is a committed
  caller now; there is no CI caller. Two of its 34 scripts are deliberate red
  reproductions, so wiring the lot would go red on day one — a judgement about
  what CI should assert, not a mechanical follow-up.
- **A pointer in this repo's `CLAUDE.md`** to the superseded epic, parked behind
  the above: a pointer verified by a runner nothing invokes is a pointer nothing
  checks.

---

## 8 · Where the code is

| | |
|---|---|
| `backend/lib/repair-plan.js` | marks in, plan out; 8 refusals |
| `backend/lib/repair-run.js` | 7 stages, each naming its own failure |
| `backend/lib/repair-bridge.js` | the cross-cut case |
| `backend/lib/frame-handles.js` | a frame a provider can fetch; opaque, scoped, expiring |
| `backend/lib/playback-marks.js` | a mark on the film vs an offset in a file |
| `backend/lib/ffmpeg.js` | extract, trim, splice, inspect, join |

Tools: `repair_plan`, `repair_run`, `bridge_list`. Routes: `POST
/film/shots/:id/repair`, `GET /film/projects/:id/bridges`.

Run the guards with:

```bash
cd backend && npm test          # all 3541
node --test tests/repair-run.test.js tests/repair-bridge.test.js tests/repair-audio.test.js
```

---

# World Engine previz console — test plan

Added 2026-09-06. The previz screen was an empty 3D stage with an XYZ panel; it
is now a **shot design console**: a persistent reconstructed world that many
shots are framed inside, with the camera frame as the hero and every control
answering *how does this change the shot I am seeing?*

**Read this first.** Every one of the four world tables is currently **empty**:

```
film_worlds 0 · film_world_versions 0 · film_world_assets 0 · film_world_sources 0
```

So the console has real code, 18 agent tools, 12 test files, and **has never
been used on a real production.** The only live proof is the $0.20 spike, which
answered three questions about Marble and generated no world anyone kept. That
is what this plan is for.

## Prerequisite — turn it on

The console is behind the `world_engine` app setting and is **injected, not
hidden**: with the flag off it builds nothing at all, so the existing previs
screen stays byte-identical. Nothing below is visible until it is on.

```
PUT /film/settings   { "world_engine": true }
```

Failure to watch for: the console appearing while the flag reads false. That
exact bug shipped once — `!!'false'` is `true` — and it is why the setting is
parsed rather than coerced.

## Stage A — free, spends nothing. Do all of it before Stage B.

Everything here reads rows or does arithmetic. If any of it is wrong, do not
spend on a world.

| # | Do | Expect | Failure |
|---|---|---|---|
| A1 | Open Previz with the flag ON, then OFF | Console appears / screen is exactly the old previs | Any trace of the console with the flag off |
| A2 | `world_plan` on a location | A cost in credits **before** anything runs, naming the model | A plan that cannot price itself |
| A3 | `cinematography_brief` for a shot | Facts only — no verdict, no proposal | The engine deciding the shot for you |
| A4 | `camera_propose` an impossible camera (inside a wall, subject behind lens) | Refused, naming **which** of the 6 checks failed | A generic "invalid camera", or silence |
| A5 | Propose a camera with no world pinned | `inside_geometry` reported **skipped**, not passed | A green tick for a check that never ran |
| A6 | `camera_explore_brief` | Six intentional cameras, comparable | Fewer than six, or six identical |

**A5 is the one to be fussy about.** A check that could not run must never read
as a check that passed — a camera forty metres under the floor once came back
clean because no world was pinned.

## Stage B — the one paid step

`world_generate` on a location that already has plates. Marble bills in credits:
**draft 250, standard 1600.** Use draft first; the geometry is what matters and
draft is explicitly *for exploring geometry*.

| # | Do | Expect | Failure |
|---|---|---|---|
| B1 | Generate a draft world from a location's plates | A world + v1, with its collider mesh | Anything billed with no version row |
| B2 | Read its reported extent | Sensible dimensions for a street, not a bubble | A world the size of a room for an exterior |
| B3 | Check the scale claim | Reported **uncalibrated** — Marble promises no unit | A confident measurement in metres |

**B3 is the honest one.** A reconstruction has no unit until somebody measures
one thing in it. A size stated confidently in the wrong unit is worse than one
that says it does not know.

## Stage C — calibration, and why it must come before any camera

| # | Do | Expect | Failure |
|---|---|---|---|
| C1 | `world_calibrate` by measuring one known object | Every distance becomes metres | Values that do not move |
| C2 | Re-read a camera height after calibrating | "1.6 m" means 1.6 m **above the floor** | A height that means something else per world |

Until C1 passes, every lens/height/framing number downstream is in an arbitrary
unit and the console is decorative.

## Stage D — the camera, and the six checks

Six checks exist because the failure is partial by nature: five passing is
indistinguishable from working, and the sixth ships a camera inside a wall.

`inside_geometry` · `subject_behind_camera` · `clipping` · `focus_impossible` ·
`occluded` · `line_crossed`

| # | Do | Expect |
|---|---|---|
| D1 | Trigger each of the six deliberately | Each refuses **by name** |
| D2 | Cross the 180° line | **Warns, never blocks** — crossing the line is a real creative choice |
| D3 | Set `strict` on a shot, cross again | Now blocks |
| D4 | Set focus to 0 or a negative | `focus_impossible` |

D2 is the design decision most likely to look like a bug. A validator that
refuses the save gets switched off within a day, taking the five checks that
*should* block with it.

## Stage E — coverage, the reason the console exists

| # | Do | Expect | Failure |
|---|---|---|---|
| E1 | Explore coverage from one world + one blocking | Six cameras, side by side, comparable | Six variations of one angle |
| E2 | Pick an intention ("more heroic") | Lens/height/tilt/occupancy **change**; no new image is generated | A new render, or an unchanged camera |
| E3 | `camera_explore_accept` one | It becomes the shot's camera | Accepted and not applied |

E2 is the core claim of the whole design — *creative intention maps to
cinematographic consequence* — and it must cost nothing.

## Stage F — the generation plate

The plate is deliberately ugly: it fixes camera, framing and where each subject
stands, and hands everything else to the image model. **It is free** — a local
render — and that must stay true or it stops being the thing you check first.

| # | Do | Expect | Failure |
|---|---|---|---|
| F1 | Render a plate | Three outputs: image, depth, segmentation | Fewer, or an output nothing consumes |
| F2 | Confirm it spends nothing | No meter entry, no provider call | Any spend |
| F3 | Generate a keyframe **from** the plate | Geometry reproduced; nothing of the flat grey look survives | The frame inheriting the plate's appearance |
| F4 | Check staleness after | The plate is **not** fingerprinted as a keyframe | Every frame from that card reported stale |
| F5 | Delete the world version, re-read the plate | Reported `detached`, not `stale` | Being told to redo work that is impossible |

F5 matters for the same reason a deleted shot's file is `detached`: you cannot
regenerate a plate against geometry that is gone, so calling it "out of date"
asks for work nobody can do.

## Stage G — versions, pinning, locking

| # | Do | Expect |
|---|---|---|
| G1 | Generate v2 of the same world | v1 untouched — worlds are never overwritten |
| G2 | Pin shot 2A to v1, 2B to v2 | Each frames inside its own pin |
| G3 | Lock a world, try to regenerate | Refused, with an explicit override |
| G4 | Delete a pinned version | Refused, or the pin reported as detached — never silent |

## Stage H — reference match and export

| # | Do | Expect | Failure |
|---|---|---|---|
| H1 | `match_reference` from marks you draw | A camera derived from **marks, never pixels**, with a confidence that is earned | A confident number from nothing |
| H2 | `world_export` | Seven files, each naming the geometry it came from | A file that cannot say what it came from |

## Known NOT built — do not test for these

- **The live Gaussian-splat viewport.** The design specifies World Labs' Spark /
  three.js for the spatial panel; the page has essentially no splat code. What
  exists is geometry and chrome. The design bundle itself says the 3D viewports
  are placeholders and are a **layout and overlay spec**, not art to reproduce.
- **`bridge_list` has no page control** (carried from the repair work above).

## What would make this real

One location, plated, taken through A → H once on a **draft** world. That is
about 250 Marble credits plus a keyframe, and it converts "18 tools and 12 test
files" into "this has been used". Until then the console's own tests are the
only evidence it works, and they cannot see whether it is usable.

---

# TODO

## 1 · Effects on real footage

Apply effects to footage that already exists rather than only to generated
clips. The repair path proved that real footage can be marked, cut, replaced and
spliced with the source surviving byte-identical — effects are the same
operation with a different middle. Open questions to settle before building:
which effects are worth doing here versus in Premiere; whether an effect is a
new take (versioned, like a repair) or a non-destructive layer; and whether it
runs on the master or per shot.

## 2 · Connect to a camera on a mobile app

Drive the previz camera from a phone — move the handset, move the virtual
camera — so blocking is walked rather than typed. The iOS wrapper already ships
the real page in a WKWebView and can reach the Mac over the LAN, so the
transport exists. What does not: reading device pose, mapping it into world
space (which needs Stage C calibration to mean anything), and deciding whether
the phone is a **viewfinder** for a world already generated or a **capture
device** whose plates build one.

Both are unstarted. Nothing has been spent on either.
