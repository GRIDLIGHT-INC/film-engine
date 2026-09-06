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
